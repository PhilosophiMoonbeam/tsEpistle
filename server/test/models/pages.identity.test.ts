import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import createKnex from 'knex'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type PageModel from '../../models/pages.ts'

const localeRelationMovePatch = vi.fn(async (_transaction: Knex.Transaction, _page: { id: number }, _locale: string) => ({}))
const writeOutboxEvent = vi.fn(async (_knex: unknown, _event: { type: string; payload: Record<string, unknown> }) => undefined)
const redactProtectedPageForSearch = vi.fn((page: unknown) => page)
const syncProtectedPageAssets = vi.fn(async (_knex: unknown, _pageId: number, _content: string, _render: string) => undefined)

vi.mockModule('../../helpers/page-locale-relations.ts', import.meta.url, () => ({ localeRelationMovePatch }))
vi.mockModule('../../core/outbox.ts', import.meta.url, () => ({ writeOutboxEvent }))
vi.mockModule('../../operations/page-protection.ts', import.meta.url, () => ({ redactProtectedPageForSearch, syncProtectedPageAssets }))

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
const actor = { id: 11, name: 'Administrator', email: 'admin@example.com', permissions: ['manage:system', 'write:pages'] } as Express.User & {
  id: number
  name: string
  email: string
}
const searchRenamed = vi.fn(async (_page: unknown) => undefined)
const storagePageEvent = vi.fn(async (_event: unknown) => undefined)
const outboundEmit = vi.fn((_event: string, _payload?: unknown) => undefined)
let db: Knex
let Page: typeof PageModel
let tempRoot: string
let generatePageHash: (options: { path: string; locale: string; visibility: 'public' | 'private'; ownerId: number | null }) => string
const sourceRevisionFields = [
  'path',
  'hash',
  'title',
  'description',
  'visibility',
  'ownerId',
  'isPublished',
  'publishStartDate',
  'publishEndDate',
  'content',
  'contentType',
  'editorKey',
  'localeCode',
  'authorId',
  'creatorId',
  'extra'
] as const

const pageRow = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  path: 'guides/identity',
  hash: 'old-hash',
  title: 'Identity',
  description: 'Identity aggregate',
  visibility: 'public',
  ownerId: null,
  isPublished: true,
  publishStartDate: '',
  publishEndDate: '',
  content: '# Identity',
  render: '<p>Identity</p>',
  toc: '[]',
  contentType: 'markdown',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T01:00:00.000Z',
  sourceRevision: 1,
  editorKey: 'markdown',
  localeCode: 'en',
  localeGroupId: null,
  authorId: 11,
  creatorId: 11,
  extra: '{}',
  ...overrides
})

