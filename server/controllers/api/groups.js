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

module.exports = router
