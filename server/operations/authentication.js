const _ = require('lodash')

const { ApplicationError } = require('./errors')
const { parseConfig } = require('./configuration')

/* global WIKI */

const validStrategy = strategy => strategy && _.isPlainObject(strategy) &&
  _.isString(strategy.key) && strategy.key.length > 0 &&
  _.isString(strategy.strategyKey) && strategy.strategyKey.length > 0 &&
  _.isString(strategy.displayName) && strategy.displayName.length > 0 &&
  Number.isInteger(strategy.order) && _.isBoolean(strategy.isEnabled) &&
  _.isBoolean(strategy.selfRegistration) &&
  Array.isArray(strategy.domainWhitelist) && strategy.domainWhitelist.every(_.isString) &&
  Array.isArray(strategy.autoEnrollGroups) && strategy.autoEnrollGroups.every(Number.isInteger) &&
  Array.isArray(strategy.config)

const listDefinitions = () => WIKI.data.authentication.map(strategy => ({
  ...strategy,
  isAvailable: strategy.isAvailable === true,
  props: _.sortBy(_.transform(strategy.props, (result, value, key) => {
    result.push({ key, value: JSON.stringify(value) })
  }, []), 'key')
}))

const listActive = async enabledOnly => {
  const strategies = (await WIKI.models.authentication.getStrategies()).map(strategy => {
    const definition = _.find(WIKI.data.authentication, ['key', strategy.strategyKey]) || {}
    return {
      ...strategy,
      strategy: definition,
      config: _.sortBy(_.transform(strategy.config, (result, value, key) => {
        const property = _.get(definition.props, key, false)
        if (property) result.push({ key, value: JSON.stringify({ ...property, value }) })
      }, []), 'key')
    }
  })
  return enabledOnly ? _.filter(strategies, 'isEnabled') : strategies
}

const listPublic = async () => {
  const strategies = await WIKI.models.authentication.getStrategies()
  return _.filter(strategies, 'isEnabled').map(strategy => {
    const definition = _.find(WIKI.data.authentication, ['key', strategy.strategyKey]) || {}
    return {
      key: strategy.key,
      displayName: strategy.displayName,
      order: strategy.order,
      selfRegistration: strategy.selfRegistration,
      strategy: _.pick(definition, ['key', 'title', 'logo', 'color', 'icon', 'useForm', 'usernameType'])
    }
  })
}

const listProviderOptions = async () => {
  return (await WIKI.models.authentication.getStrategies()).map(strategy => ({
    key: strategy.key,
    displayName: strategy.displayName,
    order: strategy.order,
    isEnabled: strategy.isEnabled === true
  }))
}

const updateStrategies = async strategies => {
  if (!Array.isArray(strategies) || strategies.some(strategy => !validStrategy(strategy))) {
    throw new ApplicationError('strategies must be an array of valid authentication strategies', { code: 'INVALID_AUTHENTICATION_STRATEGIES' })
  }
  const updates = strategies.map(strategy => ({
    ...strategy,
    config: parseConfig(strategy.config, { errorMessage: 'strategies must be an array of valid authentication strategies', code: 'INVALID_AUTHENTICATION_STRATEGIES' })
  }))
  const previousStrategies = await WIKI.models.authentication.getStrategies()
  for (const strategy of updates) {
    const patch = {
      key: strategy.key,
      strategyKey: strategy.strategyKey,
      displayName: strategy.displayName,
      order: strategy.order,
      isEnabled: strategy.isEnabled,
      config: strategy.config,
      selfRegistration: strategy.selfRegistration,
      domainWhitelist: { v: strategy.domainWhitelist },
      autoEnrollGroups: { v: strategy.autoEnrollGroups }
    }
    if (_.some(previousStrategies, ['key', strategy.key])) {
      await WIKI.models.authentication.query().patch(patch).where('key', strategy.key)
    } else {
      await WIKI.models.authentication.query().insert(patch)
    }
  }
  for (const strategy of _.differenceBy(previousStrategies, updates, 'key')) {
    const users = await WIKI.models.users.query().count('* as total').where({ providerKey: strategy.key }).first()
    if (_.toSafeInteger(users.total) > 0) {
      throw new ApplicationError(`Cannot delete ${strategy.displayName} as 1 or more users are still using it.`, { code: 'AUTHENTICATION_STRATEGY_IN_USE' })
    }
    await WIKI.models.authentication.query().delete().where('key', strategy.key)
  }
  await WIKI.auth.activateStrategies()
  WIKI.events.outbound.emit('reloadAuthStrategies')
}

const login = (args, context) => WIKI.models.users.login(args, context)
const loginForm = ({ strategyKey, username, password }, context) => {
  const strategy = _.get(WIKI.auth.strategies, strategyKey)
  const definition = strategy && _.find(WIKI.data.authentication, ['key', strategy.strategyKey])
  if (!strategy || !definition) throw new ApplicationError('Authentication strategy is invalid', { code: 'INVALID_AUTHENTICATION_STRATEGY' })
  if (!strategy.isEnabled) throw new ApplicationError('Authentication strategy is disabled', { code: 'DISABLED_AUTHENTICATION_STRATEGY' })
  if (!definition.useForm) throw new ApplicationError('REST login only supports form-based strategies', { code: 'UNSUPPORTED_AUTHENTICATION_STRATEGY' })
  if (!username || !password) throw new ApplicationError('username and password are required', { code: 'MISSING_AUTHENTICATION_CREDENTIALS' })
  if (!_.isString(username) || !_.isString(password)) throw new ApplicationError('username and password must be strings', { code: 'INVALID_AUTHENTICATION_CREDENTIALS' })
  return login({ strategy: strategyKey, username, password }, context)
}
const loginTfa = (args, context) => WIKI.models.users.loginTFA(args, context)
const loginChangePassword = (args, context) => WIKI.models.users.loginChangePassword(args, context)
const forgotPassword = (args, context) => WIKI.models.users.loginForgotPassword(args, context)
const regenerateCertificates = () => WIKI.auth.regenerateCertificates()
const resetGuestUser = () => WIKI.auth.resetGuestUser()
const register = (args, context) => WIKI.models.users.register({ ...args, verify: true }, context)
const getMetricsState = () => WIKI.config.metrics.isEnabled
const setMetricsState = async enabled => {
  if (!_.isBoolean(enabled)) {
    throw new ApplicationError('enabled must be a boolean', { code: 'INVALID_METRICS_STATE' })
  }
  const previousState = WIKI.config.metrics.isEnabled
  try {
    WIKI.config.metrics.isEnabled = enabled
    await WIKI.metrics.init()
    const saved = await WIKI.configSvc.saveToDb(['metrics'])
    if (!saved) throw new Error('Failed to persist metrics state change')
  } catch (err) {
    WIKI.config.metrics.isEnabled = previousState
    try {
      await WIKI.metrics.init()
    } catch (rollbackErr) {
      throw new Error(`Failed to rollback metrics runtime state: ${rollbackErr.message}`)
    }
    throw err
  }
}

module.exports = {
  forgotPassword,
  getMetricsState,
  listActive,
  listDefinitions,
  listProviderOptions,
  listPublic,
  login,
  loginForm,
  loginChangePassword,
  loginTfa,
  regenerateCertificates,
  register,
  resetGuestUser,
  setMetricsState,
  updateStrategies
}
