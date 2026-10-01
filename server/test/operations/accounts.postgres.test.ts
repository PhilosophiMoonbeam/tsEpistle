import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import knexModule, { type Knex } from 'knex'
import bcrypt from 'bcryptjs-then'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { createAccountAdministrationStore } from '../../operations/account-administration.ts'
import { up, down } from '../../db/migrations/tsepistle-000017-account-administration.ts'
import { up as groupUp } from '../../db/migrations/tsepistle-000018-group-administration.ts'
import { up as presentationUp } from '../../db/migrations/tsepistle-000036-user-presentation-defaults.ts'
const connection = getPostgresTestConnection('_account_test', import.meta.path)
const suite = connection ? describe : describe.skip
const admin = { id: 1, authVersion: 0 } as never,
  operator = { id: 4, authVersion: 0 } as never
suite('PostgreSQL account administration', () => {
  let previousWiki: unknown,
    db: Knex,
    store: ReturnType<typeof createAccountAdministrationStore>,
    enforce = false
  const account = (id: number, values: Record<string, unknown> = {}) => ({
    id,
    name: `Account ${id}`,
    email: `account${id}@example.invalid`,
    providerKey: 'local',
    isActive: true,
    isSystem: id <= 2,
    isVerified: true,
    tfaIsActive: false,
    tfaSecret: null,
    mustChangePwd: false,
    location: 'Old location',
    jobTitle: 'Editor',
    timezone: 'UTC',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    ...values
  })
  beforeAll(async () => {
    previousWiki = globalThis.WIKI
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    await db.schema.createTable('settings', t => {
      t.string('key').primary()
      t.jsonb('value')
    })
    await db.schema.createTable('users', t => {
      t.increments('id')
      for (const name of ['name', 'email', 'providerKey', 'password', 'tfaSecret', 'location', 'jobTitle', 'timezone', 'createdAt', 'updatedAt', 'lastLoginAt'])
        t.string(name)
      t.string('dateFormat').notNullable().defaultTo('')
      for (const name of ['isActive', 'isSystem', 'isVerified', 'tfaIsActive', 'mustChangePwd']) t.boolean(name).notNullable().defaultTo(false)
      t.unique(['providerKey', 'email'])
    })
    await db.schema.createTable('userKeys', t => {
      t.increments('id')
      t.string('validUntil')
      t.string('createdAt')
      t.integer('userId').references('id').inTable('users')
      t.string('kind')
      t.string('token')
    })
    await db.schema.createTable('groups', t => {
      t.integer('id').primary()
      t.string('name')
      t.jsonb('permissions')
      t.jsonb('pageRules').defaultTo('[]')
      t.string('createdAt').defaultTo('2026-09-01T00:00:00Z')
      t.string('updatedAt').defaultTo('2026-09-01T00:00:00Z')
      t.string('redirectOnLogin').defaultTo('/')
      t.boolean('isSystem')
    })
    await db.schema.createTable('userGroups', t => {
      t.integer('userId').references('id').inTable('users').onDelete('CASCADE')
      t.integer('groupId').references('id').inTable('groups').onDelete('CASCADE')
      t.unique(['userId', 'groupId'])
    })
    await db.schema.createTable('authentication', t => {
      t.string('key').primary()
      t.string('displayName')
      t.string('strategyKey')
      t.boolean('isEnabled')
      t.integer('order')
      t.jsonb('config')
      t.jsonb('autoEnrollGroups').defaultTo('[]')
    })
    for (const table of ['pages', 'pageHistory'])
      await db.schema.createTable(table, t => {
        t.integer('id')
        t.integer('ownerId')
        t.integer('authorId')
        t.integer('creatorId')
        t.string('visibility')
      })
    for (const table of ['comments', 'assets'])
      await db.schema.createTable(table, t => {
        t.integer('id')
        t.integer('authorId')
      })
    await up(db)
    await down(db)
    await up(db)
    await groupUp(db)
    await presentationUp(db)
    await db.schema.createTable('apiKeys', t => {
      t.increments('id')
      t.text('key')
      t.boolean('isRevoked')
      t.string('expiration')
    })
    await db.schema.createTable('navigation', t => {
      t.string('key').primary()
      t.json('config')
    })
    for (const name of ['agentProviderGrants', 'agentSkillGrants'])
      await db.schema.createTable(name, t => {
        t.integer('groupId')
      })
    store = createAccountAdministrationStore({
      db,
      definitions: () => [
        { key: 'local', useForm: true },
        { key: 'oidc', useForm: false }
      ],
      enforceTwoFactor: () => enforce
    })
  })
  beforeEach(async () => {
    for (const table of [
      'settings',
      'groupAdministrationEvents',
      'apiKeys',
      'navigation',
      'agentProviderGrants',
      'agentSkillGrants',
      'userAdministrationEvents',
      'userKeys',
      'userGroups',
      'users',
      'groups',
      'authentication',
      'pages',
      'pageHistory',
      'comments',
      'assets'
    ])
      await db(table).delete()
    await db('groups').insert([
      { id: 1, name: 'Administrators', permissions: JSON.stringify(['manage:system']), isSystem: true },
      { id: 2, name: 'Guests', permissions: JSON.stringify(['read:pages']), isSystem: true },
      { id: 3, name: 'Authors', permissions: JSON.stringify(['read:pages', 'write:pages']), isSystem: false },
      { id: 4, name: 'Account operators', permissions: JSON.stringify(['manage:users']), isSystem: false },
      { id: 5, name: 'Group managers', permissions: JSON.stringify(['manage:users', 'manage:groups']), isSystem: false }
    ])
    await db('users').insert([account(1), account(2), account(3), account(4), account(5, { providerKey: 'oidc' }), account(6)])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 2, groupId: 2 },
      { userId: 3, groupId: 3 },
      { userId: 4, groupId: 4 },
      { userId: 5, groupId: 3 },
      { userId: 6, groupId: 5 }
    ])
    await db('authentication').insert([
      {
        key: 'local',
        strategyKey: 'local',
        displayName: 'Email & password',
        isEnabled: true,
        order: 0,
        config: JSON.stringify({ password: 'PROVIDER-SECRET' })
      },
      { key: 'oidc', strategyKey: 'oidc', displayName: 'Work identity', isEnabled: true, order: 1, config: JSON.stringify({ secret: 'OIDC-SECRET' }) }
    ])
    await db.raw("SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT MAX(id) FROM users))")
    enforce = false
  })
  afterAll(async () => {
    if (db) {
      for (const table of [
        'settings',
        'groupAdministrationEvents',
        'apiKeys',
        'navigation',
        'agentProviderGrants',
        'agentSkillGrants',
        'userAdministrationEvents',
        'userKeys',
        'userGroups',
        'users',
        'groups',
        'authentication',
        'pages',
        'pageHistory',
        'comments',
        'assets'
      ])
        await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
    globalThis.WIKI = previousWiki as never
  })
  const review = async (id = 3, requester = admin) => ({
    fingerprint: (await store.inspect(requester, id)).fingerprint,
    reason: 'Account lifecycle verification'
  })
  it('checks the current persisted password minimum before account creation or replacement', async () => {
    await db('settings').insert({ key: 'auth', value: JSON.stringify({ passwordMinLength: 20 }) })
    const current = await store.inspect(admin, 3)
    await expect(
      store.setPassword(admin, 3, {
        fingerprint: current.fingerprint,
        reason: 'Verify configured password policy',
        password: 'twelve-chars!',
        mustChangePassword: true
      })
    ).rejects.toMatchObject({ status: 400 })
    expect((await db('users').where('id', 3).first()).authVersion).toBe(0)
    await store.setPassword(admin, 3, {
      fingerprint: current.fingerprint,
      reason: 'Use the configured password minimum',
      password: 'twenty-character-password',
      mustChangePassword: true
    })
    expect(await bcrypt.compare('twenty-character-password', (await db('users').where('id', 3).first()).password)).toBe(true)
    const options = await store.creationOptions(admin)
    await expect(
      store.create(admin, {
        fingerprint: options.fingerprint,
        providerKey: 'local',
        profile: { name: 'Policy fixture', email: 'policy@example.invalid', location: '', jobTitle: '', timezone: 'UTC', groups: [] },
        isVerified: false,
        mustChangePassword: true,
        password: 'twelve-chars!',
        reason: 'Verify new account password policy'
      })
    ).rejects.toMatchObject({ status: 400 })
    expect(await db('users').where('email', 'policy@example.invalid')).toHaveLength(0)
  })
  it('returns a bounded directory with literal search, filters and no credentials', async () => {
    await db('users').where('id', 3).update({ name: 'An_Example%', password: 'SECRET-HASH', tfaSecret: 'AUTHENTICATOR-SECRET' })
    const list = await store.list(admin, { search: 'an_example%', state: 'active', provider: 'local', group: 3, limit: 1 })
    expect(list.total).toBe(1)
    expect(list.items.map(row => row.id)).toEqual([3])
    expect(list.counts.accounts).toBe(6)
    expect(JSON.stringify(list)).not.toContain('SECRET')
    expect(JSON.stringify(await store.inspect(admin, 3))).not.toContain('SECRET')
    await expect(store.list(admin, { limit: 100000 })).rejects.toMatchObject({ status: 400 })
    await db('users').insert([
      account(7, { name: 'AnXExample%' }),
      account(8, { name: 'An_Example suffix' }),
      account(9, { name: 'An_Example%', isActive: false }),
      account(10, { name: 'An_Example%', providerKey: 'oidc' }),
      account(11, { name: 'An_Example%' })
    ])
    await db('userGroups').insert([
      { userId: 7, groupId: 3 },
      { userId: 8, groupId: 3 },
      { userId: 9, groupId: 3 },
      { userId: 10, groupId: 3 },
      { userId: 11, groupId: 4 }
    ])
    const filtered = await store.list(admin, { search: 'an_example%', state: 'active', provider: 'local', group: 3, limit: 100 })
    expect(filtered.total).toBe(1)
    expect(filtered.items.map(row => row.id)).toEqual([3])
  })
  it('checks persisted requester authority and generation instead of request permissions', async () => {
    await expect(store.list({ id: 3, permissions: ['manage:system'] } as never, {})).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ authVersion: 1 })
    await expect(store.inspect(admin, 3)).rejects.toMatchObject({ status: 403 })
    await expect(store.inspect({ id: 1, authVersion: 1 } as never, 3)).resolves.toMatchObject({ id: 3 })
  })
  it('guards the current privileged target even when the requested change contains no groups', async () => {
    await db('users').where('id', 1).update({ tfaIsActive: true, tfaSecret: 'PRIVILEGED-ENROLLED-SECRET' })
    expect((await store.inspect(admin, 1)).capabilities.actions).toContain('reset-2fa')
    const protectedUser = await store.inspect(operator, 1)
    expect(protectedUser.capabilities.edit).toBe(false)
    await expect(store.act(operator, 1, { ...(await review(1, operator)), action: 'reset-2fa' })).rejects.toMatchObject({ status: 403 })
    await expect(
      store.updateProfile(operator, 1, { ...(await review(1, operator)), profile: { ...protectedUser.profile, name: 'Impersonated' } })
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      store.setPassword(operator, 1, { ...(await review(1, operator)), password: 'strong-fixture-password', mustChangePassword: true })
    ).rejects.toMatchObject({ status: 403 })
    expect(await db('users').where('id', 1).first()).toMatchObject({
      tfaIsActive: true,
      tfaSecret: 'PRIVILEGED-ENROLLED-SECRET',
      authVersion: 0
    })
    expect(await db('userAdministrationEvents')).toHaveLength(0)
  })
  it('clears profile fields without ending sessions for a cosmetic edit and records only changed field names', async () => {
    const initial = await store.inspect(operator, 3)
    const next = await store.updateProfile(operator, 3, {
      ...(await review(3, operator)),
      profile: { ...initial.profile, name: 'New name', location: '', jobTitle: '' }
    })
    expect(next.profile).toMatchObject({ name: 'New name', location: '', jobTitle: '' })
    expect(next.fingerprint).not.toBe(initial.fingerprint)
    expect((await db('users').where('id', 3).first()).authVersion).toBe(0)
    expect(next.history[0]).toMatchObject({
      actorId: 4,
      action: 'profile-updated',
      details: { fields: ['name', 'location', 'jobTitle'], sessionsEnded: false }
    })
    expect(JSON.stringify(next.history)).not.toContain('New name')
  })
  it('ends existing sessions on membership changes, preserves private ownership and rejects escalation', async () => {
    await db('pages').insert({ id: 1, ownerId: 3, creatorId: 3, authorId: 3, visibility: 'private' })
    await db('groups').insert({ id: 6, name: 'Script authors', permissions: JSON.stringify(['read:pages', 'write:scripts']), isSystem: false })
    const initial = await store.inspect(operator, 3)
    expect(initial.privateOwnershipBlocksDeletion).toBe(true)
    expect(initial.capabilities.delete).toBe(false)
    await expect(store.updateProfile(operator, 3, { ...(await review(3, operator)), profile: { ...initial.profile, groups: [1] } })).rejects.toMatchObject({
      status: 403
    })
    const beforeScriptDenial = await db('users').where('id', 3).first()
    await expect(
      store.updateProfile(operator, 3, {
        ...(await review(3, operator)),
        profile: { ...initial.profile, name: 'Unauthorized script author', groups: [3, 6] }
      })
    ).rejects.toMatchObject({ status: 403 })
    expect(await db('users').where('id', 3).first()).toEqual(beforeScriptDenial)
    expect(await db('userGroups').where('userId', 3)).toEqual([{ userId: 3, groupId: 3 }])
    expect(await db('userAdministrationEvents').where('userId', 3)).toEqual([])
    const changed = await store.updateProfile(admin, 3, { ...(await review()), profile: { ...initial.profile, groups: [] } })
    expect(changed.groups).toEqual([])
    expect(changed.sessionsRevokedAt).toBeTruthy()
    expect((await db('users').where('id', 3).first()).authVersion).toBe(1)
    expect(await db('pages').first()).toMatchObject({ ownerId: 3, creatorId: 3, authorId: 3, visibility: 'private' })
    await store.updateProfile(admin, 3, { ...(await review()), profile: { ...changed.profile, groups: [6] } })
    expect(await db('userGroups').where('userId', 3)).toEqual([{ userId: 3, groupId: 6 }])
    expect((await db('users').where('id', 3).first()).authVersion).toBe(2)
    expect((await db('userAdministrationEvents').where('userId', 3).orderBy('id', 'desc').first()).details).toMatchObject({
      groups: [6],
      previousGroups: [],
      sessionsEnded: true
    })
  })
  it('protects the Guest identity without inventing a ban on ordinary membership in its group', async () => {
    const initial = await store.inspect(operator, 3)
    expect(initial.availableGroups.find(group => group.id === 2)?.canAssign).toBe(true)
    const next = await store.updateProfile(operator, 3, { ...(await review(3, operator)), profile: { ...initial.profile, groups: [2, 3] } })
    expect(next.profile.groups).toEqual([2, 3])
    expect(await db('userGroups').where('userId', 3).orderBy('groupId')).toEqual([{ userId: 3, groupId: 2 }, { userId: 3, groupId: 3 }])
    expect((await db('users').where('id', 3).first()).authVersion).toBe(1)
    expect((await store.inspect(admin, 2)).capabilities.edit).toBe(false)
  })
  it('invalidates email verification and sessions and refuses an existing normalized identity', async () => {
    const initial = await store.inspect(admin, 3)
    await expect(
      store.updateProfile(admin, 3, { ...(await review()), profile: { ...initial.profile, email: 'ACCOUNT4@EXAMPLE.INVALID' } })
    ).rejects.toMatchObject({ status: 409 })
    const changed = await store.updateProfile(admin, 3, { ...(await review()), profile: { ...initial.profile, email: 'Changed@Example.Invalid' } })
    expect(changed.email).toBe('changed@example.invalid')
    expect(changed.isVerified).toBe(false)
    expect((await db('users').where('id', 3).first()).authVersion).toBe(1)
  })
  it('accepts only one concurrent review and rejects ABA and changed access policy', async () => {
    const initial = await review(),
      requests = await Promise.allSettled([
        store.act(admin, 3, { ...initial, action: 'deactivate' }),
        store.act(admin, 3, { ...initial, action: 'deactivate' })
      ])
    expect(requests.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(requests.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    await store.act(admin, 3, { ...(await review()), action: 'activate' })
    await expect(store.act(admin, 3, { ...initial, action: 'deactivate' })).rejects.toMatchObject({ status: 409 })
    const current = await review()
    await db('groups')
      .where('id', 3)
      .update({ permissions: JSON.stringify(['read:pages']) })
    await expect(store.act(admin, 3, { ...current, action: 'deactivate' })).rejects.toMatchObject({ status: 409 })
  })
  it('protects self and system accounts while allowing explicit self session termination', async () => {
    expect((await store.inspect(admin, 1)).capabilities.actions).not.toContain('deactivate')
    expect((await store.inspect(admin, 2)).capabilities.edit).toBe(false)
    const initial = await store.inspect(admin, 1)
    await expect(store.updateProfile(admin, 1, { ...(await review(1)), profile: { ...initial.profile, groups: [] } })).rejects.toMatchObject({ status: 403 })
    await store.act(admin, 1, { ...(await review(1)), action: 'end-sessions' })
    await expect(store.inspect(admin, 1)).rejects.toMatchObject({ status: 403 })
    expect((await db('users').where('id', 1).first()).authVersion).toBe(1)
  })
  it('uses actual provider capabilities and never mistakes an unverified setup secret for enrollment', async () => {
    const external = await store.inspect(admin, 5)
    expect(external.twoFactor).toBe('provider-managed')
    expect(external.capabilities.password).toBe(false)
    expect(external.capabilities.actions).not.toContain('require-2fa')
    await db('users').where('id', 3).update({ tfaSecret: 'NOT-YET-VERIFIED' })
    const required = await store.act(admin, 3, { ...(await review()), action: 'require-2fa' })
    expect(required.twoFactor).toBe('enrollment-required')
    expect((await db('users').where('id', 3).first()).tfaSecret).toBeNull()
    enforce = true
    expect((await store.inspect(admin, 3)).capabilities.actions).not.toContain('disable-2fa')
  })
  it('resets an enrolled authenticator into required enrollment and ends sessions', async () => {
    await db('users').where('id', 3).update({ tfaIsActive: true, tfaSecret: 'ENROLLED-SECRET' })
    const next = await store.act(admin, 3, { ...(await review()), action: 'reset-2fa' })
    expect(next.twoFactor).toBe('enrollment-required')
    expect((await db('users').where('id', 3).first()).authVersion).toBe(1)
    expect(next.history[0]?.action).toBe('reset-2fa')
  })
  it('replaces a local password with a real hash and records no credential', async () => {
    const password = 'fixture-password-12!'
    const next = await store.setPassword(admin, 3, { ...(await review()), password, mustChangePassword: true })
    const persisted = await db('users').where('id', 3).first()
    expect(await bcrypt.compare(password, persisted.password)).toBe(true)
    expect(persisted.authVersion).toBe(1)
    expect(next.mustChangePassword).toBe(true)
    expect(JSON.stringify(next)).not.toContain(password)
    expect(JSON.stringify(next)).not.toContain(persisted.password)
    await expect(store.setPassword(admin, 3, { ...(await review()), password: '🙂'.repeat(20), mustChangePassword: true })).rejects.toMatchObject({
      status: 400
    })
  })
  it('rolls back account state, session revocation and history together on persistence failure', async () => {
    await db.raw(`ALTER TABLE "userAdministrationEvents" ADD CONSTRAINT account_test_failure CHECK (action <> 'deactivate')`)
    try {
      await expect(store.act(admin, 3, { ...(await review()), action: 'deactivate' })).rejects.toThrow()
    } finally {
      await db.raw('ALTER TABLE "userAdministrationEvents" DROP CONSTRAINT account_test_failure')
    }
    expect(await db('users').where('id', 3).first()).toMatchObject({ isActive: true, authVersion: 0, adminRevision: '' })
    expect(await db('userAdministrationEvents')).toHaveLength(0)
  })
  it('does not treat a workspace API principal as the primary human administrator', async () => {
    const api = { id: 1, ownershipUserId: null, groups: [1] } as never
    await store.act(api, 3, { ...(await review(3, api)), action: 'deactivate' })
    expect((await db('userAdministrationEvents').first()).actorId).toBeNull()
    expect((await db('users').where('id', 1).first()).authVersion).toBe(0)
  })
  it('creates an account with reviewed membership and a password hash, with no implicit mail', async () => {
    await db('groups').insert({ id: 6, name: 'Script authors', permissions: JSON.stringify(['read:pages', 'write:scripts']), isSystem: false })
    const options = await store.creationOptions(operator)
    const profile = { name: 'A new author', email: 'new@example.invalid', location: '', jobTitle: '', timezone: 'UTC', groups: [3] }
    const created = await store.create(operator, {
      fingerprint: options.fingerprint,
      profile,
      providerKey: 'local',
      isVerified: true,
      mustChangePassword: true,
      password: 'creation-password-12!',
      reason: 'Create a test author'
    })
    const row = await db('users').where('id', created.id).first()
    expect(row).toMatchObject({ name: profile.name, email: profile.email, isActive: true, isVerified: true, mustChangePwd: true, authVersion: 0 })
    expect(await bcrypt.compare('creation-password-12!', row.password)).toBe(true)
    expect(await db('userGroups').where('userId', created.id)).toEqual([{ userId: created.id, groupId: 3 }])
    expect((await db('userAdministrationEvents').where('userId', created.id).first()).action).toBe('account-created')
    await expect(
      store.create(operator, {
        fingerprint: options.fingerprint,
        profile: { ...profile, groups: [1], email: 'escalation@example.invalid' },
        providerKey: 'oidc',
        isVerified: true,
        mustChangePassword: false,
        reason: 'Attempt group escalation'
      })
    ).rejects.toMatchObject({ status: 403 })
    await db('groups').where('id', 4).update({ permissions: JSON.stringify(['write:users']) })
    const creationReview = await store.creationOptions(operator)
    const scriptInput = {
      fingerprint: creationReview.fingerprint,
      profile: { ...profile, groups: [6], email: 'script-boundary@example.invalid' },
      providerKey: 'oidc',
      isVerified: true,
      mustChangePassword: false,
      reason: 'Review delegated script assignment'
    }
    const usersBeforeDenial = await db('users').orderBy('id')
    const membershipsBeforeDenial = await db('userGroups').orderBy('userId').orderBy('groupId')
    const eventsBeforeDenial = await db('userAdministrationEvents').orderBy('id')
    await expect(store.create(operator, scriptInput)).rejects.toMatchObject({ status: 403 })
    expect(await db('users').orderBy('id')).toEqual(usersBeforeDenial)
    expect(await db('userGroups').orderBy('userId').orderBy('groupId')).toEqual(membershipsBeforeDenial)
    expect(await db('userAdministrationEvents').orderBy('id')).toEqual(eventsBeforeDenial)
    const delegated = await store.create(operator, { ...scriptInput, profile: { ...scriptInput.profile, groups: [3] } })
    expect(await db('userGroups').where('userId', delegated.id)).toEqual([{ userId: delegated.id, groupId: 3 }])
    expect((await db('users').where('id', delegated.id).first()).email).toBe(scriptInput.profile.email)
    const systemCreated = await store.create(admin, {
      ...scriptInput,
      fingerprint: (await store.creationOptions(admin)).fingerprint,
      profile: { ...scriptInput.profile, email: 'system-script@example.invalid' }
    })
    expect(await db('userGroups').where('userId', systemCreated.id)).toEqual([{ userId: systemCreated.id, groupId: 6 }])
    expect(await db('userAdministrationEvents').where('userId', systemCreated.id).first()).toMatchObject({
      actorId: 1,
      action: 'account-created',
      details: { groups: [6] }
    })
  })
  it('serializes competing normalized account creates and rejects a stale creation policy', async () => {
    const options = await store.creationOptions(admin),
      input = {
        fingerprint: options.fingerprint,
        profile: { name: 'Work account', email: 'work@example.invalid', location: '', jobTitle: '', timezone: 'UTC', groups: [3] },
        providerKey: 'oidc',
        isVerified: true,
        mustChangePassword: false,
        reason: 'Provision a work account'
      }
    const result = await Promise.allSettled([
      store.create(admin, input),
      store.create({ id: 6, authVersion: 0 } as never, {
        ...input,
        profile: { ...input.profile, email: 'WORK@EXAMPLE.INVALID' },
        fingerprint: (await store.creationOptions({ id: 6, authVersion: 0 } as never)).fingerprint
      })
    ])
    expect(result.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(result.find(row => row.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    expect(await db('users').where('providerKey', 'oidc').whereRaw('LOWER(??) = ?', ['email', input.profile.email]).select('email')).toEqual([
      { email: input.profile.email }
    ])
    await db('groups').where('id', 3).update({ name: 'Renamed authors' })
    await expect(store.create(admin, { ...input, profile: { ...input.profile, email: 'different@example.invalid' } })).rejects.toMatchObject({ status: 409 })
  })
  it('preserves private ownership/history and reassigns public contributions only after reviewed deletion', async () => {
    await db('pageHistory').insert({ id: 1, ownerId: 3, authorId: 3, visibility: 'private' })
    await expect(store.remove(admin, 3, { ...(await review()), replaceId: 5 })).rejects.toMatchObject({ status: 403 })
    await db('pageHistory').delete()
    await db('pages').insert({ id: 2, ownerId: null, creatorId: 3, authorId: 3, visibility: 'public' })
    await db('pages').insert({ id: 3, ownerId: 1, creatorId: 3, authorId: 3, visibility: 'private' })
    await db('comments').insert({ id: 1, authorId: 3 })
    await db('userKeys').insert({ userId: 3, kind: 'resetPwd', token: 'synthetic' })
    await expect(store.remove(admin, 3, { ...(await review()), replaceId: 3 })).rejects.toMatchObject({ status: 400 })
    await store.remove(admin, 3, { ...(await review()), replaceId: 5 })
    expect(await db('users').where('id', 3).first()).toBeUndefined()
    expect(await db('userKeys').where('userId', 3)).toHaveLength(0)
    expect(await db('pages').first()).toMatchObject({ ownerId: null, creatorId: 5, authorId: 5, visibility: 'public' })
    expect((await db('comments').first()).authorId).toBe(5)
    expect(await db('pages').where('id', 3).first()).toMatchObject({ ownerId: 1, authorId: 5, creatorId: 5, visibility: 'private' })
    expect(await db('userAdministrationEvents').where('userId', 3).first()).toMatchObject({ action: 'account-deleted', details: { replacementId: 5 } })
  })
  it('persists welcome-email acceptance or failure without implying delivery or storing its body', async () => {
    const prepared = await store.prepareWelcome(admin, 3, { ...(await review()), reason: 'Welcome our new author' })
    expect(prepared.email).toBe('account3@example.invalid')
    let current = await store.inspect(admin, 3)
    expect(current.history[0]?.action).toBe('welcome-email-requested')
    await store.finishWelcome(3, prepared.requestId, true)
    current = await store.inspect(admin, 3)
    expect(current.history[0]?.action).toBe('welcome-email-accepted')
    expect(JSON.stringify(current.history)).not.toContain(prepared.email)
    const failed = await store.prepareWelcome(admin, 3, { ...(await review()), reason: 'Retry an explicit welcome' })
    await store.finishWelcome(3, failed.requestId, false)
    expect((await store.inspect(admin, 3)).history[0]?.action).toBe('welcome-email-failed')
  })
  it('invalidates pending recovery and continuation keys and fences issuance against old login proof', async () => {
    globalThis.WIKI = {
      Error: { AuthValidationTokenInvalid: class extends Error {} },
      models: {
        knex: db,
        users: { query: (tx = db) => ({ findById: (id: number) => tx('users').where('id', id).first() }) },
        userKeys: {
          query: (tx = db) => ({
            findOne: (input: Record<string, unknown>) => tx('userKeys').where(input).first(),
            insert: (input: Record<string, unknown>) => tx('userKeys').insert(input),
            deleteById: (id: number) => tx('userKeys').where('id', id).delete()
          })
        }
      }
    } as never
    const { default: UserKey } = await vi.importFresh('../../models/userKeys.ts', import.meta.url)
    const token = await UserKey.generateToken({ userId: 3, kind: 'resetPwd', expectedAuthVersion: 0 })
    await expect(UserKey.validateToken({ kind: 'resetPwd', token, skipDelete: true })).resolves.toMatchObject({ id: 3 })
    await store.act(admin, 3, { ...(await review()), action: 'end-sessions' })
    await expect(UserKey.validateToken({ kind: 'resetPwd', token })).rejects.toThrow()
    expect(await db('userKeys').where('token', token)).toHaveLength(1)
    await expect(UserKey.generateToken({ userId: 3, kind: 'tfa', expectedAuthVersion: 0 })).rejects.toThrow()
    const next = await UserKey.generateToken({ userId: 3, kind: 'resetPwd', expectedAuthVersion: 1 })
    const competing = await Promise.allSettled([
      UserKey.validateToken({ kind: 'resetPwd', token: next }),
      UserKey.validateToken({ kind: 'resetPwd', token: next })
    ])
    expect(competing.filter(row => row.status === 'fulfilled')).toHaveLength(1)
  })
  it('advances persisted session authority for legacy group membership and permission changes', async () => {
    const permissionList = (user: unknown) => (user && typeof user === 'object' ? ((Reflect.get(user, 'permissions') as string[]) ?? []) : [])
    globalThis.WIKI = {
      auth: {
        checkExclusiveAccess: (user: unknown, include: string[], exclude: string[]) =>
          include.some(p => permissionList(user).includes(p)) && !exclude.some(p => permissionList(user).includes(p)),
        reloadGroups: async () => {},
        revokeUserTokens: () => {}
      },
      events: { outbound: { emit: () => {} } },
      models: {
        knex: db,
        groups: {
          query: (tx = db) => ({
            patch: (input: Record<string, unknown>) =>
              tx('groups').update({ ...input, permissions: JSON.stringify(input.permissions), pageRules: JSON.stringify(input.pageRules) }),
            deleteById: (id: number) => tx('groups').where('id', id).delete()
          })
        }
      }
    } as never
    const { default: operations } = await vi.importFresh('../../operations/groups.ts', import.meta.url)
    const requester = { id: 1, permissions: ['manage:system'] } as never
    await operations.assignUser({ requester, groupId: 3, userId: 4 })
    expect((await db('users').where('id', 4).first()).authVersion).toBe(1)
    await operations.unassignUser({ requester, groupId: 3, userId: 4 })
    expect((await db('users').where('id', 4).first()).authVersion).toBe(2)
    const stale = await review()
    await operations.update({ requester, id: 3, name: 'Authors', permissions: ['read:pages'], pageRules: [] })
    expect((await db('users').where('id', 3).first()).authVersion).toBe(1)
    await expect(store.act(admin, 3, { ...stale, action: 'deactivate' })).rejects.toMatchObject({ status: 409 })
    await operations.remove({ requester, id: 3 })
    expect((await db('users').where('id', 3).first()).authVersion).toBe(2)
  })
  it('refuses a downgrade after a durable revocation even if action history is absent', async () => {
    await db('users').where('id', 3).update({ authVersion: 1 })
    const before = await db('users').where('id', 3).first()
    await expect(down(db)).rejects.toBeInstanceOf(Error)
    expect(await db.schema.hasColumn('users', 'authVersion')).toBe(true)
    expect(await db('users').where('id', 3).first()).toEqual(before)
  })
})
