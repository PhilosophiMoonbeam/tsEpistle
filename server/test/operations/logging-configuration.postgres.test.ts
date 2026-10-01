import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createLoggingWorkspaceStore, type LoggingWorkspaceStore } from '../../operations/logging.ts'
import type { LoggingRuntimeConfiguration, LoggingRuntimeObservation } from '../../core/logger.ts'
import commonHelper from '../../helpers/common.ts'
import { readModuleDefinition } from '../../models/moduleTypes.ts'
import type { LoggingWorkspace } from '../../../shared/logging-workspace.ts'
import type { SystemRequester } from '../../helpers/system-authority.ts'
import { createApiPrincipal } from '../../helpers/api-principal.ts'

const connection = getPostgresTestConnection('_logging_test', import.meta.path)
const apiAdmin: SystemRequester = {
  user: createApiPrincipal(21, 3, ['manage:system']),
  apiKey: { id: 21, groupId: 3, expiresAt: Math.floor(new Date('2026-02-02T00:00:00.000Z').getTime() / 1000) }
}
const suite = connection ? describe : describe.skip
const admin: SystemRequester = { user: { id: 1, authVersion: 0 } as never }

const emptyRuntime = (): LoggingRuntimeObservation => ({
  configurationKey: null,
  state: 'unapplied',
  observedAt: null,
  console: { level: null, format: null },
  destinations: {},
  message: 'Saved logging settings have not been reconciled in this process.'
})

