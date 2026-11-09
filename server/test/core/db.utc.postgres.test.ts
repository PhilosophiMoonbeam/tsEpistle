import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import createKnex, { type Knex } from 'knex'
import { up as baseline } from '../../db/migrations/2.0.0.ts'
import { up as durableJobs } from '../../db/migrations/2.5.130.ts'
import { up as mentions } from '../../db/migrations/tsepistle-000033-comment-mentions.ts'
import { afterAll, beforeAll, describe, expect, it, vi } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_db_utc_test', import.meta.path)
const suite = connection ? describe : describe.skip
const schema = `utc_${randomUUID().replaceAll('-', '')}`
const role = `utc_role_${randomUUID().replaceAll('-', '')}`
const rolePassword = randomUUID()
const originalUrl = process.env.DATABASE_URL
const originalCa = process.env.DB_SSL_CA
const wiki = {
  INSTANCE_ID: 'utc-native', CONNECTION_ROLE: 'pool', IS_DEBUG: false, IS_MASTER: false,
  ROOTPATH: process.cwd(), SERVERPATH: '',
  config: {
    db: { host: connection?.host ?? '', user: connection?.user ?? '', pass: connection?.password ?? '',
      db: connection?.database ?? '', port: connection?.port ?? 5432, ssl: false, sslOptions: {}, schema, type: 'postgres' },
    ha: true, pool: { min: 0, max: 2 }
  },
  auth: { subscribeToEvents: vi.fn() }, configSvc: { subscribeToEvents: vi.fn() },
  events: { inbound: { emit: vi.fn(), removeAllListeners: vi.fn() }, outbound: { onAny: vi.fn(), offAny: vi.fn() } },
  models: { listener: null, pages: { subscribeToEvents: vi.fn() } },
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}
Reflect.set(globalThis, 'WIKI', wiki)
// db.ts captures the process WIKI at evaluation, so this loading boundary must follow the fixture.
const { default: database } = await import('../../core/db.ts')

const bounded = async <T>(operation: PromiseLike<T>): Promise<T> => {
  const deadline = Promise.withResolvers<never>()
  // This is an I/O failure deadline, not a sleep or a clock under test.
  const timer = setTimeout(() => deadline.reject(new Error('Native UTC operation exceeded 10 seconds')), 10_000)
  try { return await Promise.race([operation, deadline.promise]) } finally { clearTimeout(timer) }
}
interface QueryConnection { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; fields?: { name: string; dataTypeID: number }[] }> }
const listenerConnection = async (): Promise<QueryConnection> => {
  if (!database.listener) throw new Error('HA listener not started')
  // pg-pubsub exposes this protected transport boundary; no production test hook is needed.
  const listener = database.listener as unknown as { _getDB(): Promise<QueryConnection> }
  return listener._getDB()
}
const settingsSql = `SELECT current_setting('TimeZone') AS timezone, current_setting('application_name') AS application,
  current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout, pg_backend_pid() AS pid`
const asIso = (value: unknown): string => {
  if (!(value instanceof Date)) throw new Error('Expected native pg timestamp Date')
  return value.toISOString()
}

