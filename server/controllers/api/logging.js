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

module.exports = router
