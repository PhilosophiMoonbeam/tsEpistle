import fs from 'node:fs'
import knexModule, { type Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'

import { down, up } from '../../db/migrations/tsfranki-000003-page-link-identity.ts'

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  databaseName.endsWith('_page_link_identity_test') && password
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
  process.argv.some(argument => argument.replaceAll('\\', '/').endsWith('page-link-identity-migration.postgres.integration.test.ts'))
const databaseContractRequired = directlyInvoked || process.env.WIKI_TEST_POSTGRES_REQUIRED === '1'

if (databaseContractRequired && !connection) {
  throw new Error(
    'Explicit page-link identity PostgreSQL execution requires WIKI_TEST_POSTGRES_DATABASE ending in _page_link_identity_test and a PostgreSQL password.'
  )
}

const suite = connection ? describe : describe.skip

suite('PostgreSQL page-link identity migration', () => {
  let db: Knex

  beforeAll(() => {
    db = knexModule({ client: 'pg', connection })
  })

  beforeEach(async () => {
    await db.schema.dropTableIfExists('pageLinks')
    await db.schema.createTable('pageLinks', table => {
      table.increments('id').primary()
      table.integer('pageId').nullable()
      table.string('localeCode').notNullable()
      table.string('path').notNullable()
      table.index(['path', 'localeCode'], 'page_links_path_locale_existing')
    })
  })

  afterEach(async () => {
    await db.schema.dropTableIfExists('pageLinks')
  })

  afterAll(async () => {
    if (db) await db.destroy()
  })

  it('keeps the lowest-id exact duplicate and enforces one canonical identity', async () => {
    await db('pageLinks').insert([
      { id: 9, pageId: 42, localeCode: 'en', path: 'target' },
      { id: 3, pageId: 42, localeCode: 'en', path: 'target' },
      { id: 6, pageId: 42, localeCode: 'fr', path: 'target' },
      { id: 8, pageId: null, localeCode: 'en', path: 'orphan' },
      { id: 4, pageId: null, localeCode: 'en', path: 'orphan' }
    ])

    await up(db)

    expect(await db('pageLinks').orderBy('id').select('id', 'pageId', 'localeCode', 'path')).toEqual([
      { id: 3, pageId: 42, localeCode: 'en', path: 'target' },
      { id: 4, pageId: null, localeCode: 'en', path: 'orphan' },
      { id: 6, pageId: 42, localeCode: 'fr', path: 'target' }
    ])
    await expect(Promise.resolve(db('pageLinks').insert({ pageId: 42, localeCode: 'en', path: 'target' }))).rejects.toMatchObject({ code: '23505' })
    await expect(Promise.resolve(db('pageLinks').insert({ pageId: null, localeCode: 'en', path: 'orphan' }))).rejects.toMatchObject({ code: '23505' })
  })

  it('deduplicates concurrent conflict-safe inserts from independent connections', async () => {
    await up(db)
    const secondConnection = knexModule({ client: 'pg', connection })
    try {
      const row = { pageId: 42, localeCode: 'en', path: 'target' }
      await Promise.all([
        db('pageLinks').insert(row).onConflict(['pageId', 'localeCode', 'path']).ignore(),
        secondConnection('pageLinks').insert(row).onConflict(['pageId', 'localeCode', 'path']).ignore()
      ])

      expect(await db('pageLinks').where(row)).toHaveLength(1)
    } finally {
      await secondConnection.destroy()
    }
  })

  it('drops only the new identity index on rollback', async () => {
    await up(db)
    await down(db)

    const indexes = await db('pg_indexes').where({ schemaname: 'public', tablename: 'pageLinks' }).orderBy('indexname').pluck('indexname')
    expect(indexes).toContain('page_links_path_locale_existing')
    expect(indexes).not.toContain('page_links_page_locale_path_unique')

    const duplicate = { pageId: 42, localeCode: 'en', path: 'target' }
    await db('pageLinks').insert([duplicate, duplicate])
    expect(await db('pageLinks').where(duplicate)).toHaveLength(2)
  })
})
