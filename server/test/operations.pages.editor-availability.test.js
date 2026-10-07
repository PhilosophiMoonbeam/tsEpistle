import fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import createKnex from 'knex'
import { load } from 'js-yaml'

const originalWiki = global.WIKI

const pageInput = (editor, path) => ({
  editor,
  path,
  locale: 'en',
  title: 'Editor availability',
  description: '',
  content: editor === 'api' ? 'openapi: 3.0.0\ninfo:\n  title: Example\n  version: 1.0.0\npaths: {}' : 'Page content',
  tags: [],
  isPublished: true
})

describe('page creation editor availability', () => {
  let db
  let tempRoot

  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    if (db) await db.destroy()
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
    db = undefined
    if (originalWiki === undefined) delete global.WIKI
    else global.WIKI = originalWiki
  })

  const arrange = async available => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wiki-editor-availability-'))
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('pages', table => {
      table.increments('id')
      table.string('path').notNullable()
      table.string('localeCode').notNullable()
      table.string('hash').notNullable()
      table.string('title').notNullable()
      table.text('description').notNullable()
      table.string('visibility').notNullable()
      table.integer('ownerId').nullable()
      table.integer('authorId').notNullable()
      table.integer('creatorId').notNullable()
      table.string('editorKey').notNullable()
      table.string('contentType').notNullable()
      table.boolean('isPublished').notNullable()
      table.boolean('isSearchable').notNullable().defaultTo(true)
      table.text('content').notNullable()
      table.text('render').nullable()
      table.string('publishStartDate').notNullable()
      table.string('publishEndDate').notNullable()
      table.string('toc').notNullable()
      table.text('extra').notNullable()
      table.bigInteger('sourceRevision').notNullable().defaultTo(1)
      table.bigInteger('renderedSourceRevision').nullable()
      table.dateTime('createdAt').nullable()
      table.dateTime('updatedAt').nullable()
    })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.string('name').notNullable()
      table.string('email').notNullable()
    })
    await db('users').insert({ id: 7, name: 'Author', email: 'author@example.test' })
    await db.schema.createTable('tags', table => {
      table.increments('id')
      table.string('tag').notNullable().unique()
      table.string('title').notNullable()
      table.integer('redirectToId').nullable()
      table.boolean('isArchived').notNullable().defaultTo(false)
      table.dateTime('createdAt').nullable()
      table.dateTime('updatedAt').nullable()
    })
    await db.schema.createTable('pageTags', table => {
      table.integer('pageId').notNullable()
      table.integer('tagId').notNullable()
      table.primary(['pageId', 'tagId'])
    })
    await db.schema.createTable('pageMutationOutbox', table => {
      table.string('id').primary()
      table.integer('pageId').notNullable()
      table.bigInteger('sourceRevision').notNullable()
      table.string('effectKind').notNullable()
      table.string('effectKey').notNullable()
      table.string('desiredState').notNullable()
      table.string('payloadSha256').notNullable()
      table.text('payload').notNullable()
      table.string('status').notNullable()
      table.integer('attempts').notNullable()
      table.dateTime('availableAt').notNullable()
      table.dateTime('createdAt').notNullable()
      table.dateTime('updatedAt').notNullable()
      table.unique(['pageId', 'sourceRevision', 'effectKind'])
    })
    await db.schema.createTable('outboxEvents', table => {
      table.string('id').primary()
      table.string('type').notNullable()
      table.integer('version').notNullable()
      table.string('aggregateType').notNullable()
      table.string('aggregateId').notNullable()
      table.text('payload').notNullable()
      table.dateTime('createdAt').notNullable()
      table.dateTime('publishedAt').nullable()
    })
    const checkAccess = vi.fn().mockReturnValue(true)
    const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: ['write:pages'], groups: [], tagAliases: {} }))
    global.WIKI = {
      ROOTPATH: tempRoot,
      auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
      config: { dataPath: 'data', db: { type: 'sqlite' }, editors: { available }, lang: { code: 'en' } },
      data: {
        editors: ['markdown', 'ckeditor', 'asciidoc', 'code', 'api'].map(key =>
          load(fs.readFileSync(new URL(`../modules/editor/${key}/definition.yml`, import.meta.url), 'utf8'))
        ),
        reservedPaths: []
      },
      Error: { PageDuplicateCreate: Error, PageEmptyContent: Error, PageIllegalPath: Error, PageNotFound: Error },
      events: { inbound: new EventEmitter(), outbound: new EventEmitter() },
      logger: { warn: vi.fn() },
      models: { knex: db, pages: {}, tags: {}, pageHistory: {}, storage: { pageEvent: vi.fn(async () => undefined) } }
    }
    const { default: Page } = await vi.importFresh('../models/pages.ts', import.meta.url)
    Page.knex(db)
    const Tag = Page.relationMappings.tags.modelClass
    Tag.knex(db)
    global.WIKI.models.pages = Page
    global.WIKI.models.tags = Tag
    vi.spyOn(Page, 'renderPage').mockResolvedValue(undefined)
    vi.spyOn(Page, 'rebuildTree').mockResolvedValue(undefined)
    vi.spyOn(Page, 'reconnectLinks').mockResolvedValue(undefined)
    const createPage = vi.spyOn(Page, 'createPage')
    const { default: operations } = await vi.importFresh('../operations/pages.ts', import.meta.url)
    return { operations, createPage }
  }

  it('rejects a configurable editor hidden by an administrator', async () => {
    const { operations, createPage } = await arrange(['markdown'])

    let failure
    try {
      await operations.create({ requester: { id: 7 }, input: pageInput('code', 'restricted') })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ name: 'EDITOR_NOT_AVAILABLE', status: 400 })
    expect(createPage).not.toHaveBeenCalled()
    expect(await db('pages')).toEqual([])
  })

  it('creates pages with an available editor', async () => {
    const { operations } = await arrange(['markdown'])
    const requester = { id: 7, name: 'Author', email: 'author@example.test' }

    const result = await operations.create({ requester, input: pageInput('markdown', 'allowed') })
    const rows = await db('pages')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: result.id, editorKey: 'markdown', visibility: 'public', authorId: 7, creatorId: 7 })
    expect(result).toMatchObject({ id: rows[0].id, path: 'allowed', editorKey: 'markdown', visibility: 'public' })
  })

  it.each(['ckeditor', 'asciidoc', 'code'])('creates pages when %s is explicitly enabled', async editor => {
    const { operations } = await arrange([editor])

    const result = await operations.create({ requester: { id: 7 }, input: pageInput(editor, `${editor}-page`) })
    const rows = await db('pages')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: result.id, editorKey: editor, visibility: 'public' })
    expect(result).toMatchObject({ id: rows[0].id, path: `${editor}-page`, editorKey: editor, visibility: 'public' })
  })

  it('does not apply chooser restrictions to internal editor types', async () => {
    const { operations } = await arrange(['markdown'])

    const result = await operations.create({ requester: { id: 7 }, input: pageInput('api', 'api-reference') })
    const rows = await db('pages')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: result.id, editorKey: 'api', contentType: 'yml' })
    expect(result).toMatchObject({ id: rows[0].id, path: 'api-reference', editorKey: 'api', contentType: 'yml' })
  })
})
