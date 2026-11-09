import { createHmac, randomUUID } from 'node:crypto'
import { domainToASCII } from 'node:url'
import type { Knex } from 'knex'
import type {
  AuthenticationDefinition,
  AuthenticationProviderDraft,
  AuthenticationRuntime,
  AuthenticationWorkspace,
  AuthenticationWriteResult,
  AuthenticationEvent,
  AuthenticationValue
} from '../../shared/authentication-policy.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { reloadPersonalMcpKeys, revokeOwnerPersonalMcpKeys } from '../helpers/personal-mcp.ts'
import { principalId, type PagePrincipal } from '../helpers/page-access.ts'
import errors from './errors.ts'

type Database = Knex | Knex.Transaction
interface ProviderRow {
  key: string
  strategyKey: string
  displayName: string
  description: string
  isEnabled: boolean
  selfRegistration: boolean
  order: number
  config: Record<string, unknown>
  domainWhitelist: unknown
  autoEnrollGroups: unknown
  adminRevision: string
}
interface GroupRow {
  id: number
  name: string
  permissions: string[]
  adminRevision: string
  isSystem: boolean
}
interface AccountRow {
  id: number
  providerKey: string
  isActive: boolean
  authVersion: number
  adminRevision: string
}
interface Dependencies {
  db: Knex
  reviewKey: string
  definitions: () => AuthenticationDefinition[]
  host: () => string
  runtime?: () => Record<string, AuthenticationRuntime>
  onCommitted?: (ended: number[]) => Promise<boolean>
}
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail('Enter a valid provider configuration.')
const text = (value: unknown, label: string, min = 0, max = 255): string =>
  typeof value === 'string' && value.trim().length >= min && value.trim().length <= max ? value.trim() : fail(`${label} must contain ${min}–${max} characters.`)
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  )
const unwrap = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray(Reflect.get(value, 'v')) ? Reflect.get(value, 'v') : []
const administrative = (group: GroupRow) =>
  group.permissions.some(
    permission => ['users', 'groups', 'navigation', 'theme', 'api', 'system'].includes(permission.split(':').at(-1) ?? '') || permission === 'write:scripts'
  )
const system = (group: GroupRow) =>
  group.id <= 2 || group.isSystem || group.permissions.some(permission => permission.endsWith(':system') || permission === 'write:scripts')
const primitive = (value: unknown): value is AuthenticationValue =>
  value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
export const normalizeAuthenticationDomains = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 100) return fail('Choose at most 100 email domains.')
  return [
    ...new Set(
      value.map(item => {
        const domain = domainToASCII(text(item, 'Email domain', 1, 253).toLowerCase())
        if (!domain || domain.length > 253 || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !domain.includes('.'))
          return fail('Enter exact email domains, without @, URLs or wildcards.')
        return domain
      })
    )
  ].sort()
}

