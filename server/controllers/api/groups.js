const express = require('express')

const groupOperations = require('../../operations/groups')

const router = express.Router()

/* global WIKI */

const requireAccess = (req, res, permissions, message) => {
  if (!WIKI.auth.checkAccess(req.user, permissions)) {
    res.status(403).json({ error: message })
    return false
  }
  return true
}

const requireGroupsPickerAccess = (req, res) => requireAccess(
  req,
  res,
  ['write:groups', 'manage:groups', 'manage:system', 'write:users', 'manage:users', 'manage:navigation', 'manage:api'],
  'an admin groups picker permission is required'
)

const requireGroupsListAccess = (req, res) => requireAccess(
  req,
  res,
  ['write:groups', 'manage:groups', 'manage:system'],
  'write:groups, manage:groups, or manage:system is required'
)

const requireGroupUserAssignmentAccess = (req, res) => requireAccess(
  req,
  res,
  ['manage:users', 'write:groups', 'manage:groups', 'manage:system'],
  'manage:users, write:groups, manage:groups, or manage:system is required'
)

const normalizePositiveIntegerParam = (value, label, res) => {
  if (!/^[1-9]\d*$/.test(value)) {
    res.status(400).json({ error: `${label} must be a positive integer` })
    return null
  }
  return Number.parseInt(value, 10)
}

const handleOperationError = (err, res, next) => {
  if (Number.isInteger(err.status)) {
    return res.status(err.status).json({ error: err.message })
  }
  return next(err)
}

const normalizeGroupUpdatePayload = (body, res) => {
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const validPageRuleMatches = ['START', 'EXACT', 'END', 'REGEX', 'TAG']

  if (typeof payload.name !== 'string' || payload.name.length < 1) {
    res.status(400).json({ error: 'group name is required' })
    return null
  }
  if (!Array.isArray(payload.permissions) || payload.permissions.some(permission => typeof permission !== 'string')) {
    res.status(400).json({ error: 'group permissions must be an array of strings' })
    return null
  }
  if (!Array.isArray(payload.pageRules)) {
    res.status(400).json({ error: 'group page rules must be an array' })
    return null
  }
  for (const rule of payload.pageRules) {
    if (
      !rule ||
      typeof rule !== 'object' ||
      Array.isArray(rule) ||
      typeof rule.id !== 'string' ||
      rule.id.length < 1 ||
      typeof rule.path !== 'string' ||
      typeof rule.match !== 'string' ||
      !validPageRuleMatches.includes(rule.match) ||
      typeof rule.deny !== 'boolean' ||
      !Array.isArray(rule.roles) ||
      rule.roles.some(role => typeof role !== 'string') ||
      !Array.isArray(rule.locales) ||
      rule.locales.some(locale => typeof locale !== 'string')
    ) {
      res.status(400).json({ error: 'group page rules are invalid' })
      return null
    }
  }
  return {
    name: payload.name,
    redirectOnLogin: typeof payload.redirectOnLogin === 'string' && payload.redirectOnLogin.length > 0 ? payload.redirectOnLogin : '/',
    permissions: payload.permissions,
    pageRules: payload.pageRules
  }
}

router.post('/', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) return
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : ''
  if (!name) return res.status(400).json({ error: 'group name is required' })

  try {
    const group = await groupOperations.create(name)
    res.json({ succeeded: true, message: 'Group created successfully.', group })
  } catch (err) {
    handleOperationError(err, res, next)
  }
})

router.get('/', async (req, res, next) => {
  if (!requireGroupsPickerAccess(req, res)) return
  try {
    const groups = await groupOperations.listPickerOptions()
    res.json(groups.map(group => ({ id: group.id, name: group.name, isSystem: group.isSystem })))
  } catch (err) {
    next(err)
  }
})

router.get('/list', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) return
  try {
    const groups = await groupOperations.list()
    res.json(groups.map(group => ({
      id: group.id,
      name: group.name,
      isSystem: group.isSystem,
      userCount: Number.parseInt(group.userCount, 10) || 0,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt
    })))
  } catch (err) {
    next(err)
  }
})

router.post('/:groupId/users/:userId', async (req, res, next) => {
  if (!requireGroupUserAssignmentAccess(req, res)) return
  const groupId = normalizePositiveIntegerParam(req.params.groupId, 'group id', res)
  if (groupId === null) return
  const userId = normalizePositiveIntegerParam(req.params.userId, 'user id', res)
  if (userId === null) return

  try {
    await groupOperations.assignUser({ requester: req.user, groupId, userId })
    res.json({ succeeded: true, message: 'User has been assigned to group.' })
  } catch (err) {
    handleOperationError(err, res, next)
  }
})

router.delete('/:groupId/users/:userId', async (req, res, next) => {
  if (!requireGroupUserAssignmentAccess(req, res)) return
  const groupId = normalizePositiveIntegerParam(req.params.groupId, 'group id', res)
  if (groupId === null) return
  const userId = normalizePositiveIntegerParam(req.params.userId, 'user id', res)
  if (userId === null) return

  try {
    await groupOperations.unassignUser({ groupId, userId })
    res.json({ succeeded: true, message: 'User has been unassigned from group.' })
  } catch (err) {
    handleOperationError(err, res, next)
  }
})

router.delete('/:id', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) return
  const id = normalizePositiveIntegerParam(req.params.id, 'group id', res)
  if (id === null) return

  try {
    await groupOperations.remove(id)
    res.json({ succeeded: true, message: 'Group has been deleted.' })
  } catch (err) {
    handleOperationError(err, res, next)
  }
})

router.patch('/:id', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) return
  const id = normalizePositiveIntegerParam(req.params.id, 'group id', res)
  if (id === null) return
  const payload = normalizeGroupUpdatePayload(req.body, res)
  if (payload === null) return

  try {
    await groupOperations.update({ requester: req.user, id, ...payload })
    res.json({ succeeded: true, message: 'Group has been updated.' })
  } catch (err) {
    handleOperationError(err, res, next)
  }
})

router.get('/:id', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) return
  const groupId = normalizePositiveIntegerParam(req.params.id, 'group id', res)
  if (groupId === null) return

  try {
    const group = await groupOperations.get(groupId)
    if (!group) return res.status(404).json({ error: 'group not found' })
    const users = await groupOperations.listUsers(group)
    res.json({
      id: group.id,
      name: group.name,
      redirectOnLogin: group.redirectOnLogin,
      isSystem: group.isSystem,
      permissions: Array.isArray(group.permissions) ? group.permissions.filter(permission => typeof permission === 'string') : [],
      pageRules: (Array.isArray(group.pageRules) ? group.pageRules : []).map(rule => ({
        id: rule.id,
        path: rule.path,
        roles: Array.isArray(rule.roles) ? rule.roles.filter(role => typeof role === 'string') : [],
        match: rule.match,
        deny: rule.deny,
        locales: Array.isArray(rule.locales) ? rule.locales.filter(locale => typeof locale === 'string') : []
      })),
      users: users.map(user => ({ id: user.id, name: user.name, email: user.email })),
      createdAt: group.createdAt,
      updatedAt: group.updatedAt
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
