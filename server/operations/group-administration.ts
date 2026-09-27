import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { Knex } from 'knex'
import {
  groupPermissions,
  normalizeGroupRulePath,
  type GroupPolicyDraft,
  type GroupPageRule,
  type GroupWorkspace,
  type GroupRecord,
  type GroupDirectory,
  type GroupMembers,
  type GroupAccessResult,
  type GroupWriteResult
} from '../../shared/group-policy.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { principalId, type PagePrincipal } from '../helpers/page-access.ts'
import { evaluateGroupAccess } from '../helpers/group-access.ts'
import { tagAliasMap } from '../helpers/tag-aliases.ts'
import { describeApiKeyGrant } from './api-connections.ts'
import errors from './errors.ts'
const safeRegex = createRequire(import.meta.url)('safe-regex') as (pattern: string) => boolean
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const idValue = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : fail('Choose a valid group or account.')
const textValue = (value: unknown, label: string, min: number, max: number): string =>
  typeof value === 'string' && value.trim().length >= min && value.trim().length <= max ? value.trim() : fail(`${label} must contain ${min}–${max} characters.`)
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  )
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')
const date = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value ?? ''))
const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail('Enter a valid group policy.')
const strings = (value: unknown, max = 100): string[] =>
  Array.isArray(value) && value.length <= max && value.every(p => typeof p === 'string') && new Set(value).size === value.length
    ? (value as string[])
    : fail('Choose a bounded list of unique values.')
const administrative = (p: string) => ['users', 'groups', 'navigation', 'theme', 'api', 'system'].includes(p.split(':').at(-1) ?? '')
export const groupAuthorityAllows = (permissions: string[], target: string[]): boolean =>
  permissions.includes('manage:system') ||
  (!target.some(p => p.endsWith(':system') || p === 'write:scripts') && (permissions.includes('manage:groups') || !target.some(administrative)))
