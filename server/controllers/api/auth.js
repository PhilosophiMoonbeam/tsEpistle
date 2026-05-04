const express = require('express')
const ExpressBrute = require('express-brute')
const BruteKnex = require('../../helpers/brute-knex')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const bruteforce = new ExpressBrute(new BruteKnex({
  createTable: true,
  knex: WIKI.models.knex
}), {
  freeRetries: 5,
  minWait: 5 * 60 * 1000,
  maxWait: 60 * 60 * 1000,
  failCallback: (req, res, next) => {
    res.status(401).json({ error: 'Too many failed attempts. Try again later.' })
  }
})

const toAuthResponse = (result = {}) => ({
  jwt: _.get(result, 'jwt', null),
  mustChangePwd: _.get(result, 'mustChangePwd', false),
  mustProvideTFA: _.get(result, 'mustProvideTFA', false),
  mustSetupTFA: _.get(result, 'mustSetupTFA', false),
  continuationToken: _.get(result, 'continuationToken', null),
  redirect: _.get(result, 'redirect', null),
  tfaQRImage: _.get(result, 'tfaQRImage', null)
})

const getStrategyInfo = (strategyKey) => _.find(WIKI.data.authentication, ['key', strategyKey]) || null

const authErrorStatus = (err) => {
  switch (_.get(err, 'code')) {
    case 1002:
    case 1005:
    case 1006:
    case 1013:
    case 1014:
    case 1015:
    case 1016:
      return 401
    case 1003:
    case 1012:
      return 400
    default:
      return null
  }
}

const handleExpectedAuthError = (err, res) => {
  const status = authErrorStatus(err)
  if (!status) {
    return false
  }

  res.status(status).json({ error: err.message })
  return true
}

const requireAdminApiAccess = (req, res) => {
  if (WIKI.auth.checkAccess(req.user, ['manage:system', 'manage:api'])) {
    return true
  }

  res.status(403).json({ error: 'manage:system or manage:api is required' })
  return false
}

const requireSystemAccess = (req, res) => {
  if (WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    return true
  }

  res.status(403).json({ error: 'manage:system is required' })
  return false
}

const getRedactedApiKeySuffix = (key) => {
  if (!_.isString(key) || key.length <= 20) {
    return '...[redacted]'
  }

  return '...' + key.substring(key.length - 20)
}

const toApiKeyResponse = (apiKey) => ({
  id: apiKey.id,
  name: apiKey.name,
  keyShort: getRedactedApiKeySuffix(apiKey.key),
  isRevoked: apiKey.isRevoked,
  expiration: apiKey.expiration,
  createdAt: apiKey.createdAt,
  updatedAt: apiKey.updatedAt
})

router.get('/strategies', async (req, res, next) => {
  try {
    const strategies = await WIKI.models.authentication.getStrategies()
    const enabledStrategies = _.filter(strategies, 'isEnabled')

    res.json(enabledStrategies.map(stg => {
      const strategyInfo = getStrategyInfo(stg.strategyKey) || {}
      return {
        key: stg.key,
        displayName: stg.displayName,
        order: stg.order,
        selfRegistration: stg.selfRegistration,
        strategy: _.pick(strategyInfo, ['key', 'title', 'logo', 'color', 'icon', 'useForm', 'usernameType'])
      }
    }))
  } catch (err) {
    next(err)
  }
})

router.get('/providers', async (req, res, next) => {
  try {
    if (!WIKI.auth.checkAccess(req.user, ['manage:system', 'write:users', 'manage:users'])) {
      return res.status(403).json({ error: 'manage:system, write:users, or manage:users is required' })
    }

    const strategies = await WIKI.models.authentication.getStrategies()
    res.json(strategies.map(stg => ({
      key: stg.key,
      displayName: stg.displayName,
      order: stg.order,
      isEnabled: stg.isEnabled === true
    })))
  } catch (err) {
    next(err)
  }
})

router.get('/api', async (req, res, next) => {
  try {
    if (!requireAdminApiAccess(req, res)) {
      return
    }

    const keys = await WIKI.models.apiKeys.query().orderBy(['isRevoked', 'name'])
    res.json({
      enabled: WIKI.config.api.isEnabled === true,
      keys: keys.map(toApiKeyResponse)
    })
  } catch (err) {
    next(err)
  }
})

router.post('/api/state', async (req, res) => {
  if (!requireAdminApiAccess(req, res)) {
    return
  }

  const enabled = _.get(req, 'body.enabled')
  if (!_.isBoolean(enabled)) {
    return res.status(400).json({ error: 'enabled must be a boolean' })
  }

  try {
    WIKI.config.api.isEnabled = enabled
    await WIKI.configSvc.saveToDb(['api'])
    res.json({ message: 'API State changed successfully' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'API state update failed' })
  }
})

