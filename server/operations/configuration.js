const _ = require('lodash')

const { ApplicationError } = require('./errors')

const parseConfig = (config, { errorMessage, unwrap = true, code = 'INVALID_CONFIGURATION' }) => {
  if (!Array.isArray(config)) {
    throw new ApplicationError(errorMessage, { code })
  }
  return _.reduce(config, (result, entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.key !== 'string' || typeof entry.value !== 'string') {
      throw new ApplicationError(errorMessage, { code })
    }
    try {
      _.set(result, entry.key, unwrap ? _.get(JSON.parse(entry.value), 'v', null) : entry.value)
    } catch (err) {
      throw new ApplicationError(errorMessage, { code })
    }
    return result
  }, {})
}

const serializeConfig = ({ config = {}, definition = {}, knownOnly = false, maskSensitive = false }) => {
  return _.sortBy(_.transform(config, (result, value, key) => {
    const property = _.get(definition.props, key, false)
    if (!knownOnly || property) {
      result.push({
        key,
        value: JSON.stringify({
          ...(property || {}),
          value: maskSensitive && property.sensitive && value.length > 0 ? '********' : value
        })
      })
    }
  }, []), 'key')
}

const validateRows = (rows, validate, message) => {
  if (!Array.isArray(rows) || rows.some(row => !validate(row))) {
    throw new ApplicationError(message, { code: 'INVALID_CONFIGURATION' })
  }
}

module.exports = {
  parseConfig,
  serializeConfig,
  validateRows
}
