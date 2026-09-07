import type { Knex } from 'knex'
import _ from 'lodash'
import { describeApiKeyGrant } from './api-connections.ts'
import ms from 'ms'

import errors from './errors.ts'
import { requireSystemAuthority, type SystemRequester } from '../helpers/system-authority.ts'

const { ApplicationError } = errors

interface ApiKey {
  id: number
  name: string
  key: string
  isRevoked: boolean | number
  expiration: string
  createdAt: unknown
  updatedAt: unknown
}

interface ApiKeyQuery {
  orderBy(columns: string[]): Promise<ApiKey[]>
  findById(id: number): { patch(data: Record<string, unknown>): Promise<unknown> }
}

interface ApiKeyModel {
  query(): ApiKeyQuery
  createNewKey(input: { name: string, expiration: string, fullAccess: boolean, group: number | null | undefined, mcpAccess?: boolean }): Promise<unknown>
}

interface ApiConfiguration {
  isEnabled?: unknown
  [key: string]: unknown
}

interface Setting {
  key: string
  value: unknown
}

const currentApiConfiguration = (): ApiConfiguration => {
  const configuration = WIKI.config as { api?: unknown }
  const config = configuration.api
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ApplicationError('API configuration is unavailable', { status: 500, code: 'API_CONFIGURATION_UNAVAILABLE' })
  }
  // The guarded runtime configuration remains the canonical object, including legacy invalid values.
  const api = config as ApiConfiguration
  return api
}
const getApiKeyModel = (): ApiKeyModel => {
  const models = WIKI.models as { apiKeys: ApiKeyModel }
  return models.apiKeys
}
const getDatabase = (): Knex => {
  const models = WIKI.models as { knex: Knex }
  return models.knex
}
const getAuth = (): { reloadApiKeys(): Promise<unknown> } =>
  WIKI.auth as { reloadApiKeys(): Promise<unknown> }
const getOutboundEvents = (): { emit(event: string): void } => {
  const events = WIKI.events as { outbound: { emit(event: string): void } }
  return events.outbound
}

const redactedSuffix = (key: unknown): string => _.isString(key) && key.length > 20 ? `...${key.substring(key.length - 20)}` : '...[redacted]'

const serializeKey = (key: ApiKey) => ({
  id: key.id,
  name: key.name,
  keyShort: redactedSuffix(key.key),
  grant: describeApiKeyGrant(key.key),
  isRevoked: key.isRevoked === true || key.isRevoked === 1,
  expiration: key.expiration,
  createdAt: key.createdAt,
  updatedAt: key.updatedAt
})

const getConfig = async () => ({
  enabled: currentApiConfiguration().isEnabled === true,
  keys: (await getApiKeyModel().query().orderBy(['isRevoked', 'name'])).map(serializeKey)
})

let stateWrite: Promise<void> = Promise.resolve()
const setState = async (requester: SystemRequester, enabled: unknown): Promise<void> => {
  if (!_.isBoolean(enabled)) throw new ApplicationError('enabled must be a boolean', { code: 'INVALID_API_STATE' })
  const write = stateWrite.then(async () => {
    await getDatabase().transaction(async tx => {
      await requireSystemAuthority(tx, requester, true, new Date(), ['manage:system', 'manage:api'])
      const setting = await tx<Setting>('settings').where('key', 'api').forUpdate().first()
      const previous = setting?.value
      let persisted: Record<string, unknown>
      if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
        // The database JSON value was narrowed to an object before this structural assertion.
        persisted = previous as Record<string, unknown>
      } else {
        persisted = { ...currentApiConfiguration() }
      }
      const value = { ...persisted, isEnabled: enabled }
      await tx('settings')
        .insert({ key: 'api', value: JSON.stringify(value), updatedAt: new Date().toISOString() })
        .onConflict('key')
        .merge(['value', 'updatedAt'])
    })
    currentApiConfiguration().isEnabled = enabled
    getOutboundEvents().emit('reloadConfig')
  })
  stateWrite = write.catch(() => {})
  return write
}

const createKey = async (input: { name: unknown, expiration: unknown, fullAccess: unknown, group: unknown, mcpAccess?: unknown }): Promise<unknown> => {
  const { name, expiration, fullAccess, group } = input
  if (!_.isString(name) || name.trim().length < 2 || name.trim().length > 255) throw new ApplicationError('name must contain 2 through 255 characters', { code: 'INVALID_API_KEY_NAME' })
  if (!_.isString(expiration) || expiration.length < 1) throw new ApplicationError('expiration must be a non-empty string', { code: 'INVALID_API_KEY_EXPIRATION' })
  if (!_.isBoolean(fullAccess)) throw new ApplicationError('fullAccess must be a boolean', { code: 'INVALID_API_KEY_ACCESS' })
  if (!_.isNil(group) && !Number.isInteger(group)) throw new ApplicationError('group must be an integer or null', { code: 'INVALID_API_KEY_GROUP' })
  const lifetime = ms(expiration)
  if (!Number.isFinite(lifetime) || lifetime < 1000 || lifetime > ms('3y')) throw new ApplicationError('Expiration must be a duration from one second through three years', { code: 'INVALID_API_KEY_EXPIRATION' })
  if (!fullAccess && (typeof group !== 'number' || group <= 1 || group === 2)) throw new ApplicationError('Choose a non-system group for scoped access', { code: 'INVALID_API_KEY_GROUP' })
  if (!fullAccess && !(await (WIKI.models as { groups: { query(): { findById(id: number): Promise<unknown> } } }).groups.query().findById(group as number))) throw new ApplicationError('The selected group no longer exists', { code: 'INVALID_API_KEY_GROUP' })
  if (input.mcpAccess !== undefined && typeof input.mcpAccess !== 'boolean') throw new ApplicationError('mcpAccess must be a boolean', { code: 'INVALID_API_KEY_MCP' })
  if (input.mcpAccess === true && !(WIKI.config as { agents?: { mcp?: { enabled?: boolean } } }).agents?.mcp?.enabled) throw new ApplicationError('MCP is not enabled in this deployment', { code: 'MCP_DISABLED' })
  const key = await getApiKeyModel().createNewKey({ name: name.trim(), expiration, fullAccess, group: group as number | null | undefined, ...(typeof input.mcpAccess === 'boolean' ? { mcpAccess: input.mcpAccess } : {}) })
  await getAuth().reloadApiKeys()
  getOutboundEvents().emit('reloadApiKeys')
  return key
}

const revokeKey = async (id: unknown): Promise<void> => {
  if (!Number.isSafeInteger(id) || typeof id !== 'number' || id < 1) throw new ApplicationError('id must be a positive integer', { code: 'INVALID_API_KEY_ID' })
  const updated = await getApiKeyModel().query().findById(id).patch({ isRevoked: true })
  if (updated !== 1) throw new ApplicationError('API key no longer exists', { status: 404, code: 'API_KEY_NOT_FOUND' })
  await getAuth().reloadApiKeys()
  getOutboundEvents().emit('reloadApiKeys')
}

export default { createKey, getConfig, revokeKey, setState }
