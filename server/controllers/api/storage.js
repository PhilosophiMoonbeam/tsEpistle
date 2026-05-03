const express = require('express')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }

  return true
}

const requireNonEmptyString = (value, label) => {
  if (!_.isString(value) || _.trim(value).length < 1) {
    throw new Error(`${label} is required.`)
  }
}

router.post('/actions/execute', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    const targetKey = _.get(req, 'body.targetKey', '')
    const handler = _.get(req, 'body.handler', '')

    requireNonEmptyString(targetKey, 'targetKey')
    requireNonEmptyString(handler, 'handler')

    await WIKI.models.storage.executeAction(targetKey, handler)
    res.json({ message: 'Action completed.' })
  } catch (err) {
    const status = /is required\.$/.test(err.message) ? 400 : 500
    res.status(status).json({ error: err.message || 'Storage action failed' })
  }
})

module.exports = router
