import type { Knex } from 'knex'
import jwt from 'jsonwebtoken'
import { IssuePersonalMcpKeyInputSchema, type PersonalMcpKey } from '../../shared/personal-mcp.ts'
import { loadPersonalMcpOwner, personalMcpEligible, personalMcpEnabled, personalMcpEndpoint, personalMcpRuntime, type McpKeyRecord } from '../helpers/personal-mcp.ts'
import { isApiPrincipal } from '../helpers/api-principal.ts'
import errors from './errors.ts'

const { ApplicationError } = errors
interface SigningRuntime {
  config: { auth: { audience: string }; certs: { private: string | Buffer }; sessionSecret: string }
  auth: { reloadApiKeys(): Promise<void> }
  events: { outbound: { emit(event: string): void } }
}
const keyDto = (row: Pick<McpKeyRecord, 'id' | 'name' | 'personalAccess' | 'createdAt' | 'expiration' | 'isRevoked'>): PersonalMcpKey => ({
  id: row.id, name: row.name, access: row.personalAccess!, createdAt: row.createdAt,
  expiresAt: row.expiration, isRevoked: row.isRevoked === true || row.isRevoked === 1
})
const requireOwner = async (requester: Express.User | undefined, expectedAccountId: unknown, database: Knex | Knex.Transaction) => {
  const id = requester?.id
  if (isApiPrincipal(requester) || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id === 2 ||
    (Object.hasOwn(requester!, 'ownershipUserId') && requester?.ownershipUserId !== id))
    throw new ApplicationError('A signed-in user session is required.', { code: 'AUTHENTICATION_REQUIRED', status: 401 })
  if (typeof expectedAccountId !== 'string' || !/^[1-9]\d*$/.test(expectedAccountId) || !Number.isSafeInteger(Number(expectedAccountId)))
    throw new ApplicationError('The profile account identity is required.', { code: 'INVALID_PROFILE_ACCOUNT', status: 400 })
  if (Number(expectedAccountId) !== id) throw new ApplicationError('Your signed-in account changed. Reload your profile.', { code: 'STALE_PROFILE', status: 409 })
  return loadPersonalMcpOwner(id, database)
}

export const listPersonalMcpKeys = async (requester: Express.User | undefined, expectedAccountId: unknown) => {
  const database = personalMcpRuntime().models.knex
  const { owner, permissions } = await requireOwner(requester, expectedAccountId, database)
  const keys = await database<McpKeyRecord>('apiKeys').select('id', 'name', 'personalAccess', 'createdAt', 'expiration', 'isRevoked')
    .where({ personalOwnerId: owner.id }).whereNotNull('personalAccess').orderBy('createdAt', 'desc')
  return { enabled: personalMcpEnabled(), endpoint: personalMcpEndpoint(), canIssue: personalMcpEligible(permissions), keys: keys.map(keyDto) }
}

export const issuePersonalMcpKey = async (requester: Express.User | undefined, expectedAccountId: unknown, value: unknown) => {
  const parsed = IssuePersonalMcpKeyInputSchema.safeParse(value)
  if (!parsed.success) throw new ApplicationError('Choose a name, read-only or read-write access, and an expiry from 1 through 90 days.', { code: 'INVALID_PERSONAL_MCP_KEY', status: 400 })
  const input = parsed.data
  const runtime = WIKI as unknown as SigningRuntime
  const result = await personalMcpRuntime().models.knex.transaction(async transaction => {
    const { owner, permissions } = await requireOwner(requester, expectedAccountId, transaction)
    if (!personalMcpEligible(permissions)) throw new ApplicationError('Wiki Agent and MCP access are required to issue a personal key.', { code: 'MCP_PERMISSION_REQUIRED', status: 403 })
    const now = new Date()
    const expiration = new Date(now.valueOf() + input.expirationDays * 86_400_000).toISOString()
    const [row] = await transaction<McpKeyRecord>('apiKeys').insert({
      name: input.name, key: 'pending', personalOwnerId: owner.id, personalAccess: input.access,
      expiration, isRevoked: true, createdAt: now.toISOString(), updatedAt: now.toISOString()
    }).returning('*')
    if (!row) throw new Error('Personal MCP key insertion did not return its identity.')
    const key = jwt.sign({
      api: row.id,
      // Stable key transport binding, never an authority group for personal keys.
      grp: 1,
      personalMcp: 1, personalOwnerId: owner.id, personalAccess: input.access,
      mcpResource: personalMcpEndpoint(), mcpResourceVersion: 1
    }, { key: runtime.config.certs.private, passphrase: runtime.config.sessionSecret }, {
      algorithm: 'RS256', expiresIn: input.expirationDays * 86_400,
      audience: runtime.config.auth.audience, issuer: 'urn:wiki.js'
    })
    await transaction('apiKeys').where({ id: row.id }).update({ key, isRevoked: false })
    return { key, item: keyDto({ ...row, isRevoked: false }) }
  })
  await runtime.auth.reloadApiKeys()
  runtime.events.outbound.emit('reloadApiKeys')
  return result
}

export const revokePersonalMcpKey = async (requester: Express.User | undefined, expectedAccountId: unknown, id: number) => {
  if (!Number.isSafeInteger(id) || id < 1) throw new ApplicationError('Key id must be a positive integer.', { code: 'INVALID_PERSONAL_MCP_KEY', status: 400 })
  await personalMcpRuntime().models.knex.transaction(async transaction => {
    const { owner } = await requireOwner(requester, expectedAccountId, transaction)
    const updated = await transaction('apiKeys').where({ id, personalOwnerId: owner.id }).whereNotNull('personalAccess')
      .update({ isRevoked: true, updatedAt: new Date().toISOString() })
    if (updated !== 1) throw new ApplicationError('Personal MCP key does not exist.', { code: 'API_KEY_NOT_FOUND', status: 404 })
  })
  const runtime = WIKI as unknown as SigningRuntime
  await runtime.auth.reloadApiKeys()
  runtime.events.outbound.emit('reloadApiKeys')
  return { id, isRevoked: true as const }
}
