import type { Request, Response } from 'express'
import type { Knex } from 'knex'
import { isTerminalAgentRunStatus, type AgentRunStatus } from '../../shared/agents/contracts.ts'
import { canonicalJson } from '../helpers/canonical-json.ts'
import { AgentRepositoryError, listOwnedAgentEvents } from './repository.ts'

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

const parseCursor = (req: Request): number => {
  const raw = req.get('last-event-id') ?? (typeof req.query.after === 'string' ? req.query.after : '0')
  if (!/^\d{1,10}$/.test(raw)) throw new AgentRepositoryError('INVALID_EVENT_CURSOR', 'Event cursor is invalid', 400)
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
}

export const streamOwnedAgentEvents = async (
  knex: Knex,
  req: Request,
  res: Response,
  ownerId: number,
  runId: string,
  connections: Map<number, number>,
  limits: AgentSseLimits
): Promise<void> => {
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
  res.once('close', onClose)
  let closeNotifications: () => Promise<void> = async () => {}
  try {
    closeNotifications = await openNotificationListener(knex, runId, wake)
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
    res.off('close', onClose)
    await closeNotifications()
    const remaining = (connections.get(ownerId) ?? 1) - 1
    if (remaining <= 0) connections.delete(ownerId)
    else connections.set(ownerId, remaining)
    res.end()
  }
}
