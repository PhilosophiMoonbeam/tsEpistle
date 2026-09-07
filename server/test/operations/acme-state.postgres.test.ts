import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from '../bun-test.mts'
import { createAcmeStateStore, type AcmeSavedState } from '../../repositories/acme-state.ts'
const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? '',
  password = process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_ssl_test') && password ? { host: '127.0.0.1', port: Number(process.env.WIKI_TEST_POSTGRES_PORT), user: 'wiki', database, password } : null
const suite = connection ? describe : describe.skip
suite('ACME persistence and exclusion on PostgreSQL', () => {
  let db: Knex, fallback: AcmeSavedState, store: ReturnType<typeof createAcmeStateStore>
  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 6 } })
    await db.schema.createTable('settings', t => {
      t.string('key').primary()
      t.jsonb('value').notNullable()
      t.string('updatedAt').notNullable()
    })
  })
  afterAll(async () => {
    if (db) {
      await db.schema.dropTableIfExists('settings')
      await db.destroy()
    }
  })
  beforeEach(async () => {
    await db('settings').delete()
    fallback = { serverKey: 'fallback-private-key', challenge: { token: 'stale' }, opaque: { retain: true } }
    store = createAcmeStateStore(db, () => fallback)
  })
  it('uses fallback only for an absent row and never returns a persisted challenge', async () => {
    expect((await store.read()).value).toEqual({ serverKey: 'fallback-private-key', opaque: { retain: true } })
    await db('settings').insert({
      key: 'letsencrypt',
      value: JSON.stringify({ serverKey: 'saved-private-key', challenge: { token: 'old' } }),
      updatedAt: 'initial'
    })
    expect((await store.read()).value).toEqual({ serverKey: 'saved-private-key' })
  })
  it('persists a new revision, omits temporary challenge state and preserves unowned values', async () => {
    const before = await store.read(),
      after = await store.save(before, { ...before.value, domain: 'wiki.example.test', challenge: { token: 'must-not-persist' } })
    expect(after.value).toMatchObject({
      serverKey: 'fallback-private-key',
      domain: 'wiki.example.test',
      opaque: { retain: true },
      revision: expect.any(String)
    })
    expect(after.token).not.toBe(before.token)
    expect(await store.read()).toEqual(after)
    expect(JSON.stringify((await db('settings').first()).value)).not.toContain('must-not-persist')
    expect(fallback).toHaveProperty('challenge')
  })
  it('rejects stale and ABA writes without overwriting the newer certificate', async () => {
    const initial = await store.save(await store.read(), { serverKey: 'key-a' })
    const b = await store.save(initial, { serverKey: 'key-b' })
    await expect(store.save(initial, { serverKey: 'stale' })).rejects.toThrow('state changed')
    await store.save(b, { serverKey: 'key-a' })
    await expect(store.save(initial, { serverKey: 'stale-again' })).rejects.toThrow('state changed')
    expect((await store.read()).value.serverKey).toBe('key-a')
  })
  it('detects a changed fallback while the persistent row is absent', async () => {
    const before = await store.read()
    fallback.serverKey = 'changed-private-key'
    await expect(store.save(before, before.value)).rejects.toThrow('state changed')
    expect(await db('settings').first()).toBeUndefined()
  })
  it('allows exactly one concurrent writer from the same snapshot', async () => {
    const before = await store.save(await store.read(), { serverKey: 'initial' })
    const results = await Promise.allSettled([store.save(before, { serverKey: 'left' }), store.save(before, { serverKey: 'right' })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
  it('does not admit a second owner during certificate work and releases the guard after failure', async () => {
    const other = createAcmeStateStore(db, () => ({}))
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => {
        release = resolve
      }),
      waiting = new Promise<void>(resolve => {
        entered = resolve
      })
    const first = store.exclusive(async () => {
      entered()
      await gate
      throw new Error('fixture failure')
    })
    await waiting
    await expect(other.exclusive(async () => 'should not run')).rejects.toThrow('already in progress')
    release()
    await expect(first).rejects.toThrow('fixture failure')
    expect(await other.exclusive(async () => 'next owner')).toBe('next owner')
  })
  it('does not keep a transaction open while certificate work is running', async () => {
    await store.exclusive(async () => {
      const rows = await db.raw('SELECT state FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()')
      expect(rows.rows.some((row: { state: string }) => row.state === 'idle in transaction')).toBe(false)
      expect(await store.save(await store.read(), { serverKey: 'written-under-lease' })).toHaveProperty('value.serverKey', 'written-under-lease')
    })
  })
  it('destroys a connection whose lock-acquisition response was lost, releasing any acquired lock', async () => {
    const original = db.raw.bind(db)
    const transport = {
      client: db.client,
      raw: (sql: string, bindings: never) =>
        sql.includes('pg_try_advisory_lock')
          ? {
              connection: async (client: object) => {
                await original(sql, bindings).connection(client)
                throw new Error('fixture lost response')
              }
            }
          : original(sql, bindings)
    }
    const interrupted = createAcmeStateStore(transport as unknown as Knex, () => ({}))
    await expect(interrupted.exclusive(async () => 'unreachable')).rejects.toThrow('lost response')
    expect(await store.exclusive(async () => 'recovered')).toBe('recovered')
  })
  it('destroys a connection after unlock failure instead of returning a held lock to the pool', async () => {
    const original = db.raw.bind(db)
    const transport = {
      client: db.client,
      raw: (sql: string, bindings: never) =>
        sql.includes('pg_advisory_unlock')
          ? {
              connection: async () => {
                throw new Error('fixture unlock failure')
              }
            }
          : original(sql, bindings)
    }
    const interrupted = createAcmeStateStore(transport as unknown as Knex, () => ({}))
    expect(await interrupted.exclusive(async () => 'completed')).toBe('completed')
    expect(await store.exclusive(async () => 'recovered')).toBe('recovered')
  })
  it('fences further effects when the request connection loses its lock', async () => {
    await store.exclusive(async assertHeld => {
      await expect(assertHeld()).resolves.toBeUndefined()
      const rows = await db.raw(
        "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = ?::oid AND objid = ?::oid AND objsubid = 2 AND granted",
        [1414743376, 443]
      )
      const pid = rows.rows[0].pid
      await db.raw('SELECT pg_terminate_backend(?)', [pid])
      await expect(assertHeld()).rejects.toThrow()
    })
    expect(await store.exclusive(async () => 'next owner')).toBe('next owner')
  })
})
