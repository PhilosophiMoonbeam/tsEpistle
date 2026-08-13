const express = require('express')

const themingOperations = require('../../operations/theming')

const router = express.Router()

/* global WIKI */

const canManageTheme = req => WIKI.auth.checkAccess(req.user, ['manage:theme', 'manage:system'])

router.get('/config', (req, res) => {
  if (!canManageTheme(req)) return res.sendStatus(403)
  res.set('Cache-Control', 'no-store')
  res.json(themingOperations.getConfig())
})

router.post('/config', async (req, res) => {
  if (!canManageTheme(req)) return res.status(403).json({ error: 'Forbidden' })
  try {
    await themingOperations.updateConfig(req.body)
    res.json({ message: 'Theme config updated' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Theme config update failed' })
  }
})

module.exports = router
