import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { DateTime } from 'luxon'
import { decryptWebhookSecret, encryptWebhookSecret } from '../../core/webhooks.ts'

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_utility_auth_test') && password
    ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432), user: 'wiki', database, password }
    : null
const suite = connection ? describe : describe.skip
const originalWiki = globalThis.WIKI
interface UtilityAuth {
  activateStrategies(strict?: boolean): Promise<void>
  guest: { cacheExpiration: DateTime }
  regenerateCertificates(requester?: { user: Express.User }): Promise<{ revokedApiKeys: number }>
  reloadApiKeys(): Promise<void>
  resetGuestUser(): Promise<void>
}

suite('Utilities authentication effects on PostgreSQL', () => {
  let db: Knex
  let auth: UtilityAuth
  let activate: ((strict?: boolean) => Promise<void>) & { mock?: unknown }
  let reloadApiKeys: (() => Promise<void>) & { mock?: unknown }
  const root = 'persisted-encryption-root'

  const runtime = () => ({
    config: {
      api: { isEnabled: true },
      auth: { audience: 'urn:test', tokenExpiration: '30m', tokenRenewal: '15m' },
      certs: { public: 'previous-public-key', private: 'previous-private-key' },
      features: { featurePageComments: false },
      host: 'https://wiki.example.invalid',
      sessionSecret: root
    },
    startedAt: DateTime.utc(),
    configSvc: { saveToDb: vi.fn(async () => false) },
    events: { inbound: { on: vi.fn() }, outbound: { emit: vi.fn() } },
    lang: { t: vi.fn() },
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    models: { knex: db }
  })

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.jsonb('value').notNullable()
      table.timestamp('updatedAt').notNullable()
    })
    await db.schema.createTable('apiKeys', table => {
      table.integer('id').primary()
      table.boolean('isRevoked').notNullable()
      table.timestamp('expiration').notNullable()
      table.timestamp('updatedAt').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.jsonb('permissions').notNullable()
      table.string('adminRevision').notNullable()
    })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.string('providerKey').notNullable()
      table.string('email').notNullable()
      table.string('name').notNullable()
      table.string('password')
      table.boolean('tfaIsActive').notNullable()
      table.string('tfaSecret')
      table.string('localeCode').notNullable()
      table.string('defaultEditor').notNullable()
      table.boolean('isSystem').notNullable()
      table.boolean('isActive').notNullable()
      table.boolean('isVerified').notNullable()
      table.boolean('mustChangePwd').notNullable()
      table.integer('authVersion').notNullable().defaultTo(0)
      table.timestamp('createdAt').notNullable()
      table.timestamp('updatedAt').notNullable()
      table.unique(['providerKey', 'email'])
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').notNullable().references('id').inTable('users')
      table.integer('groupId').notNullable().references('id').inTable('groups')
      table.primary(['userId', 'groupId'])
    })
    auth = (await vi.importFresh('../../core/auth.ts', import.meta.url)).default
  })

  afterAll(async () => {
    if (db) {
      for (const table of ['userGroups', 'users', 'groups', 'apiKeys', 'settings']) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
    globalThis.WIKI = originalWiki
  })

  beforeEach(async () => {
    for (const table of ['userGroups', 'users', 'groups', 'apiKeys', 'settings']) await db(table).delete()
    const now = new Date().toISOString()
    await db('groups').insert([
      { id: 1, permissions: JSON.stringify(['manage:system']), adminRevision: 'one' },
      { id: 2, permissions: JSON.stringify([]), adminRevision: 'one' },
      { id: 3, permissions: JSON.stringify(['manage:system']), adminRevision: 'one' }
    ])
    await db('users').insert([
      {
        id: 1,
        providerKey: 'local',
        email: 'admin@example.test',
        name: 'Admin',
        password: '',
        tfaIsActive: false,
        localeCode: 'en',
        defaultEditor: 'markdown',
        isSystem: true,
        isActive: true,
        isVerified: true,
        mustChangePwd: false,
        authVersion: 0,
        createdAt: now,
        updatedAt: now
      },
      {
        id: 2,
        providerKey: 'local',
        email: 'guest@example.com',
        name: 'Original Guest',
        password: 'old',
        tfaIsActive: false,
        localeCode: 'en',
        defaultEditor: 'markdown',
        isSystem: true,
        isActive: true,
        isVerified: true,
        mustChangePwd: false,
        authVersion: 0,
        createdAt: now,
        updatedAt: now
      }
    ])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 2, groupId: 3 }
    ])
    await db('apiKeys').insert([
      { id: 7, isRevoked: false, expiration: new Date(Date.now() + 3600000).toISOString(), updatedAt: now },
      { id: 8, isRevoked: false, expiration: new Date(Date.now() + 3600000).toISOString(), updatedAt: now }
    ])
    globalThis.WIKI = runtime() as never
    activate = vi.fn(async () => undefined)
    reloadApiKeys = vi.fn(async () => undefined)
    auth.activateStrategies = activate as never
    auth.reloadApiKeys = reloadApiKeys as never
    auth.guest = { permissions: ['manage:system'], cacheExpiration: DateTime.utc().plus({ minutes: 1 }) } as never
  })

  it('atomically publishes only new certificates, revokes actual API keys, and preserves decryptability rooted in the session secret', async () => {
    const ciphertext = encryptWebhookSecret('webhook-fixture-secret', root)

    const outcome = await auth.regenerateCertificates()

    expect(outcome).toEqual({ revokedApiKeys: 2 })
    expect(globalThis.WIKI.config.sessionSecret).toBe(root)
    expect(decryptWebhookSecret(ciphertext, globalThis.WIKI.config.sessionSecret)).toBe('webhook-fixture-secret')
    expect(await db('apiKeys').where('isRevoked', false)).toHaveLength(0)
    expect((await db('settings').where('key', 'certs').first())?.value).toMatchObject({ public: expect.stringContaining('BEGIN RSA PUBLIC KEY') })
    expect(activate).toHaveBeenCalledWith(true)
    expect(reloadApiKeys).toHaveBeenCalledOnce()
  })

  it('reports a strict activation failure after durable rotation rather than claiming an applied runtime', async () => {
    auth.activateStrategies = vi.fn(async () => {
      throw new Error('strict fixture activation failure')
    }) as never

    await expect(auth.regenerateCertificates()).rejects.toThrow('strict fixture activation failure')

    expect((await db('settings').where('key', 'certs').first())?.value).toMatchObject({ public: expect.stringContaining('BEGIN RSA PUBLIC KEY') })
    expect(await db('apiKeys').where('isRevoked', false)).toHaveLength(0)
    expect(reloadApiKeys).not.toHaveBeenCalled()
  })
  it('rolls back the certificate record and leaves the runtime unchanged when API-key revocation faults', async () => {
    await db('settings').insert({
      key: 'certs',
      value: { public: 'previous-public-key', private: 'previous-private-key' },
      updatedAt: new Date().toISOString()
    })
    await db.raw("CREATE FUNCTION utility_auth_revoke_fault() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture revocation fault'; END; $$ LANGUAGE plpgsql")
    await db.raw('CREATE TRIGGER utility_auth_revoke_fault BEFORE UPDATE ON "apiKeys" FOR EACH ROW EXECUTE FUNCTION utility_auth_revoke_fault()')
    const previous = globalThis.WIKI.config.certs

    await expect(auth.regenerateCertificates()).rejects.toThrow('fixture revocation fault')

    expect((await db('settings').where('key', 'certs').first())?.value).toEqual(previous)
    expect(await db('apiKeys').where('isRevoked', false)).toHaveLength(2)
    expect(globalThis.WIKI.config.certs).toBe(previous)
    expect(activate).not.toHaveBeenCalled()
    await db.raw('DROP TRIGGER utility_auth_revoke_fault ON "apiKeys"')
    await db.raw('DROP FUNCTION utility_auth_revoke_fault()')
  })

  it('rolls back guest writes on relation faults and expires the anonymous cache immediately after a committed reset', async () => {
    await db.raw(
      "CREATE FUNCTION utility_auth_guest_fault() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'fixture guest relation fault'; END; $$ LANGUAGE plpgsql"
    )
    await db.raw('CREATE TRIGGER utility_auth_guest_fault BEFORE INSERT ON "userGroups" FOR EACH ROW EXECUTE FUNCTION utility_auth_guest_fault()')

    await expect(auth.resetGuestUser()).rejects.toThrow('fixture guest relation fault')

    expect((await db('users').where('id', 2).first())?.name).toBe('Original Guest')
    expect(await db('userGroups').where('userId', 2)).toEqual([{ userId: 2, groupId: 3 }])
    await db.raw('DROP TRIGGER utility_auth_guest_fault ON "userGroups"')
    await db.raw('DROP FUNCTION utility_auth_guest_fault()')

    await auth.resetGuestUser()

    expect((await db('users').where('id', 2).first())?.name).toBe('Guest')
    expect(await db('userGroups').where('userId', 2)).toEqual([{ userId: 2, groupId: 2 }])
    expect(auth.guest.cacheExpiration <= DateTime.utc()).toBe(true)
  })

  it('rechecks the requester in the durable certificate transaction', async () => {
    await db('users').where('id', 1).update({ authVersion: 1 })

    await expect(auth.regenerateCertificates({ user: { id: 1, authVersion: 0 } as never })).rejects.toMatchObject({ status: 403 })

    expect(await db('settings').where('key', 'certs')).toHaveLength(0)
    expect(activate).not.toHaveBeenCalled()
  })

  it('rechecks the requester before changing the guest relation', async () => {
    await db('users').where('id', 1).update({ authVersion: 1 })

    await expect(auth.resetGuestUser({ user: { id: 1, authVersion: 0 } as never } as never)).rejects.toMatchObject({ status: 403 })

    expect((await db('users').where('id', 2).first())?.name).toBe('Original Guest')
    expect(await db('userGroups').where('userId', 2)).toEqual([{ userId: 2, groupId: 3 }])
  })
})
