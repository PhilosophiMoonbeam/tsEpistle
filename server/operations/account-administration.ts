import { assertSavedPassword } from '../helpers/password-policy.ts'
import { newPasswordIssue } from '../../shared/security-policy.ts'
import { createHash, randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs-then'
import type { Knex } from 'knex'
import {
  accountProfileIssues,
  type AccountAction,
  type AccountCreationOptions,
  type AccountDirectory,
  type AccountProfileDraft,
  type AccountProvider,
  type AccountRecord,
  type AccountWorkspace
} from '../../shared/account-policy.ts'
import { principalId, type PagePrincipal } from '../helpers/page-access.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import errors from './errors.ts'

const { ApplicationError } = errors
type Database = Knex | Knex.Transaction
interface AccountRow {
  id: number
  name: string
  email: string
  handle: string | null
  providerKey: string
  isSystem: boolean
  isActive: boolean
  isVerified: boolean
  tfaIsActive: boolean
  tfaSecret: string | null
  mustChangePwd: boolean
  authVersion: number
  adminRevision: string
  location: string
  jobTitle: string
  timezone: string
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
  sessionsRevokedAt: Date | null
}
interface GroupRow {
  id: number
  name: string
  permissions: string[]
  isSystem: boolean
}
interface ProviderRow {
  key: string
  displayName: string
  strategyKey: string
  isEnabled: boolean
}
interface Dependencies {
  db: Knex
  definitions: () => Array<{ key: string; useForm?: boolean }>
  enforceTwoFactor: () => boolean
  onCommitted?: (id: number) => void
}
interface Authority {
  actorId: number | null
  permissions: string[]
}
const fail = (message: string, status = 400): never => {
  throw new ApplicationError(message, { status })
}
const validId = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : fail('Choose a valid account or group.')
const date = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value ?? ''))
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
const administrativeResources = new Set(['users', 'groups', 'navigation', 'theme', 'api', 'system'])
const canManageGroup = (permissions: string[], group: GroupRow): boolean => {
  if (permissions.includes('manage:system')) return true
  if (group.permissions.some(p => p.endsWith(':system') || p === 'write:scripts')) return false
  return permissions.includes('manage:groups') || !group.permissions.some(p => administrativeResources.has(p.split(':').at(-1) ?? ''))
}
const reasonValue = (value: unknown): string =>
  typeof value === 'string' && value.trim().length >= 3 && value.trim().length <= 1000
    ? value.trim()
    : fail('Add an administrative reason of 3–1,000 characters.')
const profileValue = (value: unknown): AccountProfileDraft => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Enter account profile details.')
  const v = value as Record<string, unknown>
  if (['name', 'email', 'location', 'jobTitle', 'timezone'].some(key => typeof v[key] !== 'string') || !Array.isArray(v.groups))
    return fail('Enter valid profile details and groups.')
  const profile: AccountProfileDraft = {
    name: String(v.name).trim(),
    email: String(v.email).trim().toLowerCase(),
    location: String(v.location).trim(),
    jobTitle: String(v.jobTitle).trim(),
    timezone: String(v.timezone),
    groups: v.groups as number[]
  }
  const issues = accountProfileIssues(profile)
  if (issues.length) return fail(issues.join(' '))
  return { ...profile, groups: [...profile.groups].sort((a, b) => a - b) }
}

