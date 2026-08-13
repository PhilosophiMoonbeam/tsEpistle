import _ from 'lodash'

import errors from './errors.ts'

const { ApplicationError } = errors

interface ApiKey {
  id: number
  name: string
  key: string
  isRevoked: boolean
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
  createNewKey(input: { name: string, expiration: string, fullAccess: boolean, group: number | null | undefined }): Promise<unknown>
}

const apiConfig = (WIKI.config as { api: { isEnabled: boolean } }).api
const apiKeyModel = (WIKI.models as { apiKeys: ApiKeyModel }).apiKeys
const configService = WIKI.configSvc as { saveToDb(keys: string[]): Promise<unknown> }
const getAuth = (): { reloadApiKeys(): Promise<unknown> } =>
  WIKI.auth as { reloadApiKeys(): Promise<unknown> }
const outboundEvents = (WIKI.events as { outbound: { emit(event: string): void } }).outbound

const redactedSuffix = (key: unknown): string => _.isString(key) && key.length > 20 ? `...${key.substring(key.length - 20)}` : '...[redacted]'

const serializeKey = (key: ApiKey) => ({
  id: key.id,
  name: key.name,
  keyShort: redactedSuffix(key.key),
  isRevoked: key.isRevoked,
  expiration: key.expiration,
  createdAt: key.createdAt,
  updatedAt: key.updatedAt
})

const getConfig = async () => ({
  enabled: apiConfig.isEnabled === true,
  keys: (await apiKeyModel.query().orderBy(['isRevoked', 'name'])).map(serializeKey)
})

const setState = async (enabled: unknown): Promise<void> => {
  if (!_.isBoolean(enabled)) throw new ApplicationError('enabled must be a boolean', { code: 'INVALID_API_STATE' })
  apiConfig.isEnabled = enabled
  await configService.saveToDb(['api'])
}

const createKey = async (input: { name: unknown, expiration: unknown, fullAccess: unknown, group: unknown }): Promise<unknown> => {
  const { name, expiration, fullAccess, group } = input
  if (!_.isString(name) || name.length < 1) throw new ApplicationError('name must be a non-empty string', { code: 'INVALID_API_KEY_NAME' })
  if (!_.isString(expiration) || expiration.length < 1) throw new ApplicationError('expiration must be a non-empty string', { code: 'INVALID_API_KEY_EXPIRATION' })
  if (!_.isBoolean(fullAccess)) throw new ApplicationError('fullAccess must be a boolean', { code: 'INVALID_API_KEY_ACCESS' })
  if (!_.isNil(group) && !Number.isInteger(group)) throw new ApplicationError('group must be an integer or null', { code: 'INVALID_API_KEY_GROUP' })
  const key = await apiKeyModel.createNewKey({ name, expiration, fullAccess, group: group as number | null | undefined })
  await getAuth().reloadApiKeys()
  outboundEvents.emit('reloadApiKeys')
  return key
}

const revokeKey = async (id: unknown): Promise<void> => {
  if (!Number.isSafeInteger(id) || typeof id !== 'number' || id < 1) throw new ApplicationError('id must be a positive integer', { code: 'INVALID_API_KEY_ID' })
  await apiKeyModel.query().findById(id).patch({ isRevoked: true })
  await getAuth().reloadApiKeys()
  outboundEvents.emit('reloadApiKeys')
}

export default { createKey, getConfig, revokeKey, setState }