const installSchema = async () => {
  await db.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.text('path').notNullable()
    table.text('hash').notNullable()
    table.text('title').notNullable()
    table.text('description').notNullable()
    table.text('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.boolean('isPublished').notNullable()
    table.text('publishStartDate').notNullable()
    table.text('publishEndDate').notNullable()
    table.text('content').notNullable()
    table.text('render').notNullable()
    table.text('toc').notNullable()
    table.text('contentType').notNullable()
    table.text('createdAt').notNullable()
    table.text('updatedAt').notNullable()
    table.bigInteger('sourceRevision').notNullable().defaultTo(1)
    table.text('editorKey').notNullable()
    table.text('localeCode').notNullable()
    table.text('localeGroupId').nullable()
    table.integer('authorId').notNullable()
    table.integer('creatorId').notNullable()
    table.text('extra').notNullable()
  })
  await db.raw(`
    CREATE TRIGGER pages_source_revision_trigger
    AFTER UPDATE OF path, hash, title, description, visibility, ownerId, isPublished, publishStartDate, publishEndDate, content, contentType, editorKey, localeCode, authorId, creatorId, extra
    ON pages
    FOR EACH ROW
    WHEN NEW.path IS NOT OLD.path
      OR NEW.hash IS NOT OLD.hash
      OR NEW.title IS NOT OLD.title
      OR NEW.description IS NOT OLD.description
      OR NEW.visibility IS NOT OLD.visibility
      OR NEW.ownerId IS NOT OLD.ownerId
      OR NEW.isPublished IS NOT OLD.isPublished
      OR NEW.publishStartDate IS NOT OLD.publishStartDate
      OR NEW.publishEndDate IS NOT OLD.publishEndDate
      OR NEW.content IS NOT OLD.content
      OR NEW.contentType IS NOT OLD.contentType
      OR NEW.editorKey IS NOT OLD.editorKey
      OR NEW.localeCode IS NOT OLD.localeCode
      OR NEW.authorId IS NOT OLD.authorId
      OR NEW.creatorId IS NOT OLD.creatorId
      OR NEW.extra IS NOT OLD.extra
    BEGIN
      UPDATE pages SET sourceRevision = OLD.sourceRevision + 1 WHERE id = OLD.id;
    END
  `)
  await db.schema.createTable('pageMutationOutbox', table => {
    table.uuid('id').primary()
    table.integer('pageId').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.string('effectKind').notNullable()
    table.string('effectKey').notNullable()
    table.string('desiredState').notNullable()
    table.string('payloadSha256').notNullable()
    table.text('payload').notNullable()
    table.string('status').notNullable().defaultTo('pending')
    table.integer('attempts').notNullable().defaultTo(0)
    table.string('leaseOwner').nullable()
    table.uuid('leaseToken').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.dateTime('availableAt').notNullable().defaultTo(db.fn.now())
    table.text('result').nullable()
    table.text('postcondition').nullable()
    table.dateTime('createdAt').notNullable().defaultTo(db.fn.now())
    table.dateTime('updatedAt').notNullable().defaultTo(db.fn.now())
    table.unique(['pageId', 'sourceRevision', 'effectKind'])
  })
  await db.schema.createTable('pageHistory', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.text('path').notNullable()
    table.text('hash').notNullable()
    table.text('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.text('localeCode').notNullable()
    table.bigInteger('sourceRevision').notNullable().defaultTo(1)
  })
  await db.schema.createTable('pageLinks', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.text('path').notNullable()
    table.text('localeCode').notNullable()
  })
  await db.schema.createTable('pageTree', table => {
    table.integer('id').primary()
    table.text('localeCode').notNullable()
    table.text('path').notNullable()
    table.integer('depth').notNullable()
    table.text('title').notNullable()
    table.boolean('isFolder').notNullable()
    table.text('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.integer('parent').nullable()
    table.integer('pageId').nullable()
    table.text('ancestors').notNullable()
  })
  await db.schema.createTable('tags', table => {
    table.increments('id').primary()
    table.text('tag').notNullable()
    table.text('title').notNullable()
  })
  await db.schema.createTable('pageTags', table => {
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
  })
}

