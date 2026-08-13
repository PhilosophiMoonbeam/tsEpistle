const express = require('express')
const _ = require('lodash')

const analyticsOperations = require('../../operations/analytics')

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

const parseIsEnabled = value => value === 'true' ? true : value === 'false' ? false : undefined

router.get('/providers', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const providers = await analyticsOperations.listProviders(parseIsEnabled(_.get(req, 'query.isEnabled')))
    res.json(providers.map(provider => ({
      isEnabled: provider.isEnabled,
      key: provider.key,
      title: provider.title,
      description: provider.description,
      isAvailable: provider.isAvailable,
      logo: provider.logo,
      website: provider.website,
      config: provider.config
    })))
  } catch (err) {
    next(err)
  }
})

router.post('/providers', async (req, res) => {
  if (!requireSystemAccess(req, res, true)) return
  try {
    await analyticsOperations.updateProviders(req.body && req.body.providers)
    res.json({ message: 'Providers updated successfully' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Providers update failed' })
  }
})

module.exports = router
