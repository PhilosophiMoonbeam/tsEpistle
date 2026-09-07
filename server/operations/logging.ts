import { createHmac, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { z } from 'zod'
import {
  isValidSentryDsn,
  LOGGING_FORMATS,
  LOGGING_LEVELS,
  LoggingApplySchema,
  LoggingWorkspaceDraftSchema,
  type LoggingConfigurationEvent,
  type LoggingDestination,
  type LoggingDestinationDraft,
  type LoggingDestinationField,
  type LoggingRuntimeSnapshot,
  type LoggingWorkspace
} from '../../shared/logging-workspace.ts'
import {
  loggingRuntimeKey,
  type LoggingDestinationRuntimeConfiguration,
  type LoggingRuntimeConfiguration,
  type LoggingRuntimeObservation,
  type ManagedLogger
} from '../core/logger.ts'
import { requireSystemAuthority, type SystemRequester } from '../helpers/system-authority.ts'
import errors from './errors.ts'

interface SettingRow {
  key: string
  value: unknown
  updatedAt: string
}

interface LoggerRow {
  key: string
  isEnabled: boolean
  level: string
  config: unknown
}

interface DefinitionProperty {
  type?: unknown
  title?: unknown
  hint?: unknown
  enum?: unknown
  sensitive?: unknown
  required?: unknown
  default?: unknown
  order?: unknown
}

interface LoggerDefinition {
  key: string
  title?: unknown
  description?: unknown
  logo?: unknown
  website?: unknown
  defaultLevel?: unknown
  props?: Record<string, DefinitionProperty>
}

interface Dependencies {
  db: Knex
  reviewKey: string
  fallback(): Record<string, unknown>
  definitions(): LoggerDefinition[]
  runtime(): Pick<ManagedLogger, 'loggingRuntime' | 'reconcile'>
  publishConsole(console: LoggingRuntimeConfiguration['console']): void
  now?(): Date
}

interface LoggingReviewState {
  authority: {
    actorId: number | null
    apiKeyId: number | null
    ids: number[]
    groups: unknown[]
  }
  settings: SettingRow[]
  rows: LoggerRow[]
  loggerByKey: Record<string, LoggerRow>
  definitions: LoggerDefinition[]
  metadata: Record<string, unknown>
  console: LoggingRuntimeConfiguration['console']
  runtimeConfiguration: LoggingRuntimeConfiguration
  fingerprint: string
}

export interface LoggingWorkspaceStore {
  inspect(requester: SystemRequester): Promise<LoggingWorkspace>
  reviewState(tx: Knex.Transaction, requester: SystemRequester, lock?: boolean): Promise<LoggingReviewState>
  presentState(current: LoggingReviewState): LoggingWorkspace
  authorizeLive(requester: SystemRequester): Promise<void>
  save(requester: SystemRequester, input: unknown): Promise<{ revision: string; applied: false }>
  apply(requester: SystemRequester, input: unknown): Promise<{ revision: string; applied: boolean; runtime: LoggingRuntimeSnapshot }>
}

const AVAILABLE_DESTINATIONS: Record<string, true> = { sentry: true }
const LIVE_TRAIL_LIMITS = { maxLines: 500, maxBytes: 262144, maxConnectionEvents: 1000 } as const
const POLICY_FENCE = 'tsepistle.logging-administration'
const EventSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string(),
    actorId: z.number().int().positive().nullable(),
    apiKeyId: z.number().int().positive().nullable(),
    reason: z.string().max(1000),
    changed: z.array(z.string().min(1).max(200)).max(100)
  })
  .strict()

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value))
    } catch {
      return {}
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item
  )
const fail = (message: string, status = 400): never => {
  throw new errors.ApplicationError(message, { status })
}
const settingValue = (value: unknown): unknown => {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      // Legacy adapters may already return the scalar value.
    }
  }
  const wrapped = record(value)
  return Object.hasOwn(wrapped, 'v') ? wrapped.v : value
}
const loggingLevel = (value: unknown): (typeof LOGGING_LEVELS)[number] =>
  typeof value === 'string' && (LOGGING_LEVELS as readonly string[]).includes(value) ? (value as (typeof LOGGING_LEVELS)[number]) : 'warn'
const loggingFormat = (value: unknown): (typeof LOGGING_FORMATS)[number] => (value === 'json' ? 'json' : 'default')
const scalar = (value: unknown): string | number | boolean | undefined =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined

