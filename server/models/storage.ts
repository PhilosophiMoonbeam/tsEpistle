import { Model } from 'objection'
import type { Knex } from 'knex'
import path from 'node:path'
import fs from 'fs-extra'
import _ from 'lodash'
import * as yaml from 'js-yaml'
import commonHelper from '../helpers/common.ts'
import {
  boundedStorageActionPath,
  boundedStorageActionText,
  emptyStorageActionFormats,
  storageActionFormat,
  STORAGE_ACTION_DIAGNOSTIC_LIMIT,
  STORAGE_ACTION_ITEM_LIMIT,
  type StorageActionItem,
  type StorageActionSummary,
  type StorageActionOutcome,
  type StorageActionItemOutcome,
  type StorageLastOperation
} from '../modules/types.ts'
import {
  errorMessage,
  hasMethod,
  isRecord,
  readModuleDefinition,
  readModuleDirectories,
  type LoadedModuleDefinition,
  type ModuleConfig
} from './moduleTypes.ts'
interface StorageDefinition extends LoadedModuleDefinition {
  isAvailable: boolean
  defaultMode?: string
  schedule?: string | false
  internalSchedule?: string | false
  actions?: Array<{ handler: string }>
}

interface StorageState {
  status: string
  message: string
  lastAttempt: string | null
  lastOperation?: StorageLastOperation | null
}
interface StatefulStorageTarget {
  state?: StorageState
  $query(): {
    patch(data: { state: StorageState }): PromiseLike<unknown>
  }
}

const STORAGE_STATE_REFRESH_INTERVAL_MS = 60_000

const isRecentStorageAttempt = (lastAttempt: string | null): boolean => {
  if (!lastAttempt) return false
  const recordedAt = Date.parse(lastAttempt)
  if (!Number.isFinite(recordedAt)) return false
  const age = Date.now() - recordedAt
  return age >= 0 && age < STORAGE_STATE_REFRESH_INTERVAL_MS
}

interface StoragePagePath {
  path: string
  localeCode: string
  contentType: string
}

interface WrittenStoragePage extends StoragePagePath {
  authorName: string
  authorEmail: string
  injectMetadata(): string
}

interface DeletedStoragePage extends StoragePagePath {
  authorName: string
  authorEmail: string
}

interface RenamedStoragePage extends StoragePagePath {
  destinationPath: string
  destinationLocaleCode: string
  moveAuthorName: string
  moveAuthorEmail: string
}

interface UploadedStorageAsset {
  path: string
  data: Buffer
  authorId: number
  authorName: string
  authorEmail: string
}

interface DeletedStorageAsset {
  path: string
  authorId: number
  authorName: string
  authorEmail: string
}

interface RenamedStorageAsset {
  path: string
  destinationPath: string
  moveAuthorId: number
  moveAuthorName: string
  moveAuthorEmail: string
}

type StoragePageEvent =
  | { event: 'created'; page: WrittenStoragePage }
  | { event: 'updated'; page: WrittenStoragePage }
  | { event: 'deleted'; page: DeletedStoragePage }
  | { event: 'renamed'; page: RenamedStoragePage }

type StorageAssetEvent =
  | { event: 'uploaded'; asset: UploadedStorageAsset }
  | { event: 'deleted'; asset: DeletedStorageAsset }
  | { event: 'renamed'; asset: RenamedStorageAsset }

interface StoragePlugin extends Record<string, unknown> {
  init(): Promise<unknown>
  created(page: WrittenStoragePage): Promise<unknown>
  updated(page: WrittenStoragePage): Promise<unknown>
  deleted(page: DeletedStoragePage): Promise<unknown>
  renamed(page: RenamedStoragePage): Promise<unknown>
  assetUploaded(asset: UploadedStorageAsset): Promise<unknown>
  assetDeleted(asset: DeletedStorageAsset): Promise<unknown>
  assetRenamed(asset: RenamedStorageAsset): Promise<unknown>
  getLocalLocation(asset: { path: string }): Promise<string | void>
}

