const express = require('express')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const userActivityAccessPermissions = ['write:groups', 'manage:groups', 'write:users', 'manage:users', 'manage:system']
const userMutationAccessPermissions = ['write:users', 'manage:users', 'manage:system']
const userListOrderFields = ['id', 'name', 'email', 'providerKey', 'createdAt', 'lastLoginAt']

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

const normalizeUserListQuery = query => {
  const page = Math.max(_.toSafeInteger(_.get(query, 'page')) || 1, 1)
  const pageSize = Math.max(_.toSafeInteger(_.get(query, 'pageSize')) || 15, 1)
  const orderBy = _.includes(userListOrderFields, _.get(query, 'orderBy')) ? query.orderBy : 'name'
  const orderByDirection = _.toLower(_.get(query, 'orderByDirection')) === 'desc' ? 'desc' : 'asc'

  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    filter: _.trim(_.get(query, 'filter', '')),
    providerKey: _.get(query, 'providerKey', 'all'),
    orderBy,
    orderByDirection
  }
}

const applyUserListFilters = (queryBuilder, options) => {
  if (options.filter) {
    queryBuilder.where(builder => {
      builder.where('email', 'like', `%${options.filter}%`)
        .orWhere('name', 'like', `%${options.filter}%`)
    })
  }

  if (options.providerKey && options.providerKey !== 'all') {
    queryBuilder.andWhere('providerKey', options.providerKey)
  }

  return queryBuilder
}

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
    if (!(await WIKI.auth.checkAssignUserToGroupAccess(req.user, payload.groups))) {
      return res.status(403).json({ error: 'You are not authorized to assign a user to a group with elevated permissions.' })
    }

    await WIKI.models.users.createNewUser(payload)

    return res.json({
      succeeded: true,
      message: 'User created successfully'
    })
  } catch (err) {
    return res.status(400).json({ error: err.message || 'User could not be created.' })
  }
})

router.get('/', async (req, res, next) => {
  if (!requireUserDetailAccess(req, res)) {
    return
  }

  const options = normalizeUserListQuery(req.query)

  try {
    const totalResult = await applyUserListFilters(WIKI.models.users.query(), options)
      .count('* as total')
      .first()

    const users = await applyUserListFilters(WIKI.models.users.query(), options)
      .select('id', 'email', 'name', 'providerKey', 'isSystem', 'isActive', 'createdAt', 'lastLoginAt')
      .orderBy(options.orderBy, options.orderByDirection)
      .offset(options.offset)
      .limit(options.pageSize)

    return res.json({
      total: _.toSafeInteger(_.get(totalResult, 'total')),
      users: users.map(pickListUser)
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
    const users = await WIKI.models.users.query()
      .where('email', 'like', `%${query}%`)
      .orWhere('name', 'like', `%${query}%`)
      .limit(10)
      .select('id', 'name', 'email', 'providerKey')

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
    const users = await WIKI.models.users.query()
      .select('id', 'name', 'lastLoginAt')
      .whereNotNull('lastLoginAt')
      .orderBy('lastLoginAt', 'desc')
      .limit(10)

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
    if (!(await WIKI.auth.checkAssignUserToGroupAccess(req.user, payload.groups))) {
      return res.status(403).json({ error: 'You are not authorized to assign a user to a group with elevated permissions.' })
    }

    await WIKI.models.users.updateUser({
      id,
      ...payload
    })

    return res.json({
      succeeded: true,
      message: 'User created successfully'
    })
  } catch (err) {
    return res.status(400).json({ error: err.message || 'User could not be updated.' })
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

  if (!isActive && id <= 2) {
    return res.status(400).json({ error: 'Cannot deactivate system accounts.' })
  }

  try {
    await WIKI.models.users.query().patch({ isActive }).findById(id)

    if (!isActive) {
      WIKI.auth.revokeUserTokens({ id, kind: 'u' })
      WIKI.events.outbound.emit('addAuthRevoke', { id, kind: 'u' })
    }

    return res.json({
      succeeded: true,
      message: isActive ? 'User activated successfully' : 'User deactivated successfully'
    })
  } catch (err) {
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
    await WIKI.models.users.query().patch({ isVerified: true }).findById(id)

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
    await WIKI.models.users.query().patch({
      tfaIsActive: enabled,
      tfaSecret: null
    }).findById(id)

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
    const user = await WIKI.models.users.query().findById(id)
    if (!user) {
      return res.status(404).json({ error: 'user not found' })
    }

    const providerInfo = _.get(WIKI.auth, ['strategies', user.providerKey], null)
    const strategy = providerInfo ? _.find(WIKI.data.authentication, ['key', providerInfo.strategyKey]) : null
    const groups = await user.$relatedQuery('groups').select('id', 'name')

    return res.json({
      id: user.id,
      name: user.name,
      email: user.email,
      providerKey: user.providerKey,
      providerName: _.get(providerInfo, 'displayName', 'Unknown'),
      providerId: _.isNil(user.providerId) ? null : user.providerId,
      providerIs2FACapable: _.get(strategy, 'useForm', false),
      location: user.location || '',
      jobTitle: user.jobTitle || '',
      timezone: user.timezone || '',
      isSystem: Boolean(user.isSystem),
      isActive: Boolean(user.isActive),
      isVerified: Boolean(user.isVerified),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt || null,
      tfaIsActive: Boolean(user.tfaIsActive),
      groups: groups.map(group => ({
        id: group.id,
        name: group.name
      }))
    })
  } catch (err) {
    return next(err)
  }
})

module.exports = router