export const createAuthenticationAdministrationStore = ({ db, reviewKey, definitions, host, runtime, onCommitted }: Dependencies) => {
  const groups = (tx: Database, lock = false) => {
    const query = tx<GroupRow>('groups').select('id', 'name', 'permissions', 'adminRevision', 'isSystem').orderBy('id')
    return lock ? query.forUpdate() : query
  }
  const providers = (tx: Database, lock = false) => {
    const query = tx<ProviderRow>('authentication').select('*').orderBy('key')
    return lock ? query.forUpdate() : query
  }
  const accounts = (tx: Database, lock = false) => {
    const query = tx<AccountRow>('users').select('id', 'providerKey', 'isActive', 'authVersion', 'adminRevision').orderBy('id')
    return lock ? query.forUpdate() : query
  }
  const authority = async (tx: Database, requester: PagePrincipal, list: GroupRow[], people: AccountRow[]): Promise<number | null> => {
    if (!requester) return fail('An administrator sign-in is required.', 403)
    const id = principalId(requester)
    let ids: number[]
    if (id !== null) {
      if (
        !accountSessionIsCurrent(
          { id, authVersion: Reflect.get(requester, 'authVersion') },
          people.find(person => person.id === id)
        )
      )
        return fail('Your account session changed. Sign in again.', 403)
      ids = (await tx<{ groupId: number }>('userGroups').where('userId', id).select('groupId')).map(row => row.groupId)
    } else {
      const values = requester.groups
      if (requester.ownershipUserId !== null || requester.id !== 1 || !Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'number')
        return fail('An administrator principal is required.', 403)
      ids = values as number[]
    }
    if (!list.some(group => ids.includes(group.id) && group.permissions.includes('manage:system'))) return fail('Full system administration is required.', 403)
    return id
  }
  const fingerprint = (rows: ProviderRow[], list: GroupRow[], people: AccountRow[]) =>
    createHmac('sha256', reviewKey)
      .update(stable([rows, list, people]))
      .digest('hex')
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
  const inspect = async (tx: Knex.Transaction, requester: PagePrincipal): Promise<AuthenticationWorkspace> => {
    const rows = await providers(tx),
      list = await groups(tx),
      people = await accounts(tx)
    await authority(tx, requester, list, people)
    const catalog = definitions(),
      observed = runtime?.() ?? {},
      history = await tx('authenticationAdministrationEvents').orderBy('id', 'desc').limit(50)
    return {
      fingerprint: fingerprint(rows, list, people),
      host: host(),
      definitions: catalog,
      groups: list
        .filter(group => group.id !== 2)
        .map(group => ({ id: group.id, name: group.name, administrative: administrative(group), system: system(group) })),
      providers: rows
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
        .map(row => {
          const definition = catalog.find(item => item.key === row.strategyKey),
            config: Record<string, AuthenticationValue> = {},
            secrets: AuthenticationProviderDraft['secrets'] = {},
            configuredSecrets: string[] = []
          for (const field of definition?.fields ?? []) {
            if (field.sensitive) {
              secrets[field.key] = { action: 'keep' }
              if (typeof row.config[field.key] === 'string' && row.config[field.key]) configuredSecrets.push(field.key)
            } else {
              const value = row.config[field.key]
              config[field.key] = primitive(value) ? value : field.default
            }
          }
          const status = observed[row.key]
          return {
            key: row.key,
            strategyKey: row.strategyKey,
            displayName: row.displayName,
            description: row.description,
            isEnabled: row.isEnabled,
            selfRegistration: row.selfRegistration,
            domainWhitelist: unwrap(row.domainWhitelist) as string[],
            autoEnrollGroups: unwrap(row.autoEnrollGroups) as number[],
            config,
            secrets,
            configuredSecrets,
            accountCount: people.filter(person => person.providerKey === row.key).length,
            activeAccountCount: people.filter(person => person.providerKey === row.key && person.isActive).length,
            runtime: !row.isEnabled
              ? { state: 'disabled' as const, checkedAt: status?.checkedAt ?? null, revision: row.adminRevision }
              : !definition?.available
                ? { state: 'unavailable' as const, checkedAt: null, revision: row.adminRevision }
                : status?.revision === row.adminRevision
                  ? status
                  : { state: 'pending' as const, checkedAt: null, revision: row.adminRevision }
          }
        }),
      history: history.map(event => ({
        id: event.id,
        actorId: event.actorId,
        reason: event.reason,
        changes: event.changes,
        createdAt: new Date(event.createdAt).toISOString()
      }))
    }
  }
  const normalize = (input: unknown, previous: ProviderRow[], list: GroupRow[]): ProviderRow[] => {
    if (!Array.isArray(input) || input.length < 1 || input.length > 40) return fail('Keep the built-in Local provider and at most 40 sign-in methods.')
    const catalog = definitions(),
      seen = new Set<string>()
    const rows = input.map((value, order) => {
      const draft = object(value),
        key = text(draft.key, 'Provider identifier', 1, 80),
        strategyKey = text(draft.strategyKey, 'Provider type', 1, 80)
      if (!/^[a-zA-Z0-9_-]+$/.test(key) || seen.has(key)) return fail('Provider identifiers must be unique and contain only letters, numbers, _ or -.')
      seen.add(key)
      const current = previous.find(row => row.key === key),
        definition = catalog.find(item => item.key === strategyKey)
      if (current && current.strategyKey !== strategyKey) return fail('A saved provider cannot change its type. Create another sign-in method.')
      if ((!definition?.available && !current) || (!definition?.available && draft.isEnabled)) return fail('This provider is unavailable in this deployment.')
      if (strategyKey === 'local' && key !== 'local') return fail('The built-in Local provider cannot be duplicated.')
      if (typeof draft.isEnabled !== 'boolean' || typeof draft.selfRegistration !== 'boolean') return fail('Choose explicit sign-in and registration states.')
      const displayName = text(draft.displayName, 'Display name', 1),
        description = text(draft.description, 'Purpose', 0, 1000),
        domainWhitelist = normalizeAuthenticationDomains(draft.domainWhitelist)
      if (
        !Array.isArray(draft.autoEnrollGroups) ||
        draft.autoEnrollGroups.length > 100 ||
        !draft.autoEnrollGroups.every(id => Number.isSafeInteger(id) && Number(id) > 0)
      )
        return fail('Choose valid initial groups.')
      const autoEnrollGroups = [...new Set(draft.autoEnrollGroups as number[])].sort((a, b) => a - b)
      if (autoEnrollGroups.some(id => !list.some(group => group.id === id))) return fail('An initial group no longer exists. Reload the policy.', 409)
      if (autoEnrollGroups.some(id => list.some(group => group.id === id && system(group))))
        return fail('System identities and page-script authority cannot be granted through automatic enrollment.')
      const inputConfig = object(draft.config),
        inputSecrets = object(draft.secrets),
        config: Record<string, unknown> = { ...current?.config }
      if (
        Object.keys(inputConfig).some(key => !definition?.fields.some(field => field.key === key && !field.sensitive)) ||
        Object.keys(inputSecrets).some(key => !definition?.fields.some(field => field.key === key && field.sensitive))
      )
        return fail('Configuration contains an unknown field. Reload the provider catalog.')
      for (const field of definition?.fields ?? []) {
        if (field.sensitive) {
          const action = object(inputSecrets[field.key] ?? { action: 'keep' })
          if (action.action === 'keep') config[field.key] = current?.config[field.key] ?? field.default
          else if (action.action === 'clear') config[field.key] = ''
          else if (action.action === 'replace' && typeof action.value === 'string' && action.value.length > 0 && action.value.length <= 65536)
            config[field.key] = action.value
          else return fail(`Choose whether to keep, replace or clear ${field.title}.`)
        } else {
          const value = inputConfig[field.key] ?? current?.config[field.key] ?? field.default
          if (
            !primitive(value) ||
            typeof value !== field.type ||
            (typeof value === 'string' && value.length > 65536) ||
            (field.choices.length && !field.choices.includes(value))
          )
            return fail(`Enter a valid value for ${field.title}.`)
          config[field.key] = value
        }
      }
      return {
        key,
        strategyKey,
        displayName,
        description,
        order,
        isEnabled: draft.isEnabled,
        selfRegistration: draft.selfRegistration,
        domainWhitelist: { v: domainWhitelist },
        autoEnrollGroups: { v: autoEnrollGroups },
        config,
        adminRevision: current?.adminRevision ?? ''
      }
    })
    const local = rows.find(row => row.key === 'local')
    if (!local || local.strategyKey !== 'local' || !local.isEnabled) return fail('Keep Local sign-in enabled as the built-in recovery route.')
    return rows
  }
  return {
    inspect: (requester: PagePrincipal) => read(tx => inspect(tx, requester)),
    async initialize(requester: PagePrincipal, fingerprintValue: unknown): Promise<AuthenticationWriteResult> {
      const saved = await read(tx => inspect(tx, requester))
      if (fingerprintValue !== saved.fingerprint) return fail('The sign-in policy changed. Reload before initialization.', 409)
      let applied = true
      try {
        applied = (await onCommitted?.([])) ?? true
      } catch {
        applied = false
      }
      return { sessionsEnded: 0, currentSessionEnded: false, activation: applied ? 'applied' : 'needs-attention' }
    },
    async save(requester: PagePrincipal, input: { providers?: unknown; fingerprint?: unknown; reason?: unknown }): Promise<AuthenticationWriteResult> {
      const reason = text(input.reason, 'Administrative reason', 3, 1000)
      const result = await db.transaction(async tx => {
        // Groups first matches group/account administration and serializes enrollment references with deletion.
        const list = await groups(tx, true),
          previous = await providers(tx, true),
          people = await accounts(tx, true),
          actorId = await authority(tx, requester, list, people)
        if (typeof input.fingerprint !== 'string' || input.fingerprint !== fingerprint(previous, list, people))
          return fail('Sign-in policy, account usage or group access changed. Reload before saving.', 409)
        const rows = normalize(input.providers, previous, list),
          changes: AuthenticationEvent['changes'] = [],
          ended = new Set<number>(),
          revision = randomUUID(),
          now = new Date()
        for (const current of previous) {
          if (rows.some(row => row.key === current.key)) continue
          if (people.some(person => person.providerKey === current.key))
            return fail(`${current.displayName} still has accounts. Disable sign-in or resolve those accounts before deletion.`, 409)
          changes.push({ key: current.key, name: current.displayName, action: 'deleted', fields: [], sessionsEnded: 0 })
        }
        for (const row of rows) {
          const current = previous.find(item => item.key === row.key),
            fields = (['displayName', 'description', 'isEnabled', 'selfRegistration', 'domainWhitelist', 'autoEnrollGroups', 'order'] as const).filter(
              field => !current || stable(current[field]) !== stable(row[field])
            ) as string[]
          const changedConfig = Object.keys(row.config).filter(key => !current || stable(row.config[key]) !== stable(current.config[key]))
          fields.push(...changedConfig.map(key => 'config.' + key))
          if (current && !fields.length) continue
          const invalidates = Boolean(current && (fields.includes('isEnabled') || changedConfig.length)),
            affected = invalidates ? people.filter(person => person.providerKey === row.key).map(person => person.id) : []
          for (const id of affected) ended.add(id)
          changes.push({ key: row.key, name: row.displayName, action: current ? 'updated' : 'created', fields, sessionsEnded: affected.length })
          row.adminRevision = revision
          const persisted = {
            ...row,
            config: JSON.stringify(row.config),
            domainWhitelist: JSON.stringify(row.domainWhitelist),
            autoEnrollGroups: JSON.stringify(row.autoEnrollGroups)
          }
          if (current) await tx('authentication').where('key', row.key).update(persisted)
          else await tx('authentication').insert(persisted)
        }
        for (const change of changes.filter(change => change.action === 'deleted')) await tx('authentication').where('key', change.key).delete()
        if (!changes.length) return fail('There are no authentication changes to save.')
        const ids = [...ended]
        if (ids.length) {
          await tx('users')
            .whereIn('id', ids)
            .update({ authVersion: tx.raw('?? + 1', ['authVersion']), sessionsRevokedAt: now, adminRevision: revision })
          await revokeOwnerPersonalMcpKeys(tx, ids)
          await tx('userAdministrationEvents').insert(
            ids.map(userId => ({
              userId,
              actorId,
              action: 'sign-in-policy-updated',
              reason,
              details: JSON.stringify({ providerKey: people.find(person => person.id === userId)!.providerKey, sessionsEnded: true }),
              createdAt: now
            }))
          )
        }
        await tx('authenticationAdministrationEvents').insert({ actorId, reason, changes: JSON.stringify(changes), createdAt: now })
        return { ids, currentSessionEnded: actorId !== null && ended.has(actorId) }
      })
      let applied = true
      try {
        applied = (await onCommitted?.(result.ids)) ?? true
      } catch {
        applied = false
      }
      return { sessionsEnded: result.ids.length, currentSessionEnded: result.currentSessionEnded, activation: applied ? 'applied' : 'needs-attention' }
    }
  }
}

