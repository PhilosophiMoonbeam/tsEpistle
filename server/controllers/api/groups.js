const express = require('express')
const safeRegex = require('safe-regex')

const router = express.Router()

/* global WIKI */

const requireGroupsPickerAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['write:groups', 'manage:groups', 'manage:system', 'write:users', 'manage:users', 'manage:navigation', 'manage:api'])) {
    res.status(403).json({ error: 'an admin groups picker permission is required' })
    return false
  }

  return true
}

const requireGroupsListAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['write:groups', 'manage:groups', 'manage:system'])) {
    res.status(403).json({ error: 'write:groups, manage:groups, or manage:system is required' })
    return false
  }

  return true
}

const requireGroupUserAssignmentAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:users', 'write:groups', 'manage:groups', 'manage:system'])) {
    res.status(403).json({ error: 'manage:users, write:groups, manage:groups, or manage:system is required' })
    return false
  }

  return true
}

const normalizePositiveIntegerParam = (value, label, res) => {
  if (!/^[1-9]\d*$/.test(value)) {
    res.status(400).json({ error: `${label} must be a positive integer` })
    return null
  }

  return Number.parseInt(value, 10)
}

router.post('/', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) {
    return
  }

  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : ''
  if (name.length < 1) {
    return res.status(400).json({ error: 'group name is required' })
  }

  try {
    const group = await WIKI.models.groups.query().insertAndFetch({
      name,
      permissions: JSON.stringify(WIKI.data.groups.defaultPermissions),
      pageRules: JSON.stringify(WIKI.data.groups.defaultPageRules),
      isSystem: false
    })
    await WIKI.auth.reloadGroups()
    WIKI.events.outbound.emit('reloadGroups')
    res.json({
      succeeded: true,
      message: 'Group created successfully.',
      group
    })
  } catch (err) {
    next(err)
  }
})

router.get('/', async (req, res, next) => {
  if (!requireGroupsPickerAccess(req, res)) {
    return
  }

  try {
    const groups = await WIKI.models.groups.query().select('id', 'name', 'isSystem')
    res.json(groups.map(group => ({
      id: group.id,
      name: group.name,
      isSystem: group.isSystem
    })))
  } catch (err) {
    next(err)
  }
})

