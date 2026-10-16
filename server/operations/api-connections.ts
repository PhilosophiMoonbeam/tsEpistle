import jwt from 'jsonwebtoken'
import type { Knex } from 'knex'
import type { ApiConnectionInfo, ApiKeyGrant } from '../../shared/api-admin.ts'

/** Display metadata only. Authentication continues to verify the token independently. */
export const describeApiKeyGrant = (key: unknown): ApiKeyGrant => {
  let payload: unknown = null
  try { if (typeof key === 'string') payload = jwt.decode(key) } catch { /* Malformed legacy keys remain inspectable. */ }
  const claims = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  return {
    groupId: typeof claims.grp === 'number' && Number.isSafeInteger(claims.grp) && claims.grp > 0 ? claims.grp : null
  }
}

type ConnectionRuntime = { config: { host: string; agents?: { mcp?: { enabled?: boolean } } }; models: { knex: Knex } }
export const describeApiConnections = async (): Promise<ApiConnectionInfo> => {
  const wiki = WIKI as unknown as ConnectionRuntime
  const rows = await wiki.models.knex('groups').select('id', 'name', 'permissions', 'pageRules').orderBy('name')
  const parseArray = (value: unknown): unknown[] => {
    if (value === null || value === undefined) return []
    if (typeof value === 'string') value = JSON.parse(value)
    if (!Array.isArray(value)) throw new TypeError('Group grant metadata is invalid')
    return value
  }
  return { groups: rows.filter(row => Number(row.id) !== 2).map(row => ({
    id: Number(row.id), name: String(row.name), permissions: parseArray(row.permissions).filter((p): p is string => typeof p === 'string'), pageRuleCount: parseArray(row.pageRules).length,
    pageRules: parseArray(row.pageRules).map(value => {
      if (!value || typeof value !== 'object' || !('path' in value) || typeof value.path !== 'string' || !('match' in value) || typeof value.match !== 'string') throw new TypeError('Group page rule metadata is invalid')
      const rule = value as Record<string, unknown>
      return { path: value.path, match: value.match, deny: rule.deny === true, roles: parseArray(rule.roles).filter((role): role is string => typeof role === 'string'), locales: parseArray(rule.locales).filter((locale): locale is string => typeof locale === 'string') }
    })
  })) }
}
