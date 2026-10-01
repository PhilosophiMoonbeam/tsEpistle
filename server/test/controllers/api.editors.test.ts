import knexModule from 'knex'
import type { Knex } from 'knex'
import * as editorOperations from '../../operations/editors.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
const connection = getPostgresTestConnection('_controller_editors_test', import.meta.path)
const { saveEditorPolicy: realSaveEditorPolicy, createEditorPolicyStore } = editorOperations
const router = { use: vi.fn(), get: vi.fn(), put: vi.fn() }, read = vi.fn(), write = vi.fn(), access = vi.fn(), warn = vi.fn()
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
vi.mockModule('../../operations/editors.ts', import.meta.url, () => ({ editorWorkspace: read, saveEditorPolicy: write }))
vi.mockModule('../../controllers/_types.ts', import.meta.url, () => ({ getWikiAuth: () => ({ checkAccess: access }), getTransportRuntime: () => ({ logger: { warn } }), errorStatus: (error: { status?: number }) => error.status }))
await import('../../controllers/api/editors.ts')
const middleware = router.use.mock.calls[0]![0], get = router.get.mock.calls[0]![1], put = router.put.mock.calls[0]![1]
const response = () => ({ set: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() })
describe('editor policy transport', () => {
  beforeEach(() => { for (const mock of [read, write, access, warn]) mock.mockReset() })
  it('requires system administration and prevents caching policy or private usage counts', () => {
    const res = response(), next = vi.fn()
    access.mockReturnValue(false); middleware({ user: undefined }, res, next)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store'); expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled()
    access.mockReturnValue(true); middleware({ user: { id: 1 } }, res, next); expect(next).toHaveBeenCalledTimes(1)
  })
  it('preserves review conflicts and redacts internal persistence errors', async () => {
    let res = response(); write.mockRejectedValue(Object.assign(new Error('Reload the saved policy'), { status: 409 }))
    await put({ user: {}, body: {} }, res); expect(res.status).toHaveBeenCalledWith(409); expect(res.json).toHaveBeenCalledWith({ error: 'Reload the saved policy' })
    const failure = Object.assign(new Error('internal database details'), { cause: { connection: 'private-editor-database-connection' } }); read.mockRejectedValue(failure); res = response()
    await get({ user: {} }, res); expect(res.status).toHaveBeenCalledWith(500); expect(warn).toHaveBeenCalledWith(failure)
    expect(res.json).toHaveBeenCalledTimes(1)
    const publicBody = res.json.mock.calls[0]![0]
    expect(publicBody).toEqual(expect.objectContaining({ error: expect.any(String) }))
    expect(publicBody).not.toHaveProperty('stack')
    expect(JSON.stringify(publicBody)).not.toContain('internal database details')
    expect(JSON.stringify(publicBody)).not.toContain('private-editor-database-connection')
    expect(publicBody).not.toHaveProperty('cause')
    expect(publicBody).not.toHaveProperty('error.cause')
  })
})

if (connection) describe('PostgreSQL editor policy transport outcomes', () => {
  let db: Knex
  const admin = { id: 7, permissions: ['manage:system'] }
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection })
    await db.schema.createTable('settings', table => { table.string('key').primary(); table.jsonb('value'); table.string('updatedAt').notNullable() })
  })
  afterAll(async () => { if (db) { await db.schema.dropTableIfExists('settings'); await db.destroy() } })
  beforeEach(async () => {
    await db('settings').delete()
    await db('settings').insert({ key: 'editors', value: JSON.stringify({ available: ['markdown', 'code'], recommended: null }), updatedAt: '2026-09-01T00:00:00Z' })
    const checkAccess = (user: typeof admin | undefined) => user?.id === admin.id && user.permissions.includes('manage:system')
    access.mockReset().mockImplementation(checkAccess)
    write.mockReset().mockImplementation(realSaveEditorPolicy)
    globalThis.WIKI = {
      auth: { checkAccess }, models: { knex: db }, config: { editors: {} },
      data: { editors: [{ key: 'markdown' }, { key: 'code' }] },
      events: { outbound: { emit: () => { throw new Error('notification unavailable') } } }, logger: { warn }
    } as never
  })
  it('saves normalized registered policy and warnings, rejecting stale reviews and other principals without mutation', async () => {
    const persistence = createEditorPolicyStore({ db, fallback: () => ({}), activate: async () => [] })
    const initial = await persistence.read()
    const body = { available: ['markdown'], recommended: 'markdown', fingerprint: initial.fingerprint }
    const saved = response()
    await put({ user: admin, body }, saved)
    expect(saved.status).not.toHaveBeenCalled()
    expect(saved.json).toHaveBeenCalledTimes(1)
    const result = saved.json.mock.calls[0]![0]
    expect(result.policy).toMatchObject({ available: ['markdown'], recommended: 'markdown' })
    expect(result.policy.fingerprint).not.toBe(initial.fingerprint)
    expect(result.warnings).toEqual([expect.any(String)])
    expect(await persistence.read()).toEqual(result.policy)
    expect((await db('settings').where('key', 'editors').first()).value).toMatchObject({ available: ['markdown'], recommended: 'markdown' })
    const before = await db('settings').orderBy('key')
    const stale = response()
    await put({ user: admin, body: { ...body, available: ['code'], recommended: 'code' } }, stale)
    expect(stale.status).toHaveBeenCalledWith(409)
    expect(await db('settings').orderBy('key')).toEqual(before)
    const denied = response()
    await put({ user: { id: 9, permissions: [] }, body: { ...body, fingerprint: result.policy.fingerprint } }, denied)
    expect(denied.status).toHaveBeenCalledWith(403)
    expect(await db('settings').orderBy('key')).toEqual(before)
  })
})
