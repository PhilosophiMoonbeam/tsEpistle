import express from 'express'
import { type Request, type Response, errorStatus, getTransportRuntime, getWikiAuth } from '../_types.ts'
import { systemRequester } from '../../helpers/system-authority.ts'
import type { PagePrincipal } from '../../helpers/page-access.ts'
import type { LoggingLiveTrailSource } from '../../operations/logging-live-trail.ts'
import { getLoggingWorkspaceStore, redactLoggingLiveOutput } from '../../operations/logging.ts'

const router = express.Router()
const MAX_LIVE_CONNECTIONS_PER_PRINCIPAL = 2
const LIVE_REVALIDATION_MILLISECONDS = 15_000
const liveConnections = new Map<string, number>()

interface LiveTrailBroker {
  subscribe(): LoggingLiveTrailSource
}

interface LiveTrailLine {
  timestamp: string
  level: string
  output: string
}

interface LoggingRequest extends Request {
  user?: PagePrincipal
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const isLiveTrailBroker = (value: unknown): value is LiveTrailBroker =>
  typeof value === 'object' && value !== null && typeof Reflect.get(value, 'subscribe') === 'function'
const authorized = (req: LoggingRequest, res: Response): boolean => {
  res.set('Cache-Control', 'no-store')
  if (getWikiAuth().checkAccess(req.user, ['manage:system'])) return true
  res.status(403).json({ error: 'System administration is required.' })
  return false
}
const failed = (res: Response, error: unknown) => {
  const status = errorStatus(error)
  const expected = status && [400, 403, 404, 409].includes(status)
  return res.status(expected ? status : 503).json({
    error:
      expected && error instanceof Error
        ? error.message
        : 'Logging administration is unavailable. Reload to inspect saved settings and process observations before repeating an action.'
  })
}
const livePrincipal = (req: LoggingRequest): string => {
  if (req.apiKeyAuth) return `key:${req.apiKeyAuth.apiKeyId}`
  const user = record(req.user)
  return typeof user.id === 'number' ? `user:${user.id}` : 'anonymous'
}
const liveLine = (value: unknown): LiveTrailLine | null => {
  const source = record(value)
  if (typeof source.output !== 'string') return null
  const timestamp =
    source.timestamp instanceof Date
      ? source.timestamp.toISOString()
      : typeof source.timestamp === 'string' && Number.isFinite(Date.parse(source.timestamp))
        ? source.timestamp
        : new Date().toISOString()
  const level = typeof source.level === 'string' && source.level.length <= 32 ? source.level : 'info'
  return { timestamp, level, output: redactLoggingLiveOutput(source.output) }
}
const streamWrite = (res: Response, value: string): boolean => !res.writableEnded && res.write(value)

router.get('/workspace', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getLoggingWorkspaceStore().inspect(systemRequester(req)))
  } catch (error) {
    failed(res, error)
  }
})

router.put('/workspace', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getLoggingWorkspaceStore().save(systemRequester(req), req.body))
  } catch (error) {
    failed(res, error)
  }
})

router.post('/workspace/apply', async (req, res) => {
  if (!authorized(req, res)) return
  try {
    res.json(await getLoggingWorkspaceStore().apply(systemRequester(req), req.body))
  } catch (error) {
    failed(res, error)
  }
})

router.get('/live', async (req, res) => {
  if (!authorized(req, res)) return
  const requester = systemRequester(req)
  const principal = livePrincipal(req)
  const currentConnections = liveConnections.get(principal) ?? 0
  if (currentConnections >= MAX_LIVE_CONNECTIONS_PER_PRINCIPAL) {
    res.status(429).json({ error: 'Close another live trail before opening a new one.' })
    return
  }
  liveConnections.set(principal, currentConnections + 1)
  let reserved = true
  const release = () => {
    if (!reserved) return
    reserved = false
    const remaining = (liveConnections.get(principal) ?? 1) - 1
    if (remaining > 0) liveConnections.set(principal, remaining)
    else liveConnections.delete(principal)
  }

  let broker: unknown
  try {
    broker = getTransportRuntime<{ loggingLiveTrail?: unknown }>().loggingLiveTrail
  } catch (error) {
    release()
    failed(res, error)
    return
  }
  if (!isLiveTrailBroker(broker)) {
    release()
    res.status(503).json({ error: 'Live logging is unavailable. Reload the workspace to inspect current process observations.' })
    return
  }
  try {
    await getLoggingWorkspaceStore().authorizeLive(requester)
  } catch (error) {
    release()
    failed(res, error)
    return
  }

  let source: LoggingLiveTrailSource
  try {
    source = broker.subscribe()
  } catch (error) {
    release()
    failed(res, error)
    return
  }
  res.status(200)
  res.set({
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream; charset=utf-8'
  })
  res.flushHeaders()
  streamWrite(res, 'retry: 5000\n\n')

  let closed = false
  let checking = false
  let heartbeat: NodeJS.Timeout | undefined
  const onClose = () => cleanup()
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    req.off('close', onClose)
    release()
    void source.return?.()
  }
  const revalidate = async () => {
    if (closed || checking) return
    checking = true
    try {
      await getLoggingWorkspaceStore().authorizeLive(requester)
      if (closed) return
      if (!streamWrite(res, ': keepalive\n\n')) cleanup()
    } catch {
      if (closed) return
      streamWrite(res, 'event: access-revoked\ndata: {"message":"Current system authority is required for the live trail."}\n\n')
      cleanup()
      res.end()
    } finally {
      checking = false
    }
  }
  heartbeat = setInterval(() => {
    void revalidate()
  }, LIVE_REVALIDATION_MILLISECONDS)
  heartbeat.unref()
  req.once('close', onClose)
  try {
    let sent = 0
    for await (const delivery of source) {
      if (closed) break
      if (delivery.type === 'overflow') {
        streamWrite(res, 'event: overflow\ndata: {"message":"The live trail ended because this connection could not keep up. Reconnect for a fresh view."}\n\n')
        break
      }
      try {
        await getLoggingWorkspaceStore().authorizeLive(requester)
        if (closed) break
      } catch {
        if (closed) break
        streamWrite(res, 'event: access-revoked\ndata: {"message":"Current system authority is required for the live trail."}\n\n')
        break
      }
      const line = liveLine(delivery.line)
      if (!line) continue
      sent += 1
      if (!streamWrite(res, `data: ${JSON.stringify(line)}\n\n`)) break
      if (sent >= 1000) {
        streamWrite(
          res,
          'event: limit\ndata: {"message":"The live trail connection reached its 1,000-event safety limit. Reconnect when you need a fresh view."}\n\n'
        )
        break
      }
    }
  } catch {
    if (!closed) streamWrite(res, 'event: unavailable\ndata: {"message":"The live trail ended unexpectedly. Reload the workspace before reconnecting."}\n\n')
  } finally {
    cleanup()
    if (!res.writableEnded) res.end()
  }
})

const retired = async (req: LoggingRequest, res: Response) => {
  if (!authorized(req, res)) return
  try {
    await getLoggingWorkspaceStore().authorizeLive(systemRequester(req))
    res.status(410).json({ error: 'Logging now uses reviewed workspace settings. Reload Administration or use /_api/logging/workspace.' })
  } catch (error) {
    failed(res, error)
  }
}

router.get('/loggers', retired)
router.post('/loggers', retired)

export default router
