const express = require('express')
const _ = require('lodash')
const getos = require('getos')
const os = require('os')
const filesize = require('filesize')
const path = require('path')
const fs = require('fs-extra')
const request = require('request-promise')

const getosAsync = require('util').promisify(getos)

const router = express.Router()

/* global WIKI */

const requireSystemAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system'])) {
    res.sendStatus(403)
    return false
  }

  return true
}

const requireSystemSummaryAccess = (req, res) => {
  if (!WIKI.auth.checkAccess(req.user, ['manage:system', 'manage:navigation', 'manage:groups', 'write:groups', 'manage:users', 'write:users', 'manage:theme', 'manage:api'])) {
    res.sendStatus(403)
    return false
  }

  return true
}

const buildSystemSummary = async () => {
  const groupsTotal = await WIKI.models.groups.query().count('* as total').first()
  const pagesTotal = await WIKI.models.pages.query().count('* as total').first()
  const usersTotal = await WIKI.models.users.query().count('* as total').first()
  const tagsTotal = await WIKI.models.tags.query().count('* as total').first()

  return {
    currentVersion: WIKI.version,
    latestVersion: _.get(WIKI.system, 'updates.version', WIKI.version),
    latestVersionReleaseDate: _.get(WIKI.system, 'updates.releaseDate', null),
    groupsTotal: _.toSafeInteger(groupsTotal.total),
    pagesTotal: _.toSafeInteger(pagesTotal.total),
    usersTotal: _.toSafeInteger(usersTotal.total),
    tagsTotal: _.toSafeInteger(tagsTotal.total)
  }
}

const buildSystemExtensions = async () => {
  const exts = Object.values(WIKI.extensions.ext).map(ext => _.pick(ext, ['key', 'title', 'description', 'isInstalled']))
  for (const ext of exts) {
    ext.isCompatible = await WIKI.extensions.ext[ext.key].isCompatible()
  }
  return exts
}

const buildSystemTelemetry = () => ({
  telemetry: _.get(WIKI.telemetry, 'enabled', false),
  telemetryClientId: _.get(WIKI.config, 'telemetry.clientId', null)
})

const buildSystemExportStatus = () => ({
  status: _.get(WIKI.system, 'exportStatus.status', 'notrunning'),
  progress: Math.ceil(_.get(WIKI.system, 'exportStatus.progress', 0)),
  message: _.get(WIKI.system, 'exportStatus.message', ''),
  startedAt: _.get(WIKI.system, 'exportStatus.startedAt', null)
})

const buildSystemHost = () => ({
  host: WIKI.config.host
})

const buildSystemSslInfo = () => ({
  httpPort: WIKI.servers.servers.http ? _.get(WIKI.servers.servers.http.address(), 'port', 0) : 0,
  httpRedirection: _.get(WIKI.config, 'server.sslRedir', false),
  httpsPort: WIKI.servers.servers.https ? _.get(WIKI.servers.servers.https.address(), 'port', 0) : 0,
  sslDomain: WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? WIKI.config.ssl.domain : null,
  sslExpirationDate: WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? _.get(WIKI.config.letsencrypt, 'payload.expires', null) : null,
  sslProvider: WIKI.config.ssl.enabled ? WIKI.config.ssl.provider : null,
  sslStatus: 'OK',
  sslSubscriberEmail: WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? WIKI.config.ssl.subscriberEmail : null
})

const getSystemDbVersion = async () => {
  switch (WIKI.config.db.type) {
    case 'mariadb':
    case 'mysql': {
      const result = await WIKI.models.knex.raw('SELECT VERSION() as version;')
      return _.get(result, '[0][0].version', 'Unknown Version')
    }
    case 'mssql': {
      const result = await WIKI.models.knex.raw('SELECT @@VERSION as version;')
      return _.get(result, '[0].version', 'Unknown Version')
    }
    case 'postgres':
      return _.get(WIKI.models, 'knex.client.version', 'Unknown Version')
    case 'sqlite':
      return _.get(WIKI.models, 'knex.client.driver.VERSION', 'Unknown Version')
    default:
      return 'Unknown Version'
  }
}

