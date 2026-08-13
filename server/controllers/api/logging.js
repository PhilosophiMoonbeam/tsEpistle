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

module.exports = router
