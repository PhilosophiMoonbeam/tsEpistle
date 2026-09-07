import type { Knex } from 'knex'
import type { Request } from 'express'
import { accountSessionIsCurrent } from './account-session.ts'
import { principalId, type PagePrincipal } from './page-access.ts'
import errors from '../operations/errors.ts'

export interface SystemRequester {
  user: PagePrincipal
  apiKey?: { id: number; groupId: number; expiresAt: number | null }
}
export const systemRequester = (req: Request): SystemRequester => ({
  user: req.user,
  ...(req.apiKeyAuth ? { apiKey: { id: req.apiKeyAuth.apiKeyId, groupId: req.apiKeyAuth.groupId, expiresAt: req.apiKeyAuth.expiresAt } } : {})
})
interface Group {
  id: number
  permissions: string[]
  adminRevision: string
}
const denied = (message: string): never => {
  throw new errors.ApplicationError(message, { status: 403 })
}
/** Revalidate current database authority for both browser sessions and API principals. */
export const requireSystemAuthority = async (tx: Knex.Transaction, requester: SystemRequester, lock = false, now = new Date()) => {
  const gq = tx<Group>('groups').select('id', 'permissions', 'adminRevision').orderBy('id'),
    groups = await (lock ? gq.forUpdate() : gq)
  if (!requester.user) return denied('An administrator sign-in is required.')
  const actorId = principalId(requester.user)
  let ids: number[],
    apiKeyId: number | null = null
  if (actorId !== null) {
    if (requester.apiKey) return denied('The administrator principal is inconsistent.')
    const uq = tx<{ id: number; isActive: boolean; authVersion: number }>('users').where('id', actorId).select('id', 'isActive', 'authVersion').first()
    const account = await (lock ? uq.forUpdate() : uq)
    if (!accountSessionIsCurrent({ id: actorId, authVersion: Reflect.get(requester.user, 'authVersion') }, account))
      return denied('Your account session changed. Sign in again.')
    ids = (await tx<{ groupId: number }>('userGroups').where('userId', actorId).select('groupId')).map(row => row.groupId).sort((a, b) => a - b)
  } else {
    const key = requester.apiKey
    if (
      !key ||
      !Number.isSafeInteger(key.id) ||
      key.id < 1 ||
      !Number.isSafeInteger(key.groupId) ||
      key.groupId < 1 ||
      requester.user.id !== 1 ||
      requester.user.ownershipUserId !== null ||
      !Array.isArray(requester.user.groups) ||
      requester.user.groups.length !== 1 ||
      requester.user.groups[0] !== key.groupId
    )
      return denied('A current administrator API credential is required.')
    const kq = tx<{ id: number; isRevoked: boolean; expiration: string }>('apiKeys').where('id', key.id).select('id', 'isRevoked', 'expiration').first()
    const account = await (lock ? kq.forUpdate() : kq),
      until = account ? new Date(account.expiration).getTime() : NaN
    if (
      !account ||
      account.isRevoked !== false ||
      !Number.isFinite(until) ||
      until <= now.getTime() ||
      key.expiresAt === null ||
      !Number.isFinite(key.expiresAt) ||
      key.expiresAt * 1000 <= now.getTime()
    )
      return denied('The administrator API credential expired or was revoked.')
    ids = [key.groupId]
    apiKeyId = key.id
  }
  if (!groups.some(group => ids.includes(group.id) && Array.isArray(group.permissions) && group.permissions.includes('manage:system')))
    return denied('System administration is required.')
  return { actorId, apiKeyId, ids, groups }
}