suite('Reviewed Logging configuration on PostgreSQL', () => {
  let db: Knex
  let runtime: LoggingRuntimeObservation
  let store: LoggingWorkspaceStore
  const setting = (key: string, value: unknown) =>
    db('settings')
      .insert({ key, value: JSON.stringify(value), updatedAt: new Date().toISOString() })
      .onConflict('key')
      .merge(['value', 'updatedAt'])
  const inspect = (requester = admin) => store.inspect(requester)
  const draft = (workspace: LoggingWorkspace, options: { dsn?: 'keep' | 'clear' | string; level?: string; format?: string; sentryEnabled?: boolean } = {}) => ({
    fingerprint: workspace.fingerprint,
    reason: 'Review structured logging',
    console: { level: options.level ?? workspace.console.level, format: options.format ?? workspace.console.format },
    destinations: workspace.destinations.map(destination => ({
      key: destination.key,
      isEnabled: destination.key === 'sentry' && options.sentryEnabled !== undefined ? options.sentryEnabled : destination.isEnabled,
      level: destination.level,
      config: destination.config,
      secrets: Object.fromEntries(
        Object.keys(destination.secrets).map(key => [
          key,
          destination.key === 'sentry' && key === 'key'
            ? options.dsn === 'clear'
              ? { action: 'clear' }
              : typeof options.dsn === 'string' && options.dsn !== 'keep'
                ? { action: 'replace', value: options.dsn }
                : { action: 'keep' }
            : { action: 'keep' }
        ])
      )
    }))
  })

  const fixtureDefinitions = () =>
    [
      { key: 'disk', title: 'Log Files', defaultLevel: 'info', props: {} },
      { key: 'sentry', title: 'Sentry', defaultLevel: 'warn', props: { key: { type: 'String', title: 'DSN', sensitive: true } } }
    ] as never
  const reconcileRuntime = async (configuration: LoggingRuntimeConfiguration, key: string): Promise<LoggingRuntimeObservation> => {
    runtime = {
      configurationKey: key,
      state: 'ready',
      observedAt: '2026-02-01T00:00:00.000Z',
      console: configuration.console,
      destinations: Object.fromEntries(
        configuration.destinations.map(destination => [
          destination.key,
          {
            state: destination.isEnabled ? 'active' : 'inactive',
            message: null
          }
        ])
      ),
      message: null
    }
    return structuredClone(runtime)
  }
  const makeStore = (definitions = fixtureDefinitions, reconcile = reconcileRuntime, database = db): LoggingWorkspaceStore =>
    createLoggingWorkspaceStore({
      db: database,
      reviewKey: 'fixture-only-review-key',
      fallback: () => ({ logLevel: 'warn', logFormat: 'json', sessionSecret: 'fixture-only-review-key' }),
      definitions: () => definitions() as never,
      runtime: () =>
        ({
          loggingRuntime: () => structuredClone(runtime),
          reconcile
        }) as never,
      publishConsole: () => undefined,
      now: () => new Date('2026-02-01T00:00:00.000Z')
    })
  const parsedProductionDefinitions = async () => {
    const directory = fileURLToPath(new URL('../../modules/logging/', import.meta.url))
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
    return await Promise.all(
      entries.map(async entry => {
        const source = path.join(directory, entry.name, 'definition.yml')
        const definition = readModuleDefinition(yaml.load(await readFile(source, 'utf8')), source)
        return { ...definition, props: commonHelper.parseModuleProps(definition.props) }
      })
    )
  }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 6 } })
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.jsonb('value').notNullable()
      table.string('updatedAt').notNullable()
    })
    await db.schema.createTable('loggers', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.string('level').notNullable()
      table.jsonb('config').notNullable()
    })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive')
      table.integer('authVersion')
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.jsonb('permissions')
      table.string('adminRevision')
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId')
      table.integer('groupId')
    })
    await db.schema.createTable('apiKeys', table => {
      table.integer('id').primary()
      table.boolean('isRevoked')
      table.string('expiration')
    })
  })

  afterAll(async () => {
    if (!db) return
    for (const table of ['settings', 'loggers', 'userGroups', 'groups', 'users', 'apiKeys']) await db.schema.dropTableIfExists(table)
    await db.destroy()
  })

  beforeEach(async () => {
    for (const table of ['settings', 'loggers', 'userGroups', 'groups', 'users', 'apiKeys']) await db(table).delete()
    await db('users').insert({ id: 1, isActive: true, authVersion: 0 })
    await db('groups').insert([
      { id: 1, permissions: JSON.stringify(['manage:system']), adminRevision: 'initial' },
      { id: 3, permissions: JSON.stringify(['manage:system']), adminRevision: 'api-initial' }
    ])
    await db('userGroups').insert({ userId: 1, groupId: 1 })
    await setting('logLevel', { v: 'info' })
    await setting('logFormat', { v: 'default' })
    await db('loggers').insert([
      { key: 'disk', isEnabled: false, level: 'info', config: JSON.stringify({ path: '/unowned/log-path' }) },
      {
        key: 'sentry',
        isEnabled: false,
        level: 'warn',
        config: JSON.stringify({ key: 'https://stored-secret@example.ingest.sentry.io/1', untouched: 'private-unowned-value' })
      }
    ])
    runtime = emptyRuntime()
    store = makeStore()
  })

  it('omits credentials, exposes unavailable legacy destinations, and distinguishes saved policy from runtime', async () => {
    const workspace = await inspect()
    expect(JSON.stringify(workspace)).not.toContain('stored-secret')
    expect(JSON.stringify(workspace)).not.toContain('private-unowned-value')
    expect(workspace.destinations.find(destination => destination.key === 'sentry')).toMatchObject({ availability: 'available', secrets: { key: true } })
    expect(workspace.destinations.find(destination => destination.key === 'disk')).toMatchObject({ availability: 'unavailable', isEnabled: false })
    expect(workspace.runtime.settingsCurrent).toBe(false)
  })

  it('preserves legacy JSON scalar settings exactly', async () => {
    await db('settings')
      .where('key', 'logLevel')
      .update({ value: JSON.stringify('debug') })
    await db('settings')
      .where('key', 'logFormat')
      .update({ value: JSON.stringify('json') })

    expect((await inspect()).console).toEqual({ level: 'debug', format: 'json' })
  })

  it('projects production-parsed Papertrail field types and exact scalar values', async () => {
    await db('loggers').insert({ key: 'papertrail', isEnabled: false, level: 'warn', config: JSON.stringify({ host: 'logs.example.test', port: 1514 }) })
    const definitions = await parsedProductionDefinitions()
    const productionStore = makeStore(() => definitions as never)
    const workspace = await productionStore.inspect(admin)
    const papertrail = workspace.destinations.find(destination => destination.key === 'papertrail')

    expect(papertrail?.fields.find(field => field.key === 'port')?.type).toBe('number')
    expect(papertrail).toMatchObject({
      config: { host: 'logs.example.test', port: 1514 }
    })
  })

  it('serializes concurrent first writes from independent stores', async () => {
    const before = await inspect()
    const secondStore = makeStore()
    expect(await db('settings').where('key', 'loggingAdministration').first()).toBeUndefined()

    const results = await Promise.allSettled([store.save(admin, draft(before, { level: 'error' })), secondStore.save(admin, draft(before, { level: 'debug' }))])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected').map(result => (result.status === 'rejected' ? result.reason.status : null))).toEqual([409])
    expect((await inspect()).history).toHaveLength(1)
  })

  it('holds the cross-process policy fence through reconciliation before a concurrent save', async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const slowStore = makeStore(fixtureDefinitions, async (configuration, key) => {
      started.resolve()
      await release.promise
      return reconcileRuntime(configuration, key)
    })
    const before = await inspect()
    const savingDb = knexModule({
      client: 'pg',
      connection: { ...connection!, application_name: 'logging-concurrent-save-fixture' },
      pool: { min: 0, max: 1 }
    })
    const applying = slowStore.apply(admin, { fingerprint: before.fingerprint })
    let saving: Promise<unknown> | undefined
    let saveSettled = false
    try {
      await Promise.race([started.promise, applying])
      saving = makeStore(fixtureDefinitions, reconcileRuntime, savingDb).save(admin, draft(before, { level: 'debug' }))
      void saving.then(() => { saveSettled = true }, () => { saveSettled = true })
      await vi.waitFor(async () => {
        const blocked = await db.raw(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name = ? AND wait_event_type = 'Lock' AND cardinality(pg_blocking_pids(pid)) > 0) AS blocked",
          ['logging-concurrent-save-fixture']
        )
        expect(blocked.rows).toEqual([{ blocked: true }])
        expect(saveSettled).toBe(false)
      }, { timeout: 3000 })
      release.resolve()
      await applying
      await saving
      const after = await inspect()
      expect(after.console.level).toBe('debug')
      expect(after.runtime).toMatchObject({ settingsCurrent: false, console: { level: 'info', format: 'default' } })
    } finally {
      release.resolve()
      await Promise.allSettled([applying, saving])
      await savingDb.destroy()
    }
  })

  it('atomically persists the reviewed console and Sentry policy before runtime application', async () => {
    const before = await inspect()
    const saved = await store.save(
      admin,
      draft(before, { dsn: 'https://replacement@example.ingest.sentry.io/2', sentryEnabled: true, level: 'debug', format: 'json' })
    )
    const storedSentry = await db('loggers').where('key', 'sentry').first()
    const afterSave = await inspect()
    expect(saved.applied).toBe(false)
    expect(storedSentry.config).toMatchObject({ key: 'https://replacement@example.ingest.sentry.io/2', untouched: 'private-unowned-value' })
    expect(afterSave.console).toEqual({ level: 'debug', format: 'json' })
    expect(afterSave.runtime.settingsCurrent).toBe(false)
    expect(afterSave.history[0]).toMatchObject({ actorId: 1, reason: 'Review structured logging' })
    expect(afterSave.history[0].changed).toEqual(
      expect.arrayContaining(['console.format', 'console.level', 'destinations.sentry.enabled', 'destinations.sentry.key: replaced'])
    )

    const applied = await store.apply(admin, { fingerprint: afterSave.fingerprint })
    expect(applied.applied).toBe(true)
    expect((await inspect()).runtime).toMatchObject({ settingsCurrent: true, console: { level: 'debug', format: 'json' } })
  })

  it('clears a stored destination credential without exposing its prior value', async () => {
    const before = await inspect()
    await store.save(admin, draft(before, { dsn: 'clear' }))

    expect((await db('loggers').where('key', 'sentry').first()).config).toMatchObject({ key: '' })
    const workspace = await inspect()
    expect(workspace.destinations.find(destination => destination.key === 'sentry')?.secrets).toMatchObject({ key: false })
    expect(workspace.history[0]?.changed).toContain('destinations.sentry.key: cleared')
  })

  it('preserves kept secrets, rejects stale ABA saves and applies, and never permits unsupported activation', async () => {
    await store.save(admin, draft(await inspect(), { level: 'warn' }))
    const before = await inspect()
    await store.save(admin, draft(before, { level: 'error' }))
    expect((await db('loggers').where('key', 'sentry').first()).config).toMatchObject({
      key: 'https://stored-secret@example.ingest.sentry.io/1',
      untouched: 'private-unowned-value'
    })
    const first = await inspect()
    await store.save(admin, draft(first, { level: before.console.level }))
    await expect(store.save(admin, draft(before, { level: 'debug' }))).rejects.toMatchObject({ status: 409 })
    await expect(store.apply(admin, { fingerprint: before.fingerprint })).rejects.toMatchObject({ status: 409 })
    const unavailable = await inspect()
    const invalid = draft(unavailable)
    invalid.destinations.find(destination => destination.key === 'disk')!.isEnabled = true
    await expect(store.save(admin, invalid)).rejects.toMatchObject({ status: 400 })
    expect((await db('loggers').where('key', 'disk').first()).isEnabled).toBe(false)
  })

  it('preserves accepted Sentry DSN bytes while rejecting blank replacements and reporting them absent', async () => {
    const before = await inspect()
    const replacement = 'https://replacement@example.ingest.sentry.io/2?source=reviewed'
    await store.save(admin, draft(before, { dsn: replacement }))
    expect((await db('loggers').where('key', 'sentry').first()).config).toMatchObject({ key: replacement })

    const saved = await inspect()
    const beforeInvalid = await db('loggers').where('key', 'sentry').first()
    await expect(store.save(admin, draft(saved, { dsn: '   ' }))).rejects.toMatchObject({ status: 400 })
    expect(await db('loggers').where('key', 'sentry').first()).toEqual(beforeInvalid)
    expect((await inspect()).history).toEqual(saved.history)
    await db('loggers')
      .where('key', 'sentry')
      .update({
        config: JSON.stringify({ key: '   ', untouched: 'private-unowned-value' })
      })

    const whitespace = await inspect()
    expect(whitespace.destinations.find(destination => destination.key === 'sentry')?.secrets).toMatchObject({ key: false })
    const beforeEnable = await db('loggers').where('key', 'sentry').first()
    await expect(store.save(admin, draft(whitespace, { sentryEnabled: true }))).rejects.toMatchObject({ status: 400 })
    expect(await db('loggers').where('key', 'sentry').first()).toEqual(beforeEnable)
    expect((await inspect()).history).toEqual(whitespace.history)
  })

  it('requires a present Sentry DSN before enabling and rolls back every row if the history record fails', async () => {
    const noDsn = draft(await inspect(), { dsn: 'clear', sentryEnabled: true })
    await expect(store.save(admin, noDsn)).rejects.toMatchObject({ status: 400 })
    await db.raw("ALTER TABLE settings ADD CONSTRAINT logging_fixture_history_reject CHECK (key <> 'loggingAdministration')")
    try {
      const before = await inspect()
      await expect(store.save(admin, draft(before, { level: 'error', sentryEnabled: true, dsn: 'https://replacement@example.ingest.sentry.io/2' }))).rejects.toThrow()
      expect((await inspect()).console.level).toBe('info')
      expect(await db('loggers').where('key', 'sentry').first()).toMatchObject({
        isEnabled: false,
        level: 'warn',
        config: { key: 'https://stored-secret@example.ingest.sentry.io/1', untouched: 'private-unowned-value' }
      })
    } finally {
      await db.raw('ALTER TABLE settings DROP CONSTRAINT logging_fixture_history_reject')
    }
  })

  it('rechecks current system authority before inspection and before application', async () => {
    await db('users').where('id', 1).update({ isActive: false })
    await expect(inspect()).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ isActive: true })
    await db('users').where('id', 1).update({ authVersion: 1 })
    await expect(inspect()).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ authVersion: 0 })
    const workspace = await inspect()
    await db('userGroups').where('userId', 1).delete()
    await expect(store.apply(admin, { fingerprint: workspace.fingerprint })).rejects.toMatchObject({ status: 403 })
  })

  it('allows secret-safe inspection with a real API principal and denies the same cached requester after persisted revocation', async () => {
    await db('apiKeys').insert({ id: 21, isRevoked: false, expiration: '2026-02-02T00:00:00.000Z' })
    const workspace = await inspect(apiAdmin)
    expect(workspace.console).toEqual({ level: 'info', format: 'default' })
    const sentry = workspace.destinations.find(destination => destination.key === 'sentry')
    expect(sentry).toMatchObject({ isEnabled: false, level: 'warn', secrets: { key: true } })
    expect(sentry?.config).toEqual({})
    expect(JSON.stringify(workspace)).not.toContain('stored-secret')
    expect(JSON.stringify(workspace)).not.toContain('private-unowned-value')
    await db('apiKeys').where('id', 21).update({ isRevoked: true })
    await expect(inspect(apiAdmin)).rejects.toMatchObject({ status: 403 })
  })

  it.each(['persisted key expiration', 'JWT expiration', 'persisted group revocation'])('rechecks %s after a successful API inspection', async failure => {
    await db('apiKeys').insert({ id: 21, isRevoked: false, expiration: '2026-02-02T00:00:00.000Z' })
    expect((await inspect(apiAdmin)).console).toEqual({ level: 'info', format: 'default' })
    let requester = apiAdmin
    if (failure === 'persisted key expiration') await db('apiKeys').where('id', 21).update({ expiration: '2026-02-01T00:00:00.000Z' })
    else if (failure === 'JWT expiration') requester = { ...apiAdmin, apiKey: { ...apiAdmin.apiKey!, expiresAt: Date.parse('2026-02-01T00:00:00.000Z') / 1000 } }
    else await db('groups').where('id', 3).update({ permissions: JSON.stringify([]) })
    await expect(inspect(requester)).rejects.toMatchObject({ status: 403 })
  })

  it('rejects missing, malformed and mismatched API credentials and user-shaped hybrids without returning configuration', async () => {
    await db('apiKeys').insert([
      { id: 21, isRevoked: false, expiration: '2026-02-02T00:00:00.000Z' },
      { id: 22, isRevoked: false, expiration: '2026-02-02T00:00:00.000Z' }
    ])
    expect((await inspect(apiAdmin)).console).toEqual({ level: 'info', format: 'default' })
    const before = { settings: await db('settings').orderBy('key'), loggers: await db('loggers').orderBy('key') }
    const invalid: SystemRequester[] = [
      { user: apiAdmin.user },
      { ...apiAdmin, apiKey: { ...apiAdmin.apiKey!, id: NaN } },
      { ...apiAdmin, apiKey: { ...apiAdmin.apiKey!, groupId: 0 } },
      { ...apiAdmin, apiKey: { ...apiAdmin.apiKey!, id: 22 } },
      { ...apiAdmin, apiKey: { ...apiAdmin.apiKey!, groupId: 1 } },
      { ...apiAdmin, apiKey: { ...apiAdmin.apiKey!, expiresAt: null } },
      { ...apiAdmin, user: { ...apiAdmin.user!, id: 1 } as never },
      { ...apiAdmin, user: { ...apiAdmin.user!, ownershipUserId: 1 } as never },
      { ...apiAdmin, user: { ...apiAdmin.user!, groups: [1] } as never },
      { ...apiAdmin, user: { ...apiAdmin.user!, groups: [3, 1] } as never }
    ]
    for (const requester of invalid) await expect(inspect(requester)).rejects.toMatchObject({ status: 403 })
    expect(await db('settings').orderBy('key')).toEqual(before.settings)
    expect(await db('loggers').orderBy('key')).toEqual(before.loggers)
  })
})
