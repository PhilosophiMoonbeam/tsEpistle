import { createHmac, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { parse as parseCSS, CssSyntaxError } from 'postcss'
import {
  ThemePolicySchema, themePolicyFromConfiguration, themeChangedFields,
  type ThemePolicy, type ThemeWorkspace, type ThemePolicyEvent, type ThemeWriteResult
} from '../../shared/theme-policy.ts'
import { accountSessionIsCurrent } from '../helpers/account-session.ts'
import { principalId, type PagePrincipal } from '../helpers/page-access.ts'
import errors from './errors.ts'
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item
  )
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const settingKeys = ['theming', 'themeAdministration']
const customCodeFields = ['injectCSS', 'injectHead', 'injectBody'] as const
type CustomCodeField = typeof customCodeFields[number]
const themeConfigurationPatch = (policy: ThemePolicy, configuration: Record<string, unknown>) => ({
  theming: { ...record(configuration.theming), ...policy, colors: policy.palettes.find(palette => palette.id === policy.activePaletteId)!.colors }
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
  runtime(): ThemePolicy
  runtimeReady?(): boolean
  onCommitted?(): Promise<boolean>
}
export const createThemeAdministrationStore = (deps: Dependencies) => {
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
    const authorizedGroups = groups.filter(group => ids.includes(group.id) && Array.isArray(group.permissions) && group.permissions.some(permission => ['manage:system', 'manage:theme'].includes(permission)))
    if (!authorizedGroups.length) return fail('Theme administration is required.', 403)
    const query = tx<Setting>('settings').whereIn('key', settingKeys).orderBy('key'),
      rows = await (lock ? query.forUpdate() : query)
    const configuration = {
      ...deps.fallback(),
      ...Object.fromEntries(rows.map(row => [row.key, row.value]))
    }
    const policy = themePolicyFromConfiguration(configuration),
      metadata = record(configuration.themeAdministration)
    const fingerprint = createHmac('sha256', deps.reviewKey)
      .update(stable([rows, policy, groups, actorId, ids]))
      .digest('hex')
    return {
      policy,
      configuration,
      metadata,
      fingerprint,
      actorId,
      editCustomCode: authorizedGroups.some(group => group.permissions.includes('manage:system'))
    }
  }
  const inspect = async (requester: PagePrincipal): Promise<ThemeWorkspace> => {
    const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const saved = await state(tx, requester)
      await tx.commit()
      return {
        policy: saved.policy,
        fingerprint: saved.fingerprint,
        history: Array.isArray(saved.metadata.history) ? (saved.metadata.history.slice(0, 50) as ThemePolicyEvent[]) : [],
        runtime: { state: stable(saved.policy) === stable(deps.runtime()) && deps.runtimeReady?.() !== false ? 'applied' : 'needs-attention', observedAt: new Date().toISOString() },
        capabilities: { editCustomCode: saved.editCustomCode }
      }
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }
  const activate = async (): Promise<ThemeWriteResult> => {
    try {
      return { activation: (await deps.onCommitted?.()) === true ? 'applied' : 'needs-attention' }
    } catch {
      return { activation: 'needs-attention' }
    }
  }
  return {
    inspect,
    async save(requester: PagePrincipal, input: { policy: unknown; fingerprint: unknown; reason: unknown }): Promise<ThemeWriteResult> {
      const validation = ThemePolicySchema.safeParse(input.policy)
      if (!validation.success) return fail(validation.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' '))
      if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 1000)
        return fail('Provide an administrative reason of 3–1000 characters.')
      const reason = input.reason.trim()
      await deps.db.transaction(async tx => {
        const current = await state(tx, requester, true)
        if (typeof input.fingerprint !== 'string' || current.fingerprint !== input.fingerprint)
          return fail('Workspace settings changed. Reload the saved settings before reviewing again.', 409)
        const fields = themeChangedFields(current.policy, validation.data)
        if (!fields.length) return fail('There are no workspace changes to save.')
        if (fields.some(field => customCodeFields.includes(field as CustomCodeField)) && !current.editCustomCode)
          return fail('Full system administration is required to change custom theme code.', 403)
        if (fields.includes('injectCSS')) {
          try { parseCSS(validation.data.injectCSS, { from: undefined }) }
          catch (error) {
            return fail(error instanceof CssSyntaxError ? `Custom CSS syntax error at line ${error.line}, column ${error.column}: ${error.reason}` : 'Custom CSS could not be parsed. Correct the stylesheet before publishing.')
          }
        }
        const event: ThemePolicyEvent = { id: randomUUID(), actorId: current.actorId, reason, fields, createdAt: new Date().toISOString() }
        const patch: Record<string, unknown> = themeConfigurationPatch(validation.data, current.configuration)
        patch.themeAdministration = {
          ...current.metadata,
          revision: event.id,
          history: [event, ...(Array.isArray(current.metadata.history) ? current.metadata.history : [])].slice(0, 50)
        }
        for (const [key, value] of Object.entries(patch))
          await tx('settings')
            .insert({ key, value: JSON.stringify(value), updatedAt: event.createdAt })
            .onConflict('key')
            .merge(['value', 'updatedAt'])
      })
      return activate()
    },
    async initialize(requester: PagePrincipal, fingerprint: unknown): Promise<ThemeWriteResult> {
      const saved = await inspect(requester)
      if (typeof fingerprint !== 'string' || fingerprint !== saved.fingerprint) return fail('Workspace settings changed. Reload before activation.', 409)
      return activate()
    }
  }
}
let runtimeStore: ReturnType<typeof createThemeAdministrationStore> | undefined
let runtimeDatabase: Knex | undefined
export const getThemeAdministrationStore = () => {
  const wiki = WIKI as unknown as {
    models: { knex: Knex }
    config: Record<string, unknown>
    configSvc: { loadFromDb(): Promise<void> }
    events: { outbound: { emit(event: string): void } }
    logger: { warn(message: string): void }
  }
  if (!runtimeStore || runtimeDatabase !== wiki.models.knex) {
    runtimeDatabase = wiki.models.knex
    let queue = Promise.resolve()
    runtimeStore = createThemeAdministrationStore({
      db: wiki.models.knex,
      reviewKey: String(wiki.config.sessionSecret),
      fallback: () => wiki.config,
      runtime: () => themePolicyFromConfiguration(wiki.config),
      onCommitted: () => {
        const next = queue.then(async () => {
          await wiki.configSvc.loadFromDb()
          let notified = true
          try {
            wiki.events.outbound.emit('reloadConfig')
          } catch {
            wiki.logger.warn('Workspace settings saved; peer reload notification failed.')
            notified = false
          }
          const rows = await wiki.models.knex<Setting>('settings').whereIn('key', settingKeys).orderBy('key')
          const saved = { ...wiki.config, ...Object.fromEntries(rows.map(row => [row.key, row.value])) }
          return notified && stable(themePolicyFromConfiguration(saved)) === stable(themePolicyFromConfiguration(wiki.config))
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