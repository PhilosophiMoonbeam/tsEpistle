import { createHmac, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import {
  DeveloperFlagEventSchema,
  DeveloperFlagsApplyInputSchema,
  DeveloperFlagsSaveInputSchema,
  DeveloperFlagsRevisionSchema,
  DeveloperFlagsSchema,
  developerFlagChangedFields,
  type DeveloperFlagEvent,
  type DeveloperFlags,
  type DeveloperFlagsApplyResult,
  type DeveloperFlagsSaveResult,
  type DeveloperFlagsWorkspace
} from '../../shared/developer-flags.ts'
import { requireSystemAuthority, type SystemRequester } from '../helpers/system-authority.ts'
import errors from './errors.ts'

const { ApplicationError } = errors
const SETTINGS_LOCK_NAMESPACE = 73412011
declare const WIKI: Record<string, unknown>

interface SystemAuthority {
  actorId: number | null
  apiKeyId: number | null
  ids: number[]
  groups: Array<{ id: number; permissions: string[]; adminRevision: string }>
}

interface DeveloperFlagsState {
  authority: SystemAuthority
  settings: Setting[]
  rawFlags: Record<string, unknown>
  activePolicy: DeveloperFlags
  policy: DeveloperFlags
  metadata: Record<string, unknown>
  source: 'reviewed-administration' | 'database' | 'effective-configuration'
  state: 'active' | 'staged'
  fingerprint: string
}

export interface DeveloperFlagsWorkspaceStore {
  inspect(requester: SystemRequester): Promise<DeveloperFlagsWorkspace>
  save(requester: SystemRequester, input: unknown): Promise<DeveloperFlagsSaveResult>
  apply(requester: SystemRequester, input: unknown): Promise<DeveloperFlagsApplyResult>
  legacyList(requester: SystemRequester): Promise<Array<{ key: 'ldapdebug' | 'sqllog'; value: boolean }>>
}

interface Setting {
  key: string
  value: unknown
  updatedAt: string
}

interface RuntimeSnapshot {
  instanceId: string
  flags: Record<string, unknown>
  sqlQueryLoggingApplied: boolean
}

interface Dependencies {
  db: Knex
  reviewKey: string
  fallback(): Record<string, unknown>
  deploymentDefaults(): Record<string, unknown>
  runtime(): RuntimeSnapshot
  applySaved(policy: DeveloperFlags): Promise<{ applied: boolean; published: boolean }>
  now?(): Date
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item
  )

const fail = (message: string, status = 400): never => {
  throw new ApplicationError(message, { status })
}

export const developerFlagsFromConfiguration = (value: unknown): DeveloperFlags => {
  const flags = record(value)
  return {
    ldapdebug: flags.ldapdebug === true,
    sqllog: flags.sqllog === true
  }
}

const samePolicy = (left: DeveloperFlags, right: DeveloperFlags): boolean => left.ldapdebug === right.ldapdebug && left.sqllog === right.sqllog
const revision = (value: unknown): string => {
  const parsed = DeveloperFlagsRevisionSchema.safeParse(value)
  return parsed.success ? parsed.data : ''
}

const history = (value: Record<string, unknown>): DeveloperFlagEvent[] =>
  (Array.isArray(value.history) ? value.history.slice(0, 50) : []).flatMap(entry => {
    const parsed = DeveloperFlagEventSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })

export const createDeveloperFlagsWorkspaceStore = (deps: Dependencies): DeveloperFlagsWorkspaceStore => {
  const now = () => deps.now?.() ?? new Date()

  const state = async (tx: Knex.Transaction, requester: SystemRequester, lock = false): Promise<DeveloperFlagsState> => {
    const authority = await requireSystemAuthority(tx, requester, lock, now())
    if (lock) await tx.raw('SELECT pg_advisory_xact_lock(?, ?)', [SETTINGS_LOCK_NAMESPACE, 1])
    const query = tx<Setting>('settings').whereIn('key', ['flags', 'developerFlagsAdministration']).orderBy('key')
    const settings = await (lock ? query.forUpdate() : query)
    const flagsSetting = settings.find(row => row.key === 'flags')
    const metadataSetting = settings.find(row => row.key === 'developerFlagsAdministration')
    const fallbackFlags = record(deps.fallback().flags)
    const rawFlags = { ...fallbackFlags, ...record(flagsSetting?.value) }
    const activePolicy = developerFlagsFromConfiguration(rawFlags)
    const metadata = record(metadataSetting?.value)
    const reviewed = DeveloperFlagsSchema.safeParse(metadata.policy)
    const policy = reviewed.success ? reviewed.data : activePolicy
    const source = reviewed.success ? ('reviewed-administration' as const) : flagsSetting ? ('database' as const) : ('effective-configuration' as const)
    const fingerprint = createHmac('sha256', deps.reviewKey)
      .update(stable([settings, rawFlags, metadata, authority]))
      .digest('hex')
    return {
      authority,
      settings,
      rawFlags,
      activePolicy,
      policy,
      metadata,
      source,
      state: samePolicy(policy, activePolicy) ? 'active' : 'staged',
      fingerprint
    }
  }

  const process = (current: DeveloperFlagsState): DeveloperFlagsWorkspace['process'] => {
    const runtime = deps.runtime()
    const runtimePolicy = developerFlagsFromConfiguration(runtime.flags)
    const settingsCurrent = current.state === 'active' && samePolicy(current.policy, runtimePolicy) && runtime.sqlQueryLoggingApplied === current.policy.sqllog
    return {
      instanceId: runtime.instanceId,
      observedAt: now().toISOString(),
      policy: runtimePolicy,
      sqlQueryLoggingApplied: runtime.sqlQueryLoggingApplied,
      settingsCurrent,
      state: settingsCurrent ? 'applied' : 'needs-attention'
    }
  }

  const present = (current: DeveloperFlagsState): DeveloperFlagsWorkspace => ({
    observedAt: now().toISOString(),
    fingerprint: current.fingerprint,
    revision: revision(current.metadata.revision),
    saved: { policy: current.policy, source: current.source, state: current.state },
    deployment: {
      defaults: developerFlagsFromConfiguration(deps.deploymentDefaults()),
      description: 'These are application defaults. A database flag setting, when present, overrides the effective deployment configuration.'
    },
    process: process(current),
    history: history(current.metadata)
  })

  const inspect = async (requester: SystemRequester): Promise<DeveloperFlagsWorkspace> => {
    const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const workspace = present(await state(tx, requester))
      await tx.commit()
      return workspace
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }

  const save = async (requester: SystemRequester, input: unknown): Promise<DeveloperFlagsSaveResult> => {
    const parsed = DeveloperFlagsSaveInputSchema.safeParse(input)
    if (!parsed.success) return fail('Review both diagnostic flags and provide an administrative reason before saving.')
    const draft = parsed.data
    return deps.db.transaction(async tx => {
      const current = await state(tx, requester, true)
      if (draft.fingerprint !== current.fingerprint)
        return fail('Developer flags, their history, or your current authority changed. Reload the saved settings before reviewing again.', 409)
      const changed = developerFlagChangedFields(current.policy, draft.policy)
      if (!changed.length) return fail('There are no developer flag changes to save.')
      const event: DeveloperFlagEvent = {
        id: randomUUID(),
        createdAt: now().toISOString(),
        actorId: current.authority.actorId,
        apiKeyId: current.authority.apiKeyId,
        reason: draft.reason,
        changed,
        policy: draft.policy
      }
      const metadata = {
        ...current.metadata,
        revision: event.id,
        policy: draft.policy,
        history: [event, ...history(current.metadata)].slice(0, 50)
      }
      await tx('settings')
        .insert({ key: 'developerFlagsAdministration', value: JSON.stringify(metadata), updatedAt: event.createdAt })
        .onConflict('key')
        .merge(['value', 'updatedAt'])
      return { revision: event.id, policy: draft.policy, application: 'needs-attention' }
    })
  }

  const apply = async (requester: SystemRequester, input: unknown): Promise<DeveloperFlagsApplyResult> => {
    const parsed = DeveloperFlagsApplyInputSchema.safeParse(input)
    if (!parsed.success) return fail('Reload the current saved flags before applying them.')
    const promotion = await deps.db.transaction(async tx => {
      const current = await state(tx, requester, true)
      if (current.fingerprint !== parsed.data.fingerprint)
        return fail('Developer flags, their history, or your current authority changed. Reload before applying the saved policy.', 409)
      await tx('settings')
        .insert({ key: 'flags', value: JSON.stringify({ ...current.rawFlags, ...current.policy }), updatedAt: now().toISOString() })
        .onConflict('key')
        .merge(['value', 'updatedAt'])
      return { revision: revision(current.metadata.revision), policy: current.policy }
    })
    try {
      const result = await deps.applySaved(promotion.policy)
      return { revision: promotion.revision, applied: result.applied, published: result.published }
    } catch {
      return { revision: promotion.revision, applied: false, published: false }
    }
  }

  const legacyList = async (requester: SystemRequester): Promise<Array<{ key: 'ldapdebug' | 'sqllog'; value: boolean }>> => {
    const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const current = await state(tx, requester)
      await tx.commit()
      return [
        { key: 'ldapdebug', value: current.activePolicy.ldapdebug },
        { key: 'sqllog', value: current.activePolicy.sqllog }
      ]
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }

  return { inspect, save, apply, legacyList }
}

let runtimeStore: DeveloperFlagsWorkspaceStore | undefined
let runtimeDatabase: Knex | undefined

export const getDeveloperFlagsWorkspaceStore = () => {
  const wiki = WIKI as unknown as {
    INSTANCE_ID?: string
    data?: { defaults?: { config?: { flags?: unknown } } }
    config: Record<string, unknown>
    models: { knex: Knex }
    configSvc: { loadFromDb(): Promise<void>; applyFlags(): Promise<void> }
    events: { outbound: { emit(event: string): void } }
    logger: { warn(message: string): void }
  }
  if (!runtimeStore || runtimeDatabase !== wiki.models.knex) {
    runtimeDatabase = wiki.models.knex
    let applicationQueue = Promise.resolve()
    runtimeStore = createDeveloperFlagsWorkspaceStore({
      db: wiki.models.knex,
      reviewKey: String(wiki.config.sessionSecret),
      fallback: () => wiki.config,
      deploymentDefaults: () => record(wiki.data?.defaults?.config?.flags),
      runtime: () => ({
        instanceId: wiki.INSTANCE_ID || 'current-process',
        flags: record(wiki.config.flags),
        sqlQueryLoggingApplied: wiki.models.knex.client.config.debug === true
      }),
      applySaved: expected => {
        const next = applicationQueue.then(async () => {
          try {
            await wiki.configSvc.loadFromDb()
            if (!samePolicy(developerFlagsFromConfiguration(wiki.config.flags), expected)) return { applied: false, published: false }
            await wiki.configSvc.applyFlags()
            const applied = samePolicy(developerFlagsFromConfiguration(wiki.config.flags), expected) && wiki.models.knex.client.config.debug === expected.sqllog
            if (!applied) return { applied: false, published: false }
            try {
              // EventEmitter accepts a local request; it cannot observe a peer transport delivery.
              wiki.events.outbound.emit('reloadConfig')
            } catch {
              wiki.logger.warn('Developer flags were applied locally but the peer reload request could not be emitted.')
            }
            return { applied: true, published: false }
          } catch {
            wiki.logger.warn('Saved developer flags could not be reconciled with the current process.')
            return { applied: false, published: false }
          }
        })
        applicationQueue = next.then(
          () => undefined,
          () => undefined
        )
        return next
      }
    })
  }
  return runtimeStore
}
