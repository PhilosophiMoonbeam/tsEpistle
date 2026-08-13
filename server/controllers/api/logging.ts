import express from 'express'
import { errorStatus, objectValue, type Request, type Response, wikiAuth } from '../_types.ts'

import loggingOperations from '../../operations/logging.ts'

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req: Request, res: Response, json = false): boolean => { if (!wikiAuth.checkAccess(req.user, ['manage:system'])) {
  if (json) res.status(403).json({ error: 'Forbidden' })
  else res.sendStatus(403)
  return false
}
return true }

router.get('/loggers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const loggers = await loggingOperations.listLoggers('title')
    res.json(loggers.map(logger => ({
      isEnabled: logger.isEnabled,
      key: logger.key,
      title: logger.title,
      description: logger.description,
      logo: logger.logo,
      website: logger.website,
      level: logger.level,
      config: logger.config
    })))
  } catch (err) {
    next(err)
  }
})

router.post('/loggers', async (req, res) => {
  if (!requireSystemAccess(req, res, true)) return
  try {
    await loggingOperations.updateLoggers(objectValue(req.body, 'loggers'))
    res.json({ message: 'Loggers updated successfully' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(errorStatus(err) ?? 500).json({ error: message || 'Loggers update failed' })
  }
})

router.get('/live', async (req, res, next) => {
  if (!requireSystemAccess(req, res, true)) return
  res.status(200)
  res.set({
    'Cache-Control': 'no-cache, no-transform',
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive'
  })
  res.flushHeaders()

  const emitter = WIKI.GQLEmitter
  const asyncIterator = objectValue(emitter, 'asyncIterator')
  if (typeof asyncIterator !== 'function') return next(new Error('Live log emitter is unavailable'))
  const iteratorValue: unknown = Reflect.apply(asyncIterator, emitter, ['livetrail'])
  if (
    typeof iteratorValue !== 'object' ||
    iteratorValue === null ||
    typeof Reflect.get(iteratorValue, Symbol.asyncIterator) !== 'function'
  ) return next(new Error('Live log emitter returned an invalid iterator'))
  const iterator = iteratorValue as AsyncIterableIterator<unknown>
  let closed = false
  req.on('close', async () => {
    closed = true
    if (typeof iterator.return === 'function') await iterator.return()
  })

  try {
    for await (const item of iterator) {
      if (closed) break
      res.write(`data: ${JSON.stringify(item)}\n\n`)
    }
  } catch (err) {
    if (!closed) next(err)
  }
})

export default router