interface RuntimeStoragePlugin extends StoragePlugin {
  config: ModuleConfig
  mode: string
}

interface StorageJob {
  name: string
  stop(): Promise<unknown>
}

interface StorageScheduler {
  jobs: StorageJob[]
  registerJob(
    options: {
      name: string
      immediate?: boolean
      schedule?: string
      repeat?: boolean
    },
    data?: unknown
  ): StorageJob
}

interface StorageLogger {
  error(value: unknown): void
  info(value: unknown): void
  warn(value: unknown): void
}

interface StorageWikiRuntime {
  SERVERPATH: string
  data: {
    storage?: StorageDefinition[]
  }
  logger: StorageLogger
  models: {
    storage: typeof Storage
    knex: Knex
    Objection: {
      transaction: {
        start(knex: Knex): Promise<Knex.Transaction>
      }
    }
  }
  scheduler?: StorageScheduler
}

const pluginMethods = ['init', 'created', 'updated', 'deleted', 'renamed', 'assetUploaded', 'assetDeleted', 'assetRenamed', 'getLocalLocation'] as const

function isStoragePlugin(value: unknown): value is StoragePlugin {
  return isRecord(value) && pluginMethods.every(method => typeof value[method] === 'function')
}

function readStoragePlugin(value: unknown, source: string): StoragePlugin {
  if (!isRecord(value) || !isStoragePlugin(value.default)) {
    throw new Error(`Invalid storage module: ${source}`)
  }
  return value.default
}

function isStorageWikiRuntime(value: unknown): value is StorageWikiRuntime {
  if (!isRecord(value) || typeof value.SERVERPATH !== 'string') return false
  if (!isRecord(value.data) || !isRecord(value.logger) || !isRecord(value.models)) return false
  if (typeof value.logger.error !== 'function' || typeof value.logger.info !== 'function' || typeof value.logger.warn !== 'function') return false
  if (
    typeof value.models.storage !== 'function' ||
    typeof value.models.knex !== 'function' ||
    !isRecord(value.models.Objection) ||
    !hasMethod(value.models.Objection.transaction, 'start')
  )
    return false
  return true
}

function getWiki(): StorageWikiRuntime {
  const value: unknown = WIKI
  if (!isStorageWikiRuntime(value)) {
    throw new Error('WIKI storage services are not initialized')
  }
  return value
}

function readStorageDefinition(value: unknown, source: string): StorageDefinition {
  const definition = readModuleDefinition(value, source)
  const result: StorageDefinition = {
    ...definition,
    isAvailable: typeof definition.isAvailable === 'boolean' ? definition.isAvailable : false,
    props: commonHelper.parseModuleProps(definition.props)
  }
  if (typeof definition.defaultMode === 'string') {
    result.defaultMode = definition.defaultMode
  }
  if (typeof definition.schedule === 'string' || definition.schedule === false) {
    result.schedule = definition.schedule
  }
  if (typeof definition.internalSchedule === 'string' || definition.internalSchedule === false) {
    result.internalSchedule = definition.internalSchedule
  }
  return result
}

function createDefaultConfig(props: StorageDefinition['props']): ModuleConfig {
  const config: ModuleConfig = {}
  for (const [key, value] of Object.entries(props)) {
    _.set(config, key, value.default)
  }
  return config
}

function addMissingConfigDefaults(config: ModuleConfig, props: StorageDefinition['props']): ModuleConfig {
  for (const [key, value] of Object.entries(props)) {
    if (!_.has(config, key)) {
      _.set(config, key, value.default)
    }
  }
  return config
}

function isStorageAction(value: unknown): value is () => unknown {
  return typeof value === 'function'
}

const sanitizeDiagnostics = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => boundedStorageActionText(entry, null))
    .filter((entry): entry is string => entry !== null)
    .slice(0, STORAGE_ACTION_DIAGNOSTIC_LIMIT)
}