router.get('/list', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) {
    return
  }

  try {
    const groups = await WIKI.models.groups.query().select(
      'groups.id',
      'groups.name',
      'groups.isSystem',
      'groups.createdAt',
      'groups.updatedAt',
      WIKI.models.groups.relatedQuery('users').count().as('userCount')
    )

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

const groupMutationElevatedResourceTypes = ['users', 'groups', 'navigation', 'theme', 'api', 'system']

const getPermissionResourceType = permission => String(permission).split(':').pop()

const groupHasElevatedPermissions = group => {
  const permissions = Array.isArray(group.permissions) ? group.permissions : []
  return permissions.some(permission => groupMutationElevatedResourceTypes.includes(getPermissionResourceType(permission)))
}

const groupHasSystemPermissions = group => {
  const permissions = Array.isArray(group.permissions) ? group.permissions : []
  return permissions.some(permission => getPermissionResourceType(permission) === 'system')
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

  if (payload.pageRules.some(rule => rule.match === 'REGEX' && !safeRegex(rule.path))) {
    res.status(400).json({ error: 'Some Page Rules contains unsafe or exponential time regex.' })
    return null
  }

  return {
    name: payload.name,
    redirectOnLogin: typeof payload.redirectOnLogin === 'string' && payload.redirectOnLogin.length > 0 ? payload.redirectOnLogin : '/',
    permissions: payload.permissions,
    pageRules: payload.pageRules
  }
}

router.post('/:groupId/users/:userId', async (req, res, next) => {
  if (!requireGroupUserAssignmentAccess(req, res)) {
    return
  }

  const groupId = normalizePositiveIntegerParam(req.params.groupId, 'group id', res)
  if (groupId === null) {
    return
  }

  const userId = normalizePositiveIntegerParam(req.params.userId, 'user id', res)
  if (userId === null) {
    return
  }

  if (userId === 2) {
    return res.status(400).json({ error: 'Cannot assign the Guest user to a group.' })
  }

  try {
    const group = await WIKI.models.groups.query().findById(groupId)
    if (!group) {
      return res.status(404).json({ error: 'Invalid Group ID' })
    }

    if (
      WIKI.auth.checkExclusiveAccess(req.user, ['manage:users', 'write:groups'], ['manage:groups', 'manage:system']) &&
      groupHasElevatedPermissions(group)
    ) {
      return res.status(403).json({ error: 'You are not authorized to assign a user to this administrative group.' })
    }

    if (
      WIKI.auth.checkExclusiveAccess(req.user, ['manage:groups'], ['manage:system']) &&
      groupHasSystemPermissions(group)
    ) {
      return res.status(403).json({ error: 'You are not authorized to assign a user to a group with the manage:system permission.' })
    }

    const user = await WIKI.models.users.query().findById(userId)
    if (!user) {
      return res.status(404).json({ error: 'Invalid User ID' })
    }

    const relation = await WIKI.models.knex('userGroups').where({
      userId,
      groupId
    }).first()
    if (relation) {
      return res.status(400).json({ error: 'User is already assigned to group.' })
    }

    await group.$relatedQuery('users').relate(user.id)
    WIKI.auth.revokeUserTokens({ id: user.id, kind: 'u' })
    WIKI.events.outbound.emit('addAuthRevoke', { id: user.id, kind: 'u' })

    res.json({
      succeeded: true,
      message: 'User has been assigned to group.'
    })
  } catch (err) {
    next(err)
  }
})

router.delete('/:groupId/users/:userId', async (req, res, next) => {
  if (!requireGroupUserAssignmentAccess(req, res)) {
    return
  }

  const groupId = normalizePositiveIntegerParam(req.params.groupId, 'group id', res)
  if (groupId === null) {
    return
  }

  const userId = normalizePositiveIntegerParam(req.params.userId, 'user id', res)
  if (userId === null) {
    return
  }

  if (userId === 2) {
    return res.status(400).json({ error: 'Cannot unassign Guest user' })
  }
  if (userId === 1 && groupId === 1) {
    return res.status(400).json({ error: 'Cannot unassign Administrator user from Administrators group.' })
  }

  try {
    const group = await WIKI.models.groups.query().findById(groupId)
    if (!group) {
      return res.status(404).json({ error: 'Invalid Group ID' })
    }

    const user = await WIKI.models.users.query().findById(userId)
    if (!user) {
      return res.status(404).json({ error: 'Invalid User ID' })
    }

    await group.$relatedQuery('users').unrelate().where('userId', user.id)
    WIKI.auth.revokeUserTokens({ id: user.id, kind: 'u' })
    WIKI.events.outbound.emit('addAuthRevoke', { id: user.id, kind: 'u' })

    res.json({
      succeeded: true,
      message: 'User has been unassigned from group.'
    })
  } catch (err) {
    next(err)
  }
})

router.delete('/:id', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) {
    return
  }

  const id = normalizePositiveIntegerParam(req.params.id, 'group id', res)
  if (id === null) {
    return
  }

  if (id === 1 || id === 2) {
    return res.status(400).json({ error: 'Cannot delete this group.' })
  }

  try {
    await WIKI.models.groups.query().deleteById(id)
    WIKI.auth.revokeUserTokens({ id, kind: 'g' })
    WIKI.events.outbound.emit('addAuthRevoke', { id, kind: 'g' })
    await WIKI.auth.reloadGroups()
    WIKI.events.outbound.emit('reloadGroups')

    res.json({
      succeeded: true,
      message: 'Group has been deleted.'
    })
  } catch (err) {
    next(err)
  }
})

router.patch('/:id', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) {
    return
  }

  const id = normalizePositiveIntegerParam(req.params.id, 'group id', res)
  if (id === null) {
    return
  }

  const payload = normalizeGroupUpdatePayload(req.body, res)
  if (payload === null) {
    return
  }

  if (
    WIKI.auth.checkExclusiveAccess(req.user, ['write:groups'], ['manage:groups', 'manage:system']) &&
    groupHasElevatedPermissions(payload)
  ) {
    return res.status(403).json({ error: 'You are not authorized to manage this group or assign these administrative permissions.' })
  }

  if (
    WIKI.auth.checkExclusiveAccess(req.user, ['manage:groups'], ['manage:system']) &&
    groupHasSystemPermissions(payload)
  ) {
    return res.status(403).json({ error: 'You are not authorized to manage this group or assign the manage:system permissions.' })
  }

  try {
    await WIKI.models.groups.query().patch({
      name: payload.name,
      redirectOnLogin: payload.redirectOnLogin,
      permissions: JSON.stringify(payload.permissions),
      pageRules: JSON.stringify(payload.pageRules)
    }).where('id', id)

    WIKI.auth.revokeUserTokens({ id, kind: 'g' })
    WIKI.events.outbound.emit('addAuthRevoke', { id, kind: 'g' })
    await WIKI.auth.reloadGroups()
    WIKI.events.outbound.emit('reloadGroups')

    res.json({
      succeeded: true,
      message: 'Group has been updated.'
    })
  } catch (err) {
    next(err)
  }
})

router.get('/:id', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) {
    return
  }

  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'group id must be a positive integer' })
  }

  const groupId = Number.parseInt(req.params.id, 10)

  try {
    const group = await WIKI.models.groups.query().findById(groupId)
    if (!group) {
      return res.status(404).json({ error: 'group not found' })
    }

    const users = await group.$relatedQuery('users').select('id', 'name', 'email')

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
      users: users.map(user => ({
        id: user.id,
        name: user.name,
        email: user.email
      })),
      createdAt: group.createdAt,
      updatedAt: group.updatedAt
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
