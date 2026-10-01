import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import * as yaml from 'js-yaml'
import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '../bun-test.mts'
import common from '../../helpers/common.ts'
import { up as jobsMigration } from '../../db/migrations/2.5.130.ts'
import { up as leaseMigration } from '../../db/migrations/2.5.158.ts'
import { up as storageMigration, down as storageDown } from '../../db/migrations/tsepistle-000023-storage-administration.ts'
import { storageModuleDefinition } from '../../repositories/storage-configuration.ts'
import { storageConfigurationKey } from '../../helpers/storage-configuration-key.ts'
import { createStorageConfigurationStore } from '../../operations/storage-configuration.ts'
import { createStorageActionStore, type StorageRuntimeTarget } from '../../operations/storage-actions.ts'
import { DurableJobStore, runDurableJobBatch } from '../../core/durable-jobs.ts'
import { createStorageActionHandler } from '../../jobs/storage-action.ts'
import { createStorageWorkspaceStore } from '../../operations/storage-workspace-runtime.ts'
import type { StorageModuleDefinition } from '../../../shared/storage-workspace.ts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
const connection = getPostgresTestConnection('_storage_test', import.meta.path)
const suite = connection ? describe : describe.skip,
  admin = { id: 1, authVersion: 0 } as never
const result = { outcome: 'succeeded', message: 'Operation completed.', counts: null, items: [], targets: [] }
suite('Reviewed storage operations on PostgreSQL', () => {
  let db: Knex, configuration: ReturnType<typeof createStorageConfigurationStore>, actions: ReturnType<typeof createStorageActionStore>, jobs: DurableJobStore
  let runtime: StorageRuntimeTarget[], definitions: StorageModuleDefinition[], rawDefinitions: unknown[], offline: boolean, executing: boolean, clock: Date
  const tables = ['storageOperations', 'durableJobs', 'storage', 'settings', 'userGroups', 'groups', 'users']
  const review = () => configuration.inspect(admin)
  const input = async (targetKey: string | null = 'disk', handler = targetKey === null ? 'activate' : 'dump') => ({
    targetKey,
    handler,
    fingerprint: (await review()).fingerprint,
    reason: 'Verify reviewed storage work',
    confirmation: targetKey === null ? 'APPLY STORAGE SETTINGS' : handler === 'backup' ? 'CREATE ARCHIVE' : 'EXPORT CONTENT'
  })
  const claim = async () => {
    const rows = await jobs.claim({ workerId: 'test-worker', supportedIdentities: ['storage-action@1'], now: clock, leaseMs: 30000 })
    expect(rows).toHaveLength(1)
    return rows[0]!
  }
  const decision = async (id: string, confirmation = 'CANCEL OPERATION') => ({
    id,
    fingerprint: (await review()).fingerprint,
    reason: 'Review recovery evidence',
    confirmation
  })
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    await db.schema.createTable('settings', t => {
      t.string('key').primary()
      t.jsonb('value')
      t.string('updatedAt').notNullable()
    })
    await db.schema.createTable('users', t => {
      t.integer('id').primary()
      t.boolean('isActive')
      t.integer('authVersion')
    })
    await db.schema.createTable('groups', t => {
      t.integer('id').primary()
      t.jsonb('permissions')
      t.string('adminRevision')
    })
    await db.schema.createTable('userGroups', t => {
      t.integer('userId')
      t.integer('groupId')
    })
    await db.schema.createTable('storage', t => {
      t.string('key').primary()
      t.boolean('isEnabled')
      t.string('mode')
      t.string('syncInterval')
      t.jsonb('config')
      t.jsonb('state')
    })
    await jobsMigration(db)
    await leaseMigration(db)
    await storageMigration(db)
  })
  afterAll(async () => {
    if (db) {
      for (const table of tables) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    clock = new Date(Date.now() + 1000)
    offline = false
    executing = false
    await db('settings').insert({ key: 'storageAdministration', value: '{}', updatedAt: clock.toISOString() })
    await db('users').insert([
      { id: 1, isActive: true, authVersion: 0 },
      { id: 3, isActive: true, authVersion: 0 }
    ])
    await db('groups').insert([
      { id: 1, permissions: '["manage:system"]', adminRevision: 'initial' },
      { id: 2, permissions: '[]', adminRevision: 'initial' }
    ])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 3, groupId: 2 }
    ])
    definitions = []
    rawDefinitions = []
    for (const key of ['disk', 'sftp']) {
      const raw = yaml.load(await fs.readFile(path.resolve('server/modules/storage', key, 'definition.yml'), 'utf8')) as Record<string, unknown> & {
        props: Parameters<typeof common.parseModuleProps>[0]
      }
      raw.props = common.parseModuleProps(raw.props)
      rawDefinitions.push(raw)
      const definition = storageModuleDefinition(raw)
      definitions.push(definition)
      const config = {
        ...Object.fromEntries(definition.fields.map(field => [field.key, field.default])),
        ...(key === 'disk'
          ? { path: '/tmp/storage-fixture' }
          : {
              host: 'storage.example.test',
              username: 'wiki',
              password: 'provider-secret',
              authMode: 'password',
              port: 22,
              basePath: '/wiki',
              hostKeyFingerprint: 'SHA256:' + 'A'.repeat(43)
            })
      }
      await db('storage').insert({ key, isEnabled: true, mode: 'push', syncInterval: 'P0D', config: JSON.stringify(config), state: '{}' })
    }
    runtime = (await db('storage').orderBy('key')).map(row => ({
      key: row.key,
      generation: randomUUID(),
      configurationKey: storageConfigurationKey(row),
      active: true,
      paused: false
    }))
    configuration = createStorageConfigurationStore({
      db,
      reviewKey: 'test-only-review',
      definitions: () => definitions,
      offline: () => offline,
      now: () => clock
    })
    actions = createStorageActionStore({ db, configuration, runtime: () => runtime, offline: () => offline, isExecuting: () => executing, now: () => clock })
    jobs = new DurableJobStore(db)
  })
  it('queues an attributed immutable action and stores only its identifier in a single-attempt job', async () => {
    const queued = await actions.enqueue(admin, await input()),
      row = await db('storageOperations').where('id', queued.id).first(),
      job = await db('durableJobs').where('id', queued.jobId).first()
    expect(row).toMatchObject({
      state: 'queued',
      actorId: 1,
      targetKey: 'disk',
      handler: 'dump',
      reason: 'Verify reviewed storage work',
      runtimeGeneration: runtime[0]!.generation
    })
    expect(JSON.parse(job.payload)).toEqual({ operationId: queued.id })
    expect(job.maxAttempts).toBe(1)
    const visible = await actions.list(admin),
      serialized = JSON.stringify(visible)
    expect(visible[0]).toMatchObject({ id: queued.id, state: 'queued', canCancel: true, canResolve: false })
    for (const hidden of ['provider-secret', 'reviewFingerprint', 'runtimeGeneration', 'requester', 'leaseToken', 'configurationKey'])
      expect(serialized).not.toContain(hidden)
  })
  it('rejects unreviewed, unsupported, inactive and unauthorized actions without enqueueing', async () => {
    const draft = await input()
    for (const { change, status } of [
      { change: { confirmation: 'EXPORT' }, status: 400 },
      { change: { handler: 'constructor' }, status: 400 },
      { change: { fingerprint: '0'.repeat(64) }, status: 409 },
      { change: { targetKey: 'missing' }, status: 400 }
    ])
      await expect(actions.enqueue(admin, { ...draft, ...change })).rejects.toMatchObject({ status })
    await expect(actions.enqueue({ id: 3, authVersion: 0 } as never, draft)).rejects.toMatchObject({ status: 403 })
    runtime[0]!.active = false
    await expect(actions.enqueue(admin, draft)).rejects.toMatchObject({ status: 409 })
    expect(await db('durableJobs')).toHaveLength(0)
  })
  it('serializes competing submissions and blocks configuration changes until cancellation', async () => {
    const draft = await input(),
      attempts = await Promise.allSettled([actions.enqueue(admin, draft), actions.enqueue(admin, draft)])
    expect(attempts.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(await db('durableJobs')).toHaveLength(1)
    const workspace = await review(),
      targets = workspace.targets.map(({ key, isEnabled, mode, syncInterval, config, secrets }) => ({
        key,
        isEnabled,
        mode,
        syncInterval,
        config: { ...config },
        secrets: Object.fromEntries(Object.keys(secrets).map(key => [key, { action: 'keep' }]))
      }))
    targets[0]!.config.path = '/tmp/new-storage'
    const update = { targets, fingerprint: workspace.fingerprint, reason: 'Review configuration change' }
    await expect(configuration.save(admin, update)).rejects.toMatchObject({ status: 409 })
    const active = (await actions.list(admin))[0]!
    await actions.decide(admin, await decision(active.id), 'cancel')
    await configuration.save(admin, update)
    expect((await db('storage').where('key', 'disk').first()).config.path).toBe('/tmp/new-storage')
  })
  it('begins once under a current lease and records a terminal result without changing target configuration', async () => {
    const before = await db('storage').orderBy('key'),
      queued = await actions.enqueue(admin, await input()),
      job = await claim()
    const context = await actions.begin(job)
    expect(context).toMatchObject({ id: queued.id, targetKey: 'disk', handler: 'dump' })
    expect(context.credentials).toContain('provider-secret')
    await expect(actions.begin(job)).rejects.toMatchObject({ status: 409 })
    expect((await actions.list(admin))[0]).toMatchObject({ state: 'running', canCancel: false, startedAt: clock.toISOString() })
    await actions.finish(job, result)
    expect((await actions.list(admin))[0]).toMatchObject({ state: 'succeeded', result })
    await expect(actions.finish(job, { ...result, outcome: 'failed' })).rejects.toMatchObject({ status: 409 })
    expect(await db('storage').orderBy('key')).toEqual(before)
  })
  it.each(['account', 'configuration', 'runtime'])('rechecks %s changes before the first effect', async kind => {
    await actions.enqueue(admin, await input())
    const job = await claim()
    if (kind === 'account') await db('users').where('id', 1).update({ authVersion: 1 })
    if (kind === 'configuration')
      await db('storage')
        .where('key', 'disk')
        .update({ config: JSON.stringify({ path: '/tmp/changed' }) })
    if (kind === 'runtime') runtime[0]!.generation = randomUUID()
    await expect(actions.begin(job)).rejects.toMatchObject({ status: kind === 'account' ? 403 : 409 })
    await actions.rejectBeforeStart(job)
    expect(await db('storageOperations').first()).toMatchObject({ state: 'failed', startedAt: null })
  })
  it('blocks remote work when offline policy changes and permits disk work and activation', async () => {
    offline = true
    await expect(actions.enqueue(admin, await input('sftp', 'exportAll'))).rejects.toMatchObject({ status: 409 })
    const local = await actions.enqueue(admin, await input())
    await actions.decide(admin, await decision(local.id), 'cancel')
    const activation = await actions.enqueue(admin, await input(null))
    await actions.decide(admin, await decision(activation.id), 'cancel')
    offline = false
    await actions.enqueue(admin, await input('sftp', 'exportAll'))
    const job = await claim()
    offline = true
    await expect(actions.begin(job)).rejects.toMatchObject({ status: 409 })
  })
  it('cancels claimed but unstarted work and prevents the worker from beginning afterward', async () => {
    const queued = await actions.enqueue(admin, await input()),
      job = await claim()
    await actions.decide(admin, await decision(queued.id), 'cancel')
    await expect(actions.begin(job)).rejects.toMatchObject({ status: 409 })
    expect(await db('durableJobs').where('id', job.id).first()).toMatchObject({ state: 'cancelled', leaseToken: null })
  })
  it('preserves uncertain work, refuses stale completion and requires explicit recovery after the prior worker stops', async () => {
    const queued = await actions.enqueue(admin, await input()),
      job = await claim()
    await actions.begin(job)
    await expect(actions.decide(admin, await decision(queued.id), 'cancel')).rejects.toMatchObject({ status: 409 })
    await expect(actions.decide(admin, await decision(queued.id, 'PRIOR WORKER STOPPED'), 'resolve')).rejects.toMatchObject({ status: 409 })
    clock = new Date(clock.valueOf() + 31000)
    await expect(actions.finish(job, result)).rejects.toMatchObject({ status: 409 })
    expect((await actions.list(admin))[0]).toMatchObject({ state: 'interrupted', canCancel: false, canResolve: true })
    await expect(actions.enqueue(admin, await input())).rejects.toMatchObject({ status: 409 })
    executing = true
    await expect(actions.decide(admin, await decision(queued.id, 'PRIOR WORKER STOPPED'), 'resolve')).rejects.toMatchObject({ status: 409 })
    executing = false
    await expect(actions.decide(admin, await decision(queued.id, 'STOPPED'), 'resolve')).rejects.toMatchObject({ status: 400 })
    await actions.decide(admin, await decision(queued.id, 'PRIOR WORKER STOPPED'), 'resolve')
    expect((await actions.list(admin))[0]).toMatchObject({ state: 'resolved', resolution: { actorId: 1, reason: 'Review recovery evidence' } })
    await expect(actions.finish(job, result)).rejects.toMatchObject({ status: 409 })
    const recovered = await actions.enqueue(admin, await input())
    expect(await db('storageOperations').where('id', recovered.id).first()).toMatchObject({ state: 'queued', jobId: recovered.jobId })
    const recoveredJob = await db('durableJobs').where('id', recovered.jobId).first()
    expect(recoveredJob).toMatchObject({ type: 'storage-action', version: 1, state: 'pending' })
    expect(JSON.parse(recoveredJob.payload)).toEqual({ operationId: recovered.id })
  })
  it('never reclaims exhausted work and retains its unresolved receipt after job cleanup', async () => {
    const queued = await actions.enqueue(admin, await input()),
      job = await claim()
    await actions.begin(job)
    clock = new Date(clock.valueOf() + 31000)
    expect(await jobs.claim({ workerId: 'replacement', supportedIdentities: ['storage-action@1'], now: clock })).toHaveLength(0)
    expect((await db('durableJobs').where('id', job.id).first()).state).toBe('failed')
    await db('durableJobs').where('id', job.id).delete()
    expect((await actions.list(admin))[0]).toMatchObject({ id: queued.id, state: 'interrupted', canResolve: true })
  })
  it('keeps an old active operation visible alongside the latest fifty terminal records', async () => {
    await actions.enqueue(admin, await input())
    const original = await db('storageOperations').first()
    await db('storageOperations').insert(
      Array.from({ length: 60 }, (_, index) => ({
        ...original,
        id: randomUUID(),
        jobId: randomUUID(),
        state: 'succeeded',
        createdAt: new Date(clock.valueOf() + index + 1),
        completedAt: clock,
        result: JSON.stringify(result),
        requester: JSON.stringify(original.requester)
      }))
    )
    const rows = await actions.list(admin)
    expect(rows).toHaveLength(51)
    expect(rows[0]!.id).toBe(original.id)
  })
  it('rolls back the job if its operation receipt cannot be inserted', async () => {
    await db.raw('ALTER TABLE "storageOperations" ADD CONSTRAINT fixture_failure CHECK (false)')
    try {
      await expect(actions.enqueue(admin, await input())).rejects.toBeInstanceOf(Error)
      expect(await db('durableJobs')).toHaveLength(0)
    } finally {
      await db.raw('ALTER TABLE "storageOperations" DROP CONSTRAINT fixture_failure')
    }
  })
  it('permits an empty migration rollback but refuses to discard operation evidence', async () => {
    await storageDown(db)
    await storageMigration(db)
    await actions.enqueue(admin, await input())
    await expect(storageDown(db)).rejects.toThrow('Cannot discard recorded storage operations')
    expect(await db.schema.hasTable('storageOperations')).toBe(true)
  })
  it.each(['succeeded', 'failed', 'receipt-lost'])('runs the durable worker through a real PostgreSQL %s lifecycle', async outcome => {
    const queued = await actions.enqueue(admin, await input())
    let effects = 0
    const workerActions =
      outcome === 'receipt-lost'
        ? {
            ...actions,
            finish: async () => {
              throw Error('database write failed')
            }
          }
        : actions
    const handler = createStorageActionHandler({
      store: () =>
        ({
          configuration,
          actions: workerActions,
          runtime: {
            performAdministrativeOperation: async (before, after) => {
              await before()
              effects++
              return after({
                targetKey: 'disk',
                handler: 'dump',
                outcome: outcome === 'failed' ? 'failed' : 'succeeded',
                total: 0,
                succeeded: 0,
                failed: 0,
                formats: { okf: 0, legacyV1: 0, legacyWiki: 0, plain: 0, invalid: 0 },
                items: [],
                startedAt: clock.toISOString(),
                completedAt: clock.toISOString(),
                message: 'provider-secret'
              })
            }
          }
        }) as never
    })
    const execute = () => runDurableJobBatch(db, { workerId: 'fixture-worker', now: clock, handlers: { 'storage-action@1': handler } })
    await execute()
    await execute()
    const row = (await actions.list(admin))[0]!,
      job = await db('durableJobs').where('id', queued.jobId).first()
    expect(effects).toBe(1)
    expect(row.state).toBe(outcome === 'receipt-lost' ? 'interrupted' : outcome)
    expect(job.state).toBe(outcome === 'succeeded' ? 'succeeded' : 'failed')
    expect(JSON.stringify([row, job])).not.toContain('provider-secret')
    if (outcome === 'receipt-lost') {
      expect(row.canResolve).toBe(true)
      await expect(actions.enqueue(admin, await input())).rejects.toMatchObject({ status: 409 })
    }
  })
  it('does not apply queued activation after the offline policy used for its review changes', async () => {
    offline = true
    await actions.enqueue(admin, await input(null))
    const job = await claim()
    offline = false
    await expect(actions.begin(job)).rejects.toMatchObject({ status: 409 })
  })
  it('limits API principals to their current unowned system group', async () => {
    const api = { id: 1, ownershipUserId: null, groups: [1] } as never,
      workspace = await configuration.inspect(api)
    const draft = { ...(await input()), fingerprint: workspace.fingerprint }
    await expect(actions.enqueue({ id: 1, ownershipUserId: 3, groups: [1] } as never, draft)).rejects.toMatchObject({ status: 403 })
    await expect(actions.enqueue({ id: 1, ownershipUserId: null, groups: [1, 2] } as never, draft)).rejects.toMatchObject({ status: 403 })
    await actions.enqueue(api, draft)
    const job = await claim()
    await db('groups').where('id', 1).update({ permissions: '[]', adminRevision: 'revoked' })
    await expect(actions.begin(job)).rejects.toMatchObject({ status: 403 })
  })
  const workspaceStore = () =>
    createStorageWorkspaceStore({
      models: { knex: db, storage: { runtimeTargets: () => runtime } },
      config: {
        sessionSecret: 'test-only-review',
        get offline() {
          return offline
        }
      },
      data: { storage: rawDefinitions }
    } as never)
  const changedDraft = async () => {
    const saved = await workspaceStore().configuration.inspect(admin)
    const targets = saved.targets.map(({ key, isEnabled, mode, syncInterval, config, secrets }) => ({
      key,
      isEnabled,
      mode,
      syncInterval,
      config: { ...config },
      secrets: Object.fromEntries(Object.keys(secrets).map(key => [key, { action: 'keep' }]))
    }))
    targets.find(target => target.key === 'disk')!.config.path = '/tmp/staged-storage'
    return { targets, fingerprint: saved.fingerprint, reason: 'Review and publish storage settings' }
  }
  it('publishes settings and their activation job in one transaction', async () => {
    const workspace = workspaceStore(),
      receipt = await workspace.save(admin, await changedDraft(), true)
    expect(receipt.operation?.id).toBeString()
    expect((await db('storage').where('key', 'disk').first()).config.path).toBe('/tmp/staged-storage')
    const operation = await db('storageOperations').where('id', receipt.operation!.id).first()
    expect(operation).toMatchObject({ handler: 'activate', state: 'queued', configurationRevision: receipt.revision })
    const job = await claim()
    expect(await workspace.actions.begin(job)).toMatchObject({ targetKey: null, handler: 'activate' })
  })
  it('rolls back configuration and history if the activation receipt cannot be queued', async () => {
    const before = await db('storage').orderBy('key'),
      settings = await db('settings').orderBy('key')
    await db.raw('ALTER TABLE "storageOperations" ADD CONSTRAINT fixture_failure CHECK (false)')
    try {
      await expect(workspaceStore().save(admin, await changedDraft(), true)).rejects.toBeInstanceOf(Error)
      expect(await db('storage').orderBy('key')).toEqual(before)
      expect(await db('settings').orderBy('key')).toEqual(settings)
      expect(await db('durableJobs')).toHaveLength(0)
    } finally {
      await db.raw('ALTER TABLE "storageOperations" DROP CONSTRAINT fixture_failure')
    }
  })
  it('supports staging without activation and exposes only safe saved-versus-runtime observations', async () => {
    const workspace = workspaceStore(),
      receipt = await workspace.save(admin, await changedDraft(), false)
    expect(receipt.operation).toBeNull()
    expect(await db('durableJobs')).toHaveLength(0)
    await db('storage')
      .where('key', 'disk')
      .update({ state: JSON.stringify({ status: 'error', message: 'provider-secret', lastAttempt: 'invalid' }) })
    const observed = await workspace.inspect(admin),
      serialized = JSON.stringify(observed)
    expect(observed.runtime.find(target => target.key === 'disk')).toMatchObject({
      state: 'outdated',
      active: true,
      matchesSaved: false,
      lastAttempt: null,
      lastOutcome: 'error'
    })
    for (const privateValue of ['provider-secret', 'configurationKey', 'runtimeGeneration', 'leaseToken']) expect(serialized).not.toContain(privateValue)
    await db('users').where('id', 1).update({ authVersion: 1 })
    await expect(workspace.inspect(admin)).rejects.toMatchObject({ status: 403 })
  })
})
