const express = require('express')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const requireUserSearchAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['write:groups', 'manage:groups', 'write:users', 'manage:users', 'manage:system'])) {
    res.status(403).json({ error: 'a user search admin permission is required' })
    return false
  }

  return true
}

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

router.get('/whoami', async (req, res) => {
  if (!req.user || req.user.id < 1 || req.user.id === 2) {
    return res.json({ authenticated: false, user: null })
  }

  return res.json({
    authenticated: true,
    user: _.pick(req.user, ['id', 'name', 'email', 'providerKey', 'permissions'])
  })
})

module.exports = router