const buildSystemInfo = async () => {
  const summary = await buildSystemSummary()
  const platform = await (async () => {
    const isDockerized = await fs.pathExists('/.dockerenv')
    return isDockerized ? 'docker' : os.platform()
  })()
  const operatingSystem = await (async () => {
    if (os.platform() !== 'linux') {
      return `${os.type()} (${os.platform()}) ${os.release()} ${os.arch()}`
    }

    const osInfo = await getosAsync()
    return `${os.type()} - ${osInfo.dist} (${osInfo.codename || os.platform()}) ${osInfo.release || os.release()} ${os.arch()}`
  })()

  return {
    ...summary,
    configFile: path.join(process.cwd(), 'config.yml'),
    cpuCores: os.cpus().length,
    currentVersion: WIKI.version,
    dbHost: WIKI.config.db.type === 'sqlite' ? WIKI.config.db.storage : WIKI.config.db.host,
    dbType: _.get({
      mysql: 'MySQL',
      mariadb: 'MariaDB',
      postgres: 'PostgreSQL',
      sqlite: 'SQLite',
      mssql: 'MS SQL Server'
    }, WIKI.config.db.type, 'Unknown DB'),
    dbVersion: await getSystemDbVersion(),
    hostname: os.hostname(),
    latestVersion: _.get(WIKI.system, 'updates.version', WIKI.version),
    latestVersionReleaseDate: _.get(WIKI.system, 'updates.releaseDate', null),
    nodeVersion: process.version.substr(1),
    operatingSystem,
    platform,
    ramTotal: filesize(os.totalmem()),
    telemetry: _.get(WIKI.telemetry, 'enabled', false),
    telemetryClientId: _.get(WIKI.config, 'telemetry.clientId', null),
    httpPort: WIKI.servers.servers.http ? _.get(WIKI.servers.servers.http.address(), 'port', 0) : 0,
    httpsPort: WIKI.servers.servers.https ? _.get(WIKI.servers.servers.https.address(), 'port', 0) : 0,
    upgradeCapable: !_.isNil(process.env.UPGRADE_COMPANION),
    workingDirectory: process.cwd()
  }
}

router.get('/info', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    res.json(await buildSystemInfo())
  } catch (err) {
    next(err)
  }
})

router.get('/summary', async (req, res, next) => {
  if (!requireSystemSummaryAccess(req, res)) {
    return
  }

  try {
    res.json(await buildSystemSummary())
  } catch (err) {
    next(err)
  }
})

router.get('/flags', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  res.json(_.transform(WIKI.config.flags, (result, value, key) => {
    result.push({ key, value })
  }, []))
})

router.get('/host', (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  res.json(buildSystemHost())
})

router.get('/extensions', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    res.json(await buildSystemExtensions())
  } catch (err) {
    next(err)
  }
})

router.get('/telemetry', (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  res.json(buildSystemTelemetry())
})

router.patch('/telemetry', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  const enabled = _.get(req, 'body.enabled')
  if (!_.isBoolean(enabled)) {
    return res.status(400).json({ error: 'enabled must be a boolean' })
  }

  try {
    _.set(WIKI.config, 'telemetry.isEnabled', enabled)
    WIKI.telemetry.enabled = enabled
    await WIKI.configSvc.saveToDb(['telemetry'])
    res.json({ message: 'Telemetry updated successfully.' })
  } catch (err) {
    next(err)
  }
})

router.post('/telemetry/reset-client-id', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    WIKI.telemetry.generateClientId()
    await WIKI.configSvc.saveToDb(['telemetry'])
    res.json({ message: 'Telemetry Client ID reset successfully.' })
  } catch (err) {
    next(err)
  }
})

router.post('/upgrade', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    if (!process.env.UPGRADE_COMPANION) {
      throw new Error('You must run the wiki-update-companion container and pass the UPGRADE_COMPANION env var in order to use this feature.')
    }

    await request({
      method: 'POST',
      uri: 'http://wiki-update-companion/upgrade',
      qs: {
        ...process.env.UPGRADE_COMPANION_REF && { container: process.env.UPGRADE_COMPANION_REF }
      }
    })

    res.json({ message: 'Upgrade has started.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Upgrade failed' })
  }
})

router.post('/cache/flush', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    await WIKI.models.pages.flushCache()
    WIKI.events.outbound.emit('flushCache')
    res.json({ message: 'Cache flushed successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Cache flush failed' })
  }
})

router.post('/cache/temp-uploads/flush', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    await WIKI.models.assets.flushTempUploads()
    res.json({ message: 'Temporary Uploads flushed successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Temporary Uploads flush failed' })
  }
})

router.post('/content/rebuild-tree', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    await WIKI.models.pages.rebuildTree()
    res.json({ message: 'Page tree rebuilt successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Page tree rebuild failed' })
  }
})

router.post('/content/migrate-locale', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  const sourceLocale = _.get(req, 'body.sourceLocale')
  const targetLocale = _.get(req, 'body.targetLocale')

  if (!_.isString(sourceLocale) || sourceLocale.length < 1) {
    return res.status(400).json({ error: 'sourceLocale must be a non-empty string' })
  }
  if (!_.isString(targetLocale) || targetLocale.length < 1) {
    return res.status(400).json({ error: 'targetLocale must be a non-empty string' })
  }

  try {
    const count = await WIKI.models.pages.migrateToLocale({ sourceLocale, targetLocale })
    res.json({
      message: 'Migrated content to target locale successfully.',
      count
    })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Locale migration failed' })
  }
})