const storageActionItem = (value: unknown): StorageActionItem => {
  const row = isRecord(value) ? value : {}
  const kind = row.kind === 'asset' ? 'asset' : 'page'
  const format = storageActionFormat(row.format)
  const rawOutcome = row.outcome
  const outcome: StorageActionItemOutcome =
    rawOutcome === 'conflict' ? 'conflict' : row.ok === true || rawOutcome === 'succeeded' ? 'succeeded' : 'failed'
  const rawDocument = isRecord(row.document) ? row.document : {}
  const diagnostics = sanitizeDiagnostics(rawDocument.diagnostics ?? row.diagnostics)
  const message = outcome === 'succeeded'
    ? null
    : boundedStorageActionText(
      format === 'invalid' ? 'Page document was rejected' : row.error ?? row.message,
      'Storage item failed'
    )
  return {
    kind,
    path: boundedStorageActionPath(row.path ?? row.relPath),
    outcome,
    format,
    message,
    diagnostics
  }
}

const actionSummary = (
  targetKey: string,
  handler: string,
  startedAt: string,
  completedAt: string,
  result: unknown,
  failureMessage?: string
): StorageActionSummary => {
  const values = Array.isArray(result) ? result : []
  const formats = emptyStorageActionFormats()
  let succeeded = 0
  let failed = 0
  const items: StorageActionItem[] = []
  for (const value of values) {
    const item = storageActionItem(value)
    if (item.outcome === 'succeeded') succeeded += 1
    else failed += 1
    if (item.format !== null) formats[item.format] += 1
    if (items.length < STORAGE_ACTION_ITEM_LIMIT) items.push(item)
  }
  const outcome: StorageActionOutcome = failureMessage !== undefined
    ? 'failed'
    : failed === 0 ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial'
  const message = boundedStorageActionText(
    failureMessage,
    outcome === 'succeeded' ? 'Action completed.' : outcome === 'partial' ? 'Action completed with failures.' : 'Action failed.'
  ) ?? 'Action failed.'
  return {
    targetKey,
    handler,
    outcome,
    total: values.length,
    succeeded,
    failed,
    formats,
    items,
    startedAt,
    completedAt,
    message
  }
}

async function recordTargetState(
  target: StatefulStorageTarget,
  status: string,
  message = '',
  lastOperation?: StorageLastOperation | null
): Promise<void> {
  if (lastOperation === undefined && target.state?.status === status && target.state.message === message && isRecentStorageAttempt(target.state.lastAttempt)) return
  const state: StorageState = {
    status,
    message,
    lastAttempt: new Date().toISOString(),
    ...(lastOperation === undefined
      ? target.state?.lastOperation === undefined ? {} : { lastOperation: target.state.lastOperation }
      : { lastOperation })
  }
  target.state = state
  await target.$query().patch({ state })
}

/**
 * Storage model
 */
export default class Storage extends Model {
  declare key: string
  declare isEnabled: boolean
  declare mode: string
  declare syncInterval: string
  declare internalSchedule?: string
  declare config: ModuleConfig
  declare state: StorageState
  declare fn: RuntimeStoragePlugin

  declare static targets: Storage[]
  static activeTargets: Storage[] = []

  static override get tableName() {
    return 'storage'
  }

  static override get idColumn() {
    return 'key'
  }

  static override get jsonSchema() {
    return {
      type: 'object',
      required: ['key', 'isEnabled'],
      properties: {
        key: { type: 'string' },
        isEnabled: { type: 'boolean' },
        mode: { type: 'string' }
      }
    }
  }

  static override get jsonAttributes() {
    return ['config', 'state']
  }

  static async getTargets(): Promise<Storage[]> {
    return getWiki().models.storage.query()
  }

