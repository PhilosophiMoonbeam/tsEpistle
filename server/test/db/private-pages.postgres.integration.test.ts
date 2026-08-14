import knexModule, { type Knex } from 'knex'
import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { scopePageQuery } from '../../helpers/page-access.ts'

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
    await db.schema.dropTableIfExists('pageLinks')
    await db.schema.dropTableIfExists('pageTags')
    await db.schema.dropTableIfExists('tags')
    await db.schema.dropTableIfExists('pageTree')
    await db.schema.dropTableIfExists('pageHistory')
    await db.schema.dropTableIfExists('pages')
    await db.schema.dropTableIfExists('users')

    await db.schema.createTable('users', table => {
      table.integer('id').primary()
    })
    await db.schema.createTable('pages', table => {
      table.increments('id').primary()
      table.string('localeCode').notNullable()
      table.string('path').notNullable()
      table.string('title').notNullable().defaultTo('')
      table.text('content').notNullable().defaultTo('')
      table.timestamp('updatedAt').notNullable().defaultTo(db.fn.now())
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
    await db('pages').insert({ id: 1, localeCode: 'en', path: 'same/path', isPrivate: false })
    await migratePrivatePages(db)
    await db('pages').insert([
      { id: 2, localeCode: 'en', path: 'same/path', title: 'Owner Seven Secret', content: 'private seven', visibility: 'private', ownerId: 7 },
      { id: 3, localeCode: 'en', path: 'same/path', title: 'Owner Eight Secret', content: 'private eight', visibility: 'private', ownerId: 8 }
    ])
    await db('pageHistory').insert([
      { id: 1, pageId: 1, visibility: 'public', ownerId: null },
      { id: 2, pageId: 2, visibility: 'private', ownerId: 7 },
      { id: 3, pageId: 3, visibility: 'private', ownerId: 8 }
    ])
    await db('pageTree').insert([
      { id: 1, pageId: 1, localeCode: 'en', path: 'same/path', visibility: 'public', ownerId: null },
      { id: 2, pageId: 2, localeCode: 'en', path: 'same/path', visibility: 'private', ownerId: 7 },
      { id: 3, pageId: 3, localeCode: 'en', path: 'same/path', visibility: 'private', ownerId: 8 }
    ])
    await db.schema.createTable('tags', table => {
      table.increments('id').primary()
      table.string('tag').notNullable().unique()
    })
    await db.schema.createTable('pageTags', table => {
      table.integer('pageId').notNullable().references('id').inTable('pages').onDelete('CASCADE')
      table.integer('tagId').notNullable().references('id').inTable('tags').onDelete('CASCADE')
    })
    await db.schema.createTable('pageLinks', table => {
      table.increments('id').primary()
      table.integer('pageId').notNullable().references('id').inTable('pages').onDelete('CASCADE')
      table.string('path').notNullable()
      table.string('localeCode').notNullable()
    })
    await db('tags').insert([{ id: 1, tag: 'public-tag' }, { id: 2, tag: 'owner-seven-tag' }, { id: 3, tag: 'owner-eight-tag' }])
    await db('pageTags').insert([{ pageId: 1, tagId: 1 }, { pageId: 2, tagId: 2 }, { pageId: 3, tagId: 3 }])
    await db('pageLinks').insert([
      { pageId: 1, path: 'public-target', localeCode: 'en' },
      { pageId: 2, path: 'owner-seven-target', localeCode: 'en' },
      { pageId: 3, path: 'owner-eight-target', localeCode: 'en' }
    ])
  })

  afterAll(async () => {
    if (!db) return
    await db.schema.dropTableIfExists('pageLinks')
    await db.schema.dropTableIfExists('pageTags')
    await db.schema.dropTableIfExists('tags')
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

  it('enforces owner-scoped query visibility across page, history, tree, tag, link, and search domains', async () => {
    const originalWiki = globalThis.WIKI
    globalThis.WIKI = {
      auth: {
        checkAccess: (user: Express.User | undefined, permissions: readonly string[]) =>
          permissions.some(permission => user?.permissions?.includes(permission))
      }
    } as typeof globalThis.WIKI
    try {
      const owner = { id: 7, permissions: ['read:pages'] } as Express.User
      const other = { id: 8, permissions: ['read:pages'] } as Express.User
      const guest = { id: 2, permissions: ['read:pages'] } as Express.User
      const manager = { id: 1, permissions: ['manage:system'] } as Express.User

      const visiblePages = async (user: Express.User) => {
        const query = db('pages').select('id', 'visibility', 'ownerId').orderBy('id')
        scopePageQuery(query, user)
        return query
      }
      expect((await visiblePages(owner)).map(page => page.id)).toEqual([1, 2])
      expect((await visiblePages(other)).map(page => page.id)).toEqual([1, 3])
      expect((await visiblePages(guest)).map(page => page.id)).toEqual([1])

      const managerQuery = db('pages').select('id').orderBy('id')
      scopePageQuery(managerQuery, manager, { includeAllForSystemManager: true })
      expect((await managerQuery).map(page => page.id)).toEqual([1, 2, 3])

      for (const table of ['pageHistory', 'pageTree']) {
        const query = db(table).select('pageId').orderBy('pageId')
        scopePageQuery(query, owner)
        expect((await query).map(row => row.pageId)).toEqual([1, 2])
      }

      const tags = db('tags')
        .join('pageTags', 'pageTags.tagId', 'tags.id')
        .join('pages', 'pages.id', 'pageTags.pageId')
        .select('tags.tag')
        .orderBy('tags.id')
      scopePageQuery(tags, owner, { table: 'pages' })
      expect((await tags).map(row => row.tag)).toEqual(['public-tag', 'owner-seven-tag'])

      const links = db('pageLinks')
        .join('pages', 'pages.id', 'pageLinks.pageId')
        .select('pageLinks.path')
        .orderBy('pageLinks.id')
      scopePageQuery(links, owner, { table: 'pages' })
      expect((await links).map(row => row.path)).toEqual(['public-target', 'owner-seven-target'])

      const search = db('pages')
        .select('id')
        .whereILike('content', '%private%')
        .orderBy('id')
      scopePageQuery(search, owner)
      expect((await search).map(row => row.id)).toEqual([2])
    } finally {
      globalThis.WIKI = originalWiki
    }
  })

  it('persists owner-scoped rows across independent PostgreSQL connections and preserves foreign keys and sequences', async () => {
    await db.raw(`SELECT setval(pg_get_serial_sequence('pages', 'id'), (SELECT max(id) FROM pages), true)`)
    const inserted = await db('pages')
      .insert({ localeCode: 'en', path: 'sequence-check', title: 'Sequence Check', content: '', visibility: 'private', ownerId: 7 })
      .returning<{ id: number }[]>('id')
    expect(inserted[0]?.id).toBe(4)

    const secondConnection = knexModule({ client: 'pg', connection })
    try {
      expect(await secondConnection('pages').where({ id: 4, visibility: 'private', ownerId: 7 }).first()).toBeTruthy()
      await expect(secondConnection('users').where({ id: 7 }).delete()).rejects.toMatchObject({ code: '23503' })
    } finally {
      await secondConnection.destroy()
    }
    await db('pages').where({ id: 4 }).delete()
  })
})
