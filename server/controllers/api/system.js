const express = require('express')
const _ = require('lodash')

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.sendStatus(403)
    return false
  }

  return true
}

const buildSystemInfo = () => ({
  currentVersion: WIKI.version,
  latestVersion: _.get(WIKI.system, 'updates.version', WIKI.version),
  latestVersionReleaseDate: _.get(WIKI.system, 'updates.releaseDate', null),
  telemetry: _.get(WIKI.telemetry, 'enabled', false),
  telemetryClientId: _.get(WIKI.config, 'telemetry.clientId', null),
  httpPort: WIKI.servers.servers.http ? _.get(WIKI.servers.servers.http.address(), 'port', 0) : 0,
  httpsPort: WIKI.servers.servers.https ? _.get(WIKI.servers.servers.https.address(), 'port', 0) : 0,
  upgradeCapable: !_.isNil(process.env.UPGRADE_COMPANION)
})

router.get('/info', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  res.json(buildSystemInfo())
})

router.get('/flags', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  res.json(_.transform(WIKI.config.flags, (result, value, key) => {
    result.push({ key, value })
  }, []))
})

router.post('/check-for-update', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  if (req.get('X-Requested-With') !== 'XMLHttpRequest') {
    return res.status(400).json({ error: 'X-Requested-With header is required' })
  }

  try {
    await require('../../jobs/sync-graph-updates')()
    res.json({
      currentVersion: WIKI.version,
      latestVersion: _.get(WIKI.system, 'updates.version', WIKI.version),
      latestVersionReleaseDate: _.get(WIKI.system, 'updates.releaseDate', null)
    })
  } catch (err) {
    next(err)
  }
})

module.exports = router
