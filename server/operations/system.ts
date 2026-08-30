import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import _ from 'lodash'
import { filesize } from 'filesize'
import fs from 'fs-extra'
import getos from 'getos'

import errors from './errors.ts'
import { ProductMetadataSchema, type ProductMetadata } from '../../shared/product.ts'

const { ApplicationError } = errors

interface CountResult {
  total: unknown
}

interface CountQuery {
  count(expression: string): { first(): Promise<CountResult> }
}

interface PageQuery extends CountQuery {
  findById(id: number): Promise<unknown>
}

interface PageMigrationActor extends Express.User {
  id: number
  name: string
  email: string
}

interface PageModel {
  query(): PageQuery
  flushCache(): Promise<unknown>
  rebuildTree(): unknown
  migrateToLocale(locales: { sourceLocale: string; targetLocale: string; user: PageMigrationActor }): Promise<number>
  renderPage(page: unknown): Promise<unknown>
}

interface WikiModels {
  groups: { query(): CountQuery }
  pages: PageModel
  users: { query(): CountQuery }
  tags: { query(): CountQuery }
  assets: { flushTempUploads(): unknown }
  pageHistory: { purge(olderThan: string): unknown }
  knex: {
    raw(statement: string): Promise<unknown>
    client: unknown
  }
}

interface WikiConfig {
  db: {
    type: string
    storage?: unknown
    host?: unknown
  }
  flags: Record<string, boolean>
  host: unknown
  telemetry: {
    clientId?: unknown
    isEnabled?: boolean
  }
  server: {
    sslRedir?: boolean
  }
  ssl: {
    enabled: boolean
    provider: string
    domain?: unknown
    subscriberEmail?: unknown
  }
  letsencrypt: unknown
}

interface WikiSystemState {
  updates?: unknown
  exportStatus: {
    status?: string
    progress?: number
    message?: string
    startedAt?: unknown
  }
  export(options: { entities: string[]; path: string }): unknown
}

interface WikiExtension {
  key: string
  title: unknown
  description: unknown
  isInstalled: unknown
  isCompatible(): Promise<boolean>
}

interface WikiServices extends Record<string, unknown> {
  ROOTPATH: string
  version: string
  models: WikiModels
  system: WikiSystemState
  product: ProductMetadata
  config: WikiConfig
  configSvc: {
    applyFlags(): Promise<unknown>
    saveToDb(keys: string[]): Promise<unknown>
  }
  telemetry: {
    enabled: boolean
    generateClientId(): unknown
  }
  servers: {
    servers: {
      http?: { address(): unknown }
      https?: { address(): unknown }
    }
    le?: { requestCertificate(): Promise<unknown> }
    restartServer(protocol: string): Promise<unknown>
  }
  extensions: {
    ext: Record<string, WikiExtension>
  }
  events: {
    outbound: { emit(event: string): unknown }
  }
  Error: {
    SystemSSLDisabled: new () => Error
    SystemSSLRenewInvalidProvider: new () => Error
    SystemSSLLEUnavailable: new () => Error
  }
}

// WIKI is initialized before operation modules are loaded.
const wiki = WIKI as WikiServices

const getosAsync = promisify(getos)

const getSummary = async () => {
  const product = ProductMetadataSchema.parse(wiki.product)
  const [groups, pages, users, tags] = await Promise.all([
    wiki.models.groups.query().count('* as total').first(),
    wiki.models.pages.query().count('* as total').first(),
    wiki.models.users.query().count('* as total').first(),
    wiki.models.tags.query().count('* as total').first()
  ])
  return {
    product,
    currentVersion: product.version,
    latestVersion: null,
    latestVersionReleaseDate: null,
    updateStatus: 'unavailable',
    groupsTotal: _.toSafeInteger(groups.total),
    pagesTotal: _.toSafeInteger(pages.total),
    usersTotal: _.toSafeInteger(users.total),
    tagsTotal: _.toSafeInteger(tags.total)
  }
}

const getDbVersion = async () => _.get(wiki.models, 'knex.client.version', 'Unknown Version')

const getOperatingSystem = async () => {
  if (os.platform() !== 'linux') return `${os.type()} (${os.platform()}) ${os.release()} ${os.arch()}`
  const info = await getosAsync()
  return `${os.type()} - ${info.dist} (${info.codename || os.platform()}) ${info.release || os.release()} ${os.arch()}`
}

const getPlatform = async () => ((await fs.pathExists('/.dockerenv')) ? 'docker' : os.platform())

const getInfo = async () => ({
  ...(await getSummary()),
  configFile: path.join(process.cwd(), 'config.yml'),
  cpuCores: os.cpus().length,
  dbHost: wiki.config.db.host,
  dbType: 'PostgreSQL',
  dbVersion: await getDbVersion(),
  hostname: os.hostname(),
  bunVersion: process.versions.bun ?? 'unknown',
  operatingSystem: await getOperatingSystem(),
  platform: await getPlatform(),
  ramTotal: filesize(os.totalmem()),
  telemetry: _.get(wiki.telemetry, 'enabled', false),
  telemetryClientId: _.get(wiki.config, 'telemetry.clientId', null),
  httpPort: wiki.servers.servers.http ? _.get(wiki.servers.servers.http.address(), 'port', 0) : 0,
  httpsPort: wiki.servers.servers.https ? _.get(wiki.servers.servers.https.address(), 'port', 0) : 0,
  upgradeCapable: false,
  workingDirectory: process.cwd()
})

