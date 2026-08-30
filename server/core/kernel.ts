import _ from 'lodash'
import EventEmitter2Module, { type EventEmitter2 as EventEmitter2Instance } from 'eventemitter2'
import asar from './asar.ts'
import cache from './cache.ts'
import database from './db.ts'
import collaboration, { type CollaborationService } from './collaboration.ts'
import type { InitializedDatabase } from './db.ts'
import type { ServerWiki } from './servers.ts'
import type { HttpTransportRuntime, MasterBackgroundWorkers } from '../master.ts'
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
  backgroundWorkers?: MasterBackgroundWorkers
  config: { setup?: boolean }
  configSvc: { applyFlags(): Promise<void>; loadFromDb(): Promise<void> }
  events?: { inbound: EventEmitter2Instance; outbound: EventEmitter2Instance }
  extensions: typeof extensions
  logger: Logger
  metrics?: unknown
  models?: InitializedModels
  scheduler?: { start(): void; stop(): Promise<unknown> }
  servers?: { stopServers(): Promise<void> }
  sideloader?: unknown
  telemetry: typeof telemetry
  product: ProductMetadata
  version: string
}
interface KernelService { init(): Promise<void>; preBootMaster(): Promise<void>; bootMaster(): Promise<void>; postBootMaster(): Promise<void>; shutdown(devMode?: boolean): Promise<void> }

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
let notificationsSubscribed = false
const kernel: KernelService = {
  async init(): Promise<void> {
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
      await initializedModels.onReady
      await wiki.configSvc.loadFromDb()
      await wiki.configSvc.applyFlags()
    } catch (error) {
      wiki.logger.error('Database Initialization Error: ' + (error instanceof Error ? error.message : String(error)))
      if (wiki.IS_DEBUG) wiki.logger.error(error)
      throw error
    }
    await this.bootMaster()
  },
  async preBootMaster(): Promise<void> {
    try {
      wiki.sideloader = await sideloader.init()
      wiki.cache = cache.init()
      wiki.metrics = await metrics.init()
      wiki.scheduler = scheduler.init()
      wiki.events = { inbound: new EventEmitter2(), outbound: new EventEmitter2() }
      wiki.collaboration = collaboration.init()
      wiki.extensions = extensions
      wiki.asar = asar
      // Server modules read initialized models and event services while registering GraphQL operations.
      wiki.servers = (await import('./servers.ts')).default(WIKI as unknown as ServerWiki)
    } catch (error) {
      wiki.logger.error(error)
      throw error
    }
  },
  async bootMaster(): Promise<void> {
    try {
      telemetry.init()
      if (wiki.config.setup) {
        wiki.logger.info('Starting setup wizard...')
        const { default: setup } = await import('../setup.ts')
        await setup()
      }
      await this.preBootMaster()
      const { default: master } = await import('../master.ts')
      await master(WIKI as unknown as HttpTransportRuntime)
      await this.postBootMaster()
    } catch (error) {
      wiki.logger.error(error)
      throw error
    }
  },
  async postBootMaster(): Promise<void> {
    const models = wiki.models
    if (!models) throw new Error('Database models must be initialized before booting the master process')
    await models.analytics.refreshProvidersFromDisk()
    await models.authentication.refreshStrategiesFromDisk()
    await models.commentProviders.refreshProvidersFromDisk()
    await models.editors.refreshEditorsFromDisk()
    await models.loggers.refreshLoggersFromDisk()
    await models.renderers.refreshRenderersFromDisk()
    await models.searchEngines.refreshSearchEnginesFromDisk()
    await models.storage.refreshTargetsFromDisk()
    await wiki.extensions.init()
    await wiki.auth.activateStrategies()
    await models.commentProviders.initProvider()
    await models.searchEngines.initEngine()
    await models.storage.initTargets()
    wiki.scheduler?.start()
    await models.subscribeToNotifications()
    notificationsSubscribed = true
    wiki.backgroundWorkers?.start()
  },
  async shutdown(_devMode = false): Promise<void> {
    const models = wiki.models
    const backgroundWorkers = wiki.backgroundWorkers
    const servers = wiki.servers
    const collaborationService = wiki.collaboration
    const activeScheduler = wiki.scheduler
    const knex = models?.knex ?? database.knex
    const archive = wiki.asar
    const teardowns: Array<() => Promise<unknown>> = []
    if (backgroundWorkers) teardowns.push(() => backgroundWorkers.shutdown())
    if (servers) {
      teardowns.push(() => servers.stopServers())
    } else if (collaborationService) {
      teardowns.push(() => collaborationService.dispose())
    }
    if (activeScheduler) teardowns.push(() => activeScheduler.stop())
    if (notificationsSubscribed && models) {
      teardowns.push(async () => {
        await models.unsubscribeToNotifications()
        notificationsSubscribed = false
      })
    }
    if (knex) teardowns.push(() => knex.destroy())
    if (archive) teardowns.push(() => archive.unload())

    let firstError: unknown
    for (const teardown of teardowns) {
      try {
        await teardown()
      } catch (error) {
        firstError ??= error
        wiki.logger.error(error)
      }
    }
    if (firstError) throw firstError
  }
}

export default kernel
