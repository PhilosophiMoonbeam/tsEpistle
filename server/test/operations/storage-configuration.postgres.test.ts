import fs from 'node:fs/promises'
import path from 'node:path'
import * as yaml from 'js-yaml'
import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import common from '../../helpers/common.ts'
import { up as storageMigration } from '../../db/migrations/tsepistle-000023-storage-administration.ts'
import { storageModuleDefinition } from '../../repositories/storage-configuration.ts'
import { createStorageConfigurationStore } from '../../operations/storage-configuration.ts'
import type { StorageConfigurationWorkspace, StorageModuleDefinition, StorageTargetDraft } from '../../../shared/storage-workspace.ts'
const connection = getPostgresTestConnection('_storage_test', import.meta.path)
const suite = connection ? describe : describe.skip,
  admin = { id: 1, authVersion: 0 } as never
const drafts = (workspace: StorageConfigurationWorkspace): StorageTargetDraft[] =>
  workspace.targets.map(({ key, isEnabled, mode, syncInterval, config, secrets }) => ({
    key,
    isEnabled,
    mode,
    syncInterval,
    config: structuredClone(config),
    secrets: Object.fromEntries(Object.keys(secrets).map((key) => [key, { action: 'keep' as const }]))
  }))
suite('Reviewed storage configuration on PostgreSQL', () => {
  let db: Knex, definitions: StorageModuleDefinition[], store: ReturnType<typeof createStorageConfigurationStore>
  const read = () => store.inspect(admin),
    body = (workspace: StorageConfigurationWorkspace) => ({
      targets: drafts(workspace),
      fingerprint: workspace.fingerprint,
      reason: 'Review storage configuration'
    })
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 6 } })
    await db.schema.createTable('settings', (t) => {
      t.string('key').primary()
      t.jsonb('value')
      t.string('updatedAt').notNullable()
    })
    await db.schema.createTable('users', (t) => {
      t.integer('id').primary()
      t.boolean('isActive')
      t.integer('authVersion')
    })
    await db.schema.createTable('groups', (t) => {
      t.integer('id').primary()
      t.jsonb('permissions')
      t.string('adminRevision')
    })
    await db.schema.createTable('userGroups', (t) => {
      t.integer('userId')
      t.integer('groupId')
    })
    await db.schema.createTable('storage', (t) => {
      t.string('key').primary()
      t.boolean('isEnabled')
      t.string('mode')
      t.string('syncInterval')
      t.jsonb('config')
      t.jsonb('state')
    })
    await storageMigration(db)
  })
  afterAll(async () => {
    if (db) {
      for (const table of ['storageOperations', 'storage', 'settings', 'userGroups', 'groups', 'users']) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    for (const table of ['storageOperations', 'storage', 'settings', 'userGroups', 'groups', 'users']) await db(table).delete()
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
    for (const key of ['disk', 'git', 's3']) {
      const raw = yaml.load(await fs.readFile(path.resolve('server/modules/storage', key, 'definition.yml'), 'utf8')) as Record<string, unknown> & {
        props: Parameters<typeof common.parseModuleProps>[0]
      }
      raw.props = common.parseModuleProps(raw.props)
      const definition = storageModuleDefinition(raw)
      definitions.push(definition)
      const config = Object.fromEntries(definition.fields.map((field) => [field.key, field.default]))
      if (key === 'git') {
        config.sshPrivateKeyContent = 'original-secret'
        config.opaque = 'unowned-secret'
      }
      await db('storage').insert({
        key,
        isEnabled: false,
        mode: definition.defaultMode,
        syncInterval: definition.schedule || 'P0D',
        config: JSON.stringify(config),
        state: JSON.stringify({ status: 'warning', lastOperation: { message: 'Retain this operation' } })
      })
    }
    store = createStorageConfigurationStore({ db, reviewKey: 'test-only-review-key', definitions: () => definitions })
  })
  it('separates configured credential state from public fields and retains opaque saved values', async () => {
    const workspace = await read(),
      json = JSON.stringify(workspace)
    expect(json).not.toContain('original-secret')
    expect(json).not.toContain('unowned-secret')
    expect(workspace.targets.find((row) => row.key === 'git')?.secrets.sshPrivateKeyContent).toBe(true)
    const input = body(workspace)
    input.targets.find((row) => row.key === 'git')!.config.branch = 'main'
    await store.save(admin, input)
    expect((await db('storage').where('key', 'git').first()).config).toMatchObject({
      sshPrivateKeyContent: 'original-secret',
      opaque: 'unowned-secret',
      branch: 'main'
    })
  })
  it('publishes multiple targets atomically with attributed field names and preserves operational records', async () => {
    const before = await db('storage').orderBy('key'),
      input = body(await read())
    input.targets.find((row) => row.key === 'disk')!.config.path = '/tmp/wiki-reviewed-storage'
    input.targets.find((row) => row.key === 'git')!.config.branch = 'main'
    const receipt = await store.save(admin, input),
      workspace = await read()
    expect(receipt.changedTargets).toEqual(['disk', 'git'])
    expect(workspace.history[0]).toMatchObject({
      actorId: 1,
      reason: input.reason,
      targets: [
        { key: 'disk', fields: ['config.path'] },
        { key: 'git', fields: ['config.branch'] }
      ]
    })
    expect((await db('storage').orderBy('key')).map((row) => row.state)).toEqual(before.map((row) => row.state))
  })
  it('rolls back earlier target changes when a later target fails validation', async () => {
    const before = await db('storage').orderBy('key'),
      input = body(await read())
    input.targets.find((row) => row.key === 'disk')!.config.path = '/tmp/should-not-save'
    input.targets.find((row) => row.key === 's3')!.isEnabled = true
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 400 })
    expect(await db('storage').orderBy('key')).toEqual(before)
    expect(await db('settings')).toHaveLength(0)
  })
  it('requires active current sessions and persisted system authority for reads and publications', async () => {
    const input = body(await read())
    input.targets[0]!.config.path = '/tmp/wiki-storage'
    for (const requester of [undefined, { id: 2 }, { id: 3, authVersion: 0 }, { id: 1, authVersion: 1 }]) {
      await expect(store.inspect(requester as never)).rejects.toMatchObject({ status: 403 })
      await expect(store.save(requester as never, input)).rejects.toMatchObject({ status: 403 })
    }
    await db('users').where('id', 1).update({ isActive: false })
    await expect(read()).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ isActive: true })
    await db('groups').where('id', 1).update({ permissions: '[]' })
    await expect(read()).rejects.toMatchObject({ status: 403 })
  })
  it('accepts only the current granted group of an unowned API principal', async () => {
    expect((await store.inspect({ id: 1, ownershipUserId: null, groups: [1] } as never)).targets).toHaveLength(3)
    for (const requester of [
      { id: 1, ownershipUserId: null, groups: [2] },
      { id: 1, ownershipUserId: null, groups: [1, 2] },
      { id: 3, ownershipUserId: null, groups: [1] }
    ])
      await expect(store.inspect(requester as never)).rejects.toMatchObject({ status: 403 })
  })
  it('rejects stale and ABA configuration reviews while allowing an independent status update', async () => {
    const first = await read(),
      input = body(first)
    await db('storage').where('key', 'disk').update({ state: '{"status":"operational"}' })
    input.targets[0]!.config.path = '/tmp/one'
    await store.save(admin, input)
    const latest = body(await read())
    latest.targets[0]!.config.path = ''
    await store.save(admin, latest)
    expect((await read()).targets[0]?.config.path).toEqual(first.targets[0]?.config.path)
    input.targets[0]!.config.path = '/tmp/stale'
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 409 })
    expect((await db('storage').where('key', 'disk').first()).state).toEqual({ status: 'operational' })
  })
  it('applies explicit secret replacement and clearing without recording values in history', async () => {
    let input = body(await read())
    input.targets.find((row) => row.key === 'git')!.secrets.sshPrivateKeyContent = { action: 'replace', value: 'replacement-secret' }
    await store.save(admin, input)
    expect((await db('storage').where('key', 'git').first()).config.sshPrivateKeyContent).toBe('replacement-secret')
    expect(JSON.stringify((await read()).history)).not.toContain('replacement-secret')
    input = body(await read())
    input.targets.find((row) => row.key === 'git')!.secrets.sshPrivateKeyContent = { action: 'clear' }
    await store.save(admin, input)
    expect((await read()).targets.find((row) => row.key === 'git')?.secrets.sshPrivateKeyContent).toBe(false)
  })

  it('serializes competing publications so one immutable review can commit only once', async () => {
    const workspace = await read(), first = body(workspace), second = body(workspace)
    first.targets[0]!.config.path = '/tmp/first-review'
    second.targets[0]!.config.path = '/tmp/second-review'
    const results = await Promise.allSettled([store.save(admin, first), store.save(admin, second)])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({status: 409})
    const current = await read()
    expect(current.history).toHaveLength(1)
    expect(['/tmp/first-review', '/tmp/second-review']).toContain(current.targets[0]?.config.path)
  })
  it('requires complete unique inventory and rejects missing known or foreign configuration fields', async () => {
    const before = await db('storage').orderBy('key'),
      settings = await db('settings').orderBy('key')
    let input = body(await read())
    input.targets.pop()
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 400 })
    input = body(await read())
    input.targets[1] = input.targets[0]!
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 400 })
    input = body(await read())
    delete input.targets[0]!.config.path
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 400 })
    expect(await db('storage').orderBy('key')).toEqual(before)
    expect(await db('settings').orderBy('key')).toEqual(settings)
    for (const field of ['unknown', 'constructor', 'prototype']) {
      input = body(await read())
      const disk = input.targets.find((row) => row.key === 'disk')!
      disk.config.path = '/tmp/foreign-field-must-not-save'
      Object.defineProperty(disk.config, field, { value: 'bad', enumerable: true })
      await expect(store.save(admin, input)).rejects.toMatchObject({ status: 400 })
      expect(await db('storage').orderBy('key')).toEqual(before)
      expect(await db('settings').orderBy('key')).toEqual(settings)
    }
  })
  it('allows disabling an unavailable target while preserving its full opaque configuration', async () => {
    await db('storage').insert({
      key: 'legacy-unavailable',
      isEnabled: true,
      mode: 'legacy',
      syncInterval: 'P0D',
      config: '{"secret":"untouched"}',
      state: '{"status":"error"}'
    })
    const unavailableBefore = await db('storage').where('key', 'legacy-unavailable').first()
    let input = body(await read())
    input.targets.find((row) => row.key === 'legacy-unavailable')!.isEnabled = false
    await store.save(admin, input)
    const unavailableSaved = await db('storage').where('key', 'legacy-unavailable').first()
    expect(unavailableSaved.config).toEqual({ secret: 'untouched' })
    expect(unavailableSaved).toEqual({ ...unavailableBefore, isEnabled: false })
    definitions.find((row) => row.key === 'git')!.isAvailable = false
    await db('storage').where('key', 'git').update({ isEnabled: true })
    const gitBefore = await db('storage').where('key', 'git').first()
    input = body(await read())
    input.targets.find((row) => row.key === 'git')!.isEnabled = false
    await store.save(admin, input)
    const gitSaved = await db('storage').where('key', 'git').first()
    expect(gitSaved.config.sshPrivateKeyContent).toBe('original-secret')
    expect(gitSaved).toEqual({ ...gitBefore, isEnabled: false })
  })
  it('allows disabling invalid legacy configuration without forcing unrelated repairs', async () => {
    const row = await db('storage').where('key', 'git').first()
    await db('storage')
      .where('key', 'git')
      .update({ isEnabled: true, mode: 'unsupported-old-mode', syncInterval: 'bad', config: JSON.stringify({ ...row.config, authType: 'legacy' }) })
    const before = await db('storage').where('key', 'git').first()
    const input = body(await read())
    input.targets.find((row) => row.key === 'git')!.isEnabled = false
    await store.save(admin, input)
    const saved = await db('storage').where('key', 'git').first()
    expect(saved.mode).toBe('unsupported-old-mode')
    expect(saved).toEqual({ ...before, isEnabled: false })
  })
  it('normalizes zero-duration schedules and rejects timer-overflow, busy-loop and unsupported schedules', async () => {
    let input = body(await read())
    input.targets.find((row) => row.key === 'git')!.syncInterval = 'PT0S'
    await store.save(admin, input)
    expect((await db('storage').where('key', 'git').first()).syncInterval).toBe('P0D')
    for (const interval of ['PT1S', 'P30D', 'garbage']) {
      input = body(await read())
      input.targets.find((row) => row.key === 'git')!.syncInterval = interval
      await expect(store.save(admin, input)).rejects.toMatchObject({ status: 400 })
    }
    input = body(await read())
    input.targets[0]!.syncInterval = 'PT1M'
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 400 })
  })
})
