import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from '../bun-test.mts'
import { createGroupAdministrationStore, getGroupAdministrationStore, normalizeGroupPolicy } from '../../operations/group-administration.ts'
import { up, down } from '../../db/migrations/tsepistle-000018-group-administration.ts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
const connection = getPostgresTestConnection('_group_test', import.meta.path)
const suite = connection ? describe : describe.skip
const admin = { id: 1, authVersion: 0 } as never,
  steward = { id: 4, authVersion: 0 } as never,
  manager = { id: 5, authVersion: 0 } as never
const policy = (name = 'Readers') => ({
  name,
  description: '',
  redirectOnLogin: '/',
  permissions: ['read:pages'],
  pageRules: [{ id: 'all', match: 'START', path: '', deny: false, roles: ['read:pages'], locales: [] }]
})
suite('PostgreSQL reviewed group administration', () => {
  let db: Knex, store: ReturnType<typeof createGroupAdministrationStore>
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    await db.schema.createTable('users', t => {
      t.integer('id').primary()
      t.string('name')
      t.string('email')
      t.boolean('isActive').defaultTo(true)
      t.boolean('isSystem').defaultTo(false)
      t.integer('authVersion').defaultTo(0)
      t.string('adminRevision').defaultTo('')
      t.timestamp('sessionsRevokedAt')
    })
    await db.schema.createTable('groups', t => {
      t.increments('id')
      t.string('name')
      t.string('redirectOnLogin')
      t.json('permissions')
      t.json('pageRules')
      t.boolean('isSystem')
      t.string('createdAt')
      t.string('updatedAt')
    })
    await db.schema.createTable('userGroups', t => {
      t.integer('userId').references('users.id')
      t.integer('groupId').references('groups.id').onDelete('CASCADE')
      t.primary(['userId', 'groupId'])
    })
    await db.schema.createTable('userAdministrationEvents', t => {
      t.increments('id')
      t.integer('userId')
      t.integer('actorId')
      t.string('action')
      t.string('reason')
      t.jsonb('details')
      t.timestamp('createdAt')
    })
    await db.schema.createTable('apiKeys', t => {
      t.increments('id')
      t.text('key')
      t.boolean('isRevoked')
      t.string('expiration')
    })
    await db.schema.createTable('authentication', t => {
      t.string('key').primary()
      t.json('autoEnrollGroups')
    })
    await db.schema.createTable('navigation', t => {
      t.string('key').primary()
      t.json('config')
    })
    for (const name of ['agentProviderGrants', 'agentSkillGrants'])
      await db.schema.createTable(name, t => {
        t.integer('groupId').references('groups.id').onDelete('CASCADE')
      })
    await db.schema.createTable('tags', t => {
      t.increments('id')
      t.string('tag')
      t.integer('redirectToId')
      t.boolean('isArchived')
    })
    await up(db)
    store = createGroupAdministrationStore({ db })
  })
  afterAll(async () => {
    if (!db) return
    for (const table of [
      'groupAdministrationEvents',
      'tags',
      'agentSkillGrants',
      'agentProviderGrants',
      'navigation',
      'authentication',
      'apiKeys',
      'userAdministrationEvents',
      'userGroups',
      'groups',
      'users'
    ])
      await db.schema.dropTableIfExists(table)
    await db.destroy()
  })
  beforeEach(async () => {
    for (const table of [
      'groupAdministrationEvents',
      'tags',
      'agentSkillGrants',
      'agentProviderGrants',
      'navigation',
      'authentication',
      'apiKeys',
      'userAdministrationEvents',
      'userGroups',
      'groups',
      'users'
    ])
      await db(table).delete()
    await db('users').insert(
      [1, 2, 3, 4, 5, 6].map(id => ({
        id,
        name: `Person ${id}`,
        email: `person${id}@example.invalid`,
        isSystem: id <= 2,
        isActive: true,
        authVersion: 0,
        adminRevision: ''
      }))
    )
    await db('groups').insert(
      [
        ['Administrators', ['manage:system']],
        ['Guests', ['read:pages']],
        ['Readers', ['read:pages']],
        ['Content stewards', ['write:groups']],
        ['Group managers', ['manage:groups']]
      ].map(([name, permissions], index) => ({
        id: index + 1,
        name,
        permissions: JSON.stringify(permissions),
        pageRules: JSON.stringify(policy().pageRules),
        redirectOnLogin: '/',
        isSystem: index < 2,
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z'
      }))
    )
    await db.raw("SELECT setval(pg_get_serial_sequence('groups','id'), 5)")
    await db('userGroups').insert([1, 2, 3, 4, 5].map(id => ({ userId: id, groupId: id })))
  })
  const review = async (id = 3, actor = admin) => ({
    fingerprint: (await store.inspect(actor, id)).fingerprint,
    reason: 'Reviewed group administration verification'
  })
  it('creates a deliberately reviewed policy and records its purpose', async () => {
    const options = await store.creationOptions(steward),
      created = await store.create(steward, {
        ...options,
        policy: { ...policy('Research'), description: 'Research team access' },
        reason: 'Create a research workspace group'
      })
    const read = await store.inspect(admin, created.id)
    expect(read.description).toBe('Research team access')
    expect(read.memberCount).toBe(0)
    expect(read.history[0]?.action).toBe('group-created')
    await expect(store.create(steward, { ...options, policy: policy('Other'), reason: 'Stale creation review' })).rejects.toMatchObject({ status: 409 })
  })
  it('persists clearable purpose without ending sessions; permission changes end sessions', async () => {
    await store.savePolicy(steward, 3, { ...(await review(3, steward)), policy: { ...policy(), description: 'Temporary purpose' } })
    expect((await db('users').where('id', 3).first()).authVersion).toBe(0)
    await store.savePolicy(steward, 3, { ...(await review(3, steward)), policy: { ...policy(), permissions: ['read:pages', 'write:pages'] } })
    const read = await store.inspect(admin, 3)
    expect(read.description).toBe('')
    expect(read.permissions).toContain('write:pages')
    expect((await db('users').where('id', 3).first()).authVersion).toBe(1)
    expect(read.history).toHaveLength(2)
  })
  it('accepts one concurrent review and rejects ABA edits', async () => {
    const input = { ...(await review()), policy: { ...policy(), description: 'Reviewed change' } },
      results = await Promise.allSettled([store.savePolicy(admin, 3, input), store.savePolicy(admin, 3, input)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    await store.savePolicy(admin, 3, { ...(await review()), policy: policy() })
    await expect(store.savePolicy(admin, 3, input)).rejects.toMatchObject({ status: 409 })
  })
  it('uses current actor authority and target authority, including password-only session changes', async () => {
    const input = await review(3, steward)
    await db('groups')
      .where('id', 4)
      .update({ permissions: JSON.stringify([]) })
    await expect(store.savePolicy(steward, 3, { ...input, policy: { ...policy(), description: 'No longer authorized' } })).rejects.toMatchObject({
      status: 403
    })
    await expect(
      store.savePolicy(manager, 1, { ...(await review(1, manager)), policy: { ...policy('Administrators'), permissions: ['manage:system'] } })
    ).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 5).update({ authVersion: 1 })
    await expect(store.inspect(manager, 3)).rejects.toMatchObject({ status: 403 })
  })
  it('protects identities, system permissions and self-membership', async () => {
    await expect(store.savePolicy(admin, 1, { ...(await review(1)), policy: { ...policy('Administrators'), permissions: [] } })).rejects.toMatchObject({
      status: 403
    })
    await expect(store.changeMembers(admin, 1, { ...(await review(1)), action: 'remove', userIds: [1] })).rejects.toMatchObject({ status: 403 })
    await expect(store.changeMembers(admin, 3, { ...(await review()), action: 'add', userIds: [2] })).rejects.toMatchObject({ status: 403 })
    await expect(store.remove(admin, 2, await review(2))).rejects.toMatchObject({ status: 403 })
  })
  it('stages membership with current target-account authority and records both histories', async () => {
    await expect(store.changeMembers(steward, 3, { ...(await review(3, steward)), action: 'add', userIds: [5] })).rejects.toMatchObject({ status: 403 })
    const previous = await review()
    await store.changeMembers(steward, 3, { ...(await review(3, steward)), action: 'add', userIds: [6] })
    expect(await db('userGroups').where({ userId: 6, groupId: 3 })).toEqual([{ userId: 6, groupId: 3 }])
    expect((await db('users').where('id', 6).first()).authVersion).toBe(1)
    expect(await db('userAdministrationEvents')).toHaveLength(1)
    await store.changeMembers(admin, 3, { ...(await review()), action: 'remove', userIds: [6] })
    expect(await db('userGroups').where({ userId: 6, groupId: 3 })).toEqual([])
    expect((await store.inspect(admin, 3)).history).toMatchObject([
      { action: 'members-removed', actorId: 1, details: { userIds: [6], sessionsEnded: 1 } },
      { action: 'members-added', actorId: 4, details: { userIds: [6], sessionsEnded: 1 } }
    ])
    expect(await db('userAdministrationEvents').where('userId', 6).orderBy('id')).toMatchObject([
      { userId: 6, actorId: 4, action: 'membership-updated', details: { groupId: 3, action: 'add', sessionsEnded: true } },
      { userId: 6, actorId: 1, action: 'membership-updated', details: { groupId: 3, action: 'remove', sessionsEnded: true } }
    ])
    await expect(store.remove(admin, 3, previous)).rejects.toMatchObject({ status: 409 })
    expect((await db('users').where('id', 6).first()).authVersion).toBe(2)
    await db('groups').insert({
      id: 6,
      name: 'Script authors',
      permissions: JSON.stringify(['read:pages', 'write:scripts']),
      pageRules: JSON.stringify(policy().pageRules),
      redirectOnLogin: '/',
      isSystem: false,
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z'
    })
    const accountBeforeDenial = await db('users').where('id', 6).first()
    const groupBeforeDenial = await db('groups').where('id', 6).first()
    const eventsBeforeDenial = await db('userAdministrationEvents').where('userId', 6).orderBy('id')
    for (const actor of [steward, manager]) {
      await expect(store.changeMembers(actor, 6, { ...(await review(6, actor)), action: 'add', userIds: [6] })).rejects.toMatchObject({ status: 403 })
      expect(await db('userGroups').where('userId', 6)).toEqual([])
      expect(await db('users').where('id', 6).first()).toEqual(accountBeforeDenial)
      expect(await db('groups').where('id', 6).first()).toEqual(groupBeforeDenial)
      expect(await db('userAdministrationEvents').where('userId', 6).orderBy('id')).toEqual(eventsBeforeDenial)
      expect(await db('groupAdministrationEvents').where('groupId', 6)).toEqual([])
    }
    await store.changeMembers(manager, 3, { ...(await review(3, manager)), action: 'add', userIds: [6] })
    expect(await db('userGroups').where('userId', 6)).toEqual([{ userId: 6, groupId: 3 }])
    await store.changeMembers(admin, 6, { ...(await review(6)), action: 'add', userIds: [6] })
    expect(await db('userGroups').where('userId', 6).orderBy('groupId')).toEqual([{ userId: 6, groupId: 3 }, { userId: 6, groupId: 6 }])
    expect((await db('users').where('id', 6).first()).authVersion).toBe(4)
    expect(await db('groupAdministrationEvents').where('groupId', 6).first()).toMatchObject({
      actorId: 1,
      action: 'members-added',
      details: { userIds: [6], sessionsEnded: 1 }
    })
    expect(await db('userAdministrationEvents').where('userId', 6).orderBy('id', 'desc').first()).toMatchObject({
      actorId: 1,
      action: 'membership-updated',
      details: { groupId: 6, action: 'add', sessionsEnded: true }
    })
  })
  it('rolls back policy and revocation when event persistence fails', async () => {
    await db.raw('ALTER TABLE "groupAdministrationEvents" ADD CONSTRAINT reject_event CHECK (action <> \'policy-updated\')')
    try {
      await expect(store.savePolicy(admin, 3, { ...(await review()), policy: { ...policy(), permissions: [] } })).rejects.toThrow()
    } finally {
      await db.raw('ALTER TABLE "groupAdministrationEvents" DROP CONSTRAINT reject_event')
    }
    expect((await store.inspect(admin, 3)).permissions).toEqual(['read:pages'])
    expect((await db('users').where('id', 3).first()).authVersion).toBe(0)
  })
  it('explains saved and draft combined access without modifying the saved policy', async () => {
    const input = { path: 'home', locale: 'en', permission: 'read:pages', tags: [], memberId: 3 }
    expect((await store.evaluate(admin, 3, input)).allowed).toBe(true)
    const preview = await store.evaluate(admin, 3, { ...input, draft: { ...policy(), pageRules: [{ ...policy().pageRules[0], deny: true }] } })
    expect(preview).toMatchObject({ allowed: false, source: 'draft', scope: 'member' })
    expect((await store.evaluate(admin, 3, input)).allowed).toBe(true)
    await expect(store.evaluate(admin, 3, { ...input, memberId: 6 })).rejects.toMatchObject({ status: 400 })
  })
  it('reports dependencies and requires them to be resolved before deletion', async () => {
    await db('authentication').insert({ key: 'provider', autoEnrollGroups: JSON.stringify({ v: [3] }) })
    await db('navigation').insert({ key: 'site', config: JSON.stringify([{ locale: 'en', items: [{ visibilityGroups: [3] }] }]) })
    await db('agentProviderGrants').insert({ groupId: 3 })
    expect((await store.inspect(admin, 3)).dependencies).toEqual({ authentication: 1, navigation: 1, agentProviders: 1, agentSkills: 0 })
    await expect(store.remove(admin, 3, await review())).rejects.toMatchObject({ status: 409 })
    for (const table of ['authentication', 'navigation', 'agentProviderGrants']) await db(table).delete()
    const removed = await store.remove(admin, 3, await review())
    expect(removed.sessionsEnded).toBe(1)
    await expect(store.inspect(admin, 3)).rejects.toMatchObject({ status: 404 })
    expect((await db('users').where('id', 3).first()).authVersion).toBe(1)
    expect(await db('groupAdministrationEvents').where('groupId', 3)).toHaveLength(1)
  })
  it('filters the group directory and candidate-account search', async () => {
    expect((await store.list(admin, { search: 'Readers' })).items.map(g => g.id)).toEqual([3])
    expect((await store.members(admin, 3, { candidates: 'true', search: 'Person 6' })).items.map(u => u.id)).toEqual([6])
  })
  it('counts active credential dependencies without exposing token material', async () => {
    const key = 'e30.' + Buffer.from(JSON.stringify({ grp: 3 })).toString('base64url') + '.fixture'
    await db('apiKeys').insert({ key, isRevoked: false, expiration: '2066-01-01T00:00:00Z' })
    const read = await store.inspect(admin, 3)
    expect(read.apiKeyCount).toBe(1)
    expect(JSON.stringify(read)).not.toContain(key)
    await expect(store.remove(admin, 3, await review())).rejects.toMatchObject({ status: 409 })
    await db('apiKeys').update({ isRevoked: true })
    expect((await store.inspect(admin, 3)).apiKeyCount).toBe(0)
  })
  it('keeps Guest visible and marks members outside the actor’s scope as unchangeable', async () => {
    expect((await store.members(admin, 2, {})).items).toMatchObject([{ id: 2, canRemove: false }])
    await db('userGroups').insert({ userId: 5, groupId: 3 })
    expect((await store.members(steward, 3, {})).items.find(user => user.id === 5)?.canRemove).toBe(false)
    expect((await store.members(admin, 3, { candidates: 'true' })).items.some(user => user.id === 2)).toBe(false)
  })
  it('rejects old member reviews after an account-side remove-and-add cycle', async () => {
    const original = await review()
    await db.transaction(async tx => {
      await tx('userGroups').where({ userId: 3, groupId: 3 }).delete()
      await tx('users')
        .where('id', 3)
        .update({ authVersion: tx.raw('?? + 1', ['authVersion']) })
      await tx('userGroups').insert({ userId: 3, groupId: 3 })
      await tx('users')
        .where('id', 3)
        .update({ authVersion: tx.raw('?? + 1', ['authVersion']) })
    })
    await expect(store.savePolicy(admin, 3, { ...original, policy: { ...policy(), description: 'Stale membership review' } })).rejects.toMatchObject({
      status: 409
    })
  })
  it('bounds combined-member explanations while evaluating every rule', async () => {
    const rules = Array.from({ length: 100 }, (_, index) => ({ ...policy().pageRules[0], id: 'rule-' + index }))
    await db('groups')
      .whereIn('id', [3, 4, 5])
      .update({ pageRules: JSON.stringify(rules) })
    await db('groups')
      .where('id', 5)
      .update({
        pageRules: JSON.stringify(
          rules.map((rule, index) => index === 99 ? { ...rule, id: 'late-home-deny', match: 'EXACT', path: 'home', deny: true } : rule)
        )
      })
    await db('userGroups').insert([
      { userId: 3, groupId: 4 },
      { userId: 3, groupId: 5 }
    ])
    const result = await store.evaluate(admin, 3, { path: 'home', locale: 'en', permission: 'read:pages', tags: [], memberId: 3 })
    expect(result).toMatchObject({ allowed: false, ruleCount: 300, rulesTruncated: true })
    expect(result.rules.filter(rule => rule.outcome === 'winner').map(({ groupId, ruleId }) => ({ groupId, ruleId }))).toEqual([
      { groupId: 5, ruleId: 'late-home-deny' }
    ])
    expect(result.rules).toHaveLength(200)
    const directory = await store.list(admin, {})
    expect(directory.items.find(group => group.id === 3)?.ruleCount).toBe(100)
    expect(directory.items[0]).not.toHaveProperty('pageRules')
  })
  it('reports committed success and continues revocations when a cache refresh or peer notification fails', async () => {
    const previousWiki = globalThis.WIKI
    const reloadGroups = vi.fn().mockRejectedValue(new Error('Cache unavailable')),
      revokeUserTokens = vi.fn(),
      emit = vi.fn().mockImplementationOnce(() => {
        throw new Error('Peer unavailable')
      }),
      warn = vi.fn()
    try {
      globalThis.WIKI = { models: { knex: db }, auth: { reloadGroups, revokeUserTokens }, events: { outbound: { emit } }, logger: { warn } } as never
      const runtime = getGroupAdministrationStore()
      const result = await runtime.savePolicy(admin, 3, { ...(await review()), policy: { ...policy(), permissions: ['read:pages', 'write:pages'] } })
      expect(result.sessionsEnded).toBe(1)
      expect(revokeUserTokens).toHaveBeenCalledWith({ id: 3, kind: 'u' })
      expect(emit).toHaveBeenCalledWith('addAuthRevoke', { id: 3, kind: 'u' })
      expect(reloadGroups).toHaveBeenCalled()
      expect((await db('users').where('id', 3).first()).authVersion).toBe(1)
      expect(await db('groupAdministrationEvents').where('groupId', 3)).toHaveLength(1)
      expect((await store.inspect(admin, 3)).history).toMatchObject([
        { action: 'policy-updated', actorId: 1, details: { fields: ['permissions'], permissionsAdded: ['write:pages'], permissionsRemoved: [], sessionsEnded: 1 } }
      ])
    } finally {
      globalThis.WIKI = previousWiki
    }
  })
  it('guards migration rollback once administrative history exists', async () => {
    await down(db)
    await up(db)
    await store.savePolicy(admin, 3, { ...(await review()), policy: { ...policy(), description: 'Purpose' } })
    const saved = await store.inspect(admin, 3)
    await expect(down(db)).rejects.toThrow()
    const retained = await store.inspect(admin, 3)
    expect(retained.description).toBe('Purpose')
    expect(retained.fingerprint).toBe(saved.fingerprint)
    expect(retained.history).toMatchObject([
      { action: 'policy-updated', actorId: 1, details: { fields: ['description'], sessionsEnded: 0 } }
    ])
  })
})
describe('Group policy input boundaries', () => {
  it('checks only regex rules for exponential expressions and validates redirects/actions', () => {
    const normalized = normalizeGroupPolicy({ ...policy(), pageRules: [{ ...policy().pageRules[0], path: '(a+)+$', match: 'START' }] })
    expect(normalized.pageRules).toEqual([
      { id: 'all', path: '(a+)+$', match: 'START', deny: false, roles: ['read:pages'], locales: [] }
    ])
    expect(() => normalizeGroupPolicy({ ...policy(), pageRules: [{ ...policy().pageRules[0], path: '(a+)+$', match: 'REGEX' }] })).toThrow()
    expect(() => normalizeGroupPolicy({ ...policy(), redirectOnLogin: 'javascript:alert(1)' })).toThrow()
    expect(() => normalizeGroupPolicy({ ...policy(), permissions: ['invented:permission'] })).toThrow()
    expect(() => normalizeGroupPolicy({ ...policy(), permissions: ['use:agent-browser'] })).toThrow()
  })
})
