import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '../bun-test.mts'
import { createTlsConfigurationStore } from '../../operations/tls-configuration.ts'
import type { TlsConfigurationWorkspace, TlsListenerSnapshot } from '../../../shared/tls-workspace.ts'
import type { SystemRequester } from '../../helpers/system-authority.ts'
const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? '',
  password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_ssl_test') && password ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT), user: 'wiki', database, password } : null
const suite = connection ? describe : describe.skip
const admin: SystemRequester = { user: { id: 1, authVersion: 0 } as never }
const verifiedCheckId = '724044d5-5336-42b1-bd10-0df7dbba01b4'
const body = (workspace: TlsConfigurationWorkspace, enabled = true) => ({
  enabled,
  fingerprint: workspace.fingerprint,
  reason: 'Review HTTPS redirection',
  ...(enabled ? { verifiedCheckId } : {})
})
suite('Reviewed HTTPS policy on PostgreSQL', () => {
  let db: Knex,
    fallback: Record<string, unknown>,
    listeners: TlsListenerSnapshot,
    store: ReturnType<typeof createTlsConfigurationStore>,
    verified: Array<[string, string, string]>
  const read = (requester = admin) => store.inspect(requester)
  const setting = (key: string, value: unknown) =>
    db('settings')
      .insert({ key, value: JSON.stringify(value), updatedAt: new Date().toISOString() })
      .onConflict('key')
      .merge(['value', 'updatedAt'])
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 6 } })
    await db.schema.createTable('settings', t => {
      t.string('key').primary()
      t.jsonb('value').notNullable()
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
    await db.schema.createTable('apiKeys', t => {
      t.integer('id').primary()
      t.boolean('isRevoked')
      t.string('expiration')
    })
  })
  afterAll(async () => {
    if (db) {
      for (const name of ['settings', 'userGroups', 'groups', 'users', 'apiKeys']) await db.schema.dropTableIfExists(name)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    for (const name of ['settings', 'userGroups', 'groups', 'users', 'apiKeys']) await db(name).delete()
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
    await setting('server', { sslRedir: false, opaque: { secret: 'unowned-private-server-value' } })
    await setting('host', { v: 'https://wiki.example.test' })
    await setting('security', { securityTrustProxy: true })
    await setting('offline', { v: false })
    fallback = {
      host: 'https://stale.example.test',
      security: { securityTrustProxy: false },
      server: { sslRedir: false },
      offline: true,
      ssl: { enabled: false, provider: 'custom', format: 'pem', key: '/private/key.pem', cert: '/private/cert.pem', passphrase: 'private-passphrase' }
    }
    listeners = { httpPort: 3000, httpsPort: null, material: null, replacementMode: null }
    verified = []
    store = createTlsConfigurationStore({
      db,
      reviewKey: 'fixture-only-review-key',
      fallback: () => fallback,
      listeners: () => structuredClone(listeners),
      verifyEndpoint: async (_tx, id, url, fingerprint) => {
        if (id !== verifiedCheckId) throw new Error('Fixture check is not verified.')
        verified.push([id, url, fingerprint])
      }
    })
  })
  it('separates saved and process policy while omitting private deployment and unowned settings', async () => {
    const workspace = await read(),
      json = JSON.stringify(workspace)
    expect(workspace).toMatchObject({
      publicUrl: 'https://wiki.example.test',
      offline: false,
      redirection: { enabled: false, eligible: true, trustedProxy: true },
      runtimeRedirection: { enabled: false, eligible: false, publicUrl: 'https://stale.example.test', settingsCurrent: false }
    })
    for (const secret of ['unowned-private-server-value', '/private/key.pem', '/private/cert.pem', 'private-passphrase']) expect(json).not.toContain(secret)
  })
  it('verifies the reviewed endpoint and atomically records policy and attribution', async () => {
    const before = await read(),
      result = await store.save(admin, body(before)),
      after = await read()
    expect(verified).toEqual([[verifiedCheckId, 'https://wiki.example.test', before.fingerprint]])
    expect((await db('settings').where('key', 'server').first()).value).toEqual({ sslRedir: true, opaque: { secret: 'unowned-private-server-value' } })
    expect(after.history).toEqual([
      expect.objectContaining({ id: result.revision, actorId: 1, apiKeyId: null, enabled: true, reason: 'Review HTTPS redirection' })
    ])
    expect(after.runtimeRedirection.enabled).toBe(false)
    expect(fallback.server).toEqual({ sslRedir: false })
  })
  it('requires an endpoint receipt and preserves settings when validation fails', async () => {
    const input = body(await read())
    delete input.verifiedCheckId
    await expect(store.save(admin, input)).rejects.toThrow('public TLS check')
    await expect(store.save(admin, { ...input, verifiedCheckId: '243b33b7-8c58-454e-b793-f6b11258ccfd' })).rejects.toThrow('not verified')
    expect((await read()).redirection.enabled).toBe(false)
    expect((await read()).history).toHaveLength(0)
  })
  it('rejects unsafe origins and unavailable HTTPS/proxy configuration', async () => {
    await setting('host', { v: 'http://wiki.example.test' })
    await expect(store.save(admin, body(await read()))).rejects.toThrow('public HTTPS origin')
    await setting('host', { v: 'https://wiki.example.test' })
    await setting('security', { securityTrustProxy: false })
    await expect(store.save(admin, body(await read()))).rejects.toThrow('trusted proxy')
    listeners.httpsPort = 3443
    listeners.replacementMode = 'listener-restart'
    await expect(store.save(admin, body(await read()))).resolves.toHaveProperty('enabled', true)
  })
  it('always allows reviewed disabling even when the old target and proxy configuration are broken', async () => {
    await setting('server', { sslRedir: true })
    await setting('host', { v: 'invalid-origin' })
    await setting('security', { securityTrustProxy: false })
    await expect(store.save(admin, body(await read(), false))).resolves.toHaveProperty('enabled', false)
    expect(verified).toHaveLength(0)
  })
  it('fences deployment/listener changes and ABA publications', async () => {
    const stale = body(await read())
    listeners.httpsPort = 3443
    await expect(store.save(admin, stale)).rejects.toMatchObject({ status: 409 })
    const original = body(await read())
    await store.save(admin, original)
    await store.save(admin, body(await read(), false))
    await expect(store.save(admin, original)).rejects.toMatchObject({ status: 409 })
  })
  it('rolls back the policy if its history write fails', async () => {
    await db.raw("ALTER TABLE settings ADD CONSTRAINT tls_fixture_history_reject CHECK (key <> 'sslAdministration')")
    try {
      await expect(store.save(admin, body(await read()))).rejects.toThrow()
      expect((await read()).redirection.enabled).toBe(false)
    } finally {
      await db.raw('ALTER TABLE settings DROP CONSTRAINT tls_fixture_history_reject')
    }
  })
  it('rechecks account activation, session generation and current group membership', async () => {
    const input = body(await read())
    await db('users').where('id', 1).update({ isActive: false })
    await expect(store.save(admin, input)).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ isActive: true, authVersion: 1 })
    await expect(read()).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ authVersion: 0 })
    await db('userGroups').where('userId', 1).delete()
    await expect(read()).rejects.toMatchObject({ status: 403 })
    await expect(read({ user: { id: 3, authVersion: 0 } as never })).rejects.toMatchObject({ status: 403 })
  })
  it('attributes API publications to their credential and rechecks revocation and both expirations', async () => {
    const expiration = new Date(Date.now() + 3600000).toISOString()
    await db('apiKeys').insert({ id: 7, isRevoked: false, expiration })
    const requester: SystemRequester = {
      user: { id: 1, ownershipUserId: null, groups: [1] } as never,
      apiKey: { id: 7, groupId: 1, expiresAt: Math.floor(Date.now() / 1000) + 3600 }
    }
    await store.save(requester, body(await read(requester)))
    expect((await read(requester)).history[0]).toMatchObject({ actorId: null, apiKeyId: 7 })
    await db('apiKeys').where('id', 7).update({ isRevoked: true })
    await expect(read(requester)).rejects.toMatchObject({ status: 403 })
    await db('apiKeys').where('id', 7).update({ isRevoked: false, expiration: '2000-01-01T00:00:00.000Z' })
    await expect(read(requester)).rejects.toMatchObject({ status: 403 })
    await db('apiKeys').where('id', 7).update({ expiration })
    requester.apiKey!.expiresAt = 1
    await expect(read(requester)).rejects.toMatchObject({ status: 403 })
  })
  it('rejects synthetic API principals without request-bound credential metadata', async () => {
    await expect(read({ user: { id: 1, ownershipUserId: null, groups: [1] } as never })).rejects.toMatchObject({ status: 403 })
  })
  it('returns a bounded explanation for malformed saved certificate material', async () => {
    await setting('letsencrypt', { payload: { cert: 'malformed-private-certificate-details' }, serverKey: 'private-key' })
    const workspace = await read()
    expect(workspace.savedCertificate).toBeNull()
    expect(workspace.savedCertificateIssue).toContain('could not be read')
    expect(JSON.stringify(workspace)).not.toContain('malformed-private-certificate-details')
    expect(JSON.stringify(workspace)).not.toContain('private-key')
  })
  it('keeps the effect guard stable across owned ACME writes while fencing policy changes', async () => {
    const state = () => db.transaction(tx => store.reviewState(tx, admin))
    const before = await state()
    await setting('letsencrypt', { revision: 'new-certificate-revision', serverKey: 'private-key' })
    const after = await state()
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.effectFingerprint).toBe(before.effectFingerprint)
    await setting('offline', { v: true })
    expect((await state()).effectFingerprint).not.toBe(before.effectFingerprint)
  })
})