export const authenticationDefinitions = (source: unknown[]): AuthenticationDefinition[] =>
  source.map(value => {
    const definition = object(value),
      props = object(definition.props ?? {})
    return {
      key: String(definition.key),
      title: String(definition.title ?? definition.key),
      description: String(definition.description ?? ''),
      available: definition.isAvailable === true,
      useForm: definition.useForm === true,
      website: typeof definition.website === 'string' && /^https?:\/\//.test(definition.website) ? definition.website : '',
      fields: Object.entries(props)
        .map(([key, value]) => {
          const prop = object(value),
            type = prop.type === 'boolean' ? 'boolean' : prop.type === 'number' ? 'number' : 'string'
          return {
            key,
            title: String(prop.title ?? key),
            type,
            hint: typeof prop.hint === 'string' ? prop.hint : '',
            default: prop.sensitive ? '' : primitive(prop.default) ? prop.default : type === 'boolean' ? false : type === 'number' ? 0 : '',
            sensitive: prop.sensitive === true,
            multiline: prop.multiline === true,
            choices: Array.isArray(prop.enum) ? prop.enum.filter(primitive) : [],
            order: typeof prop.order === 'number' ? prop.order : 100
          } as AuthenticationDefinition['fields'][number]
        })
        .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    }
  })
export const getAuthenticationAdministrationStore = () => {
  const wiki = WIKI as unknown as {
    models: { knex: Knex }
    data: { authentication: unknown[] }
    config: { host: string; sessionSecret: string }
    auth: {
      strategyStatus: Record<string, AuthenticationRuntime>
      activateStrategies(): Promise<void>
      revokeUserTokens(input: { id: number; kind: 'u' }): void
      reloadApiKeys(): Promise<void>
    }
    events: { outbound: { emit(event: string, payload?: unknown): void } }
    logger: { warn(message: string): void }
  }
  return createAuthenticationAdministrationStore({
    db: wiki.models.knex,
    reviewKey: wiki.config.sessionSecret,
    definitions: () => authenticationDefinitions(wiki.data.authentication),
    host: () => wiki.config.host,
    runtime: () => wiki.auth.strategyStatus,
    onCommitted: async ids => {
      let applied = true
      const deliver = async (work: () => unknown) => {
        try {
          await work()
        } catch {
          applied = false
          wiki.logger.warn('Authentication policy committed; an activation or revocation notification failed.')
        }
      }
      for (const id of ids) {
        await deliver(() => wiki.auth.revokeUserTokens({ id, kind: 'u' }))
        await deliver(() => wiki.events.outbound.emit('addAuthRevoke', { id, kind: 'u' }))
      }
      if (ids.length && !(await reloadPersonalMcpKeys(wiki))) applied = false
      await deliver(() => wiki.events.outbound.emit('reloadAuthStrategies'))
      await deliver(() => wiki.auth.activateStrategies())
      const enabled = await wiki.models.knex('authentication').where('isEnabled', true).select('key', 'adminRevision')
      return (
        applied &&
        enabled.every(row => wiki.auth.strategyStatus[row.key]?.state === 'ready' && wiki.auth.strategyStatus[row.key]?.revision === row.adminRevision)
      )
    }
  })
}
