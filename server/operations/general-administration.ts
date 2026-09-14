import { createHmac, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import {
  generalPolicyDefaults,
  validateGeneralPolicy,
  generalChangedFields,
  type GeneralPolicy,
  type GeneralWorkspace,
  type GeneralPolicyEvent,
  type GeneralWriteResult
} from '../../shared/general-policy.ts'
import { isUserDateFormat, isUserTimeFormat, isUserTimezone, userPresentationDefaults, type UserPresentationDefaults } from '../../shared/user-presentation.ts'
import { siteBannerOrDefault } from '../../shared/site-banner.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { principalId, type PagePrincipal } from '../helpers/page-access.ts'
import errors from './errors.ts'
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const parsePresentationDefaults = (value: unknown): Record<string, unknown> => {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return {}
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const candidate = parsed as Record<string, unknown>
  const wrapped = candidate.v
  return wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped) ? (wrapped as Record<string, unknown>) : candidate
}

const normalizePresentationDefaults = (value: unknown): UserPresentationDefaults => {
  const candidate = parsePresentationDefaults(value)
  if (!isUserTimezone(candidate.timezone) || !isUserDateFormat(candidate.dateFormat) || !isUserTimeFormat(candidate.timeFormat))
    return { ...userPresentationDefaults }
  return {
    timezone: candidate.timezone,
    dateFormat: candidate.dateFormat,
    timeFormat: candidate.timeFormat
  }
}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  )
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const settingKeys = [
  'host',
  'title',
  'company',
  'contentLicense',
  'footerOverride',
  'seo',
  'banner',
  'pageExtensions',
  'editShortcuts',
  'generalAdministration',
  'userDefaults'
]
const scalarKeys = ['host', 'title', 'company', 'contentLicense', 'footerOverride', 'pageExtensions']
export const generalPolicyFromConfiguration = (configuration: Record<string, unknown>): GeneralPolicy => {
  const result = structuredClone(generalPolicyDefaults),
    flat = { ...configuration, ...record(configuration.seo), ...record(configuration.editShortcuts) }
  for (const key of Object.keys(result) as Array<keyof GeneralPolicy>) {
    if (flat[key] !== undefined) Reflect.set(result, key, structuredClone(flat[key]))
  }
  result.banner = siteBannerOrDefault(configuration.banner)
  result.userDefaults = normalizePresentationDefaults(flat.userDefaults)
  return result
}
export const generalConfigurationPatch = (policy: GeneralPolicy, configuration: Record<string, unknown>): Record<string, unknown> => ({
  host: policy.host,
  title: policy.title,
  company: policy.company,
  contentLicense: policy.contentLicense,
  footerOverride: policy.footerOverride,
  banner: policy.banner,
  pageExtensions: policy.pageExtensions,
  userDefaults: policy.userDefaults,
  seo: { ...record(configuration.seo), description: policy.description, robots: policy.robots },
  editShortcuts: { ...record(configuration.editShortcuts), ...Object.fromEntries(Object.entries(policy).filter(([key]) => key.startsWith('edit'))) }
})
interface Group {
  id: number
  permissions: string[]
  adminRevision: string
}
interface Account {
  id: number
  isActive: boolean
  authVersion: number
}
interface Setting {
  key: string
  value: unknown
}
interface Dependencies {
  db: Knex
  reviewKey: string
  fallback(): Record<string, unknown>
  runtime(): GeneralPolicy
  runtimeReady?(): boolean
  onCommitted?(): Promise<boolean>
}
export const createGeneralAdministrationStore = (deps: Dependencies) => {
  const state = async (tx: Knex.Transaction, requester: PagePrincipal, lock = false) => {
    const g = tx<Group>('groups').select('id', 'permissions', 'adminRevision').orderBy('id'),
      groups = await (lock ? g.forUpdate() : g)
    if (!requester) return fail('An administrator sign-in is required.', 403)
    const actorId = principalId(requester)
    let ids: number[]
    if (actorId !== null) {
      const query = tx<Account>('users').where('id', actorId).select('id', 'isActive', 'authVersion').first(),
        account = await (lock ? query.forUpdate() : query)
      if (!accountSessionIsCurrent({ id: actorId, authVersion: Reflect.get(requester, 'authVersion') }, account))
        return fail('Your account session changed. Sign in again.', 403)
      ids = (await tx<{ groupId: number }>('userGroups').where('userId', actorId).select('groupId')).map(row => row.groupId).sort((a, b) => a - b)
    } else {
      if (
        requester.ownershipUserId !== null ||
        requester.id !== 1 ||
        !Array.isArray(requester.groups) ||
        requester.groups.length !== 1 ||
        typeof requester.groups[0] !== 'number'
      )
        return fail('An administrator principal is required.', 403)
      ids = requester.groups as number[]
    }
    if (!groups.some(group => ids.includes(group.id) && group.permissions.includes('manage:system')))
      return fail('Full system administration is required.', 403)
    const query = tx<Setting>('settings').whereIn('key', settingKeys).orderBy('key'),
      rows = await (lock ? query.forUpdate() : query)
    const configuration = {
      ...deps.fallback(),
      ...Object.fromEntries(rows.map(row => [row.key, scalarKeys.includes(row.key) ? record(row.value).v : row.value]))
    }
    const policy = generalPolicyFromConfiguration(configuration),
      metadata = record(configuration.generalAdministration)
    const fingerprint = createHmac('sha256', deps.reviewKey)
      .update(stable([rows, policy, groups, actorId, ids]))
      .digest('hex')
    return { policy, configuration, metadata, fingerprint, actorId }
  }
  const inspect = async (requester: PagePrincipal): Promise<GeneralWorkspace> => {
    const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const saved = await state(tx, requester)
      await tx.commit()
      return {
        policy: saved.policy,
        fingerprint: saved.fingerprint,
        history: Array.isArray(saved.metadata.history) ? (saved.metadata.history.slice(0, 50) as GeneralPolicyEvent[]) : [],
        runtime: {
          state: stable(saved.policy) === stable(deps.runtime()) && deps.runtimeReady?.() !== false ? 'applied' : 'needs-attention',
          observedAt: new Date().toISOString()
        }
      }
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }
  const activate = async (): Promise<GeneralWriteResult> => {
    try {
      return { activation: (await deps.onCommitted?.()) === false ? 'needs-attention' : 'applied' }
    } catch {
      return { activation: 'needs-attention' }
    }
  }
  return {
    inspect,
    async save(requester: PagePrincipal, input: { policy: unknown; fingerprint: unknown; reason: unknown }): Promise<GeneralWriteResult> {
      const validation = validateGeneralPolicy(input.policy)
      if (!validation.ok) return fail(validation.issues.join(' '))
      if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 1000)
        return fail('Provide an administrative reason of 3–1000 characters.')
      const reason = input.reason.trim()
      await deps.db.transaction(async tx => {
        const current = await state(tx, requester, true)
        if (typeof input.fingerprint !== 'string' || current.fingerprint !== input.fingerprint)
          return fail('Workspace settings changed. Reload the saved settings before reviewing again.', 409)
        const fields = generalChangedFields(current.policy, validation.value)
        if (!fields.length) return fail('There are no workspace changes to save.')
        if (URL.canParse(current.policy.host) && new URL(current.policy.host).protocol === 'https:' && !validation.value.host.startsWith('https:'))
          return fail('An HTTPS workspace cannot change to HTTP while running. Configure that transition during a deployment.', 409)
        const event: GeneralPolicyEvent = { id: randomUUID(), actorId: current.actorId, reason, fields, createdAt: new Date().toISOString() }
        const patch = generalConfigurationPatch(validation.value, current.configuration)
        patch.generalAdministration = {
          ...current.metadata,
          revision: event.id,
          history: [event, ...(Array.isArray(current.metadata.history) ? current.metadata.history : [])].slice(0, 50)
        }
        for (const [key, value] of Object.entries(patch))
          await tx('settings')
            .insert({ key, value: JSON.stringify(scalarKeys.includes(key) ? { v: value } : value), updatedAt: event.createdAt })
            .onConflict('key')
            .merge(['value', 'updatedAt'])
      })
      return activate()
    },
    async initialize(requester: PagePrincipal, fingerprint: unknown): Promise<GeneralWriteResult> {
      const saved = await inspect(requester)
      if (typeof fingerprint !== 'string' || fingerprint !== saved.fingerprint) return fail('Workspace settings changed. Reload before activation.', 409)
      return activate()
    }
  }
}
let runtimeStore: ReturnType<typeof createGeneralAdministrationStore> | undefined
let runtimeDatabase: Knex | undefined
export const getGeneralAdministrationStore = () => {
  const wiki = WIKI as unknown as {
    models: { knex: Knex }
    config: Record<string, unknown>
    configSvc: { loadFromDb(): Promise<void> }
    auth?: { strategyHost: string | null; activateStrategies(): Promise<void> }
    events: { outbound: { emit(event: string): void } }
    logger: { warn(message: string): void }
  }
  if (!runtimeStore || runtimeDatabase !== wiki.models.knex) {
    runtimeDatabase = wiki.models.knex
    let queue = Promise.resolve()
    runtimeStore = createGeneralAdministrationStore({
      db: wiki.models.knex,
      reviewKey: String(wiki.config.sessionSecret),
      fallback: () => wiki.config,
      runtime: () => generalPolicyFromConfiguration(wiki.config),
      runtimeReady: () => !wiki.auth || wiki.auth.strategyHost === wiki.config.host,
      onCommitted: () => {
        const next = queue.then(async () => {
          await wiki.configSvc.loadFromDb()
          if (wiki.auth && wiki.auth.strategyHost !== wiki.config.host) await wiki.auth.activateStrategies()
          let notified = true
          try {
            wiki.events.outbound.emit('reloadConfig')
          } catch {
            wiki.logger.warn('Workspace settings saved; peer reload notification failed.')
            notified = false
          }
          const rows = await wiki.models.knex<Setting>('settings').whereIn('key', settingKeys).orderBy('key')
          const saved = { ...wiki.config, ...Object.fromEntries(rows.map(row => [row.key, scalarKeys.includes(row.key) ? record(row.value).v : row.value])) }
          return (
            notified &&
            (!wiki.auth || wiki.auth.strategyHost === wiki.config.host) &&
            stable(generalPolicyFromConfiguration(saved)) === stable(generalPolicyFromConfiguration(wiki.config))
          )
        })
        queue = next.then(
          () => {},
          () => {}
        )
        return next
      }
    })
  }
  return runtimeStore
}

