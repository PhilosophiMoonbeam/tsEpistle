import { randomUUID } from 'node:crypto'
import type { Request, Response } from 'express'
import type { Knex } from 'knex'
import { isTerminalAgentRunStatus, type AgentRunStatus } from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { AgentRepositoryError, listOwnedAgentEvents } from './repository.ts'
const GOOGLE_SEARCH_CHANNEL = 'wiki_agent_google_search_suggestions'
const GOOGLE_SEARCH_SOURCE = randomUUID()
const GOOGLE_SEARCH_MAX_SUGGESTIONS = 8
const GOOGLE_SEARCH_MAX_STRING_LENGTH = 32_768
const GOOGLE_SEARCH_MAX_PAYLOAD_BYTES = 128 * 1_024
const GOOGLE_SEARCH_CHUNK_BYTES = 5_000
const GOOGLE_SEARCH_MAX_CHUNKS = 36
const localGoogleSearchListeners = new Map<string, Set<(payload: string) => void>>()

const validateGoogleSearchSuggestions = (runId: string, suggestions: readonly string[]): string => {
  if (
    suggestions.length > GOOGLE_SEARCH_MAX_SUGGESTIONS ||
    suggestions.some(suggestion => typeof suggestion !== 'string' || suggestion.length < 1 || suggestion.length > GOOGLE_SEARCH_MAX_STRING_LENGTH)
  )
    throw new AgentRepositoryError('INVALID_GOOGLE_SEARCH_SUGGESTIONS', 'Google Search suggestions are invalid', 500)
  const payload = canonicalJson({ runId, suggestions })
  if (Buffer.byteLength(payload, 'utf8') > GOOGLE_SEARCH_MAX_PAYLOAD_BYTES)
    throw new AgentRepositoryError('INVALID_GOOGLE_SEARCH_SUGGESTIONS', 'Google Search suggestions exceed the delivery limit', 500)
  return payload
}

export const publishAgentGoogleSearchSuggestions = async (
  knex: Knex,
  input: {
    readonly ownerId: number
    readonly sessionId: string
    readonly runId: string
    readonly suggestions: readonly string[]
  }
): Promise<void> => {
  if (input.suggestions.length === 0) return
  const run = (await knex('agentRuns')
    .where({
      id: input.runId,
      ownerId: input.ownerId,
      sessionId: input.sessionId,
      googleSearchEnabled: true
    })
    .whereIn('status', ['running', 'awaiting_approval'])
    .first('id')) as { id: string } | undefined
  if (!run) throw new AgentRepositoryError('RUN_LEASE_LOST', 'Google Search suggestions no longer belong to an active admitted run', 409)
  const payload = validateGoogleSearchSuggestions(input.runId, input.suggestions)
  for (const listener of localGoogleSearchListeners.get(input.runId) ?? []) listener(payload)
  if (knex.client.config.client !== 'pg' && knex.client.config.client !== 'postgresql') return
  const encoded = Buffer.from(payload).toString('base64url')
  const chunks = Array.from({ length: Math.ceil(encoded.length / GOOGLE_SEARCH_CHUNK_BYTES) }, (_, index) =>
    encoded.slice(index * GOOGLE_SEARCH_CHUNK_BYTES, (index + 1) * GOOGLE_SEARCH_CHUNK_BYTES)
  )
  if (chunks.length > GOOGLE_SEARCH_MAX_CHUNKS)
    throw new AgentRepositoryError('INVALID_GOOGLE_SEARCH_SUGGESTIONS', 'Google Search suggestions exceed the delivery limit', 500)
  const notificationId = randomUUID()
  for (let index = 0; index < chunks.length; index += 1) {
    const notification = canonicalJson({
      v: 1,
      source: GOOGLE_SEARCH_SOURCE,
      id: notificationId,
      runId: input.runId,
      ownerId: input.ownerId,
      index,
      count: chunks.length,
      chunk: chunks[index]
    })
    if (Buffer.byteLength(notification, 'utf8') >= 8_000)
      throw new AgentRepositoryError('INVALID_GOOGLE_SEARCH_SUGGESTIONS', 'Google Search notification exceeds the database delivery limit', 500)
    await knex.raw(`SELECT pg_notify('${GOOGLE_SEARCH_CHANNEL}', ?)`, [notification])
  }
}