export const createAccountAdministrationStore = ({ db, definitions, enforceTwoFactor, onCommitted }: Dependencies) => {
  const providers = async (tx: Database): Promise<AccountProvider[]> => {
    const query = tx<ProviderRow>('authentication').select('key', 'displayName', 'strategyKey', 'isEnabled').orderBy('order').orderBy('key')
    return (await (tx.isTransaction ? query.forShare() : query)).map(row => {
      const definition = definitions().find(item => item.key === row.strategyKey)
      return {
        key: row.key,
        title: row.displayName || row.strategyKey,
        strategy: row.strategyKey,
        enabled: row.isEnabled,
        available: Boolean(definition),
        localPassword: row.key === 'local',
        supportsTwoFactor: definition?.useForm === true
      }
    })
  }
  const groups = async (tx: Database, lock = false): Promise<GroupRow[]> => {
    const query = tx<GroupRow>('groups').select('id', 'name', 'permissions', 'isSystem').orderBy('id')
    return (await (lock ? query.forShare() : query)).map(row => ({ ...row, permissions: strings(row.permissions) }))
  }
  const memberships = async (tx: Database, id: number, available: GroupRow[]) => {
    const relations = await tx<{ groupId: number }>('userGroups').where('userId', id).select('groupId')
    const ids = new Set(relations.map(row => row.groupId))
    return available.filter(row => ids.has(row.id))
  }
  const authority = async (tx: Database, requester: PagePrincipal, available: GroupRow[], lockedRows?: AccountRow[], creating = false): Promise<Authority> => {
    if (!requester) return fail('An administrator sign-in is required.', 403)
    const actorId = principalId(requester)
    let permissions: string[]
    if (actorId !== null) {
      const actor = lockedRows?.find(row => row.id === actorId) ?? (await tx<AccountRow>('users').where('id', actorId).first())
      if (!accountSessionIsCurrent({ id: actorId, authVersion: Reflect.get(requester, 'authVersion') }, actor))
        return fail('Your account session changed. Sign in again.', 403)
      permissions = [...new Set((await memberships(tx, actorId, available)).flatMap(group => group.permissions))]
    } else {
      // API principals carry no ownership identity. Their current group, rather
      // than the compatibility id of 1, determines authority and audit identity.
      const ids = Array.isArray(requester.groups) ? requester.groups : []
      if (requester.ownershipUserId !== null || requester.id !== 1 || ids.length !== 1 || typeof ids[0] !== 'number')
        return fail('An administrator principal is required.', 403)
      permissions = available.find(group => group.id === ids[0])?.permissions ?? []
    }
    if (!permissions.some(p => ['manage:users', 'manage:system', ...(creating ? ['write:users'] : [])].includes(p)))
      return fail('Account administration permission is required.', 403)
    return { actorId, permissions }
  }
  const profile = (row: AccountRow, membership: GroupRow[]): AccountProfileDraft => ({
    name: row.name,
    email: row.email,
    location: row.location ?? '',
    jobTitle: row.jobTitle ?? '',
    timezone: row.timezone,
    groups: membership.map(group => group.id)
  })
  const record = (row: AccountRow, membership: GroupRow[], provider?: AccountProvider): AccountRecord => ({
    id: row.id,
    name: row.name,
    email: row.email,
    providerKey: row.providerKey,
    providerTitle: provider?.title ?? row.providerKey,
    isSystem: row.isSystem,
    isActive: row.isActive,
    isVerified: row.isVerified,
    twoFactor: !provider?.supportsTwoFactor
      ? 'provider-managed'
      : row.tfaIsActive && row.tfaSecret
        ? 'enrolled'
        : row.tfaIsActive || enforceTwoFactor()
          ? 'enrollment-required'
          : 'off',
    createdAt: date(row.createdAt),
    updatedAt: date(row.updatedAt),
    lastLoginAt: row.lastLoginAt ? date(row.lastLoginAt) : null,
    groups: membership.map(({ id, name }) => ({ id, name }))
  })
  const fingerprint = (row: AccountRow, membership: GroupRow[], available: GroupRow[], identityProviders: AccountProvider[]) =>
    hash([
      row.id,
      row.adminRevision,
      row.authVersion,
      row.updatedAt,
      row.handle,
      profile(row, membership),
      row.isSystem,
      row.isActive,
      row.isVerified,
      row.tfaIsActive,
      Boolean(row.tfaSecret),
      row.mustChangePwd,
      available,
      identityProviders,
      enforceTwoFactor()
    ])
  const capabilities = (
    row: AccountRow,
    membership: GroupRow[],
    provider: AccountProvider | undefined,
    actor: Authority,
    privateOwnership: boolean
  ): AccountWorkspace['capabilities'] => {
    const self = actor.actorId === row.id
    const edit =
      row.id !== 2 &&
      membership.every(group => canManageGroup(actor.permissions, group)) &&
      (!(row.isSystem || row.id === 1) || actor.permissions.includes('manage:system'))
    const actions: AccountAction[] = []
    if (edit) {
      if (!row.isActive) actions.push('activate')
      if (row.isActive && !self && !row.isSystem && row.id > 2) actions.push('deactivate')
      if (!row.isVerified) actions.push('verify')
      if (row.isActive) actions.push('end-sessions')
      if (provider?.supportsTwoFactor) {
        if (!row.tfaIsActive) actions.push('require-2fa')
        if (row.tfaIsActive && row.tfaSecret) actions.push('reset-2fa')
        if (row.tfaIsActive && !enforceTwoFactor()) actions.push('disable-2fa')
      }
    }
    return {
      edit,
      password: edit && provider?.localPassword === true && !self,
      delete: edit && !self && row.id > 2 && !row.isSystem && !privateOwnership,
      actions,
      explanation:
        row.id === 2
          ? 'The Guest account represents anonymous readers. Manage its access in Groups.'
          : !edit
            ? 'This account has authority outside your administrative scope.'
            : self
              ? 'This is your account. Use your profile to change your password; deactivation and deletion are unavailable here.'
              : row.isSystem
                ? 'This system account cannot be deactivated or deleted.'
                : privateOwnership
                  ? 'Private pages or private page history still belong to this account. Resolve ownership before deletion.'
                  : ''
    }
  }
  const inspect = async (
    tx: Database,
    requester: PagePrincipal,
    id: number,
    available?: GroupRow[],
    identityProviders?: AccountProvider[],
    actor?: Authority
  ): Promise<AccountWorkspace> => {
    validId(id)
    const allGroups = available ?? (await groups(tx)),
      allProviders = identityProviders ?? (await providers(tx)),
      access = actor ?? (await authority(tx, requester, allGroups))
    const row = await tx<AccountRow>('users').where('id', id).first()
    if (!row) return fail('Account not found.', 404)
    const membership = await memberships(tx, id, allGroups),
      provider = allProviders.find(item => item.key === row.providerKey)
    const privatePage = await tx('pages').where({ ownerId: id, visibility: 'private' }).first('id')
    const privateHistory = await tx('pageHistory').where({ ownerId: id, visibility: 'private' }).first('id')
    const pagesCreated = await tx('pages').where('creatorId', id).count('* as count').first()
    const pagesAuthored = await tx('pages').where('authorId', id).count('* as count').first()
    const comments = await tx('comments').where('authorId', id).count('* as count').first()
    const assets = await tx('assets').where('authorId', id).count('* as count').first()
    const history = await tx('userAdministrationEvents')
      .where('userId', id)
      .orderBy('id', 'desc')
      .limit(50)
      .select('id', 'action', 'reason', 'details', 'actorId', 'createdAt')
    const privateOwnership = Boolean(privatePage || privateHistory)
    return {
      ...record(row, membership, provider),
      profile: profile(row, membership),
      provider: provider ?? null,
      fingerprint: fingerprint(row, membership, allGroups, allProviders),
      availableGroups: allGroups.map(group => ({ ...group, canAssign: canManageGroup(access.permissions, group) })),
      permissions: [...new Set(membership.flatMap(group => group.permissions))].sort(),
      mustChangePassword: row.mustChangePwd,
      sessionsRevokedAt: row.sessionsRevokedAt ? date(row.sessionsRevokedAt) : null,
      privateOwnershipBlocksDeletion: privateOwnership,
      contributionCounts: {
        pagesCreated: Number(pagesCreated?.count ?? 0),
        pagesAuthored: Number(pagesAuthored?.count ?? 0),
        comments: Number(comments?.count ?? 0),
        assets: Number(assets?.count ?? 0)
      },
      capabilities: capabilities(row, membership, provider, access, privateOwnership),
      history: history.map(event => ({
        id: Number(event.id),
        action: String(event.action),
        reason: String(event.reason),
        details: event.details as Record<string, unknown>,
        actorId: event.actorId === null ? null : Number(event.actorId),
        createdAt: date(event.createdAt)
      }))
    }
  }
  const mutate = async (
    requester: PagePrincipal,
    id: number,
    input: Record<string, unknown>,
    operation: (
      tx: Knex.Transaction,
      row: AccountRow,
      workspace: AccountWorkspace,
      actor: Authority
    ) => Promise<{ action: string; details: Record<string, unknown>; deleted?: true }>
  ): Promise<AccountWorkspace> => {
    validId(id)
    const reason = reasonValue(input.reason)
    if (typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)) return fail('Load the current account before reviewing changes.')
    const result = await db.transaction(async tx => {
      // Group policy is stable before taking account locks; membership writers
      // follow the same group → account order. Lock actor/subject by id so two
      // administrators editing each other cannot invert the account lock order.
      const allGroups = await groups(tx, true),
        allProviders = await providers(tx)
      const replacementId = input.replaceId === undefined ? null : validId(input.replaceId)
      const ids = [...new Set([id, principalId(requester), replacementId].filter((value): value is number => value !== null))].sort((a, b) => a - b)
      const locked = await tx<AccountRow>('users').whereIn('id', ids).orderBy('id').forUpdate()
      const actor = await authority(tx, requester, allGroups, locked),
        row = locked.find(item => item.id === id)
      if (!row) return fail('Account not found.', 404)
      const workspace = await inspect(tx, requester, id, allGroups, allProviders, actor)
      if (input.fingerprint !== workspace.fingerprint) return fail('This account or its access policy changed. Reload it before saving.', 409)
      const event = await operation(tx, row, workspace, actor),
        now = new Date()
      await tx('users').where('id', id).update({ adminRevision: randomUUID(), updatedAt: now.toISOString() })
      await tx('userAdministrationEvents').insert({
        userId: id,
        actorId: actor.actorId,
        reason,
        action: event.action,
        details: JSON.stringify(event.details),
        createdAt: now
      })
      return event.deleted ? workspace : inspect(tx, requester, id, allGroups, allProviders, actor)
    })
    onCommitted?.(id)
    return result
  }
  const endSessions = async (tx: Knex.Transaction, row: AccountRow) => {
    if (!Number.isSafeInteger(row.authVersion) || row.authVersion < 0 || row.authVersion >= 2147483647)
      return fail('The account session version cannot be advanced.', 409)
    await tx('users')
      .where('id', row.id)
      .update({ authVersion: row.authVersion + 1, sessionsRevokedAt: new Date() })
  }
  const creationOptions = (allGroups: GroupRow[], allProviders: AccountProvider[], actor: Authority): AccountCreationOptions => ({
    providers: allProviders,
    groups: allGroups.map(group => ({ ...group, canAssign: canManageGroup(actor.permissions, group) })),
    fingerprint: hash([allGroups, allProviders, actor.permissions])
  })
  return {
    async creationOptions(requester: PagePrincipal) {
      const allGroups = await groups(db),
        actor = await authority(db, requester, allGroups, undefined, true)
      return creationOptions(allGroups, await providers(db), actor)
    },
    async create(requester: PagePrincipal, input: Record<string, unknown>) {
      const next = profileValue(input.profile),
        reason = reasonValue(input.reason)
      if (typeof input.providerKey !== 'string' || typeof input.isVerified !== 'boolean' || typeof input.mustChangePassword !== 'boolean')
        return fail('Choose a sign-in provider and account verification settings.')
      const local = input.providerKey === 'local'
      if (local && newPasswordIssue(input.password)) return fail(newPasswordIssue(input.password)!)
      if (!local && input.password !== undefined && input.password !== '') return fail('Passwords for this account belong to its identity provider.')
      const password = local ? await bcrypt.hash(String(input.password), 12) : null
      return db.transaction(async tx => {
        const allGroups = await groups(tx, true),
          allProviders = await providers(tx)
        const actorId = principalId(requester),
          locked = actorId ? await tx<AccountRow>('users').where('id', actorId).forUpdate() : []
        const actor = await authority(tx, requester, allGroups, locked, true)
        if (input.fingerprint !== creationOptions(allGroups, allProviders, actor).fingerprint)
          return fail('The available groups or sign-in providers changed. Reload creation options before saving.', 409)
        const provider = allProviders.find(item => item.key === input.providerKey)
        if (!provider?.available || !provider.enabled) return fail('Choose an enabled, installed sign-in provider.')
        if (next.groups.some(groupId => !allGroups.some(group => group.id === groupId && canManageGroup(actor.permissions, group))))
          return fail('A selected group is unavailable or outside your administrative scope.', 403)
        // Normalize before serializing competing creates, including operators
        // with different identities. The database uniqueness constraint remains.
        await tx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`account-create:${provider.key}:${next.email}`])
        if (await tx('users').where('providerKey', provider.key).whereRaw('LOWER(??) = ?', ['email', next.email]).first('id'))
          return fail('This email address already belongs to an account with that provider.', 409)
        if (local) await assertSavedPassword(tx, input.password)
        const now = new Date()
        const [created] = await tx('users')
          .insert({
            providerKey: provider.key,
            name: next.name,
            email: next.email,
            location: next.location,
            jobTitle: next.jobTitle,
            timezone: next.timezone,
            password,
            isActive: true,
            isSystem: false,
            isVerified: input.isVerified,
            tfaIsActive: false,
            mustChangePwd: local && input.mustChangePassword,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            adminRevision: randomUUID()
          })
          .returning('id')
        const id = validId(created?.id)
        if (next.groups.length) await tx('userGroups').insert(next.groups.map(groupId => ({ userId: id, groupId })))
        await tx('userAdministrationEvents').insert({
          userId: id,
          actorId: actor.actorId,
          action: 'account-created',
          reason,
          details: JSON.stringify({
            provider: provider.key,
            groups: next.groups,
            isVerified: input.isVerified,
            mustChangePassword: local && input.mustChangePassword
          }),
          createdAt: now
        })
        // Creation never sends mail implicitly. Delivery is a separate explicit
        // operation, so an SMTP failure cannot make account creation ambiguous.
        return { id }
      })
    },
    async list(requester: PagePrincipal, input: Record<string, unknown>): Promise<AccountDirectory> {
      const allGroups = await groups(db),
        actor = await authority(db, requester, allGroups),
        allProviders = await providers(db)
      const search = typeof input.search === 'string' ? input.search.trim() : '',
        state = input.state ?? 'all',
        verified = input.verified ?? 'all',
        provider = input.provider ?? 'all',
        limit = Number(input.limit ?? 25),
        offset = Number(input.offset ?? 0)
      if (
        search.length > 200 ||
        !['all', 'active', 'inactive'].includes(String(state)) ||
        !['all', 'verified', 'unverified'].includes(String(verified)) ||
        typeof provider !== 'string' ||
        provider.length > 255 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 1000000
      )
        return fail('Choose valid account filters and pagination.')
      const base = db<AccountRow>('users as u')
      if (search) {
        const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`
        base.where(query => query.whereILike('u.name', pattern).orWhereILike('u.email', pattern))
      }
      if (state !== 'all') base.where('u.isActive', state === 'active')
      if (verified !== 'all') base.where('u.isVerified', verified === 'verified')
      if (provider !== 'all') base.where('u.providerKey', provider)
      if (input.group !== undefined && input.group !== 'all' && input.group !== '')
        base.whereIn(
          'u.id',
          db('userGroups')
            .select('userId')
            .where('groupId', validId(Number(input.group)))
        )
      const [count, rows, counts] = await Promise.all([
        base.clone().count<{ count: string }[]>('* as count').first(),
        base.clone().select('u.*').orderByRaw('LOWER(??) ASC', ['u.name']).orderBy('u.id').limit(limit).offset(offset),
        db('users')
          .select(
            db.raw(
              'COUNT(*) AS accounts, COUNT(*) FILTER (WHERE "isActive") AS active, COUNT(*) FILTER (WHERE NOT "isActive") AS inactive, COUNT(*) FILTER (WHERE NOT "isVerified") AS unverified'
            )
          )
          .first()
      ])
      const relations = rows.length
        ? await db<{ userId: number; groupId: number }>('userGroups')
            .whereIn(
              'userId',
              rows.map(row => row.id)
            )
            .select('userId', 'groupId')
        : []
      return {
        items: rows.map(row =>
          record(
            row,
            allGroups.filter(group => relations.some(item => item.userId === row.id && item.groupId === group.id)),
            allProviders.find(item => item.key === row.providerKey)
          )
        ),
        total: Number(count?.count ?? 0),
        limit,
        offset,
        counts: {
          accounts: Number(counts?.accounts ?? 0),
          active: Number(counts?.active ?? 0),
          inactive: Number(counts?.inactive ?? 0),
          unverified: Number(counts?.unverified ?? 0)
        },
        providers: allProviders,
        groups: allGroups.map(({ id, name }) => ({ id, name })),
        canCreate: actor.permissions.some(p => ['manage:users', 'manage:system'].includes(p))
      }
    },
    async inspect(requester: PagePrincipal, id: number) {
      return inspect(db, requester, id)
    },
    async prepareWelcome(requester: PagePrincipal, id: number, input: Record<string, unknown>) {
      const requestId = randomUUID()
      const workspace = await mutate(requester, id, input, async (_tx, _row, workspace) => {
        if (!workspace.capabilities.edit || !workspace.isActive) return fail('Welcome email is unavailable for this account.', 403)
        return { action: 'welcome-email-requested', details: { requestId } }
      })
      return { requestId, email: workspace.email }
    },
    async finishWelcome(id: number, requestId: string, accepted: boolean) {
      await db('userAdministrationEvents')
        .where({ userId: id, action: 'welcome-email-requested' })
        .whereRaw("details->>'requestId' = ?", [requestId])
        .update({
          action: accepted ? 'welcome-email-accepted' : 'welcome-email-failed',
          details: JSON.stringify({ requestId, outcomeAt: new Date().toISOString() })
        })
    },
    async remove(requester: PagePrincipal, id: number, input: Record<string, unknown>) {
      const replaceId = validId(input.replaceId)
      if (replaceId === id || replaceId === 2) return fail('Choose another person to receive contribution attribution.')
      await mutate(requester, id, input, async (tx, _row, workspace, actor) => {
        if (!workspace.capabilities.delete) return fail(workspace.capabilities.explanation || 'This account cannot be deleted.', 403)
        const replacement = await tx<AccountRow>('users').where('id', replaceId).first()
        if (!replacement?.isActive) return fail('The replacement account must exist and be active.')
        const replacementGroups = await memberships(tx, replaceId, await groups(tx))
        if (!replacementGroups.every(group => canManageGroup(actor.permissions, group)))
          return fail('The replacement account is outside your administrative scope.', 403)
        // The subject lock excludes new FK-referenced contributions. Private
        // ownership/history is checked while that same lock is held.
        for (const table of ['assets', 'comments', 'pageHistory', 'pages']) await tx(table).where('authorId', id).update({ authorId: replaceId })
        await tx('pages').where('creatorId', id).update({ creatorId: replaceId })
        await tx('userKeys').where('userId', id).delete()
        await tx('users').where('id', id).delete()
        return { action: 'account-deleted', details: { replacementId: replaceId }, deleted: true }
      })
      return { id, deleted: true }
    },
    async updateProfile(requester: PagePrincipal, id: number, input: Record<string, unknown>) {
      const next = profileValue(input.profile)
      const replacingPassword = input.password !== undefined && input.password !== ''
      if (replacingPassword && newPasswordIssue(input.password)) return fail(newPasswordIssue(input.password)!)
      const password = replacingPassword ? await bcrypt.hash(String(input.password), 12) : undefined
      const presentation: Record<string, string> = {}
      if (input.dateFormat !== undefined) {
        if (!['', 'DD/MM/YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'YYYY/MM/DD'].includes(String(input.dateFormat)))
          return fail('Choose a valid date format.')
        presentation.dateFormat = String(input.dateFormat)
      }
      if (input.appearance !== undefined) {
        if (!['', 'light', 'dark', 'system'].includes(String(input.appearance))) return fail('Choose a valid appearance.')
        presentation.appearance = String(input.appearance)
      }
      return mutate(requester, id, input, async (tx, row, workspace, actor) => {
        if (!workspace.capabilities.edit) return fail(workspace.capabilities.explanation, 403)
        if (password) await assertSavedPassword(tx, input.password)
        if (password && !workspace.capabilities.password) return fail('Use the account’s identity provider or your own profile to change this password.', 403)
        if (next.groups.some(groupId => !workspace.availableGroups.some(group => group.id === groupId && group.canAssign)))
          return fail('A selected group is unavailable or outside your administrative scope.', 403)
        if (id === 1 && !next.groups.includes(1)) return fail('The primary administrator must remain in Administrators.', 403)
        if (actor.actorId === id && JSON.stringify(next.groups) !== JSON.stringify(workspace.profile.groups))
          return fail('Ask another administrator to change your group memberships.', 403)
        const changed: string[] = (Object.keys(next) as Array<keyof AccountProfileDraft>).filter(
          key => JSON.stringify(next[key]) !== JSON.stringify(workspace.profile[key])
        )
        for (const [key, value] of Object.entries(presentation)) if (Reflect.get(row, key) !== value) changed.push(key)
        if (password) changed.push('password')
        if (!changed.length) return fail('There are no profile changes to save.')
        if (
          next.email !== row.email &&
          (await tx('users').where('providerKey', row.providerKey).whereRaw('LOWER(??) = ?', ['email', next.email]).whereNot('id', id).first('id'))
        )
          return fail('This email address already belongs to an account with that provider.', 409)
        await tx('users')
          .where('id', id)
          .update({
            name: next.name,
            email: next.email,
            location: next.location,
            jobTitle: next.jobTitle,
            timezone: next.timezone,
            ...presentation,
            ...(password ? { password } : {}),
            ...(next.email !== row.email ? { isVerified: false } : {})
          })
        if (changed.includes('groups')) {
          await tx('userGroups').where('userId', id).whereNotIn('groupId', next.groups).delete()
          const added = next.groups.filter(groupId => !workspace.profile.groups.includes(groupId))
          if (added.length) await tx('userGroups').insert(added.map(groupId => ({ userId: id, groupId })))
        }
        const sessionsEnded = changed.some(key => ['groups', 'email', 'password'].includes(key))
        if (sessionsEnded) await endSessions(tx, row)
        return {
          action: 'profile-updated',
          details: { fields: changed, ...(changed.includes('groups') ? { previousGroups: workspace.profile.groups, groups: next.groups } : {}), sessionsEnded }
        }
      })
    },
    async act(requester: PagePrincipal, id: number, input: Record<string, unknown>) {
      return mutate(requester, id, input, async (tx, row, workspace) => {
        const action = input.action as AccountAction
        if (!workspace.capabilities.actions.includes(action)) return fail('This action is unavailable for the account in its current state.', 403)
        const patch: Record<string, unknown> = {}
        if (action === 'activate') patch.isActive = true
        if (action === 'deactivate') patch.isActive = false
        if (action === 'verify') patch.isVerified = true
        if (action === 'require-2fa') {
          patch.tfaIsActive = true
          patch.tfaSecret = null
        }
        if (action === 'reset-2fa') {
          patch.tfaIsActive = true
          patch.tfaSecret = null
        }
        if (action === 'disable-2fa') {
          patch.tfaIsActive = false
          patch.tfaSecret = null
        }
        if (Object.keys(patch).length) await tx('users').where('id', id).update(patch)
        if (action !== 'verify' && action !== 'activate') await endSessions(tx, row)
        return { action, details: { sessionsEnded: action !== 'verify' && action !== 'activate' } }
      })
    },
    async setPassword(requester: PagePrincipal, id: number, input: Record<string, unknown>) {
      if (newPasswordIssue(input.password)) return fail(newPasswordIssue(input.password)!)
      if (typeof input.mustChangePassword !== 'boolean') return fail('Choose whether the password must be changed at sign-in.')
      const password = await bcrypt.hash(String(input.password), 12)
      return mutate(requester, id, input, async (tx, row, workspace) => {
        if (!workspace.capabilities.password) return fail('Use the account’s identity provider or your own profile to change this password.', 403)
        await assertSavedPassword(tx, input.password)
        await tx('users').where('id', id).update({ password, mustChangePwd: input.mustChangePassword })
        await endSessions(tx, row)
        return { action: 'password-replaced', details: { mustChangePassword: input.mustChangePassword, sessionsEnded: true } }
      })
    }
  }
}

export const accountAdministration = () => {
  const wiki = WIKI as unknown as {
    models: { knex: Knex }
    data: { authentication: Array<{ key: string; useForm?: boolean }> }
    config: { auth: { enforce2FA?: boolean } }
    auth: { revokeUserTokens(input: { id: number; kind: 'u' }): void }
    events: { outbound: { emit(event: string, input: unknown): void } }
    logger: { warn(message: string): void }
  }
  return createAccountAdministrationStore({
    db: wiki.models.knex,
    definitions: () => wiki.data.authentication,
    enforceTwoFactor: () => wiki.config.auth.enforce2FA === true,
    onCommitted(id) {
      try {
        wiki.auth.revokeUserTokens({ id, kind: 'u' })
        wiki.events.outbound.emit('addAuthRevoke', { id, kind: 'u' })
      } catch {
        wiki.logger.warn('Account change committed; live session recheck notification could not be published.')
      }
    }
  })
}
