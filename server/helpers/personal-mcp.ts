import type { Knex } from 'knex'
import jwt from 'jsonwebtoken'
import type { PersonalMcpAccess } from '../../shared/personal-mcp.ts'
import { canonicalMcpResource } from '../agents/origins.ts'
import { createApiPrincipal, type ApiPrincipal } from './api-principal.ts'
import errors from '../operations/errors.ts'

const { ApplicationError } = errors
export interface McpKeyRecord {
  id: number
  name: string
  key: string
  expiration: string
  createdAt: string
  updatedAt: string
  isRevoked: boolean | number
  personalOwnerId: number | null
  personalAccess: PersonalMcpAccess | null
}
interface OwnerRecord {
  id: number
  isActive: boolean | number
  authVersion: number
  name: string
  email: string
  pictureUrl: string | null
  timezone: string
  localeCode: string
}
interface GroupRecord { id: number; permissions: unknown }
interface PersonalMcpRuntime {
  config: {
    api: { isEnabled: boolean }
    agents: { enabled: boolean; mcp: { enabled: boolean } }
    host: string
  }
  models: { knex: Knex }
}
export const personalMcpRuntime = (): PersonalMcpRuntime => WIKI as unknown as PersonalMcpRuntime
export const personalMcpEnabled = (): boolean => {
  const { config } = personalMcpRuntime()
  return config.api.isEnabled === true && config.agents.enabled === true && config.agents.mcp.enabled === true
}
export const personalMcpEndpoint = (): string => canonicalMcpResource(personalMcpRuntime().config.host).href
const denied = (message: string, code = 'API_KEY_INVALID', status = 401): never => {
  throw new ApplicationError(message, { code, status })
}
const stringArray = (value: unknown): string[] => {
  let parsed = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return denied('Owner group permissions are invalid.') }
  }
  if (!Array.isArray(parsed) || !parsed.every((permission): permission is string => typeof permission === 'string')) return denied('Owner group permissions are invalid.')
  return parsed
}
export const loadPersonalMcpOwner = async (ownerId: number, database: Knex | Knex.Transaction = personalMcpRuntime().models.knex) => {
  if (!Number.isSafeInteger(ownerId) || ownerId < 1 || ownerId === 2) return denied('Personal MCP owner is unavailable.')
  const owner = await database<OwnerRecord>('users').select('id', 'isActive', 'authVersion', 'name', 'email', 'pictureUrl', 'timezone', 'localeCode').where({ id: ownerId }).first()
  if (!owner || !(owner.isActive === true || owner.isActive === 1)) return denied('Personal MCP owner is unavailable.')
  const groups = await database<GroupRecord>('groups').join('userGroups', 'groups.id', 'userGroups.groupId')
    .where('userGroups.userId', ownerId).select('groups.id', 'groups.permissions').orderBy('groups.id')
  const permissions = [...new Set(groups.flatMap(group => stringArray(group.permissions)))]
  return { owner, groups: groups.map(group => group.id), permissions }
}
export const personalMcpEligible = (permissions: readonly string[]): boolean => personalMcpEnabled() &&
  (permissions.includes('manage:system') || (permissions.includes('use:agents') && permissions.includes('use:mcp')))

export const loadActiveApiKey = async (apiKeyId: number, database: Knex | Knex.Transaction = personalMcpRuntime().models.knex): Promise<McpKeyRecord> => {
  const row = await database<McpKeyRecord>('apiKeys').where({ id: apiKeyId }).first()
  if (!row || !(row.isRevoked === false || row.isRevoked === 0) || !Number.isFinite(Date.parse(row.expiration)) || Date.parse(row.expiration) <= Date.now())
    return denied('API key is expired, invalid, or revoked.')
  return row
}

/** API transport identity stays key-bound and has no browser-user id. */
export const loadMcpApiPrincipal = async (apiKeyId: number, groupId: number, database: Knex | Knex.Transaction = personalMcpRuntime().models.knex): Promise<ApiPrincipal> => {
  const row = await loadActiveApiKey(apiKeyId, database)
  const claims = jwt.decode(row.key)
  if (!claims || typeof claims !== 'object' || claims.api !== apiKeyId || claims.grp !== groupId) return denied('API key identity does not match its stored grant.')
  if (row.personalAccess != null) {
    if (!row.personalOwnerId || (row.personalAccess !== 'read-only' && row.personalAccess !== 'read-write')) return denied('Personal MCP owner is unavailable.')
    if (claims.personalMcp !== 1 || claims.personalOwnerId !== row.personalOwnerId || claims.personalAccess !== row.personalAccess ||
      claims.mcpResource !== personalMcpEndpoint() || claims.mcpResourceVersion !== 1) return denied('Personal MCP credential binding is invalid.')
    const { owner, groups, permissions } = await loadPersonalMcpOwner(row.personalOwnerId, database)
    if (!personalMcpEligible(permissions)) return denied('Personal MCP access is no longer permitted.', 'MCP_PERMISSION_REQUIRED', 403)
    return {
      ...createApiPrincipal(apiKeyId, groupId, permissions),
      name: owner.name, email: owner.email, pictureUrl: owner.pictureUrl, timezone: owner.timezone, localeCode: owner.localeCode,
      ownershipUserId: owner.id, authVersion: owner.authVersion, personalMcpAccess: row.personalAccess,
      groups, getGroups: () => groups
    }
  }
  return denied('Only personal MCP credentials are supported by the MCP transport.', 'API_KEY_TRANSPORT_FORBIDDEN', 403)
}
