import knexModule from 'knex'
import type { Knex } from 'knex'
import * as groupAdministration from '../../operations/group-administration.ts'
import type { GroupWorkspace } from '../../../shared/group-policy.ts'
import type { PagePrincipal } from '../../helpers/page-access.ts'
import { up as addGroupAdministration } from '../../db/migrations/tsepistle-000018-group-administration.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
const connection = getPostgresTestConnection('_controller_groups_test', import.meta.path)
const { createGroupAdministrationStore } = groupAdministration
const store = {
  list: vi.fn(),
  creationOptions: vi.fn(),
  create: vi.fn(),
  inspect: vi.fn(),
  members: vi.fn(),
  savePolicy: vi.fn(),
  changeMembers: vi.fn(),
  evaluate: vi.fn(),
  remove: vi.fn()
}
vi.mockModule('../../operations/group-administration.ts', import.meta.url, () => ({ getGroupAdministrationStore: () => store }))
const router = { get: vi.fn(), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
type Handler = (request: unknown, response: unknown) => Promise<void>
const handlers = new Map<string, Handler>(),
  response = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn() })
beforeAll(async () => {
  await vi.importFresh('../../controllers/api/groups.ts', import.meta.url)
  for (const method of ['get', 'put', 'post', 'patch', 'delete'] as const)
    for (const [path, handler] of router[method].mock.calls) if (path.includes('workspace')) handlers.set(`${method} ${path}`, handler as Handler)
})
beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset()
  globalThis.WIKI = { auth: { checkAccess: vi.fn().mockReturnValue(true) } } as never
})
describe('reviewed group workspace transports', () => {
  it('gates every workspace route and rejects malformed identifiers', async () => {
    ;(WIKI.auth.checkAccess as ReturnType<typeof vi.fn>).mockReturnValue(false)
    for (const handler of handlers.values()) {
      const res = response()
      await handler({ params: { id: '3' }, query: {}, body: {} }, res)
      expect(res.status).toHaveBeenCalledWith(403)
    }
    for (const fn of Object.values(store)) expect(fn).not.toHaveBeenCalled()
    ;(WIKI.auth.checkAccess as ReturnType<typeof vi.fn>).mockReturnValue(true)
    for (const id of ['0', '-1', '3x', '3.2']) {
      const res = response()
      await handlers.get('post /workspace/:id/members')!({ params: { id }, body: {} }, res)
      expect(res.status).toHaveBeenCalledWith(400)
    }
  })
  it('preserves actionable conflicts and hides unexpected persistence errors', async () => {
    store.savePolicy.mockRejectedValue(Object.assign(new Error('Reload this policy'), { status: 409 }))
    const conflict = response()
    await handlers.get('put /workspace/:id/policy')!({ params: { id: '3' }, body: {} }, conflict)
    expect(conflict.status).toHaveBeenCalledWith(409)
    expect(conflict.json).toHaveBeenCalledWith({ error: 'Reload this policy' })
    store.savePolicy.mockRejectedValue(new Error('SQL contains internal credentials'))
    const failed = response()
    await handlers.get('put /workspace/:id/policy')!({ params: { id: '3' }, body: {} }, failed)
    expect(failed.status).toHaveBeenCalledWith(500)
    expect(JSON.stringify(failed.json.mock.calls)).not.toContain('credentials')
  })
  it('keeps account-manager membership access narrower than policy access', async () => {
    ;(WIKI.auth.checkAccess as ReturnType<typeof vi.fn>).mockImplementation((_user, permissions) => permissions.includes('manage:users'))
    const user = { id: 9 }
    await handlers.get('get /workspace/:id/members')!({ user, params: { id: '3' }, query: {} }, response())
    expect(store.members).toHaveBeenCalledWith(user, 3, {})
    const res = response()
    await handlers.get('put /workspace/:id/policy')!({ user, params: { id: '3' }, body: {} }, res)
    expect(res.status).toHaveBeenCalledWith(403)
  })
})

