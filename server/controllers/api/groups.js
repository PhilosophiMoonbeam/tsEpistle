const express = require('express')

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

router.delete('/:groupId/users/:userId', async (req, res, next) => {
  if (!requireGroupsListAccess(req, res)) {
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
