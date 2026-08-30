import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type PageModel from '../../models/pages.ts'

const localeRelationMovePatch = vi.fn(async () => ({}))
const writeOutboxEvent = vi.fn(async () => undefined)
const enqueuePageMutationEffects = vi.fn(async () => undefined)
const redactProtectedPageForSearch = vi.fn(async () => undefined)
const syncProtectedPageAssets = vi.fn(async () => undefined)

vi.mockModule('../../helpers/page-locale-relations.ts', import.meta.url, () => ({ localeRelationMovePatch }))
vi.mockModule('../../core/outbox.ts', import.meta.url, () => ({ writeOutboxEvent }))
vi.mockModule('../../core/page-mutation-outbox.ts', import.meta.url, () => ({ enqueuePageMutationEffects }))
vi.mockModule('../../operations/page-protection.ts', import.meta.url, () => ({ redactProtectedPageForSearch, syncProtectedPageAssets }))

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
let tempRoot: string
let Page: typeof PageModel
let transactionPageProjection: Record<string, unknown> | undefined

const pageErrorNames = [
  'PageDeleteForbidden',
  'PageDuplicateCreate',
  'PageEmptyContent',
  'PageIllegalPath',
  'PageMoveForbidden',
  'PageNotFound',
  'PagePathCollision',
  'PageUpdateForbidden'
]

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-page-cache-'))
  transactionPageProjection = undefined
  const projectionQuery = {
    select: vi.fn(),
    where: vi.fn(),
    forUpdate: vi.fn(),
    first: vi.fn(async () => transactionPageProjection)
  }
  projectionQuery.select.mockReturnValue(projectionQuery)
  projectionQuery.where.mockReturnValue(projectionQuery)
  projectionQuery.forUpdate.mockReturnValue(projectionQuery)
  const knexTransaction = Object.assign(
    vi.fn((table: string) => {
      if (table !== 'pages') throw new Error(`Unexpected transaction table ${table}`)
      return projectionQuery
    }),
    { raw: vi.fn() }
  )
  const transaction = vi.fn(async (callback: (trx: typeof knexTransaction) => Promise<unknown>) => callback(knexTransaction))
  const knex = Object.assign(vi.fn(), { transaction })
  const errors = Object.fromEntries(pageErrorNames.map(name => [name, class extends Error {}]))

  wikiGlobal.WIKI = {
    ROOTPATH: tempRoot,
    Error: errors,
    auth: { checkAccess: vi.fn().mockReturnValue(true) },
    collaboration: { pageChanged: vi.fn(async () => undefined) },
    config: { dataPath: 'data', db: { type: 'postgres' } },
    data: {
      editors: [],
      searchEngine: {
        created: vi.fn(),
        deleted: vi.fn(),
        renamed: vi.fn(),
        updated: vi.fn()
      }
    },
    events: { inbound: new EventEmitter(), outbound: new EventEmitter() },
    logger: { error: vi.fn(), warn: vi.fn() },
    models: {
      comments: {},
      knex,
      pageHistory: { addVersion: vi.fn(async () => undefined) },
      pages: {},
      storage: { pageEvent: vi.fn(async () => undefined) },
      tags: {}
    },
    scheduler: { registerJob: vi.fn() }
  }

  // pages.ts captures WIKI at module evaluation, so each test needs a fresh import after installing its isolated global.
  Page = (await vi.importFresh('../../models/pages.ts', import.meta.url)).default
  ;(wikiGlobal.WIKI.models as Record<string, unknown>).pages = Page
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.remove(tempRoot)
  if (originalWiki === undefined) delete wikiGlobal.WIKI
  else wikiGlobal.WIKI = originalWiki
})

