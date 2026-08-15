import _ from 'lodash'
import EventEmitter2Module, { type EventEmitter2 as EventEmitter2Instance } from 'eventemitter2'
import asar from './asar.ts'
import cache from './cache.ts'
import database from './db.ts'
import collaboration, { type CollaborationService } from './collaboration.ts'
import type { InitializedDatabase } from './db.ts'
import extensions from './extensions.ts'
import metrics from './metrics.ts'
import scheduler from './scheduler.ts'
import sideloader from './sideloader.ts'
import telemetry from './telemetry.ts'
import type { ProductMetadata } from '../../shared/product.ts'
const EventEmitter2 = EventEmitter2Module.EventEmitter2

interface Logger { error(message: unknown): void; info(message: string): void; warn(message: unknown): void }
interface KernelModels {
  analytics: { refreshProvidersFromDisk(): Promise<void> }
  authentication: { refreshStrategiesFromDisk(): Promise<void> }
  commentProviders: { initProvider(): Promise<void>; refreshProvidersFromDisk(): Promise<void> }
  editors: { refreshEditorsFromDisk(): Promise<void> }
  loggers: { refreshLoggersFromDisk(): Promise<void> }
  renderers: { refreshRenderersFromDisk(): Promise<void> }
  searchEngines: { initEngine(): Promise<void>; refreshSearchEnginesFromDisk(): Promise<void> }
  storage: { initTargets(): Promise<void>; refreshTargetsFromDisk(): Promise<void> }
}
type InitializedModels = InitializedDatabase & KernelModels
interface WikiContext {
  IS_DEBUG: boolean
  asar?: { unload(): Promise<void> }
  auth: { activateStrategies(): Promise<void> }
  collaboration?: CollaborationService
  cache?: unknown
  config: { setup?: boolean }
  configSvc: { applyFlags(): Promise<void>; loadFromDb(): Promise<void> }
  events?: { inbound: EventEmitter2Instance; outbound: EventEmitter2Instance }
  extensions: typeof extensions
  logger: Logger
  metrics?: unknown
  models: InitializedModels
  scheduler?: { start(): void; stop(): Promise<unknown> }
  servers?: { stopServers(): Promise<void> }
  sideloader?: unknown
  telemetry: typeof telemetry
  product: ProductMetadata
  version: string
}
interface KernelService { init(): Promise<void>; preBootMaster(): Promise<void>; bootMaster(): Promise<void>; postBootMaster(): Promise<void>; initTelemetry(): Promise<void>; shutdown(devMode?: boolean): Promise<void> }

function hasMethod(value: unknown, method: string): boolean {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  return typeof (value as Record<string, unknown>)[method] === 'function'
}

function hasKernelModels(value: InitializedDatabase): value is InitializedModels {
  return hasMethod(value.analytics, 'refreshProvidersFromDisk') &&
    hasMethod(value.authentication, 'refreshStrategiesFromDisk') &&
    hasMethod(value.commentProviders, 'initProvider') &&
    hasMethod(value.commentProviders, 'refreshProvidersFromDisk') &&
    hasMethod(value.editors, 'refreshEditorsFromDisk') &&
    hasMethod(value.loggers, 'refreshLoggersFromDisk') &&
    hasMethod(value.renderers, 'refreshRenderersFromDisk') &&
    hasMethod(value.searchEngines, 'initEngine') &&
    hasMethod(value.searchEngines, 'refreshSearchEnginesFromDisk') &&
    hasMethod(value.storage, 'initTargets') &&
    hasMethod(value.storage, 'refreshTargetsFromDisk')
}

const wiki = WIKI as unknown as WikiContext
const kernel: KernelService = {
  async init() {
    wiki.logger.info('=======================================')
    wiki.logger.info(`= ${_.padEnd(`${wiki.product.name} ${wiki.product.version} `, 35, '=')}`)
    wiki.logger.info(`= Upstream: ${wiki.product.upstreamBase}`)
    wiki.logger.info(`= Revision: ${wiki.product.revision}`)
    wiki.logger.info(`= Source: ${wiki.product.sourceUrl}`)
    wiki.logger.info('=======================================')
    wiki.logger.info('Initializing...')
    const initializedModels = await database.init()
    if (!hasKernelModels(initializedModels)) throw new Error('Database model registry is incomplete')
    wiki.models = initializedModels
    try {
      await wiki.models.onReady
      await wiki.configSvc.loadFromDb()
      await wiki.configSvc.applyFlags()
    } catch (error) {
      wiki.logger.error('Database Initialization Error: ' + (error instanceof Error ? error.message : String(error)))
      if (wiki.IS_DEBUG) wiki.logger.error(error)
      process.exit(1)
    }
    void this.bootMaster()
  },
  async preBootMaster() {
    try {
      await this.initTelemetry()
      wiki.sideloader = await sideloader.init()
      wiki.cache = cache.init()
      wiki.metrics = await metrics.init()
      wiki.scheduler = scheduler.init()
      wiki.events = { inbound: new EventEmitter2(), outbound: new EventEmitter2() }
      wiki.collaboration = collaboration.init()
      wiki.extensions = extensions
      wiki.asar = asar
      // Server modules read initialized models and event services while registering GraphQL operations.
      wiki.servers = (await import('./servers.ts')).default
    } catch (error) {
      wiki.logger.error(error)
      process.exit(1)
    }
  },
  async bootMaster() {
    try {
      // Deferred until database initialization because controller modules read wiki.models during evaluation.
      if (wiki.config.setup) {
        wiki.logger.info('Starting setup wizard...')
        const { default: setup } = await import('../setup.ts')
        setup()
      } else {
        await this.preBootMaster()
        const { default: master } = await import('../master.ts')
        await master()
        await this.postBootMaster()
      }
    } catch (error) {
      wiki.logger.error(error)
      process.exit(1)
    }
  },
  async postBootMaster() {
    await wiki.models.analytics.refreshProvidersFromDisk()
    await wiki.models.authentication.refreshStrategiesFromDisk()
    await wiki.models.commentProviders.refreshProvidersFromDisk()
    await wiki.models.editors.refreshEditorsFromDisk()
    await wiki.models.loggers.refreshLoggersFromDisk()
    await wiki.models.renderers.refreshRenderersFromDisk()
    await wiki.models.searchEngines.refreshSearchEnginesFromDisk()
    await wiki.models.storage.refreshTargetsFromDisk()
    await wiki.extensions.init()
    await wiki.auth.activateStrategies()
    await wiki.models.commentProviders.initProvider()
    await wiki.models.searchEngines.initEngine()
    await wiki.models.storage.initTargets()
    wiki.scheduler?.start()
    await wiki.models.subscribeToNotifications()
  },
  async initTelemetry() {
    telemetry.init()
    process.on('unhandledRejection', (error: unknown) => { wiki.logger.warn(error); wiki.telemetry.sendError(error) })
    process.on('uncaughtException', (error: Error) => { wiki.logger.warn(error); wiki.telemetry.sendError(error) })
  },
  async shutdown(devMode = false) {
    if (wiki.servers) await wiki.servers.stopServers()
    if (wiki.scheduler) await wiki.scheduler.stop()
    await wiki.models.unsubscribeToNotifications()
    if (wiki.models.knex) await wiki.models.knex.destroy()
    if (wiki.asar) await wiki.asar.unload()
    if (!devMode) process.exit(0)
  }
}

export default kernel