beforeEach(async () => {
  vi.resetModules()
  writeOutboxEvent.mockReset()
  writeOutboxEvent.mockResolvedValue(undefined)
  localeRelationMovePatch.mockReset()
  localeRelationMovePatch.mockResolvedValue({})
  searchRenamed.mockReset()
  searchRenamed.mockResolvedValue(undefined)
  storagePageEvent.mockReset()
  storagePageEvent.mockResolvedValue(undefined)
  outboundEmit.mockReset()
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-page-identity-'))
  db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await installSchema()

  const errors = Object.fromEntries(
    [
      'PageDeleteForbidden',
      'PageDuplicateCreate',
      'PageEmptyContent',
      'PageIllegalPath',
      'PageMoveForbidden',
      'PageNotFound',
      'PagePathCollision',
      'PageUpdateForbidden'
    ].map(name => [name, class extends Error {}])
  )
  wikiGlobal.WIKI = {
    ROOTPATH: tempRoot,
    Error: errors,
    auth: { checkAccess: vi.fn().mockReturnValue(true) },
    collaboration: { pageChanged: vi.fn(async () => undefined) },
    config: { dataPath: 'data', db: { type: 'postgres' } },
    data: {
      editors: [],
      searchEngine: { created: vi.fn(), deleted: vi.fn(), renamed: searchRenamed, updated: vi.fn() }
    },
    events: { inbound: new EventEmitter(), outbound: { emit: outboundEmit } },
    logger: { error: vi.fn(), warn: vi.fn() },
    models: {
      comments: {},
      knex: db,
      pageHistory: {
        addVersion: vi.fn(async (page: Record<string, unknown> & { transaction: Knex.Transaction; sourceRevision?: string | number }) => {
          await page.transaction('pageHistory').insert({
            pageId: page.id,
            path: page.path,
            hash: page.hash,
            visibility: page.visibility,
            ownerId: page.ownerId,
            localeCode: page.localeCode,
            sourceRevision: page.sourceRevision ?? 1
          })
        })
      },
      pages: {},
      storage: { pageEvent: storagePageEvent },
      tags: {}
    },
    scheduler: { registerJob: vi.fn() }
  }

  Page = (await vi.importFresh('../../models/pages.ts', import.meta.url)).default
  Page.knex(db)
  // SQLite cannot assign to NEW in a BEFORE trigger. Its AFTER trigger commits
  // the same revision, while these hooks retain the fenced outer UPDATE count
  // instead of exposing the trigger's internal UPDATE through Objection.
  const fencedUpdateRows = new WeakMap<object, number>()
  vi.spyOn(Page, 'beforeUpdate').mockImplementation(async args => {
    if (sourceRevisionFields.some(field => args.inputItems.some(item => Object.hasOwn(item, field)))) {
      fencedUpdateRows.set(args.context, (await args.asFindQuery().select('id')).length)
    }
  })
  vi.spyOn(Page, 'afterUpdate').mockImplementation(args => {
    const affectedRows = fencedUpdateRows.get(args.context)
    fencedUpdateRows.delete(args.context)
    return affectedRows
  })
  // page.ts captures the test WIKI global, so the known helper module must be loaded after the isolated global is installed.
  generatePageHash = (await import('../../helpers/page.ts')).default.generateHash
  ;(wikiGlobal.WIKI.models as Record<string, unknown>).pages = Page
  vi.spyOn(Page, 'acquireLocaleMigrationLocks').mockResolvedValue(undefined)
  vi.spyOn(Page, 'rebuildTree').mockResolvedValue(undefined)
  vi.spyOn(Page, 'prepareSearchDocument').mockImplementation(async page => {
    page.safeContent = 'identity'
    return page
  })
  vi.spyOn(Page, 'getPageFromDb').mockImplementation(async input => {
    const row =
      typeof input === 'number'
        ? await db('pages').where({ id: input }).first()
        : await db('pages')
            .where({
              path: input.path,
              localeCode: input.locale,
              visibility: input.visibility,
              ownerId: input.ownerId
            })
            .first()
    return row
      ? ({ ...row, tags: [], authorName: 'Author', authorEmail: 'author@example.com', creatorName: 'Author', creatorEmail: 'author@example.com' } as never)
      : undefined
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await db.destroy()
  await fs.remove(tempRoot)
  if (originalWiki === undefined) delete wikiGlobal.WIKI
  else wikiGlobal.WIKI = originalWiki
})

describe('models/pages identity aggregate', () => {
  it('emits visibility and ownership identities from the committed state', async () => {
    await db('pages').insert(pageRow())

    const visibilityPage = await Page.changeVisibility({ id: 42, visibility: 'private', user: actor, expectedSourceRevision: '1' })
    const visibilityEvent = writeOutboxEvent.mock.calls.find(([, event]) => event.type === 'page.visibility-changed')?.[1]
    expect(visibilityEvent?.payload).toMatchObject({ pageId: 42, visibility: 'private', ownerId: 11 })
    expect(visibilityPage).toMatchObject({ visibility: 'private', ownerId: 11, sourceRevision: 2 })
    expect(await db('pages').where({ id: 42 }).first('visibility', 'ownerId', 'sourceRevision')).toMatchObject({
      visibility: 'private',
      ownerId: 11,
      sourceRevision: 2
    })

    const visibilityEffects = await db('pageMutationOutbox').where({ pageId: 42, sourceRevision: 2 }).orderBy('effectKind')
    expect(visibilityEffects.map(row => row.effectKind)).toEqual(['knowledge', 'links', 'render', 'search'])
    const visibilitySearch = visibilityEffects.find(row => row.effectKind === 'search')
    expect(visibilitySearch).toMatchObject({
      pageId: 42,
      sourceRevision: 2,
      effectKind: 'search',
      effectKey: 'page:42:search',
      desiredState: 'present',
      status: 'pending'
    })
    expect(JSON.parse(String(visibilitySearch?.payload))).toEqual({
      version: 1,
      effectKind: 'search',
      desiredState: 'present',
      action: 'visibility',
      pageId: 42,
      sourceRevision: '2',
      sourceSha256: createHash('sha256').update('# Identity').digest('hex'),
      location: { locale: 'en', path: 'guides/identity', visibility: 'private', ownerId: 11 },
      previousLocation: { locale: 'en', path: 'guides/identity', visibility: 'public', ownerId: null }
    })

    const ownershipPage = await Page.transferOwnership({ id: 42, ownerId: 27, user: actor, expectedSourceRevision: '2' })
    const ownershipEvent = writeOutboxEvent.mock.calls.find(([, event]) => event.type === 'page.ownership-transferred')?.[1]
    expect(ownershipEvent?.payload).toMatchObject({ pageId: 42, visibility: 'private', ownerId: 27 })
    expect(ownershipPage).toMatchObject({ visibility: 'private', ownerId: 27, sourceRevision: 3 })
    expect(await db('pages').where({ id: 42 }).first('visibility', 'ownerId', 'sourceRevision')).toMatchObject({
      visibility: 'private',
      ownerId: 27,
      sourceRevision: 3
    })

    const ownershipEffects = await db('pageMutationOutbox').where({ pageId: 42, sourceRevision: 3 }).orderBy('effectKind')
    expect(ownershipEffects.map(row => row.effectKind)).toEqual(['knowledge', 'links', 'render', 'search'])
    const ownershipSearch = ownershipEffects.find(row => row.effectKind === 'search')
    expect(ownershipSearch).toMatchObject({
      pageId: 42,
      sourceRevision: 3,
      effectKind: 'search',
      effectKey: 'page:42:search',
      desiredState: 'present',
      status: 'pending'
    })
    expect(JSON.parse(String(ownershipSearch?.payload))).toEqual({
      version: 1,
      effectKind: 'search',
      desiredState: 'present',
      action: 'ownership',
      pageId: 42,
      sourceRevision: '3',
      sourceSha256: createHash('sha256').update('# Identity').digest('hex'),
      location: { locale: 'en', path: 'guides/identity', visibility: 'private', ownerId: 27 },
      previousLocation: { locale: 'en', path: 'guides/identity', visibility: 'private', ownerId: 11 }
    })
  })

  it('moves locale identity and creates revision-fenced durable search work with storage', async () => {
    const oldHash = generatePageHash({ path: 'guides/identity', locale: 'en', visibility: 'public', ownerId: null })
    const newHash = generatePageHash({ path: 'guides/identity', locale: 'fr', visibility: 'public', ownerId: null })
    const backlinkHash = generatePageHash({ path: 'references/backlink', locale: 'de', visibility: 'public', ownerId: null })
    const source = pageRow({ hash: oldHash })
    const backlink = pageRow({
      id: 84,
      path: 'references/backlink',
      hash: backlinkHash,
      localeCode: 'de',
      render: '<a href="/en/guides/identity" class="is-internal-link is-valid-page">Identity</a>'
    })
    await db('pages').insert([source, backlink])
    await db('pageHistory').insert({
      pageId: 42,
      path: 'guides/identity',
      hash: oldHash,
      visibility: 'public',
      ownerId: null,
      localeCode: 'en',
      sourceRevision: 1
    })
    await db('pageLinks').insert({ pageId: 84, path: 'guides/identity', localeCode: 'en' })
    await Page.savePageToCache({ ...source, extra: {}, tags: [], authorName: 'Author', creatorName: 'Author' } as never)
    await Page.savePageToCache({
      ...source,
      hash: newHash,
      localeCode: 'fr',
      render: '<p>stale destination</p>',
      extra: {},
      tags: [],
      authorName: 'Author',
      creatorName: 'Author'
    } as never)

    await expect(Page.migrateToLocale({ sourceLocale: 'en', targetLocale: 'fr', user: actor })).resolves.toBe(1)

    expect(await db('pages').where({ id: 42 }).first('localeCode', 'hash', 'sourceRevision')).toMatchObject({
      localeCode: 'fr',
      hash: newHash,
      sourceRevision: 2
    })
    expect(await db('pageHistory').where({ pageId: 42 }).select('localeCode', 'hash', 'sourceRevision').orderBy('id')).toEqual([
      { localeCode: 'fr', hash: newHash, sourceRevision: 1 },
      { localeCode: 'fr', hash: newHash, sourceRevision: 1 }
    ])
    expect(await db('pageTree').where({ pageId: 42 }).first('localeCode', 'path')).toMatchObject({ localeCode: 'fr', path: 'guides/identity' })
    expect(await db('pageLinks').where({ pageId: 84 }).first('localeCode', 'path')).toMatchObject({ localeCode: 'fr', path: 'guides/identity' })
    expect((await db('pages').where({ id: 84 }).first('render')).render).toContain('/fr/guides/identity')
    const projectionRows = await db('pageMutationOutbox').where({ pageId: 42 }).orderBy('effectKind')
    expect(projectionRows.map(row => row.effectKind)).toEqual(['knowledge', 'links', 'render', 'search'])
    const searchEffect = projectionRows.find(row => row.effectKind === 'search')
    expect(searchEffect).toMatchObject({
      pageId: 42,
      sourceRevision: 2,
      effectKind: 'search',
      effectKey: 'page:42:search',
      desiredState: 'present',
      status: 'pending'
    })
    expect(JSON.parse(String(searchEffect?.payload))).toEqual({
      version: 1,
      effectKind: 'search',
      desiredState: 'present',
      action: 'move',
      pageId: 42,
      sourceRevision: '2',
      sourceSha256: createHash('sha256').update('# Identity').digest('hex'),
      location: { locale: 'fr', path: 'guides/identity', visibility: 'public', ownerId: null },
      previousLocation: { locale: 'en', path: 'guides/identity', visibility: 'public', ownerId: null }
    })
    expect(await Page.getPageFromCache({ path: 'guides/identity', locale: 'en', visibility: 'public', ownerId: null })).toBe(false)
    const movedEvent = writeOutboxEvent.mock.calls.find(([, event]) => event.type === 'page.moved')?.[1]
    expect(movedEvent?.payload).toMatchObject({ actorId: 11, localeCode: 'fr' })
    expect(await Page.getPageFromCache({ path: 'guides/identity', locale: 'fr', visibility: 'public', ownerId: null })).toBe(false)
    await expect(Page.getPage({ path: 'guides/identity', locale: 'en', visibility: 'public', ownerId: null })).resolves.toBeUndefined()
    await expect(Page.getPage({ path: 'guides/identity', locale: 'fr', visibility: 'public', ownerId: null })).resolves.toMatchObject({
      hash: newHash,
      localeCode: 'fr'
    })
    expect(searchRenamed).not.toHaveBeenCalled()
    expect(Page.prepareSearchDocument).not.toHaveBeenCalled()
    expect(storagePageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renamed',
        page: expect.objectContaining({ moveAuthorId: 11, moveAuthorName: 'Administrator', destinationLocaleCode: 'fr' })
      })
    )
  })

  it('creates no durable search work when a conflicted locale mutation rolls back', async () => {
    const oldHash = generatePageHash({ path: 'guides/identity', locale: 'en', visibility: 'public', ownerId: null })
    await db('pages').insert(pageRow({ hash: oldHash }))
    await db('pageHistory').insert({
      pageId: 42,
      path: 'guides/identity',
      hash: oldHash,
      visibility: 'public',
      ownerId: null,
      localeCode: 'en',
      sourceRevision: 1
    })
    await db('pageTree').insert({
      id: 1,
      localeCode: 'en',
      path: 'guides/identity',
      depth: 2,
      title: 'Identity',
      isFolder: false,
      visibility: 'public',
      ownerId: null,
      parent: null,
      pageId: 42,
      ancestors: '[]'
    })
    localeRelationMovePatch.mockImplementationOnce(async (transaction, page) => {
      await transaction('pages').where({ id: page.id }).update({ sourceRevision: 2 })
      return {}
    })

    await expect(Page.migrateToLocale({ sourceLocale: 'en', targetLocale: 'fr', user: actor })).rejects.toThrow('The page changed after history was opened.')

    expect(await db('pages').where({ id: 42 }).first('localeCode', 'hash')).toMatchObject({ localeCode: 'en', hash: oldHash })
    expect(await db('pageHistory').where({ pageId: 42 }).select('localeCode', 'hash')).toEqual([expect.objectContaining({ localeCode: 'en', hash: oldHash })])
    expect(await db('pageTree').where({ pageId: 42 }).first('localeCode')).toMatchObject({ localeCode: 'en' })
    expect(storagePageEvent).not.toHaveBeenCalled()
    expect(searchRenamed).not.toHaveBeenCalled()
    expect(await db('pageMutationOutbox')).toEqual([])
    expect(writeOutboxEvent).not.toHaveBeenCalled()
    expect(outboundEmit).not.toHaveBeenCalledWith('deletePageFromCache', expect.anything())
  })
})