const listFlags = () => Object.entries(wiki.config.flags).map(([key, value]) => ({ key, value }))

interface SystemFlag {
  key: string
  value: boolean
}

const isSystemFlag = (row: unknown): row is SystemFlag =>
  Boolean(
    row && typeof row === 'object' && !Array.isArray(row) && typeof Reflect.get(row, 'key') === 'string' && typeof Reflect.get(row, 'value') === 'boolean'
  )

function validateFlags(flags: unknown): asserts flags is SystemFlag[] {
  if (!Array.isArray(flags)) {
    throw new ApplicationError('flags must be an array', { code: 'INVALID_SYSTEM_FLAGS' })
  }
  if (!flags.every(isSystemFlag)) {
    throw new ApplicationError('flags entries must contain string keys and boolean values', { code: 'INVALID_SYSTEM_FLAGS' })
  }
}

const updateFlags = async (flags: unknown): Promise<void> => {
  validateFlags(flags)
  const allowedKeys = Object.keys(wiki.config.flags)
  if (flags.some(row => !allowedKeys.includes(row.key))) throw new ApplicationError('flags entries must use known flag keys', { code: 'INVALID_SYSTEM_FLAGS' })
  if (_.uniq(flags.map(row => row.key)).length !== flags.length)
    throw new ApplicationError('flags entries must not contain duplicate keys', { code: 'INVALID_SYSTEM_FLAGS' })
  if (flags.length !== allowedKeys.length || allowedKeys.some(key => !flags.find(row => row.key === key))) {
    throw new ApplicationError('flags payload must include the full known flag set', { code: 'INVALID_SYSTEM_FLAGS' })
  }
  const previous = _.cloneDeep(wiki.config.flags)
  try {
    wiki.config.flags = Object.fromEntries(flags.map(row => [row.key, row.value]))
    await wiki.configSvc.applyFlags()
    const saved = await wiki.configSvc.saveToDb(['flags'])
    if (saved === false) throw new Error('System flags could not be persisted.')
  } catch (err) {
    wiki.config.flags = previous
    await wiki.configSvc.applyFlags()
    throw err
  }
}

const listExtensions = async () => {
  const extensions: Array<Record<string, unknown>> = []
  for (const extension of Object.values(wiki.extensions.ext)) {
    extensions.push({
      key: extension.key,
      title: extension.title,
      description: extension.description,
      isInstalled: extension.isInstalled,
      isCompatible: await extension.isCompatible()
    })
  }
  return extensions
}

const getHost = () => ({ host: wiki.config.host })
const getTelemetry = () => ({ telemetry: _.get(wiki.telemetry, 'enabled', false), telemetryClientId: _.get(wiki.config, 'telemetry.clientId', null) })

const setTelemetry = async (enabled: unknown): Promise<void> => {
  if (typeof enabled !== 'boolean') throw new ApplicationError('enabled must be a boolean', { code: 'INVALID_TELEMETRY_STATE' })
  wiki.config.telemetry.isEnabled = enabled
  wiki.telemetry.enabled = enabled
  await wiki.configSvc.saveToDb(['telemetry'])
}

const resetTelemetryClientId = async () => {
  wiki.telemetry.generateClientId()
  await wiki.configSvc.saveToDb(['telemetry'])
}

const performUpgrade = async (): Promise<void> => {
  throw new ApplicationError('Preview updates are unavailable because no fork-owned update provider is configured.', {
    code: 'UPDATE_PROVIDER_UNAVAILABLE',
    status: 409
  })
}

const flushPageCache = async () => {
  await wiki.models.pages.flushCache()
  wiki.events.outbound.emit('flushCache')
}
const flushTemporaryUploads = () => wiki.models.assets.flushTempUploads()
const rebuildPageTree = () => wiki.models.pages.rebuildTree()

const migratePagesToLocale = (input: unknown): Promise<number> => {
  const sourceLocale = input && typeof input === 'object' && !Array.isArray(input) ? Reflect.get(input, 'sourceLocale') : undefined
  const targetLocale = input && typeof input === 'object' && !Array.isArray(input) ? Reflect.get(input, 'targetLocale') : undefined
  const requester = input && typeof input === 'object' && !Array.isArray(input) ? Reflect.get(input, 'requester') : undefined
  if (typeof sourceLocale !== 'string' || sourceLocale.length < 1)
    throw new ApplicationError('sourceLocale must be a non-empty string', { code: 'INVALID_SOURCE_LOCALE' })
  if (typeof targetLocale !== 'string' || targetLocale.length < 1)
    throw new ApplicationError('targetLocale must be a non-empty string', { code: 'INVALID_TARGET_LOCALE' })
  if (
    !requester ||
    typeof requester !== 'object' ||
    typeof Reflect.get(requester, 'id') !== 'number' ||
    typeof Reflect.get(requester, 'name') !== 'string' ||
    typeof Reflect.get(requester, 'email') !== 'string'
  ) {
    throw new ApplicationError('Authentication is required', { code: 'AUTH_REQUIRED', status: 401 })
  }
  return wiki.models.pages.migrateToLocale({ sourceLocale, targetLocale, user: requester as PageMigrationActor })
}

