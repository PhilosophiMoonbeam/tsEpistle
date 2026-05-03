const express = require('express')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.sendStatus(403)
    return false
  }

  return true
}

const buildLoggerConfig = config => {
  if (!Array.isArray(config)) {
    throw new Error('Invalid loggers payload')
  }

  return _.reduce(config, (result, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.key !== 'string' || typeof value.value !== 'string') {
      throw new Error('Invalid loggers payload')
    }
    _.set(result, `${value.key}`, value.value)
    return result
  }, {})
}

const validateLoggerPayload = logger => {
  return logger &&
    typeof logger === 'object' &&
    !Array.isArray(logger) &&
    typeof logger.key === 'string' &&
    typeof logger.isEnabled === 'boolean' &&
    typeof logger.level === 'string' &&
    Array.isArray(logger.config) &&
    logger.config.every(value => value && typeof value === 'object' && !Array.isArray(value) && typeof value.key === 'string' && typeof value.value === 'string')
}

const serializeLogger = logger => {
  const loggerInfo = _.find(WIKI.data.loggers, ['key', logger.key]) || {}
  const mergedLogger = {
    ...loggerInfo,
    ...logger
  }
  const config = _.sortBy(_.transform(logger.config, (res, value, key) => {
    res.push({
      key,
      value: JSON.stringify({
        ..._.get(loggerInfo.props, key, {}),
        value
      })
    })
  }, []), 'key')

  return {
    isEnabled: mergedLogger.isEnabled,
    key: mergedLogger.key,
    title: mergedLogger.title,
    description: mergedLogger.description,
    logo: mergedLogger.logo,
    website: mergedLogger.website,
    level: mergedLogger.level,
    config
  }
}

router.get('/loggers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    const loggers = await WIKI.models.loggers.getLoggers()
    res.json(_.sortBy(loggers.map(serializeLogger), ['title']))
  } catch (err) {
    next(err)
  }
})

router.post('/loggers', async (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return
  }

  const loggers = req.body && req.body.loggers
  if (!Array.isArray(loggers) || loggers.some(logger => !validateLoggerPayload(logger))) {
    res.status(400).json({ error: 'Invalid loggers payload' })
    return
  }

  try {
    for (const logger of loggers) {
      await WIKI.models.loggers.query().patch({
        isEnabled: logger.isEnabled,
        level: logger.level,
        config: buildLoggerConfig(logger.config)
      }).where('key', logger.key)
    }

    res.json({ message: 'Loggers updated successfully' })
  } catch (err) {
    if (err.message === 'Invalid loggers payload') {
      res.status(400).json({ error: 'Invalid loggers payload' })
      return
    }
    res.status(500).json({ error: err.message || 'Loggers update failed' })
  }
})

module.exports = router
