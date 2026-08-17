import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import {
  AGENT_EVENT_TYPES,
  type AgentCurrentPageHint,
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
const digestBuffer = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest()

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
  retention: retentionSchema.parse(row.retention),
  executionMode: executionModeSchema.parse(row.executionMode),
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
  lastActivityAt: iso(row.lastActivityAt),
  expiresAt: row.expiresAt === null ? null : iso(row.expiresAt),
  deletedAt: row.deletedAt === null ? null : iso(row.deletedAt)
})

export interface CreateAgentSessionInput {
  readonly ownerId: number
  readonly title?: string
  readonly retention: AgentSessionRetention
  readonly providerProfileId: string | null
  readonly executionMode: AgentExecutionMode
  readonly expiresAt?: Date | null
  readonly id?: string
}

export const createAgentSession = async (knex: Knex | Knex.Transaction, input: CreateAgentSessionInput): Promise<AgentSessionRecord> => {
  const retention = retentionSchema.parse(input.retention)
  const executionMode = executionModeSchema.parse(input.executionMode)
  const now = new Date()
  const row = {
    id: input.id ?? randomUUID(),
    ownerId: input.ownerId,
    title: (input.title ?? '').trim().slice(0, 255),
    retention,
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
  await knex('agentSessions').insert(row)
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
  const query = knex<SessionRow>('agentSessions').where({ ownerId }).whereNull('deletedAt')
  if (before) query.where('lastActivityAt', '<', before)
  const rows = await query.orderBy('lastActivityAt', 'desc').orderBy('id', 'desc').limit(boundedLimit)
  return rows.map(sessionRecord)
}

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
  if (input.title !== undefined) patch.title = input.title.trim().slice(0, 255)
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

export interface AgentLaunchHandoff {
  readonly id: string
  readonly token: string
  readonly expiresAt: string
}

export interface AgentLaunchHandoffPayload {
  readonly pageId: number | null
  readonly locale: string | null
  readonly path: string | null
  readonly observedUpdatedAt: string | null
}

export interface IssueAgentLaunchHandoffInput extends AgentLaunchHandoffPayload {
  readonly ownerId: number
  readonly ttlSeconds: number
}

const handoffPayload = (row: { pageId: number | null, localeCode: string | null, path: string | null, observedUpdatedAt: Date | string | null }): AgentLaunchHandoffPayload => ({
  pageId: row.pageId,
  locale: row.localeCode,
  path: row.path,
  observedUpdatedAt: row.observedUpdatedAt === null ? null : iso(row.observedUpdatedAt)
})

export const issueAgentLaunchHandoff = async (knex: Knex, input: IssueAgentLaunchHandoffInput): Promise<AgentLaunchHandoff> => {
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 900) throw new AgentRepositoryError('INVALID_HANDOFF_TTL', 'Launch handoff TTL is invalid', 400)
  const id = randomUUID()
  const token = randomBytes(32).toString('base64url')
  const now = new Date()
  const expiresAt = new Date(now.valueOf() + input.ttlSeconds * 1_000)
  const payload = handoffPayload({ pageId: input.pageId, localeCode: input.locale, path: input.path, observedUpdatedAt: input.observedUpdatedAt })
  await knex('agentLaunchHandoffs').insert({
    id,
    tokenSha256: digestBuffer(token),
    ownerId: input.ownerId,
    pageId: input.pageId,
    localeCode: input.locale,
    path: input.path,
    observedUpdatedAt: input.observedUpdatedAt,
    pageHintSha256: digestBuffer(canonicalJson(payload)),
    createdAt: now,
    expiresAt,
    consumedAt: null
  })
  return { id, token, expiresAt: expiresAt.toISOString() }
}

interface HandoffRow {
  id: string
  tokenSha256: Buffer
  ownerId: number
  pageId: number | null
  localeCode: string | null
  path: string | null
  observedUpdatedAt: Date | string | null
  pageHintSha256: Buffer
  expiresAt: Date | string
  consumedAt: Date | string | null
}

const consumeAgentLaunchHandoffInTransaction = async (transaction: Knex.Transaction, ownerId: number, token: string): Promise<AgentLaunchHandoffPayload> => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return notFound()
  const tokenSha256 = digestBuffer(token)
  const row = await transaction<HandoffRow>('agentLaunchHandoffs').where({ ownerId, tokenSha256 }).forUpdate().first()
  if (!row || row.consumedAt !== null || new Date(row.expiresAt).valueOf() <= Date.now()) return notFound()
  if (!timingSafeEqual(Buffer.from(row.tokenSha256), tokenSha256)) return notFound()
  const payload = handoffPayload(row)
  const payloadHash = digestBuffer(canonicalJson(payload))
  if (!timingSafeEqual(Buffer.from(row.pageHintSha256), payloadHash)) throw new AgentRepositoryError('LAUNCH_HANDOFF_CORRUPT', 'Launch handoff payload hash mismatch', 500)
  const consumedAt = new Date()
  const changed = await transaction('agentLaunchHandoffs').where({ id: row.id, ownerId }).whereNull('consumedAt').update({ consumedAt })
  if (changed !== 1) return conflict('LAUNCH_HANDOFF_CONSUMED', 'Launch handoff was already consumed')
  return payload
}

export const consumeAgentLaunchHandoff = async (knex: Knex, ownerId: number, token: string): Promise<AgentLaunchHandoffPayload> =>
  knex.transaction(transaction => consumeAgentLaunchHandoffInTransaction(transaction, ownerId, token))

export const createAgentSessionFromHandoff = async (knex: Knex, input: CreateAgentSessionInput, token: string): Promise<{ readonly session: AgentSessionRecord, readonly handoff: AgentLaunchHandoffPayload }> =>
  knex.transaction(async transaction => {
    const handoff = await consumeAgentLaunchHandoffInTransaction(transaction, input.ownerId, token)
    const session = await createAgentSession(transaction, input)
    return { session, handoff }
  })

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

export const currentPageHint = (payload: AgentLaunchHandoffPayload): AgentCurrentPageHint | null => {
  if (payload.pageId === null || payload.locale === null || payload.path === null || payload.observedUpdatedAt === null) return null
  return { id: payload.pageId, locale: payload.locale, path: payload.path, observedUpdatedAt: payload.observedUpdatedAt }
}
