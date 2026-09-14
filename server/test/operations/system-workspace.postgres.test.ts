import { randomUUID } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '../bun-test.mts'
import { createSystemWorkspaceStore } from '../../operations/system-workspace.ts'
import { SYSTEM_CONNECTION_APPLICATION_PREFIX, systemSupportReport } from '../../../shared/system-workspace.ts'
import { systemWorkspaceFixture } from '../fixtures/system-workspace.ts'
import { up as createQueue } from '../../db/migrations/2.5.130.ts'
const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? '',
  password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_system_test') && password
    ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT), user: 'wiki', database, password }
    : null
const suite = connection ? describe : describe.skip,
  admin = { id: 1, authVersion: 0 } as never,
  now = new Date('2026-09-06T12:00:00Z')
suite('System observations against PostgreSQL', () => {
  let db: Knex,
    store: ReturnType<typeof createSystemWorkspaceStore>,
    supported: string[],
    taggedConnections: Knex[] = []
  const openTaggedConnection = async (identity: string, role: string): Promise<Knex> => {
    const tagged = knexModule({
      client: 'pg',
      connection: { ...connection!, application_name: `${SYSTEM_CONNECTION_APPLICATION_PREFIX}${identity}/${role}` },
      pool: { min: 1, max: 1 }
    })
    taggedConnections.push(tagged)
    await tagged.raw('SELECT 1')
    return tagged
  }
  const closeTaggedConnections = async (): Promise<void> => {
    for (const tagged of taggedConnections.splice(0)) await tagged.destroy()
  }
  const row = (patch: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    type: 'deliver-webhook',
    version: 1,
    state: 'pending',
    payload: '{"secret":"private payload"}',
    attempts: 0,
    maxAttempts: 5,
    nextRunAt: now,
    createdAt: now,
    updatedAt: now,
    lastError: 'credential-bearing failure',
    ...patch
  })
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.schema.createTable('users', t => {
      t.integer('id').primary()
      t.boolean('isActive')
      t.integer('authVersion')
    })
    await db.schema.createTable('groups', t => {
      t.integer('id').primary()
      t.jsonb('permissions')
    })
    await db.schema.createTable('userGroups', t => {
      t.integer('userId')
      t.integer('groupId')
    })
    await db.schema.createTable('migrations', t => {
      t.increments('id')
      t.string('name')
    })
    await createQueue(db)
  })
  afterAll(async () => {
    await closeTaggedConnections()
    if (db) {
      for (const table of ['durableJobs', 'migrations', 'userGroups', 'groups', 'users']) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    await closeTaggedConnections()
    for (const table of ['durableJobs', 'migrations', 'userGroups', 'groups', 'users']) await db(table).delete()
    await db('users').insert([
      { id: 1, isActive: true, authVersion: 0 },
      { id: 3, isActive: true, authVersion: 0 },
      { id: 2, isActive: true, authVersion: 0 }
    ])
    await db('groups').insert([
      { id: 1, permissions: JSON.stringify(['manage:system']) },
      { id: 2, permissions: '[]' }
    ])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 3, groupId: 2 }
    ])
    await db('migrations').insert({ name: 'one.js' })
    supported = ['deliver-webhook@1']
    const fixture = systemWorkspaceFixture()
    store = createSystemWorkspaceStore({
      db,
      now: () => now,
      product: () => fixture.product,
      runtime: () => fixture.runtime,
      scheduler: () => fixture.scheduler,
      migrationNames: async () => ['one.js'],
      supportedJobs: () => supported,
      databaseHost: () => fixture.database.host
    })
  })
  it('aggregates tagged open connections by opaque identity and role, and drops identities after close', async () => {
    const identityA = '00000000-0000-4000-8000-000000000001'
    const identityB = '00000000-0000-4000-8000-000000000002'
    const pool = await openTaggedConnection(identityA, 'pool')
    const listener = await openTaggedConnection(identityA, 'listener')
    await openTaggedConnection(identityB, 'worker')
    await openTaggedConnection(identityB, 'future')

    const observed = (await store.inspect(admin)).database.connectedProcesses
    expect(observed.status).toBe('observed')
    expect(observed.processes).toHaveLength(2)
    expect(observed.processes.find(process => process.identity === identityA)).toMatchObject({
      connections: { pool: 1, listener: 1, worker: 0, unclassified: 0 }
    })
    expect(observed.processes.find(process => process.identity === identityB)).toMatchObject({
      connections: { pool: 0, listener: 0, worker: 1, unclassified: 1 }
    })
    expect(observed.processes.find(process => process.identity === identityA)?.earliestBackendStart).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    await pool.destroy()
    await listener.destroy()
    taggedConnections = taggedConnections.filter(tagged => tagged !== pool && tagged !== listener)
    const afterClose = (await store.inspect(admin)).database.connectedProcesses
    expect(afterClose.processes.find(process => process.identity === identityA)).toBeUndefined()
  })
  it('collects a real version query and distinguishes pending/unknown migrations without changing the ledger', async () => {
    await db('migrations').delete()
    await db('migrations').insert({ name: 'foreign.js' })
    const before = await db('migrations'),
      result = await store.inspect(admin)
    expect(result.database.version).toMatch(/^17\./)
    expect(result.database.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.database.migrations).toEqual({ applied: ['foreign.js'], pending: ['one.js'], unknown: ['foreign.js'] })
    expect(await db('migrations')).toEqual(before)
  })
  it('rechecks account activity, session generation and current group permissions', async () => {
    for (const user of [undefined, { id: 2, authVersion: 0 }, { id: 3, authVersion: 0 }, { id: 1, authVersion: 1 }])
      await expect(store.inspect(user as never)).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ isActive: false })
    await expect(store.inspect(admin)).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ isActive: true })
    await db('groups').where('id', 1).update({ permissions: '[]' })
    await expect(store.inspect(admin)).rejects.toMatchObject({ status: 403 })
  })
  it('accepts only current system groups for unowned API principals', async () => {
    const token = { id: 1, ownershipUserId: null, groups: [1] } as never
    expect((await store.inspect(token)).runtime.instanceId).toBe('instance-private')
    for (const user of [
      { id: 1, ownershipUserId: null, groups: [2] },
      { id: 1, ownershipUserId: null, groups: [1, 2] },
      { id: 3, ownershipUserId: null, groups: [1] }
    ])
      await expect(store.inspect(user as never)).rejects.toMatchObject({ status: 403 })
    await db('groups').where('id', 1).update({ permissions: '[]' })
    await expect(store.inspect(token)).rejects.toMatchObject({ status: 403 })
  })
  it('deduplicates attention categories and does not expose or mutate job payloads, leases or raw errors', async () => {
    const past = new Date(now.getTime() - 1000),
      future = new Date(now.getTime() + 60000)
    await db('durableJobs').insert([
      row(),
      row({ nextRunAt: future }),
      row({ state: 'running', leaseExpiresAt: past }),
      row({ state: 'running', leaseExpiresAt: future }),
      row({ state: 'failed' }),
      row({ type: 'future-job', state: 'running', leaseExpiresAt: past }),
      row({ version: 2 }),
      row({ state: 'succeeded' }),
      row({ state: 'cancelled' })
    ])
    const before = await db('durableJobs').orderBy('id'),
      result = await store.inspect(admin)
    expect(result.queue.counts).toEqual({ pending: 3, running: 3, failed: 1, succeeded: 1, cancelled: 1 })
    expect(result.queue).toMatchObject({ due: 2, expiredLeases: 2, unsupported: 2, totalAttention: 4 })
    expect(result.queue.attention).toHaveLength(4)
    expect(JSON.stringify(result)).not.toContain('private payload')
    expect(JSON.stringify(result)).not.toContain('credential-bearing')
    expect(JSON.stringify(result)).not.toContain('leaseOwner')
    expect(await db('durableJobs').orderBy('id')).toEqual(before)
  })
  it('limits attention detail to the latest fifty with stable ordering and retains full aggregate counts', async () => {
    await db('durableJobs').insert(Array.from({ length: 61 }, (_, i) => row({ state: 'failed', updatedAt: new Date(now.getTime() + i * 1000) })))
    const result = await store.inspect(admin)
    expect(result.queue.totalAttention).toBe(61)
    expect(result.queue.attention).toHaveLength(50)
    expect(result.queue.attention[0]?.updatedAt).toBe(new Date(now.getTime() + 60000).toISOString())
    expect(result.queue.attention.at(-1)?.updatedAt).toBe(new Date(now.getTime() + 11000).toISOString())
  })
  it('treats an empty build handler catalog as unsupported and keeps future scheduled work separate from due work', async () => {
    supported = []
    await db('durableJobs').insert(row({ nextRunAt: new Date(now.getTime() + 50000) }))
    expect((await store.inspect(admin)).queue).toMatchObject({ due: 0, unsupported: 1, totalAttention: 1 })
  })
  it('produces an explicitly redacted support report and includes reviewed deployment identifiers only by opt-in', async () => {
    const exportIdentity = '00000000-0000-4000-8000-000000000003'
    await openTaggedConnection(exportIdentity, 'worker')
    const job = row({ state: 'failed' })
    const result = await store.inspect(admin),
      redacted = JSON.stringify(systemSupportReport(result)),
      expanded = JSON.stringify(systemSupportReport(result, true))
    expect(redacted).not.toContain(exportIdentity)
    expect(expanded).toContain(exportIdentity)
    for (const privateValue of [
      'instance-private',
      'private-host',
      'private-database',
      '/private/',
      'private.example.test',
      job.id,
      'private payload',
      'credential-bearing'
    ])
      expect(redacted).not.toContain(privateValue)
    expect(expanded).toContain('private-host')
    expect(expanded).toContain('private-database')
    expect(expanded).not.toContain(job.id)
    expect(expanded).not.toContain('private payload')
  })
})
