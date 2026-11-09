import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { Request } from 'express'
import express from 'express'
import session from 'express-session'
import createKnex, { type Knex } from 'knex'
import { Passport } from 'passport'
import { up as migrate } from '../../db/migrations/tsepistle-000071-browser-session-retirement.ts'
import { BrowserSessionStore } from '../../helpers/browser-session-store.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_session_retirement_test', import.meta.path)
const suite = connection ? describe : describe.skip
const secret = 'browser-session-native-test-secret-at-least-thirty-two-bytes'
interface Gate {
  entered: { promise: Promise<void>; resolve: () => void }
  release: { promise: Promise<void>; resolve: () => void }
}
const bounded = async <T>(operation: PromiseLike<T>): Promise<T> => {
  const deadline = Promise.withResolvers<never>()
  // Failure deadline only: PostgreSQL/network completion is signaled directly,
  // and no assertion depends on waiting this duration or a guessed sleep.
  const timer = setTimeout(() => deadline.reject(new Error('Browser-session fixture exceeded 10 seconds')), 10_000)
  try { return await Promise.race([operation, deadline.promise]) } finally { clearTimeout(timer) }
}
const save = async (value: session.Session): Promise<void> => {
  const result = Promise.withResolvers<void>()
  value.save(error => error ? result.reject(error) : result.resolve())
  await bounded(result.promise)
}
const destroy = async (store: BrowserSessionStore, sid: string): Promise<void> => {
  const result = Promise.withResolvers<void>()
  store.destroy(sid, error => error ? result.reject(error) : result.resolve())
  await bounded(result.promise)
}
const load = async (store: BrowserSessionStore, sid: string): Promise<session.Session & session.SessionData> => {
  const result = Promise.withResolvers<session.SessionData>()
  store.get(sid, (error, value) => error ? result.reject(error) : value ? result.resolve(value) : result.reject(new Error('Fixture session missing')))
  const value = await bounded(result.promise)
  return store.createSession({ sessionID: sid, sessionStore: store } as unknown as Request, value)
}
const generate = (store: BrowserSessionStore): session.Session & session.SessionData => {
  const request = { headers: {}, connection: {}, sessionStore: store } as unknown as Request
  store.generate(request)
  return request.session
}

