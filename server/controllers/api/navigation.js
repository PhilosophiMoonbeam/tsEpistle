const express = require('express')

const navigationOperations = require('../../operations/navigation')

const router = express.Router()

/* global WIKI */

const requireNavigationAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:navigation', 'manage:system'])) {
    res.status(403).json({ error: 'manage:navigation or manage:system is required' })
    return false
  }
  return true
}

router.get('/', async (req, res, next) => {
  if (!requireNavigationAccess(req, res)) return
  try {
    res.json(await navigationOperations.get())
  } catch (err) {
    next(err)
  }
})

router.put('/', async (req, res) => {
  if (!requireNavigationAccess(req, res)) return
  try {
    await navigationOperations.update(req.body || {})
    res.json({ message: 'Navigation saved successfully.' })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Navigation save failed' })
  }
})

module.exports = router
