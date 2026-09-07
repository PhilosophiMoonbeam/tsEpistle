import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from '../bun-test.mts'
import { createTlsWorkspaceStore } from '../../operations/tls-workspace.ts'
import { up, down } from '../../db/migrations/tsepistle-000025-tls-operations.ts'
import type { TlsMaterialConfiguration } from '../../repositories/tls-material.ts'
import { prepareTlsMaterial } from '../../repositories/tls-preflight.ts'
import { describeTlsCertificate } from '../../repositories/tls-material.ts'
import { tlsFixture } from '../helpers/tls-fixture.ts'
import type { SystemRequester } from '../../helpers/system-authority.ts'
import type { TlsListenerSnapshot, TlsOperationKind, TlsConnectionEvidence } from '../../../shared/tls-workspace.ts'
const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? '',
  password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_ssl_test') && password ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT), user: 'wiki', database, password } : null
const suite = connection ? describe : describe.skip
const admin: SystemRequester = { user: { id: 1, authVersion: 0 } as never },
  other: SystemRequester = { user: { id: 3, authVersion: 0 } as never }
suite('HTTPS operation receipts on PostgreSQL', () => {
  let db: Knex,
    fixture: ReturnType<typeof tlsFixture>,
    fallback: Record<string, unknown> & {
      host: string
      server: { sslRedir: boolean }
      security: { securityTrustProxy: boolean }
      offline: boolean
      ssl: TlsMaterialConfiguration & { enabled: boolean; provider: string }
    },
    listeners: TlsListenerSnapshot,
    store: ReturnType<typeof createTlsWorkspaceStore>,
    clock: number
  let apply: ReturnType<typeof vi.fn>, probe: ReturnType<typeof vi.fn>, renew: ReturnType<typeof vi.fn>, publish: ReturnType<typeof vi.fn>
  const setting = (key: string, value: unknown) =>
    db('settings')
      .insert({ key, value: JSON.stringify(value), updatedAt: new Date().toISOString() })
      .onConflict('key')
      .merge(['value', 'updatedAt'])
  const request = async (kind: TlsOperationKind, extra = {}) => ({ id: randomUUID(), kind, fingerprint: (await store.inspect(admin)).fingerprint, ...extra })
  const finished = async (id: string, requester = admin) => {
    for (let i = 0; i < 150; i++) {
      const row = await store.receipt(requester, id)
      if (row.state !== 'running') return row
      await Bun.sleep(20)
    }
    throw new Error('Fixture operation did not finish.')
  }
  const run = async (kind: TlsOperationKind, extra = {}) => {
    const input = await request(kind, extra)
    await store.start(admin, input)
    return finished(input.id)
  }
  beforeAll(async () => {
    fixture = tlsFixture(90)
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
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
    await up(db)
  })
  afterAll(async () => {
    if (db) {
      await db('tlsOperations').delete()
      await down(db)
      for (const name of ['settings', 'userGroups', 'groups', 'users', 'apiKeys']) await db.schema.dropTableIfExists(name)
      await db.destroy()
    }
    fixture?.close()
  })
  beforeEach(async () => {
    for (const name of ['tlsOperations', 'settings', 'userGroups', 'groups', 'users', 'apiKeys']) await db(name).delete()
    await db('users').insert([
      { id: 1, isActive: true, authVersion: 0 },
      { id: 3, isActive: true, authVersion: 0 }
    ])
    await db('groups').insert({ id: 1, permissions: '["manage:system"]', adminRevision: 'initial' })
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 3, groupId: 1 }
    ])
    clock = Date.now()
    fallback = {
      host: 'https://wiki.example.test',
      server: { sslRedir: false },
      security: { securityTrustProxy: true },
      offline: false,
      ssl: { enabled: true, provider: 'custom', format: 'pem', inline: true, key: fixture.first.key, cert: fixture.first.cert }
    }
    for (const key of ['host', 'server', 'security', 'offline']) await setting(key, ['host', 'offline'].includes(key) ? { v: fallback[key] } : fallback[key])
    await setting('sslAdministration', {})
    listeners = { httpPort: 3000, httpsPort: 3443, material: null, replacementMode: 'listener-restart' }
    apply = vi.fn(async () => {
      const material = {
        revision: randomUUID(),
        appliedAt: new Date().toISOString(),
        certificate: describeTlsCertificate(fixture.first.cert),
        source: 'inline' as const,
        format: 'pem' as const
      }
      listeners.material = material
      return material
    })
    probe = vi.fn(
      async target =>
        ({
          observedAt: new Date(clock).toISOString(),
          endpoint: target,
          connected: true,
          trusted: true,
          hostnameMatches: true,
          protocol: 'TLSv1.3',
          cipher: 'fixture',
          certificate: describeTlsCertificate(fixture.first.cert),
          chain: [describeTlsCertificate(fixture.first.cert)],
          summary: 'Fixture handshake succeeded; no HTTP request was sent.'
        }) satisfies TlsConnectionEvidence
    )
    renew = vi.fn(async guard => {
      await guard()
      return describeTlsCertificate(fixture.first.cert)
    })
    publish = vi.fn(enabled => {
      fallback.server.sslRedir = enabled
    })
    store = createTlsWorkspaceStore({
      db,
      reviewKey: 'fixture-tls-review-key',
      fallback: () => fallback,
      listeners: () => structuredClone(listeners),
      nativeTarget: () => (listeners.httpsPort ? { host: '127.0.0.1', port: listeners.httpsPort, servername: 'wiki.example.test' } : null),
      publishRedirection: publish,
      acme: () => ({ apiDirectory: 'https://ca.example.test', challenge: null, init: async () => {}, requestCertificate: renew }),
      prepareHttps: async config => {
        const material = await prepareTlsMaterial(config)
        return {
          materialKey: material.key,
          certificate: material.certificate,
          source: material.source,
          format: material.format,
          mode: 'listener-restart',
          apply
        }
      },
      probe,
      now: () => new Date(clock)
    })
  })
  it('records and retrieves a public handshake without exposing internal ownership or review fields', async () => {
    const result = await run('public-check')
    expect(result).toMatchObject({
      state: 'succeeded',
      result: { connection: { connected: true, trusted: true, hostnameMatches: true, endpoint: { host: 'wiki.example.test', port: 443 } } }
    })
    expect(probe).toHaveBeenCalledTimes(1)
    for (const field of ['ownerId', 'effectFingerprint', 'reviewFingerprint', 'materialKey']) expect(result).not.toHaveProperty(field)
    expect((await store.inspect(other)).operations[0]?.id).toBe(result.id)
    expect(JSON.stringify(result)).not.toContain('PRIVATE KEY')
  })
  it('recovers a lost start response with the same ID without replaying its handshake', async () => {
    const input = await request('public-check')
    await store.start(admin, input)
    await finished(input.id)
    expect((await store.start(admin, input)).state).toBe('succeeded')
    expect(probe).toHaveBeenCalledTimes(1)
    await expect(store.start(other, input)).rejects.toMatchObject({ status: 409 })
    await expect(store.start(admin, { ...input, kind: 'native-check' })).rejects.toMatchObject({ status: 409 })
  })
  it('accepts only a current successful public receipt for redirect publication', async () => {
    const check = await run('public-check'),
      before = await store.inspect(admin)
    const result = await store.save(admin, {
      enabled: true,
      fingerprint: before.fingerprint,
      reason: 'Enable reviewed HTTPS redirect',
      verifiedCheckId: check.id
    })
    expect(result.applied).toBe(true)
    expect(fallback.server.sslRedir).toBe(true)
    expect((await store.inspect(admin)).runtimeRedirection.settingsCurrent).toBe(true)
  })
  it('rejects stale or unsuccessful endpoint evidence before enabling redirection', async () => {
    const check = await run('public-check')
    clock += 16 * 60000
    await expect(
      store.save(admin, { enabled: true, fingerprint: (await store.inspect(admin)).fingerprint, reason: 'Enable reviewed redirect', verifiedCheckId: check.id })
    ).rejects.toMatchObject({ status: 409 })
    expect(fallback.server.sslRedir).toBe(false)
    probe.mockResolvedValueOnce({ ...structuredClone(check.result!.connection!), trusted: false })
    const failed = await run('public-check')
    expect(failed.state).toBe('failed')
    await expect(
      store.save(admin, {
        enabled: true,
        fingerprint: (await store.inspect(admin)).fingerprint,
        reason: 'Enable reviewed redirect',
        verifiedCheckId: failed.id
      })
    ).rejects.toMatchObject({ status: 409 })
  })
  it('preserves a saved policy when publication fails and allows explicit reapplication', async () => {
    const check = await run('public-check')
    publish.mockImplementationOnce(() => {
      throw new Error('fixture runtime unavailable')
    })
    expect(
      await store.save(admin, {
        enabled: true,
        fingerprint: (await store.inspect(admin)).fingerprint,
        reason: 'Enable reviewed redirect',
        verifiedCheckId: check.id
      })
    ).toMatchObject({ enabled: true, applied: false })
    expect((await store.inspect(admin)).redirection.enabled).toBe(true)
    expect(fallback.server.sslRedir).toBe(false)
    expect((await store.applyPolicy(admin, { fingerprint: (await store.inspect(admin)).fingerprint })).applied).toBe(true)
  })
  it('validates material locally and requires review of the native restart before application', async () => {
    const check = await run('validate-material')
    expect(check.state).toBe('succeeded')
    expect(check.result?.material?.certificate.subject).toBe('CN=wiki.example.test')
    expect(apply).not.toHaveBeenCalled()
    const input = await request('apply-certificate', { reason: 'Replace reviewed certificate', materialCheckId: check.id })
    await expect(store.start(admin, input)).rejects.toThrow('connection interruption')
    await store.start(admin, { ...input, allowRestart: true })
    expect((await finished(input.id)).state).toBe('succeeded')
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith({ allowRestart: true })
    expect((await store.start(admin, { ...input, allowRestart: true })).state).toBe('succeeded')
    expect(apply).toHaveBeenCalledTimes(1)
  })
  it('refuses changed certificate file contents after validation without restarting HTTPS', async () => {
    fallback.ssl = { enabled: true, provider: 'custom', format: 'pem', inline: false, key: fixture.first.keyPath, cert: fixture.first.certPath }
    const check = await run('validate-material')
    writeFileSync(fixture.first.keyPath, fixture.second.key)
    writeFileSync(fixture.first.certPath, fixture.second.cert)
    try {
      const result = await run('apply-certificate', { reason: 'Replace checked certificate', materialCheckId: check.id, allowRestart: true })
      expect(result.state).toBe('failed')
      expect(apply).not.toHaveBeenCalled()
    } finally {
      writeFileSync(fixture.first.keyPath, fixture.first.key)
      writeFileSync(fixture.first.certPath, fixture.first.cert)
    }
  })
  it('allows local validation offline while blocking public checks and external issuance', async () => {
    fallback.offline = true
    await setting('offline', { v: true })
    expect((await run('validate-material')).state).toBe('succeeded')
    await expect(store.start(admin, await request('public-check'))).rejects.toThrow('offline mode')
    await expect(store.start(admin, await request('renew-certificate', { reason: 'Renew certificate', confirmIssuance: true }))).rejects.toThrow('offline mode')
    expect(renew).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })
  it('permits owned ACME persistence between guarded effects and leaves listener application separate', async () => {
    fallback.ssl.provider = 'letsencrypt'
    renew.mockImplementationOnce(async guard => {
      await guard()
      await setting('letsencrypt', { revision: randomUUID(), serverKey: fixture.first.key, payload: { cert: fixture.first.cert, chain: '' } })
      await guard()
      return describeTlsCertificate(fixture.first.cert)
    })
    const result = await run('renew-certificate', { reason: 'Renew expiring certificate', confirmIssuance: true })
    expect(result.state).toBe('succeeded')
    expect(result.summary).toContain('apply it separately')
    expect(apply).not.toHaveBeenCalled()
    expect((await store.inspect(admin)).savedCertificate?.subject).toBe('CN=wiki.example.test')
  })
  it('records uncertain external outcomes and requires acknowledgement before another certificate change', async () => {
    fallback.ssl.provider = 'letsencrypt'
    renew.mockRejectedValueOnce(new Error('private-authority-detail'))
    const uncertain = await run('renew-certificate', { reason: 'Renew certificate', confirmIssuance: true })
    expect(uncertain.state).toBe('uncertain')
    expect(JSON.stringify(uncertain)).not.toContain('private-authority-detail')
    const next = await request('renew-certificate', { reason: 'Review prior uncertainty', confirmIssuance: true })
    await expect(store.start(admin, next)).rejects.toThrow('latest uncertain')
    await store.start(admin, { ...next, acknowledgedUncertainId: uncertain.id })
    expect((await finished(next.id)).state).toBe('succeeded')
    expect(renew).toHaveBeenCalledTimes(2)
  })
  it('does not replay an abandoned operation when its receipt is read', async () => {
    const saved = await db.transaction(tx => store.configuration.reviewState(tx, admin)),
      id = randomUUID()
    await db('tlsOperations').insert({
      id,
      kind: 'renew-certificate',
      state: 'running',
      phase: 'requesting-certificate',
      actorId: 1,
      apiKeyId: null,
      reason: 'Previous request',
      reviewFingerprint: saved.fingerprint,
      effectFingerprint: saved.effectFingerprint,
      materialKey: null,
      materialCheckId: null,
      allowRestart: false,
      ownerId: randomUUID(),
      createdAt: new Date(clock - 180000),
      heartbeatAt: new Date(clock - 180000),
      completedAt: null,
      summary: 'Previously running',
      result: null
    })
    expect((await store.receipt(admin, id)).state).toBe('uncertain')
    expect(renew).not.toHaveBeenCalled()
    expect((await db('tlsOperations').where('id', id).first()).state).toBe('running')
    expect((await run('public-check')).state).toBe('succeeded')
    expect((await db('tlsOperations').where('id', id).first()).state).toBe('uncertain')
    expect(renew).not.toHaveBeenCalled()
  })
  it('rejects rollback when recorded operations exist', async () => {
    await run('public-check')
    await expect(down(db)).rejects.toThrow('Cannot discard recorded HTTPS operations')
    expect(await db.schema.hasTable('tlsOperations')).toBe(true)
  })
  it('excludes a second operation while the first handshake remains in progress', async () => {
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => {
        release = resolve
      }),
      waiting = new Promise<void>(resolve => {
        entered = resolve
      })
    const response = {
      observedAt: new Date(clock).toISOString(),
      endpoint: { host: 'wiki.example.test', port: 443, servername: 'wiki.example.test' },
      connected: false,
      trusted: null,
      hostnameMatches: null,
      protocol: null,
      cipher: null,
      certificate: null,
      chain: [],
      summary: 'Fixture handshake stopped.'
    }
    probe.mockImplementationOnce(async () => {
      entered()
      await gate
      return response
    })
    const first = await request('public-check')
    await store.start(admin, first)
    await waiting
    try {
      await expect(store.start(admin, await request('public-check'))).rejects.toThrow('already running')
    } finally {
      release()
      await finished(first.id)
    }
    expect(probe).toHaveBeenCalledTimes(1)
  })
  it('rechecks authority before further external effects during issuance', async () => {
    fallback.ssl.provider = 'letsencrypt'
    let continued = false
    renew.mockImplementationOnce(async guard => {
      await db('users').where('id', 1).update({ isActive: false })
      await guard()
      continued = true
      return describeTlsCertificate(fixture.first.cert)
    })
    const input = await request('renew-certificate', { reason: 'Renew certificate', confirmIssuance: true })
    await store.start(admin, input)
    expect((await finished(input.id, other)).state).toBe('uncertain')
    expect(continued).toBe(false)
    expect(apply).not.toHaveBeenCalled()
  })
  it('records uncertainty after an applied certificate cannot receive a success receipt, without replaying application', async () => {
    const checked = await run('validate-material')
    await db.raw(`ALTER TABLE "tlsOperations" ADD CONSTRAINT tls_fixture_success_reject CHECK (state <> 'succeeded' OR kind <> 'apply-certificate')`)
    const input = await request('apply-certificate', { reason: 'Apply reviewed certificate', materialCheckId: checked.id, allowRestart: true })
    try {
      await store.start(admin, input)
      expect((await finished(input.id)).state).toBe('uncertain')
      expect(listeners.material?.revision).toBeDefined()
      expect((await store.start(admin, input)).state).toBe('uncertain')
      expect(apply).toHaveBeenCalledTimes(1)
    } finally {
      await db.raw('ALTER TABLE "tlsOperations" DROP CONSTRAINT tls_fixture_success_reject')
    }
  })
})
