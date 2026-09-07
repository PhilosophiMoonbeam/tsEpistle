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

interface ScheduledWorker {
  finished: Promise<unknown>
  stop(): Promise<unknown>
}

interface Scheduler {
  registerJob(options: { name: string; immediate: true; worker: true }, data?: unknown): ScheduledWorker
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
  export(options: { entities: string[]; path: string }): Promise<void>
}

interface WikiServices extends Record<string, unknown> {
  ROOTPATH: string
  version: string
  models: WikiModels
  system: WikiSystemState
  scheduler: Scheduler
  product: ProductMetadata
  config: WikiConfig
  telemetry: {
    enabled: boolean
  }
  servers: {
    servers: {
      http?: { address(): unknown }
      https?: { address(): unknown }
    }
    le?: { requestCertificate(): Promise<unknown> }
    restartServer(protocol: string): Promise<unknown>
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

interface SystemRuntimeGlobal {
  WIKI: WikiServices
}
interface OperatingSystemInfo {
  dist?: string
  codename?: string
  release?: string
}
const systemRuntimeGlobal = globalThis as unknown as SystemRuntimeGlobal
const wiki = systemRuntimeGlobal.WIKI
const getosAsync = promisify(getos) as unknown as () => Promise<OperatingSystemInfo>

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

const getHost = () => ({ host: wiki.config.host })

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

const workerEffectTimeoutMs = 120_000

const runBoundedWorker = async (name: string, data?: unknown): Promise<void> => {
  const job = wiki.scheduler.registerJob({ name, immediate: true, worker: true }, data)
  let stopping: Promise<unknown> | undefined
  const timeout = setTimeout(() => {
    stopping = job.stop()
  }, workerEffectTimeoutMs)
  try {
    await job.finished
  } finally {
    clearTimeout(timeout)
  }
  if (stopping) {
    await stopping
    throw new Error(`The ${name} worker exceeded its ${workerEffectTimeoutMs / 1_000}-second execution limit and was stopped.`)
  }
}

const rebuildPageTree = async (): Promise<void> => {
  await runBoundedWorker('rebuild-tree')
}

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
  await runBoundedWorker('render-page', id)
}

const purgePageHistory = (olderThan: unknown): unknown => {
  if (typeof olderThan !== 'string' || olderThan.length < 1)
    throw new ApplicationError('olderThan must be a non-empty string', { code: 'INVALID_HISTORY_DATE' })
  return wiki.models.pageHistory.purge(olderThan)
}

const getExportStatus = () => ({
  status: _.get(wiki.system, 'exportStatus.status', 'notrunning'),
  progress: Math.ceil(_.get(wiki.system, 'exportStatus.progress', 0)),
  message: _.get(wiki.system, 'exportStatus.message', '')
})
const exportEntities: readonly string[] = ['assets', 'comments', 'navigation', 'pages', 'history', 'settings', 'groups', 'users']

function validateExportEntities(entities: unknown): asserts entities is string[] {
  if (!Array.isArray(entities) || entities.length < 1) {
    throw new ApplicationError('entities must be a non-empty supported section array', { code: 'INVALID_EXPORT_ENTITIES' })
  }
  for (const entity of entities as unknown[]) {
    if (typeof entity !== 'string' || !exportEntities.includes(entity)) {
      throw new ApplicationError('entities must be a non-empty supported section array', { code: 'INVALID_EXPORT_ENTITIES' })
    }
  }
}

const startExport = async (input: unknown, beforeStart?: () => Promise<void>): Promise<void> => {
  const entities = input && typeof input === 'object' && !Array.isArray(input) ? Reflect.get(input, 'entities') : undefined
  const exportPath = input && typeof input === 'object' && !Array.isArray(input) ? Reflect.get(input, 'exportPath') : undefined
  validateExportEntities(entities)
  if (typeof exportPath !== 'string' || exportPath.length < 1) throw new ApplicationError('path must be a non-empty string', { code: 'INVALID_EXPORT_PATH' })
  if (wiki.system.exportStatus.status === 'running') throw new Error('Another export is already running.')

  const rootPath = path.resolve(wiki.ROOTPATH)
  const desiredPath = path.resolve(rootPath, exportPath)
  const lexicalRelative = path.relative(rootPath, desiredPath)
  if (lexicalRelative === '' || lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative))
    throw new ApplicationError('Export path must be a folder beneath the application root.', { code: 'UNSAFE_EXPORT_PATH' })

  let existingParent = desiredPath
  while (!(await fs.pathExists(existingParent))) {
    const parent = path.dirname(existingParent)
    if (parent === existingParent) throw new ApplicationError('Export path has no accessible parent folder.', { code: 'UNSAFE_EXPORT_PATH' })
    existingParent = parent
  }
  const [realRoot, realParent] = await Promise.all([fs.realpath(rootPath), fs.realpath(existingParent)])
  const parentRelative = path.relative(realRoot, realParent)
  if (parentRelative === '..' || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative))
    throw new ApplicationError('Export path resolves outside the application root.', { code: 'UNSAFE_EXPORT_PATH' })

  await fs.mkdir(desiredPath, { recursive: true, mode: 0o700 })
  const realPath = await fs.realpath(desiredPath)
  const resolvedRelative = path.relative(realRoot, realPath)
  if (resolvedRelative === '' || resolvedRelative === '..' || resolvedRelative.startsWith(`..${path.sep}`) || path.isAbsolute(resolvedRelative))
    throw new ApplicationError('Export path resolves outside the application root.', { code: 'UNSAFE_EXPORT_PATH' })
  if ((await fs.readdir(realPath)).length) throw new Error('Target directory must be empty!')

  if (beforeStart) await beforeStart()
  if (wiki.system.exportStatus.status === 'running') throw new Error('Another export is already running.')
  await wiki.system.export({ entities, path: realPath })
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
  getHost,
  getInfo,
  getSummary,
  migratePagesToLocale,
  getExportStatus,
  performUpgrade,
  purgePageHistory,
  rebuildPageTree,
  renderPage,
  startExport
}
