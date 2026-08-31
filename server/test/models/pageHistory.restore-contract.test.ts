import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
let db: Knex
let PageHistory: typeof import('../../models/pageHistory.ts').default

const createSchema = async (): Promise<void> => {
  await db.schema.createTable('users', table => {
    table.integer('id').primary()
    table.string('name').notNullable()
  })
  await db.schema.createTable('tags', table => {
    table.integer('id').primary()
    table.string('tag').notNullable()
    table.string('title').notNullable()
    table.string('createdAt').notNullable()
    table.string('updatedAt').notNullable()
  })
  await db.schema.createTable('pageHistory', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.integer('authorId').notNullable()
    table.string('path').notNullable()
    table.string('hash').notNullable()
    table.string('title').notNullable()
    table.string('description').notNullable()
    table.string('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.boolean('isPublished').notNullable()
    table.string('publishStartDate').notNullable()
    table.string('publishEndDate').notNullable()
    table.text('content').notNullable()
    table.string('contentType').notNullable()
    table.json('extra').nullable()
    table.string('editorKey').notNullable()
    table.string('localeCode').notNullable()
    table.string('action').notNullable()
    table.string('versionDate').notNullable()
    table.bigInteger('sourceRevision').notNullable().defaultTo(1)
    table.string('createdAt').notNullable()
  })
  await db.schema.createTable('pageTags', table => {
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
  })
  await db.schema.createTable('pageHistoryTags', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
  })
}

describe('page history restore metadata contract', () => {
  beforeEach(async () => {
    vi.resetModules()
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    await createSchema()
    await db('users').insert({ id: 7, name: 'Owner' })
    await db('tags').insert([
      { id: 2, tag: 'release', title: 'Release', createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z' },
      { id: 3, tag: 'docs', title: 'Docs', createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z' }
    ])
    await db('pageTags').insert([{ pageId: 42, tagId: 2 }, { pageId: 42, tagId: 3 }])

    wikiGlobal.WIKI = {
      auth: { checkAccess: vi.fn().mockReturnValue(true) },
      models: { knex: db, pageHistory: undefined }
    }
    PageHistory = (await vi.importFresh('../../models/pageHistory.ts', import.meta.url)).default
    PageHistory.knex(db)
    const Tag = (await import('../../models/tags.ts')).default
    Tag.knex(db)
    ;(wikiGlobal.WIKI as { models: Record<string, unknown> }).models.pageHistory = PageHistory
  })

  afterEach(async () => {
    await db.destroy()
    if (originalWiki === undefined) delete wikiGlobal.WIKI
    else wikiGlobal.WIKI = originalWiki
  })

  it('snapshots tag relations and returns canonical editor metadata for restore', async () => {
    const extra = {
      okf: {
        type: 'Reference',
        status: 'stable',
        generated: { by: 'human:7', at: '2026-08-15T00:00:00.000Z' }
      }
    }
    await PageHistory.addVersion({
      id: 42,
      authorId: 7,
      content: '# Release\n',
      contentType: 'markdown',
      extra,
      description: 'Release notes',
      editorKey: 'visual-markdown',
      hash: 'public:en:release',
      visibility: 'public',
      ownerId: null,
      isPublished: true,
      localeCode: 'en',
      path: 'release',
      publishEndDate: '',
      publishStartDate: '',
      title: 'Release',
      action: 'updated',
      versionDate: '2026-08-15T00:00:00.000Z'
    })
    const version = await db('pageHistory').where({ pageId: 42 }).first('id')

    expect(await db('pageHistoryTags').where({ pageId: version.id }).orderBy('tagId')).toEqual([
      expect.objectContaining({ pageId: version.id, tagId: 2 }),
      expect.objectContaining({ pageId: version.id, tagId: 3 })
    ])

    const restored = await PageHistory.getVersion({
      pageId: 42,
      versionId: version.id,
      requester: { id: 7, permissions: ['manage:system'] } as Express.User
    })
    expect(restored).toMatchObject({
      versionId: version.id,
      pageId: 42,
      content: '# Release\n',
      contentType: 'markdown',
      editor: 'visual-markdown',
      locale: 'en',
      extra,
      tags: ['release', 'docs'],
      visibility: 'public'
    })
  })
})
