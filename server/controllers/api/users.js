const express = require('express')
const _ = require('lodash')
const userOperations = require('../../operations/users')

const router = express.Router()

/* global WIKI */

const userActivityAccessPermissions = ['write:groups', 'manage:groups', 'write:users', 'manage:users', 'manage:system']
const userMutationAccessPermissions = ['write:users', 'manage:users', 'manage:system']

const pickListUser = user => ({
  id: user.id,
  email: user.email,
  name: user.name,
  providerKey: user.providerKey,
  isSystem: Boolean(user.isSystem),
  isActive: Boolean(user.isActive),
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt || null
})

const normalizeUserIdParam = (value, res) => {
  if (!/^[1-9]\d*$/.test(value)) {
    res.status(400).json({ error: 'user id must be a positive integer' })
    return null
  }

  return Number.parseInt(value, 10)
}

const requireBooleanBodyValue = (req, res, field) => {
  const value = _.get(req, ['body', field])
  if (typeof value !== 'boolean') {
    res.status(400).json({ error: `${field} must be a boolean` })
    return null
  }

  return value
}

const requireUserSearchAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, userActivityAccessPermissions)) {
    res.status(403).json({ error: 'a user search admin permission is required' })
    return false
  }

  return true
}

const requireUserLastLoginsAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, userActivityAccessPermissions)) {
    res.status(403).json({ error: 'a dashboard user activity permission is required' })
    return false
  }

  return true
}

const requireUserDetailAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:users', 'manage:system'])) {
    res.status(403).json({ error: 'manage:users or manage:system is required' })
    return false
  }

  return true
}

const requireUserMutationAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, userMutationAccessPermissions)) {
    res.status(403).json({ error: 'write:users, manage:users or manage:system is required' })
    return false
  }

  return true
}

router.post('/', async (req, res, next) => {
  if (!requireUserMutationAccess(req, res)) {
    return
  }

  const payload = _.pick(req.body, ['providerKey', 'email', 'passwordRaw', 'name', 'groups', 'mustChangePassword', 'sendWelcomeEmail'])
  if (!Array.isArray(payload.groups)) {
    return res.status(400).json({ error: 'groups must be an array' })
  }

  try {
    await userOperations.create({ requester: req.user, input: payload })
    return res.json({
      succeeded: true,
      message: 'User created successfully'
    })
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'User could not be created.' })
  }
})

router.get('/', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  try {
    const result = await userOperations.list(req.query)
    return res.json({
      total: result.total,
      users: result.users.map(pickListUser)
    })
  } catch (err) {
    return next(err)
  }
})

router.get('/search', async (req, res, next) => {
  if (!requireUserSearchAccess(req, res)) {
    return
  }

  const query = _.trim(_.get(req, 'query.query', ''))
  if (query.length < 2) {
    return res.json([])
  }

  try {
    const users = await userOperations.search(query)
    return res.json(users.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      providerKey: user.providerKey
    })))
  } catch (err) {
    return next(err)
  }
})

router.get('/last-logins', async (req, res, next) => {
  if (!requireUserLastLoginsAccess(req, res)) {
    return
  }

  try {
    const users = await userOperations.lastLogins()
    return res.json(users.map(user => ({
      id: user.id,
      name: user.name,
      lastLoginAt: user.lastLoginAt
    })))
  } catch (err) {
    return next(err)
  }
})

router.get('/whoami', async (req, res) => {
  if (!req.user || req.user.id < 1 || req.user.id === 2) {
    return res.json({ authenticated: false, user: null })
  }

  return res.json({
    authenticated: true,
    user: _.pick(req.user, ['id', 'name', 'email', 'providerKey', 'permissions'])
  })
})