export const legacyGeneralKeys = Object.keys(generalPolicyDefaults)
const legacyRetainedKeys = ['analyticsService', 'analyticsId', 'featurePageRatings', 'featurePersonalWikis']
export const patchLegacyGeneralConfiguration = async (requester: PagePrincipal, input: Record<string, unknown>): Promise<void> => {
  if (Object.keys(input).some(key => !legacyGeneralKeys.includes(key) && !legacyRetainedKeys.includes(key)))
    return fail('Save General settings separately from other workspace controls.')
  const service = getGeneralAdministrationStore(),
    saved = await service.inspect(requester)
  const wiki = WIKI as unknown as { models: { knex: Knex }; config: Record<string, unknown> }
  const rows = await wiki.models.knex<Setting>('settings').whereIn('key', ['seo', 'features']).select('key', 'value')
  const configuration = { ...wiki.config, ...Object.fromEntries(rows.map(row => [row.key, row.value])) }
  const retained = { ...record(configuration.seo), ...record(configuration.features) }
  for (const key of legacyRetainedKeys)
    if (Object.hasOwn(input, key) && input[key] !== retained[key])
      return fail('Analytics and inactive feature flags cannot be changed through General settings.')
  const next: Record<string, unknown> = { ...saved.policy }
  for (const [key, value] of Object.entries(input)) {
    if (!legacyGeneralKeys.includes(key)) continue
    if (key === 'pageExtensions' && typeof value === 'string')
      next[key] = value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean)
    else next[key] = value
  }
  const result = validateGeneralPolicy(next)
  if (!result.ok) return fail(result.issues.join(' '))
  if (!generalChangedFields(saved.policy, result.value).length) return
  const outcome = await service.save(requester, {
    policy: result.value,
    fingerprint: saved.fingerprint,
    reason: 'Updated through the legacy General configuration API'
  })
  if (outcome.activation === 'needs-attention')
    return fail('Workspace settings were saved, but runtime activation needs attention. Reload General settings before continuing.', 500)
}
