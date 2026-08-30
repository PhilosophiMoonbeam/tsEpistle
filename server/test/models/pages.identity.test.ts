import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import createKnex from 'knex'
import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type PageModel from '../../models/pages.ts'

const localeRelationMovePatch = vi.fn(async (_transaction: unknown, _page: unknown, _locale: string) => ({}))
const writeOutboxEvent = vi.fn(async (_knex: unknown, _event: { type: string; payload: Record<string, unknown> }) => undefined)
const enqueuePageMutationEffects = vi.fn(async (_knex: unknown, _input: Record<string, unknown>) => undefined)
const redactProtectedPageForSearch = vi.fn((page: unknown) => page)
const syncProtectedPageAssets = vi.fn(async (_knex: unknown, _pageId: number, _content: string, _render: string) => undefined)

vi.mockModule('../../helpers/page-locale-relations.ts', import.meta.url, () => ({ localeRelationMovePatch }))
vi.mockModule('../../core/outbox.ts', import.meta.url, () => ({ writeOutboxEvent }))
vi.mockModule('../../core/page-mutation-outbox.ts', import.meta.url, () => ({ enqueuePageMutationEffects }))
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
    table.integer('sourceRevision').notNullable()
    table.text('editorKey').notNullable()
    table.text('localeCode').notNullable()
    table.text('localeGroupId').nullable()
    table.integer('authorId').notNullable()
    table.integer('creatorId').notNullable()
    table.text('extra').notNullable()
  })
  await db.schema.createTable('pageHistory', table => {
    table.increments('id').primary()
    table.integer('pageId').notNullable()
    table.text('path').notNullable()
    table.text('hash').notNullable()
    table.text('visibility').notNullable()
    table.integer('ownerId').nullable()
    table.text('localeCode').notNullable()
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
  enqueuePageMutationEffects.mockReset()
  enqueuePageMutationEffects.mockResolvedValue(undefined)
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
        addVersion: vi.fn(async (page: Record<string, unknown> & { transaction: Knex.Transaction }) => {
          await page.transaction('pageHistory').insert({
            pageId: page.id,
            path: page.path,
            hash: page.hash,
            visibility: page.visibility,
            ownerId: page.ownerId,
            localeCode: page.localeCode
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

    await Page.changeVisibility({ id: 42, visibility: 'private', user: actor, expectedSourceRevision: '1' })
    const visibilityEvent = writeOutboxEvent.mock.calls.find(([, event]) => event.type === 'page.visibility-changed')?.[1]
    expect(visibilityEvent?.payload).toMatchObject({ pageId: 42, visibility: 'private', ownerId: 11 })
    expect(await db('pages').where({ id: 42 }).first('visibility', 'ownerId')).toMatchObject({ visibility: 'private', ownerId: 11 })

    await Page.transferOwnership({ id: 42, ownerId: 27, user: actor })
    const ownershipEvent = writeOutboxEvent.mock.calls.find(([, event]) => event.type === 'page.ownership-transferred')?.[1]
    expect(ownershipEvent?.payload).toMatchObject({ pageId: 42, visibility: 'private', ownerId: 27 })
    expect(await db('pages').where({ id: 42 }).first('visibility', 'ownerId')).toMatchObject({ visibility: 'private', ownerId: 27 })
  })

  it('moves locale identity, history, tree, links, projections, caches, search, and storage together', async () => {
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
    await db('pageHistory').insert({ pageId: 42, path: 'guides/identity', hash: oldHash, visibility: 'public', ownerId: null, localeCode: 'en' })
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

    expect(await db('pages').where({ id: 42 }).first('localeCode', 'hash')).toMatchObject({ localeCode: 'fr', hash: newHash })
    expect(await db('pageHistory').where({ pageId: 42 }).select('localeCode', 'hash')).toEqual(
      expect.arrayContaining([expect.objectContaining({ localeCode: 'fr', hash: newHash })])
    )
    expect(await db('pageTree').where({ pageId: 42 }).first('localeCode', 'path')).toMatchObject({ localeCode: 'fr', path: 'guides/identity' })
    expect(await db('pageLinks').where({ pageId: 84 }).first('localeCode', 'path')).toMatchObject({ localeCode: 'fr', path: 'guides/identity' })
    expect((await db('pages').where({ id: 84 }).first('render')).render).toContain('/fr/guides/identity')
    expect(enqueuePageMutationEffects).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'move',
        location: expect.objectContaining({ locale: 'fr' }),
        previousLocation: expect.objectContaining({ locale: 'en' })
      })
    )
    expect(await Page.getPageFromCache({ path: 'guides/identity', locale: 'en', visibility: 'public', ownerId: null })).toBe(false)
    const movedEvent = writeOutboxEvent.mock.calls.find(([, event]) => event.type === 'page.moved')?.[1]
    expect(movedEvent?.payload).toMatchObject({ actorId: 11, localeCode: 'fr' })
    expect(await Page.getPageFromCache({ path: 'guides/identity', locale: 'fr', visibility: 'public', ownerId: null })).toBe(false)
    await expect(Page.getPage({ path: 'guides/identity', locale: 'en', visibility: 'public', ownerId: null })).resolves.toBeUndefined()
    await expect(Page.getPage({ path: 'guides/identity', locale: 'fr', visibility: 'public', ownerId: null })).resolves.toMatchObject({
      hash: newHash,
      localeCode: 'fr'
    })
    expect(searchRenamed).toHaveBeenCalledWith(expect.objectContaining({ localeCode: 'en', destinationLocaleCode: 'fr', destinationHash: newHash }))
    expect(storagePageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'renamed',
        page: expect.objectContaining({ moveAuthorId: 11, moveAuthorName: 'Administrator', destinationLocaleCode: 'fr' })
      })
    )
  })

  it('rolls every database-owned identity back when projection enqueue fails', async () => {
    const oldHash = generatePageHash({ path: 'guides/identity', locale: 'en', visibility: 'public', ownerId: null })
    await db('pages').insert(pageRow({ hash: oldHash }))
    await db('pageHistory').insert({ pageId: 42, path: 'guides/identity', hash: oldHash, visibility: 'public', ownerId: null, localeCode: 'en' })
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
    enqueuePageMutationEffects.mockRejectedValueOnce(new Error('projection enqueue failed'))

    await expect(Page.migrateToLocale({ sourceLocale: 'en', targetLocale: 'fr', user: actor })).rejects.toThrow('projection enqueue failed')

    expect(await db('pages').where({ id: 42 }).first('localeCode', 'hash')).toMatchObject({ localeCode: 'en', hash: oldHash })
    expect(await db('pageHistory').where({ pageId: 42 }).select('localeCode', 'hash')).toEqual([expect.objectContaining({ localeCode: 'en', hash: oldHash })])
    expect(await db('pageTree').where({ pageId: 42 }).first('localeCode')).toMatchObject({ localeCode: 'en' })
    expect(storagePageEvent).not.toHaveBeenCalled()
    expect(searchRenamed).not.toHaveBeenCalled()
    expect(outboundEmit).not.toHaveBeenCalledWith('deletePageFromCache', expect.anything())
  })
})
