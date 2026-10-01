import knexModule from 'knex'
import type { Knex } from 'knex'
import * as generalAdministration from '../../operations/general-administration.ts'
import { generalPolicyDefaults } from '../../../shared/general-policy.ts'
import type { GeneralWorkspace, GeneralWriteResult } from '../../../shared/general-policy.ts'
import type { PagePrincipal } from '../../helpers/page-access.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
const connection = getPostgresTestConnection('_controller_general_test', import.meta.path)
const { createGeneralAdministrationStore } = generalAdministration
import { configureTransportRuntime } from '../../controllers/_types.ts'
const router = { get: vi.fn(), put: vi.fn(), post: vi.fn() },
  store = { inspect: vi.fn(), save: vi.fn(), initialize: vi.fn() },
  checkAccess = vi.fn()
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
vi.mockModule('../../operations/site.ts', import.meta.url, () => ({ default: {} }))
vi.mockModule('../../operations/general-administration.ts', import.meta.url, () => ({ getGeneralAdministrationStore: () => store }))
await vi.importFresh('../../controllers/api/site.ts', import.meta.url)
const read = router.get.mock.calls.find(([path]) => path === '/general')![1]!,
  save = router.put.mock.calls.find(([path]) => path === '/general')![1]!,
  initialize = router.post.mock.calls.find(([path]) => path === '/general/activate')![1]!
