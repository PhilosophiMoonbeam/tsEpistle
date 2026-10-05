import type { Request, Response } from 'express'
import type { Knex } from 'knex'
import { isTerminalAgentRunStatus, type AgentRunStatus } from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { AgentRepositoryError, listOwnedAgentEvents } from './repository.ts'

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

const openNotificationListener = async (knex: Knex, runId: string, wake: () => void): Promise<() => Promise<void>> => {
  if (knex.client.config.client !== 'pg' && knex.client.config.client !== 'postgresql') return async () => {}
  const connection: unknown = await knex.client.acquireConnection()
  if (!isNotificationConnection(connection)) {
    await knex.client.releaseConnection(connection)
    throw new AgentRepositoryError('AGENT_EVENT_LISTENER_FAILED', 'Database connection cannot receive notifications', 500)
  }
  const listener = (notification: Notification): void => {
    if (notification.channel === 'wiki_agent_events' && notification.payload === runId) wake()
  }
  connection.on('notification', listener)
  try {
    await connection.query('LISTEN wiki_agent_events')
  } catch (error) {
    connection.removeListener('notification', listener)
    await knex.client.releaseConnection(connection)
    throw error
  }
  return async () => {
    connection.removeListener('notification', listener)
    try {
      await connection.query('UNLISTEN wiki_agent_events')
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
  const wake = (): void => {
    wakeCurrent?.()
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
    closeNotifications = await openNotificationListener(knex, runId, wake)
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