  static async refreshTargetsFromDisk(): Promise<void> {
    const wiki = getWiki()
    let trx: Knex.Transaction | undefined
    try {
      const dbTargets = await wiki.models.storage.query()

      // -> Fetch definitions from disk
      const storageDirs = await readModuleDirectories(path.join(wiki.SERVERPATH, 'modules/storage'))
      const diskTargets: StorageDefinition[] = []
      for (const dir of storageDirs) {
        const definitionPath = path.join(wiki.SERVERPATH, 'modules/storage', dir, 'definition.yml')
        const definition = yaml.load(await fs.readFile(definitionPath, 'utf8'))
        diskTargets.push(readStorageDefinition(definition, definitionPath))
      }
      wiki.data.storage = diskTargets

      // -> Insert new targets
      const newTargets: Array<Pick<Storage, 'key' | 'isEnabled' | 'mode' | 'syncInterval' | 'config' | 'state'>> = []
      for (const target of diskTargets) {
        const dbTarget = dbTargets.find(candidate => candidate.key === target.key)
        if (!dbTarget) {
          newTargets.push({
            key: target.key,
            isEnabled: false,
            mode: target.defaultMode || 'push',
            syncInterval: target.schedule || 'P0D',
            config: createDefaultConfig(target.props),
            state: {
              status: 'pending',
              message: '',
              lastAttempt: null
            }
          })
        } else {
          const targetConfig = isRecord(dbTarget.config) ? dbTarget.config : {}
          await wiki.models.storage
            .query()
            .patch({
              config: addMissingConfigDefaults(targetConfig, target.props)
            })
            .where('key', target.key)
        }
      }
      if (newTargets.length > 0) {
        trx = await wiki.models.Objection.transaction.start(wiki.models.knex)
        for (const target of newTargets) {
          await wiki.models.storage.query(trx).insert(target)
        }
        await trx.commit()
        wiki.logger.info(`Loaded ${newTargets.length} new storage targets: [ OK ]`)
      } else {
        wiki.logger.info('No new storage targets found: [ SKIPPED ]')
      }

      // -> Delete removed targets
      for (const target of dbTargets) {
        if (!diskTargets.some(candidate => candidate.key === target.key)) {
          await wiki.models.storage.query().where('key', target.key).del()
          wiki.logger.info(`Removed target ${target.key} because it is no longer present in the modules folder: [ OK ]`)
        }
      }
    } catch (err) {
      wiki.logger.error('Failed to scan or load new storage providers: [ FAILED ]')
      wiki.logger.error(err)
      if (trx) {
        void trx.rollback()
      }
    }
  }

  /**
   * Initialize active storage targets
   */
  static async initTargets(): Promise<void> {
    const wiki = getWiki()
    this.activeTargets = []
    this.targets = await wiki.models.storage.query().where('isEnabled', true).orderBy('key')
    try {
      const scheduler = wiki.scheduler
      if (scheduler === undefined) throw new Error('WIKI scheduler is not initialized')
      // -> Stop and delete existing jobs
      const previousJobs = _.remove(scheduler.jobs, job => job.name === 'sync-storage')
      if (previousJobs.length > 0) {
        previousJobs.forEach(job => {
          void job.stop()
        })
      }

      // -> Initialize targets
      for (const target of this.targets) {
        try {
          const targetDef = wiki.data.storage?.find(candidate => candidate.key === target.key)
          if (!targetDef) {
            throw new Error(`Missing storage definition: ${target.key}`)
          }
          // Target key is selected from the enabled runtime module registry.
          const source = `../modules/storage/${target.key}/storage.ts`
          target.fn = Object.assign(readStoragePlugin(await import(source), source), {
            config: target.config,
            mode: target.mode
          })
          await target.fn.init()
          this.activeTargets.push(target)

          // -> Save succeeded init state
          await recordTargetState(target, 'operational')

          // -> Set recurring sync job
          if (targetDef.schedule && target.syncInterval !== 'P0D') {
            scheduler.registerJob(
              {
                name: 'sync-storage',
                immediate: false,
                schedule: target.syncInterval,
                repeat: true
              },
              target.key
            )
          }

          // -> Set internal recurring sync job
          if (targetDef.internalSchedule && targetDef.internalSchedule !== 'P0D') {
            scheduler.registerJob(
              {
                name: 'sync-storage',
                immediate: false,
                ...(target.internalSchedule === undefined ? {} : { schedule: target.internalSchedule }),
                repeat: true
              },
              target.key
            )
          }
        } catch (err) {
          // -> Save initialization error
          try {
            await recordTargetState(target, 'error', errorMessage(err))
          } catch (statusError) {
            wiki.logger.warn(statusError)
          }
        }
      }
    } catch (err) {
      wiki.logger.warn(err)
      throw err
    }
  }

