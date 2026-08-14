import knexModule, { type Knex } from 'knex'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { up as migratePrivatePages } from '../../db/migrations/2.5.129.ts'

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const connection = passwordFile
  ? {
      host: process.env.WIKI_TEST_POSTGRES_HOST ?? 'wiki-postgres',
      port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
      user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
      password: fs.readFileSync(passwordFile, 'utf8').trim(),
      database: databaseName
    }
  : null
const enabled = Boolean(connection && databaseName.endsWith('_private_pages_test'))

const suite = enabled ? describe : describe.skip

suite('PostgreSQL private-page schema migration', () => {
  let db: Knex

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection })
    await db.schema.dropTableIfExists('pageTree')
    await db.schema.dropTableIfExists('pageHistory')
    await db.schema.dropTableIfExists('pages')
    await db.schema.dropTableIfExists('users')

    await db.schema.createTable('users', table => {
      table.integer('id').primary()
    })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('localeCode').notNullable()
      table.string('path').notNullable()
      table.boolean('isPrivate').notNullable().defaultTo(false)
      table.string('privateNS').nullable()
      table.unique(['localeCode', 'path'])
    })
    await db.schema.createTable('pageHistory', table => {
      table.integer('id').primary()
      table.integer('pageId').nullable()
      table.boolean('isPrivate').notNullable().defaultTo(false)
      table.string('privateNS').nullable()
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
    await db('pages').insert({ id: 1, localeCode: 'en', path: 'same/path', isPrivate: false })
    await migratePrivatePages(db)
  })

  afterAll(async () => {
    if (!db) return
    await db.schema.dropTableIfExists('pageTree')
    await db.schema.dropTableIfExists('pageHistory')
    await db.schema.dropTableIfExists('pages')
    await db.schema.dropTableIfExists('users')
    await db.destroy()
  })

  it('enforces visibility, ownership, foreign keys, and namespace-specific identity', async () => {
    const columns = await db('information_schema.columns')
      .select('column_name')
      .where({ table_schema: 'public', table_name: 'pages' })
    const names = columns.map(column => column.column_name)
    expect(names).toContain('visibility')
    expect(names).toContain('ownerId')
    expect(names).not.toContain('isPrivate')
    expect(names).not.toContain('privateNS')

    await db('pages').insert({ id: 2, localeCode: 'en', path: 'same/path', visibility: 'private', ownerId: 7 })
    await db('pages').insert({ id: 3, localeCode: 'en', path: 'same/path', visibility: 'private', ownerId: 8 })

    await expect(db('pages').insert({ id: 4, localeCode: 'en', path: 'same/path', visibility: 'public', ownerId: null }))
      .rejects.toMatchObject({ code: '23505' })
    await expect(db('pages').insert({ id: 5, localeCode: 'en', path: 'same/path', visibility: 'private', ownerId: 7 }))
      .rejects.toMatchObject({ code: '23505' })
    await expect(db('pages').insert({ id: 6, localeCode: 'en', path: 'bad-public', visibility: 'public', ownerId: 7 }))
      .rejects.toMatchObject({ code: '23514' })
    await expect(db('pages').insert({ id: 7, localeCode: 'en', path: 'bad-private', visibility: 'private', ownerId: null }))
      .rejects.toMatchObject({ code: '23514' })
    await expect(db('pages').insert({ id: 8, localeCode: 'en', path: 'orphan', visibility: 'private', ownerId: 999 }))
      .rejects.toMatchObject({ code: '23503' })

    await expect(db('users').where({ id: 7 }).delete()).rejects.toMatchObject({ code: '23503' })
    expect(await db('pages').where({ localeCode: 'en', path: 'same/path' }).count<{ count: string }[]>({ count: '*' }).first())
      .toEqual({ count: '3' })
  })
})
