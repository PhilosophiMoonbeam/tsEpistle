const express = require('express')

const router = express.Router()

/* global WIKI */

const requireGroupsAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['write:groups', 'manage:groups', 'manage:system', 'write:users', 'manage:users', 'manage:navigation', 'manage:api'])) {
    res.status(403).json({ error: 'an admin groups picker permission is required' })
    return false
  }

  return true
}

router.get('/', async (req, res, next) => {
  if (!requireGroupsAccess(req, res)) {
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

module.exports = router