export interface AgentSseRequest {
  readonly aborted?: boolean
  readonly query: Request['query']
  get(name: string): string | undefined
}

interface RequestLifecycleEvents {
  once(event: 'aborted', listener: () => void): unknown
  off(event: 'aborted', listener: () => void): unknown
}

const hasRequestLifecycleEvents = (value: AgentSseRequest): value is AgentSseRequest & RequestLifecycleEvents =>
  typeof Reflect.get(value, 'once') === 'function' && typeof Reflect.get(value, 'off') === 'function'

interface Notification {
  readonly channel?: string
  readonly payload?: string
}

interface NotificationConnection {
  query(sql: string): Promise<unknown>
  on(event: 'notification', listener: (notification: Notification) => void): void
  removeListener(event: 'notification', listener: (notification: Notification) => void): void
}

const isNotificationConnection = (value: unknown): value is NotificationConnection => {
  if (value === null || typeof value !== 'object') return false
  return (
    typeof Reflect.get(value, 'query') === 'function' &&
    typeof Reflect.get(value, 'on') === 'function' &&
    typeof Reflect.get(value, 'removeListener') === 'function'
  )
}
interface GoogleSearchAssembly {
  readonly createdAt: number
  readonly count: number
  readonly chunks: Map<number, string>
}

const decodedGoogleSearchNotification = (
  raw: string | undefined,
  ownerId: number,
  runId: string,
  assemblies: Map<string, GoogleSearchAssembly>
): string | null => {
  if (!raw || Buffer.byteLength(raw, 'utf8') >= 8_000) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const source = Reflect.get(value, 'source')
  if (source === GOOGLE_SEARCH_SOURCE) return null
  const id = Reflect.get(value, 'id')
  const index = Reflect.get(value, 'index')
  const count = Reflect.get(value, 'count')
  const chunk = Reflect.get(value, 'chunk')
  if (
    Reflect.get(value, 'v') !== 1 ||
    typeof source !== 'string' ||
    typeof id !== 'string' ||
    id.length > 64 ||
    Reflect.get(value, 'runId') !== runId ||
    Reflect.get(value, 'ownerId') !== ownerId ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > GOOGLE_SEARCH_MAX_CHUNKS ||
    index >= count ||
    typeof chunk !== 'string' ||
    chunk.length > GOOGLE_SEARCH_CHUNK_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(chunk)
  )
    return null
  const now = Date.now()
  for (const [assemblyId, assembly] of assemblies) if (now - assembly.createdAt > 10_000) assemblies.delete(assemblyId)
  let assembly = assemblies.get(id)
  if (!assembly) {
    if (assemblies.size >= 4) return null
    assembly = { createdAt: now, count, chunks: new Map() }
    assemblies.set(id, assembly)
  }
  if (assembly.count !== count || (assembly.chunks.has(index) && assembly.chunks.get(index) !== chunk)) {
    assemblies.delete(id)
    return null
  }
  assembly.chunks.set(index, chunk)
  if (assembly.chunks.size !== count) return null
  assemblies.delete(id)
  const encoded = Array.from({ length: count }, (_, part) => assembly!.chunks.get(part)).join('')
  if (encoded.length > Math.ceil((GOOGLE_SEARCH_MAX_PAYLOAD_BYTES * 4) / 3) + 4) return null
  let payload: string
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(payload)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Reflect.get(parsed, 'runId') !== runId ||
      !Array.isArray(Reflect.get(parsed, 'suggestions')) ||
      validateGoogleSearchSuggestions(runId, Reflect.get(parsed, 'suggestions')) !== payload
    )
      return null
  } catch {
    return null
  }
  return payload
}

const parseCursor = (req: AgentSseRequest): number => {
  const header = req.get('last-event-id')
  const query = req.query.after
  const raw = header ?? (query === undefined ? '0' : typeof query === 'string' ? query : null)
  if (raw === null || !/^\d{1,10}$/.test(raw)) throw new AgentRepositoryError('INVALID_EVENT_CURSOR', 'Event cursor is invalid', 400)
  const cursor = Number(raw)
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new AgentRepositoryError('INVALID_EVENT_CURSOR', 'Event cursor is invalid', 400)
  return cursor
}

