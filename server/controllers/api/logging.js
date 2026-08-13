const express = require('express')

const loggingOperations = require('../../operations/logging')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res, json = false) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    if (json) res.status(403).json({ error: 'Forbidden' })
    else res.sendStatus(403)
    return false
  }
  return true
}

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
    await loggingOperations.updateLoggers(req.body && req.body.loggers)
    res.json({ message: 'Loggers updated successfully' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Loggers update failed' })
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

  const iterator = WIKI.GQLEmitter.asyncIterator('livetrail')
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

module.exports = router