suite('application PostgreSQL UTC contract', () => {
  let admin: Knex
  let directory: string
  let roleCreated = false

  beforeAll(async () => {
    if (!connection) throw new Error('Runner-assigned disposable PostgreSQL is required')
    delete process.env.DATABASE_URL
    delete process.env.DB_SSL_CA
    directory = await mkdtemp(path.join(process.cwd(), '.utc-db-native-'))
    wiki.SERVERPATH = directory
    await mkdir(path.join(directory, 'models'))
    admin = createKnex({ client: 'pg', connection, searchPath: [schema, 'public'], pool: { min: 0, max: 2 } })
    await admin.raw('CREATE SCHEMA ??', [schema])
    // Real migration definitions, not copied type declarations.
    await baseline(admin)
    await durableJobs(admin)
    await mentions(admin)
    const defaults = await admin.raw("SELECT setting, reset_val, source FROM pg_settings WHERE name = 'TimeZone'")
    console.info('Disposable PostgreSQL initial TimeZone default:', defaults.rows[0])
  })

  afterAll(async () => {
    try {
      await database.unsubscribeToNotifications()
      await database.knex?.destroy()
    } finally {
      try {
        if (admin) {
          try {
            if (connection) await admin.raw('ALTER DATABASE ?? RESET timezone', [connection.database])
            await admin.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [schema])
            if (roleCreated) {
              await admin.raw('DROP OWNED BY ??', [role])
              await admin.raw('DROP ROLE ??', [role])
            }
          } finally { await admin.destroy() }
        }
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true })
        if (originalUrl === undefined) delete process.env.DATABASE_URL
        else process.env.DATABASE_URL = originalUrl
        if (originalCa === undefined) delete process.env.DB_SSL_CA
        else process.env.DB_SSL_CA = originalCa
      }
    }
  })

  it('catalogs real varchar, timestamptz and zoneless columns and preserves their distinct semantics', async () => {
    const catalog = await admin.raw(`SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = ? AND ((table_name = 'userKeys' AND column_name = 'validUntil')
      OR (table_name = 'durableJobs' AND column_name = 'leaseExpiresAt')
      OR (table_name = 'userHandleClaims' AND column_name = 'createdAt')) ORDER BY table_name`, [schema])
    expect(catalog.rows).toEqual([
      { table_name: 'durableJobs', column_name: 'leaseExpiresAt', data_type: 'timestamp with time zone' },
      { table_name: 'userHandleClaims', column_name: 'createdAt', data_type: 'timestamp without time zone' },
      { table_name: 'userKeys', column_name: 'validUntil', data_type: 'character varying' }
    ])
    const instant = new Date('2026-03-08T09:59:59.123Z')
    for (const timezone of ['UTC', 'America/New_York']) {
      await admin.transaction(async trx => {
        await trx.raw("SELECT set_config('TimeZone', ?, true)", [timezone])
        const id = randomUUID()
        await trx('durableJobs').insert({ id, type: 'utc-probe', payload: '{}', nextRunAt: instant.toISOString(),
          leaseExpiresAt: instant, createdAt: trx.fn.now(), updatedAt: trx.fn.now() })
        await trx('userKeys').insert({ kind: 'utc-probe', token: id, createdAt: instant.toISOString(), validUntil: instant.toISOString() })
        await trx('userHandleClaims').insert({ handle: `h_${id.replaceAll('-', '').slice(0, 20)}` })
        const result = await trx.raw(`SELECT j."leaseExpiresAt", j."nextRunAt", j."createdAt", k."validUntil",
          j."createdAt" = now() AS default_equal,
          j."leaseExpiresAt" <= ?::timestamptz AS expired_equal,
          j."leaseExpiresAt" > ?::timestamptz AS live_equal,
          j."leaseExpiresAt" > ?::timestamptz - interval '1 millisecond' AS live_before,
          j."leaseExpiresAt" <= ?::timestamptz + interval '1 millisecond' AS expired_after,
          k."validUntil"::timestamptz = j."leaseExpiresAt" AS iso_equal
          FROM "durableJobs" j JOIN "userKeys" k ON k.token = j.id::text WHERE j.id = ?`,
          [instant, instant, instant, instant, id])
        const row = result.rows[0]
        expect(asIso(row.leaseExpiresAt)).toBe(instant.toISOString())
        expect(asIso(row.nextRunAt)).toBe(instant.toISOString())
        expect(row.validUntil).toBe(instant.toISOString())
        expect(row).toMatchObject({ default_equal: true, expired_equal: true, live_equal: false, live_before: true, expired_after: true, iso_equal: true })
        const wall = await trx.raw(`SELECT "createdAt", "createdAt"::text AS wall,
          "createdAt" = now() AT TIME ZONE current_setting('TimeZone') AS default_equal FROM "userHandleClaims"
          WHERE handle = ?`, [`h_${id.replaceAll('-', '').slice(0, 20)}`])
        expect(wall.rows[0].default_equal).toBe(true)
        const local = wall.rows[0].createdAt
        expect(local).toBeInstanceOf(Date)
        // OID 1114 is a local wall-time Date, not evidence of a stored instant.
        expect(local.valueOf()).toBe(new Date(wall.rows[0].wall.replace(' ', 'T')).valueOf())
        expect(result.fields.find((field: { name: string }) => field.name === 'leaseExpiresAt').dataTypeID).toBe(1184)
        expect(wall.fields.find((field: { name: string }) => field.name === 'createdAt').dataTypeID).toBe(1114)
        await trx('userHandleClaims').insert([
          { handle: `js_${id.replaceAll('-', '').slice(0, 20)}`, createdAt: instant },
          { handle: `iso_${id.replaceAll('-', '').slice(0, 20)}`, createdAt: instant.toISOString() }
        ])
        const explicitWall = await trx.raw(`SELECT handle, to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS wall
          FROM "userHandleClaims" WHERE handle IN (?, ?) ORDER BY handle`,
          [`js_${id.replaceAll('-', '').slice(0, 20)}`, `iso_${id.replaceAll('-', '').slice(0, 20)}`])
        const pad = (value: number): string => String(value).padStart(2, '0')
        const jsWall = `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}T${pad(instant.getHours())}:${pad(instant.getMinutes())}:${pad(instant.getSeconds())}.123`
        expect(explicitWall.rows.map((row: { wall: string }) => row.wall)).toEqual([instant.toISOString().slice(0, -1), jsWall])
      })
    }
    // A historical zoneless wall value stays byte-for-byte wall text after UTC cutover.
    await admin('userHandleClaims').insert({ handle: 'historical_wall', createdAt: '2020-11-01 01:30:00' })
    const initialized = await database.init()
    try {
      const historical = await initialized.knex.raw(`SELECT "createdAt"::text AS wall FROM "userHandleClaims" WHERE handle = 'historical_wall'`)
      expect(historical.rows[0].wall).toBe('2020-11-01 01:30:00')
      await initialized.knex.transaction(async trx => {
        await trx('userHandleClaims').insert({ handle: 'utc_future_default' })
        const future = await trx.raw(`SELECT "createdAt" = now() AT TIME ZONE 'UTC' AS utc_wall
          FROM "userHandleClaims" WHERE handle = 'utc_future_default'`)
        expect(future.rows[0].utc_wall).toBe(true)
      })
    } finally { await initialized.knex.destroy() }
  })

  it('overrides UTC and non-UTC database and disposable-role defaults on fresh, reacquired and replacement worker/pool connections', async () => {
    if (!connection) throw new Error('Missing assigned database')
    // Requires CREATEROLE on the disposable native service, never the application role.
    await admin.raw(`CREATE ROLE ?? LOGIN PASSWORD '${rolePassword}'`, [role])
    roleCreated = true
    await admin.raw('GRANT USAGE ON SCHEMA ?? TO ??', [schema, role])
    for (const databaseZone of ['UTC', 'America/New_York']) {
      await admin.raw(`ALTER DATABASE ?? SET timezone TO '${databaseZone}'`, [connection.database])
      for (const roleZone of [null, 'UTC', 'Asia/Tokyo']) {
        if (roleZone) await admin.raw(`ALTER ROLE ?? SET timezone TO '${roleZone}'`, [role])
        else await admin.raw('ALTER ROLE ?? RESET timezone', [role])
        const control = createKnex({ client: 'pg', connection: { ...connection, user: role, password: rolePassword }, pool: { min: 0, max: 1 } })
        try {
          const observed = await control.raw("SELECT current_setting('TimeZone') AS timezone")
          expect(observed.rows[0].timezone).toBe(roleZone ?? databaseZone)
        } finally { await control.destroy() }
        wiki.config.db.user = role
        wiki.config.db.pass = rolePassword
        for (const applicationRole of ['pool', 'worker']) {
          wiki.CONNECTION_ROLE = applicationRole
          const initialized = await database.init()
          try {
            for (let acquisition = 0; acquisition < 2; acquisition += 1) {
              const observed = await initialized.knex.raw(settingsSql)
              expect(observed.rows[0]).toMatchObject({ timezone: 'UTC', path: `${schema}, public`, application: expect.stringMatching(new RegExp(`/${applicationRole}$`)) })
            }
            const old = await initialized.knex.client.acquireConnection()
            const previous = (await old.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
            try {
              await initialized.knex.client.destroyRawConnection(old)
            } finally { await initialized.knex.client.releaseConnection(old) }
            const replacement = (await initialized.knex.raw(settingsSql)).rows[0]
            expect(replacement).toMatchObject({ timezone: 'UTC', path: `${schema}, public`, application: expect.stringMatching(new RegExp(`/${applicationRole}$`)) })
            expect(replacement.pid).not.toBe(previous)
          } finally { await initialized.knex.destroy() }
        }
      }
    }
    wiki.config.db.user = connection.user
    wiki.config.db.pass = connection.password
  }, 60_000)

  it('retains URL options, listener identity, UTC and notification delivery after a real backend reconnect', async () => {
    if (!connection) throw new Error('Missing assigned database')
    wiki.config.db.user = connection.user
    wiki.config.db.pass = connection.password
    wiki.CONNECTION_ROLE = 'pool'
    const url = new URL(`postgresql://${connection.host}:${connection.port}/${connection.database}`)
    url.username = connection.user
    url.password = connection.password
    url.searchParams.set('application_name', 'uri-must-not-replace-app-identity')
    url.searchParams.set('options', `-c timezone=Pacific/Honolulu -c statement_timeout=7000 -c search_path=${schema},public`)
    process.env.DATABASE_URL = url.href
    const initialized = await database.init()
    try {
      expect((await initialized.knex.raw(settingsSql)).rows[0]).toMatchObject({ timezone: 'UTC', path: `${schema}, public`, timeout: '7s', application: expect.stringMatching(/\/pool$/) })
      await bounded(database.subscribeToNotifications())
      for (let generation = 0; generation < 2; generation += 1) {
        const transport = await bounded(listenerConnection())
        const observed = (await bounded(transport.query(settingsSql))).rows[0]
        expect(observed).toMatchObject({ timezone: 'UTC', timeout: '7s', application: expect.stringMatching(/\/listener$/) })
        // PostgreSQL retains the URL's search_path bytes for this dedicated connection.
        expect(String(observed.path).replaceAll(' ', '')).toBe(`${schema},public`)
        const value = randomUUID()
        await admin.raw('SELECT pg_notify(?, ?)', ['wiki', JSON.stringify({ event: 'utc.native', source: 'other-instance', value })])
        await vi.waitFor(() => expect(wiki.events.inbound.emit).toHaveBeenCalledWith('utc.native', value), { timeout: 10_000 })
        if (generation === 0) {
          const disconnected = Promise.withResolvers<void>()
          const emitter = transport as unknown as { once(event: string, callback: () => void): void }
          emitter.once('error', () => disconnected.resolve())
          await admin.raw('SELECT pg_terminate_backend(?)', [observed.pid])
          await bounded(disconnected.promise)
        }
      }
    } finally {
      await bounded(database.unsubscribeToNotifications())
      expect(database.listener).toBeNull()
      expect(wiki.events.outbound.offAny).toHaveBeenCalled()
      await initialized.knex.destroy()
      delete process.env.DATABASE_URL
    }
  }, 45_000)
})
