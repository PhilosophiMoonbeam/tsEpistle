const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export interface ApiPrincipal extends Express.User {
  readonly api: number
  readonly grp: number
  readonly ownershipUserId: null
  readonly groups: number[]
  readonly permissions: string[]
  readonly getGlobalPermissions: () => string[]
  readonly getGroups: () => number[]
  readonly exp?: number
  readonly mcpResource?: string
  readonly mcpResourceVersion?: number
}

/**
 * API credentials are principals in their own right, not users. In
 * particular, an API principal deliberately has no `id` property: any
 * human-attributed sink must reject it instead of treating it as a user row.
 */
export const createApiPrincipal = (apiKeyId: number, groupId: number, permissions: readonly string[]): ApiPrincipal => {
  if (!positiveInteger(apiKeyId) || !positiveInteger(groupId)) throw new TypeError('API principal identifiers must be positive safe integers')
  if (!Array.isArray(permissions) || !permissions.every(permission => typeof permission === 'string')) throw new TypeError('API principal permissions must be strings')

  const assignedPermissions = [...permissions]
  const groups = [groupId]
  return {
    api: apiKeyId,
    grp: groupId,
    email: 'api@localhost',
    name: 'API',
    pictureUrl: null,
    timezone: 'America/New_York',
    localeCode: 'en',
    permissions: assignedPermissions,
    groups,
    ownershipUserId: null,
    getGlobalPermissions: () => assignedPermissions,
    getGroups: () => groups
  }
}

/**
 * Recognize both the signed API-key claims Passport supplies before the
 * request is normalized and the fully materialized principal from the
 * factory above. A user-shaped id is never accepted as API identity.
 */
export const isApiPrincipal = (value: unknown): value is ApiPrincipal => {
  if (!isRecord(value) || 'id' in value || !Object.hasOwn(value, 'api') || !Object.hasOwn(value, 'grp') || !positiveInteger(value.api) || !positiveInteger(value.grp)) return false
  if (Object.hasOwn(value, 'ownershipUserId') && value.ownershipUserId !== null) return false
  if (value.groups !== undefined && (!Array.isArray(value.groups) || value.groups.length !== 1 || value.groups[0] !== value.grp)) return false
  if (value.permissions !== undefined && (!Array.isArray(value.permissions) || !value.permissions.every(permission => typeof permission === 'string'))) return false
  const expiresAt = value.exp
  if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt < 0)) return false
  if (value.mcpResource !== undefined && typeof value.mcpResource !== 'string') return false
  const resourceVersion = value.mcpResourceVersion
  if (resourceVersion !== undefined && (typeof resourceVersion !== 'number' || !Number.isSafeInteger(resourceVersion) || resourceVersion < 0)) return false
  return true
}

export class ApiPrincipalMutationError extends Error {
  readonly code = 'API_KEY_MUTATION_FORBIDDEN'
  readonly status = 403

  constructor () {
    super('API-key principals cannot perform direct mutations.')
    this.name = 'API_KEY_MUTATION_FORBIDDEN'
  }
}

/**
 * Human-attributed stores call this before any lookup or other side effect.
 * Guest principals remain valid and are intentionally handled separately.
 */
export const rejectApiPrincipalMutation = (value: unknown): void => {
  if (isApiPrincipal(value)) throw new ApiPrincipalMutationError()
}
