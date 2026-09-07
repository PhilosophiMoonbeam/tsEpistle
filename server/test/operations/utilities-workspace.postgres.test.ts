import { rm } from 'node:fs/promises'
import path from 'node:path'

import { randomUUID } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { up, down } from '../../db/migrations/tsepistle-000026-utilities-operations.ts'
import type { UtilitiesWorkspaceStore } from '../../operations/utilities-workspace.ts'

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_utilities_workspace_test') && password
    ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT), user: 'wiki', database, password }
    : null
const suite = connection ? describe : describe.skip
const administrator = { user: { id: 1, authVersion: 0 } } as never

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
const deferred = (): Deferred => {
  const resolvers = Promise.withResolvers<void>()
  return { promise: resolvers.promise, resolve: () => resolvers.resolve(), reject: resolvers.reject }
}
const waitFor = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read()
    if (value !== undefined) return value
    await Promise.resolve()
  }
  throw new Error('Timed out waiting for the Utilities receipt.')
}
interface FixtureRuntime {
  ROOTPATH: string
  config: { sessionSecret: string; telemetry: { isEnabled: boolean; clientId: string } }
  telemetry: { enabled: boolean; generateClientId(): void }
  configSvc: { saveToDb(keys: string[]): Promise<boolean> }
  system: {
    exportStatus: { status: string; progress: number }
    export(options: { entities: string[]; path: string }): Promise<void>
  }
  models: {
    assets: { flushTempUploads(): Promise<void> }
    pages: { query(): { findById(): Promise<undefined> }; renderPage(): Promise<void> }
    storage: Record<string, never>
  }
}
suite('Utilities workspace persistence on PostgreSQL', () => {
  let db: Knex
  let store: UtilitiesWorkspaceStore
  let operation: Deferred
  let effectDispatched: Deferred
  let flushTemporaryUploadsCalls: number
  let previousWiki: unknown
  const runtime: FixtureRuntime = {
    ROOTPATH: process.cwd(),
    config: { sessionSecret: 'utilities-workspace-test-review-key', telemetry: { isEnabled: false, clientId: 'fixture-client-id' } },
    telemetry: { enabled: false, generateClientId: () => undefined },
    configSvc: { saveToDb: async () => true },
    system: {
      exportStatus: { status: 'notrunning', progress: 0 },
      export: async () => {
        await operation.promise
        runtime.system.exportStatus.status = 'success'
      }
    },
    models: {
      assets: { flushTempUploads: async () => undefined },
      pages: { query: () => ({ findById: async () => undefined }), renderPage: async () => undefined },
      storage: {}
    }
  }

  const request = async () => {
    const workspace = await store.inspect(administrator)
    return {
      id: randomUUID(),
      kind: 'cache-temporary-uploads' as const,
      fingerprint: workspace.fingerprint,
      reason: 'Remove abandoned fixture uploads after the validation run',
      confirmation: 'DELETE TEMPORARY UPLOADS',
      payload: {}
    }
  }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.jsonb('permissions').notNullable()
      table.string('adminRevision').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').notNullable()
      table.integer('groupId').notNullable()
    })
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.jsonb('value').notNullable()
      table.timestamp('updatedAt', { useTz: true }).notNullable()
    })
    await db.schema.createTable('locales', table => {
      table.string('code', 35).primary()
      table.string('name', 160).notNullable()
    })
    await up(db)
    previousWiki = Reflect.get(globalThis, 'WIKI')
    Reflect.set(globalThis, 'WIKI', runtime)
    // The operations module captures the initialized runtime; importing after this fixture is deliberate.
    const module = await import('../../operations/utilities-workspace.ts')
    store = module.createUtilitiesWorkspaceStore(db)
  })

  afterAll(async () => {
    if (!db) return
    await db('utilitiesOperations').delete()
    await down(db)
    for (const table of ['locales', 'settings', 'userGroups', 'groups', 'users']) await db.schema.dropTableIfExists(table)
    await db.destroy()
    Reflect.set(globalThis, 'WIKI', previousWiki)
  })

  beforeEach(async () => {
    for (const table of ['utilitiesOperations', 'locales', 'settings', 'userGroups', 'groups', 'users']) await db(table).delete()
    await db('users').insert({ id: 1, isActive: true, authVersion: 0 })
    await db('groups').insert({ id: 1, permissions: JSON.stringify(['manage:system']), adminRevision: 'first' })
    await db('userGroups').insert({ userId: 1, groupId: 1 })
    await db('settings').insert({
      key: 'telemetry',
      value: JSON.stringify({ isEnabled: false, clientId: 'fixture-client-id' }),
      updatedAt: new Date().toISOString()
    })
    await db('locales').insert({ code: 'en', name: 'English' })
    runtime.config.telemetry.isEnabled = false
    runtime.config.telemetry.clientId = 'fixture-client-id'
    runtime.telemetry.enabled = false
    runtime.configSvc.saveToDb = async () => true
    runtime.system.exportStatus = { status: 'notrunning', progress: 0 }
    runtime.system.export = async () => {
      await operation.promise
      runtime.system.exportStatus.status = 'success'
    }
    operation = deferred()
    effectDispatched = deferred()
    flushTemporaryUploadsCalls = 0
    runtime.models.assets.flushTempUploads = async () => {
      flushTemporaryUploadsCalls += 1
      effectDispatched.resolve()
      await operation.promise
    }
  })

  it('persists a reviewed receipt before the effect starts and never executes a repeated request identifier twice', async () => {
    const input = await request()
    const receipt = await store.start(administrator, input)
    const persisted = await db('utilitiesOperations').where('id', input.id).first()
    expect(receipt).toMatchObject({ id: input.id, state: 'running', phase: 'queued', reason: input.reason })
    expect(persisted).toMatchObject({ id: input.id, kind: input.kind, state: 'running', reason: input.reason })
    expect(persisted).not.toHaveProperty('payload')
    await effectDispatched.promise
    await expect(store.start(administrator, input)).resolves.toMatchObject({ id: input.id, state: 'running' })
    expect(flushTemporaryUploadsCalls).toBe(1)
    operation.resolve()
    await waitFor(async () => ((await store.receipt(administrator, input.id)).state === 'succeeded' ? true : undefined))
    await expect(store.start(administrator, input)).resolves.toMatchObject({ id: input.id, state: 'succeeded' })
    expect(flushTemporaryUploadsCalls).toBe(1)
  })

  it('rechecks persisted current authority before creating an effect receipt', async () => {
    const input = await request()
    await db('users').where('id', 1).update({ authVersion: 1 })
    await expect(store.start(administrator, input)).rejects.toMatchObject({ status: 403 })
    expect(await db('utilitiesOperations').count<{ count: string }>('* as count').first()).toMatchObject({ count: '0' })
    expect(flushTemporaryUploadsCalls).toBe(0)
  })

  it('rejects a second reviewed action while the first effect is active', async () => {
    const first = await request()
    const second = await request()
    await store.start(administrator, first)
    await effectDispatched.promise
    await expect(store.start(administrator, second)).rejects.toMatchObject({ status: 409 })
    expect(flushTemporaryUploadsCalls).toBe(1)
    operation.resolve()
    await waitFor(async () => ((await store.receipt(administrator, first.id)).state === 'succeeded' ? true : undefined))
  })

  it('records a failed in-process effect as uncertain and requires explicit recovery acknowledgement before another action', async () => {
    const first = await request()
    await store.start(administrator, first)
    await effectDispatched.promise
    operation.reject(new Error('fixture effect failed after dispatch'))
    const uncertain = await waitFor(async () => {
      const receipt = await store.receipt(administrator, first.id)
      return receipt.state === 'uncertain' ? receipt : undefined
    })
    expect(uncertain).toMatchObject({ phase: 'interrupted' })
    await expect(store.start(administrator, await request())).rejects.toMatchObject({ status: 409 })
  })
  it('rejects a changed reviewed request when its identifier was already recorded', async () => {
    const first = await request()
    await store.start(administrator, first)
    await effectDispatched.promise
    await expect(store.start(administrator, { ...first, reason: 'A materially different reviewed reason for this identifier' })).rejects.toMatchObject({
      status: 409
    })
    expect(flushTemporaryUploadsCalls).toBe(1)
    operation.resolve()
    await waitFor(async () => ((await store.receipt(administrator, first.id)).state === 'succeeded' ? true : undefined))
  })

  it('persists an uncertainty acknowledgement once so the next independent operation does not repeat it', async () => {
    const first = await request()
    await store.start(administrator, first)
    await effectDispatched.promise
    operation.reject(new Error('fixture effect failed after dispatch'))
    await waitFor(async () => ((await store.receipt(administrator, first.id)).state === 'uncertain' ? true : undefined))

    operation = deferred()
    effectDispatched = deferred()
    const second = { ...(await request()), acknowledgedUncertainId: first.id }
    await store.start(administrator, second)
    await effectDispatched.promise
    operation.resolve()
    await waitFor(async () => ((await store.receipt(administrator, second.id)).state === 'succeeded' ? true : undefined))

    const acknowledged = await db('utilitiesOperations').where('id', first.id).first()
    expect(acknowledged).toMatchObject({ acknowledgedByOperationId: second.id })
    expect(acknowledged.acknowledgedAt).not.toBeNull()

    operation = deferred()
    effectDispatched = deferred()
    const third = await request()
    await expect(store.start(administrator, third)).resolves.toMatchObject({ id: third.id, state: 'running' })
    await effectDispatched.promise
    operation.resolve()
    await waitFor(async () => ((await store.receipt(administrator, third.id)).state === 'succeeded' ? true : undefined))
  })

  it('rejects invalid retention, absent locales, and unavailable import targets before creating an effect receipt', async () => {
    const review = await store.inspect(administrator)
    const before = await db('utilitiesOperations').count<{ count: string }>('* as count').first()
    await expect(
      store.start(administrator, {
        id: randomUUID(),
        kind: 'content-purge-history',
        fingerprint: review.fingerprint,
        reason: 'Verify that unsupported retention has no effect',
        confirmation: 'PURGE HISTORY',
        payload: { olderThan: 'P0D' }
      })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      store.start(administrator, {
        id: randomUUID(),
        kind: 'content-migrate-locale',
        fingerprint: review.fingerprint,
        reason: 'Verify that a missing target locale has no effect',
        confirmation: 'MIGRATE PAGES',
        payload: { sourceLocale: 'en', targetLocale: 'fr' }
      })
    ).rejects.toMatchObject({ status: 400 })
    await expect(
      store.start(administrator, {
        id: randomUUID(),
        kind: 'import-v1-content',
        fingerprint: review.fingerprint,
        reason: 'Verify that unavailable storage import has no effect',
        confirmation: 'IMPORT CONTENT',
        payload: { mode: 'disk', path: '/fixture/import' }
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(await db('utilitiesOperations').count<{ count: string }>('* as count').first()).toEqual(before)
    expect(flushTemporaryUploadsCalls).toBe(0)
  })

  it('invalidates a review when the actual telemetry identifier changes', async () => {
    const review = await store.inspect(administrator)
    runtime.config.telemetry.clientId = 'new-fixture-client-id'
    await expect(
      store.start(administrator, {
        id: randomUUID(),
        kind: 'telemetry-reset-client-id',
        fingerprint: review.fingerprint,
        reason: 'Verify stale telemetry identity review protection',
        confirmation: 'RESET CLIENT ID',
        payload: {}
      })
    ).rejects.toMatchObject({ status: 409 })
    expect(await db('utilitiesOperations').count<{ count: string }>('* as count').first()).toMatchObject({ count: '0' })
  })

  it('records an unpersisted telemetry preference as a confirmed failure without publishing it', async () => {
    runtime.configSvc.saveToDb = async () => false
    const review = await store.inspect(administrator)
    const input = {
      id: randomUUID(),
      kind: 'telemetry-save' as const,
      fingerprint: review.fingerprint,
      reason: 'Verify a persistence failure cannot publish telemetry state',
      confirmation: 'SAVE TELEMETRY',
      payload: { enabled: true }
    }
    await store.start(administrator, input)
    const receipt = await waitFor(async () => {
      const value = await store.receipt(administrator, input.id)
      return value.state === 'failed' ? value : undefined
    })
    expect(receipt).toMatchObject({ state: 'failed', phase: 'complete' })
    expect(runtime.config.telemetry.isEnabled).toBe(false)
    expect(runtime.telemetry.enabled).toBe(false)
  })
  it('refuses to discard recorded utility receipts during migration rollback', async () => {
    const at = new Date().toISOString()
    await db('utilitiesOperations').insert({
      id: randomUUID(),
      kind: 'cache-pages',
      state: 'succeeded',
      phase: 'complete',
      actorId: 1,
      apiKeyId: null,
      reason: 'Protect historical utility evidence from migration rollback',
      reviewFingerprint: 'a'.repeat(64),
      requestFingerprint: 'b'.repeat(64),
      createdAt: at,
      heartbeatAt: at,
      completedAt: at,
      acknowledgedAt: null,
      acknowledgedByOperationId: null,
      progress: 100,
      summary: 'Fixture receipt',
      result: null
    })
    await expect(down(db)).rejects.toThrow('Cannot discard recorded Utilities operations')
    await db('utilitiesOperations').delete()
  })
  it('keeps export ownership through a recoverable heartbeat persistence fault until the effect settles', async () => {
    const trigger = 'utilities_operations_export_heartbeat_fault'
    const sequence = 'utilities_operations_export_heartbeat_fault_sequence'
    const functionName = 'utilities_operations_export_heartbeat_fault_fn'
    const destination = `utilities-export-${randomUUID()}`
    await db.raw(`CREATE SEQUENCE "${sequence}"`)
    await db.raw(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.summary = 'The local export service is running. Its destination is intentionally not retained in this receipt.'
          AND nextval('"${sequence}"') = 1 THEN
          RAISE EXCEPTION 'fixture heartbeat persistence fault';
        END IF;
        RETURN NEW;
      END;
      $$`)
    await db.raw(`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON "utilitiesOperations" FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`)
    try {
      const review = await store.inspect(administrator)
      const first = {
        id: randomUUID(),
        kind: 'export' as const,
        fingerprint: review.fingerprint,
        reason: 'Verify that a transient export heartbeat write does not release ownership',
        confirmation: 'START EXPORT',
        payload: { entities: ['pages'], path: destination }
      }
      await store.start(administrator, first)
      // observeExport uses node's live timer; this PostgreSQL integration test deliberately waits for that persisted heartbeat boundary.
      const heartbeat = Promise.withResolvers<void>()
      setTimeout(heartbeat.resolve, 1_100)
      await heartbeat.promise
      await expect(store.start(administrator, await request())).rejects.toMatchObject({ status: 409 })
      operation.resolve()
      await waitFor(async () => ((await store.receipt(administrator, first.id)).state === 'succeeded' ? true : undefined))
    } finally {
      await db.raw(`DROP TRIGGER IF EXISTS "${trigger}" ON "utilitiesOperations"`)
      await db.raw(`DROP FUNCTION IF EXISTS "${functionName}"()`)
      await db.raw(`DROP SEQUENCE IF EXISTS "${sequence}"`)
      await rm(path.join(process.cwd(), destination), { force: true, recursive: true })
    }
  })
})