const writeWithBackpressure = async (res: Response, value: string): Promise<boolean> => {
  if (res.write(value)) return true
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const finish = (result: boolean): void => {
    clearTimeout(timer)
    res.off('drain', onDrain)
    res.off('close', onClose)
    resolve(result)
  }
  const onDrain = (): void => finish(true)
  const onClose = (): void => finish(false)
  const timer = setTimeout(() => finish(false), 5_000)
  res.once('drain', onDrain)
  res.once('close', onClose)
  return promise
}

const openNotificationListener = async (
  knex: Knex,
  ownerId: number,
  runId: string,
  wake: () => void,
  onGoogleSearchSuggestions: (payload: string) => void
): Promise<() => Promise<void>> => {
  let local = localGoogleSearchListeners.get(runId)
  if (!local) {
    local = new Set()
    localGoogleSearchListeners.set(runId, local)
  }
  local.add(onGoogleSearchSuggestions)
  const closeLocal = (): void => {
    const listeners = localGoogleSearchListeners.get(runId)
    listeners?.delete(onGoogleSearchSuggestions)
    if (listeners?.size === 0) localGoogleSearchListeners.delete(runId)
  }
  if (knex.client.config.client !== 'pg' && knex.client.config.client !== 'postgresql')
    return async () => {
      closeLocal()
    }
  const connection: unknown = await knex.client.acquireConnection()
  if (!isNotificationConnection(connection)) {
    closeLocal()
    await knex.client.releaseConnection(connection)
    throw new AgentRepositoryError('AGENT_EVENT_LISTENER_FAILED', 'Database connection cannot receive notifications', 500)
  }
  const assemblies = new Map<string, GoogleSearchAssembly>()
  const listener = (notification: Notification): void => {
    if (notification.channel === 'wiki_agent_events' && notification.payload === runId) {
      wake()
      return
    }
    if (notification.channel !== GOOGLE_SEARCH_CHANNEL) return
    const payload = decodedGoogleSearchNotification(notification.payload, ownerId, runId, assemblies)
    if (payload !== null) onGoogleSearchSuggestions(payload)
  }
  connection.on('notification', listener)
  try {
    await connection.query('LISTEN wiki_agent_events')
    await connection.query(`LISTEN ${GOOGLE_SEARCH_CHANNEL}`)
  } catch (error) {
    closeLocal()
    connection.removeListener('notification', listener)
    await knex.client.releaseConnection(connection)
    throw error
  }
  return async () => {
    closeLocal()
    connection.removeListener('notification', listener)
    assemblies.clear()
    try {
      await connection.query('UNLISTEN wiki_agent_events')
      await connection.query(`UNLISTEN ${GOOGLE_SEARCH_CHANNEL}`)
    } finally {
      await knex.client.releaseConnection(connection)
    }
  }
}

export interface AgentSseLimits {
  readonly maximumConnectionsPerUser: number
  readonly reconciliationMilliseconds?: number
  readonly keepaliveMilliseconds?: number
  readonly signal?: AbortSignal
}