if (connection) describe('PostgreSQL reviewed group workspace transport outcomes', () => {
  let db: Knex
  let persistence: {
    inspect(requester: PagePrincipal, id: number): Promise<GroupWorkspace>
    creationOptions(requester: PagePrincipal): Promise<{ fingerprint: string; allowedPermissions: string[] }>
  }
  const admin = { id: 7, authVersion: 0 } as never
  const policy = {
    name: 'Readers', description: '', redirectOnLogin: '/', permissions: ['read:pages'],
    pageRules: [{ id: 'all', match: 'START', path: '', deny: false, roles: ['read:pages'], locales: [] }]
  }
  const tables = ['groupAdministrationEvents', 'tags', 'agentSkillGrants', 'agentProviderGrants', 'navigation', 'authentication', 'apiKeys', 'userAdministrationEvents', 'userGroups', 'groups', 'users']
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection })
    await db.schema.createTable('users', table => {
      table.integer('id').primary(); table.string('name'); table.string('email'); table.boolean('isActive').defaultTo(true)
      table.boolean('isSystem').defaultTo(false); table.integer('authVersion').defaultTo(0); table.string('adminRevision').defaultTo(''); table.timestamp('sessionsRevokedAt')
    })
    await db.schema.createTable('groups', table => {
      table.increments('id'); table.string('name'); table.string('redirectOnLogin'); table.json('permissions'); table.json('pageRules')
      table.boolean('isSystem'); table.string('createdAt'); table.string('updatedAt')
    })
    await db.schema.createTable('userGroups', table => { table.integer('userId').references('users.id'); table.integer('groupId').references('groups.id').onDelete('CASCADE'); table.primary(['userId', 'groupId']) })
    await db.schema.createTable('userAdministrationEvents', table => { table.increments('id'); table.integer('userId'); table.integer('actorId'); table.string('action'); table.string('reason'); table.jsonb('details'); table.timestamp('createdAt') })
    await db.schema.createTable('apiKeys', table => { table.increments('id'); table.text('key'); table.boolean('isRevoked'); table.string('expiration') })
    await db.schema.createTable('authentication', table => { table.string('key').primary(); table.json('autoEnrollGroups') })
    await db.schema.createTable('navigation', table => { table.string('key').primary(); table.json('config') })
    for (const name of ['agentProviderGrants', 'agentSkillGrants']) await db.schema.createTable(name, table => { table.integer('groupId').references('groups.id').onDelete('CASCADE') })
    await db.schema.createTable('tags', table => { table.increments('id'); table.string('tag'); table.integer('redirectToId'); table.boolean('isArchived') })
    await addGroupAdministration(db)
  })
  afterAll(async () => { if (db) { for (const table of tables) await db.schema.dropTableIfExists(table); await db.destroy() } })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    await db('users').insert([1, 2, 3, 7, 8, 9].map(id => ({ id, name: `Person ${id}`, email: `person${id}@example.invalid`, isSystem: id <= 2, isActive: true, authVersion: 0, adminRevision: '' })))
    await db('groups').insert([
      { id: 1, name: 'Administrators', permissions: ['manage:system'], pageRules: [], isSystem: true },
      { id: 2, name: 'Guests', permissions: ['read:pages'], pageRules: policy.pageRules, isSystem: true },
      { id: 3, name: 'Readers', permissions: ['read:pages'], pageRules: policy.pageRules, isSystem: false },
      { id: 4, name: 'Other', permissions: [], pageRules: [], isSystem: false }
    ].map(row => ({ ...row, permissions: JSON.stringify(row.permissions), pageRules: JSON.stringify(row.pageRules), redirectOnLogin: '/', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })))
    await db.raw("SELECT setval(pg_get_serial_sequence('groups','id'), 4)")
    await db('userGroups').insert([{ userId: 7, groupId: 1 }, { userId: 3, groupId: 3 }, { userId: 8, groupId: 4 }, { userId: 9, groupId: 4 }])
    const realStore = createGroupAdministrationStore({ db })
    persistence = realStore
    for (const [name, method] of Object.entries(store)) method.mockImplementation(Reflect.get(realStore, name))
  })
  it('creates, updates, adds membership, evaluates without writes and deletes the intended group with reviewed actor/history/session outcomes', async () => {
    const options = await persistence.creationOptions(admin)
    const createBody = { policy: { ...policy, name: 'Research', description: 'Research team' }, reason: 'Create research group', fingerprint: options.fingerprint }
    const createdResponse = response()
    await handlers.get('post /workspace')!({ user: admin, body: createBody }, createdResponse)
    expect(createdResponse.status).toHaveBeenCalledWith(201)
    expect(createdResponse.json).toHaveBeenCalledTimes(1)
    const created = createdResponse.json.mock.calls[0]![0]
    expect(created).toMatchObject({ sessionsEnded: 0, currentSessionEnded: false })
    const createdGroup = await persistence.inspect(admin, created.id)
    expect(createdGroup).toMatchObject({ id: created.id, name: 'Research', description: 'Research team', memberCount: 0 })
    expect(createdGroup.history[0]).toMatchObject({ action: 'group-created', actorId: 7, reason: createBody.reason })
    const beforeStaleCreation = await db('groups').orderBy('id')
    const staleCreation = response()
    await handlers.get('post /workspace')!({ user: admin, body: { ...createBody, policy: { ...createBody.policy, name: 'Stale research' } } }, staleCreation)
    expect(staleCreation.status).toHaveBeenCalledWith(409)
    expect(await db('groups').orderBy('id')).toEqual(beforeStaleCreation)
    const initial = await persistence.inspect(admin, 3)
    const policyBody = { policy: { ...policy, description: 'Reviewed reader purpose' }, fingerprint: initial.fingerprint, reason: 'Clarify reader purpose' }
    const savedResponse = response()
    await handlers.get('put /workspace/:id/policy')!({ user: admin, params: { id: '3' }, body: policyBody }, savedResponse)
    expect(savedResponse.json).toHaveBeenCalledWith({ id: 3, sessionsEnded: 0, currentSessionEnded: false })
    const saved = await persistence.inspect(admin, 3)
    expect(saved.description).toBe('Reviewed reader purpose')
    expect(saved.history[0]).toMatchObject({ action: 'policy-updated', actorId: 7, reason: policyBody.reason })
    expect((await persistence.inspect(admin, 4)).description).toBe('')
    const stale = response()
    await handlers.get('put /workspace/:id/policy')!({ user: admin, params: { id: '3' }, body: { ...policyBody, policy: { ...policy, description: 'Stale purpose' } } }, stale)
    expect(stale.status).toHaveBeenCalledWith(409)
    expect(await persistence.inspect(admin, 3)).toEqual(saved)
    const denied = response()
    await handlers.get('put /workspace/:id/policy')!({ user: { id: 9, authVersion: 0 }, params: { id: '3' }, body: { ...policyBody, fingerprint: saved.fingerprint } }, denied)
    expect(denied.status).toHaveBeenCalledWith(403)
    expect(await persistence.inspect(admin, 3)).toEqual(saved)
    const memberBody = { action: 'add', userIds: [8], reason: 'Enroll reviewed reader', fingerprint: saved.fingerprint }
    const membersResponse = response()
    await handlers.get('post /workspace/:id/members')!({ user: admin, params: { id: '3' }, body: memberBody }, membersResponse)
    expect(membersResponse.json).toHaveBeenCalledWith({ id: 3, sessionsEnded: 1, currentSessionEnded: false })
    expect(await db('userGroups').where({ groupId: 3, userId: 8 }).first()).toMatchObject({ groupId: 3, userId: 8 })
    expect((await db('users').where('id', 8).first()).authVersion).toBe(1)
    expect((await db('userAdministrationEvents').where('userId', 8).first())).toMatchObject({ actorId: 7, action: 'membership-updated', reason: memberBody.reason })
    const memberSaved = await persistence.inspect(admin, 3)
    expect(memberSaved.history[0]).toMatchObject({ actorId: 7, action: 'members-added', reason: memberBody.reason })
    const staleMembers = response()
    await handlers.get('post /workspace/:id/members')!({ user: admin, params: { id: '3' }, body: { ...memberBody, action: 'remove' } }, staleMembers)
    expect(staleMembers.status).toHaveBeenCalledWith(409)
    expect(await persistence.inspect(admin, 3)).toEqual(memberSaved)
    const beforeEvaluation = await db('groups').orderBy('id')
    const evaluation = response()
    await handlers.get('post /workspace/:id/evaluate')!({ user: admin, params: { id: '3' }, body: { permission: 'read:pages', path: 'home', locale: 'en', tags: [] } }, evaluation)
    expect(evaluation.json).toHaveBeenCalledTimes(1)
    expect(evaluation.json.mock.calls[0]![0]).toMatchObject({ allowed: true, source: 'saved', scope: 'group', fingerprint: memberSaved.fingerprint })
    expect(await db('groups').orderBy('id')).toEqual(beforeEvaluation)
    expect(await persistence.inspect(admin, 3)).toEqual(memberSaved)
    const staleDelete = response()
    await handlers.get('delete /workspace/:id')!({ user: admin, params: { id: '3' }, body: { reason: 'Stale removal review', fingerprint: saved.fingerprint } }, staleDelete)
    expect(staleDelete.status).toHaveBeenCalledWith(409)
    expect(await persistence.inspect(admin, 3)).toEqual(memberSaved)
    const removed = response()
    await handlers.get('delete /workspace/:id')!({ user: admin, params: { id: '3' }, body: { reason: 'Retire reviewed group', fingerprint: memberSaved.fingerprint } }, removed)
    expect(removed.json).toHaveBeenCalledWith({ id: 3, sessionsEnded: 2, currentSessionEnded: false })
    expect(await db('groups').where('id', 3).first()).toBeUndefined()
    expect(await db('groups').where('id', 4).first()).toMatchObject({ name: 'Other' })
    expect((await db('groupAdministrationEvents').where({ groupId: 3, action: 'group-deleted' }).first())).toMatchObject({ actorId: 7, reason: 'Retire reviewed group' })
    expect((await db('users').where('id', 8).first()).authVersion).toBe(2)
  })
})
