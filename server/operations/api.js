const _ = require('lodash')

const { ApplicationError } = require('./errors')

/* global WIKI */

const redactedSuffix = key => _.isString(key) && key.length > 20 ? `...${key.substring(key.length - 20)}` : '...[redacted]'

const serializeKey = key => ({
  id: key.id,
  name: key.name,
  keyShort: redactedSuffix(key.key),
  isRevoked: key.isRevoked,
  expiration: key.expiration,
  createdAt: key.createdAt,
  updatedAt: key.updatedAt
})

const getConfig = async () => ({
  enabled: WIKI.config.api.isEnabled === true,
  keys: (await WIKI.models.apiKeys.query().orderBy(['isRevoked', 'name'])).map(serializeKey)
})

const setState = async enabled => {
  if (!_.isBoolean(enabled)) throw new ApplicationError('enabled must be a boolean', { code: 'INVALID_API_STATE' })
  WIKI.config.api.isEnabled = enabled
  await WIKI.configSvc.saveToDb(['api'])
}

const createKey = async ({ name, expiration, fullAccess, group }) => {
  if (!_.isString(name) || name.length < 1) throw new ApplicationError('name must be a non-empty string', { code: 'INVALID_API_KEY_NAME' })
  if (!_.isString(expiration) || expiration.length < 1) throw new ApplicationError('expiration must be a non-empty string', { code: 'INVALID_API_KEY_EXPIRATION' })
  if (!_.isBoolean(fullAccess)) throw new ApplicationError('fullAccess must be a boolean', { code: 'INVALID_API_KEY_ACCESS' })
  if (!_.isNil(group) && !Number.isInteger(group)) throw new ApplicationError('group must be an integer or null', { code: 'INVALID_API_KEY_GROUP' })
  const key = await WIKI.models.apiKeys.createNewKey({ name, expiration, fullAccess, group })
  await WIKI.auth.reloadApiKeys()
  WIKI.events.outbound.emit('reloadApiKeys')
  return key
}

const revokeKey = async id => {
  if (!Number.isSafeInteger(id) || id < 1) throw new ApplicationError('id must be a positive integer', { code: 'INVALID_API_KEY_ID' })
  await WIKI.models.apiKeys.query().findById(id).patch({ isRevoked: true })
  await WIKI.auth.reloadApiKeys()
  WIKI.events.outbound.emit('reloadApiKeys')
}

module.exports = { createKey, getConfig, revokeKey, setState }
