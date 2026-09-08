import fs from 'node:fs'
import knexModule, { type Knex } from 'knex'
import { up as migrateTaxonomy } from '../../db/migrations/tsepistle-000015-taxonomy-lifecycle.ts'
import type PageModel from '../../models/pages.ts'
import type TagModel from '../../models/tags.ts'
import { afterAll, beforeAll, describe, expect, it, vi } from '../bun-test.mts'

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection = databaseName.endsWith('_tags_test')
  ? {
      host: process.env.WIKI_TEST_POSTGRES_HOST ?? 'wiki-postgres',
      port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
      user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
      password,
      database: databaseName
    }
  : null
const suite = connection ? describe : describe.skip
const wikiGlobal = globalThis as unknown as { WIKI?: unknown }
const originalWiki = wikiGlobal.WIKI

interface TestWiki {
  models: { tags: typeof TagModel | undefined; knex: Knex }
}

suite('PostgreSQL tag association', () => {
  let db: Knex
  let Tag: typeof TagModel
  let Page: typeof PageModel

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined })
    await db.schema.dropTableIfExists('pageTags')
    await db.schema.dropTableIfExists('tags')
    await db.schema.dropTableIfExists('pages')
    await db.schema.createTable('pages', table => {
      table.increments('id').primary()
    })
    await db.schema.createTable('tags', table => {
      table.increments('id').primary()
      table.string('tag').notNullable().unique()
      table.string('title').notNullable()
      table.timestamp('createdAt').notNullable()
      table.timestamp('updatedAt').notNullable()
    })
    await migrateTaxonomy(db)
    await db.schema.createTable('pageTags', table => {
      table.integer('pageId').notNullable().references('id').inTable('pages').onDelete('CASCADE')
      table.integer('tagId').notNullable().references('id').inTable('tags').onDelete('CASCADE')
      table.primary(['pageId', 'tagId'])
    })
    await db('pages').insert([{ id: 1 }, { id: 2 }])

    const testWiki: TestWiki = { models: { tags: undefined, knex: db } }
    wikiGlobal.WIKI = testWiki
    // Models capture the global WIKI object during evaluation, so they must load after the test installs it.
    Tag = (await vi.importFresh('../../models/tags.ts', import.meta.url)).default
    Page = (await import('../../models/pages.ts')).default
    Tag.knex(db)
    Page.knex(db)
    testWiki.models.tags = Tag
  })

  afterAll(async () => {
    if (db) {
      await db.schema.dropTableIfExists('pageTags')
      await db.schema.dropTableIfExists('tags')
      await db.schema.dropTableIfExists('pages')
      await db.destroy()
    }
    if (originalWiki === undefined) delete wikiGlobal.WIKI
    else wikiGlobal.WIKI = originalWiki
  })

  it('commits concurrent normalized tag creation and relates both pages to the canonical tag', async () => {
    const blocker = await db.transaction()
    await blocker.raw('LOCK TABLE "tags" IN SHARE MODE')

    let insertAttempts = 0
    let resolveInsertAttempts: () => void
    const bothInsertsAttempted = new Promise<void>(resolve => {
      resolveInsertAttempts = resolve
    })
    const onQuery = ({ sql }: { sql?: string }) => {
      if (sql?.toLowerCase().startsWith('insert into "tags"')) {
        insertAttempts += 1
        if (insertAttempts === 2) resolveInsertAttempts()
      }
    }
    db.on('query', onQuery)

    const associations = Promise.all([
      db.transaction(async transaction => {
        const page = await Page.query(transaction).findById(1).throwIfNotFound()
        return await Tag.associateTags({ tags: [' Shared ', 'shared'], page, transaction })
      }),
      db.transaction(async transaction => {
        const page = await Page.query(transaction).findById(2).throwIfNotFound()
        return await Tag.associateTags({ tags: ['SHARED'], page, transaction })
      })
    ])

    await bothInsertsAttempted
    db.removeListener('query', onQuery)
    await blocker.commit()

    expect(await associations).toEqual([true, true])
    const canonicalTags = await db('tags').select('id', 'tag', 'title')
    expect(canonicalTags).toHaveLength(1)
    expect(canonicalTags[0]).toMatchObject({ tag: 'shared', title: 'shared' })
    expect(await db('pageTags').select('pageId', 'tagId').orderBy('pageId')).toEqual([
      { pageId: 1, tagId: canonicalTags[0].id },
      { pageId: 2, tagId: canonicalTags[0].id }
    ])
  })
  it('resolves aliases during authoring and rejects archived names without losing current assignments', async () => {
    const now = new Date().toISOString()
    const [canonical] = await db('tags').insert({ tag: 'canonical', title: 'Canonical', createdAt: now, updatedAt: now }).returning('id')
    await db('tags').insert([
      { tag: 'old-label', title: 'Old label', redirectToId: canonical.id, createdAt: now, updatedAt: now },
      { tag: 'retired', title: 'Retired', isArchived: true, createdAt: now, updatedAt: now }
    ])
    const page = await Page.query().findById(1).throwIfNotFound()
    await Tag.associateTags({ tags: ['old-label', 'canonical'], page })
    expect(await db('pageTags').where('pageId', 1).pluck('tagId')).toEqual([canonical.id])
    await expect(Tag.associateTags({ tags: ['retired'], page })).rejects.toThrow('archived')
    expect(await db('pageTags').where('pageId', 1).pluck('tagId')).toEqual([canonical.id])
  })
  it('rejects invalid tag containers atomically and accepts exactly 100 canonical entries', async () => {
    const page = await Page.query().findById(2).throwIfNotFound()
    await Tag.associateTags({ tags: ['Keep'], page })
    const invalidInputs = [null, 'tag', ['valid', 1], [''], ['\u0000'], ['x'.repeat(256)]]
    for (const tags of invalidInputs) {
      await expect(Tag.associateTags({ tags, page })).rejects.toMatchObject({ status: 400 })
    }
    expect(await db('pageTags').where('pageId', 2)).toHaveLength(1)

    const hundred = Array.from({ length: 100 }, (_, index) => `Bounded-${index}`)
    await Tag.associateTags({ tags: hundred, page })
    expect(await db('pageTags').where('pageId', 2)).toHaveLength(100)
    await expect(
      Tag.associateTags({
        tags: [...hundred, 'one-too-many'],
        page
      })
    ).rejects.toMatchObject({ status: 400 })
    expect(await db('pageTags').where('pageId', 2)).toHaveLength(100)

    await Tag.associateTags({ tags: [], page })
    expect(await db('pageTags').where('pageId', 2)).toHaveLength(0)
  })
})
