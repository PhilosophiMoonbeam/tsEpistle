import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import {
  AGENT_EVENT_TYPES,
  type AgentEvent,
  type AgentEventData,
  type AgentEventType,
  type AgentExecutionMode,
  type AgentMessageRole,
  type AgentMessageStatus,
  type AgentSessionRetention
} from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'

const SHA256 = /^[a-f0-9]{64}$/
const eventTypeSchema = z.enum(AGENT_EVENT_TYPES)
const retentionSchema = z.enum(['temporary', 'saved'])
const executionModeSchema = z.enum(['agent', 'generation-only'])
const messageRoleSchema = z.enum(['user', 'assistant'])
const messageStatusSchema = z.enum(['pending', 'streaming', 'complete', 'failed', 'cancelled'])

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

export class AgentRepositoryError extends Error {
  readonly code: string
  readonly status: number

  constructor (code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

const conflict = (code: string, message: string): never => { throw new AgentRepositoryError(code, message, 409) }
const notFound = (): never => { throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent resource was not found', 404) }

const isJsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > 12) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 1_000 && value.every(item => isJsonValue(item, depth + 1))
  if (typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const entries = Object.entries(value as Record<string, unknown>)
  return entries.length <= 1_000 && entries.every(([key, item]) => key.length <= 255 && isJsonValue(item, depth + 1))
}

const validatedEventData = (data: AgentEventData): { encoded: string, sha256: string } => {
  if (!isJsonValue(data)) throw new AgentRepositoryError('INVALID_AGENT_EVENT', 'Agent event data must be bounded JSON', 400)
  const encoded = canonicalJson(data)
  if (Buffer.byteLength(encoded) > 65_536) throw new AgentRepositoryError('INVALID_AGENT_EVENT', 'Agent event data exceeds 64 KiB', 400)
  return { encoded, sha256: digest(encoded) }
}

export interface AgentSessionRecord {
  readonly id: string
  readonly ownerId: number
  readonly title: string
  readonly retention: AgentSessionRetention
  readonly folderId: string | null
  readonly providerProfileId: string | null
  readonly executionMode: AgentExecutionMode
  readonly version: number
  readonly summary: string | null
  readonly summaryThroughOrdinal: number | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastActivityAt: string
  readonly expiresAt: string | null
  readonly deletedAt: string | null
}

interface SessionRow extends Omit<AgentSessionRecord, 'createdAt' | 'updatedAt' | 'lastActivityAt' | 'expiresAt' | 'deletedAt'> {
  createdAt: Date | string
  updatedAt: Date | string
  lastActivityAt: Date | string
  expiresAt: Date | string | null
  deletedAt: Date | string | null
}

const sessionRecord = (row: SessionRow): AgentSessionRecord => ({
  ...row,
  folderId: row.folderId ?? null,
  retention: retentionSchema.parse(row.retention),
  executionMode: executionModeSchema.parse(row.executionMode),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  lastActivityAt: iso(row.lastActivityAt),
  expiresAt: row.expiresAt === null || row.expiresAt === undefined ? null : iso(row.expiresAt),
  deletedAt: row.deletedAt === null || row.deletedAt === undefined ? null : iso(row.deletedAt)
})

export interface CreateAgentSessionInput {
  readonly ownerId: number
  readonly title?: string
  readonly retention: AgentSessionRetention
  readonly providerProfileId: string | null
  readonly executionMode: AgentExecutionMode
  readonly expiresAt?: Date | null
  readonly memorySnapshot?: string
  readonly id?: string
}

export const createAgentSession = async (knex: Knex | Knex.Transaction, input: CreateAgentSessionInput): Promise<AgentSessionRecord> => {
  const retention = retentionSchema.parse(input.retention)
  const executionMode = executionModeSchema.parse(input.executionMode)
  if (input.memorySnapshot !== undefined && Buffer.byteLength(input.memorySnapshot, 'utf8') > 16 * 1_024) throw new AgentRepositoryError('INVALID_AGENT_MEMORY', 'Memory snapshot exceeds 16 KiB', 400)
  const now = new Date()
  const row = {
    id: input.id ?? randomUUID(),
    ownerId: input.ownerId,
    title: (input.title ?? '').trim().slice(0, 255),
    titleSource: (input.title ?? '').trim().length > 0 ? 'manual' : 'none',
    retention,
    folderId: null,
    providerProfileId: input.providerProfileId,
    executionMode,
    version: 1,
    summary: null,
    summaryThroughOrdinal: null,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    expiresAt: input.expiresAt ?? null,
    deletedAt: null
  }
  await knex('agentSessions').insert(input.memorySnapshot === undefined ? row : { ...row, memorySnapshot: input.memorySnapshot })
  return sessionRecord(row)
}

export const getOwnedAgentSession = async (knex: Knex | Knex.Transaction, ownerId: number, id: string, includeDeleted = false): Promise<AgentSessionRecord> => {
  const query = knex<SessionRow>('agentSessions').where({ id, ownerId })
  if (!includeDeleted) query.whereNull('deletedAt')
  const row = await query.first()
  if (!row) return notFound()
  return sessionRecord(row)
}

export const listOwnedAgentSessions = async (knex: Knex, ownerId: number, limit = 50, before?: Date): Promise<AgentSessionRecord[]> => {
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const query = knex<SessionRow>('agentSessions')
    .where({ ownerId })
    .whereNull('deletedAt')
    .whereExists(function persistedConversation () {
      this.select(knex.raw('1'))
        .from('agentMessages')
        .where('agentMessages.sessionId', knex.ref('agentSessions.id'))
        .where({ role: 'user', status: 'complete' })
    })
  if (before) query.where('lastActivityAt', '<', before)
  const rows = await query.orderBy('lastActivityAt', 'desc').orderBy('id', 'desc').limit(boundedLimit)
  return rows.map(sessionRecord)
}
export interface AgentConversationFolderRecord {
  readonly id: string
  readonly ownerId: number
  readonly name: string
  readonly version: number
  readonly createdAt: string
  readonly updatedAt: string
}

interface ConversationFolderRow extends Omit<AgentConversationFolderRecord, 'createdAt' | 'updatedAt'> {
  readonly normalizedName: string
  readonly createdAt: Date | string
  readonly updatedAt: Date | string
}

const folderRecord = (row: ConversationFolderRow): AgentConversationFolderRecord => ({
  id: row.id,
  ownerId: row.ownerId,
  name: row.name,
  version: row.version,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt)
})

const cleanFolderName = (value: string): string => value.normalize('NFKC').trim().replace(/\s+/g, ' ')
const normalizedFolderName = (value: string): string => cleanFolderName(value).toLowerCase()

export const listOwnedAgentConversationFolders = async (knex: Knex, ownerId: number): Promise<AgentConversationFolderRecord[]> => {
  const rows = await knex<ConversationFolderRow>('agentConversationFolders')
    .where({ ownerId })
    .orderBy('normalizedName')
    .orderBy('id')
  return rows.map(folderRecord)
}

export const createAgentConversationFolder = async (knex: Knex, ownerId: number, requestedName: string): Promise<AgentConversationFolderRecord> => knex.transaction(async transaction => {
  const name = cleanFolderName(requestedName)
  if (!name || name.length > 64) throw new AgentRepositoryError('INVALID_CONVERSATION_FOLDER_NAME', 'Conversation folder names must contain between 1 and 64 characters', 400)
  if (await transaction('agentConversationFolders').where({ ownerId, normalizedName: normalizedFolderName(name) }).first('id')) {
    return conflict('CONVERSATION_FOLDER_EXISTS', 'A conversation folder with this name already exists')
  }
  const countRow = await transaction('agentConversationFolders').where({ ownerId }).count<{ count: number | string }[]>({ count: '*' }).first()
  if (Number(countRow?.count ?? 0) >= 32) throw new AgentRepositoryError('CONVERSATION_FOLDER_LIMIT_REACHED', 'You can create up to 32 conversation folders', 409)
  const now = new Date()
  const row: ConversationFolderRow = {
    id: randomUUID(),
    ownerId,
    name,
    normalizedName: normalizedFolderName(name),
    version: 1,
    createdAt: now,
    updatedAt: now
  }
  await transaction('agentConversationFolders').insert(row)
  return folderRecord(row)
})

export const renameAgentConversationFolder = async (knex: Knex, ownerId: number, folderId: string, expectedVersion: number, requestedName: string): Promise<AgentConversationFolderRecord> => knex.transaction(async transaction => {
  const name = cleanFolderName(requestedName)
  if (!name || name.length > 64) throw new AgentRepositoryError('INVALID_CONVERSATION_FOLDER_NAME', 'Conversation folder names must contain between 1 and 64 characters', 400)
  const existing = await transaction<ConversationFolderRow>('agentConversationFolders').where({ id: folderId, ownerId }).first()
  if (!existing) return notFound()
  if (existing.version !== expectedVersion) return conflict('CONVERSATION_FOLDER_VERSION_CHANGED', 'Conversation folder changed concurrently')
  const duplicate = await transaction('agentConversationFolders')
    .where({ ownerId, normalizedName: normalizedFolderName(name) })
    .whereNot({ id: folderId })
    .first('id')
  if (duplicate) return conflict('CONVERSATION_FOLDER_EXISTS', 'A conversation folder with this name already exists')
  const changed = await transaction('agentConversationFolders')
    .where({ id: folderId, ownerId, version: expectedVersion })
    .update({ name, normalizedName: normalizedFolderName(name), version: transaction.raw('?? + 1', ['version']), updatedAt: new Date() })
  if (changed !== 1) return conflict('CONVERSATION_FOLDER_VERSION_CHANGED', 'Conversation folder changed concurrently')
  const updated = await transaction<ConversationFolderRow>('agentConversationFolders').where({ id: folderId, ownerId }).first()
  if (!updated) return notFound()
  return folderRecord(updated)
})

export const deleteAgentConversationFolder = async (knex: Knex, ownerId: number, folderId: string): Promise<number> => knex.transaction(async transaction => {
  const folder = await transaction('agentConversationFolders').where({ id: folderId, ownerId }).first('id')
  if (!folder) return notFound()
  const now = new Date()
  const moved = await transaction('agentSessions')
    .where({ ownerId, folderId })
    .whereNull('deletedAt')
    .update({
      folderId: null,
      retention: 'saved',
      expiresAt: null,
      lastActivityAt: now,
      updatedAt: now,
      version: transaction.raw('?? + 1', ['version'])
    })
  await transaction('agentConversationFolders').where({ id: folderId, ownerId }).delete()
  return moved
})

export interface MoveAgentSessionToFolderInput {
  readonly ownerId: number
  readonly sessionId: string
  readonly expectedVersion: number
  readonly folderId: string | null
}

export const moveAgentSessionToFolder = async (knex: Knex, input: MoveAgentSessionToFolderInput): Promise<AgentSessionRecord> => knex.transaction(async transaction => {
  const session = await getOwnedAgentSession(transaction, input.ownerId, input.sessionId)
  if (session.version !== input.expectedVersion) return conflict('SESSION_VERSION_CHANGED', 'Agent session changed concurrently')
  if (input.folderId !== null && !await transaction('agentConversationFolders').where({ id: input.folderId, ownerId: input.ownerId }).first('id')) return notFound()
  if (session.folderId === input.folderId) return session
  const now = new Date()
  const changed = await transaction('agentSessions')
    .where({ id: input.sessionId, ownerId: input.ownerId, version: input.expectedVersion })
    .whereNull('deletedAt')
    .update({
      folderId: input.folderId,
      retention: 'saved',
      expiresAt: null,
      updatedAt: now,
      version: transaction.raw('?? + 1', ['version']),
      ...(input.folderId === null ? { lastActivityAt: now } : {})
    })
  if (changed !== 1) return conflict('SESSION_VERSION_CHANGED', 'Agent session changed concurrently')
  return getOwnedAgentSession(transaction, input.ownerId, input.sessionId)
})


export interface UpdateAgentSessionInput {
  readonly ownerId: number
  readonly sessionId: string
  readonly expectedVersion: number
  readonly title?: string
  readonly retention?: AgentSessionRetention
  readonly expiresAt?: Date | null
}

export const updateAgentSession = async (knex: Knex, input: UpdateAgentSessionInput): Promise<AgentSessionRecord> => {
  await getOwnedAgentSession(knex, input.ownerId, input.sessionId)
  const now = new Date()
  const patch: Record<string, unknown> = { version: knex.raw('?? + 1', ['version']), updatedAt: now, lastActivityAt: now }
  if (input.title !== undefined) {
    patch.title = input.title.trim().slice(0, 255)
    patch.titleSource = input.title.trim().length > 0 ? 'manual' : 'none'
  }
  if (input.retention !== undefined) patch.retention = retentionSchema.parse(input.retention)
  if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt
  const changed = await knex('agentSessions')
    .where({ id: input.sessionId, ownerId: input.ownerId, version: input.expectedVersion })
    .whereNull('deletedAt')
    .update(patch)
  if (changed !== 1) return conflict('SESSION_VERSION_CHANGED', 'Agent session changed concurrently')
  return getOwnedAgentSession(knex, input.ownerId, input.sessionId)
}

export interface AgentMessageRecord {
  readonly id: string
  readonly sessionId: string
  readonly runId: string | null
  readonly ordinal: number
  readonly role: AgentMessageRole
  readonly status: AgentMessageStatus
  readonly content: string
  readonly citations: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

interface MessageRow extends Omit<AgentMessageRecord, 'createdAt' | 'updatedAt'> {
  createdAt: Date | string
  updatedAt: Date | string
}

const messageRecord = (row: MessageRow): AgentMessageRecord => ({
  ...row,
  role: messageRoleSchema.parse(row.role),
  status: messageStatusSchema.parse(row.status),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt)
})

export interface AppendAgentMessageInput {
  readonly ownerId: number
  readonly sessionId: string
  readonly runId?: string | null
  readonly role: AgentMessageRole
  readonly status: AgentMessageStatus
  readonly content: string
  readonly citations?: string | null
  readonly id?: string
}

export const appendAgentMessage = async (knex: Knex, input: AppendAgentMessageInput): Promise<AgentMessageRecord> => knex.transaction(async transaction => {
  const session = await transaction<SessionRow>('agentSessions').where({ id: input.sessionId, ownerId: input.ownerId }).whereNull('deletedAt').forUpdate().first()
  if (!session) return notFound()
  const latest = await transaction<MessageRow>('agentMessages').where({ sessionId: input.sessionId }).max<{ ordinal: number | string | null }>('ordinal as ordinal').first()
  const ordinal = Number(latest?.ordinal ?? 0) + 1
  const now = new Date()
  const row = {
    id: input.id ?? randomUUID(),
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    ordinal,
    role: messageRoleSchema.parse(input.role),
    status: messageStatusSchema.parse(input.status),
    content: input.content,
    citations: input.citations ?? null,
    createdAt: now,
    updatedAt: now
  }
  await transaction('agentMessages').insert(row)
  await transaction('agentSessions').where({ id: input.sessionId }).update({ lastActivityAt: now, updatedAt: now })
  return messageRecord(row)
})

export const listOwnedAgentMessages = async (knex: Knex, ownerId: number, sessionId: string, afterOrdinal = 0, limit = 200): Promise<AgentMessageRecord[]> => {
  await getOwnedAgentSession(knex, ownerId, sessionId)
  const rows = await knex<MessageRow>('agentMessages').where({ sessionId }).andWhere('ordinal', '>', afterOrdinal).orderBy('ordinal').limit(Math.max(1, Math.min(500, Math.floor(limit))))
  return rows.map(messageRecord)
}

interface EventRow {
  id: string
  runId: string
  sequence: number
  type: AgentEventType
  attempt: number
  schemaVersion: number
  dataSha256: string
  data: string
  createdAt: Date | string
}

const eventRecord = (row: EventRow): AgentEvent => {
  if (!SHA256.test(row.dataSha256) || digest(row.data) !== row.dataSha256) throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Agent event payload hash mismatch', 500)
  const data: unknown = JSON.parse(row.data)
  if (!isJsonValue(data) || data === null || Array.isArray(data) || typeof data !== 'object') throw new AgentRepositoryError('AGENT_EVENT_CORRUPT', 'Agent event payload is invalid', 500)
  return {
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    type: eventTypeSchema.parse(row.type),
    attempt: row.attempt,
    schemaVersion: 1,
    data: data as AgentEventData,
    createdAt: iso(row.createdAt)
  }
}

export interface AppendAgentEventInput {
  readonly id: string
  readonly runId: string
  readonly ownerId: number
  readonly type: AgentEventType
  readonly attempt: number
  readonly data: AgentEventData
  readonly leaseToken?: string
}

const sameEvent = (row: EventRow, input: AppendAgentEventInput, dataSha256: string): boolean => row.runId === input.runId && row.type === input.type && row.attempt === input.attempt && row.dataSha256 === dataSha256

export const appendAgentEvent = async (knex: Knex, input: AppendAgentEventInput): Promise<AgentEvent> => {
  const type = eventTypeSchema.parse(input.type)
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0) throw new AgentRepositoryError('INVALID_AGENT_EVENT', 'Agent event attempt is invalid', 400)
  const payload = validatedEventData(input.data)
  return knex.transaction(async transaction => {
    const existing = await transaction<EventRow>('agentEvents')
      .join('agentRuns', 'agentRuns.id', 'agentEvents.runId')
      .where('agentEvents.id', input.id)
      .andWhere('agentRuns.ownerId', input.ownerId)
      .select('agentEvents.*')
      .first()
    if (existing) {
      if (!sameEvent(existing, input, payload.sha256)) return conflict('AGENT_EVENT_IDEMPOTENCY_MISMATCH', 'Agent event ID was reused with a different payload')
      return eventRecord(existing)
    }

    const runQuery = transaction('agentRuns').where({ id: input.runId, ownerId: input.ownerId }).forUpdate()
    if (input.leaseToken !== undefined) runQuery.andWhere('leaseToken', input.leaseToken)
    const run = await runQuery.select('eventSequence').first() as { eventSequence: number } | undefined
    if (!run) return notFound()
    const sequence = Number(run.eventSequence) + 1
    const now = new Date()
    const row: EventRow = { id: input.id, runId: input.runId, sequence, type, attempt: input.attempt, schemaVersion: 1, dataSha256: payload.sha256, data: payload.encoded, createdAt: now }
    await transaction('agentEvents').insert(row)
    const changed = await transaction('agentRuns').where({ id: input.runId, ownerId: input.ownerId, eventSequence: run.eventSequence }).modify(query => {
      if (input.leaseToken !== undefined) query.andWhere('leaseToken', input.leaseToken)
    }).update({ eventSequence: sequence, updatedAt: now })
    if (changed !== 1) return conflict('AGENT_EVENT_SEQUENCE_CHANGED', 'Agent event sequence changed concurrently')
    if (transaction.client.config.client === 'pg' || transaction.client.config.client === 'postgresql') {
      await transaction.raw("SELECT pg_notify('wiki_agent_events', ?)", [input.runId])
    }
    return eventRecord(row)
  })
}

