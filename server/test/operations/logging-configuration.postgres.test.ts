import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { createLoggingWorkspaceStore, type LoggingWorkspaceStore } from '../../operations/logging.ts'
import type { LoggingRuntimeConfiguration, LoggingRuntimeObservation } from '../../core/logger.ts'
import commonHelper from '../../helpers/common.ts'
import { readModuleDefinition } from '../../models/moduleTypes.ts'
import type { LoggingWorkspace } from '../../../shared/logging-workspace.ts'
import type { SystemRequester } from '../../helpers/system-authority.ts'

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_logging_test') && password
    ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT), user: 'wiki', database, password }
    : null
const apiAdmin: SystemRequester = {
  user: { id: 1, ownershipUserId: null, groups: [1] } as never,
  apiKey: { id: 7, groupId: 1, expiresAt: Math.floor(new Date('2026-02-02T00:00:00.000Z').getTime() / 1000) }
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
  const makeStore = (definitions = fixtureDefinitions, reconcile = reconcileRuntime): LoggingWorkspaceStore =>
    createLoggingWorkspaceStore({
      db,
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
    await db('groups').insert({ id: 1, permissions: JSON.stringify(['manage:system']), adminRevision: 'initial' })
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

  it('projects all twelve production-parsed definitions with lowercase field types and exact scalar values', async () => {
    await db('loggers').insert({ key: 'papertrail', isEnabled: false, level: 'warn', config: JSON.stringify({ host: 'logs.example.test', port: 1514 }) })
    const definitions = await parsedProductionDefinitions()
    const productionStore = makeStore(() => definitions as never)
    const workspace = await productionStore.inspect(admin)
    const papertrail = workspace.destinations.find(destination => destination.key === 'papertrail')

    expect(definitions).toHaveLength(12)
    expect(workspace.destinations.map(destination => destination.key)).toEqual(definitions.map(definition => definition.key))
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
    const applying = slowStore.apply(admin, { fingerprint: before.fingerprint })
    await started.promise

    const saving = store.save(admin, draft(before, { level: 'debug' }))
    const fence = await db.raw('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS acquired', ['tsepistle.logging-administration'])
    expect(fence.rows).toEqual([{ acquired: false }])

    release.resolve()
    await applying
    await saving
    expect((await inspect()).console.level).toBe('debug')
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
    const before = await inspect()
    await store.save(admin, draft(before, { level: 'error' }))
    expect((await db('loggers').where('key', 'sentry').first()).config).toMatchObject({
      key: 'https://stored-secret@example.ingest.sentry.io/1',
      untouched: 'private-unowned-value'
    })
    const first = await inspect()
    await store.save(admin, draft(first, { level: 'warn' }))
    await expect(store.save(admin, draft(before, { level: 'debug' }))).rejects.toMatchObject({ status: 409 })
    await expect(store.apply(admin, { fingerprint: before.fingerprint })).rejects.toMatchObject({ status: 409 })
    const unavailable = await inspect()
    const invalid = draft(unavailable)
    invalid.destinations.find(destination => destination.key === 'disk')!.isEnabled = true
    await expect(store.save(admin, invalid)).rejects.toThrow('unavailable')
  })

  it('preserves accepted Sentry DSN bytes while rejecting blank replacements and reporting them absent', async () => {
    const before = await inspect()
    const replacement = 'https://replacement@example.ingest.sentry.io/2?source=reviewed'
    await store.save(admin, draft(before, { dsn: replacement }))
    expect((await db('loggers').where('key', 'sentry').first()).config).toMatchObject({ key: replacement })

    const saved = await inspect()
    await expect(store.save(admin, draft(saved, { dsn: '   ' }))).rejects.toThrow('Review the complete logging configuration')
    await db('loggers')
      .where('key', 'sentry')
      .update({
        config: JSON.stringify({ key: '   ', untouched: 'private-unowned-value' })
      })

    const whitespace = await inspect()
    expect(whitespace.destinations.find(destination => destination.key === 'sentry')?.secrets).toMatchObject({ key: false })
    await expect(store.save(admin, draft(whitespace, { sentryEnabled: true }))).rejects.toThrow('valid Sentry DSN')
  })

  it('requires a present Sentry DSN before enabling and rolls back every row if the history record fails', async () => {
    const noDsn = draft(await inspect(), { dsn: 'clear', sentryEnabled: true })
    await expect(store.save(admin, noDsn)).rejects.toThrow('Sentry DSN')
    await db.raw("ALTER TABLE settings ADD CONSTRAINT logging_fixture_history_reject CHECK (key <> 'loggingAdministration')")
    try {
      const before = await inspect()
      await expect(store.save(admin, draft(before, { level: 'error' }))).rejects.toThrow()
      expect((await inspect()).console.level).toBe('info')
      expect((await db('loggers').where('key', 'sentry').first()).level).toBe('warn')
    } finally {
      await db.raw('ALTER TABLE settings DROP CONSTRAINT logging_fixture_history_reject')
    }
  })

  it('rechecks current system authority before inspection and before application', async () => {
    await db('users').where('id', 1).update({ isActive: false })
    await expect(inspect()).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ isActive: true })
    const workspace = await inspect()
    await db('userGroups').where('userId', 1).delete()
    await expect(store.apply(admin, { fingerprint: workspace.fingerprint })).rejects.toMatchObject({ status: 403 })
  })

  it('rechecks current API authority before a saved configuration can be applied', async () => {
    await db('apiKeys').insert({ id: 7, isRevoked: false, expiration: '2026-02-02T00:00:00.000Z' })
    const workspace = await inspect(apiAdmin)
    await db('apiKeys').where('id', 7).update({ isRevoked: true })

    await expect(store.apply(apiAdmin, { fingerprint: workspace.fingerprint })).rejects.toMatchObject({ status: 403 })
  })
})
