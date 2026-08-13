const _ = require('lodash')
const filesize = require('filesize')
const fs = require('fs-extra')
const getos = require('getos')
const os = require('os')
const path = require('path')
const request = require('request-promise')
const { promisify } = require('util')

const { ApplicationError } = require('./errors')

const getosAsync = promisify(getos)

/* global WIKI */

const getSummary = async () => {
  const [groups, pages, users, tags] = await Promise.all([
    WIKI.models.groups.query().count('* as total').first(),
    WIKI.models.pages.query().count('* as total').first(),
    WIKI.models.users.query().count('* as total').first(),
    WIKI.models.tags.query().count('* as total').first()
  ])
  return {
    currentVersion: WIKI.version,
    latestVersion: _.get(WIKI.system, 'updates.version', WIKI.version),
    latestVersionReleaseDate: _.get(WIKI.system, 'updates.releaseDate', null),
    groupsTotal: _.toSafeInteger(groups.total),
    pagesTotal: _.toSafeInteger(pages.total),
    usersTotal: _.toSafeInteger(users.total),
    tagsTotal: _.toSafeInteger(tags.total)
  }
}

const getDbVersion = async () => {
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

const getOperatingSystem = async () => {
  if (os.platform() !== 'linux') return `${os.type()} (${os.platform()}) ${os.release()} ${os.arch()}`
  const info = await getosAsync()
  return `${os.type()} - ${info.dist} (${info.codename || os.platform()}) ${info.release || os.release()} ${os.arch()}`
}

const getPlatform = async () => await fs.pathExists('/.dockerenv') ? 'docker' : os.platform()

const getInfo = async () => ({
  ...await getSummary(),
  configFile: path.join(process.cwd(), 'config.yml'),
  cpuCores: os.cpus().length,
  dbHost: WIKI.config.db.type === 'sqlite' ? WIKI.config.db.storage : WIKI.config.db.host,
  dbType: _.get({ mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', sqlite: 'SQLite', mssql: 'MS SQL Server' }, WIKI.config.db.type, 'Unknown DB'),
  dbVersion: await getDbVersion(),
  hostname: os.hostname(),
  nodeVersion: process.version.slice(1),
  operatingSystem: await getOperatingSystem(),
  platform: await getPlatform(),
  ramTotal: filesize(os.totalmem()),
  telemetry: _.get(WIKI.telemetry, 'enabled', false),
  telemetryClientId: _.get(WIKI.config, 'telemetry.clientId', null),
  httpPort: WIKI.servers.servers.http ? _.get(WIKI.servers.servers.http.address(), 'port', 0) : 0,
  httpsPort: WIKI.servers.servers.https ? _.get(WIKI.servers.servers.https.address(), 'port', 0) : 0,
  upgradeCapable: !_.isNil(process.env.UPGRADE_COMPANION),
  workingDirectory: process.cwd()
})

const listFlags = () => _.transform(WIKI.config.flags, (result, value, key) => result.push({ key, value }), [])

const updateFlags = async flags => {
  if (!Array.isArray(flags)) throw new ApplicationError('flags must be an array', { code: 'INVALID_SYSTEM_FLAGS' })
  if (_.some(flags, row => !row || !_.isString(row.key) || !_.isBoolean(row.value))) {
    throw new ApplicationError('flags entries must contain string keys and boolean values', { code: 'INVALID_SYSTEM_FLAGS' })
  }
  const allowedKeys = Object.keys(WIKI.config.flags)
  if (_.some(flags, row => !allowedKeys.includes(row.key))) throw new ApplicationError('flags entries must use known flag keys', { code: 'INVALID_SYSTEM_FLAGS' })
  if (_.uniq(flags.map(row => row.key)).length !== flags.length) throw new ApplicationError('flags entries must not contain duplicate keys', { code: 'INVALID_SYSTEM_FLAGS' })
  if (flags.length !== allowedKeys.length || _.some(allowedKeys, key => !flags.find(row => row.key === key))) {
    throw new ApplicationError('flags payload must include the full known flag set', { code: 'INVALID_SYSTEM_FLAGS' })
  }
  const previous = _.cloneDeep(WIKI.config.flags)
  try {
    WIKI.config.flags = _.fromPairs(flags.map(row => [row.key, row.value]))
    await WIKI.configSvc.applyFlags()
    const saved = await WIKI.configSvc.saveToDb(['flags'])
    if (saved === false) throw new Error('System flags could not be persisted.')
  } catch (err) {
    WIKI.config.flags = previous
    await WIKI.configSvc.applyFlags()
    throw err
  }
}

const listExtensions = async () => {
  const extensions = Object.values(WIKI.extensions.ext).map(extension => _.pick(extension, ['key', 'title', 'description', 'isInstalled']))
  for (const extension of extensions) extension.isCompatible = await WIKI.extensions.ext[extension.key].isCompatible()
  return extensions
}

const getHost = () => ({ host: WIKI.config.host })
const getTelemetry = () => ({ telemetry: _.get(WIKI.telemetry, 'enabled', false), telemetryClientId: _.get(WIKI.config, 'telemetry.clientId', null) })

const setTelemetry = async enabled => {
  if (!_.isBoolean(enabled)) throw new ApplicationError('enabled must be a boolean', { code: 'INVALID_TELEMETRY_STATE' })
  _.set(WIKI.config, 'telemetry.isEnabled', enabled)
  WIKI.telemetry.enabled = enabled
  await WIKI.configSvc.saveToDb(['telemetry'])
}

const resetTelemetryClientId = async () => {
  WIKI.telemetry.generateClientId()
  await WIKI.configSvc.saveToDb(['telemetry'])
}

const performUpgrade = async () => {
  if (!process.env.UPGRADE_COMPANION) throw new Error('You must run the wiki-update-companion container and pass the UPGRADE_COMPANION env var in order to use this feature.')
  await request({
    method: 'POST',
    uri: 'http://wiki-update-companion/upgrade',
    qs: { ...process.env.UPGRADE_COMPANION_REF && { container: process.env.UPGRADE_COMPANION_REF } }
  })
}

const flushPageCache = async () => {
  await WIKI.models.pages.flushCache()
  WIKI.events.outbound.emit('flushCache')
}
const flushTemporaryUploads = () => WIKI.models.assets.flushTempUploads()
const rebuildPageTree = () => WIKI.models.pages.rebuildTree()

const migratePagesToLocale = ({ sourceLocale, targetLocale }) => {
  if (!_.isString(sourceLocale) || sourceLocale.length < 1) throw new ApplicationError('sourceLocale must be a non-empty string', { code: 'INVALID_SOURCE_LOCALE' })
  if (!_.isString(targetLocale) || targetLocale.length < 1) throw new ApplicationError('targetLocale must be a non-empty string', { code: 'INVALID_TARGET_LOCALE' })
  return WIKI.models.pages.migrateToLocale({ sourceLocale, targetLocale })
}

const renderPage = async id => {
  if (!Number.isSafeInteger(id) || id < 1) throw new ApplicationError('id must be a positive integer', { code: 'INVALID_PAGE_ID' })
  const page = await WIKI.models.pages.query().findById(id)
  if (!page) throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
  await WIKI.models.pages.renderPage(page)
}

const purgePageHistory = olderThan => {
  if (!_.isString(olderThan) || olderThan.length < 1) throw new ApplicationError('olderThan must be a non-empty string', { code: 'INVALID_HISTORY_DATE' })
  return WIKI.models.pageHistory.purge(olderThan)
}

const getExportStatus = () => ({
  status: _.get(WIKI.system, 'exportStatus.status', 'notrunning'),
  progress: Math.ceil(_.get(WIKI.system, 'exportStatus.progress', 0)),
  message: _.get(WIKI.system, 'exportStatus.message', ''),
  startedAt: _.get(WIKI.system, 'exportStatus.startedAt', null)
})

const startExport = async ({ entities, exportPath }) => {
  if (!Array.isArray(entities) || entities.length < 1 || entities.some(entity => !_.isString(entity) || entity.length < 1)) {
    throw new ApplicationError('entities must be a non-empty string array', { code: 'INVALID_EXPORT_ENTITIES' })
  }
  if (!_.isString(exportPath) || exportPath.length < 1) throw new ApplicationError('path must be a non-empty string', { code: 'INVALID_EXPORT_PATH' })
  const desiredPath = path.resolve(WIKI.ROOTPATH, exportPath)
  if (WIKI.system.exportStatus.status === 'running') throw new Error('Another export is already running.')
  await fs.ensureDir(desiredPath)
  if ((await fs.readdir(desiredPath)).length) throw new Error('Target directory must be empty!')
  WIKI.system.export({ entities, path: desiredPath })
}

const getSsl = () => ({
  httpPort: WIKI.servers.servers.http ? _.get(WIKI.servers.servers.http.address(), 'port', 0) : 0,
  httpRedirection: _.get(WIKI.config, 'server.sslRedir', false),
  httpsPort: WIKI.servers.servers.https ? _.get(WIKI.servers.servers.https.address(), 'port', 0) : 0,
  sslDomain: WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? WIKI.config.ssl.domain : null,
  sslExpirationDate: WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? _.get(WIKI.config.letsencrypt, 'payload.expires', null) : null,
  sslProvider: WIKI.config.ssl.enabled ? WIKI.config.ssl.provider : null,
  sslStatus: 'OK',
  sslSubscriberEmail: WIKI.config.ssl.enabled && WIKI.config.ssl.provider === 'letsencrypt' ? WIKI.config.ssl.subscriberEmail : null
})

const setSslRedirection = async enabled => {
  if (!_.isBoolean(enabled)) throw new ApplicationError('enabled must be a boolean', { code: 'INVALID_SSL_REDIRECTION' })
  _.set(WIKI.config, 'server.sslRedir', enabled)
  await WIKI.configSvc.saveToDb(['server'])
}

const renewSslCertificate = async () => {
  if (!WIKI.config.ssl.enabled) throw new WIKI.Error.SystemSSLDisabled()
  if (WIKI.config.ssl.provider !== 'letsencrypt') throw new WIKI.Error.SystemSSLRenewInvalidProvider()
  if (!WIKI.servers.le) throw new WIKI.Error.SystemSSLLEUnavailable()
  await WIKI.servers.le.requestCertificate()
  await WIKI.servers.restartServer('https')
}

const checkForUpdate = async () => {
  await require('../jobs/sync-graph-updates')()
  return {
    currentVersion: WIKI.version,
    latestVersion: _.get(WIKI.system, 'updates.version', WIKI.version),
    latestVersionReleaseDate: _.get(WIKI.system, 'updates.releaseDate', null)
  }
}

module.exports = {
  checkForUpdate,
  flushPageCache,
  flushTemporaryUploads,
  getExportStatus,
  getHost,
  getInfo,
  getSsl,
  getSummary,
  getTelemetry,
  listExtensions,
  listFlags,
  migratePagesToLocale,
  performUpgrade,
  purgePageHistory,
  rebuildPageTree,
  renderPage,
  renewSslCertificate,
  resetTelemetryClientId,
  setSslRedirection,
  setTelemetry,
  startExport,
  updateFlags
}