export const normalizeGroupPolicy = (value: unknown, existingPermissions: string[] = []): GroupPolicyDraft => {
  const v = recordValue(value),
    name = textValue(v.name, 'Group name', 1, 255),
    description = textValue(v.description ?? '', 'Group description', 0, 1000),
    redirectOnLogin = textValue(v.redirectOnLogin || '/', 'Sign-in destination', 1, 255),
    permissions = strings(v.permissions).sort()
  if (permissions.some(p => !groupPermissions.some(item => item.key === p) && !existingPermissions.includes(p))) return fail('Choose a recognized permission.')
  if (permissions.includes('use:agent-browser') && !permissions.includes('use:agents')) return fail('Agent browsing also requires Use the Wiki Agent.')
  try {
    const url = new URL(redirectOnLogin, 'https://group-policy.invalid')
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      redirectOnLogin.includes('\\') ||
      redirectOnLogin.startsWith('//') ||
      (!redirectOnLogin.startsWith('/') && !/^https?:\/\//.test(redirectOnLogin))
    )
      throw new Error()
  } catch {
    return fail('Use a workspace path starting with / or an HTTP(S) destination.')
  }
  if (!Array.isArray(v.pageRules) || v.pageRules.length > 100) return fail('Use at most 100 page rules.')
  const pageRules = v.pageRules.map(candidate => {
    const r = recordValue(candidate),
      id = textValue(r.id, 'Rule identifier', 1, 64),
      match = String(r.match) as GroupPageRule['match'],
      path = normalizeGroupRulePath(match, textValue(r.path, 'Rule path', 0, 500)),
      roles = strings(r.roles),
      locales = strings(r.locales ?? [])
    if (!['START', 'SUBTREE', 'END', 'REGEX', 'TAG', 'EXACT'].includes(match) || typeof r.deny !== 'boolean') return fail('Choose a rule match type and effect.')
    if (!roles.length || roles.some(role => !groupPermissions.some(p => p.key === role && p.pageScoped)))
      return fail('Choose at least one page-scoped action for every rule.')
    if (locales.some(locale => !/^[a-zA-Z0-9_-]{1,24}$/.test(locale))) return fail('Choose valid language codes.')
    if ((match === 'TAG' || match === 'REGEX') && !path) return fail('Tag and regular-expression rules need a value.')
    if (match === 'REGEX') {
      try {
        new RegExp(path)
        if (!safeRegex(path)) throw new Error()
      } catch {
        return fail('Use a valid, non-exponential regular expression.')
      }
    }
    return { id, path, match, deny: r.deny, roles: roles.sort(), locales: locales.sort() }
  })
  if (new Set(pageRules.map(r => r.id)).size !== pageRules.length) return fail('Page-rule identifiers must be unique.')
  return { name, description, redirectOnLogin, permissions, pageRules }
}
type Database = Knex | Knex.Transaction
interface Row extends GroupPolicyDraft {
  id: number
  isSystem: boolean
  adminRevision: string
  updatedAt: string
}
interface Account {
  id: number
  name: string
  email: string
  isActive: boolean
  authVersion: number
  isSystem: boolean
}
interface Actor {
  id: number | null
  permissions: string[]
}
interface Dependencies {
  db: Knex
  onCommitted?: (groupId: number, memberIds: number[]) => Promise<void>
}
export const createGroupAdministrationStore = ({ db, onCommitted }: Dependencies) => {
  const allGroups = async (tx: Database, lock = false): Promise<Row[]> => {
    const q = tx<Row>('groups').select('*').orderBy('id')
    return lock ? q.forUpdate() : q
  }
  const authority = async (tx: Database, requester: PagePrincipal, groups: Row[], membersOnly = false): Promise<Actor> => {
    if (!requester) return fail('An administrator sign-in is required.', 403)
    const id = principalId(requester)
    let permissions: string[]
    if (id !== null) {
      const user = await tx<Account>('users').where('id', id).first()
      if (!accountSessionIsCurrent({ id, authVersion: Reflect.get(requester, 'authVersion') }, user))
        return fail('Your account session changed. Sign in again.', 403)
      const membership = await tx<{ groupId: number }>('userGroups').where('userId', id).select('groupId')
      permissions = [...new Set(groups.filter(g => membership.some(m => m.groupId === g.id)).flatMap(g => g.permissions))]
    } else {
      const ids = requester.groups
      if (requester.ownershipUserId !== null || requester.id !== 1 || !Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'number')
        return fail('An administrator principal is required.', 403)
      permissions = groups.find(g => g.id === ids[0])?.permissions ?? []
    }
    if (!permissions.some(p => ['write:groups', 'manage:groups', 'manage:system', ...(membersOnly ? ['manage:users'] : [])].includes(p)))
      return fail('Group administration permission is required.', 403)
    return { id, permissions }
  }
  const capabilities = (row: Row, actor: Actor) => {
    const scoped = groupAuthorityAllows(actor.permissions, row.permissions),
      system = actor.permissions.includes('manage:system'),
      edit = scoped && actor.permissions.some(p => ['write:groups', 'manage:groups', 'manage:system'].includes(p)) && (!(row.isSystem || row.id <= 2) || system)
    return {
      edit,
      members: scoped && (!(row.isSystem || row.id <= 2) || system),
      delete: edit && row.id > 2 && !row.isSystem,
      rename: edit && row.id > 2 && !row.isSystem,
      permissions: edit && row.id !== 1,
      explanation: !scoped
        ? 'This group has authority outside your administrative scope.'
        : (row.isSystem || row.id <= 2) && !system
          ? 'System groups require full system administration.'
          : row.id === 1
            ? 'The Administrators group retains its identity and full-system permissions.'
            : row.id === 2
              ? 'The Guest identity and group name are protected. Its policy controls anonymous access.'
              : ''
    }
  }
  const groupMembers = (tx: Database, id: number) => tx<{ userId: number }>('userGroups').where('groupId', id).orderBy('userId').select('userId')
  const fingerprint = async (tx: Database, row: Row, groups: Row[]) => {
    const members = await tx('userGroups as m')
      .join('users as u', 'u.id', 'm.userId')
      .where('m.groupId', row.id)
      .orderBy('u.id')
      .select('u.id', 'u.authVersion', 'u.adminRevision')
    return hash([row, members, groups.map(g => [g.id, g.adminRevision, g.permissions, g.isSystem])])
  }
  const keyCounts = async (tx: Database) => {
    const rows = await tx('apiKeys').select('key', 'isRevoked', 'expiration'),
      counts = new Map<number, number>()
    for (const row of rows) {
      const id = describeApiKeyGrant(row.key).groupId
      if (id !== null && !row.isRevoked && new Date(row.expiration).getTime() > Date.now()) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }
  const summary = (row: Row, memberCount: number, apiKeyCount: number): GroupRecord => ({
    id: row.id,
    name: row.name,
    description: row.description,
    redirectOnLogin: row.redirectOnLogin || '/',
    permissions: row.permissions,
    pageRules: row.pageRules,
    isSystem: row.isSystem,
    memberCount,
    apiKeyCount,
    updatedAt: date(row.updatedAt)
  })
  const dependencies = async (tx: Database, id: number) => {
    const providers = await tx('authentication').select('autoEnrollGroups'),
      navigation = await tx('navigation').select('config'),
      providerGrants = await tx('agentProviderGrants').where('groupId', id).count('* as count').first(),
      skillGrants = await tx('agentSkillGrants').where('groupId', id).count('* as count').first()
    const enrolls = (value: unknown): boolean =>
      Array.isArray(value) ? value.includes(id) : value && typeof value === 'object' ? enrolls(Reflect.get(value, 'v')) : false
    const references = (value: unknown): number =>
      Array.isArray(value)
        ? value.reduce((count, child) => count + references(child), 0)
        : value && typeof value === 'object'
          ? (enrolls(Reflect.get(value, 'visibilityGroups')) ? 1 : 0) +
            Object.entries(value)
              .filter(([key]) => key !== 'visibilityGroups')
              .reduce((count, [, child]) => count + references(child), 0)
          : 0
    return {
      authentication: providers.filter(p => enrolls(p.autoEnrollGroups)).length,
      navigation: navigation.reduce((count, row) => count + references(row.config), 0),
      agentProviders: Number(providerGrants?.count ?? 0),
      agentSkills: Number(skillGrants?.count ?? 0)
    }
  }
  const inspect = async (tx: Database, requester: PagePrincipal, id: number, membersOnly = false): Promise<GroupWorkspace> => {
    const groups = await allGroups(tx),
      actor = await authority(tx, requester, groups, membersOnly),
      row = groups.find(g => g.id === idValue(id))
    if (!row) return fail('This group no longer exists.', 404)
    const members = await groupMembers(tx, id),
      counts = await keyCounts(tx),
      history = await tx('groupAdministrationEvents').where('groupId', id).orderBy('id', 'desc').limit(50)
    return {
      ...summary(row, members.length, counts.get(id) ?? 0),
      fingerprint: await fingerprint(tx, row, groups),
      dependencies: await dependencies(tx, id),
      capabilities: capabilities(row, actor),
      allowedPermissions: groupPermissions.filter(p => groupAuthorityAllows(actor.permissions, [p.key])).map(p => p.key),
      history: history.map(h => ({ id: h.id, action: h.action, reason: h.reason, actorId: h.actorId, details: h.details, createdAt: date(h.createdAt) }))
    }
  }
  const pagination = (input: Record<string, unknown>) => {
    const limit = Number(input.limit ?? 25),
      offset = Number(input.offset ?? 0),
      search = textValue(input.search ?? '', 'Search', 0, 200)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      return fail('Choose valid pagination.')
    return { limit, offset, search }
  }
  const read = async <T>(work: (tx: Knex.Transaction) => Promise<T>): Promise<T> => {
    const tx = await db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const result = await work(tx)
      await tx.commit()
      return result
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }
  const mutate = async (
    requester: PagePrincipal,
    id: number,
    input: Record<string, unknown>,
    operation: (
      tx: Knex.Transaction,
      row: Row,
      actor: Actor,
      groups: Row[],
      members: number[]
    ) => Promise<{ action: string; details: Record<string, unknown>; ended: number[]; deleted?: boolean }>
  ): Promise<GroupWriteResult> => {
    idValue(id)
    const reason = textValue(input.reason, 'Administrative reason', 3, 1000)
    if (typeof input.fingerprint !== 'string') return fail('Load the saved group before reviewing changes.')
    const changed = await db.transaction(async tx => {
      const groups = await allGroups(tx, true),
        row = groups.find(g => g.id === id)
      if (!row) return fail('This group no longer exists.', 404)
      const members = (await groupMembers(tx, id)).map(m => m.userId),
        extra = Array.isArray(input.userIds) ? input.userIds.map(idValue) : [],
        actorId = principalId(requester)
      if (extra.length > 100) return fail('Change at most 100 memberships at a time.')
      const lockIds = [...new Set([...members, ...extra, ...(actorId === null ? [] : [actorId])])].sort((a, b) => a - b)
      if (lockIds.length) await tx('users').whereIn('id', lockIds).orderBy('id').forUpdate().select('id')
      const actor = await authority(tx, requester, groups, true)
      if (input.fingerprint !== (await fingerprint(tx, row, groups))) return fail('This group or its membership changed. Reload before saving.', 409)
      const result = await operation(tx, row, actor, groups, members),
        now = new Date(),
        revision = randomUUID()
      if (!result.deleted) await tx('groups').where('id', id).update({ adminRevision: revision, updatedAt: now.toISOString() })
      if (result.ended.length)
        await tx('users')
          .whereIn('id', result.ended)
          .update({ authVersion: tx.raw('?? + 1', ['authVersion']), sessionsRevokedAt: now, adminRevision: revision })
      await tx('groupAdministrationEvents').insert({
        groupId: id,
        actorId: actor.id,
        action: result.action,
        reason,
        details: JSON.stringify({ ...result.details, sessionsEnded: result.ended.length }),
        createdAt: now
      })
      if (result.ended.length && !['members-added', 'members-removed'].includes(result.action))
        await tx('userAdministrationEvents').insert(
          result.ended.map(userId => ({
            userId,
            actorId: actor.id,
            action: result.deleted ? 'group-deleted' : 'group-policy-updated',
            reason,
            details: JSON.stringify({ groupId: id, sessionsEnded: true }),
            createdAt: now
          }))
        )
      return { id, ended: result.ended, currentSessionEnded: actor.id !== null && result.ended.includes(actor.id) }
    })
    await onCommitted?.(id, changed.ended)
    return { id, sessionsEnded: changed.ended.length, currentSessionEnded: changed.currentSessionEnded }
  }
  return {
    async creationOptions(requester: PagePrincipal) {
      return read(async db => {
        const groups = await allGroups(db),
          actor = await authority(db, requester, groups)
        return {
          fingerprint: hash(groups.map(g => [g.id, g.adminRevision, g.permissions])),
          allowedPermissions: groupPermissions.filter(p => groupAuthorityAllows(actor.permissions, [p.key])).map(p => p.key)
        }
      })
    },
    async create(requester: PagePrincipal, input: Record<string, unknown>): Promise<GroupWriteResult> {
      const policy = normalizeGroupPolicy(input.policy),
        reason = textValue(input.reason, 'Administrative reason', 3, 1000)
      const id = await db.transaction(async tx => {
        const groups = await allGroups(tx, true),
          actorId = principalId(requester)
        if (actorId !== null) await tx('users').where('id', actorId).forUpdate().first('id')
        const actor = await authority(tx, requester, groups)
        if (input.fingerprint !== hash(groups.map(g => [g.id, g.adminRevision, g.permissions])))
          return fail('Group creation policy changed. Reload creation options.', 409)
        if (!groupAuthorityAllows(actor.permissions, policy.permissions)) return fail('The proposed permissions exceed your authority.', 403)
        if (groups.some(g => g.name.toLocaleLowerCase() === policy.name.toLocaleLowerCase())) return fail('A group with this name already exists.', 409)
        const now = new Date().toISOString(),
          [created] = await tx('groups')
            .insert({
              ...policy,
              permissions: JSON.stringify(policy.permissions),
              pageRules: JSON.stringify(policy.pageRules),
              isSystem: false,
              adminRevision: randomUUID(),
              createdAt: now,
              updatedAt: now
            })
            .returning('id')
        await tx('groupAdministrationEvents').insert({
          groupId: created.id,
          actorId: actor.id,
          action: 'group-created',
          reason,
          details: JSON.stringify({ permissions: policy.permissions, ruleCount: policy.pageRules.length }),
          createdAt: now
        })
        return Number(created.id)
      })
      await onCommitted?.(id, [])
      return { id, sessionsEnded: 0, currentSessionEnded: false }
    },
    async savePolicy(requester: PagePrincipal, id: number, input: Record<string, unknown>) {
      return mutate(requester, id, input, async (tx, row, actor, groups, members) => {
        const policy = normalizeGroupPolicy(input.policy, row.permissions),
          allowed = capabilities(row, actor)
        if (!allowed.edit || !groupAuthorityAllows(actor.permissions, policy.permissions)) return fail('You cannot change this group’s policy.', 403)
        if (!allowed.rename && policy.name !== row.name) return fail('This group’s name is protected.', 403)
        if (!allowed.permissions && JSON.stringify(policy.permissions) !== JSON.stringify([...row.permissions].sort()))
          return fail('The Administrators group permissions are protected.', 403)
        if (groups.some(g => g.id !== id && g.name.toLocaleLowerCase() === policy.name.toLocaleLowerCase()))
          return fail('A group with this name already exists.', 409)
        const fields = (Object.keys(policy) as Array<keyof GroupPolicyDraft>).filter(
          key =>
            stable(policy[key]) !==
            stable(
              key === 'permissions'
                ? [...row.permissions].sort()
                : key === 'pageRules'
                  ? row.pageRules.map(rule => ({ ...rule, roles: [...rule.roles].sort(), locales: [...(rule.locales ?? [])].sort() }))
                  : row[key]
            )
        )
        if (!fields.length) return fail('There are no policy changes to save.')
        await tx('groups')
          .where('id', id)
          .update({ ...policy, permissions: JSON.stringify(policy.permissions), pageRules: JSON.stringify(policy.pageRules) })
        return {
          action: 'policy-updated',
          details: {
            fields,
            permissionsAdded: policy.permissions.filter(p => !row.permissions.includes(p)),
            permissionsRemoved: row.permissions.filter(p => !policy.permissions.includes(p)),
            ruleCount: policy.pageRules.length
          },
          ended: fields.some(f => f === 'permissions' || f === 'pageRules') ? members : []
        }
      })
    },
    async changeMembers(requester: PagePrincipal, id: number, input: Record<string, unknown>) {
      if (
        !['add', 'remove'].includes(String(input.action)) ||
        !Array.isArray(input.userIds) ||
        !input.userIds.length ||
        input.userIds.length > 100 ||
        new Set(input.userIds).size !== input.userIds.length
      )
        return fail('Choose 1–100 unique accounts and a membership action.')
      const ids = input.userIds.map(idValue)
      return mutate(requester, id, input, async (tx, row, actor, groups, members) => {
        if (!capabilities(row, actor).members) return fail('You cannot change this group’s membership.', 403)
        if (ids.includes(2) || (actor.id !== null && ids.includes(actor.id)) || (input.action === 'remove' && id === 1 && ids.includes(1)))
          return fail('Guest, your own membership and the primary administrator membership are protected.', 403)
        const users = await tx<Account>('users').whereIn('id', ids).select('*')
        if (users.length !== ids.length) return fail('One or more accounts no longer exist.', 409)
        const relations = await tx<{ userId: number; groupId: number }>('userGroups').whereIn('userId', ids).select('userId', 'groupId')
        if (
          users.some(
            user =>
              ((user.isSystem || user.id === 1) && !actor.permissions.includes('manage:system')) ||
              !groupAuthorityAllows(
                actor.permissions,
                groups.filter(g => relations.some(r => r.userId === user.id && r.groupId === g.id)).flatMap(g => g.permissions)
              )
          )
        )
          return fail('One or more accounts have authority outside your administrative scope.', 403)
        if (ids.some(userId => (input.action === 'add' ? members.includes(userId) : !members.includes(userId))))
          return fail('Membership changed. Reload the group before continuing.', 409)
        if (input.action === 'add') await tx('userGroups').insert(ids.map(userId => ({ userId, groupId: id })))
        else await tx('userGroups').where('groupId', id).whereIn('userId', ids).delete()
        for (const userId of ids)
          await tx('userAdministrationEvents').insert({
            userId,
            actorId: actor.id,
            action: 'membership-updated',
            reason: textValue(input.reason, 'Administrative reason', 3, 1000),
            details: JSON.stringify({ groupId: id, action: input.action, sessionsEnded: true }),
            createdAt: new Date()
          })
        return { action: input.action === 'add' ? 'members-added' : 'members-removed', details: { userIds: ids }, ended: ids }
      })
    },
    async remove(requester: PagePrincipal, id: number, input: Record<string, unknown>) {
      return mutate(requester, id, input, async (tx, row, actor, _groups, members) => {
        if (!capabilities(row, actor).delete) return fail('This group cannot be deleted.', 403)
        const uses = await dependencies(tx, id),
          keys = (await keyCounts(tx)).get(id) ?? 0
        if (Object.values(uses).some(Boolean) || keys)
          return fail('Resolve this group’s active credentials, enrollment, navigation and agent grants before deleting it.', 409)
        await tx('groups').where('id', id).delete()
        return { action: 'group-deleted', details: { name: row.name, memberIds: members }, ended: members, deleted: true }
      })
    },
    inspectForMembership: (requester: PagePrincipal, id: number) => read(tx => inspect(tx, requester, id, true)),
    inspect: (requester: PagePrincipal, id: number) => read(tx => inspect(tx, requester, id)),
    async list(requester: PagePrincipal, input: Record<string, unknown>): Promise<GroupDirectory> {
      return read(async db => {
        const groups = await allGroups(db),
          actor = await authority(db, requester, groups),
          { limit, offset, search } = pagination(input),
          kind = input.kind ?? 'all'
        if (!['all', 'system', 'custom', 'empty', 'administrative'].includes(String(kind))) return fail('Choose a valid group filter.')
        const members = await db('userGroups').select('groupId').count('* as count').groupBy('groupId'),
          counts = await keyCounts(db)
        const all = groups
          .map(row => summary(row, Number(members.find(m => m.groupId === row.id)?.count ?? 0), counts.get(row.id) ?? 0))
          .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id)
        const selected = all.filter(
          g =>
            (!search || `${g.name} ${g.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) &&
            (kind === 'all' ||
              (kind === 'system' && g.isSystem) ||
              (kind === 'custom' && !g.isSystem) ||
              (kind === 'empty' && !g.memberCount) ||
              (kind === 'administrative' && g.permissions.some(administrative)))
        )
        return {
          items: selected.slice(offset, offset + limit).map(({ pageRules, redirectOnLogin: _redirect, ...row }) => ({ ...row, ruleCount: pageRules.length })),
          total: selected.length,
          limit,
          offset,
          counts: {
            groups: all.length,
            system: all.filter(g => g.isSystem).length,
            empty: all.filter(g => !g.memberCount).length,
            administrative: all.filter(g => g.permissions.some(administrative)).length
          },
          canCreate: actor.permissions.some(p => ['write:groups', 'manage:groups', 'manage:system'].includes(p))
        }
      })
    },
    async members(requester: PagePrincipal, id: number, input: Record<string, unknown>): Promise<GroupMembers> {
      return read(async db => {
        const groups = await allGroups(db),
          actor = await authority(db, requester, groups, true),
          row = groups.find(g => g.id === idValue(id))
        if (!row) return fail('This group no longer exists.', 404)
        const { limit, offset, search } = pagination(input),
          candidates = input.candidates === 'true',
          relation = db('userGroups').select('userId').where('groupId', id),
          q = db<Account>('users').select('id', 'name', 'email', 'isActive', 'isSystem')
        if (candidates) q.whereNot('id', 2).whereNotIn('id', relation)
        else q.whereIn('id', relation)
        if (search) {
          const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`
          q.where(b => b.whereILike('name', pattern).orWhereILike('email', pattern))
        }
        const count = await q.clone().clearSelect().count<{ count: string }[]>('* as count').first(),
          items = await q.orderByRaw('LOWER(??)', ['name']).orderBy('id').limit(limit).offset(offset)
        const otherMemberships = items.length
          ? await db<{ userId: number; groupId: number }>('userGroups')
              .whereIn(
                'userId',
                items.map(u => u.id)
              )
              .select('userId', 'groupId')
          : []
        return {
          items: items.map(user => ({
            id: user.id,
            name: user.name,
            email: user.email,
            isActive: user.isActive,
            canRemove:
              capabilities(row, actor).members &&
              user.id !== 2 &&
              user.id !== actor.id &&
              !(id === 1 && user.id === 1) &&
              (!(user.id === 1 || user.isSystem) || actor.permissions.includes('manage:system')) &&
              groupAuthorityAllows(
                actor.permissions,
                groups.filter(g => otherMemberships.some(m => m.userId === user.id && m.groupId === g.id)).flatMap(g => g.permissions)
              )
          })),
          total: Number(count?.count ?? 0),
          limit,
          offset
        }
      })
    },
    async evaluate(requester: PagePrincipal, id: number, value: Record<string, unknown>): Promise<GroupAccessResult> {
      return read(async db => {
        const workspace = await inspect(db, requester, id),
          groups = await allGroups(db),
          selected = groups.find(g => g.id === id)!,
          permission = String(value.permission),
          path = textValue(value.path, 'Page path', 0, 500),
          locale = textValue(value.locale ?? '', 'Language code', 0, 24),
          tags = strings(value.tags ?? [])
        if (!groupPermissions.some(p => p.key === permission && p.pageScoped) || tags.some(t => t.length > 255))
          return fail('Choose a page action and valid tags.')
        let evaluated = [selected],
          subject = selected.name
        if (value.memberId !== undefined) {
          const memberId = idValue(value.memberId),
            membership = await db<{ groupId: number }>('userGroups').where('userId', memberId).select('groupId')
          if (!membership.some(m => m.groupId === id)) return fail('Choose a current member of this group.')
          evaluated = groups.filter(g => membership.some(m => m.groupId === g.id))
          const member = await db<Account>('users').where('id', memberId).first()
          if (!member?.isActive) return fail('This member cannot sign in while inactive.')
          subject = member.name
        }
        if (value.draft !== undefined) {
          if (!workspace.capabilities.edit) return fail('You cannot preview changes to this group.', 403)
          const draft = normalizeGroupPolicy(value.draft, selected.permissions)
          if (!draft.permissions.every(p => workspace.allowedPermissions.includes(p) || selected.permissions.includes(p)))
            return fail('The proposed permissions exceed your authority.', 403)
          evaluated = evaluated.map(g => (g.id === id ? { ...g, ...draft } : g))
        }
        const permissions = [...new Set(evaluated.flatMap(g => g.permissions))],
          aliases = tagAliasMap(await db('tags').select('id', 'tag', 'redirectToId', 'isArchived')),
          result = evaluateGroupAccess(permissions, [permission], evaluated, { path, locale, tags: tags.map(tag => ({ tag })) }, aliases)
        return {
          ...result,
          scope: value.memberId === undefined ? 'group' : 'member',
          source: value.draft === undefined ? 'saved' : 'draft',
          subject,
          globalPermissions: permissions.sort(),
          ruleCount: result.rules.length,
          rulesTruncated: result.rules.length > 200,
          rules: result.rules
            .toSorted(
              (a, b) => (a.outcome === 'winner' ? 0 : a.outcome === 'overridden' ? 1 : 2) - (b.outcome === 'winner' ? 0 : b.outcome === 'overridden' ? 1 : 2)
            )
            .slice(0, 200),
          fingerprint: workspace.fingerprint
        }
      })
    }
  }
}

export const getGroupAdministrationStore = () => {
  const wiki = WIKI as unknown as {
    models: { knex: Knex }
    auth: { reloadGroups(): Promise<void>; revokeUserTokens(input: { id: number; kind: 'u' | 'g' }): void }
    events: { outbound: { emit(event: string, payload?: unknown): void } }
    logger: { warn(message: string): void }
  }
  return createGroupAdministrationStore({
    db: wiki.models.knex,
    onCommitted: async (id, members) => {
      // State and history have already committed. Notification trouble must not
      // present a successful write as retryable or erase its recorded outcome.
      const deliver = async (work: () => unknown) => {
        try {
          await work()
        } catch {
          wiki.logger.warn(`Group ${id} committed; an authorization notification could not be delivered.`)
        }
      }
      // Each delivery is independent: a cache read failure must not skip peer
      // refreshes or revocation notifications for the affected accounts.
      await deliver(() => wiki.events.outbound.emit('reloadGroups'))
      await deliver(() => wiki.auth.reloadGroups())
      for (const userId of members) {
        await deliver(() => wiki.auth.revokeUserTokens({ id: userId, kind: 'u' }))
        await deliver(() => wiki.events.outbound.emit('addAuthRevoke', { id: userId, kind: 'u' }))
      }
    }
  })
}