router.get('/profile', async (req, res, next) => {
  try {
    const user = await userOperations.getProfile(req.user)
    const [groups, pagesTotal] = await Promise.all([
      userOperations.listProfileGroups(user),
      userOperations.countPages(user)
    ])
    res.json({
      ..._.pick(user, ['id', 'name', 'email', 'providerKey', 'providerName', 'isSystem', 'isVerified', 'location', 'jobTitle', 'timezone', 'dateFormat', 'appearance', 'createdAt', 'updatedAt', 'lastLoginAt']),
      groups,
      pagesTotal
    })
  } catch (err) {
    next(err)
  }
})

router.patch('/profile', async (req, res, next) => {
  const input = _.pick(req.body, ['name', 'location', 'jobTitle', 'timezone', 'dateFormat', 'appearance'])
  if (['name', 'location', 'jobTitle', 'timezone', 'dateFormat', 'appearance'].some(field => typeof input[field] !== 'string')) {
    return res.status(400).json({ error: 'Profile fields must be strings' })
  }
  try {
    const token = await userOperations.updateProfile({ requester: req.user, input })
    res.json({ token })
  } catch (err) {
    next(err)
  }
})

router.post('/profile/password', async (req, res, next) => {
  const current = _.get(req, 'body.current')
  const newPassword = _.get(req, 'body.newPassword')
  if (typeof current !== 'string' || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'current and newPassword must be strings' })
  }
  try {
    const token = await userOperations.changePassword({ requester: req.user, current, newPassword })
    res.json({ token })
  } catch (err) {
    next(err)
  }
})

router.put('/:id', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  const payload = _.pick(req.body, ['email', 'name', 'newPassword', 'groups', 'location', 'jobTitle', 'timezone', 'dateFormat', 'appearance'])
  if (!_.isNil(payload.groups) && !Array.isArray(payload.groups)) {
    return res.status(400).json({ error: 'groups must be an array' })
  }

  try {
    await userOperations.update({
      requester: req.user,
      input: {
        id,
        ...payload
      }
    })
    return res.json({
      succeeded: true,
      message: 'User updated successfully'
    })
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'User could not be updated.' })
  }
})

router.delete('/:id', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  const replaceId = normalizeUserIdParam(_.toString(_.get(req, ['body', 'replaceId'], '')), res)
  if (replaceId === null) {
    return
  }

  try {
    await userOperations.remove({ id, replaceId })
    return res.json({
      succeeded: true,
      message: 'User deleted successfully'
    })
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'User could not be deleted.' })
  }
})

router.patch('/:id/status', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  const isActive = requireBooleanBodyValue(req, res, 'isActive')
  if (isActive === null) {
    return
  }

  try {
    await userOperations.setActive({ id, isActive })

    return res.json({
      succeeded: true,
      message: isActive ? 'User activated successfully' : 'User deactivated successfully'
    })
  } catch (err) {
    if (Number.isInteger(err.status)) return res.status(err.status).json({ error: err.message })
    return next(err)
  }
})

router.patch('/:id/verification', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  const isVerified = requireBooleanBodyValue(req, res, 'isVerified')
  if (isVerified === null) {
    return
  }
  if (!isVerified) {
    return res.status(400).json({ error: 'isVerified must be true' })
  }

  try {
    await userOperations.verify(id)
    return res.json({
      succeeded: true,
      message: 'User verified successfully'
    })
  } catch (err) {
    return next(err)
  }
})

router.patch('/:id/tfa', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  const enabled = requireBooleanBodyValue(req, res, 'enabled')
  if (enabled === null) {
    return
  }

  try {
    await userOperations.setTfa({ id, enabled })
    return res.json({
      succeeded: true,
      message: enabled ? 'User 2FA enabled successfully' : 'User 2FA disabled successfully'
    })
  } catch (err) {
    return next(err)
  }
})

router.get('/:id', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const id = normalizeUserIdParam(req.params.id, res)
  if (id === null) {
    return
  }

  try {
    return res.json(await userOperations.getAdminDetail(id))
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'user not found' })
    return next(err)
  }
})

module.exports = router
