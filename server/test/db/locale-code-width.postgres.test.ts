import knexModule, { type Knex } from 'knex'
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from '../bun-test.mts'
import { up, down } from '../../db/migrations/tsepistle-000021-locale-code-width.ts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_locale_test', import.meta.path)
const suite = connection ? describe : describe.skip
const references = ['pages', 'pageHistory', 'pageLinks', 'pageTree', 'users', 'pageWatchNotifications']
suite('PostgreSQL upgrade from legacy language-code widths', () => {
  let db: Knex
  beforeAll(() => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
  })
  beforeEach(async () => {
    await db.schema.createTable('locales', t => {
      t.string('code', 5).primary()
    })
    for (const table of references) {
      await db.schema.createTable(table, t => {
        t.increments('id').primary()
        t.string('localeCode', table === 'pageWatchNotifications' ? 32 : 5)
          .notNullable()
          .defaultTo('en')
          .references('code')
          .inTable('locales')
        t.string('path').notNullable().defaultTo('home')
        t.unique(['localeCode', 'path'])
      })
    }
    await db('locales').insert({ code: 'en' })
    for (const table of references) await db(table).insert({ localeCode: 'en' })
  })
  afterEach(async () => {
    for (const table of references.toReversed()) await db.schema.dropTableIfExists(table)
    await db.schema.dropTableIfExists('locales')
  })
  afterAll(async () => {
    if (db) await db.destroy()
  })
  it('upgrades existing data without losing foreign keys, identity indexes, defaults or nullability', async () => {
    await expect(Promise.resolve(db('locales').insert({ code: 'sr-latn' }))).rejects.toMatchObject({ code: '22001' })
    await up(db)
    await db('locales').insert({ code: 'sr-latn' })
    for (const table of references) {
      await db(table).insert({ localeCode: 'sr-latn' })
      expect(await db(table).orderBy('id').pluck('localeCode')).toEqual(['en', 'sr-latn'])
      await expect(Promise.resolve(db(table).insert({ localeCode: 'sr-latn' }))).rejects.toMatchObject({ code: '23505' })
      await expect(Promise.resolve(db(table).insert({ localeCode: 'missing' }))).rejects.toMatchObject({ code: '23503' })
      await expect(Promise.resolve(db(table).insert({ localeCode: null }))).rejects.toMatchObject({ code: '23502' })
      await db(table).insert({ path: 'default-language' })
      expect((await db(table).where('path', 'default-language').first()).localeCode).toBe('en')
    }
    await expect(down(db)).rejects.toThrow('language codes in use')
    expect(
      (await db('information_schema.columns').where({ table_schema: 'public', table_name: 'locales', column_name: 'code' }).first()).character_maximum_length
    ).toBe(35)
    expect(await db('locales').orderBy('code').pluck('code')).toEqual(['en', 'sr-latn'])
  })
  it('allows a lossless rollback only while all codes still fit their original columns', async () => {
    await up(db)
    await down(db)
    expect(await db('locales').pluck('code')).toEqual(['en'])
    for (const table of references) expect(await db(table).pluck('localeCode')).toEqual(['en'])
    await expect(Promise.resolve(db('locales').insert({ code: 'sr-latn' }))).rejects.toMatchObject({ code: '22001' })
    expect(
      (await db('information_schema.columns').where({ table_schema: 'public', table_name: 'pageWatchNotifications', column_name: 'localeCode' }).first())
        .character_maximum_length
    ).toBe(32)
  })
})
