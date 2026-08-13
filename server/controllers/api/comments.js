const express = require('express')

const commentOperations = require('../../operations/comments')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res, json = false) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    if (json) res.status(403).json({ error: 'Forbidden' })
    else res.sendStatus(403)
    return false
  }
  return true
}

router.get('/providers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const providers = await commentOperations.listProviders()
    res.json(providers.map(provider => ({
      isEnabled: provider.isEnabled,
      key: provider.key,
      title: provider.title,
      description: provider.description,
      logo: provider.logo,
      website: provider.website,
      isAvailable: provider.isAvailable,
      config: provider.config
    })))
  } catch (err) {
    next(err)
  }
})

router.post('/providers', async (req, res) => {
  if (!requireSystemAccess(req, res, true)) return
  try {
    await commentOperations.updateProviders(req.body && req.body.providers)
    res.json({ message: 'Comment Providers updated successfully' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Comment providers update failed' })
  }
})

module.exports = router
