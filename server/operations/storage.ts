import _ from 'lodash'
import { Duration } from 'luxon'

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
  executeAction(targetKey: string, handler: string): Promise<unknown>
}

const storageModel = (WIKI.models as { storage: StorageModel }).storage

const getStorageDefinitions = (): StorageDefinition[] =>
  (WIKI.data as { storage: StorageDefinition[] }).storage

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
    if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(properties, key) || configKeys.has(key)) {
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
      lastAttempt: _.get(target, 'state.lastAttempt', null)
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

const executeAction = async ({ targetKey, handler }: { targetKey: unknown, handler: unknown }): Promise<void> => {
  requireString(targetKey, 'targetKey')
  requireString(handler, 'handler')
  const definition = getStorageDefinitions().find(candidate => candidate.key === targetKey)
  if (!definition?.actions?.some(action => action.handler === handler)) {
    throw new ApplicationError(`Storage target ${targetKey} does not declare action ${handler}.`, { code: 'INVALID_STORAGE_ACTION' })
  }
  await storageModel.executeAction(targetKey, handler)
}

export default { executeAction, listStatus, listTargets, updateTargets }
