import express from 'express'
import { errorStatus, objectValue, type Request, type Response, getWikiAuth } from '../_types.ts'
import { createAuthRateLimiter } from '../../helpers/auth-rate-limiter.ts'
import _ from 'lodash'

import apiOperations from '../../operations/api.ts'
import authenticationOperations from '../../operations/authentication.ts'

const router = express.Router()

/* global WIKI */
const wikiModels = WIKI.models as { knex: Parameters<typeof createAuthRateLimiter>[0]['knex'] }
const bruteforce = createAuthRateLimiter({
  knex: wikiModels.knex,
  keyPrefix: 'auth-api',
  onLimit: (_req, res) => {
    res.status(401).json({ error: 'Too many failed attempts. Try again later.' })
  }
})

const toAuthResponse = (result: unknown = {}) => ({
  jwt: _.get(result, 'jwt', null),
  mustChangePwd: _.get(result, 'mustChangePwd', false),
  mustProvideTFA: _.get(result, 'mustProvideTFA', false),
  mustSetupTFA: _.get(result, 'mustSetupTFA', false),
  continuationToken: _.get(result, 'continuationToken', null),
  redirect: _.get(result, 'redirect', null),
  tfaQRImage: _.get(result, 'tfaQRImage', null)
})

const authErrorStatus = (value: unknown): number | null => {
  const status = errorStatus(value)
  if (status !== undefined) return status
  switch (objectValue(value, 'code')) {
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

const handleExpectedAuthError = (err: unknown, res: Response): boolean => {
  const status = authErrorStatus(err)
  if (!status) return false
  const message = err instanceof Error ? err.message : String(err)
  res.status(status).json({ error: message })
  return true
}

const requireAdminApiAccess = (req: Request, res: Response): boolean => {
  if (getWikiAuth().checkAccess(req.user, ['manage:system', 'manage:api'])) return true
  res.status(403).json({ error: 'manage:system or manage:api is required' })
  return false
}

const requireSystemAccess = (req: Request, res: Response): boolean => {
  if (getWikiAuth().checkAccess(req.user, ['manage:system'])) return true
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
    await authenticationOperations.updateStrategies(objectValue(req.body, 'strategies'))
    res.json({ message: 'Strategies updated successfully' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const status = objectValue(err, 'name') === 'INVALID_AUTHENTICATION_STRATEGIES' ? (errorStatus(err) ?? 500) : 500
    res.status(status).json({ error: message || 'Authentication strategies update failed' })
  }
})

router.get('/providers', async (req, res, next) => {
  if (!getWikiAuth().checkAccess(req.user, ['manage:system', 'write:users', 'manage:users'])) {
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
    await apiOperations.setState(objectValue(req.body, 'enabled'))
    res.json({ message: 'API State changed successfully' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(errorStatus(err) ?? 500).json({ error: message || 'API state update failed' })
  }
})

router.post('/api/keys', async (req, res) => {
  if (!requireAdminApiAccess(req, res)) return
  try {
    const key = await apiOperations.createKey({
      name: objectValue(req.body, 'name'),
      expiration: objectValue(req.body, 'expiration'),
      fullAccess: objectValue(req.body, 'fullAccess'),
      group: objectValue(req.body, 'group')
    })
    res.json({ key, message: 'API Key created successfully' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(errorStatus(err) ?? 500).json({ error: message || 'API key creation failed' })
  }
})

router.post('/api/keys/:id/revoke', async (req, res) => {
  if (!requireAdminApiAccess(req, res)) return
  try {
    await apiOperations.revokeKey(Number(req.params.id))
    res.json({ message: 'API Key revoked successfully' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(errorStatus(err) ?? 500).json({ error: message || 'API key revoke failed' })
  }
})

router.post('/certificates/regenerate', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await authenticationOperations.regenerateCertificates()
    res.json({ message: 'Certificates have been regenerated successfully.' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message || 'Certificate regeneration failed' })
  }
})

router.post('/guest/reset', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await authenticationOperations.resetGuestUser()
    res.json({ message: 'Guest user has been reset successfully.' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    res.status(500).json({ error: message || 'Guest user reset failed' })
  }
})

router.post('/register', async (req, res, next) => {
  try {
    await authenticationOperations.register({
      email: objectValue(req.body, 'email'),
      password: objectValue(req.body, 'password'),
      name: objectValue(req.body, 'name')
    }, { req, res })
    res.status(201).json({ message: 'Registration success' })
  } catch (err) {
    next(err)
  }
})

router.post('/forgot-password', bruteforce.middleware, async (req, res, next) => {
  const email = objectValue(req.body, 'email')
  if (!email) return res.status(400).json({ error: 'email is required' })
  if (typeof email !== 'string') return res.status(400).json({ error: 'email must be a string' })
  try {
    await authenticationOperations.forgotPassword({ email }, { req, res })
    res.json({ message: 'Password reset request processed.' })
  } catch (err) {
    next(err)
  }
})

router.post('/login', bruteforce.middleware, async (req, res, next) => {
  const strategy = objectValue(req.body, 'strategy')
  const strategyKey = typeof strategy === 'string' ? strategy : ''
  try {
    const result = await authenticationOperations.loginForm({
      strategyKey,
      username: objectValue(req.body, 'username'),
      password: objectValue(req.body, 'password')
    }, { req, res })
    await bruteforce.reset(req)
    res.json(toAuthResponse(result))
  } catch (err) {
    if (!handleExpectedAuthError(err, res)) next(err)
  }
})

router.post('/login/tfa', bruteforce.middleware, async (req, res, next) => {
  const securityCode = objectValue(req.body, 'securityCode')
  const continuationToken = objectValue(req.body, 'continuationToken')
  if (!securityCode || !continuationToken) return res.status(400).json({ error: 'securityCode and continuationToken are required' })
  if (typeof securityCode !== 'string' || typeof continuationToken !== 'string') return res.status(400).json({ error: 'securityCode and continuationToken must be strings' })
  try {
    const result = await authenticationOperations.loginTfa({
      securityCode,
      continuationToken,
      setup: objectValue(req.body, 'setup') === true
    }, { req, res })
    await bruteforce.reset(req)
    res.json(toAuthResponse(result))
  } catch (err) {
    if (!handleExpectedAuthError(err, res)) next(err)
  }
})

router.post('/login/change-password', bruteforce.middleware, async (req, res, next) => {
  const continuationToken = objectValue(req.body, 'continuationToken')
  const newPassword = objectValue(req.body, 'newPassword')
  if (!continuationToken || !newPassword) return res.status(400).json({ error: 'continuationToken and newPassword are required' })
  if (typeof continuationToken !== 'string' || typeof newPassword !== 'string') return res.status(400).json({ error: 'continuationToken and newPassword must be strings' })
  try {
    const result = await authenticationOperations.loginChangePassword({ continuationToken, newPassword }, { req, res })
    await bruteforce.reset(req)
    res.json(toAuthResponse(result))
  } catch (err) {
    if (!handleExpectedAuthError(err, res)) next(err)
  }
})

export default router