const response = () => {
  const res = { status: vi.fn(), set: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}
beforeEach(() => {
  checkAccess.mockReturnValue(true)
  for (const method of Object.values(store)) method.mockReset().mockResolvedValue({})
  configureTransportRuntime({ auth: { checkAccess } })
})
afterAll(() => configureTransportRuntime({}))
describe('General workspace transport', () => {
  it('requires system access before reads, writes and runtime retries', async () => {
    checkAccess.mockReturnValue(false)
    for (const handler of [read, save, initialize]) {
      const res = response()
      await handler({}, res)
      expect(res.status).toHaveBeenCalledWith(403)
    }
    for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled()
  })
  it('prevents caching each independent read, save and runtime retry response', async () => {
    const user = { id: 1, authVersion: 2 },
      body = { policy: { ...generalPolicyDefaults, title: 'New name' }, fingerprint: 'review', reason: 'Update workspace identity' }
    const readResponse = response()
    await read({ user }, readResponse)
    expect(readResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    const saveResponse = response()
    await save({ user, body }, saveResponse)
    expect(saveResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    const retryResponse = response()
    await initialize({ user, body: { fingerprint: body.fingerprint } }, retryResponse)
    expect(retryResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
  it('preserves expected authority, validation and conflict errors', async () => {
    for (const status of [400, 403, 409]) {
      store.save.mockRejectedValue(Object.assign(new Error('Reload policy'), { status }))
      const res = response()
      await save({ user: {}, body: {} }, res)
      expect(res.status).toHaveBeenCalledWith(status)
      expect(res.json).toHaveBeenCalledWith({ error: 'Reload policy' })
    }
  })
  it('does not expose internal database errors', async () => {
    store.inspect.mockRejectedValue(Object.assign(new Error('private database configuration'), { cause: { connection: 'private-general-database-connection' } }))
    const res = response()
    await read({ user: {} }, res)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledTimes(1)
    const publicBody = res.json.mock.calls[0]![0]
    expect(publicBody).toEqual(expect.objectContaining({ error: expect.any(String) }))
    expect(publicBody).not.toHaveProperty('stack')
    expect(JSON.stringify(publicBody)).not.toContain('private database configuration')
    expect(JSON.stringify(publicBody)).not.toContain('private-general-database-connection')
    expect(publicBody).not.toHaveProperty('cause')
    expect(publicBody).not.toHaveProperty('error.cause')
  })
})

if (connection) describe('PostgreSQL General workspace transport outcomes', () => {
  let db: Knex
  let realStore: {
    inspect(requester: PagePrincipal): Promise<GeneralWorkspace>
    save(requester: PagePrincipal, body: { policy: unknown; fingerprint: unknown; reason: unknown }): Promise<GeneralWriteResult>
    initialize(requester: PagePrincipal, fingerprint: unknown): Promise<GeneralWriteResult>
  }
  const admin = { id: 1, authVersion: 2 } as never
  const tables = ['userGroups', 'users', 'groups', 'settings']
  let failActivation = true
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection })
    await db.schema.createTable('settings', table => { table.string('key').primary(); table.jsonb('value'); table.string('updatedAt').notNullable() })
    await db.schema.createTable('groups', table => { table.integer('id').primary(); table.json('permissions'); table.string('adminRevision').defaultTo('') })
    await db.schema.createTable('users', table => { table.integer('id').primary(); table.boolean('isActive').defaultTo(true); table.integer('authVersion').defaultTo(0) })
    await db.schema.createTable('userGroups', table => { table.integer('userId'); table.integer('groupId'); table.primary(['userId', 'groupId']) })
  })
  afterAll(async () => { if (db) { for (const table of tables) await db.schema.dropTableIfExists(table); await db.destroy() } })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    await db('settings').insert([{ key: 'host', value: JSON.stringify({ v: 'https://wiki.example.invalid' }) }, { key: 'title', value: JSON.stringify({ v: 'Original' }) }].map(row => ({ ...row, updatedAt: '2026-09-01T00:00:00Z' })))
    await db('groups').insert([{ id: 1, permissions: JSON.stringify(['manage:system']) }, { id: 3, permissions: JSON.stringify(['read:pages']) }])
    await db('users').insert([{ id: 1, authVersion: 2 }, { id: 9, authVersion: 0 }])
    await db('userGroups').insert([{ userId: 1, groupId: 1 }, { userId: 9, groupId: 3 }])
    failActivation = true
    let observed = structuredClone(generalPolicyDefaults)
    realStore = createGeneralAdministrationStore({
      db, reviewKey: 'controller-general-review-key', fallback: () => ({}), runtime: () => observed,
      async onCommitted() {
        if (failActivation) throw new Error('runtime unavailable')
        observed = (await realStore.inspect(admin)).policy
        return true
      }
    })
    store.inspect.mockImplementation(realStore.inspect)
    store.save.mockImplementation(realStore.save)
    store.initialize.mockImplementation(realStore.initialize)
  })
  it('reads saved settings, saves actor/reason history and retries the committed review while fencing stale or unauthorized callers', async () => {
    const initialResponse = response()
    await read({ user: admin }, initialResponse)
    expect(initialResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(initialResponse.json).toHaveBeenCalledTimes(1)
    const initial = initialResponse.json.mock.calls[0]![0]
    expect(initial.policy.title).toBe('Original')
    const body = { policy: { ...initial.policy, title: 'Reviewed title' }, fingerprint: initial.fingerprint, reason: 'Update workspace identity' }
    const savedResponse = response()
    await save({ user: admin, body }, savedResponse)
    expect(savedResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(savedResponse.json).toHaveBeenCalledWith({ activation: 'needs-attention' })
    const saved = await realStore.inspect(admin)
    expect(saved.policy.title).toBe('Reviewed title')
    expect(saved.history[0]).toMatchObject({ actorId: 1, reason: body.reason, fields: expect.arrayContaining(['title']) })
    expect((await db('settings').where('key', 'title').first()).value).toEqual({ v: 'Reviewed title' })
    failActivation = false
    const retryResponse = response()
    await initialize({ user: admin, body: { fingerprint: saved.fingerprint } }, retryResponse)
    expect(retryResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(retryResponse.json).toHaveBeenCalledWith({ activation: 'applied' })
    expect((await realStore.inspect(admin)).runtime.state).toBe('applied')
    const before = await db('settings').orderBy('key')
    for (const [handler, requestBody] of [
      [save, { ...body, policy: { ...body.policy, title: 'Stale title' } }],
      [initialize, { fingerprint: initial.fingerprint }]
    ] as const) {
      const stale = response()
      await handler({ user: admin, body: requestBody }, stale)
      expect(stale.status).toHaveBeenCalledWith(409)
      expect(await db('settings').orderBy('key')).toEqual(before)
    }
    for (const user of [{ id: 9, authVersion: 0 }, { id: 1, authVersion: 1 }]) {
      const denied = response()
      await save({ user, body: { ...body, policy: { ...body.policy, title: 'Unauthorized title' }, fingerprint: saved.fingerprint } }, denied)
      expect(denied.status).toHaveBeenCalledWith(403)
      expect(await db('settings').orderBy('key')).toEqual(before)
    }
  })
})
