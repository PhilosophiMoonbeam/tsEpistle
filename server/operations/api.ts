import type { Knex } from 'knex'
import _ from 'lodash'
import ms from 'ms'
import type { ApiAssignableGroup } from '../../shared/api-admin.ts'
import { describeApiKeyGrant } from './api-connections.ts'
import errors from './errors.ts'
import { groupAuthorityAllows } from './group-administration.ts'
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
  query(transaction?: Knex.Transaction): ApiKeyQuery
  createNewKey(
    input: { name: string; expiration: string; fullAccess: boolean; group: number | null; mcpAccess?: boolean },
    transaction?: Knex.Transaction
  ): Promise<unknown>
}

interface ApiConfiguration {
  isEnabled?: unknown
  [key: string]: unknown
}

interface Setting {
  key: string
  value: unknown
}

interface GroupRow {
  id: number
  name: string
  permissions: unknown
  pageRules: unknown
  isSystem?: boolean
}
type GrantGroup = {
  id: number
  permissions: string[]
  isSystem?: boolean
}

type GroupGrantRow = Pick<GroupRow, 'id' | 'permissions' | 'isSystem'>

const grantGroup = (group: Pick<GroupRow, 'id' | 'isSystem'>, permissions: string[]): GrantGroup => ({
  id: group.id,
  permissions,
  ...(typeof group.isSystem === 'boolean' ? { isSystem: group.isSystem } : {})
})

interface Authority {
  actorId: number | null
  apiKeyId: number | null
  ids: number[]
  groups: Array<{ id: number; permissions: string[]; adminRevision: string }>
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

const parseArray = (value: unknown, message: string): unknown[] => {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      throw new ApplicationError(message, { status: 500, code: 'API_GROUP_METADATA_INVALID' })
    }
  }
  if (!Array.isArray(parsed)) throw new ApplicationError(message, { status: 500, code: 'API_GROUP_METADATA_INVALID' })
  return parsed
}

const groupPermissions = (value: unknown): string[] | null => {
  try {
    const values = parseArray(value, 'API group permissions are invalid.')
    return values.every(item => typeof item === 'string') ? values as string[] : null
  } catch {
    return null
  }
}

const groupPageRules = (value: unknown): ApiAssignableGroup['pageRules'] => parseArray(value, 'API group page rules are invalid.').map(rule => {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new ApplicationError('API group page rules are invalid.', { status: 500, code: 'API_GROUP_METADATA_INVALID' })
  const record = rule as Record<string, unknown>
  const roles = parseArray(record.roles ?? [], 'API group page rules are invalid.')
  const locales = parseArray(record.locales ?? [], 'API group page rules are invalid.')
  if (typeof record.match !== 'string' || typeof record.path !== 'string' || !roles.every(role => typeof role === 'string') || !locales.every(locale => typeof locale === 'string')) {
    throw new ApplicationError('API group page rules are invalid.', { status: 500, code: 'API_GROUP_METADATA_INVALID' })
  }
  return {
    match: record.match,
    path: record.path,
    deny: record.deny === true,
    roles: roles as string[],
    locales: locales as string[]
  }
})

const serializeGroup = (row: GroupRow): ApiAssignableGroup | null => {
  const permissions = groupPermissions(row.permissions)
  if (!permissions || typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || typeof row.name !== 'string') return null
  const pageRules = groupPageRules(row.pageRules)
  return {
    id: row.id,
    name: row.name,
    permissions,
    pageRuleCount: pageRules.length,
    pageRules
  }
}

const actorPermissions = (authority: Authority): string[] =>
  authority.groups
    .filter(group => authority.ids.includes(group.id))
    .flatMap(group => Array.isArray(group.permissions) ? group.permissions.filter((permission): permission is string => typeof permission === 'string') : [])

const requiresSystemAuthority = (group: GrantGroup): boolean =>
  group.id === 1 ||
  group.isSystem === true ||
  group.permissions.some(permission => permission.endsWith(':system') || permission === 'write:scripts')

