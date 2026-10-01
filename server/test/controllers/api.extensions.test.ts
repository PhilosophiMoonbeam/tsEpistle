import knexModule from 'knex'
import type { Knex } from 'knex'
import * as extensionsWorkspace from '../../operations/extensions-workspace.ts'
import { createApiPrincipal } from '../../helpers/api-principal.ts'
import type { ExtensionWorkspaceExtension } from '../../../shared/extensions-workspace.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
const connection = getPostgresTestConnection('_controller_extensions_test', import.meta.path)
const { createExtensionsWorkspaceStore } = extensionsWorkspace

const router = { get: vi.fn() }
const inspect = vi.fn()
const checkAccess = vi.fn()

vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
vi.mockModule('../../operations/extensions-workspace.ts', import.meta.url, () => ({ getExtensionsWorkspaceStore: () => ({ inspect }) }))
vi.mockModule('../../controllers/_types.ts', import.meta.url, () => ({
  errorStatus: (error: { status?: number }) => error.status,
  getWikiAuth: () => ({ checkAccess })
}))

await import('../../controllers/api/extensions.ts')

const workspace = router.get.mock.calls.find(([path]) => path === '/workspace')![1]
const response = () => ({ set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn() })

describe('Extensions deployment observations API', () => {
  beforeEach(() => {
    inspect.mockReset()
    checkAccess.mockReset().mockReturnValue(true)
    inspect.mockResolvedValue({ observedAt: '2026-09-07T00:00:00.000Z', extensions: [] })
  })

  it('prevents caching read-only process observations', async () => {
    const res = response()

    await workspace({ user: { id: 7 } }, res)

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })

  it('rejects unauthorized reads before process inspection and redacts unexpected failures', async () => {
    checkAccess.mockReturnValue(false)
    let res = response()

    await workspace({ user: { id: 7 } }, res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(inspect).not.toHaveBeenCalled()

    checkAccess.mockReturnValue(true)
    inspect.mockRejectedValueOnce(Error('private process path /srv/secret'))
    res = response()
    await workspace({ user: { id: 7 } }, res)
    expect(res.status).toHaveBeenCalledWith(503)
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('/srv/secret')
  })
})

if (connection) describe('PostgreSQL request-bound Extensions authority', () => {
  let db: Knex
  const runtimeInspection = vi.fn()
  const tables = ['userGroups', 'users', 'groups', 'apiKeys']
  const browser = { user: { id: 7, authVersion: 2 } }
  const credential = {
    user: createApiPrincipal(11, 3, ['manage:system']),
    apiKeyAuth: { apiKeyId: 11, groupId: 3, expiresAt: Date.parse('2099-01-01T00:00:00Z') / 1000 }
  }
  const observation: ExtensionWorkspaceExtension = {
    key: 'git', title: 'Git', description: 'Repository integration',
    installation: { boundary: 'application-image', detail: 'Bundled binary', recovery: 'Repair deployment' },
    capabilities: [], dependencies: [],
    observation: { state: 'usable', compatibility: 'verified', evidence: 'Controlled executable observation', checkedAt: '2026-09-07T00:00:00.000Z' }
  }
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection })
    await db.schema.createTable('groups', table => { table.integer('id').primary(); table.json('permissions'); table.string('adminRevision').defaultTo('') })
    await db.schema.createTable('users', table => { table.integer('id').primary(); table.boolean('isActive').notNullable(); table.integer('authVersion').notNullable() })
    await db.schema.createTable('userGroups', table => { table.integer('userId'); table.integer('groupId'); table.primary(['userId', 'groupId']) })
    await db.schema.createTable('apiKeys', table => { table.integer('id').primary(); table.boolean('isRevoked').notNullable(); table.string('expiration').notNullable() })
  })
  afterAll(async () => { if (db) { for (const table of tables) await db.schema.dropTableIfExists(table); await db.destroy() } })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    await db('groups').insert([{ id: 3, permissions: JSON.stringify(['manage:system']) }, { id: 4, permissions: JSON.stringify(['read:pages']) }])
    await db('users').insert([{ id: 7, authVersion: 2, isActive: true }, { id: 9, authVersion: 0, isActive: true }])
    await db('userGroups').insert([{ userId: 7, groupId: 3 }, { userId: 9, groupId: 4 }])
    await db('apiKeys').insert({ id: 11, isRevoked: false, expiration: '2099-01-01T00:00:00Z' })
    checkAccess.mockReset().mockReturnValue(true)
    runtimeInspection.mockReset().mockResolvedValue([observation])
    const realStore = createExtensionsWorkspaceStore({ db, extensions: { inspect: runtimeInspection }, now: () => new Date('2026-09-07T00:00:00.000Z') })
    inspect.mockReset().mockImplementation(realStore.inspect)
  })
  it('observes only after actual browser-session or scoped credential authority passes', async () => {
    for (const request of [browser, credential]) {
      runtimeInspection.mockClear()
      const res = response()
      await workspace(request, res)
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
      expect(res.status).not.toHaveBeenCalled()
      expect(runtimeInspection).toHaveBeenCalledTimes(1)
      expect(res.json).toHaveBeenCalledTimes(1)
      const observed = res.json.mock.calls[0]![0]
      expect(observed.observedAt).toBe('2026-09-07T00:00:00.000Z')
      expect(observed.extensions[0]).toMatchObject({ key: 'git', observation: { state: 'usable', compatibility: 'verified' } })
    }
    for (const request of [
      { user: { id: 9, authVersion: 0 } },
      { user: { id: 7, authVersion: 1 } },
      { user: credential.user },
      { ...credential, apiKeyAuth: { ...credential.apiKeyAuth, apiKeyId: 12 } }
    ]) {
      runtimeInspection.mockClear()
      const res = response()
      await workspace(request, res)
      expect(res.status).toHaveBeenCalledWith(403)
      expect(runtimeInspection).not.toHaveBeenCalled()
    }
    await db('apiKeys').where('id', 11).update({ isRevoked: true })
    runtimeInspection.mockClear()
    const revoked = response()
    await workspace(credential, revoked)
    expect(revoked.status).toHaveBeenCalledWith(403)
    expect(runtimeInspection).not.toHaveBeenCalled()
  })
})
