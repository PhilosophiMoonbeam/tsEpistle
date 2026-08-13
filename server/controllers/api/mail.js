const express = require('express')

const mailOperations = require('../../operations/mail')

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

router.get('/config', (req, res) => {
  if (!requireSystemAccess(req, res)) return
  res.json(mailOperations.getConfig())
})

router.post('/config', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await mailOperations.updateConfig(req.body)
    res.json({ message: 'Mail configuration updated successfully.' })
  } catch (err) {
    sendError(res, err, 'Mail configuration update failed')
  }
})

router.post('/test', async (req, res) => {
  if (!requireSystemAccess(req, res)) return
  try {
    await mailOperations.sendTest(req.body && req.body.recipientEmail)
    res.json({ message: 'Test email sent successfully.' })
  } catch (err) {
    sendError(res, err, 'Test email failed')
  }
})

module.exports = router
