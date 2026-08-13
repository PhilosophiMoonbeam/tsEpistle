const express = require('express')

const siteOperations = require('../../operations/site')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }
  return true
}

router.get('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(siteOperations.getConfig())
  } catch (err) {
    res.status(500).json({ error: err.message || 'Site configuration fetch failed' })
  }
})

router.put('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await siteOperations.updateConfig(req.body)
    res.json({ message: 'Site configuration updated successfully' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Site configuration update failed' })
  }
})

module.exports = router
