const express = require('express')

const searchOperations = require('../../operations/search')

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

router.get('/engines', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) return
  try {
    const engines = await searchOperations.listEngines('title')
    res.json(engines.map(engine => ({
      isEnabled: engine.isEnabled,
      key: engine.key,
      title: engine.title,
      description: engine.description,
      logo: engine.logo,
      website: engine.website,
      isAvailable: engine.isAvailable,
      config: engine.config
    })))
  } catch (err) {
    next(err)
  }
})

router.post('/engines', async (req, res) => {
  if (!requireSystemAccess(req, res, true)) return
  try {
    await searchOperations.updateEngines(req.body && req.body.engines)
    res.json({ message: 'Search Engines updated successfully' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Search Engines update failed' })
  }
})

router.post('/rebuild-index', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await searchOperations.rebuildIndex()
    res.json({ message: 'Index rebuilt successfully' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Index rebuild failed' })
  }
})

module.exports = router