export const streamOwnedAgentEvents = async (
  knex: Knex,
  req: AgentSseRequest,
  res: Response,
  ownerId: number,
  runId: string,
  connections: Map<number, number>,
  limits: AgentSseLimits
): Promise<void> => {
  if (limits.signal?.aborted || req.aborted || res.destroyed) return
  const run = (await knex('agentRuns').where({ id: runId, ownerId }).first('id', 'status', 'eventSequence')) as
    | { id: string; status: string; eventSequence: number }
    | undefined
  if (!run) throw new AgentRepositoryError('AGENT_RESOURCE_NOT_FOUND', 'Agent resource was not found', 404)
  const currentConnections = connections.get(ownerId) ?? 0
  if (currentConnections >= limits.maximumConnectionsPerUser) throw new AgentRepositoryError('SSE_CONNECTION_LIMIT', 'Too many agent event streams', 429)
  let cursor = parseCursor(req)
  if (cursor > run.eventSequence) throw new AgentRepositoryError('INVALID_EVENT_CURSOR', 'Event cursor is ahead of the run', 400)

  connections.set(ownerId, currentConnections + 1)
  let closed = false
  let wakeCurrent: (() => void) | null = null
  const pendingGoogleSearchSuggestions: string[] = []
  const wake = (): void => {
    wakeCurrent?.()
  }
  const onGoogleSearchSuggestions = (payload: string): void => {
    if (pendingGoogleSearchSuggestions.length >= 4) {
      closed = true
    } else {
      pendingGoogleSearchSuggestions.push(payload)
    }
    wake()
  }
  const onClose = (): void => {
    closed = true
    wake()
  }
  const requestLifecycle = hasRequestLifecycleEvents(req) ? req : null
  let requestAbortAttached = false
  let responseCloseAttached = false
  let signalAbortAttached = false
  let closeNotifications: () => Promise<void> = async () => {}
  try {
    if (requestLifecycle) {
      requestLifecycle.once('aborted', onClose)
      requestAbortAttached = true
    }
    res.once('close', onClose)
    responseCloseAttached = true
    if (limits.signal) {
      limits.signal.addEventListener('abort', onClose, { once: true })
      signalAbortAttached = true
    }
    if (limits.signal?.aborted || req.aborted || res.destroyed) onClose()
    closeNotifications = await openNotificationListener(knex, ownerId, runId, wake, onGoogleSearchSuggestions)
    if (closed || limits.signal?.aborted || req.aborted || res.destroyed) return
    res.status(200)
    res.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive'
    })
    res.flushHeaders()

    const reconciliationMilliseconds = limits.reconciliationMilliseconds ?? 1_000
    const keepaliveMilliseconds = limits.keepaliveMilliseconds ?? 15_000
    let lastWriteAt = Date.now()
    while (!closed) {
      const events = await listOwnedAgentEvents(knex, ownerId, runId, cursor, 1_000)
      for (const event of events) {
        const envelope = canonicalJson({ schemaVersion: event.schemaVersion, attempt: event.attempt, data: event.data, createdAt: event.createdAt })
        const sent = await writeWithBackpressure(res, `id: ${event.sequence}\nevent: ${event.type}\ndata: ${envelope}\n\n`)
        if (!sent) {
          closed = true
          break
        }
        cursor = event.sequence
        lastWriteAt = Date.now()
      }
      if (closed) break
      while (!closed && pendingGoogleSearchSuggestions.length > 0) {
        const payload = pendingGoogleSearchSuggestions.shift()!
        if (!(await writeWithBackpressure(res, `event: google_search.suggestions\ndata: ${payload}\n\n`))) {
          closed = true
          break
        }
        lastWriteAt = Date.now()
      }
      if (closed) break
      const current = (await knex('agentRuns').where({ id: runId, ownerId }).first('status', 'eventSequence')) as
        | { status: AgentRunStatus; eventSequence: number }
        | undefined
      if (!current) break
      if (isTerminalAgentRunStatus(current.status) && cursor >= current.eventSequence) break
      if (Date.now() - lastWriteAt >= keepaliveMilliseconds) {
        if (!(await writeWithBackpressure(res, ': keepalive\n\n'))) break
        lastWriteAt = Date.now()
      }
      const { promise, resolve } = Promise.withResolvers<void>()
      const timer = setTimeout(resolve, reconciliationMilliseconds)
      wakeCurrent = () => {
        clearTimeout(timer)
        resolve()
      }
      await promise
      wakeCurrent = null
    }
  } finally {
    if (requestAbortAttached) requestLifecycle?.off('aborted', onClose)
    if (responseCloseAttached) res.off('close', onClose)
    if (signalAbortAttached) limits.signal?.removeEventListener('abort', onClose)
    try {
      await closeNotifications()
    } finally {
      const remaining = (connections.get(ownerId) ?? 1) - 1
      if (remaining <= 0) connections.delete(ownerId)
      else connections.set(ownerId, remaining)
      if (!res.destroyed && !res.writableEnded) res.end()
    }
  }
}
