import knexModule, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as migratePrivatePages } from '../../db/migrations-sqlite/2.5.129.ts'

const createLegacySchema = async (db: Knex): Promise<void> => {
  await db.raw('PRAGMA foreign_keys = ON')
  await db.schema.createTable('users', table => {
    table.integer('id').primary()
  })
  await db.schema.createTable('pages', table => {
    table.increments('id').primary()
    table.string('localeCode').notNullable()
    table.string('path').notNullable()
    table.boolean('isPrivate').notNullable().defaultTo(false)
    table.string('privateNS').nullable()
  })
  await db.schema.createTable('pageHistory', table => {
    table.integer('id').primary()
    table.integer('pageId').nullable()
    table.boolean('isPrivate').notNullable().defaultTo(false)
  })
  await db.schema.createTable('pageTree', table => {
    table.integer('id').primary()
    table.string('localeCode').notNullable()
    table.string('path').notNullable()
    table.integer('pageId').nullable()
    table.boolean('isPrivate').notNullable().defaultTo(false)
    table.string('privateNS').nullable()
  })
  await db('users').insert([{ id: 7 }, { id: 8 }])
}

describe('SQLite private-page schema migration', () => {
  let db: Knex

  beforeEach(async () => {
    db = knexModule({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createLegacySchema(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('preserves public rows and enforces owner-scoped identities and visibility invariants', async () => {
    await db('pages').insert({ id: 1, localeCode: 'en', path: 'same/path', isPrivate: false })
    await migratePrivatePages(db)

    const columns = await db.raw<Array<{ name: string }>>('PRAGMA table_info("pages")')
    expect(columns.map(column => column.name)).toContain('visibility')
    expect(columns.map(column => column.name)).toContain('ownerId')
    expect(columns.map(column => column.name)).not.toContain('isPrivate')
    expect(await db('pages').where({ id: 1 }).first()).toMatchObject({ visibility: 'public', ownerId: null })

    await db('pages').insert({ id: 2, localeCode: 'en', path: 'same/path', visibility: 'private', ownerId: 7 })
    await db('pages').insert({ id: 3, localeCode: 'en', path: 'same/path', visibility: 'private', ownerId: 8 })
    await expect(db('pages').insert({ id: 4, localeCode: 'en', path: 'same/path', visibility: 'public', ownerId: null })).rejects.toThrow()
    await expect(db('pages').insert({ id: 5, localeCode: 'en', path: 'same/path', visibility: 'private', ownerId: 7 })).rejects.toThrow()
    await expect(db('pages').insert({ id: 6, localeCode: 'en', path: 'bad-public', visibility: 'public', ownerId: 7 })).rejects.toThrow()
    await expect(db('pages').insert({ id: 7, localeCode: 'en', path: 'bad-private', visibility: 'private', ownerId: null })).rejects.toThrow()
    await expect(db('pages').insert({ id: 8, localeCode: 'en', path: 'orphan', visibility: 'private', ownerId: 999 })).rejects.toThrow()
  })

  it('fails without altering the schema when legacy private ownership cannot be mapped', async () => {
    await db('pages').insert({ id: 1, localeCode: 'en', path: 'legacy-secret', isPrivate: true, privateNS: 'unknown' })

    await expect(migratePrivatePages(db)).rejects.toThrow('owner identity is unavailable')

    const columns = await db.raw<Array<{ name: string }>>('PRAGMA table_info("pages")')
    expect(columns.map(column => column.name)).toContain('isPrivate')
    expect(columns.map(column => column.name)).not.toContain('visibility')
  })
})