const forbiddenGrant = (message = 'The requested API credential grant exceeds your delegation authority.'): never => {
  throw new ApplicationError(message, { status: 403, code: 'API_KEY_GRANT_FORBIDDEN' })
}

const authorizeGroupGrant = (authority: Authority, group: GrantGroup): void => {
  const permissions = actorPermissions(authority)
  if (requiresSystemAuthority(group) && !permissions.includes('manage:system')) forbiddenGrant()
  if (!groupAuthorityAllows(permissions, group.permissions)) forbiddenGrant()
}

const targetGroupForGrant = (
  grantGroupId: number | null,
  groups: readonly GroupGrantRow[]
): GrantGroup | null => {
  if (grantGroupId === 1) return { id: 1, permissions: ['manage:system'] }
  if (grantGroupId === null || grantGroupId === 2) return null
  const group = groups.find(candidate => candidate.id === grantGroupId)
  const permissions = group ? groupPermissions(group.permissions) : null
  return group && permissions ? grantGroup(group, permissions) : null
}

const canRevokeGrant = (authority: Authority, grantGroupId: number | null, groups: readonly GroupGrantRow[]): boolean => {
  const target = targetGroupForGrant(grantGroupId, groups)
  if (!target) return actorPermissions(authority).includes('manage:system')
  try {
    authorizeGroupGrant(authority, target)
    return true
  } catch {
    return false
  }
}

const serializeKey = (key: ApiKey, canRevoke: boolean) => ({
  id: key.id,
  name: key.name,
  keyShort: redactedSuffix(key.key),
  grant: describeApiKeyGrant(key.key),
  canRevoke,
  isRevoked: key.isRevoked === true || key.isRevoked === 1,
  expiration: key.expiration,
  createdAt: key.createdAt,
  updatedAt: key.updatedAt
})

