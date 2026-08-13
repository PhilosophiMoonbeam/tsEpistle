const express = require('express')
const ExpressBrute = require('express-brute')
const _ = require('lodash')

const BruteKnex = require('../../helpers/brute-knex')
const apiOperations = require('../../operations/api')
const authenticationOperations = require('../../operations/authentication')

const router = express.Router()

/* global WIKI */

const bruteforce = new ExpressBrute(new BruteKnex({
  createTable: true,
  knex: WIKI.models.knex
}), {
  freeRetries: 5,
  minWait: 5 * 60 * 1000,
  maxWait: 60 * 60 * 1000,
  failCallback: (req, res) => res.status(401).json({ error: 'Too many failed attempts. Try again later.' })
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

const authErrorStatus = err => {
  if (Number.isInteger(err.status)) return err.status
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
  if (!status) return false
  res.status(status).json({ error: err.message })
  return true
}

const requireAdminApiAccess = (req, res) => {
  if (WIKI.auth.checkAccess(req.user, ['manage:system', 'manage:api'])) return true
  res.status(403).json({ error: 'manage:system or manage:api is required' })
  return false
}

const requireSystemAccess = (req, res) => {
  if (WIKI.auth.checkAccess(req.user, ['manage:system'])) return true
  res.status(403).json({ error: 'manage:system is required' })
  return false
}

router.get('/admin/strategies', (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(authenticationOperations.listDefinitions())
  } catch (err) {
    next(err)
  }
})

router.get('/admin/active-strategies', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(await authenticationOperations.listActive(_.get(req, 'query.enabledOnly') === 'true'))
  } catch (err) {
    next(err)
  }
})

router.get('/strategies', async (req, res, next) => {
  try {
    res.json(await authenticationOperations.listPublic())
  } catch (err) {
    next(err)
  }
})
router.post('/strategies', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await authenticationOperations.updateStrategies(req.body && req.body.strategies)
    res.json({ message: 'Strategies updated successfully' })
  } catch (err) {
    res.status(err.name === 'INVALID_AUTHENTICATION_STRATEGIES' ? err.status : 500).json({ error: err.message || 'Authentication strategies update failed' })
  }
})

router.get('/providers', async (req, res, next) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system', 'write:users', 'manage:users'])) {
    return res.status(403).json({ error: 'manage:system, write:users, or manage:users is required' })
  }
  try {
    res.json(await authenticationOperations.listProviderOptions())
  } catch (err) {
    next(err)
  }
})

router.get('/api', async (req, res, next) => {
  if (!requireAdminApiAccess(req, res)) return
  try {
    res.json(await apiOperations.getConfig())
  } catch (err) {
    next(err)
  }
})

router.post('/api/state', async (req, res) => {
  if (!requireAdminApiAccess(req, res)) return
  try {
    await apiOperations.setState(req.body && req.body.enabled)
    res.json({ message: 'API State changed successfully' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'API state update failed' })
  }
})

router.post('/api/keys', async (req, res) => {
  if (!requireAdminApiAccess(req, res)) return
  try {
    const key = await apiOperations.createKey({
      name: req.body && req.body.name,
      expiration: req.body && req.body.expiration,
      fullAccess: req.body && req.body.fullAccess,
      group: req.body && Object.prototype.hasOwnProperty.call(req.body, 'group') ? req.body.group : null
    })
    res.json({ key, message: 'API Key created successfully' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'API key creation failed' })
  }
})

router.post('/api/keys/:id/revoke', async (req, res) => {
  if (!requireAdminApiAccess(req, res)) return
  try {
    await apiOperations.revokeKey(Number(req.params && req.params.id))
    res.json({ message: 'API Key revoked successfully' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'API key revoke failed' })
  }
})

router.post('/certificates/regenerate', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await authenticationOperations.regenerateCertificates()
    res.json({ message: 'Certificates have been regenerated successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Certificate regeneration failed' })
  }
})

router.post('/guest/reset', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await authenticationOperations.resetGuestUser()
    res.json({ message: 'Guest user has been reset successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Guest user reset failed' })
  }
})

router.post('/register', async (req, res, next) => {
  try {
    await authenticationOperations.register({
      email: req.body && req.body.email,
      password: req.body && req.body.password,
      name: req.body && req.body.name
    }, { req, res })
    res.status(201).json({ message: 'Registration success' })
  } catch (err) {
    next(err)
  }
})

router.post('/forgot-password', bruteforce.prevent, async (req, res, next) => {
  const email = req.body && req.body.email
  if (!email) return res.status(400).json({ error: 'email is required' })
  if (!_.isString(email)) return res.status(400).json({ error: 'email must be a string' })
  try {
    await authenticationOperations.forgotPassword({ email }, { req, res })
    res.json({ message: 'Password reset request processed.' })
  } catch (err) {
    next(err)
  }
})

router.post('/login', bruteforce.prevent, async (req, res, next) => {
  try {
    const result = await authenticationOperations.loginForm({
      strategyKey: req.body && req.body.strategy,
      username: req.body && req.body.username,
      password: req.body && req.body.password
    }, { req, res })
    if (_.get(req, 'brute.reset')) req.brute.reset()
    res.json(toAuthResponse(result))
  } catch (err) {
    if (!handleExpectedAuthError(err, res)) next(err)
  }
})

router.post('/login/tfa', bruteforce.prevent, async (req, res, next) => {
  const securityCode = req.body && req.body.securityCode
  const continuationToken = req.body && req.body.continuationToken
  if (!securityCode || !continuationToken) return res.status(400).json({ error: 'securityCode and continuationToken are required' })
  if (!_.isString(securityCode) || !_.isString(continuationToken)) return res.status(400).json({ error: 'securityCode and continuationToken must be strings' })
  try {
    const result = await authenticationOperations.loginTfa({ securityCode, continuationToken, setup: req.body.setup === true }, { req, res })
    if (_.get(req, 'brute.reset')) req.brute.reset()
    res.json(toAuthResponse(result))
  } catch (err) {
    if (!handleExpectedAuthError(err, res)) next(err)
  }
})

router.post('/login/change-password', bruteforce.prevent, async (req, res, next) => {
  const continuationToken = req.body && req.body.continuationToken
  const newPassword = req.body && req.body.newPassword
  if (!continuationToken || !newPassword) return res.status(400).json({ error: 'continuationToken and newPassword are required' })
  if (!_.isString(continuationToken) || !_.isString(newPassword)) return res.status(400).json({ error: 'continuationToken and newPassword must be strings' })
  try {
    const result = await authenticationOperations.loginChangePassword({ continuationToken, newPassword }, { req, res })
    if (_.get(req, 'brute.reset')) req.brute.reset()
    res.json(toAuthResponse(result))
  } catch (err) {
    if (!handleExpectedAuthError(err, res)) next(err)
  }
})

module.exports = router