const unwrapStoredValue = (value: unknown): unknown => {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return value
    }
  }
  const wrapped = record(value)
  return Object.hasOwn(wrapped, 'v') ? wrapped.v : value
}

const history = (metadata: Record<string, unknown>): LoggingConfigurationEvent[] =>
  (Array.isArray(metadata.history) ? metadata.history.slice(0, 50) : []).flatMap(value => {
    const parsed = EventSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })

const propertyType = (property: DefinitionProperty): LoggingDestinationField['type'] => {
  switch (typeof property.type === 'string' ? property.type.toLowerCase() : '') {
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'string'
  }
}

const fieldsFor = (definition: LoggerDefinition): LoggingDestinationField[] =>
  Object.entries(definition.props ?? {})
    .map(([key, property]) => ({
      key,
      title: typeof property.title === 'string' && property.title.trim() ? property.title : key,
      hint: typeof property.hint === 'string' && property.hint.trim() ? property.hint : null,
      type: propertyType(property),
      enum: Array.isArray(property.enum) && property.enum.every(value => typeof value === 'string') ? property.enum : null,
      sensitive: property.sensitive === true,
      required: property.required === true,
      order: typeof property.order === 'number' ? property.order : Number.MAX_SAFE_INTEGER
    }))
    .sort((left, right) => left.order - right.order || left.key.localeCompare(right.key))
    .map(({ order: _order, ...field }) => field)

const isAvailable = (key: string): boolean => AVAILABLE_DESTINATIONS[key] === true
const availabilityReason = (key: string): string | null =>
  isAvailable(key)
    ? null
    : 'This release does not include an active transport for this legacy destination. Its saved values are retained, but it cannot be enabled or used to deliver logs.'

