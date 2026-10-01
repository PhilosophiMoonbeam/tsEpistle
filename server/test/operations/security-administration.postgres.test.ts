import { assertSavedPassword } from '../../helpers/password-policy.ts'
import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from '../bun-test.mts'
import {
  createSecurityAdministrationStore,
  securityPolicyFromConfiguration,
  patchLegacySecurityConfiguration
} from '../../operations/security-administration.ts'
import { securityPolicyDefaults, type SecurityPolicy } from '../../../shared/security-policy.ts'
import { up, down } from '../../db/migrations/tsepistle-000020-security-administration.ts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
const connection = getPostgresTestConnection('_security_test', import.meta.path)
const suite = connection ? describe : describe.skip,
  admin = { id: 1, authVersion: 0 } as never
const definitions = () => [
  { key: 'local', useForm: true },
  { key: 'oidc', useForm: false }
]
suite('PostgreSQL reviewed workspace security', () => {
  let db: Knex, store: ReturnType<typeof createSecurityAdministrationStore>, runtime: SecurityPolicy
  const read = () => store.inspect(admin)
  const write = async (patch: Partial<SecurityPolicy>, extra = {}) => {
    const w = await read()
    return store.save(admin, { policy: { ...w.policy, ...patch }, fingerprint: w.fingerprint, reason: 'Review workspace security policy', ...extra })
  }
  const tables = ['securityAdministrationEvents', 'userAdministrationEvents', 'userGroups', 'users', 'groups', 'authentication', 'settings']
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 8 } })
    await db.schema.createTable('settings', t => {
      t.string('key').primary()
      t.jsonb('value')
      t.timestamp('updatedAt')
    })
    await db.schema.createTable('groups', t => {
      t.integer('id').primary()
      t.json('permissions')
      t.string('adminRevision').defaultTo('')
    })
    await db.schema.createTable('authentication', t => {
      t.string('key').primary()
      t.string('strategyKey')
      t.string('displayName')
      t.boolean('isEnabled')
      t.string('adminRevision').defaultTo('')
    })
    await db.schema.createTable('users', t => {
      t.integer('id').primary()
      t.string('providerKey')
      t.boolean('isActive').defaultTo(true)
      t.integer('authVersion').defaultTo(0)
      t.string('adminRevision').defaultTo('')
      t.boolean('tfaIsActive').defaultTo(false)
      t.text('tfaSecret')
      t.timestamp('sessionsRevokedAt')
    })
    await db.schema.createTable('userGroups', t => {
      t.integer('userId')
      t.integer('groupId')
      t.primary(['userId', 'groupId'])
    })
    await db.schema.createTable('userAdministrationEvents', t => {
      t.increments('id')
      t.integer('userId')
      t.integer('actorId')
      t.string('action')
      t.text('reason')
      t.jsonb('details')
      t.timestamp('createdAt')
    })
    await up(db)
  })
  afterAll(async () => {
    if (db) {
      for (const table of tables) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
  })
  beforeEach(async () => {
    for (const table of tables) await db(table).delete()
    await db('settings').insert([
      { key: 'auth', value: JSON.stringify({ audience: 'urn:wiki.js', tokenExpiration: '30m', tokenRenewal: '14d', unrelatedAuthSetting: 'retained' }) },
      { key: 'security', value: JSON.stringify({ securitySRI: true, futureSecurityOption: 'retained' }) },
      { key: 'uploads', value: JSON.stringify({ maxFiles: 10, storageOption: 'retained' }) },
      { key: 'title', value: JSON.stringify({ v: 'Workspace title' }) },
      { key: 'securityPolicyRevision', value: JSON.stringify({ revision: '' }) }
    ])
    await db('groups').insert([
      { id: 1, permissions: '["manage:system"]' },
      { id: 2, permissions: '[]' },
      { id: 3, permissions: '["manage:users"]' }
    ])
    await db('authentication').insert([
      { key: 'local', strategyKey: 'local', displayName: 'Local', isEnabled: true },
      { key: 'org', strategyKey: 'oidc', displayName: 'Organization', isEnabled: true }
    ])
    await db('users').insert([
      { id: 1, providerKey: 'local', tfaIsActive: true, tfaSecret: 'secret-not-for-administration' },
      { id: 2, providerKey: 'local' },
      { id: 3, providerKey: 'org' },
      { id: 4, providerKey: 'local', isActive: false }
    ])
    await db('userGroups').insert([
      { userId: 1, groupId: 1 },
      { userId: 2, groupId: 2 },
      { userId: 3, groupId: 3 }
    ])
    runtime = structuredClone(securityPolicyDefaults)
    store = createSecurityAdministrationStore({
      db,
      reviewKey: 'fixture-review-key',
      fallback: () => ({}),
      host: () => 'https://wiki.example.invalid',
      definitions,
      runtime: () => runtime
    })
  })
  it('reports account coverage and observed policy without exposing two-factor secrets', async () => {
    const w = await read()
    expect(w.policy).toEqual(securityPolicyDefaults)
    expect(w.coverage).toEqual({
      activeAccounts: 2,
      formAccounts: 1,
      twoFactorEnrolled: 1,
      providerManagedAccounts: 1,
      unavailableProviderAccounts: 0,
      localAccounts: 1
    })
    expect(w.runtime.state).toBe('applied')
    expect(JSON.stringify(w)).not.toContain('secret-not-for-administration')
    runtime = { ...runtime, authPasswordMinLength: 16 }
    expect((await read()).runtime.state).toBe('pending')
  })
  it('requires persisted system authority and a current account session', async () => {
    await expect(store.inspect({ id: 3, authVersion: 0, permissions: ['manage:system'] } as never)).rejects.toMatchObject({ status: 403 })
    await db('users').where('id', 1).update({ authVersion: 1 })
    await expect(read()).rejects.toMatchObject({ status: 403 })
  })
  it('preserves unrelated persisted settings and writes policy/history without ending sessions for a file setting', async () => {
    expect(await write({ uploadMaxFileSize: 1048576 })).toMatchObject({ sessionsEnded: 0, currentSessionEnded: false })
    const settings = Object.fromEntries((await db('settings')).map(row => [row.key, row.value]))
    expect(settings.auth.unrelatedAuthSetting).toBe('retained')
    expect(settings.security.futureSecurityOption).toBe('retained')
    expect(settings.uploads).toMatchObject({ maxFileSize: 1048576, maxFiles: 10, storageOption: 'retained' })
    expect(settings.title).toEqual({ v: 'Workspace title' })
    expect((await read()).history[0]).toMatchObject({ actorId: 1, fields: ['uploadMaxFileSize'], sessionsEnded: 0 })
    expect(await db('userAdministrationEvents')).toHaveLength(0)
  })
  it('atomically ends all account generations except Guest for token-policy changes', async () => {
    expect(await write({ authJwtExpirationSeconds: 900 })).toMatchObject({ sessionsEnded: 3, currentSessionEnded: true })
    expect((await db('users').orderBy('id')).map(row => row.authVersion)).toEqual([1, 0, 1, 1])
    expect(await db('userAdministrationEvents')).toHaveLength(3)
    expect((await db('securityAdministrationEvents').first()).sessionsEnded).toBe(3)
    await expect(read()).rejects.toMatchObject({ status: 403 })
  })
  it('supports an explicit session-only action while requiring a reason and a reviewed snapshot', async () => {
    await expect(write({}, { reason: '' })).rejects.toMatchObject({ status: 400 })
    expect(await write({}, { endSessions: true })).toMatchObject({ sessionsEnded: 3 })
    expect((await db('securityAdministrationEvents').first()).fields).toEqual([])
  })
  it('requires report-only staging before enforcing new CSP directives', async () => {
    await expect(write({ securityCSPMode: 'enforce', securityCSPDirectives: "default-src 'self'" })).rejects.toMatchObject({ status: 400 })
    await write({ securityCSPMode: 'report-only', securityCSPDirectives: "default-src 'self'" })
    await write({ securityCSPMode: 'enforce' })
    expect((await read()).policy.securityCSPMode).toBe('enforce')
    await expect(write({ securityCSPDirectives: "default-src 'none'" })).rejects.toMatchObject({ status: 400 })
  })
  it('protects Local visibility when no alternative is available and HTTPS policy on an HTTP workspace', async () => {
    await db('authentication').where('key', 'org').update({ isEnabled: false })
    await expect(write({ authHideLocal: true })).rejects.toMatchObject({ status: 400 })
    const insecure = createSecurityAdministrationStore({
      db,
      reviewKey: 'fixture-review-key',
      fallback: () => ({}),
      host: () => 'http://wiki.example.invalid',
      definitions,
      runtime: () => runtime
    })
    const w = await insecure.inspect(admin)
    await expect(
      insecure.save(admin, { policy: { ...w.policy, securityHSTS: true }, fingerprint: w.fingerprint, reason: 'Verify HTTPS boundary' })
    ).rejects.toMatchObject({ status: 400 })
  })
  it('accepts exactly one simultaneous reviewed save and rejects stale account coverage', async () => {
    let w = await read()
    const input = { policy: { ...w.policy, uploadMaxFileSize: 1048576 }, fingerprint: w.fingerprint, reason: 'Review concurrent configuration' }
    const results = await Promise.allSettled([store.save(admin, input), store.save(admin, input)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    w = await read()
    await db('users').where('id', 3).update({ isActive: false })
    await expect(store.save(admin, { ...input, fingerprint: w.fingerprint })).rejects.toMatchObject({ status: 409 })
  })
  it('rolls settings and session changes back when retained history cannot be written', async () => {
    await db.raw(`CREATE FUNCTION reject_security_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'history unavailable'; END $$`)
    await db.raw(
      'CREATE TRIGGER reject_security_history BEFORE INSERT ON "securityAdministrationEvents" FOR EACH ROW EXECUTE FUNCTION reject_security_history()'
    )
    try {
      await expect(write({ authEnforce2FA: true })).rejects.toThrow('history unavailable')
      expect((await read()).policy.authEnforce2FA).toBe(false)
      expect((await db('users').where('id', 1).first()).authVersion).toBe(0)
      expect(await db('userAdministrationEvents')).toHaveLength(0)
    } finally {
      await db.raw('DROP TRIGGER reject_security_history ON "securityAdministrationEvents"')
      await db.raw('DROP FUNCTION reject_security_history()')
    }
  })
  it('reports activation failure after a committed save and retries only a current authorized policy', async () => {
    const onCommitted = vi.fn().mockRejectedValue(new Error('Runtime reload failed')),
      service = createSecurityAdministrationStore({
        db,
        reviewKey: 'fixture-review-key',
        fallback: () => ({}),
        host: () => 'https://wiki.example.invalid',
        definitions,
        runtime: () => runtime,
        onCommitted
      }),
      w = await service.inspect(admin)
    expect(
      (
        await service.save(admin, {
          policy: { ...w.policy, uploadMaxFileSize: 1048576 },
          fingerprint: w.fingerprint,
          reason: 'Verify durable save despite failed reload'
        })
      ).activation
    ).toBe('needs-attention')
    expect((await read()).policy.uploadMaxFileSize).toBe(1048576)
    onCommitted.mockResolvedValue(true)
    await expect(service.initialize(admin, w.fingerprint)).rejects.toMatchObject({ status: 409 })
    expect((await service.initialize(admin, (await service.inspect(admin)).fingerprint)).activation).toBe('applied')
  })
  it('routes legacy settings through the same reviewed policy and rejects mixed or obsolete changes', async () => {
    const configuration = { host: 'https://wiki.example.invalid', sessionSecret: 'fixture-review-key' } as Record<string, unknown>
    const loadFromDb = async () => Object.assign(configuration, Object.fromEntries((await db('settings')).map(row => [row.key, row.value])))
    await loadFromDb()
    const authRuntime = {
      jwtAudience: 'urn:wiki.js',
      activateStrategies: vi.fn(async () => {
        authRuntime.jwtAudience = String((configuration.auth as { audience: string }).audience)
      }),
      revokeUserTokens: vi.fn()
    }
    vi.stubGlobal('WIKI', {
      models: { knex: db },
      config: configuration,
      data: { authentication: definitions() },
      configSvc: { loadFromDb },
      auth: authRuntime,
      app: { set: vi.fn() },
      events: { outbound: { emit: vi.fn() } }
    })
    try {
      await expect(patchLegacySecurityConfiguration(admin, { title: 'Unrelated title', securityIframe: false })).rejects.toMatchObject({ status: 400 })
      await expect(patchLegacySecurityConfiguration(admin, { uploadMaxFiles: 20 })).rejects.toMatchObject({ status: 400 })
      await expect(patchLegacySecurityConfiguration(admin, { securitySRI: false })).rejects.toMatchObject({ status: 400 })
      await expect(patchLegacySecurityConfiguration(admin, { authJwtExpiration: 'nonsense' })).rejects.toMatchObject({ status: 400 })
      await patchLegacySecurityConfiguration(admin, { uploadMaxFileSize: 2097152, uploadMaxFiles: 10, securitySRI: true })
      expect((await read()).policy.uploadMaxFileSize).toBe(2097152)
      expect(authRuntime.activateStrategies).not.toHaveBeenCalled()
      expect((await read()).history[0]).toMatchObject({ actorId: 1, fields: ['uploadMaxFileSize'], sessionsEnded: 0 })
      expect((await db('settings').where('key', 'title').first()).value).toEqual({ v: 'Workspace title' })
      await write({ securityCSPMode: 'report-only', securityCSPDirectives: "default-src 'self'" })
      await patchLegacySecurityConfiguration(admin, { securityCSP: false, securityIframe: false })
      expect((await read()).policy.securityCSPMode).toBe('report-only')
      await patchLegacySecurityConfiguration(admin, { authJwtExpiration: '15m' })
      expect((await db('users').where('id', 1).first()).authVersion).toBe(1)
      expect(securityPolicyFromConfiguration(configuration).authJwtExpirationSeconds).toBe(900)
      expect(authRuntime.activateStrategies).not.toHaveBeenCalled()
      await patchLegacySecurityConfiguration({ id: 1, authVersion: 1 } as never, { authJwtAudience: 'reviewed-workspace-audience' })
      expect(authRuntime.activateStrategies).toHaveBeenCalledOnce()
      expect(authRuntime.jwtAudience).toBe('reviewed-workspace-audience')
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('rechecks saved password requirements after a concurrent policy writer completes', async () => {
    const writer = await db.transaction()
    let validator: Knex.Transaction | undefined
    let pendingOutcome: Promise<void> | undefined
    try {
      await writer('settings').where('key', 'auth').forUpdate().first()
      const writerPid = (await writer.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid
      validator = await db.transaction()
      const validatorPid = (await validator.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid
      let validatorSettled = false
      const pending = assertSavedPassword(validator, 'eighteen-characters')
      pendingOutcome = pending.then(() => { validatorSettled = true }, () => { validatorSettled = true })
      await vi.waitFor(async () => {
        const blocked = await db.raw('SELECT ?::integer = ANY(pg_blocking_pids(?::integer)) AS blocked', [writerPid, validatorPid])
        expect(blocked.rows).toEqual([{ blocked: true }])
        expect(validatorSettled).toBe(false)
      }, { timeout: 2000 })
      await writer('settings')
        .where('key', 'auth')
        .update({ value: JSON.stringify({ passwordMinLength: 24 }) })
      await writer.commit()
      await expect(pending).rejects.toThrow('24 characters')
    } finally {
      try {
        if (!writer.isCompleted()) await writer.rollback()
      } finally {
        try {
          await pendingOutcome
        } finally {
          if (validator && !validator.isCompleted()) await validator.rollback()
        }
      }
    }
    await expect(Promise.resolve(db.transaction(tx => assertSavedPassword(tx, 'a'.repeat(24))))).resolves.toBeUndefined()
    await expect(Promise.resolve(db.transaction(tx => assertSavedPassword(tx, '😀'.repeat(24))))).rejects.toThrow('72 UTF-8 bytes')
  })
  it('guards migration reversal after policy history exists', async () => {
    await down(db)
    await up(db)
    await write({ uploadScanSVG: false })
    await expect(down(db)).rejects.toThrow('Cannot discard recorded workspace security policy')
  })
})
describe('Security configuration projection', () => {
  it('preserves the meaning of legacy enforced CSP and duration strings', () => {
    expect(
      securityPolicyFromConfiguration({ auth: { tokenExpiration: '2h', tokenRenewal: '0s' }, security: { securityCSP: true, securityCSPReportOnly: true } })
    ).toMatchObject({ authJwtExpirationSeconds: 7200, authJwtRenewalSeconds: 0, securityCSPMode: 'enforce' })
  })
})
