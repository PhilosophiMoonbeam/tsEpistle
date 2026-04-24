const express = require('express')
const _ = require('lodash')
const getos = require('getos')
const os = require('os')
const filesize = require('filesize')
const path = require('path')
const fs = require('fs-extra')

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
