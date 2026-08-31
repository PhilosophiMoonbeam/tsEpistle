import _ from 'lodash'
import { Duration } from 'luxon'

import type {
  StorageActionFormat,
  StorageActionItem,
  StorageActionItemOutcome,
  StorageActionSummary
} from '../modules/types.ts'
import configuration from './configuration.ts'
import errors from './errors.ts'
const { parseConfig, preserveSensitiveConfig, serializeConfig } = configuration
const { ApplicationError } = errors

interface StorageTarget extends Record<string, unknown> {
  key: string
  isEnabled: boolean
  mode: string
  syncInterval?: string
  config: Record<string, unknown>
  state?: Record<string, unknown>
}

interface StorageTargetUpdate {
  key: string
  isEnabled: boolean
  mode: string
  syncInterval?: unknown
  config: unknown[]
}

interface StorageDefinitionProperty extends Record<string, unknown> {
  type?: string
  sensitive?: boolean
  enum?: unknown
}

interface StorageDefinition extends Record<string, unknown> {
  key: string
  schedule?: string | false
  title?: string
  isAvailable?: boolean
  supportedModes?: string[]
  props?: Record<string, StorageDefinitionProperty>
  actions?: Array<{ handler?: string }>
}

interface StorageQuery {
  where(column: string, value: unknown): Promise<StorageTarget[]>
  patch(data: Record<string, unknown>): { where(column: string, value: unknown): Promise<unknown> }
}

interface StorageModel {
  getTargets(): Promise<StorageTarget[]>
  query(): StorageQuery
  initTargets(): Promise<unknown>
  executeAction(targetKey: string, handler: string): Promise<StorageActionSummary>
}

const storageModel = (WIKI.models as { storage: StorageModel }).storage

const getStorageDefinitions = (): StorageDefinition[] =>
  (WIKI.data as { storage: StorageDefinition[] }).storage
const actionFormats: StorageActionFormat[] = ['okf', 'legacyV1', 'legacyWiki', 'plain', 'invalid']
const actionItemOutcomes: StorageActionItemOutcome[] = ['succeeded', 'failed', 'conflict']
const ACTION_ITEM_LIMIT = 50
const ACTION_TEXT_LIMIT = 512
const ACTION_PATH_LIMIT = 512

const actionText = (value: unknown, fallback: string | null): string | null => {
  if (typeof value !== 'string') return fallback
  const text = value.replaceAll(/[\r\n\t]+/gu, ' ').trim()
  return text.length > 0 ? text.slice(0, ACTION_TEXT_LIMIT) : fallback
}

const redactActionSummary = (value: unknown): StorageActionSummary | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (
    typeof source.targetKey !== 'string' ||
    typeof source.handler !== 'string' ||
    !['succeeded', 'partial', 'failed'].includes(String(source.outcome)) ||
    !Number.isInteger(source.total) ||
    !Number.isInteger(source.succeeded) ||
    !Number.isInteger(source.failed) ||
    Number(source.total) < 0 ||
    Number(source.succeeded) < 0 ||
    Number(source.failed) < 0 ||
    Number(source.succeeded) + Number(source.failed) !== Number(source.total) ||
    !source.formats ||
    typeof source.formats !== 'object' ||
    !Array.isArray(source.items) ||
    typeof source.startedAt !== 'string' ||
    typeof source.completedAt !== 'string'
  ) return null
  const formats = source.formats as Record<string, unknown>
  if (!actionFormats.every(format => Number.isInteger(formats[format]) && Number(formats[format]) >= 0)) return null
  const items: StorageActionItem[] = []
  for (const value of source.items) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    const kind = row.kind === 'asset' ? 'asset' : row.kind === 'page' ? 'page' : null
    const outcome = actionItemOutcomes.includes(row.outcome as StorageActionItemOutcome) ? row.outcome as StorageActionItemOutcome : null
    if (kind === null || outcome === null) continue
    const format = actionFormats.includes(row.format as StorageActionFormat) ? row.format as StorageActionFormat : null
    const diagnostics = Array.isArray(row.diagnostics)
      ? row.diagnostics.filter((entry): entry is string => typeof entry === 'string').map(entry => actionText(entry, null)).filter((entry): entry is string => entry !== null).slice(0, 8)
      : []
    if (items.length < ACTION_ITEM_LIMIT) {
      items.push({
        kind,
        path: typeof row.path === 'string' ? row.path.replaceAll('\\', '/').slice(0, ACTION_PATH_LIMIT) : '',
        outcome,
        format,
        message: actionText(row.message, null),
        diagnostics
      })
    }
  }
  const outcome = source.outcome as StorageActionSummary['outcome']
  return {
    targetKey: source.targetKey,
    handler: source.handler,
    outcome,
    total: Number(source.total),
    succeeded: Number(source.succeeded),
    failed: Number(source.failed),
    formats: {
      okf: Number(formats.okf),
      legacyV1: Number(formats.legacyV1),
      legacyWiki: Number(formats.legacyWiki),
      plain: Number(formats.plain),
      invalid: Number(formats.invalid)
    },
    items,
    startedAt: source.startedAt,
    completedAt: source.completedAt,
    message: actionText(source.message, 'Action completed.') ?? 'Action completed.'
  }
}