const getConfig = async (requester: SystemRequester) => getDatabase().transaction(async tx => {
  const authority = await requireSystemAuthority(tx, requester, true, new Date(), ['manage:system', 'manage:api'])
  const groups = await tx<GroupRow>('groups').select('id', 'name', 'permissions', 'pageRules', 'isSystem').orderBy('name')
  const permissions = actorPermissions(authority)
  const assignableGroups = groups
    .filter(group => group.id !== 2)
    .filter(group => {
      const targetPermissions = groupPermissions(group.permissions)
      return targetPermissions !== null && (requiresSystemAuthority(grantGroup(group, targetPermissions))
        ? permissions.includes('manage:system')
        : groupAuthorityAllows(permissions, targetPermissions))
    })
    .map(serializeGroup)
    .filter((group): group is ApiAssignableGroup => group !== null)
  const keys = await getApiKeyModel().query(tx).orderBy(['isRevoked', 'name'])
  return {
    enabled: currentApiConfiguration().isEnabled === true,
    createFullAccess: permissions.includes('manage:system'),
    assignableGroups,
    keys: keys.map(key => serializeKey(key, canRevokeGrant(authority, describeApiKeyGrant(key.key).groupId, groups)))
  }
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

const createKey = async (
  requester: SystemRequester,
  input: { name: unknown; expiration: unknown; fullAccess: unknown; group: unknown; mcpAccess?: unknown }
): Promise<unknown> => {
  const { name, expiration, fullAccess, group } = input
  if (!_.isString(name) || name.trim().length < 2 || name.trim().length > 255) throw new ApplicationError('name must contain 2 through 255 characters', { code: 'INVALID_API_KEY_NAME' })
  if (!_.isString(expiration) || expiration.length < 1) throw new ApplicationError('expiration must be a non-empty string', { code: 'INVALID_API_KEY_EXPIRATION' })
  if (!_.isBoolean(fullAccess)) throw new ApplicationError('fullAccess must be a boolean', { code: 'INVALID_API_KEY_ACCESS' })
  if (!_.isNil(group) && !Number.isInteger(group)) throw new ApplicationError('group must be an integer or null', { code: 'INVALID_API_KEY_GROUP' })
  if (fullAccess && !_.isNil(group)) throw new ApplicationError('group must be null when fullAccess is true', { code: 'INVALID_API_KEY_GROUP' })
  const lifetime = ms(expiration)
  if (!Number.isFinite(lifetime) || lifetime < 1000 || lifetime > ms('3y')) throw new ApplicationError('Expiration must be a duration from one second through three years', { code: 'INVALID_API_KEY_EXPIRATION' })
  if (!fullAccess && (typeof group !== 'number' || group <= 2)) throw new ApplicationError('Choose a non-system group for scoped access', { code: 'INVALID_API_KEY_GROUP' })
  if (input.mcpAccess !== undefined && typeof input.mcpAccess !== 'boolean') throw new ApplicationError('mcpAccess must be a boolean', { code: 'INVALID_API_KEY_MCP' })
  if (input.mcpAccess === true && !(WIKI.config as { agents?: { mcp?: { enabled?: boolean } } }).agents?.mcp?.enabled) throw new ApplicationError('MCP is not enabled in this deployment', { code: 'MCP_DISABLED' })

  const key = await getDatabase().transaction(async tx => {
    const authority = await requireSystemAuthority(tx, requester, true, new Date(), ['manage:system', 'manage:api'])
    let target: GrantGroup
    let targetGroupId: number
    if (fullAccess) {
      target = { id: 1, permissions: ['manage:system'] }
      targetGroupId = 1
    } else {
      targetGroupId = group as number
      const row = await tx<GroupRow>('groups').where('id', targetGroupId).forUpdate().first()
      const permissions = row ? groupPermissions(row.permissions) : null
      if (!row || !permissions) throw new ApplicationError('The selected group no longer exists', { code: 'INVALID_API_KEY_GROUP' })
      target = grantGroup(row, permissions)
    }
    authorizeGroupGrant(authority, target)
    return getApiKeyModel().createNewKey({
      name: name.trim(),
      expiration,
      fullAccess,
      group: targetGroupId,
      ...(typeof input.mcpAccess === 'boolean' ? { mcpAccess: input.mcpAccess } : {})
    }, tx)
  })
  await getAuth().reloadApiKeys()
  getOutboundEvents().emit('reloadApiKeys')
  return key
}

const revokeKey = async (requester: SystemRequester, id: unknown): Promise<void> => {
  if (!Number.isSafeInteger(id) || typeof id !== 'number' || id < 1) throw new ApplicationError('id must be a positive integer', { code: 'INVALID_API_KEY_ID' })
  await getDatabase().transaction(async tx => {
    const authority = await requireSystemAuthority(tx, requester, true, new Date(), ['manage:system', 'manage:api'])
    const row = await tx<ApiKey>('apiKeys').where('id', id).forUpdate().first()
    if (!row) throw new ApplicationError('API key no longer exists', { status: 404, code: 'API_KEY_NOT_FOUND' })
    const groups = await tx<GroupRow>('groups').select('id', 'permissions', 'isSystem').orderBy('id')
    const grantGroupId = describeApiKeyGrant(row.key).groupId
    const target = targetGroupForGrant(grantGroupId, groups)
    if (!target) {
      if (!actorPermissions(authority).includes('manage:system')) forbiddenGrant('Only system administration may revoke an unscoped or legacy API credential.')
    } else {
      authorizeGroupGrant(authority, target)
    }
    const updated = await tx('apiKeys').where('id', id).update({ isRevoked: true })
    if (updated !== 1) throw new ApplicationError('API key no longer exists', { status: 404, code: 'API_KEY_NOT_FOUND' })
  })
  await getAuth().reloadApiKeys()
  getOutboundEvents().emit('reloadApiKeys')
}

export default { createKey, getConfig, revokeKey, setState }
