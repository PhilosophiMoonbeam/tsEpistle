import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import knexModule, { type Knex } from 'knex'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

interface ExportSystem {
  export(options: { path: string; entities: string[] }): Promise<void>
}

type ExportedRow = Record<string, unknown>
type ModelClass = { knex(knex: Knex): void }

const database = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  database.endsWith('_utility_export_test') && password
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        database,
        password
      }
    : null
const suite = connection ? describe : describe.skip
const wikiGlobal = globalThis as unknown as { WIKI?: unknown }
const originalWiki = wikiGlobal.WIKI
const outputDirectories: string[] = []
const publicIds = [1, 2, 4, 5, 6, 7, 9, 13, 15, 16, 17, 18, 19, 20]
const privatePageId = 14

const readGzipJson = (file: string): ExportedRow[] => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as ExportedRow[]

suite('System export relation paging against PostgreSQL', () => {
  let db: Knex
  let system: ExportSystem

  const tagsFor = (pageId: number): Array<{ tag: string; title: string }> => {
    const ordinal = publicIds.indexOf(pageId)
    const suffixes = ordinal >= 0 && ordinal < 7 ? ['alpha', 'beta'] : ['alpha']
    return suffixes.map(suffix => ({ tag: `page-${pageId}-${suffix}`, title: `Page ${pageId} ${suffix}` }))
  }

  const createOutputDirectory = (): string => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-system-export-postgres-'))
    outputDirectories.push(directory)
    return directory
  }

  beforeAll(async () => {
    db = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 4 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.string('name').notNullable()
    })
    await db.schema.createTable('tags', table => {
      table.integer('id').primary()
      table.string('tag').notNullable()
      table.string('title').notNullable()
    })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('path').notNullable()
      table.string('localeCode').notNullable()
      table.string('title').notNullable()
      table.text('description').notNullable()
      table.text('content').notNullable()
      table.string('contentType').notNullable()
      table.string('editorKey').notNullable()
      table.string('visibility').notNullable()
      table.integer('ownerId').nullable()
      table.boolean('isPublished').notNullable()
      table.bigInteger('sourceRevision').notNullable()
      table.integer('authorId').notNullable().references('id').inTable('users')
      table.integer('creatorId').notNullable().references('id').inTable('users')
      table.jsonb('extra').notNullable()
      table.timestamp('createdAt').notNullable()
      table.timestamp('updatedAt').notNullable()
    })
    await db.schema.createTable('pageTags', table => {
      table.integer('pageId').notNullable().references('id').inTable('pages').onDelete('CASCADE')
      table.integer('tagId').notNullable().references('id').inTable('tags').onDelete('CASCADE')
      table.primary(['pageId', 'tagId'])
    })
    await db.schema.createTable('pageHistory', table => {
      table.integer('id').primary()
      table.integer('pageId').notNullable().references('id').inTable('pages').onDelete('CASCADE')
      table.integer('authorId').notNullable().references('id').inTable('users')
      table.string('authorName').notNullable()
      table.string('path').notNullable()
      table.string('localeCode').notNullable()
      table.string('title').notNullable()
      table.text('description').notNullable()
      table.text('content').notNullable()
      table.string('contentType').notNullable()
      table.string('editorKey').notNullable()
      table.string('visibility').notNullable()
      table.integer('ownerId').nullable()
      table.boolean('isPublished').notNullable()
      table.bigInteger('sourceRevision').notNullable()
      table.string('action').notNullable()
      table.timestamp('versionDate').notNullable()
      table.jsonb('extra').notNullable()
      table.timestamp('createdAt').notNullable()
    })
    await db.schema.createTable('pageHistoryTags', table => {
      table.integer('pageId').notNullable().references('id').inTable('pageHistory').onDelete('CASCADE')
      table.integer('tagId').notNullable().references('id').inTable('tags').onDelete('CASCADE')
      table.primary(['pageId', 'tagId'])
    })

    const wiki = {
      ROOTPATH: process.cwd(),
      config: { dataPath: 'data' },
      logger: { info: () => undefined, warn: () => undefined },
      models: { knex: db }
    }
    wikiGlobal.WIKI = wiki
    // The models capture WIKI while evaluating, so this fixture must load them after installing its isolated runtime.
    const Page = (await vi.importFresh<{ default: ModelClass }>('../../models/pages.ts', import.meta.url)).default
    const PageHistory = (await import('../../models/pageHistory.ts')).default as unknown as ModelClass
    const User = (await import('../../models/users.ts')).default as unknown as ModelClass
    const Tag = (await import('../../models/tags.ts')).default as unknown as ModelClass
    for (const model of [Page, PageHistory, User, Tag]) model.knex(db)
    Reflect.set(wiki, 'models', { pages: Page, pageHistory: PageHistory, knex: db })
    system = (await vi.importFresh<{ default: ExportSystem }>('../../core/system.ts', import.meta.url)).default
  })

  beforeEach(async () => {
    for (const table of ['pageHistoryTags', 'pageTags', 'pageHistory', 'pages', 'tags', 'users']) await db(table).delete()
    await db('users').insert([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Private' }
    ])
    const now = new Date('2026-09-07T00:00:00.000Z')
    const pageRows = [...publicIds, privatePageId].map(id => ({
      id,
      path: id === privatePageId ? 'private' : `page-${id}`,
      localeCode: 'en',
      title: id === privatePageId ? 'Private page' : `Page ${id}`,
      description: '',
      content: id === privatePageId ? 'private page content' : `public page ${id}`,
      contentType: 'text/markdown',
      editorKey: 'markdown',
      visibility: id === privatePageId ? 'private' : 'public',
      ownerId: id === privatePageId ? 2 : null,
      isPublished: true,
      sourceRevision: 1,
      authorId: id === privatePageId ? 2 : 1,
      creatorId: id === privatePageId ? 2 : 1,
      extra: {},
      createdAt: now,
      updatedAt: now
    }))
    await db('pages').insert(pageRows)
    const allPageIds = [...publicIds, privatePageId]
    const tagRows = allPageIds.flatMap(pageId => tagsFor(pageId)).map((tag, index) => ({ id: index + 1, ...tag }))
    await db('tags').insert(tagRows)
    let tagId = 1
    const assignments = allPageIds.flatMap(pageId => tagsFor(pageId).map(() => ({ pageId, tagId: tagId++ })))
    await db('pageTags').insert(assignments)
    const historyRows = pageRows.map(page => ({
      id: page.id + 100,
      pageId: page.id,
      authorId: page.authorId,
      authorName: page.authorId === 1 ? 'Ada' : 'Private',
      path: page.path,
      localeCode: page.localeCode,
      title: page.title,
      description: page.description,
      content: page.content,
      contentType: page.contentType,
      editorKey: page.editorKey,
      visibility: page.visibility,
      ownerId: page.ownerId,
      isPublished: page.isPublished,
      sourceRevision: page.sourceRevision,
      action: 'updated',
      versionDate: now,
      extra: {},
      createdAt: now
    }))
    await db('pageHistory').insert(historyRows)
    await db('pageHistoryTags').insert(assignments.map(assignment => ({ pageId: assignment.pageId + 100, tagId: assignment.tagId })))
  })

  afterEach(() => {
    for (const directory of outputDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
  })

  afterAll(async () => {
    if (db) {
      for (const table of ['pageHistoryTags', 'pageTags', 'pageHistory', 'pages', 'tags', 'users']) await db.schema.dropTableIfExists(table)
      await db.destroy()
    }
    if (originalWiki === undefined) delete wikiGlobal.WIKI
    else wikiGlobal.WIKI = originalWiki
  })

  it('exports every public parent once with complete tags across parent batches', async () => {
    const directory = createOutputDirectory()

    await system.export({ path: directory, entities: ['pages', 'history'] })

    const pages = readGzipJson(path.join(directory, 'pages.json.gz'))
    const history = readGzipJson(path.join(directory, 'pages-history.json.gz'))
    expect(pages.map(page => page.id)).toEqual(publicIds)
    expect(history.map(entry => entry.id)).toEqual(publicIds.map(id => id + 100))
    for (const rows of [pages, history]) {
      for (const [index, row] of rows.entries()) {
        const expectedTags = tagsFor(publicIds[index]!)
        expect(row.tags).toHaveLength(expectedTags.length)
        expect(row.tags).toEqual(expect.arrayContaining(expectedTags))
      }
    }
    expect(fs.statSync(path.join(directory, 'pages.json.gz')).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(directory).some(entry => entry.includes('.tmp'))).toBe(false)
    expect(JSON.stringify([pages, history])).not.toContain('private page content')
    expect(JSON.stringify([pages, history])).not.toContain('Private page')
  })
})