suite('PostgreSQL browser-session retirement across instances', () => {
  let db: Knex
  let second: Knex
  let firstStore: BrowserSessionStore
  let secondStore: BrowserSessionStore
  const servers: Server[] = []

  beforeAll(async () => {
    db = createKnex({ client: 'pg', connection: connection!, pool: { min: 0, max: 4 } })
    second = createKnex({ client: 'pg', connection: connection!, pool: { min: 0, max: 4 } })
    await db.schema.dropTableIfExists('browserSessionLifecycles')
    await db.schema.dropTableIfExists('sessions')
    await migrate(db)
    firstStore = new BrowserSessionStore({ knex: db, cleanupInterval: 0 })
    secondStore = new BrowserSessionStore({ knex: second, cleanupInterval: 0 })
    for (const store of [firstStore, secondStore]) store.middleware({ secret, resave: false, saveUninitialized: false })
    await Promise.all([firstStore.ready, secondStore.ready])
  })
  beforeEach(async () => {
    await db('sessions').delete()
    await db('browserSessionLifecycles').delete()
  })
  afterAll(async () => {
    for (const server of servers) {
      server.closeAllConnections()
      const closed = Promise.withResolvers<void>()
      server.close(() => closed.resolve())
      await closed.promise
    }
    await Promise.all([firstStore?.close(), secondStore?.close()])
    if (db) {
      await db.schema.dropTableIfExists('browserSessionLifecycles')
      await db.schema.dropTableIfExists('sessions')
    }
    await Promise.all([db?.destroy(), second?.destroy()])
  })

  it('preserves legacy live data and cookie expiry while backfilling and lazily admitting generations', async () => {
    const original = { cookie: { httpOnly: true, originalMaxAge: null, expires: null }, csrf: randomUUID(), workflow: { provider: 'native' } }
    const expiry = new Date(Date.now() + 60_000)
    await db.schema.dropTable('browserSessionLifecycles')
    await db('sessions').insert({ sid: 'legacy-live', sess: JSON.stringify(original), expired: expiry })
    await migrate(db)
    const row = await db('sessions').where({ sid: 'legacy-live' }).first()
    expect(typeof row.sess === 'string' ? JSON.parse(row.sess) : row.sess).toEqual(original)
    expect(new Date(row.expired).toISOString()).toBe(expiry.toISOString())
    expect(await db('browserSessionLifecycles').where({ sid: 'legacy-live' }).first()).toMatchObject({ retiredAt: null })
    await db('browserSessionLifecycles').where({ sid: 'legacy-live' }).delete()
    const loaded = await load(secondStore, 'legacy-live')
    Object.assign(loaded, { modified: true })
    await save(loaded)
    expect(Reflect.get(await load(firstStore, 'legacy-live'), 'csrf')).toBe(original.csrf)
    await destroy(firstStore, 'legacy-live')
    await expect(save(loaded)).rejects.toMatchObject({ code: 'BROWSER_SESSION_RETIRED' })
  })

  it('fences destroy before the first save even when no persisted session exists', async () => {
    const fresh = generate(firstStore)
    await destroy(secondStore, fresh.id)
    await expect(save(fresh)).rejects.toMatchObject({ code: 'BROWSER_SESSION_RETIRED' })
    expect(await db('sessions').where({ sid: fresh.id }).first()).toBeUndefined()
    expect(await db('browserSessionLifecycles').where({ sid: fresh.id }).first()).not.toBeUndefined()
  })

  it('serializes an in-flight first save and destroy without allowing a later resurrection', async () => {
    const fresh = generate(firstStore)
    const transaction = await db.transaction()
    const entered = Promise.withResolvers<void>()
    const insert = (query: { sql: string }) => { if (query.sql.startsWith('insert into "browserSessionLifecycles"')) entered.resolve() }
    firstStore.options.knex.on('query', insert)
    try {
      await transaction.raw('LOCK TABLE ?? IN SHARE MODE', ['browserSessionLifecycles'])
      const pending = save(fresh)
      pending.catch(() => undefined)
      await bounded(entered.promise)
      const retirement = destroy(secondStore, fresh.id)
      retirement.catch(() => undefined)
      await transaction.commit()
      const results = await Promise.allSettled([pending, retirement])
      expect(results[1]!.status).toBe('fulfilled')
      await expect(save(fresh)).rejects.toMatchObject({ code: 'BROWSER_SESSION_RETIRED' })
      expect(await db('sessions').where({ sid: fresh.id }).first()).toBeUndefined()
    } finally {
      firstStore.options.knex.removeListener('query', insert)
      if (!transaction.isCompleted()) await transaction.rollback()
    }
  })

  it('allows same-generation concurrent initial and loaded benign writes without version conflicts', async () => {
    const fresh = generate(firstStore)
    await Promise.all([save(fresh), save(fresh)])
    const [first, other] = await Promise.all([load(firstStore, fresh.id), load(secondStore, fresh.id)])
    Object.assign(first, { benign: 'first' })
    Object.assign(other, { benign: 'second' })
    await Promise.all([save(first), save(other)])
    expect(['first', 'second']).toContain(Reflect.get(await load(firstStore, fresh.id), 'benign'))
    expect(await db('browserSessionLifecycles').where({ sid: fresh.id })).toHaveLength(1)
  })

  it('rejects expired loaded saves before and after cleanup, never recreating removed rows', async () => {
    const fresh = generate(firstStore)
    await save(fresh)
    const loaded = await load(firstStore, fresh.id)
    await db('sessions').where({ sid: fresh.id }).update({ expired: new Date(Date.now() - 1_000) })
    await expect(save(loaded)).rejects.toMatchObject({ code: 'BROWSER_SESSION_RETIRED' })
    await secondStore.cleanup()
    expect(await db('sessions').where({ sid: fresh.id }).first()).toBeUndefined()
    await expect(save(loaded)).rejects.toMatchObject({ code: 'BROWSER_SESSION_RETIRED' })
    await db('browserSessionLifecycles').where({ sid: fresh.id }).update({ expiresAt: new Date(Date.now() - 1_000) })
    await secondStore.cleanup()
    expect(await db('browserSessionLifecycles').where({ sid: fresh.id }).first()).toBeUndefined()
    await expect(save(loaded)).rejects.toMatchObject({ code: 'BROWSER_SESSION_RETIRED' })
  })

  it('uses the post-lock database clock rather than transaction-start time for expiry', async () => {
    const fresh = generate(firstStore)
    await save(fresh)
    const loaded = await load(firstStore, fresh.id)
    const lock = await second.transaction()
    const attempted = Promise.withResolvers<void>()
    const queryListener = (query: { sql: string }) => { if (query.sql.includes('for update')) attempted.resolve() }
    db.on('query', queryListener)
    try {
      await lock('browserSessionLifecycles').where({ sid: fresh.id }).forUpdate().first()
      const pending = save(loaded)
      pending.catch(() => undefined)
      await bounded(attempted.promise)
      // The fixture changes expiry while holding the same lifecycle mutex. The
      // waiting save must inspect this committed expiry, not its old snapshot.
      await lock('sessions').where({ sid: fresh.id }).update({ expired: lock.raw("clock_timestamp() - interval '1 millisecond'") })
      await lock.commit()
      await expect(pending).rejects.toMatchObject({ code: 'BROWSER_SESSION_RETIRED' })
    } finally {
      db.removeListener('query', queryListener)
      if (!lock.isCompleted()) await lock.rollback()
    }
  })

  it('rolls back failed creation and failed retirement without promoting markers or deleting live state', async () => {
    await db.raw(`CREATE FUNCTION browser_session_reject_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejects session write'; END $$`)
    await db.raw('CREATE TRIGGER browser_session_write_failure BEFORE INSERT OR DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION browser_session_reject_write()')
    const fresh = generate(firstStore)
    try {
      await expect(save(fresh)).rejects.toThrow('fixture rejects session write')
      expect(await db('browserSessionLifecycles').where({ sid: fresh.id }).first()).toBeUndefined()
      await db.raw('DROP TRIGGER browser_session_write_failure ON sessions')
      await save(fresh)
      await db.raw('CREATE TRIGGER browser_session_write_failure BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION browser_session_reject_write()')
      await expect(destroy(secondStore, fresh.id)).rejects.toThrow('fixture rejects session write')
      expect(await db('browserSessionLifecycles').where({ sid: fresh.id }).first()).toMatchObject({ retiredAt: null })
      expect(await load(firstStore, fresh.id)).toBeDefined()
    } finally {
      await db.raw('DROP TRIGGER IF EXISTS browser_session_write_failure ON sessions')
      await db.raw('DROP FUNCTION browser_session_reject_write()')
    }
  })

  it('does not promote a first-save marker until deferred commit constraints pass', async () => {
    await db.raw(`CREATE FUNCTION browser_session_reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejects session commit'; END $$`)
    await db.raw('CREATE CONSTRAINT TRIGGER browser_session_commit_failure AFTER INSERT ON sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION browser_session_reject_commit()')
    const fresh = generate(firstStore)
    try {
      await expect(save(fresh)).rejects.toThrow('fixture rejects session commit')
      expect(await db('sessions').where({ sid: fresh.id }).first()).toBeUndefined()
      expect(await db('browserSessionLifecycles').where({ sid: fresh.id }).first()).toBeUndefined()
    } finally {
      await db.raw('DROP TRIGGER browser_session_commit_failure ON sessions')
      await db.raw('DROP FUNCTION browser_session_reject_commit()')
    }
    await save(fresh)
    expect(await load(secondStore, fresh.id)).toBeDefined()
  })

  it('makes real Passport logout and cookie regeneration fence a held Express save on the other instance', async () => {
    const gates = new Map<string, Gate>()
    let secure = false
    const urls: string[] = []
    const realStores: BrowserSessionStore[] = []
    try {
      for (const database of [db, second]) {
        const store = new BrowserSessionStore({ knex: database, cleanupInterval: 0 })
        realStores.push(store)
        const app = express()
        app.set('trust proxy', 'loopback')
        app.use(store.middleware({ secret, resave: false, saveUninitialized: false, cookie: () => ({ secure, sameSite: 'lax', httpOnly: true }) }))
        app.use((request, _response, next) => {
          if (Boolean(request.session.cookie.secure) === secure) return next()
          request.session.regenerate(next)
        })
        app.use(new Passport().initialize())
        app.post('/seed', (request, response) => {
          Object.assign(request.session, { csrf: randomUUID() })
          response.json({ sid: request.sessionID, csrf: Reflect.get(request.session, 'csrf') })
        })
        app.post('/probe', (request, response) => response.json({ sid: request.sessionID, csrf: Reflect.get(request.session, 'csrf') ?? null }))
        app.post('/hold/:id', async (request, response, next) => {
          const gate = gates.get(request.params.id)!
          Object.assign(request.session, { late: true })
          gate.entered.resolve()
          await bounded(gate.release.promise)
          request.session.save(error => error ? next(error) : response.json({ saved: true }))
        })
        app.post('/logout', (request, response, next) => request.logout(error => error ? next(error) : response.status(303).end()))
        app.use((_error: unknown, _request: Request, response: express.Response, _next: express.NextFunction) => response.status(409).json({ retired: true }))
        const listening = Promise.withResolvers<void>()
        const server = app.listen(0, '127.0.0.1', listening.resolve)
        servers.push(server)
        server.once('error', listening.reject)
        await bounded(listening.promise)
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Fixture did not bind loopback')
        urls.push(`http://127.0.0.1:${address.port}`)
      }
      const request = async (index: number, route: string, cookie?: string) => await fetch(urls[index] + route, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10_000),
        headers: { 'X-Forwarded-Proto': 'https', ...(cookie ? { Cookie: cookie } : {}) }
      })
      for (const mode of ['logout', 'cookie-regeneration', 'expiry-cleanup'] as const) {
        secure = false
        const seeded = await request(0, '/seed')
        const oldCookie = seeded.headers.getSetCookie().find(value => value.startsWith('connect.sid='))!.split(';', 1)[0]!
        const original = await seeded.json() as { sid: string; csrf: string }
        const gate = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
        const key = randomUUID()
        gates.set(key, gate)
        const pending = request(0, `/hold/${key}`, oldCookie)
        pending.catch(() => undefined)
        try {
          await bounded(gate.entered.promise)
          if (mode === 'logout') expect((await request(1, '/logout', oldCookie)).status).toBe(303)
          else if (mode === 'cookie-regeneration') {
            secure = true
            expect((await request(1, '/seed', oldCookie)).status).toBe(200)
          } else {
            await db('sessions').where({ sid: original.sid }).update({ expired: new Date(Date.now() - 1_000) })
            await realStores[1]!.cleanup()
          }
        } finally { gate.release.resolve() }
        expect((await pending).status).toBe(409)
        expect(await db('sessions').where({ sid: original.sid }).first()).toBeUndefined()
        const old = await (await request(1, '/probe', oldCookie)).json() as { sid: string; csrf: string | null }
        expect(old.sid).not.toBe(original.sid)
        expect(old.csrf).toBeNull()
        gates.delete(key)
      }
    } finally {
      for (const gate of gates.values()) gate.release.resolve()
      await Promise.all(realStores.map(store => store.close()))
    }
  })
})