  static async pageEvent(payload: StoragePageEvent): Promise<void> {
    const wiki = getWiki()
    for (const target of this.activeTargets) {
      try {
        switch (payload.event) {
          case 'created':
            await target.fn.created(payload.page)
            break
          case 'updated':
            await target.fn.updated(payload.page)
            break
          case 'deleted':
            await target.fn.deleted(payload.page)
            break
          case 'renamed':
            await target.fn.renamed(payload.page)
            break
        }
        await recordTargetState(target, 'operational')
      } catch (err) {
        wiki.logger.warn(err)
        try {
          await recordTargetState(target, 'warning', errorMessage(err))
        } catch (statusError) {
          wiki.logger.warn(statusError)
        }
      }
    }
  }

  static async assetEvent(payload: StorageAssetEvent): Promise<void> {
    const wiki = getWiki()
    for (const target of this.activeTargets) {
      try {
        switch (payload.event) {
          case 'uploaded':
            await target.fn.assetUploaded(payload.asset)
            break
          case 'deleted':
            await target.fn.assetDeleted(payload.asset)
            break
          case 'renamed':
            await target.fn.assetRenamed(payload.asset)
            break
        }
        await recordTargetState(target, 'operational')
      } catch (err) {
        wiki.logger.warn(err)
        try {
          await recordTargetState(target, 'warning', errorMessage(err))
        } catch (statusError) {
          wiki.logger.warn(statusError)
        }
      }
    }
  }

  static async getLocalLocations({ asset }: { asset: { path: string } }): Promise<Array<{ path: string | void; key: string }>> {
    const wiki = getWiki()
    const locations: Array<{ path: string | void; key: string }> = []
    const promises = this.activeTargets.map(async target => {
      try {
        const localPath = await target.fn.getLocalLocation(asset)
        locations.push({
          path: localPath,
          key: target.key
        })
      } catch (err) {
        wiki.logger.warn(err)
      }
    })
    await Promise.all(promises)
    return locations
  }

  static async executeAction(targetKey: string, handler: string): Promise<StorageActionSummary> {
    const wiki = getWiki()
    const target = this.targets.find(candidate => candidate.key === targetKey)
    if (!target) {
      throw new Error('Invalid or Inactive Storage Target')
    }
    const definition = wiki.data.storage?.find(candidate => candidate.key === targetKey)
    if (!definition?.actions?.some(action => action.handler === handler)) {
      throw new Error('Invalid Handler for Storage Target')
    }
    const action = target.fn[handler]
    if (!isStorageAction(action)) {
      throw new Error('Invalid Handler for Storage Target')
    }

    const startedAt = new Date().toISOString()
    try {
      const result = await action.call(target.fn)
      const completedAt = new Date().toISOString()
      const summary = actionSummary(targetKey, handler, startedAt, completedAt, result)
      const stateStatus = summary.outcome === 'partial' ? 'warning' : summary.outcome === 'failed' ? 'error' : 'operational'
      await recordTargetState(target, stateStatus, stateStatus === 'operational' ? '' : summary.message, summary)
      return summary
    } catch (err) {
      wiki.logger.warn(err)
      const completedAt = new Date().toISOString()
      const summary = actionSummary(targetKey, handler, startedAt, completedAt, undefined, errorMessage(err))
      try {
        await recordTargetState(target, 'error', summary.message, summary)
      } catch (statusError) {
        wiki.logger.warn(statusError)
      }
      return summary
    }
  }
}
