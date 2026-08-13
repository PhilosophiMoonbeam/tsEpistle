import _ from 'lodash'

import configuration from './configuration.ts'
import errors from './errors.ts'

const { parseConfig, serializeConfig } = configuration
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

interface StorageDefinition extends Record<string, unknown> {
  key: string
  schedule?: string | false
  title?: string
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

// WIKI model and data registries are initialized before operation modules are loaded.
const wikiModels = WIKI.models as { storage: StorageModel }
const wikiData = WIKI.data as { storage: StorageDefinition[] }
const storageModel = wikiModels.storage
const storageDefinitions = wikiData.storage

function requireString(value: unknown, label: string): asserts value is string {
  if (!_.isString(value) || _.trim(value).length < 1) {
    throw new ApplicationError(`${label} is required.`, { code: 'INVALID_STORAGE_ARGUMENT' })
  }
}

function validateTargets(targets: unknown): asserts targets is StorageTargetUpdate[] {
  if (!Array.isArray(targets)) {
    throw new ApplicationError('targets must be an array.', { code: 'INVALID_STORAGE_TARGETS' })
  }
  for (const target of targets as unknown[]) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new ApplicationError('target key is required.', { code: 'INVALID_STORAGE_ARGUMENT' })
    }
    requireString(Reflect.get(target, 'key'), 'target key')
    if (!_.isBoolean(Reflect.get(target, 'isEnabled'))) {
      throw new ApplicationError('target isEnabled must be a boolean.', { code: 'INVALID_STORAGE_TARGETS' })
    }
    requireString(Reflect.get(target, 'mode'), 'target mode')
    if (!Array.isArray(Reflect.get(target, 'config'))) {
      throw new ApplicationError('target config must be an array.', { code: 'INVALID_STORAGE_TARGETS' })
    }
  }
}

const listTargets = async () => {
  const targets = await storageModel.getTargets()
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
  for (const target of targets) {
    const current = _.find(currentTargets, ['key', target.key])
    if (!current) continue
    const config = parseConfig(target.config, { errorMessage: 'target config must contain valid entries' })
    for (const [key, value] of Object.entries(config)) {
      if (value === '********') config[key] = _.get(current.config, key, '')
    }
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
  await storageModel.executeAction(targetKey, handler)
}

export default { executeAction, listStatus, listTargets, updateTargets }
