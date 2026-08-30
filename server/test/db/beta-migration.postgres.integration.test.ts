import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import knexModule from 'knex'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  databaseName.endsWith('_beta_migration_test') && password
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? 'wiki-postgres',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        password,
        database: databaseName
      }
    : null
const directlyInvoked =
  process.env.npm_lifecycle_event !== 'test' &&
  process.argv.some(argument => argument.replaceAll('\\', '/').endsWith('beta-migration.postgres.integration.test.ts'))
const databaseContractRequired = directlyInvoked || process.env.WIKI_TEST_POSTGRES_REQUIRED === '1'

if (databaseContractRequired && !connection) {
  throw new Error('Explicit beta-migration PostgreSQL execution requires WIKI_TEST_POSTGRES_DATABASE ending in _beta_migration_test and a PostgreSQL password.')
}

const wikiDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WIKI')
Object.defineProperty(globalThis, 'WIKI', {
  configurable: true,
  writable: true,
  value: { SERVERPATH: fileURLToPath(new URL('../../', import.meta.url)) }
})
// The beta module captures WIKI during module initialization, so the test must install the global before loading it.
const { getLegacyMigrationNames, migrate } = await import('../../db/beta/index.ts')
if (wikiDescriptor) {
  Object.defineProperty(globalThis, 'WIKI', wikiDescriptor)
} else {
  Reflect.deleteProperty(globalThis, 'WIKI')
}

interface QueryEvent {
  sql: string
}

const dropLegacySchema = async (db: Knex): Promise<void> => {
  await db.schema.dropTableIfExists('pageTree')
  await db.schema.dropTableIfExists('pageHistory')
  await db.schema.dropTableIfExists('pages')
  await db.schema.dropTableIfExists('users')
  await db.schema.dropTableIfExists('locales')
  await db.schema.dropTableIfExists('migrations_lock')
  await db.schema.dropTableIfExists('migrations')
}

const createLegacySchema = async (db: Knex, migrationNames: string[]): Promise<void> => {
  await db.schema.createTable('migrations', table => {
    table.increments('id').primary()
    table.string('name').notNullable()
    table.integer('batch').notNullable()
    table.timestamp('migration_time').notNullable()
  })
  await db('migrations').insert(
    migrationNames.map((name, index) => ({
      name,
      batch: 1,
      migration_time: new Date(Date.UTC(2026, 0, 1, 0, index))
    }))
  )

  await db.schema.createTable('locales', table => {
    table.string('code', 2).notNullable().primary()
    table.json('strings')
    table.boolean('isRTL').notNullable().defaultTo(false)
    table.string('name').notNullable()
    table.string('nativeName').notNullable()
    table.integer('availability').notNullable().defaultTo(0)
    table.string('createdAt').notNullable()
    table.string('updatedAt').notNullable()
  })
  await db('locales').insert({
    code: 'en',
    strings: { greeting: 'Hello' },
    isRTL: false,
    name: 'English',
    nativeName: 'English',
    availability: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  })

  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.string('localeCode', 2).notNullable().defaultTo('en').references('code').inTable('locales')
  })
  await db.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.string('localeCode', 2).references('code').inTable('locales')
  })
  await db.schema.createTable('pageHistory', table => {
    table.integer('id').primary()
    table.string('localeCode', 2).references('code').inTable('locales')
  })
  await db.schema.createTable('pageTree', table => {
    table.integer('id').primary()
    table.string('localeCode', 2).references('code').inTable('locales')
  })
  await db('users').insert({ id: 1, localeCode: 'en' })
  await db('pages').insert({ id: 1, localeCode: 'en' })
  await db('pageHistory').insert({ id: 1, localeCode: 'en' })
  await db('pageTree').insert({ id: 1, localeCode: 'en' })
}

const suite = connection ? describe : describe.skip

suite('PostgreSQL beta migration atomicity', () => {
  let db: Knex
  let migrationNames: string[]

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection })
    migrationNames = await getLegacyMigrationNames()
  })

  beforeEach(async () => {
    await dropLegacySchema(db)
    await createLegacySchema(db, migrationNames)
  })

  afterAll(async () => {
    await dropLegacySchema(db)
    await db.destroy()
  })

  it('rolls back every locale schema and data operation when execution fails after dropping locales', async () => {
    let failureInjected = false
    const failAfterLocaleDrop = (_response: unknown, query: QueryEvent): void => {
      if (!/^drop table "locales"/i.test(query.sql)) return
      failureInjected = true
      db.off('query-response', failAfterLocaleDrop)
      throw new Error('injected failure after locale drop')
    }
    db.on('query-response', failAfterLocaleDrop)

    try {
      await expect(Promise.resolve(migrate(db))).rejects.toThrow('injected failure after locale drop')
    } finally {
      db.off('query-response', failAfterLocaleDrop)
    }

    expect(failureInjected).toBe(true)
    expect((await db('locales').columnInfo('code')).maxLength).toBe(2)
    for (const tableName of ['users', 'pages', 'pageHistory', 'pageTree']) {
      expect((await db(tableName).columnInfo('localeCode')).maxLength).toBe(2)
      expect(await db(tableName).where({ id: 1, localeCode: 'en' }).first()).toBeTruthy()
    }
    expect(await db('locales').where({ code: 'en' }).first()).toMatchObject({
      code: 'en',
      strings: { greeting: 'Hello' },
      availability: 100
    })
    await expect(Promise.resolve(db('users').insert({ id: 2, localeCode: 'fr' }))).rejects.toMatchObject({ code: '23503' })
    expect((await db('migrations').orderBy('id')).map(row => row.name)).toEqual(migrationNames)
  })

  it('preserves the historical ledger when replacement fails after truncate and succeeds on retry', async () => {
    expect(migrationNames).not.toContain('2.0.0.js')
    const originalLedger = await db('migrations').select('id', 'name', 'batch', 'migration_time').orderBy('id')
    let failureInjected = false
    const failAfterLedgerTruncate = (_response: unknown, query: QueryEvent): void => {
      if (!/^truncate "migrations"/i.test(query.sql)) return
      failureInjected = true
      db.off('query-response', failAfterLedgerTruncate)
      throw new Error('injected failure after migration ledger truncate')
    }
    db.on('query-response', failAfterLedgerTruncate)

    try {
      await expect(Promise.resolve(migrate(db))).rejects.toThrow('injected failure after migration ledger truncate')
    } finally {
      db.off('query-response', failAfterLedgerTruncate)
    }

    expect(failureInjected).toBe(true)
    expect(await db('migrations').select('id', 'name', 'batch', 'migration_time').orderBy('id')).toEqual(originalLedger)
    expect((await db('pages').columnInfo('localeCode')).maxLength).toBe(5)

    await migrate(db)

    expect(await db('migrations').select('id', 'name', 'batch').orderBy('id')).toEqual([{ id: 1, name: '2.0.0.js', batch: 1 }])
    expect(await db('locales').where({ code: 'en' }).first()).toMatchObject({
      code: 'en',
      strings: { greeting: 'Hello' },
      availability: 100
    })
  })
})