describe('models/pages.updatePage cache invalidation', () => {
  it('removes the writer cache for the old path without deleting the newly rendered cache', async () => {
    // page.ts captures WIKI at module evaluation, so load it after installing the isolated test global.
    const pageHelper = (await import('../../helpers/page.ts')).default
    const oldPath = 'guides/old-location'
    const newPath = 'guides/new-location'
    const locale = 'en'
    const ownerId = 7
    const oldHash = pageHelper.generateHash({ path: oldPath, locale, visibility: 'private', ownerId })
    const newHash = pageHelper.generateHash({ path: newPath, locale, visibility: 'private', ownerId })
    const oldPage = {
      id: 42,
      authorId: ownerId,
      authorName: 'Owner',
      authorEmail: 'owner@example.com',
      creatorId: ownerId,
      creatorName: 'Owner',
      creatorEmail: 'owner@example.com',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T01:00:00.000Z',
      content: '# Cached at the old path',
      contentType: 'markdown',
      description: 'Old location',
      editorKey: 'markdown',
      extra: {},
      hash: oldHash,
      isPublished: true,
      localeCode: locale,
      ownerId,
      path: oldPath,
      publishEndDate: '',
      publishStartDate: '',
      render: '<p>stale old-path render</p>',
      sourceRevision: undefined,
      tags: [],
      title: 'Moved page',
      toc: '[]',
      visibility: 'private'
    }
    const movedPage = {
      ...oldPage,
      hash: newHash,
      path: newPath,
      render: '<p>fresh new-path render</p>',
      updatedAt: '2026-08-29T02:00:00.000Z'
    }
    transactionPageProjection = movedPage
    const oldLookup = { path: oldPath, locale, visibility: 'private' as const, ownerId }
    const newLookup = { path: newPath, locale, visibility: 'private' as const, ownerId }

    await Page.savePageToCache(oldPage as never)
    expect(await Page.getPageFromCache(oldLookup)).toMatchObject({ render: '<p>stale old-path render</p>' })

    const patch = vi.fn()
    const where = vi.fn()
    const patchBuilder: Record<string, unknown> & PromiseLike<number> = {
      patch,
      where,
      then: (resolve, reject) => Promise.resolve(1).then(resolve, reject)
    }
    patch.mockReturnValue(patchBuilder)
    where.mockReturnValue(patchBuilder)
    let readQueryCount = 0
    vi.spyOn(Page, 'query').mockImplementation(((transaction?: unknown) => {
      if (transaction !== undefined) return patchBuilder
      readQueryCount += 1
      if (readQueryCount === 1) return { findById: vi.fn(async () => oldPage) }
      if (readQueryCount === 2) return { findOne: vi.fn(async () => undefined) }
      if (readQueryCount === 3) {
        return {
          findById: vi.fn(() => ({
            select: vi.fn(async () => ({ updatedAt: movedPage.updatedAt }))
          }))
        }
      }
      throw new Error(`Unexpected page query ${readQueryCount}`)
    }) as never)
    vi.spyOn(Page, 'getPageFromDb').mockImplementation(async opts => (typeof opts === 'number' ? (movedPage as never) : undefined))
    vi.spyOn(Page, 'renderPage').mockImplementation(async page => {
      await Page.savePageToCache(page)
    })
    vi.spyOn(Page, 'rebuildTree').mockResolvedValue(undefined)
    const deletePageFromCache = Page.deletePageFromCache.bind(Page)
    const deletedHashes: string[] = []
    vi.spyOn(Page, 'deletePageFromCache').mockImplementation(async hash => {
      deletedHashes.push(hash)
      await deletePageFromCache(hash)
    })

    await Page.updatePage({
      id: oldPage.id,
      path: newPath,
      user: {
        id: ownerId,
        name: 'Owner',
        email: 'owner@example.com',
        permissions: []
      } as Express.User & { id: number; name: string; email: string }
    })

    expect(deletedHashes).toEqual([oldHash])
    expect(deletedHashes).not.toContain(newHash)
    expect(await Page.getPageFromCache(newLookup)).toMatchObject({
      path: newPath,
      render: '<p>fresh new-path render</p>'
    })
    expect(await Page.getPage(oldLookup)).toBeUndefined()
  })
})
