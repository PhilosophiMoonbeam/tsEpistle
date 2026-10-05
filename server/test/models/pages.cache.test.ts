import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'fs-extra'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type PageModel from '../../models/pages.ts'
import errors from '../../helpers/error.ts'


const localeRelationMovePatch = vi.fn(async () => ({}))
const writeOutboxEvent = vi.fn(async () => undefined)
const enqueuePageMutationEffects = vi.fn(async () => undefined)
const redactProtectedPageForSearch = vi.fn(async () => undefined)
const syncProtectedPageAssets = vi.fn(async () => undefined)
const protectedAssetRequiresUnlock = vi.fn(async () => false)

vi.mockModule('../../helpers/page-locale-relations.ts', import.meta.url, () => ({ localeRelationMovePatch }))
vi.mockModule('../../core/outbox.ts', import.meta.url, () => ({ writeOutboxEvent }))
vi.mockModule('../../core/page-mutation-outbox.ts', import.meta.url, () => ({
  enqueuePageMutationEffects,
  admitPageRenderEffect: vi.fn(async () => ({ effectId: 'render-effect', sourceRevision: '1' }))
}))
vi.mockModule('../../operations/page-protection.ts', import.meta.url, () => ({
  redactProtectedPageForSearch,
  syncProtectedPageAssets,
  pageRequiresUnlock: vi.fn(async () => false),
  protectedAssetRequiresUnlock
}))

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
let tempRoot: string
let Page: typeof PageModel
let transactionPageProjection: Record<string, unknown> | undefined
let cacheIdentityMarker:
  | {
      id: number
      hash: string
      sourceRevision: string | number
      renderedSourceRevision: string | number | null
      render: string
      toc: string
      path: string
      localeCode: string
      visibility: 'public' | 'private'
      ownerId: number | null
      isSearchable: boolean
    }
  | undefined

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-page-cache-'))
  transactionPageProjection = undefined
  cacheIdentityMarker = undefined
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
    { raw: vi.fn(), client: { config: { client: 'pg' } } }
  )
  const markerQuery = {
    select: vi.fn(),
    where: vi.fn(),
    first: vi.fn()
  }
  markerQuery.select.mockReturnValue(markerQuery)
  markerQuery.where.mockImplementation((identity: Record<string, unknown>) => {
    const matches =
      cacheIdentityMarker !== undefined &&
      cacheIdentityMarker.path === identity.path &&
      cacheIdentityMarker.localeCode === identity.localeCode &&
      cacheIdentityMarker.visibility === identity.visibility &&
      cacheIdentityMarker.ownerId === identity.ownerId
    markerQuery.first.mockResolvedValue(matches ? cacheIdentityMarker : undefined)
    return markerQuery
  })
  const transaction = vi.fn(async (callback: (trx: typeof knexTransaction) => Promise<unknown>) => callback(knexTransaction))
  const knex = Object.assign(
    vi.fn((table?: string) => {
      if (table !== 'pages') throw new Error(`Unexpected table ${String(table)}`)
      return markerQuery
    }),
    { transaction }
  )
  const checkAccess = vi.fn().mockReturnValue(true)
  const loadPageRuleAuthority = vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
  wikiGlobal.WIKI = {
    ROOTPATH: tempRoot,
    Error: errors,
    auth: { checkAccess, checkPageAccess: checkAccess, loadPageRuleAuthority },
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
  it('evicts the old location and serves a later renderer cache at the committed location', async () => {
    // page.ts captures WIKI at module evaluation, so load it after installing the isolated test global.
    const pageHelper = (await import('../../helpers/page.ts')).default
    const oldPath = 'guides/old-location'
    const newPath = 'guides/new-location'
    const locale = 'en'
    const ownerId = 7
    const oldHash = pageHelper.generateHash({ path: oldPath, locale, visibility: 'private', ownerId })
    const newHash = pageHelper.generateHash({ path: newPath, locale, visibility: 'private', ownerId })
    const oldTags: Array<{ tag: string }> = []
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
      isSearchable: true,
      localeCode: locale,
      ownerId,
      path: oldPath,
      publishEndDate: '',
      publishStartDate: '',
      render: '<p>stale old-path render</p>',
      sourceRevision: '1',
      renderedSourceRevision: '1',
      tags: oldTags,
      $relatedQuery: vi.fn(async (relation: string) => relation === 'tags' ? oldTags : []),
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
    transactionPageProjection = { ...movedPage, updatedAt: oldPage.updatedAt }
    cacheIdentityMarker = oldPage
    const oldLookup = { path: oldPath, locale, visibility: 'private' as const, ownerId }
    const newLookup = { path: newPath, locale, visibility: 'private' as const, ownerId }

    await Page.savePageToCache(oldPage as never)
    expect(await Page.getPageFromCache(oldLookup)).toMatchObject({ render: '<p>stale old-path render</p>' })
    await Page.savePageToCache({ ...movedPage, render: '<p>stale destination render</p>' } as never)
    const oldCachePath = path.join(tempRoot, 'data', 'cache', `${oldHash}.bin`)
    const newCachePath = path.join(tempRoot, 'data', 'cache', `${newHash}.bin`)
    expect(await fs.pathExists(newCachePath)).toBe(true)

    const patch = vi.fn()
    const where = vi.fn()
    const patchBuilder: Record<string, unknown> & PromiseLike<number> = {
      patch,
      where,
      findOne: vi.fn(async () => undefined),
      then: (resolve, reject) => Promise.resolve(1).then(resolve, reject)
    }
    patch.mockReturnValue(patchBuilder)
    where.mockReturnValue(patchBuilder)
    let readQueryCount = 0
    vi.spyOn(Page, 'query').mockImplementation(((transaction?: unknown) => {
      if (transaction !== undefined) return patchBuilder
      readQueryCount += 1
      if (readQueryCount === 1) return { findById: vi.fn(async () => oldPage) }
      if (readQueryCount === 2) {
        return {
          findById: vi.fn(() => ({
            select: vi.fn(async () => ({ updatedAt: movedPage.updatedAt, sourceRevision: movedPage.sourceRevision }))
          }))
        }
      }
      throw new Error(`Unexpected page query ${readQueryCount}`)
    }) as never)
    vi.spyOn(Page, 'getPageFromDb').mockImplementation(async opts => (typeof opts === 'number' ? (movedPage as never) : undefined))
    vi.spyOn(Page, 'rebuildTree').mockResolvedValue(undefined)

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
    expect(await fs.pathExists(oldCachePath)).toBe(false)
    expect(await fs.pathExists(newCachePath)).toBe(false)

    cacheIdentityMarker = movedPage
    await Page.savePageToCache(movedPage as never)
    expect(await Page.getPageFromCache(newLookup)).toMatchObject({
      path: newPath,
      render: '<p>fresh new-path render</p>'
    })
    expect(await Page.getPage(oldLookup)).toBeUndefined()
  })

  it('fails a stale public cache read closed after a committed privacy transition', async () => {
    const pageHelper = (await import('../../helpers/page.ts')).default
    const publicIdentity = { path: 'security/private-now', locale: 'en', visibility: 'public' as const, ownerId: null }
    const publicHash = pageHelper.generateHash(publicIdentity)
    const publicPage = {
      id: 77,
      sourceRevision: '4',
      renderedSourceRevision: '4',
      authorId: 7,
      authorName: 'Owner',
      creatorId: 7,
      creatorName: 'Owner',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T01:00:00.000Z',
      description: 'Formerly public',
      editorKey: 'markdown',
      extra: {},
      hash: publicHash,
      isPublished: true,
      isSearchable: true,
      localeCode: 'en',
      ownerId: null,
      path: publicIdentity.path,
      publishEndDate: '',
      publishStartDate: '',
      contentType: 'markdown',
      render: '<p>must not escape after commit</p>',
      tags: [],
      title: 'Private now',
      toc: '[]',
      visibility: 'public' as const
    }
    cacheIdentityMarker = publicPage
    await Page.savePageToCache(publicPage as never)
    await expect(Page.getPageFromCache(publicIdentity)).resolves.toMatchObject({ render: publicPage.render })

    cacheIdentityMarker = {
      ...publicPage,
      sourceRevision: '5',
      hash: pageHelper.generateHash({ ...publicIdentity, visibility: 'private', ownerId: 7 }),
      visibility: 'private',
      ownerId: 7
    }

    await expect(Page.getPageFromCache(publicIdentity)).resolves.toBe(false)
    await expect(fs.pathExists(path.join(tempRoot, 'data', 'cache', `${publicHash}.bin`))).resolves.toBe(false)
  })

  it('rejects a delayed cache during same-revision invalidation and after replacement publication', async () => {
    // The helper captures WIKI at evaluation; static import would bind the pre-fixture global.
    const pageHelper = (await import('../../helpers/page.ts')).default
    const identity = { path: 'render/same-revision', locale: 'en', visibility: 'public' as const, ownerId: null }
    const hash = pageHelper.generateHash(identity)
    const certifiedPage = {
      id: 88,
      hash,
      sourceRevision: '7',
      renderedSourceRevision: '7' as string | null,
      authorId: 7,
      authorName: 'Owner',
      creatorId: 7,
      creatorName: 'Owner',
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T01:00:00.000Z',
      description: 'Same source, changing render',
      editorKey: 'markdown',
      extra: {},
      isPublished: true,
      isSearchable: true,
      localeCode: 'en',
      ownerId: null,
      path: identity.path,
      publishEndDate: '',
      publishStartDate: '',
      contentType: 'markdown',
      render: '<p>old certified publication</p>',
      content: 'unchanged source',
      tags: [],
      title: 'Same revision',
      toc: '[]',
      visibility: 'public' as const
    }
    cacheIdentityMarker = certifiedPage
    await Page.savePageToCache(certifiedPage as never)
    await expect(Page.getPage(identity)).resolves.toMatchObject({ render: certifiedPage.render })

    const pendingPage = { ...certifiedPage, renderedSourceRevision: null, render: '', toc: '[]' }
    cacheIdentityMarker = pendingPage
    const canonicalRead = vi.spyOn(Page, 'getPageFromDb').mockResolvedValue(pendingPage as never)
    // A worker that started earlier writes its old bytes after invalidation committed.
    await Page.savePageToCache(certifiedPage as never)
    await expect(Page.getPage(identity)).rejects.toMatchObject({ name: 'PAGE_RENDER_PENDING', status: 503 })
    await expect(fs.pathExists(path.join(tempRoot, 'data', 'cache', `${hash}.bin`))).resolves.toBe(false)

    const replacementPage = { ...certifiedPage, render: '<p>new certified publication</p>', toc: '[{"title":"New"}]' }
    cacheIdentityMarker = replacementPage
    canonicalRead.mockResolvedValue(replacementPage as never)
    await Page.savePageToCache(certifiedPage as never)
    await expect(Page.getPage(identity)).resolves.toMatchObject({ render: replacementPage.render, toc: replacementPage.toc })
    await expect(Page.getPageFromCache(identity)).resolves.toMatchObject({ render: replacementPage.render, toc: replacementPage.toc })

    // TOC alone is part of the publication identity, even when HTML is unchanged.
    await Page.savePageToCache({ ...replacementPage, toc: certifiedPage.toc } as never)
    await expect(Page.getPageFromCache(identity)).resolves.toBe(false)
  })
})
