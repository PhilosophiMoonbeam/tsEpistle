import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { createDeveloperFlagsWorkspaceStore, getDeveloperFlagsWorkspaceStore, type DeveloperFlagsWorkspaceStore } from '../../operations/developer-flags.ts'
import type { DeveloperFlags } from '../../../shared/developer-flags.ts'

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const port = Number(process.env.WIKI_TEST_POSTGRES_PORT)
const connection =
  database.endsWith('_developer_flags_test') && password
    ? { host: '127.0.0.1', ...(Number.isInteger(port) && port > 0 ? { port } : {}), user: 'wiki', database, password }
    : null
const suite = connection ? describe : describe.skip
const administrator = { user: { id: 1, authVersion: 0 } } as never

suite('Developer flags workspace persistence on PostgreSQL', () => {
  let db: Knex
  let runtimeFlags: Record<string, unknown>
  let runtimeSqlDebug: boolean
  let applySaved: (policy: DeveloperFlags) => Promise<{ applied: boolean; published: boolean }>
  let store: DeveloperFlagsWorkspaceStore

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.schema.createTable('settings', table => {
      table.string('key').primary()
      table.jsonb('value')
      table.string('updatedAt').notNullable()
    })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.jsonb('permissions').notNullable()
      table.string('adminRevision').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').notNullable()
      table.integer('groupId').notNullable()
    })
  })

  afterAll(async () => {
    if (!db) return
    for (const table of ['settings', 'userGroups', 'groups', 'users']) await db.schema.dropTableIfExists(table)
    await db.destroy()
  })

  beforeEach(async () => {
    for (const table of ['settings', 'userGroups', 'groups', 'users']) await db(table).delete()
    await db('users').insert({ id: 1, isActive: true, authVersion: 0 })
    await db('groups').insert({ id: 1, permissions: JSON.stringify(['manage:system']), adminRevision: 'first' })
    await db('userGroups').insert({ userId: 1, groupId: 1 })
    await db('settings').insert({
      key: 'flags',
      value: JSON.stringify({ ldapdebug: false, sqllog: false, retained: 'unrelated setting' }),
      updatedAt: '2026-09-07T00:00:00.000Z'
    })
    runtimeFlags = { ldapdebug: false, sqllog: false, retained: 'runtime-only setting' }
    runtimeSqlDebug = false
    applySaved = vi.fn().mockImplementation(async (policy: DeveloperFlags) => {
      runtimeFlags = { ...runtimeFlags, ...policy }
      runtimeSqlDebug = policy.sqllog
      return { applied: true, published: true }
    })
    store = createDeveloperFlagsWorkspaceStore({
      db,
      reviewKey: 'developer-flags-fixture-key',
      fallback: () => ({ flags: { ldapdebug: false, sqllog: false, fallbackRetained: true } }),
      deploymentDefaults: () => ({ ldapdebug: false, sqllog: false }),
      runtime: () => ({ instanceId: 'fixture-process', flags: runtimeFlags, sqlQueryLoggingApplied: runtimeSqlDebug }),
      applySaved
    })
  })

  it('stages a reviewed policy separately so unrelated reloads retain active flags and unknown values', async () => {
    const initial = await store.inspect(administrator)
    expect(initial.saved).toMatchObject({ policy: { ldapdebug: false, sqllog: false }, source: 'database', state: 'active' })
    await store.save(administrator, {
      policy: { ldapdebug: false, sqllog: true },
      fingerprint: initial.fingerprint,
      reason: 'Trace the current database failure'
    })

    const flags = (await db('settings').where('key', 'flags').first()).value
    const metadata = (await db('settings').where('key', 'developerFlagsAdministration').first()).value
    expect(flags).toMatchObject({ ldapdebug: false, sqllog: false, retained: 'unrelated setting' })
    expect(metadata).toMatchObject({ policy: { ldapdebug: false, sqllog: true } })
    expect(metadata.history).toHaveLength(1)
    expect(metadata.history[0]).toMatchObject({ changed: ['sqllog'], reason: 'Trace the current database failure', policy: { ldapdebug: false, sqllog: true } })
    expect(applySaved).not.toHaveBeenCalled()

    const staged = await store.inspect(administrator)
    expect(staged.saved).toMatchObject({ policy: { ldapdebug: false, sqllog: true }, source: 'reviewed-administration', state: 'staged' })
    await expect(store.legacyList(administrator)).resolves.toEqual([
      { key: 'ldapdebug', value: false },
      { key: 'sqllog', value: false }
    ])
    expect(staged.process.settingsCurrent).toBe(false)
  })

  it('rejects stale and ABA reviews, then promotes only the current staged policy', async () => {
    const initial = await store.inspect(administrator)
    await expect(
      store.save(administrator, { policy: { ldapdebug: true, sqllog: false }, fingerprint: '0'.repeat(64), reason: 'Investigate LDAP failures' })
    ).rejects.toMatchObject({
      status: 409
    })
    await store.save(administrator, { policy: { ldapdebug: true, sqllog: false }, fingerprint: initial.fingerprint, reason: 'Investigate LDAP failures' })
    const firstReview = await store.inspect(administrator)
    await store.save(administrator, { policy: { ldapdebug: false, sqllog: false }, fingerprint: firstReview.fingerprint, reason: 'Finish LDAP investigation' })
    const current = await store.inspect(administrator)

    await expect(store.apply(administrator, { fingerprint: initial.fingerprint })).rejects.toMatchObject({ status: 409 })
    const result = await store.apply(administrator, { fingerprint: current.fingerprint })
    expect(result).toMatchObject({ applied: true, published: true })
    expect(applySaved).toHaveBeenCalledWith({ ldapdebug: false, sqllog: false })
    expect((await db('settings').where('key', 'flags').first()).value).toMatchObject({ ldapdebug: false, sqllog: false, retained: 'unrelated setting' })
    expect((await store.inspect(administrator)).process.settingsCurrent).toBe(true)
  })

  it('preserves fallback unknown flags on the first explicit promotion', async () => {
    await db('settings').where('key', 'flags').delete()
    const initial = await store.inspect(administrator)
    await store.save(administrator, {
      policy: { ldapdebug: true, sqllog: false },
      fingerprint: initial.fingerprint,
      reason: 'Inspect first-write fallback preservation'
    })
    expect(await db('settings').where('key', 'flags').first()).toBeUndefined()

    const staged = await store.inspect(administrator)
    await store.apply(administrator, { fingerprint: staged.fingerprint })
    expect((await db('settings').where('key', 'flags').first()).value).toMatchObject({
      ldapdebug: true,
      sqllog: false,
      fallbackRetained: true
    })
  })
  it('rolls back a failed durable promotion without reconciling the process', async () => {
    const initial = await store.inspect(administrator)
    await store.save(administrator, { policy: { ldapdebug: true, sqllog: false }, fingerprint: initial.fingerprint, reason: 'Exercise promotion rollback' })
    const staged = await store.inspect(administrator)
    await db.raw(`
      CREATE FUNCTION reject_developer_flag_promotion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.key = 'flags' THEN RAISE EXCEPTION 'promotion blocked'; END IF;
        RETURN NEW;
      END;
      $$;
    `)
    await db.raw(
      'CREATE TRIGGER reject_developer_flag_promotion BEFORE INSERT OR UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION reject_developer_flag_promotion();'
    )
    try {
      await expect(store.apply(administrator, { fingerprint: staged.fingerprint })).rejects.toThrow('promotion blocked')
    } finally {
      await db.raw('DROP TRIGGER IF EXISTS reject_developer_flag_promotion ON settings; DROP FUNCTION IF EXISTS reject_developer_flag_promotion();')
    }
    expect((await db('settings').where('key', 'flags').first()).value).toMatchObject({ ldapdebug: false, sqllog: false, retained: 'unrelated setting' })
    expect((await store.inspect(administrator)).saved.state).toBe('staged')
    expect(applySaved).not.toHaveBeenCalled()
  })

  it('reports peer publication as unconfirmed even when the local EventEmitter accepts the reload request', async () => {
    const previousWiki = globalThis.WIKI
    const config = { sessionSecret: 'runtime-fixture-secret', flags: { ldapdebug: false, sqllog: false } }
    const emit = vi.fn()
    try {
      globalThis.WIKI = {
        INSTANCE_ID: 'runtime-fixture',
        config,
        data: { defaults: { config: { flags: { ldapdebug: false, sqllog: false } } } },
        models: { knex: db },
        configSvc: {
          loadFromDb: async () => {
            config.flags = (await db('settings').where('key', 'flags').first()).value
          },
          applyFlags: async () => {
            db.client.config.debug = config.flags.sqllog
          }
        },
        events: { outbound: { emit } },
        logger: { warn: vi.fn() }
      } as typeof globalThis.WIKI
      const runtimeStore = getDeveloperFlagsWorkspaceStore()
      const initial = await runtimeStore.inspect(administrator)
      await runtimeStore.save(administrator, {
        policy: { ldapdebug: false, sqllog: true },
        fingerprint: initial.fingerprint,
        reason: 'Confirm local peer request reporting'
      })
      const staged = await runtimeStore.inspect(administrator)
      const result = await runtimeStore.apply(administrator, { fingerprint: staged.fingerprint })

      expect(result).toMatchObject({ applied: true, published: false })
      expect(emit).toHaveBeenCalledWith('reloadConfig')
    } finally {
      db.client.config.debug = false
      globalThis.WIKI = previousWiki
    }
  })

  it('rechecks persisted authority before saving', async () => {
    const initial = await store.inspect(administrator)
    await db('groups')
      .where('id', 1)
      .update({ permissions: JSON.stringify([]), adminRevision: 'revoked' })
    await expect(
      store.save(administrator, { policy: { ldapdebug: true, sqllog: false }, fingerprint: initial.fingerprint, reason: 'Investigate LDAP failures' })
    ).rejects.toMatchObject({ status: 403 })
    expect((await db('settings').where('key', 'flags').first()).value).toMatchObject({ ldapdebug: false, sqllog: false })
  })
})
