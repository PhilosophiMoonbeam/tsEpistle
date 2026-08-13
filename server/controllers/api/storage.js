const express = require('express')

const storageOperations = require('../../operations/storage')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }
  return true
}

const sendError = (res, err, fallback) => res.status(err.status || 500).json({ error: err.message || fallback })

router.get('/targets', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(await storageOperations.listTargets())
  } catch (err) {
    sendError(res, err, 'Storage targets failed')
  }
})

router.get('/status', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    res.json(await storageOperations.listStatus())
  } catch (err) {
    sendError(res, err, 'Storage status failed')
  }
})

router.put('/targets', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await storageOperations.updateTargets(req.body && req.body.targets)
    res.json({ message: 'Storage targets updated successfully' })
  } catch (err) {
    sendError(res, err, 'Storage targets update failed')
  }
})

router.post('/actions/execute', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await storageOperations.executeAction(req.body || {})
    res.json({ message: 'Action completed.' })
  } catch (err) {
    sendError(res, err, 'Storage action failed')
  }
})

module.exports = router
