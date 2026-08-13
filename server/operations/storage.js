const _ = require('lodash')

const { ApplicationError } = require('./errors')
const { parseConfig, serializeConfig } = require('./configuration')

/* global WIKI */

const requireString = (value, label) => {
  if (!_.isString(value) || _.trim(value).length < 1) {
    throw new ApplicationError(`${label} is required.`, { code: 'INVALID_STORAGE_ARGUMENT' })
  }
}

const validateTargets = targets => {
  if (!Array.isArray(targets)) {
    throw new ApplicationError('targets must be an array.', { code: 'INVALID_STORAGE_TARGETS' })
  }
  for (const target of targets) {
    requireString(_.get(target, 'key', ''), 'target key')
    if (!_.isBoolean(target.isEnabled)) {
      throw new ApplicationError('target isEnabled must be a boolean.', { code: 'INVALID_STORAGE_TARGETS' })
    }
    requireString(_.get(target, 'mode', ''), 'target mode')
    if (!Array.isArray(target.config)) {
      throw new ApplicationError('target config must be an array.', { code: 'INVALID_STORAGE_TARGETS' })
    }
  }
}

const listTargets = async () => {
  const targets = await WIKI.models.storage.getTargets()
  return _.sortBy(targets.map(target => {
    const definition = _.find(WIKI.data.storage, ['key', target.key]) || {}
    return {
      ...definition,
      ...target,
      hasSchedule: definition.schedule !== false,
      syncInterval: target.syncInterval || definition.schedule || 'P0D',
      syncIntervalDefault: definition.schedule,
      config: serializeConfig({ config: target.config, definition, knownOnly: true, maskSensitive: true })
    }
  }), ['title', 'key'])
}

const listStatus = async () => {
  const activeTargets = await WIKI.models.storage.query().where('isEnabled', true)
  return activeTargets.map(target => {
    const definition = _.find(WIKI.data.storage, ['key', target.key]) || {}
    return {
      key: target.key,
      title: definition.title,
      status: _.get(target, 'state.status', 'pending'),
      message: _.get(target, 'state.message', 'Initializing...'),
      lastAttempt: _.get(target, 'state.lastAttempt', null)
    }
  })
}

const updateTargets = async targets => {
  validateTargets(targets)
  const currentTargets = await WIKI.models.storage.getTargets()
  for (const target of targets) {
    const current = _.find(currentTargets, ['key', target.key])
    if (!current) continue
    const config = parseConfig(target.config, { errorMessage: 'target config must contain valid entries' })
    for (const [key, value] of Object.entries(config)) {
      if (value === '********') config[key] = _.get(current.config, key, '')
    }
    await WIKI.models.storage.query().patch({
      isEnabled: target.isEnabled,
      mode: target.mode,
      syncInterval: target.syncInterval,
      config,
      state: {
        status: 'pending',
        message: 'Initializing...',
        lastAttempt: null
      }
    }).where('key', target.key)
  }
  await WIKI.models.storage.initTargets()
}

const executeAction = async ({ targetKey, handler }) => {
  requireString(targetKey, 'targetKey')
  requireString(handler, 'handler')
  await WIKI.models.storage.executeAction(targetKey, handler)
}

module.exports = { executeAction, listStatus, listTargets, updateTargets }
