import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from '../bun-test.mts'

const wiki = {
  INSTANCE_ID: 'utc-unit', CONNECTION_ROLE: 'pool', IS_DEBUG: false, IS_MASTER: false,
  ROOTPATH: process.cwd(), SERVERPATH: '',
  config: {
    db: { host: 'configured.example.test', user: 'configured', pass: 'configured-secret', db: 'configured', port: 5432,
      ssl: false, sslOptions: {}, schema: 'utc_contract', type: 'postgres' },
    ha: false, pool: { min: 0, max: 3 }
  },
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}
Reflect.set(globalThis, 'WIKI', wiki)
// db.ts captures WIKI at module evaluation; static import would precede this fixture.
const { default: database } = await import('../../core/db.ts')
const originalUrl = process.env.DATABASE_URL
const originalCa = process.env.DB_SSL_CA
let directory: string

beforeAll(async () => {
  directory = await mkdtemp(path.join(process.cwd(), '.utc-db-unit-'))
  wiki.SERVERPATH = directory
  await mkdir(path.join(directory, 'models'))
})
afterEach(async () => {
  await database.knex?.destroy()
  if (originalUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = originalUrl
  if (originalCa === undefined) delete process.env.DB_SSL_CA
  else process.env.DB_SSL_CA = originalCa
  wiki.CONNECTION_ROLE = 'pool'
})
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

describe('application PostgreSQL session initialization', () => {
  for (const role of ['pool', 'worker']) {
    it(`initializes UTC, ${role} identity and schema before admitting each connection`, async () => {
      delete process.env.DATABASE_URL
      delete process.env.DB_SSL_CA
      wiki.CONNECTION_ROLE = role
      const initialized = await database.init()
      await initialized.onReady
      const pool = initialized.knex.client.config.pool
      expect(pool?.min).toBe(0)
      expect(pool?.max).toBe(3)
      if (!pool?.afterCreate) throw new Error('Application pool must initialize new connections')
      for (let index = 0; index < 2; index += 1) {
        const statements: unknown[] = []
        const gate = Promise.withResolvers<void>()
        const query = vi.fn(async (statement: unknown) => {
          statements.push(statement)
          if (statements.length === 1) await gate.promise
        })
        const done = vi.fn()
        pool.afterCreate({ query }, done)
        expect(done).not.toHaveBeenCalled()
        expect(statements[0]).toMatchObject({
          text: expect.stringContaining("set_config('TimeZone', 'UTC', false)"),
          values: [expect.stringMatching(new RegExp(`/` + role + `$`))]
        })
        gate.resolve()
        await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
        expect(statements[1]).toBe('set search_path TO utc_contract, public;')
        expect(done).toHaveBeenCalledWith()
      }
    })
  }

  it('retains DATABASE_URL precedence and inline SSL handling without connecting', async () => {
    process.env.DATABASE_URL = 'postgres://url-user:url-secret@url.example.test:5433/url-db?sslmode=require&options=-c%20statement_timeout%3D7000'
    process.env.DB_SSL_CA = 'SYNTHETIC_CA'
    const initialized = await database.init()
    expect(initialized.knex.client.connectionSettings).toMatchObject({
      host: 'url.example.test', user: 'url-user', database: 'url-db', port: '5433',
      options: '-c statement_timeout=7000'
    })
    // The existing URL branch owns SSL; DB_SSL_CA must not replace URI settings.
    expect(Reflect.get(initialized.knex.client.connectionSettings, 'ssl')).not.toHaveProperty('ca')
  })

  it('preserves configured certificate verification for the field-based connection', async () => {
    delete process.env.DATABASE_URL
    delete process.env.DB_SSL_CA
    wiki.config.db.ssl = true
    wiki.config.db.sslOptions = { auto: false, ca: '-----BEGIN CERTIFICATE-----\\nSYNTHETIC\\n-----END CERTIFICATE-----' }
    try {
      const initialized = await database.init()
      expect(initialized.knex.client.connectionSettings).toMatchObject({
        host: 'configured.example.test', user: 'configured', password: 'configured-secret',
        ssl: { rejectUnauthorized: true, ca: expect.stringContaining('SYNTHETIC') }
      })
    } finally {
      wiki.config.db.ssl = false
      wiki.config.db.sslOptions = {}
    }
  })

  for (const failureAt of [1, 2]) {
    it(`propagates initialization failure at statement ${failureAt} exactly once`, async () => {
      delete process.env.DATABASE_URL
      const initialized = await database.init()
      const afterCreate = initialized.knex.client.config.pool?.afterCreate
      if (!afterCreate) throw new Error('Missing connection initializer')
      const failure = new Error('session initialization denied')
      let count = 0
      const query = vi.fn(async () => { if (++count === failureAt) throw failure })
      const done = vi.fn()
      afterCreate({ query }, done)
      await vi.waitFor(() => expect(done).toHaveBeenCalledOnce())
      expect(done).toHaveBeenCalledWith(failure)
      expect(query).toHaveBeenCalledTimes(failureAt)
    })
  }
})