export const listOwnedAgentEvents = async (knex: Knex, ownerId: number, runId: string, afterSequence = 0, limit = 1_000): Promise<AgentEvent[]> => {
  const run = await knex('agentRuns').where({ id: runId, ownerId }).first('id')
  if (!run) return notFound()
  const rows = await knex<EventRow>('agentEvents').where({ runId }).andWhere('sequence', '>', afterSequence).orderBy('sequence').limit(Math.max(1, Math.min(1_000, Math.floor(limit))))
  let expected = afterSequence + 1
  for (const row of rows) {
    if (row.sequence !== expected) throw new AgentRepositoryError('AGENT_EVENT_SEQUENCE_GAP', 'Agent event sequence is not contiguous', 500)
    expected += 1
  }
  return rows.map(eventRecord)
}


export interface StoreAgentArtifactInput {
  readonly id?: string
  readonly ownerId: number
  readonly sessionId: string
  readonly runId: string
  readonly payload: Buffer
  readonly width: number
  readonly height: number
  readonly expiresAt?: Date | null
  readonly metadata?: Readonly<Record<string, unknown>> | null
}

export const storeAgentScreenshot = async (knex: Knex, input: StoreAgentArtifactInput): Promise<string> => {
  if (input.payload.length < 8 || input.payload.length > 10 * 1024 * 1024 || input.payload.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new AgentRepositoryError('INVALID_AGENT_ARTIFACT', 'Artifact must be a bounded PNG', 400)
  if (!Number.isSafeInteger(input.width) || input.width < 1 || !Number.isSafeInteger(input.height) || input.height < 1) throw new AgentRepositoryError('INVALID_AGENT_ARTIFACT', 'Artifact dimensions are invalid', 400)
  await getOwnedAgentSession(knex, input.ownerId, input.sessionId)
  const run = await knex('agentRuns').where({ id: input.runId, sessionId: input.sessionId, ownerId: input.ownerId }).first('id')
  if (!run) return notFound()
  const id = input.id ?? randomUUID()
  const metadata = input.metadata === undefined || input.metadata === null ? null : canonicalJson(input.metadata)
  await knex('agentArtifacts').insert({ id, sessionId: input.sessionId, runId: input.runId, ownerId: input.ownerId, kind: 'browser-screenshot', mimeType: 'image/png', byteLength: input.payload.length, sha256: digest(input.payload), payload: input.payload, width: input.width, height: input.height, createdAt: new Date(), expiresAt: input.expiresAt ?? null, metadata })
  return id
}

export interface AgentArtifactPayload {
  readonly id: string
  readonly payload: Buffer
  readonly sha256: string
  readonly mimeType: 'image/png'
  readonly byteLength: number
  readonly expiresAt: string | null
}

export const getOwnedAgentArtifact = async (knex: Knex, ownerId: number, id: string): Promise<AgentArtifactPayload> => {
  const row = await knex('agentArtifacts').where({ id, ownerId }).first() as { id: string, payload: Buffer | null, sha256: string, mimeType: string, byteLength: number, expiresAt: Date | string | null } | undefined
  if (!row || row.payload === null || (row.expiresAt !== null && new Date(row.expiresAt).valueOf() <= Date.now())) return notFound()
  const payload = Buffer.from(row.payload)
  if (row.mimeType !== 'image/png' || row.byteLength !== payload.length || digest(payload) !== row.sha256) throw new AgentRepositoryError('AGENT_ARTIFACT_CORRUPT', 'Agent artifact integrity check failed', 500)
  return { id: row.id, payload, sha256: row.sha256, mimeType: 'image/png', byteLength: row.byteLength, expiresAt: row.expiresAt === null ? null : iso(row.expiresAt) }
}
