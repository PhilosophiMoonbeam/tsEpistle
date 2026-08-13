const _ = require('lodash')

const { parseConfig, serializeConfig, validateRows } = require('./configuration')

/* global WIKI */

const validLogger = logger => logger && typeof logger === 'object' && !Array.isArray(logger) && typeof logger.key === 'string' && typeof logger.isEnabled === 'boolean' && typeof logger.level === 'string' && Array.isArray(logger.config)

const listLoggers = async orderBy => {
  const loggers = await WIKI.models.loggers.getLoggers()
  const result = loggers.map(logger => {
    const definition = _.find(WIKI.data.loggers, ['key', logger.key]) || {}
    return {
      ...definition,
      ...logger,
      config: serializeConfig({ config: logger.config, definition })
    }
  })
  return orderBy ? _.sortBy(result, [orderBy]) : result
}

const updateLoggers = async loggers => {
  validateRows(loggers, validLogger, 'Invalid loggers payload')
  const updates = loggers.map(logger => ({
    key: logger.key,
    isEnabled: logger.isEnabled,
    level: logger.level,
    config: parseConfig(logger.config, { errorMessage: 'Invalid loggers payload', unwrap: false })
  }))
  for (const logger of updates) {
    await WIKI.models.loggers.query().patch({
      isEnabled: logger.isEnabled,
      level: logger.level,
      config: logger.config
    }).where('key', logger.key)
  }
}

module.exports = { listLoggers, updateLoggers }