const redactionPatterns = [
  /((?:["']?)(?:authorization|(?:access[-_]?|refresh[-_]?|id[-_]?)?token|password|passphrase|(?:client[-_]?)?secret|api[-_]?key|dsn)["']?\s*[:=]\s*)(?:(?:bearer|basic)\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi,
  /https?:\/\/[^\s/@]+@[^/\s]+\/\d+/gi,
  /\b(?:bearer\s+|eyJ)[a-zA-Z0-9._-]{16,}\b/gi
] as const satisfies readonly [RegExp, RegExp, RegExp, RegExp]

/** Bound and redact log content before it crosses a subscribed troubleshooting boundary. */
export const redactLoggingLiveOutput = (value: unknown): string => {
  let output = typeof value === 'string' ? value : String(value ?? '')
  output = output.replace(redactionPatterns[0], '$1[redacted]')
  output = output.replace(redactionPatterns[1], '$1[redacted]@')
  output = output.replace(redactionPatterns[2], 'https://[redacted]')
  output = output.replace(redactionPatterns[3], '[redacted token]')
  output = Array.from(output, character => {
    const code = character.codePointAt(0) ?? 0
    return (code < 32 && character !== '\n' && character !== '\t') || code === 127 ? '�' : character
  }).join('')
  return output.length > 8192 ? `${output.slice(0, 8191)}…` : output
}

const normalizeValue = (field: LoggingDestinationField, value: unknown): string | number | boolean => {
  if (field.type === 'string') {
    if (typeof value !== 'string') return fail(`Enter a valid ${field.title}.`)
    if (value.length > 65536) return fail(`Enter a valid ${field.title}.`)
    if (field.enum && !field.enum.includes(value)) return fail(`Choose a valid ${field.title}.`)
    return value
  }
  if (field.type === 'number') {
    if (typeof value !== 'number') return fail(`Enter a valid ${field.title}.`)
    if (!Number.isFinite(value)) return fail(`Enter a valid ${field.title}.`)
    return value
  }
  if (typeof value !== 'boolean') return fail(`Choose a valid ${field.title}.`)
  return value
}

const same = (left: unknown, right: unknown): boolean => stable(left) === stable(right)

export const createLoggingWorkspaceStore = (deps: Dependencies): LoggingWorkspaceStore => {
  const now = () => deps.now?.() ?? new Date()
  let queue = Promise.resolve()
  const serialize = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = queue
    const gate = Promise.withResolvers<void>()
    queue = gate.promise
    await previous.catch(() => undefined)
    try {
      return await work()
    } finally {
      gate.resolve()
    }
  }

  const state = async (tx: Knex.Transaction, requester: SystemRequester, lock = false): Promise<LoggingReviewState> => {
    const authority = await requireSystemAuthority(tx, requester, lock, now())
    const settingQuery = tx<SettingRow>('settings').whereIn('key', ['logLevel', 'logFormat', 'loggingAdministration']).orderBy('key')
    const loggerQuery = tx<LoggerRow>('loggers').select('key', 'isEnabled', 'level', 'config').orderBy('key')
    const [settings, rawRows] = await Promise.all([lock ? settingQuery.forUpdate() : settingQuery, lock ? loggerQuery.forUpdate() : loggerQuery])
    const rows = rawRows.map(row => ({ ...row, config: record(row.config) }))
    const values = { ...deps.fallback(), ...Object.fromEntries(settings.map(row => [row.key, settingValue(row.value)])) }
    const metadata = record(values.loggingAdministration)
    const definitions = deps.definitions().filter(definition => typeof definition.key === 'string' && definition.key.length > 0)
    const loggerByKey = Object.fromEntries(rows.map(row => [row.key, row]))
    const console = { level: loggingLevel(values.logLevel), format: loggingFormat(values.logFormat) }
    const destinations = definitions.map(definition => {
      const row = loggerByKey[definition.key]
      return {
        key: definition.key,
        isEnabled: row?.isEnabled === true,
        level: loggingLevel(row?.level ?? definition.defaultLevel),
        config: Object.fromEntries(Object.entries(record(row?.config)).map(([key, value]) => [key, unwrapStoredValue(value)]))
      } satisfies LoggingDestinationRuntimeConfiguration
    })
    const runtimeConfiguration: LoggingRuntimeConfiguration = { console, destinations }
    const fingerprint = createHmac('sha256', deps.reviewKey)
      .update(
        stable([
          settings,
          rows,
          definitions.map(definition => ({ key: definition.key, props: definition.props, defaultLevel: definition.defaultLevel })),
          authority
        ])
      )
      .digest('hex')
    return { authority, settings, rows, loggerByKey, definitions, metadata, console, runtimeConfiguration, fingerprint }
  }

  const lockedState = async (tx: Knex.Transaction, requester: SystemRequester): Promise<LoggingReviewState> => {
    await tx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [POLICY_FENCE])
    const initial = await state(tx, requester, true)
    if (initial.authority.actorId !== null) {
      await tx('userGroups').where('userId', initial.authority.actorId).whereIn('groupId', initial.authority.ids).forShare()
    }
    return state(tx, requester, true)
  }

  const destination = (definition: LoggerDefinition, row: LoggerRow | undefined, runtime: LoggingRuntimeObservation): LoggingDestination => {
    const fields = fieldsFor(definition)
    const config = record(row?.config)
    const publicConfig: LoggingDestination['config'] = {}
    const secrets: Record<string, boolean> = {}
    for (const field of fields) {
      const stored = scalar(unwrapStoredValue(config[field.key]))
      if (field.sensitive) {
        secrets[field.key] = typeof stored === 'string' && stored.trim().length > 0
      } else if (stored !== undefined) {
        publicConfig[field.key] = stored
      } else {
        const property = definition.props?.[field.key]
        const fallback = scalar(unwrapStoredValue(property?.default))
        if (fallback !== undefined) publicConfig[field.key] = fallback
      }
    }
    const observed = runtime.destinations[definition.key]
    return {
      key: definition.key,
      title: typeof definition.title === 'string' && definition.title.trim() ? definition.title : definition.key,
      description: typeof definition.description === 'string' && definition.description.trim() ? definition.description : null,
      logo: typeof definition.logo === 'string' && definition.logo.trim() ? definition.logo : null,
      website: typeof definition.website === 'string' && definition.website.trim() ? definition.website : null,
      availability: isAvailable(definition.key) ? 'available' : 'unavailable',
      availabilityReason: availabilityReason(definition.key),
      isEnabled: row?.isEnabled === true,
      level: loggingLevel(row?.level ?? definition.defaultLevel),
      fields,
      config: publicConfig,
      secrets,
      runtime: observed ?? { state: 'unapplied', message: 'Saved destination settings have not been reconciled in this process.' }
    }
  }

  const present = (current: LoggingReviewState): LoggingWorkspace => {
    const runtime = deps.runtime().loggingRuntime()
    const runtimeKey = loggingRuntimeKey(deps.reviewKey, current.runtimeConfiguration)
    const runtimeSnapshot: LoggingRuntimeSnapshot = {
      settingsCurrent: runtime.configurationKey === runtimeKey && runtime.state === 'ready',
      state: runtime.state,
      observedAt: runtime.observedAt,
      console: { ...runtime.console },
      message: runtime.message
    }
    return {
      fingerprint: current.fingerprint,
      revision: typeof current.metadata.revision === 'string' ? current.metadata.revision : '',
      observedAt: now().toISOString(),
      console: current.console,
      destinations: current.definitions.map(definition => destination(definition, current.loggerByKey[definition.key], runtime)),
      runtime: runtimeSnapshot,
      history: history(current.metadata),
      liveTrail: {
        enabled: true,
        ...LIVE_TRAIL_LIMITS,
        message:
          'The live trail is a privileged, ephemeral diagnostic view. It redacts common credentials, truncates each message and retains no server-side history.'
      }
    }
  }

  const inspect = async (requester: SystemRequester): Promise<LoggingWorkspace> => {
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

  const applyDestinationDraft = (current: LoggerRow, definition: LoggerDefinition, draft: LoggingDestinationDraft): { row: LoggerRow; changed: string[] } => {
    const fields = fieldsFor(definition)
    const expectedConfig = fields
      .filter(field => !field.sensitive)
      .map(field => field.key)
      .sort()
    const expectedSecrets = fields
      .filter(field => field.sensitive)
      .map(field => field.key)
      .sort()
    if (!same(Object.keys(draft.config).sort(), expectedConfig) || !same(Object.keys(draft.secrets).sort(), expectedSecrets))
      fail(`Reload ${typeof definition.title === 'string' ? definition.title : definition.key} before saving its configuration.`)

    if (!isAvailable(draft.key)) {
      if (draft.isEnabled) fail(`${typeof definition.title === 'string' ? definition.title : draft.key} is unavailable in this release and cannot be enabled.`)
      if (Object.values(draft.secrets).some(action => action.action !== 'keep'))
        fail(
          `Historic ${typeof definition.title === 'string' ? definition.title : draft.key} credentials cannot be changed because this destination is unavailable.`
        )
      return {
        row: { ...current, isEnabled: false },
        changed: current.isEnabled ? [`destinations.${draft.key}.enabled`] : []
      }
    }

    const currentConfig = record(current.config)
    const normalizedConfig: Record<string, unknown> = { ...currentConfig }
    const changed: string[] = []
    for (const field of fields) {
      const stored = scalar(unwrapStoredValue(currentConfig[field.key]))
      if (field.sensitive) {
        const action =
          draft.secrets[field.key] ??
          fail(`Reload ${typeof definition.title === 'string' ? definition.title : definition.key} before saving its configuration.`)
        if (action.action === 'clear') {
          if (stored !== '') changed.push(`destinations.${draft.key}.${field.key}: cleared`)
          normalizedConfig[field.key] = ''
        } else if (action.action === 'replace') {
          if (draft.key === 'sentry' && field.key === 'key' && !isValidSentryDsn(action.value)) fail('Enter a valid Sentry DSN.')
          if (stored !== action.value) changed.push(`destinations.${draft.key}.${field.key}: replaced`)
          normalizedConfig[field.key] = action.value
        }
      } else {
        const value = normalizeValue(field, draft.config[field.key])
        if (!same(stored, value)) changed.push(`destinations.${draft.key}.${field.key}`)
        normalizedConfig[field.key] = value
      }
    }
    if (draft.isEnabled !== current.isEnabled) changed.push(`destinations.${draft.key}.enabled`)
    if (draft.level !== loggingLevel(current.level ?? definition.defaultLevel)) changed.push(`destinations.${draft.key}.level`)
    const sentryDsn = unwrapStoredValue(normalizedConfig.key)
    if (draft.key === 'sentry' && draft.isEnabled && (typeof sentryDsn !== 'string' || !isValidSentryDsn(sentryDsn)))
      fail('Add a valid Sentry DSN before enabling this destination.')
    return {
      row: { ...current, isEnabled: draft.isEnabled, level: draft.level, config: normalizedConfig },
      changed
    }
  }

  return {
    inspect,
    reviewState: state,
    presentState: present,
    async authorizeLive(requester: SystemRequester): Promise<void> {
      const tx = await deps.db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
      try {
        await state(tx, requester)
        await tx.commit()
      } catch (error) {
        await tx.rollback()
        throw error
      }
    },
    async save(requester: SystemRequester, input: unknown): Promise<{ revision: string; applied: false }> {
      const parsed = LoggingWorkspaceDraftSchema.safeParse(input)
      const draft = parsed.success && parsed.data ? parsed.data : fail('Review the complete logging configuration and provide a reason before saving.')
      return serialize(async () =>
        deps.db.transaction(async tx => {
          const current = await lockedState(tx, requester)
          if (draft.fingerprint !== current.fingerprint) fail('Logging settings or your current authority changed. Reload and review again.', 409)
          if (!same(draft.destinations.map(item => item.key).sort(), current.definitions.map(item => item.key).sort()))
            fail('Logging destinations changed. Reload before saving.', 409)

          const changed: string[] = []
          const updates: LoggerRow[] = []
          for (const definition of current.definitions) {
            const row = current.loggerByKey[definition.key] ?? fail('Logging destinations changed. Reload before saving.', 409)
            const item =
              draft.destinations.find(candidate => candidate.key === definition.key) ?? fail('Logging destinations changed. Reload before saving.', 409)
            const update = applyDestinationDraft(row, definition, item)
            updates.push(update.row)
            changed.push(...update.changed)
          }
          if (draft.console.level !== current.console.level) changed.push('console.level')
          if (draft.console.format !== current.console.format) changed.push('console.format')
          if (changed.length === 0) fail('There are no logging changes to save.')

          const event: LoggingConfigurationEvent = {
            id: randomUUID(),
            createdAt: now().toISOString(),
            actorId: current.authority.actorId,
            apiKeyId: current.authority.apiKeyId,
            reason: draft.reason,
            changed: [...new Set(changed)].sort()
          }
          for (const update of updates) {
            await tx('loggers')
              .where('key', update.key)
              .update({
                isEnabled: update.isEnabled,
                level: update.level,
                config: JSON.stringify(update.config)
              })
          }
          const nextMetadata = { ...current.metadata, revision: event.id, history: [event, ...history(current.metadata)].slice(0, 50) }
          for (const [key, value] of [
            ['logLevel', { v: draft.console.level }],
            ['logFormat', { v: draft.console.format }],
            ['loggingAdministration', nextMetadata]
          ] as const) {
            await tx('settings')
              .insert({ key, value: JSON.stringify(value), updatedAt: event.createdAt })
              .onConflict('key')
              .merge(['value', 'updatedAt'])
          }
          return { revision: event.id, applied: false as const }
        })
      )
    },
    async apply(requester: SystemRequester, input: unknown): Promise<{ revision: string; applied: boolean; runtime: LoggingRuntimeSnapshot }> {
      const parsed = LoggingApplySchema.safeParse(input)
      const fingerprint = parsed.success && parsed.data ? parsed.data.fingerprint : fail('Reload logging settings before applying them.')
      return serialize(async () =>
        deps.db.transaction(async tx => {
          const current = await lockedState(tx, requester)
          if (fingerprint !== current.fingerprint) fail('Logging settings or your current authority changed. Reload before applying them.', 409)
          deps.publishConsole(current.console)
          const runtime = await deps.runtime().reconcile(current.runtimeConfiguration, loggingRuntimeKey(deps.reviewKey, current.runtimeConfiguration))
          const workspace = present(current)
          return { revision: workspace.revision, applied: runtime.configurationKey !== null && workspace.runtime.settingsCurrent, runtime: workspace.runtime }
        })
      )
    }
  }
}

let workspaceStore: LoggingWorkspaceStore | undefined

export const getLoggingWorkspaceStore = () => {
  if (workspaceStore) return workspaceStore
  const wiki = (globalThis as typeof globalThis & { WIKI: unknown }).WIKI as {
    config: Record<string, unknown>
    models: { knex: Knex }
    data: { loggers: LoggerDefinition[] }
    logger: ManagedLogger
  }
  workspaceStore = createLoggingWorkspaceStore({
    db: wiki.models.knex,
    reviewKey: typeof wiki.config.sessionSecret === 'string' ? wiki.config.sessionSecret : '',
    fallback: () => wiki.config,
    definitions: () => wiki.data.loggers ?? [],
    runtime: () => wiki.logger,
    publishConsole: console => {
      wiki.config.logLevel = console.level
      wiki.config.logFormat = console.format
    }
  })
  return workspaceStore
}