router.post('/content/render-page', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  const id = _.get(req, 'body.id')
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  try {
    const page = await WIKI.models.pages.query().findById(id)
    if (!page) {
      return res.status(404).json({ error: 'This page does not exist.' })
    }

    await WIKI.models.pages.renderPage(page)
    res.json({ message: 'Page rendered successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Page render failed' })
  }
})

router.post('/content/purge-history', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  const olderThan = _.get(req, 'body.olderThan')
  if (!_.isString(olderThan) || olderThan.length < 1) {
    return res.status(400).json({ error: 'olderThan must be a non-empty string' })
  }

  try {
    await WIKI.models.pageHistory.purge(olderThan)
    res.json({ message: 'Page history purged successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Page history purge failed' })
  }
})

router.post('/export', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  const entities = _.get(req, 'body.entities')
  const exportPath = _.get(req, 'body.path')

  if (!Array.isArray(entities) || entities.length < 1 || entities.some(entity => !_.isString(entity) || entity.length < 1)) {
    return res.status(400).json({ error: 'entities must be a non-empty string array' })
  }
  if (!_.isString(exportPath) || exportPath.length < 1) {
    return res.status(400).json({ error: 'path must be a non-empty string' })
  }

  try {
    const desiredPath = path.resolve(WIKI.ROOTPATH, exportPath)
    if (WIKI.system.exportStatus.status === 'running') {
      throw new Error('Another export is already running.')
    }

    await fs.ensureDir(desiredPath)
    const existingFiles = await fs.readdir(desiredPath)
    if (existingFiles.length) {
      throw new Error('Target directory must be empty!')
    }

    WIKI.system.export({
      entities,
      path: desiredPath
    })
    res.json({ message: 'Export started successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'Export failed' })
  }
})

router.get('/export-status', (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  if (typeof res.set === 'function') {
    res.set('Cache-Control', 'no-store')
  }
  res.json(buildSystemExportStatus())
})

router.get('/ssl', (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  res.json(buildSystemSslInfo())
})

router.patch('/ssl/redirection', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  const enabled = _.get(req, 'body.enabled')
  if (!_.isBoolean(enabled)) {
    return res.status(400).json({ error: 'enabled must be a boolean' })
  }

  try {
    _.set(WIKI.config, 'server.sslRedir', enabled)
    await WIKI.configSvc.saveToDb(['server'])
    res.json({ message: 'HTTP Redirection state set successfully.' })
  } catch (err) {
    res.status(500).json({ error: err.message || 'HTTP Redirection update failed' })
  }
})

router.post('/ssl/renew', async (req, res) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  try {
    if (!WIKI.config.ssl.enabled) {
      throw new WIKI.Error.SystemSSLDisabled()
    } else if (WIKI.config.ssl.provider !== 'letsencrypt') {
      throw new WIKI.Error.SystemSSLRenewInvalidProvider()
    } else if (!WIKI.servers.le) {
      throw new WIKI.Error.SystemSSLLEUnavailable()
    } else {
      await WIKI.servers.le.requestCertificate()
      await WIKI.servers.restartServer('https')
      res.json({ message: 'SSL Certificate renewed successfully.' })
    }
  } catch (err) {
    res.status(500).json({ error: err.message || 'SSL Certificate renewal failed' })
  }
})

router.post('/flags', async (req, res, next) => {
  if (!requireSystemAccess(req, res)) {
    return
  }

  const flags = _.get(req, 'body.flags')
  if (!Array.isArray(flags)) {
    return res.status(400).json({ error: 'flags must be an array' })
  }
  if (_.some(flags, row => !row || !_.isString(row.key) || !_.isBoolean(row.value))) {
    return res.status(400).json({ error: 'flags entries must contain string keys and boolean values' })
  }

  const allowedKeys = Object.keys(WIKI.config.flags)
  if (_.some(flags, row => !allowedKeys.includes(row.key))) {
    return res.status(400).json({ error: 'flags entries must use known flag keys' })
  }
  if (_.uniq(flags.map(row => row.key)).length !== flags.length) {
    return res.status(400).json({ error: 'flags entries must not contain duplicate keys' })
  }
  if (flags.length !== allowedKeys.length || _.some(allowedKeys, key => !flags.find(row => row.key === key))) {
    return res.status(400).json({ error: 'flags payload must include the full known flag set' })
  }

  const previousFlags = _.cloneDeep(WIKI.config.flags)

  try {
    WIKI.config.flags = _.transform(flags, (result, row) => {
      result[row.key] = row.value
    }, {})
    await WIKI.configSvc.applyFlags()
    const saved = await WIKI.configSvc.saveToDb(['flags'])
    if (saved === false) {
      throw new Error('System flags could not be persisted.')
    }
    res.json({ message: 'System flags applied successfully.' })
  } catch (err) {
    WIKI.config.flags = previousFlags
    await WIKI.configSvc.applyFlags()
    next(err)
  }
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