const renderPage = async (id: unknown): Promise<void> => {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) throw new ApplicationError('id must be a positive integer', { code: 'INVALID_PAGE_ID' })
  const page = await wiki.models.pages.query().findById(id)
  if (!page) throw new ApplicationError('This page does not exist.', { code: 'PAGE_NOT_FOUND', status: 404 })
  await wiki.models.pages.renderPage(page)
}

const purgePageHistory = (olderThan: unknown): unknown => {
  if (typeof olderThan !== 'string' || olderThan.length < 1)
    throw new ApplicationError('olderThan must be a non-empty string', { code: 'INVALID_HISTORY_DATE' })
  return wiki.models.pageHistory.purge(olderThan)
}

const getExportStatus = () => ({
  status: _.get(wiki.system, 'exportStatus.status', 'notrunning'),
  progress: Math.ceil(_.get(wiki.system, 'exportStatus.progress', 0)),
  message: _.get(wiki.system, 'exportStatus.message', ''),
  startedAt: _.get(wiki.system, 'exportStatus.startedAt', null)
})

function validateExportEntities(entities: unknown): asserts entities is string[] {
  if (!Array.isArray(entities) || entities.length < 1) {
    throw new ApplicationError('entities must be a non-empty string array', { code: 'INVALID_EXPORT_ENTITIES' })
  }
  for (const entity of entities as unknown[]) {
    if (typeof entity !== 'string' || entity.length < 1) {
      throw new ApplicationError('entities must be a non-empty string array', { code: 'INVALID_EXPORT_ENTITIES' })
    }
  }
}

const startExport = async (input: unknown): Promise<void> => {
  const entities = input && typeof input === 'object' && !Array.isArray(input) ? Reflect.get(input, 'entities') : undefined
  const exportPath = input && typeof input === 'object' && !Array.isArray(input) ? Reflect.get(input, 'exportPath') : undefined
  validateExportEntities(entities)
  if (typeof exportPath !== 'string' || exportPath.length < 1) throw new ApplicationError('path must be a non-empty string', { code: 'INVALID_EXPORT_PATH' })
  const desiredPath = path.resolve(wiki.ROOTPATH, exportPath)
  if (wiki.system.exportStatus.status === 'running') throw new Error('Another export is already running.')
  await fs.ensureDir(desiredPath)
  if ((await fs.readdir(desiredPath)).length) throw new Error('Target directory must be empty!')
  wiki.system.export({ entities, path: desiredPath })
}

const getSsl = () => ({
  httpPort: wiki.servers.servers.http ? _.get(wiki.servers.servers.http.address(), 'port', 0) : 0,
  httpRedirection: _.get(wiki.config, 'server.sslRedir', false),
  httpsPort: wiki.servers.servers.https ? _.get(wiki.servers.servers.https.address(), 'port', 0) : 0,
  sslDomain: wiki.config.ssl.enabled && wiki.config.ssl.provider === 'letsencrypt' ? wiki.config.ssl.domain : null,
  sslExpirationDate: wiki.config.ssl.enabled && wiki.config.ssl.provider === 'letsencrypt' ? _.get(wiki.config.letsencrypt, 'payload.expires', null) : null,
  sslProvider: wiki.config.ssl.enabled ? wiki.config.ssl.provider : null,
  sslStatus: 'OK',
  sslSubscriberEmail: wiki.config.ssl.enabled && wiki.config.ssl.provider === 'letsencrypt' ? wiki.config.ssl.subscriberEmail : null
})

const setSslRedirection = async (enabled: unknown): Promise<void> => {
  if (typeof enabled !== 'boolean') throw new ApplicationError('enabled must be a boolean', { code: 'INVALID_SSL_REDIRECTION' })
  wiki.config.server.sslRedir = enabled
  await wiki.configSvc.saveToDb(['server'])
}

const renewSslCertificate = async () => {
  if (!wiki.config.ssl.enabled) throw new wiki.Error.SystemSSLDisabled()
  if (wiki.config.ssl.provider !== 'letsencrypt') throw new wiki.Error.SystemSSLRenewInvalidProvider()
  if (!wiki.servers.le) throw new wiki.Error.SystemSSLLEUnavailable()
  await wiki.servers.le.requestCertificate()
  await wiki.servers.restartServer('https')
}

const checkForUpdate = async () => ({
  product: wiki.product,
  currentVersion: wiki.product.version,
  latestVersion: null,
  latestVersionReleaseDate: null,
  updateStatus: 'unavailable'
})

export default {
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
