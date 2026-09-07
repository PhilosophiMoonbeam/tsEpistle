import { createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import type { Knex } from 'knex'
import { z } from 'zod'
import {
  UtilitiesWorkspaceSchema,
  UtilityHistoryRetentionPeriodSchema,
  UtilityOperationSchema,
  utilityOperationConfirmation,
  utilityOperationTitle,
  type UtilitiesWorkspace,
  type UtilityOperation
} from '../../shared/utilities-workspace.ts'
import { LocaleCodeSchema } from '../../shared/locale-policy.ts'
import { requireSystemAuthority, type SystemRequester } from '../helpers/system-authority.ts'
import authenticationOperations from './authentication.ts'
import importV1Operations, { isConfirmedImportV1UsersFailure } from './import-v1.ts'
import { runUtilityContentImport } from './utility-content-import.ts'
import systemOperations from './system.ts'
import { storageModuleDefinition } from '../repositories/storage-configuration.ts'
import errors from './errors.ts'

const { ApplicationError } = errors
const staleAfterMs = 120_000
const active = new Set<string>()

interface OperationRow extends Omit<UtilityOperation, 'createdAt' | 'heartbeatAt' | 'completedAt' | 'result'> {
  reviewFingerprint: string
  requestFingerprint: string
  createdAt: Date | string
  heartbeatAt: Date | string
  completedAt: Date | string | null
  result: unknown
}
interface Runtime {
  ROOTPATH: string
  config: {
    sessionSecret: string
    offline?: boolean
    telemetry: { isEnabled: boolean; clientId?: unknown }
  }
  data?: { storage?: unknown[] }
  telemetry: { enabled: boolean; generateClientId(): string }
  configSvc: { saveToDb(keys: string[]): Promise<unknown> }
  models: {
    knex: Knex
    pages: { query(): { findById(id: number): Promise<unknown> }; renderPage(page: unknown): Promise<unknown> }
    storage: {
      performAdministrativeOperation<T>(
        before: () => Promise<{ targetKey: string | null; handler: string }>,
        after: (result: unknown) => Promise<T>
      ): Promise<T>
      executeAction(targetKey: string, handler: string): Promise<unknown>
    }
  }
}
interface UtilitiesRuntimeGlobal {
  WIKI: Runtime
}
interface SystemAuthority {
  actorId: number | null
  apiKeyId: number | null
  ids: number[]
  groups: Array<{ id: number; adminRevision: string }>
}
interface SettingRow {
  key: string
  value: unknown
  updatedAt: Date | string
}
interface LocaleRow {
  code: unknown
  name: unknown
}
interface ImportTarget {
  available: boolean
  reason: string | null
}
const utilitiesRuntimeGlobal = globalThis as unknown as UtilitiesRuntimeGlobal
const runtime = () => utilitiesRuntimeGlobal.WIKI
const unknownRecordSchema = z.record(z.string(), z.unknown())
function fail(message: string, status = 400): never {
  throw new ApplicationError(message, { status })
}
const record = (value: unknown): Record<string, unknown> => unknownRecordSchema.safeParse(value).data ?? {}
const timestamp = (value: Date | string) => new Date(value).toISOString()
const result = (value: unknown) => (unknownRecordSchema.safeParse(value).success ? value : null)

const canonical = (value: unknown): string => {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Utilities requests must contain JSON-compatible values.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const parsed = unknownRecordSchema.safeParse(value)
  if (!parsed.success || parsed.data === undefined) fail('Utilities requests must contain JSON-compatible values.')
  const record = parsed.data
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`
}
const inputSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum([
      'auth-certificates',
      'auth-guest-reset',
      'cache-pages',
      'cache-temporary-uploads',
      'content-rebuild-tree',
      'content-rerender',
      'content-migrate-locale',
      'content-purge-history',
      'export',
      'import-v1-users',
      'import-v1-content',
      'telemetry-save',
      'telemetry-reset-client-id'
    ]),
    fingerprint: z.string().length(64),
    reason: z.string().trim().min(3).max(1000),
    confirmation: z.string().max(100),
    acknowledgedUncertainId: z.uuid().optional(),
    payload: z.record(z.string(), z.unknown()).default({})
  })
  .strict()
type StartInput = z.infer<typeof inputSchema>
const requestFingerprint = (input: StartInput): string => createHmac('sha256', runtime().config.sessionSecret).update(canonical(input)).digest('hex')

const isStale = (row: OperationRow, now: Date) =>
  row.state === 'running' && !active.has(row.id) && new Date(row.heartbeatAt).valueOf() + staleAfterMs < now.valueOf()
const present = (row: OperationRow, now: Date): UtilityOperation =>
  UtilityOperationSchema.parse({
    id: row.id,
    kind: row.kind,
    state: isStale(row, now) ? 'uncertain' : row.state,
    phase: isStale(row, now) ? 'interrupted' : row.phase,
    actorId: row.actorId,
    apiKeyId: row.apiKeyId,
    reason: row.reason,
    createdAt: timestamp(row.createdAt),
    heartbeatAt: timestamp(row.heartbeatAt),
    completedAt: row.completedAt ? timestamp(row.completedAt) : null,
    acknowledgedAt: row.acknowledgedAt ? timestamp(row.acknowledgedAt) : null,
    acknowledgedByOperationId: row.acknowledgedByOperationId ?? null,
    progress: row.progress,
    summary: isStale(row, now) ? 'This operation stopped reporting before its outcome was recorded. It has not been repeated.' : row.summary,
    result: result(row.result)
  })

const readSettings = async (tx: Knex.Transaction, lock = false): Promise<SettingRow[]> => {
  const query = tx<SettingRow>('settings').select('key', 'value', 'updatedAt').orderBy('key')
  return lock ? query.forUpdate() : query
}
const readLocales = async (tx: Knex.Transaction, lock = false): Promise<Array<{ code: string; name: string }>> => {
  const query = tx<LocaleRow>('locales').select('code', 'name').orderBy('code'),
    rows = await (lock ? query.forUpdate() : query)
  return rows.map(row => {
    const code = LocaleCodeSchema.safeParse(row.code)
    if (!code.success || code.data === undefined) fail('The installed locale catalog is invalid.', 409)
    const name = z.string().trim().min(1).max(160).safeParse(row.name)
    if (!name.success || name.data === undefined) fail('The installed locale catalog is invalid.', 409)
    return { code: code.data, name: name.data }
  })
}
const importTargets = (): { disk: ImportTarget; git: ImportTarget } => {
  const definitions = (runtime().data?.storage ?? []).map(storageModuleDefinition)
  const target = (key: 'disk' | 'git'): ImportTarget =>
    definitions.some(definition => definition.key === key && definition.isAvailable)
      ? { available: true, reason: null }
      : { available: false, reason: `The ${key === 'git' ? 'Git' : 'disk'} storage target is unavailable in this deployment.` }
  return { disk: target('disk'), git: target('git') }
}
const assertImportTarget = (input: StartInput, status: 400 | 409) => {
  if (input.kind !== 'import-v1-content') return
  const parsed = z.enum(['disk', 'git']).safeParse(record(input.payload).mode)
  if (!parsed.success || parsed.data === undefined) fail('Choose a supported Wiki.js 1.x content source.')
  const mode = parsed.data
  if (!importTargets()[mode].available) fail(`The ${mode === 'git' ? 'Git' : 'disk'} storage target is unavailable in this deployment.`, status)
}
const assertLocaleMigration = (input: StartInput, locales: ReadonlyArray<{ code: string }>, status: 400 | 409) => {
  if (input.kind !== 'content-migrate-locale') return
  const value = record(input.payload),
    sourceLocale = LocaleCodeSchema.parse(value.sourceLocale),
    targetLocale = LocaleCodeSchema.parse(value.targetLocale)
  if (!locales.some(locale => locale.code === sourceLocale) || !locales.some(locale => locale.code === targetLocale))
    fail('Choose source and target locales that are currently installed.', status)
}
const reviewFingerprint = (
  authority: SystemAuthority,
  settings: ReadonlyArray<SettingRow>,
  locales: ReadonlyArray<{ code: string; name: string }>,
  omitStorageAdministration = false
) => {
  const wiki = runtime(),
    reviewedSettings = omitStorageAdministration ? settings.filter(setting => setting.key !== 'storageAdministration') : settings
  return createHmac('sha256', wiki.config.sessionSecret)
    .update(
      canonical({
        actorId: authority.actorId,
        apiKeyId: authority.apiKeyId,
        groupIds: authority.ids,
        groupRevisions: [...authority.groups].sort((left, right) => left.id - right.id).map(group => [group.id, group.adminRevision]),
        settings: reviewedSettings.map(setting => [setting.key, setting.value, timestamp(setting.updatedAt)]),
        locales,
        importTargets: importTargets(),
        offline: wiki.config.offline === true,
        telemetry: {
          enabled: wiki.config.telemetry.isEnabled,
          clientId: typeof wiki.config.telemetry.clientId === 'string' ? wiki.config.telemetry.clientId : null
        }
      })
    )
    .digest('hex')
}

const validatePayload = (input: StartInput) => {
  const value = record(input.payload)
  if (input.confirmation !== utilityOperationConfirmation(input.kind)) fail(`Enter ${utilityOperationConfirmation(input.kind)} to confirm this operation.`)
  if (input.kind === 'content-migrate-locale') {
    const sourceLocale = LocaleCodeSchema.safeParse(value.sourceLocale)
    const targetLocale = LocaleCodeSchema.safeParse(value.targetLocale)
    if (!sourceLocale.success || !targetLocale.success || sourceLocale.data === targetLocale.data) fail('Choose different source and target locales.')
  }
  if (input.kind === 'content-purge-history' && !UtilityHistoryRetentionPeriodSchema.safeParse(value.olderThan).success)
    fail('Choose a supported page history retention period.')
  if (input.kind === 'export') {
    if (
      !z
        .array(z.enum(['assets', 'comments', 'navigation', 'pages', 'history', 'settings', 'groups', 'users']))
        .min(1)
        .safeParse(value.entities).success
    )
      fail('Choose one or more supported export sections.')
    if (!z.string().trim().min(1).max(4096).safeParse(value.path).success) fail('Enter an export folder path.')
  }
  if (input.kind === 'import-v1-users') {
    if (!z.string().min(11).max(4096).safeParse(value.mongoDbConnString).success) fail('Enter a valid Wiki.js 1.x MongoDB connection string.')
    if (!z.enum(['SINGLE', 'MULTI', 'NONE']).safeParse(value.groupMode).success) fail('Choose an imported-user group strategy.')
  }
  if (input.kind === 'import-v1-content') {
    if (!z.enum(['git', 'disk']).safeParse(value.mode).success) fail('Choose a supported Wiki.js 1.x content source.')
    if (value.mode === 'disk' && !z.string().trim().min(1).max(4096).safeParse(value.path).success) fail('Enter a content folder path.')
    if (value.mode === 'git') {
      const git = z
        .object({
          repoUrl: z.string().trim().min(1).max(4096),
          branch: z.string().trim().min(1).max(255),
          authType: z.enum(['ssh', 'basic']),
          privateKey: z.string().max(65536).optional(),
          username: z.string().max(255).optional(),
          password: z.string().max(65536).optional(),
          defaultEmail: z.string().max(254).optional(),
          defaultName: z.string().max(255).optional(),
          localRepoPath: z.string().trim().min(1).max(4096),
          verifySSL: z.boolean()
        })
        .safeParse(value)
      if (
        !git.success ||
        (git.data.authType === 'ssh' && !git.data.privateKey) ||
        (git.data.authType === 'basic' && (!git.data.username || !git.data.password))
      )
        fail('Provide complete Git import credentials and repository settings.')
    }
  }
  if (input.kind === 'telemetry-save' && !z.boolean().safeParse(value.enabled).success) fail('Choose whether to enable telemetry.')
}

export interface UtilitiesWorkspaceStore {
  inspect(requester: SystemRequester): Promise<UtilitiesWorkspace>
  receipt(requester: SystemRequester, id: unknown): Promise<UtilityOperation>
  start(requester: SystemRequester, value: unknown): Promise<UtilityOperation>
}

export const createUtilitiesWorkspaceStore = (db: Knex): UtilitiesWorkspaceStore => {
  const now = () => new Date()
  const fence = async (
    requester: SystemRequester,
    input: StartInput,
    phase: UtilityOperation['phase'] = 'working',
    expectedFingerprint = input.fingerprint,
    omitStorageAdministration = false
  ): Promise<string> =>
    await db.transaction(async tx => {
      const authority = await requireSystemAuthority(tx, requester, true)
      const settings = await readSettings(tx, true)
      const locales = await readLocales(tx, true)
      if (reviewFingerprint(authority, settings, locales, omitStorageAdministration) !== expectedFingerprint)
        fail('Utilities settings or current system authority changed. Reload and review again.', 409)
      assertLocaleMigration(input, locales, 409)
      assertImportTarget(input, 409)
      const row = await tx<OperationRow>('utilitiesOperations').where('id', input.id).forUpdate().first()
      if (!row || row.state !== 'running') fail('This utilities operation is no longer active.', 409)
      await tx('utilitiesOperations').where('id', input.id).update({ phase, heartbeatAt: now().toISOString() })
      return reviewFingerprint(authority, settings, locales, true)
    })
  const finish = async (id: string, value: { summary: string; result?: UtilityOperation['result']; progress?: number }) => {
    const completedAt = now().toISOString()
    await db('utilitiesOperations')
      .where({ id, state: 'running' })
      .update({
        state: 'succeeded',
        phase: 'complete',
        heartbeatAt: completedAt,
        completedAt,
        progress: value.progress ?? 100,
        summary: value.summary,
        result: value.result ?? null
      })
  }
  const failKnownOutcome = async (id: string, value: { summary: string; result?: UtilityOperation['result'] }) => {
    const completedAt = now().toISOString()
    await db('utilitiesOperations')
      .where({ id, state: 'running' })
      .update({
        state: 'failed',
        phase: 'complete',
        heartbeatAt: completedAt,
        completedAt,
        progress: 100,
        summary: value.summary,
        result: value.result ?? null
      })
  }
  const observeExport = async (id: string, effect: Promise<void>) => {
    let completed = false
    while (!completed) {
      completed = await Promise.race([effect.then(() => true), delay(1_000).then(() => false)])
      const status = systemOperations.getExportStatus()
      const progress = typeof status.progress === 'number' && Number.isFinite(status.progress) ? Math.max(0, Math.min(100, status.progress)) : null
      try {
        await db('utilitiesOperations')
          .where({ id, state: 'running' })
          .update({
            phase: 'working',
            heartbeatAt: now().toISOString(),
            ...(progress === null ? {} : { progress }),
            summary: 'The local export service is running. Its destination is intentionally not retained in this receipt.'
          })
      } catch {
        // The export continues to be owned until its promise settles; a later durable update can still record its outcome.
      }
    }
    if (systemOperations.getExportStatus().status === 'success') {
      await finish(id, { summary: 'The local export completed successfully. Its destination is intentionally not retained in this receipt.' })
      return
    }
    await failKnownOutcome(id, {
      summary: 'The local export service reported an error. Inspect its destination and application logs before deciding whether to make a new request.'
    })
  }

  const stop = async (id: string, afterEffect: boolean) => {
    const completedAt = now().toISOString()
    await db('utilitiesOperations')
      .where({ id, state: 'running' })
      .update({
        state: afterEffect ? 'uncertain' : 'failed',
        phase: afterEffect ? 'interrupted' : 'complete',
        heartbeatAt: completedAt,
        completedAt,
        summary: afterEffect
          ? 'The final outcome could not be confirmed. Inspect the affected service or data before another request; this operation has not been replayed.'
          : 'Current authority or reviewed settings could not be confirmed before the operation started. No utility effect was requested.',
        result: null
      })
  }
  const current = async (requester: SystemRequester) => {
    const tx = await db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
    try {
      const authority = await requireSystemAuthority(tx, requester)
      const settings = await readSettings(tx)
      const locales = await readLocales(tx)
      const rows = await tx<OperationRow>('utilitiesOperations').orderBy('createdAt', 'desc').orderBy('id', 'desc').limit(50)
      const workspace = UtilitiesWorkspaceSchema.parse({
        observedAt: now().toISOString(),
        fingerprint: reviewFingerprint(authority, settings, locales),
        telemetry: {
          enabled: runtime().config.telemetry.isEnabled,
          clientId: typeof runtime().config.telemetry.clientId === 'string' ? runtime().config.telemetry.clientId : null
        },
        importTargets: importTargets(),
        locales,
        operations: rows.map(row => present(row, now()))
      })
      await tx.commit()
      return workspace
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }
  const execute = async (requester: SystemRequester, input: StartInput) => {
    let effectStarted = false
    let importEffectFingerprint: string | undefined
    const fenceEffect = async () => {
      const fingerprint = await fence(requester, input, 'working', importEffectFingerprint ?? input.fingerprint, importEffectFingerprint !== undefined)
      if (input.kind === 'import-v1-content' && importEffectFingerprint === undefined) importEffectFingerprint = fingerprint
      effectStarted = true
    }
    try {
      await fence(requester, input, 'reviewing')
      const payload = record(input.payload)
      switch (input.kind) {
        case 'auth-certificates': {
          await fenceEffect()
          const rotated = await authenticationOperations.regenerateCertificates(requester)
          await finish(input.id, {
            summary: `Authentication certificates were regenerated and ${rotated.revokedApiKeys} API ${rotated.revokedApiKeys === 1 ? 'key was' : 'keys were'} revoked. Existing signed-in sessions must authenticate again.`
          })
          break
        }
        case 'auth-guest-reset':
          await fenceEffect()
          await authenticationOperations.resetGuestUser(requester)
          await finish(input.id, { summary: 'Guest access was reset to the configured defaults.' })
          break
        case 'cache-pages':
          await fenceEffect()
          await systemOperations.flushPageCache()
          await finish(input.id, { summary: 'Pages and assets cache was flushed.' })
          break
        case 'cache-temporary-uploads':
          await fenceEffect()
          await systemOperations.flushTemporaryUploads()
          await finish(input.id, { summary: 'Temporary uploads were deleted.' })
          break
        case 'content-rebuild-tree':
          await fenceEffect()
          await systemOperations.rebuildPageTree()
          await finish(input.id, { summary: 'The page tree was rebuilt.' })
          break
        case 'content-rerender': {
          const pages = await db<{ id: number }>('pages').select('id').orderBy('id')
          let processed = 0
          for (const page of pages) {
            await fenceEffect()
            await systemOperations.renderPage(page.id)
            processed += 1
            await db('utilitiesOperations')
              .where({ id: input.id, state: 'running' })
              .update({ progress: Math.round((processed / Math.max(pages.length, 1)) * 100), heartbeatAt: now().toISOString() })
          }
          await finish(input.id, {
            summary: `Rendering completed for ${processed} page${processed === 1 ? '' : 's'}.`,
            result: { processed, succeeded: processed, failed: 0 },
            progress: 100
          })
          break
        }
        case 'content-migrate-locale': {
          const requesterUser = requester.user as Record<string, unknown>
          if (typeof requesterUser.id !== 'number' || typeof requesterUser.name !== 'string' || typeof requesterUser.email !== 'string')
            fail('A current interactive administrator sign-in is required for a page locale migration.', 403)
          await fenceEffect()
          const count = await systemOperations.migratePagesToLocale({
            sourceLocale: payload.sourceLocale,
            targetLocale: payload.targetLocale,
            requester: requester.user
          })
          await finish(input.id, {
            summary: `Migrated ${count} eligible page${count === 1 ? '' : 's'} without overwriting target pages.`,
            result: { processed: count, succeeded: count, failed: 0 }
          })
          break
        }
        case 'content-purge-history':
          await fenceEffect()
          await systemOperations.purgePageHistory(payload.olderThan)
          await finish(input.id, { summary: 'Selected page history was purged. Storage-module history was not changed.' })
          break
        case 'export': {
          const effect = systemOperations.startExport({ entities: payload.entities, exportPath: payload.path }, fenceEffect)
          await observeExport(input.id, effect)
          break
        }
        case 'import-v1-users': {
          await fenceEffect()
          try {
            const imported = await importV1Operations.importUsers({ mongoDbConnString: payload.mongoDbConnString, groupMode: payload.groupMode })
            const aggregate = {
              processed: imported.usersCount + imported.failed.length,
              succeeded: imported.usersCount,
              failed: imported.failed.length,
              skipped: imported.failed.length
            }
            if (imported.failed.length === 0) {
              await finish(input.id, {
                summary: `Wiki.js 1.x user import completed with ${imported.usersCount} imported user records.`,
                result: aggregate
              })
            } else {
              await failKnownOutcome(input.id, {
                summary: `Wiki.js 1.x user import completed partially with ${imported.usersCount} imported records and ${imported.failed.length} skipped or failed records.`,
                result: aggregate
              })
            }
          } catch (error) {
            if (!isConfirmedImportV1UsersFailure(error)) throw error
            await failKnownOutcome(input.id, { summary: 'The legacy database could not be read before any user or group record was imported.' })
          }
          break
        }
        case 'import-v1-content': {
          const imported = await runUtilityContentImport(requester, payload, input.reason, fenceEffect)
          const counts = imported.counts,
            aggregate = counts ? { processed: counts.total, succeeded: counts.succeeded, failed: counts.failed } : null
          if (imported.outcome === 'succeeded') {
            await finish(input.id, {
              summary: `Content import completed: ${counts?.succeeded ?? 0} of ${counts?.total ?? 0} items imported.`,
              result: aggregate
            })
          } else {
            await failKnownOutcome(input.id, {
              summary:
                imported.outcome === 'partial'
                  ? `Content import completed partially: ${counts?.succeeded ?? 0} of ${counts?.total ?? 0} items imported and ${counts?.failed ?? 0} failed.`
                  : 'Content import failed before any content could be confirmed.',
              result: aggregate
            })
          }
          break
        }
        case 'telemetry-save': {
          await fence(requester, input)
          const wiki = runtime(),
            nextEnabled = payload.enabled === true,
            previousEnabled = wiki.config.telemetry.isEnabled
          wiki.config.telemetry.isEnabled = nextEnabled
          try {
            const saved = await wiki.configSvc.saveToDb(['telemetry'])
            if (saved === false) throw new Error('Telemetry preference could not be persisted.')
          } catch (error) {
            wiki.config.telemetry.isEnabled = previousEnabled
            throw error
          }
          effectStarted = true
          wiki.telemetry.enabled = nextEnabled
          await finish(input.id, { summary: `Telemetry was ${nextEnabled ? 'enabled' : 'disabled'} after its saved preference was applied.` })
          break
        }
        case 'telemetry-reset-client-id': {
          await fence(requester, input)
          const wiki = runtime(),
            telemetry = wiki.config.telemetry,
            hadClientId = Object.hasOwn(telemetry, 'clientId'),
            previousClientId = telemetry.clientId
          try {
            wiki.telemetry.generateClientId()
            const saved = await wiki.configSvc.saveToDb(['telemetry'])
            if (saved === false) throw new Error('Telemetry client ID could not be persisted.')
          } catch (error) {
            if (hadClientId) telemetry.clientId = previousClientId
            else delete telemetry.clientId
            throw error
          }
          effectStarted = true
          await finish(input.id, { summary: 'A new telemetry client ID was saved. The previous ID is not retained in this receipt.' })
          break
        }
      }
    } catch {
      await stop(input.id, effectStarted)
    } finally {
      active.delete(input.id)
    }
  }
  return {
    inspect: (requester: SystemRequester): Promise<UtilitiesWorkspace> => current(requester),
    async receipt(requester: SystemRequester, id: unknown): Promise<UtilityOperation> {
      const parsed = z.uuid().safeParse(id)
      if (!parsed.success || !parsed.data) throw new ApplicationError('Choose a valid Utilities operation identifier.', { status: 404 })
      const tx = await db.transaction({ isolationLevel: 'repeatable read', readOnly: true })
      try {
        await requireSystemAuthority(tx, requester)
        const row = await tx<OperationRow>('utilitiesOperations').where('id', parsed.data).first()
        if (!row) throw new ApplicationError('This Utilities operation has not been recorded.', { status: 404 })
        const view = present(row, now())
        await tx.commit()
        return view
      } catch (error) {
        await tx.rollback()
        throw error
      }
    },
    async start(requester: SystemRequester, value: unknown): Promise<UtilityOperation> {
      const parsed = inputSchema.safeParse(value)
      if (!parsed.success || !parsed.data)
        throw new ApplicationError('Provide a current review, meaningful reason, operation identifier and exact confirmation.')
      const input: StartInput = parsed.data
      validatePayload(input)
      const fingerprint = requestFingerprint(input)
      const requested = await db.transaction(async tx => {
        const authority = await requireSystemAuthority(tx, requester, true)
        const existing = await tx<OperationRow>('utilitiesOperations').where('id', input.id).forUpdate().first()
        if (existing) {
          if (
            existing.kind !== input.kind ||
            existing.actorId !== authority.actorId ||
            existing.apiKeyId !== authority.apiKeyId ||
            existing.requestFingerprint !== fingerprint
          )
            fail('This operation identifier belongs to a different reviewed request.', 409)
          return { row: existing, started: false }
        }
        const settings = await readSettings(tx, true)
        const locales = await readLocales(tx, true)
        if (reviewFingerprint(authority, settings, locales) !== input.fingerprint)
          fail('Utilities settings or current system authority changed. Reload and review again.', 409)
        assertLocaleMigration(input, locales, 400)
        assertImportTarget(input, 409)
        const at = now()
        const running = await tx<OperationRow>('utilitiesOperations').where('state', 'running').forUpdate()
        for (const row of running) {
          if (!isStale(row, at)) fail('Another Utilities operation is still active. Inspect its receipt before starting another action.', 409)
          await tx('utilitiesOperations').where('id', row.id).update({
            state: 'uncertain',
            phase: 'interrupted',
            completedAt: at.toISOString(),
            heartbeatAt: at.toISOString(),
            summary: 'This operation stopped reporting before its outcome was recorded. It has not been repeated.'
          })
        }
        const previous = await tx<OperationRow>('utilitiesOperations')
          .where('state', 'uncertain')
          .whereNull('acknowledgedAt')
          .orderBy('createdAt', 'desc')
          .orderBy('id', 'desc')
          .forUpdate()
          .first()
        if (previous && input.acknowledgedUncertainId !== previous.id)
          fail('Inspect and acknowledge the latest uncertain Utilities receipt before requesting another action.', 409)
        if (!previous && input.acknowledgedUncertainId)
          fail('The referenced uncertain Utilities receipt is already acknowledged. Reload before requesting another action.', 409)
        if (previous) {
          await tx('utilitiesOperations')
            .where({ id: previous.id, state: 'uncertain' })
            .whereNull('acknowledgedAt')
            .update({ acknowledgedAt: at.toISOString(), acknowledgedByOperationId: input.id })
        }
        const row: OperationRow = {
          id: input.id,
          kind: input.kind,
          state: 'running',
          phase: 'queued',
          actorId: authority.actorId,
          apiKeyId: authority.apiKeyId,
          reason: input.reason,
          reviewFingerprint: input.fingerprint,
          requestFingerprint: fingerprint,
          createdAt: at.toISOString(),
          heartbeatAt: at.toISOString(),
          completedAt: null,
          acknowledgedAt: null,
          acknowledgedByOperationId: null,
          progress: null,
          summary: `${utilityOperationTitle(input.kind)} was recorded and is waiting to start.`,
          result: null
        }
        await tx('utilitiesOperations').insert(row)
        return { row, started: true }
      })
      if (requested.started) {
        active.add(input.id)
        void execute(requester, input)
      }
      return present(requested.row, now())
    }
  }
}

let database: Knex | undefined, store: UtilitiesWorkspaceStore | undefined
export const getUtilitiesWorkspaceStore = () => {
  const db = runtime().models.knex
  if (!store || database !== db) {
    database = db
    store = createUtilitiesWorkspaceStore(db)
  }
  return store
}
