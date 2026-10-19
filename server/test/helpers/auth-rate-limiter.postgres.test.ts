import type { Request, Response } from 'express'
import createKnex, { type Knex } from 'knex'
import { createAuthRateLimiter, type AuthRateLimiter } from '../../helpers/auth-rate-limiter.ts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_auth_rate_limiter_test', import.meta.path)
const ip = '192.0.2.70'
const prefix = 'auth-native'
const attemptKey = `${prefix}:attempts:${ip}`
const blockKey = `${prefix}:blocks:${ip}`
const lifetime = 12 * 60 * 60 * 1000
const request = { ip, socket: { remoteAddress: ip } } as Request

if (connection) {
  describe('PostgreSQL auth rate limiter accounting', () => {
    let db: Knex
    let second: Knex
    let observer: Knex
    let limiter: AuthRateLimiter
    let otherLimiter: AuthRateLimiter
    let now: number

    const state = async (table: string) => (await db(table).orderBy('key')).map(row => ({
      key: row.key as string,
      points: Number(row.points),
      expire: row.expire === null ? null : Number(row.expire)
    }))

    beforeAll(async () => {
      db = createKnex({ client: 'pg', connection, pool: { min: 1, max: 1 } })
      second = createKnex({ client: 'pg', connection, pool: { min: 1, max: 1 } })
      observer = createKnex({ client: 'pg', connection, pool: { min: 1, max: 1 } })
      for (const table of ['authRateLimitAttempts', 'authRateLimitBlocks']) {
        await db.schema.createTable(table, builder => {
          builder.string('key', 255).primary()
          builder.bigInteger('points').notNullable()
          builder.bigInteger('expire').nullable()
        })
      }
    })

    beforeEach(async () => {
      await db('authRateLimitBlocks').del()
      await db('authRateLimitAttempts').del()
      now = Date.UTC(2026, 0, 1)
      vi.spyOn(Date, 'now').mockImplementation(() => now)
      limiter = createAuthRateLimiter({ knex: db, keyPrefix: prefix })
      otherLimiter = createAuthRateLimiter({ knex: second, keyPrefix: prefix })
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    afterAll(async () => {
      await db.schema.dropTableIfExists('authRateLimitBlocks')
      await db.schema.dropTableIfExists('authRateLimitAttempts')
      await Promise.all([db.destroy(), second.destroy(), observer.destroy()])
    })

    it('counts both concurrent first consumptions exactly once and retains only four free admissions', async () => {
      // A server notice arrives before the advisory wait, unlike transactional
      // NOTIFY. Both real INSERTs must enter before either can create the key;
      // a SELECT FOR UPDATE of a missing row therefore cannot hide the race.
      await db.raw(`
        CREATE FUNCTION auth_rate_limit_insert_gate() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE NOTICE 'auth-rate-limit-first-insert';
          PERFORM pg_advisory_xact_lock(54219, 1);
          RETURN NEW;
        END $$;
        CREATE TRIGGER auth_rate_limit_insert_gate BEFORE INSERT ON "authRateLimitAttempts"
          FOR EACH ROW EXECUTE FUNCTION auth_rate_limit_insert_gate();
      `)
      let entered = 0
      let bothEntered!: () => void
      const barrier = new Promise<void>(resolve => { bothEntered = resolve })
      const onNotice = (notice: { message?: string }) => {
        if (notice.message !== 'auth-rate-limit-first-insert') return
        entered += 1
        if (entered === 2) bothEntered()
      }
      const clients = await Promise.all([db.client.acquireConnection(), second.client.acquireConnection()])
      for (const client of clients) client.on('notice', onNotice)
      await Promise.all([db.client.releaseConnection(clients[0]), second.client.releaseConnection(clients[1])])
      const gate = await observer.transaction()
      let settled: Promise<PromiseSettledResult<number | null>[]> | undefined
      try {
        await gate.raw('SELECT pg_advisory_xact_lock(54219, 1)')
        const pending = [limiter.admit(request), otherLimiter.admit(request)]
        settled = Promise.allSettled(pending)
        await Promise.race([
          barrier,
          ...pending.map(async result => {
            await result
            throw new Error('Admission completed before both database insertions reached the gate')
          })
        ])
        await gate.commit()
        expect(await settled).toEqual([
          { status: 'fulfilled', value: null },
          { status: 'fulfilled', value: null }
        ])
        expect(await state('authRateLimitAttempts')).toEqual([{ key: attemptKey, points: 2, expire: now + lifetime }])
        expect(await state('authRateLimitBlocks')).toEqual([])
      } finally {
        if (!gate.isCompleted()) await gate.rollback()
        if (settled) await settled
        for (const client of clients) client.removeListener('notice', onNotice)
        await db.raw('DROP TRIGGER auth_rate_limit_insert_gate ON "authRateLimitAttempts"; DROP FUNCTION auth_rate_limit_insert_gate()')
      }

      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(await otherLimiter.admit(request)).toBeNull()
      }
      expect(await limiter.admit(request)).toBe(5 * 60 * 1000)
      expect(await state('authRateLimitAttempts')).toEqual([{ key: attemptKey, points: 7, expire: now + lifetime }])
      expect(await state('authRateLimitBlocks')).toEqual([{ key: blockKey, points: 1, expire: now + 5 * 60 * 1000 }])
    })

    it('admits only the sixth attempt when two connections cross the free-attempt boundary', async () => {
      await db('authRateLimitAttempts').insert({ key: attemptKey, points: 5, expire: now + lifetime })
      const outcomes = await Promise.all([limiter.admit(request), otherLimiter.admit(request)])
      expect(outcomes.filter(result => result === null)).toEqual([null])
      expect(outcomes.filter(result => result !== null)).toEqual([5 * 60 * 1000])
      expect(await state('authRateLimitAttempts')).toEqual([{ key: attemptKey, points: 7, expire: now + lifetime }])
      const block = [{ key: blockKey, points: 1, expire: now + 5 * 60 * 1000 }]
      expect(await state('authRateLimitBlocks')).toEqual(block)

      now += 60 * 1000
      expect(await Promise.all([limiter.admit(request), otherLimiter.admit(request)])).toEqual([4 * 60 * 1000, 4 * 60 * 1000])
      expect(await state('authRateLimitAttempts')).toEqual([{ key: attemptKey, points: 7, expire: now - 60 * 1000 + lifetime }])
      expect(await state('authRateLimitBlocks')).toEqual(block)
    })

    it.each([
      ['already expired', -1, null, 1],
      ['exactly expired', 0, null, 1],
      ['one millisecond remaining', 1, 5 * 60 * 1000, 7],
      ['non-expiring', null, 5 * 60 * 1000, 7]
    ] as const)('preserves accounting for the %s attempt window', async (_label, offset, admission, points) => {
      const expire = offset === null ? null : now + offset
      await db('authRateLimitAttempts').insert({ key: attemptKey, points: 6, expire })
      expect(await limiter.admit(request)).toBe(admission)
      expect(await state('authRateLimitAttempts')).toEqual([{
        key: attemptKey,
        points,
        expire: points === 1 ? now + lifetime : expire
      }])
      expect(await state('authRateLimitBlocks')).toEqual(admission === null ? [] : [{ key: blockKey, points: 1, expire: now + admission }])
    })

    it('does not expire an active block with its attempt window and releases it at the exact block deadline', async () => {
      const blockExpire = now + 5 * 60 * 1000
      const attemptExpire = now + 1
      await db('authRateLimitAttempts').insert({ key: attemptKey, points: 7, expire: attemptExpire })
      await db('authRateLimitBlocks').insert({ key: blockKey, points: 1, expire: blockExpire })
      now = blockExpire - 1
      expect(await otherLimiter.admit(request)).toBe(1)
      expect(await state('authRateLimitAttempts')).toEqual([{ key: attemptKey, points: 7, expire: attemptExpire }])
      expect(await state('authRateLimitBlocks')).toEqual([{ key: blockKey, points: 1, expire: blockExpire }])

      now = blockExpire
      expect(await limiter.admit(request)).toBeNull()
      expect(await state('authRateLimitAttempts')).toEqual([{ key: attemptKey, points: 1, expire: now + lifetime }])
      expect(await state('authRateLimitBlocks')).toEqual([{ key: blockKey, points: 1, expire: blockExpire }])
    })

    it('renews expired blocks without extending the attempt window and caps progressive waits at one hour', async () => {
      const attemptExpire = now + lifetime
      for (let attempt = 0; attempt < 6; attempt += 1) expect(await limiter.admit(request)).toBeNull()
      for (const [index, minutes] of [5, 5, 10, 15, 25, 40, 60, 60].entries()) {
        const wait = minutes * 60 * 1000
        expect(await otherLimiter.admit(request)).toBe(wait)
        expect(await state('authRateLimitAttempts')).toEqual([{ key: attemptKey, points: 7 + 2 * index, expire: attemptExpire }])
        expect(await state('authRateLimitBlocks')).toEqual([{ key: blockKey, points: 1, expire: now + wait }])
        now += wait
        expect(await limiter.admit(request)).toBeNull()
        expect(await state('authRateLimitAttempts')).toEqual([{ key: attemptKey, points: 8 + 2 * index, expire: attemptExpire }])
      }
    })

    it('resets both durable records for every application instance', async () => {
      for (let attempt = 0; attempt < 6; attempt += 1) expect(await limiter.admit(request)).toBeNull()
      expect(await otherLimiter.admit(request)).toBe(5 * 60 * 1000)
      await limiter.reset(request)
      expect(await state('authRateLimitAttempts')).toEqual([])
      expect(await state('authRateLimitBlocks')).toEqual([])
      for (let attempt = 0; attempt < 6; attempt += 1) expect(await otherLimiter.admit(request)).toBeNull()
      expect(await limiter.admit(request)).toBe(5 * 60 * 1000)
      expect(await state('authRateLimitAttempts')).toEqual([{ key: attemptKey, points: 7, expire: now + lifetime }])
      expect(await state('authRateLimitBlocks')).toEqual([{ key: blockKey, points: 1, expire: now + 5 * 60 * 1000 }])
    })

    it.each(['authRateLimitAttempts', 'authRateLimitBlocks'])('fails closed on a real %s persistence error', async table => {
      if (table === 'authRateLimitBlocks') {
        for (let attempt = 0; attempt < 6; attempt += 1) expect(await limiter.admit(request)).toBeNull()
      }
      await db.raw(`
        CREATE FUNCTION auth_rate_limit_write_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'auth rate limit persistence unavailable';
        END $$;
        CREATE TRIGGER auth_rate_limit_write_failure BEFORE INSERT OR UPDATE ON ??
          FOR EACH ROW EXECUTE FUNCTION auth_rate_limit_write_failure();
      `, [table])
      const onLimit = vi.fn()
      const closed = createAuthRateLimiter({ knex: second, keyPrefix: prefix, onLimit })
      try {
        const next = vi.fn()
        await closed.middleware(request, {} as Response, next)
        expect(next).toHaveBeenCalledTimes(1)
        expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'P0001' }))
        expect(onLimit).not.toHaveBeenCalled()
        expect(await state('authRateLimitAttempts')).toEqual(table === 'authRateLimitAttempts' ? [] : [{ key: attemptKey, points: 7, expire: now + lifetime }])
        expect(await state('authRateLimitBlocks')).toEqual([])
      } finally {
        await db.raw('DROP TRIGGER auth_rate_limit_write_failure ON ??; DROP FUNCTION auth_rate_limit_write_failure()', [table])
      }
    })
  })
}