router.post('/api/keys', async (req, res) => {
  if (!requireAdminApiAccess(req, res)) {
    return
  }

  const name = _.get(req, 'body.name')
  const expiration = _.get(req, 'body.expiration')
  const fullAccess = _.get(req, 'body.fullAccess')
  const group = _.get(req, 'body.group', null)

  if (!_.isString(name) || name.length < 1) {
    return res.status(400).json({ error: 'name must be a non-empty string' })
  }
  if (!_.isString(expiration) || expiration.length < 1) {
    return res.status(400).json({ error: 'expiration must be a non-empty string' })
  }
  if (!_.isBoolean(fullAccess)) {
    return res.status(400).json({ error: 'fullAccess must be a boolean' })
  }
  if (!_.isNil(group) && !Number.isInteger(group)) {
    return res.status(400).json({ error: 'group must be an integer or null' })
  }

  try {
    const key = await WIKI.models.apiKeys.createNewKey({ name, expiration, fullAccess, group })
    await WIKI.auth.reloadApiKeys()
    WIKI.events.outbound.emit('reloadApiKeys')
    res.json({
      key,
      message: 'API Key created successfully'
    })
  } catch (err) {
    res.status(500).json({ error: err.message || 'API key creation failed' })
  }
})

router.post('/api/keys/:id/revoke', async (req, res) => {
  if (!requireAdminApiAccess(req, res)) {
    return
  }

  const rawId = _.get(req, 'params.id')
  if (!_.isString(rawId) || !/^[1-9]\d*$/.test(rawId)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  const id = Number(rawId)
  if (!Number.isSafeInteger(id)) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  try {
    await WIKI.models.apiKeys.query().findById(id).patch({
      isRevoked: true
    })
    await WIKI.auth.reloadApiKeys()
    WIKI.events.outbound.emit('reloadApiKeys')
    res.json({ message: 'API Key revoked successfully' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'API key revoke failed' })
  }
})

router.post('/certificates/regenerate', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    await WIKI.auth.regenerateCertificates()
    res.json({ message: 'Certificates have been regenerated successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Certificate regeneration failed' })
  }
})

router.post('/guest/reset', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    await WIKI.auth.resetGuestUser()
    res.json({ message: 'Guest user has been reset successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Guest user reset failed' })
  }
})

router.post('/forgot-password', bruteforce.prevent, async (req, res, next) => {
  try {
    const email = _.get(req, 'body.email')

    if (!email) {
      return res.status(400).json({ error: 'email is required' })
    }
    if (!_.isString(email)) {
      return res.status(400).json({ error: 'email must be a string' })
    }

    await WIKI.models.users.loginForgotPassword({
      email
    }, { req, res })

    res.json({ message: 'Password reset request processed.' })
  } catch (err) {
    next(err)
  }
})

router.post('/login', bruteforce.prevent, async (req, res, next) => {
  try {
    const strategyKey = _.get(req, 'body.strategy')
    const username = _.get(req, 'body.username')
    const password = _.get(req, 'body.password')
    const strategy = _.get(WIKI.auth.strategies, strategyKey)
    const strategyInfo = strategy ? getStrategyInfo(strategy.strategyKey) : null

    if (!strategy || !strategyInfo) {
      return res.status(400).json({ error: 'Authentication strategy is invalid' })
    }
    if (!strategy.isEnabled) {
      return res.status(400).json({ error: 'Authentication strategy is disabled' })
    }
    if (!strategyInfo.useForm) {
      return res.status(400).json({ error: 'REST login only supports form-based strategies' })
    }
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password are required' })
    }
    if (!_.isString(username) || !_.isString(password)) {
      return res.status(400).json({ error: 'username and password must be strings' })
    }

    const result = await WIKI.models.users.login({
      strategy: strategyKey,
      username,
      password
    }, { req, res })

    if (_.get(req, 'brute.reset')) {
      req.brute.reset()
    }
    res.json(toAuthResponse(result))
  } catch (err) {
    if (!handleExpectedAuthError(err, res)) {
      next(err)
    }
  }
})

router.post('/login/tfa', bruteforce.prevent, async (req, res, next) => {
  try {
    const securityCode = _.get(req, 'body.securityCode')
    const continuationToken = _.get(req, 'body.continuationToken')
    const setup = _.get(req, 'body.setup') === true

    if (!securityCode || !continuationToken) {
      return res.status(400).json({ error: 'securityCode and continuationToken are required' })
    }
    if (!_.isString(securityCode) || !_.isString(continuationToken)) {
      return res.status(400).json({ error: 'securityCode and continuationToken must be strings' })
    }

    const result = await WIKI.models.users.loginTFA({
      securityCode,
      continuationToken,
      setup
    }, { req, res })

    if (_.get(req, 'brute.reset')) {
      req.brute.reset()
    }
    res.json(toAuthResponse(result))
  } catch (err) {
    if (!handleExpectedAuthError(err, res)) {
      next(err)
    }
  }
})

router.post('/login/change-password', bruteforce.prevent, async (req, res, next) => {
  try {
    const continuationToken = _.get(req, 'body.continuationToken')
    const newPassword = _.get(req, 'body.newPassword')

    if (!continuationToken || !newPassword) {
      return res.status(400).json({ error: 'continuationToken and newPassword are required' })
    }
    if (!_.isString(continuationToken) || !_.isString(newPassword)) {
      return res.status(400).json({ error: 'continuationToken and newPassword must be strings' })
    }

    const result = await WIKI.models.users.loginChangePassword({
      continuationToken,
      newPassword
    }, { req, res })

    if (_.get(req, 'brute.reset')) {
      req.brute.reset()
    }
    res.json(toAuthResponse(result))
  } catch (err) {
    if (!handleExpectedAuthError(err, res)) {
      next(err)
    }
  }
})

module.exports = router