function requireString(value: unknown, label: string): asserts value is string {
  if (!_.isString(value) || _.trim(value).length < 1) {
    throw new ApplicationError(`${label} is required.`, { code: 'INVALID_STORAGE_ARGUMENT' })
  }
}

function validateTargets(targets: unknown): asserts targets is StorageTargetUpdate[] {
  if (!Array.isArray(targets)) {
    throw new ApplicationError('targets must be an array.', { code: 'INVALID_STORAGE_TARGETS' })
  }
  const keys = new Set<string>()
  for (const target of targets as unknown[]) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new ApplicationError('target key is required.', { code: 'INVALID_STORAGE_ARGUMENT' })
    }
    const key = Reflect.get(target, 'key')
    requireString(key, 'target key')
    if (keys.has(key)) {
      throw new ApplicationError(`target ${key} must not be repeated.`, { code: 'INVALID_STORAGE_TARGETS' })
    }
    keys.add(key)
    if (!_.isBoolean(Reflect.get(target, 'isEnabled'))) {
      throw new ApplicationError('target isEnabled must be a boolean.', { code: 'INVALID_STORAGE_TARGETS' })
    }
    requireString(Reflect.get(target, 'mode'), 'target mode')
    if (!Array.isArray(Reflect.get(target, 'config'))) {
      throw new ApplicationError('target config must be an array.', { code: 'INVALID_STORAGE_TARGETS' })
    }
  }
}

const validateConfig = (
  target: StorageTargetUpdate,
  definition: StorageDefinition,
  current: StorageTarget
): Record<string, unknown> => {
  const properties = definition.props ?? {}
  const configKeys = new Set<string>()
  for (const entry of target.config) {
    const key = entry && typeof entry === 'object' && !Array.isArray(entry) ? Reflect.get(entry, 'key') : null
    if (typeof key !== 'string' || !Object.hasOwn(properties, key) || configKeys.has(key)) {
      throw new ApplicationError(`target ${target.key} config must contain unique, known entries.`, { code: 'INVALID_STORAGE_TARGETS' })
    }
    configKeys.add(key)
  }

  const config = parseConfig(target.config, { errorMessage: `target ${target.key} config must contain valid entries` })
  for (const [key, value] of Object.entries(config)) {
    const property = properties[key]
    const expectedType = property?.type?.toLowerCase()
    const isValid = (expectedType === 'string' && typeof value === 'string') ||
      (expectedType === 'boolean' && typeof value === 'boolean') ||
      (expectedType === 'number' && typeof value === 'number' && Number.isFinite(value))
    if (!isValid) {
      throw new ApplicationError(`target ${target.key} config value ${key} has an invalid type.`, { code: 'INVALID_STORAGE_TARGETS' })
    }
    if (
      Array.isArray(property?.enum) &&
      !property.enum.some(entry => String(entry).split('|')[0] === String(value))
    ) {
      throw new ApplicationError(`target ${target.key} config value ${key} is not allowed.`, { code: 'INVALID_STORAGE_TARGETS' })
    }
  }
  return preserveSensitiveConfig({ config, current: current.config, definition })

}

const listTargets = async () => {
  const targets = await storageModel.getTargets()
  const storageDefinitions = getStorageDefinitions()
  return _.sortBy(targets.map(target => {
    const definition: StorageDefinition = storageDefinitions.find(item => item.key === target.key) ?? { key: target.key }
    return {
      ...definition,
      ...target,
      isEnabled: Boolean(target.isEnabled),
      hasSchedule: definition.schedule !== false,
      syncInterval: target.syncInterval || definition.schedule || 'P0D',
      syncIntervalDefault: definition.schedule,
      config: serializeConfig({ config: target.config, definition, knownOnly: true, maskSensitive: true })
    }
  }), ['title', 'key'])
}

const listStatus = async () => {
  const activeTargets = await storageModel.query().where('isEnabled', true)
  const storageDefinitions = getStorageDefinitions()
  return activeTargets.map(target => {
    const definition: StorageDefinition = storageDefinitions.find(item => item.key === target.key) ?? { key: target.key }
    return {
      key: target.key,
      title: definition.title,
      status: _.get(target, 'state.status', 'pending'),
      message: _.get(target, 'state.message', 'Initializing...'),
      lastAttempt: _.get(target, 'state.lastAttempt', null),
      lastOperation: redactActionSummary(_.get(target, 'state.lastOperation', null))
    }
  })
}

const updateTargets = async (targets: unknown): Promise<void> => {
  validateTargets(targets)
  const currentTargets = await storageModel.getTargets()
  const storageDefinitions = getStorageDefinitions()
  const prepared = targets.map(target => {
    const current = currentTargets.find(candidate => candidate.key === target.key)
    const definition = storageDefinitions.find(candidate => candidate.key === target.key)
    if (!current || !definition) {
      throw new ApplicationError(`Storage target ${target.key} does not exist.`, { code: 'INVALID_STORAGE_TARGET' })
    }
    if (target.isEnabled && definition.isAvailable === false) {
      throw new ApplicationError(`Storage target ${target.key} is not available.`, { code: 'INVALID_STORAGE_TARGET' })
    }
    const syncInterval = target.syncInterval ?? definition.schedule ?? 'P0D'
    if (!_.isString(syncInterval) || syncInterval.length > 64) {
      throw new ApplicationError('target syncInterval must be a valid ISO 8601 duration.', { code: 'INVALID_STORAGE_TARGETS' })
    }
    const duration = Duration.fromISO(syncInterval)
    if (!duration.isValid || duration.toMillis() < 0) {
      throw new ApplicationError('target syncInterval must be a valid ISO 8601 duration.', { code: 'INVALID_STORAGE_TARGETS' })
    }
    if (!definition.supportedModes?.includes(target.mode)) {
      throw new ApplicationError(`Storage target ${target.key} does not support mode ${target.mode}.`, { code: 'INVALID_STORAGE_TARGET' })
    }
    return {
      target: { ...target, syncInterval },
      config: validateConfig(target, definition, current)
    }
  })

  for (const { target, config } of prepared) {
    await storageModel.query().patch({
      isEnabled: target.isEnabled,
      mode: target.mode,
      syncInterval: target.syncInterval,
      config,
      state: { status: 'pending', message: 'Initializing...', lastAttempt: null }
    }).where('key', target.key)
  }
  await storageModel.initTargets()
}
const executeAction = async ({ targetKey, handler }: { targetKey: unknown, handler: unknown }): Promise<StorageActionSummary> => {
  requireString(targetKey, 'targetKey')
  requireString(handler, 'handler')
  const definition = getStorageDefinitions().find(candidate => candidate.key === targetKey)
  if (!definition?.actions?.some(action => action.handler === handler)) {
    throw new ApplicationError(`Storage target ${targetKey} does not declare action ${handler}.`, { code: 'INVALID_STORAGE_ACTION' })
  }
  const summary = await storageModel.executeAction(targetKey, handler)
  const redacted = redactActionSummary(summary)
  if (redacted === null) {
    throw new ApplicationError('Storage action returned an invalid summary.', { code: 'INVALID_STORAGE_SUMMARY' })
  }
  return redacted
}

export default { executeAction, listStatus, listTargets, updateTargets }
