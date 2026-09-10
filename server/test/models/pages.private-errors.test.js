import { EventEmitter } from 'node:events'
import createKnex from 'knex'
import { beforeEach, afterEach, describe, expect, it, vi } from '../bun-test.mts'
import { createApiPrincipal } from '../../helpers/api-principal.ts'


const originalWIKI = global.WIKI

class PageNotFound extends Error {}
class PageUpdateForbidden extends Error {}
class PageMoveForbidden extends Error {}
class PageDeleteForbidden extends Error {}

const authorityFor = requester => ({ requester, permissions: [], groups: [], tagAliases: {} })
const privatePageTags = []
const privatePage = {
  id: 17,
  path: 'secret',
  localeCode: 'en',
  visibility: 'private',
  ownerId: 7,
  editorKey: 'markdown',
  tags: privatePageTags,
  $relatedQuery: vi.fn(async (relation, _transaction) => relation === 'tags' ? privatePageTags : [])
}

describe('private page mutation existence isolation', () => {
  let Page

  beforeEach(async () => {
    vi.resetModules()
    const mutationOutboxRows = []
    const knex = vi.fn(table => {
      if (table === 'pages') {
        return {
          select: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          forUpdate: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue({
            id: 17,
            sourceRevision: '2',
            updatedAt: '2026-08-14T00:00:00.000Z',
            content: 'changed content',
            localeCode: 'en',
            path: 'secret',
            visibility: 'private',
            ownerId: 7
          }),
          update: vi.fn().mockResolvedValue(1)
        }
      }
      if (table === 'pageAccessPasswords') {
        return {
          where: vi.fn().mockReturnThis(),
          first: vi.fn().mockResolvedValue(undefined)
        }
      }
      if (table === 'pageMutationOutbox') {
        return {
          insert: vi.fn(row => {
            const rows = Array.isArray(row) ? row : [row]
            mutationOutboxRows.push(...rows)
            return { onConflict: vi.fn().mockReturnValue({ ignore: vi.fn().mockResolvedValue([]) }) }
          }),
          where: vi.fn(criteria => ({
            first: vi.fn().mockResolvedValue(
              mutationOutboxRows.find(candidate =>
                Object.entries(criteria).every(([key, value]) => String(candidate[key]) === String(value))
              )
            )
          }))
        }
      }
      return { insert: vi.fn().mockResolvedValue(1) }
    })
    knex.transaction = vi.fn(callback => callback(knex))
    global.WIKI = {
      ROOTPATH: '/test',
      Error: {
        PageDeleteForbidden,
        PageDuplicateCreate: Error,
        PageEmptyContent: Error,
        PageIllegalPath: Error,
        PageMoveForbidden,
        PageNotFound,
        PagePathCollision: Error,
        PageUpdateForbidden
      },
      auth: {
        checkAccess: vi.fn().mockReturnValue(false),
        checkPageAccess: vi.fn().mockReturnValue(false),
        loadPageRuleAuthority: vi.fn(async requester => authorityFor(requester))
      },
      config: { dataPath: '/test/data', db: { type: 'postgres' }, lang: { code: 'en' } },
      data: {
        editors: [{ key: 'markdown', contentType: 'markdown' }],
        reservedPaths: [],
        searchEngine: { created: vi.fn(), updated: vi.fn(), deleted: vi.fn(), renamed: vi.fn() }
      },
      events: { inbound: new EventEmitter(), outbound: new EventEmitter() },
      logger: { error: vi.fn(), warn: vi.fn() },
      models: {
        comments: {},
        knex,
        pageHistory: { addVersion: vi.fn() },
        pages: {},
        storage: { pageEvent: vi.fn() },
        tags: {
          associateTags: vi.fn(({ tags, page }) => {
            page.tags = tags.map(tag => ({ tag }))
          })
        }
      },
      scheduler: { registerJob: vi.fn() }
    }
    Page = (await vi.importFresh('../../models/pages.ts', import.meta.url)).default
    global.WIKI.models.pages = Page
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalWIKI === undefined) delete global.WIKI
    else global.WIKI = originalWIKI
  })

  it('uses the deleting query transaction for comment cleanup', async () => {
    const transaction = { id: 'delete-transaction' }
    const where = vi.fn().mockResolvedValue(1)
    const deleteRelated = vi.fn().mockReturnValue({ where })
    const commentsQuery = vi.fn().mockReturnValue({ delete: deleteRelated })
    global.WIKI.models.comments = { query: commentsQuery }

    await Page.beforeDelete({
      asFindQuery: () => ({ select: vi.fn().mockResolvedValue([{ id: 17 }]) }),
      transaction
    })

    expect(commentsQuery).toHaveBeenCalledWith(transaction)
    expect(where).toHaveBeenCalledWith('pageId', 17)
  })

  const requester = { id: 8, permissions: ['write:pages', 'delete:pages'] }
  it('rejects an API principal before reading or mutating a page', async () => {
    const api = createApiPrincipal(7, 3, ['write:pages'])
    const lookup = vi.spyOn(Page, 'query')

    await expect(Promise.resolve(Page.updatePage({ id: 17, user: api, content: 'changed' }))).rejects.toMatchObject({
      code: 'API_KEY_MUTATION_FORBIDDEN',
      status: 403
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('returns not found before update or editor-conversion details can leak', async () => {
    vi.spyOn(Page, 'query').mockReturnValue({ findById: vi.fn().mockResolvedValue(privatePage) })

    await expect(Promise.resolve(Page.updatePage({ id: 17, user: requester, content: 'changed' }))).rejects.toBeInstanceOf(PageNotFound)
    await expect(Promise.resolve(Page.convertPage({ id: 17, user: requester, editor: 'markdown' }))).rejects.toBeInstanceOf(PageNotFound)
  })

  it('returns not found before move path validation can leak a private id', async () => {
    vi.spyOn(Page, 'query').mockReturnValue({ findById: vi.fn().mockResolvedValue(privatePage) })

    await expect(Promise.resolve(Page.movePage({
      id: 17,
      user: requester,
      destinationLocale: 'en',
      destinationPath: 'invalid path'
    }))).rejects.toBeInstanceOf(PageNotFound)
  })

  it('returns not found for direct deletion by a non-owner', async () => {
    vi.spyOn(Page, 'getPageFromDb').mockResolvedValue(privatePage)

    await expect(Promise.resolve(Page.deletePage({ id: 17, user: requester }))).rejects.toBeInstanceOf(PageNotFound)
  })

  it('preserves omitted optional fields and tags during a partial update', async () => {
    const owner = { id: 7, permissions: [] }
    const originalPage = {
      ...privatePage,
      authorId: 7,
      content: 'original content',
      contentType: 'markdown',
      description: 'original description',
      extra: { css: '.original{}', js: 'original()' },
      hash: 'private:7:en:secret',
      isPublished: true,
      publishEndDate: '2030-01-01T00:00:00.000Z',
      publishStartDate: '2026-01-01T00:00:00.000Z',
      title: 'Original title',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }
    const updatedPage = {
      ...originalPage,
      content: 'changed content',
      title: 'Changed title',
    }
    const patch = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(1) })
    const query = vi.fn()
      .mockReturnValueOnce({ findById: vi.fn().mockResolvedValue(originalPage) })
      .mockReturnValueOnce({ patch })
      .mockReturnValueOnce({
        findById: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({ updatedAt: '2026-08-14T00:01:00.000Z' })
        })
      })
    const associateTags = vi.fn()
    global.WIKI.models.pages = {
      query,
      getPageFromDb: vi.fn().mockResolvedValue(updatedPage),
      renderPage: vi.fn().mockResolvedValue(undefined)
    }
    global.WIKI.models.tags = { associateTags }
    global.WIKI.models.knex.table = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue(1) })
    })

    expect(await Page.updatePage({
      id: 17,
      user: owner,
      content: 'changed content',
      title: 'Changed title'
    })).toMatchObject({ content: 'changed content', title: 'Changed title' })

    expect(patch).toHaveBeenCalledWith(expect.objectContaining({
      content: 'changed content',
      description: 'original description',
      isPublished: true,
      publishEndDate: '2030-01-01T00:00:00.000Z',
      publishStartDate: '2026-01-01T00:00:00.000Z',
      title: 'Changed title',
      extra: expect.objectContaining({
        css: '.original{}',
        js: 'original()',
        okf: expect.objectContaining({
          type: 'Reference',
          status: 'stable',
          generated: expect.objectContaining({ by: 'human:7', at: expect.any(String) })
        })
      })
    }))
    expect(associateTags).not.toHaveBeenCalled()
  })

  it('does not churn history or trust for a no-op authoritative OKF write', async () => {
    const owner = { id: 7, permissions: [] }
    const originalPage = {
      ...privatePage,
      authorId: 3,
      content: '# Runbook',
      contentType: 'markdown',
      description: '',
      extra: {
        css: '',
        js: '',
        okf: {
          type: 'Reference',
          status: 'stable',
          generated: { by: 'human:3', at: '2026-08-01T00:00:00.000Z' },
          verified: { by: 'human:9', at: '2026-08-02T00:00:00.000Z' }
        }
      },
      hash: 'private:7:en:secret',
      isPublished: true,
      publishEndDate: '',
      publishStartDate: '',
      sourceRevision: '2',
      title: 'Runbook',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }
    const getPageFromDb = vi.fn().mockResolvedValue(originalPage)
    const query = vi.fn().mockReturnValue({ findById: vi.fn().mockResolvedValue(originalPage) })
    global.WIKI.models.pages = { query, getPageFromDb }

    const result = await Page.updatePage({
      id: 17,
      user: owner,
      okfMetadata: {
        type: 'Reference',
        status: 'stable',
        generated: { by: 'human:999', at: '2026-08-30T00:00:00.000Z' },
        verified: { by: 'human:999', at: '2026-08-30T00:00:00.000Z' }
      },
      replaceOkfMetadata: true,
      expectedSourceRevision: '2'
    })

    expect(result).toBe(originalPage)

    expect(global.WIKI.models.pageHistory.addVersion).not.toHaveBeenCalled()
  })

  it('stamps producer provenance and clears verification through the real update operation', async () => {
    const owner = { id: 7, name: 'Owner', email: 'owner@example.test', permissions: [] }
    const originalExtra = {
      css: '',
      js: '',
      okf: {
        type: 'Reference',
        status: 'stable',
        generated: { by: 'human:3', at: '2026-08-01T00:00:00.000Z' },
        verified: { by: 'human:9', at: '2026-08-02T00:00:00.000Z' }
      }
    }
    const originalPage = {
      ...privatePage,
      authorId: 3,
      content: '# Runbook',
      contentType: 'markdown',
      description: '',
      extra: originalExtra,
      hash: 'private:7:en:secret',
      isPublished: true,
      publishEndDate: '',
      publishStartDate: '',
      sourceRevision: '2',
      title: 'Runbook',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }
    let persistedPage = { ...originalPage, sourceRevision: '3' }
    const patchQuery = {
      where: vi.fn(),
      then: vi.fn(resolve => resolve(1))
    }
    patchQuery.where.mockReturnValue(patchQuery)
    const patch = vi.fn(value => {
      persistedPage = { ...persistedPage, ...value }
      return patchQuery
    })
    const query = vi.fn()
      .mockReturnValueOnce({ findById: vi.fn().mockResolvedValue(originalPage) })
      .mockReturnValueOnce({ patch })
      .mockReturnValueOnce({
        findById: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({ updatedAt: '2026-08-14T00:01:00.000Z' })
        })
      })
    global.WIKI.models.pages = Page
    vi.spyOn(Page, 'query').mockImplementation(query)
    vi.spyOn(Page, 'getPageFromDb').mockImplementation(async () => persistedPage)
    vi.spyOn(Page, 'renderPage').mockResolvedValue(undefined)
    vi.spyOn(Page, 'deletePageFromCache').mockResolvedValue(undefined)
    global.WIKI.models.knex.table = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue(1) })
    })

    const operations = (await vi.importFresh('../../operations/pages.ts', import.meta.url)).default
    const { OKF_PRODUCER_CONTEXT } = await import('../../okf/mutation-context.ts')
    const result = await operations.update({
      requester: owner,
      [OKF_PRODUCER_CONTEXT]: 'agent:authority-request',
      input: {
        id: 17,
        okfMetadata: { type: 'Procedure', status: 'stable' },
        replaceOkfMetadata: false,
        expectedSourceRevision: '2'
      }
    })

    expect(result).toBe(persistedPage)
    expect(result.extra.okf).toMatchObject({
      type: 'Procedure',
      generated: { by: 'agent:authority-request', at: expect.any(String) }
    })
    expect(result.extra.okf).not.toHaveProperty('verified')
    expect(result.sourceRevision).toBe('3')
    expect(global.WIKI.models.pageHistory.addVersion).toHaveBeenCalledWith(expect.objectContaining({
      sourceRevision: '2',
      extra: originalExtra
    }))
  })


  it.each([
    [
      'inherited',
      () =>
        Object.assign(Object.create({ okfMetadata: { type: 'Metric' } }), {
          id: 17,
          title: 'Inherited metadata ignored',
          expectedSourceRevision: '2'
        })
    ],
    ['omitted', () => ({ id: 17, title: 'Omitted metadata ignored', expectedSourceRevision: '2' })]
  ])('keeps %s OKF metadata out of the real update result', async (_kind, makeInput) => {
    const owner = { id: 7, name: 'Owner', email: 'owner@example.test', permissions: [] }
    const originalPage = {
      ...privatePage,
      authorId: 7,
      content: '# Runbook',
      contentType: 'markdown',
      description: '',
      extra: {
        css: '',
        js: '',
        okf: {
          type: 'Reference',
          status: 'stable',
          generated: { by: 'human:3', at: '2026-08-01T00:00:00.000Z' },
          verified: { by: 'human:9', at: '2026-08-02T00:00:00.000Z' }
        }
      },
      hash: 'private:7:en:secret',
      isPublished: true,
      publishEndDate: '',
      publishStartDate: '',
      sourceRevision: '2',
      title: 'Runbook',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }
    let persistedPage = { ...originalPage, sourceRevision: '3' }
    const patchQuery = {
      where: vi.fn(),
      then: vi.fn(resolve => resolve(1))
    }
    patchQuery.where.mockReturnValue(patchQuery)
    const patch = vi.fn(value => {
      persistedPage = { ...persistedPage, ...value }
      return patchQuery
    })
    const query = vi.fn()
      .mockReturnValueOnce({ findById: vi.fn().mockResolvedValue(originalPage) })
      .mockReturnValueOnce({ patch })
      .mockReturnValueOnce({
        findById: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({ updatedAt: '2026-08-14T00:01:00.000Z' })
        })
      })
    global.WIKI.models.pages = Page
    vi.spyOn(Page, 'query').mockImplementation(query)
    vi.spyOn(Page, 'getPageFromDb').mockImplementation(async () => persistedPage)
    vi.spyOn(Page, 'renderPage').mockResolvedValue(undefined)
    vi.spyOn(Page, 'deletePageFromCache').mockResolvedValue(undefined)
    global.WIKI.models.knex.table = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue(1) })
    })

    const operations = (await vi.importFresh('../../operations/pages.ts', import.meta.url)).default
    const result = await operations.update({ requester: owner, input: makeInput() })

    expect(result).toBe(persistedPage)
    expect(result.extra.okf).toMatchObject({ type: 'Reference' })
    expect(result.extra.okf).not.toMatchObject({ type: 'Metric' })
    expect(result.sourceRevision).toBe('3')
  })

  it('atomically replaces invalid stored OKF authority with server-owned valid metadata', async () => {
    const owner = { id: 7, permissions: [] }
    const originalExtra = {
      css: '',
      js: '',
      okf: {
        type: '',
        unsafeSecret: 'must-not-survive',
        verified: { by: 'human:9', at: '2026-08-02T00:00:00.000Z' }
      }
    }
    const originalPage = {
      ...privatePage,
      authorId: 3,
      content: '# Runbook',
      contentType: 'markdown',
      description: '',
      extra: originalExtra,
      hash: 'private:7:en:secret',
      isPublished: true,
      publishEndDate: '',
      publishStartDate: '',
      sourceRevision: '2',
      title: 'Runbook',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }
    const patchQuery = {
      where: vi.fn(),
      then: vi.fn(resolve => resolve(1))
    }
    patchQuery.where.mockReturnValue(patchQuery)
    const patch = vi.fn().mockReturnValue(patchQuery)
    const query = vi.fn()
      .mockReturnValueOnce({ findById: vi.fn().mockResolvedValue(originalPage) })
      .mockReturnValueOnce({ patch })
      .mockReturnValueOnce({
        findById: vi.fn().mockReturnValue({
          select: vi.fn().mockResolvedValue({ updatedAt: '2026-08-14T00:01:00.000Z' })
        })
      })
    const updatedPage = {
      ...originalPage,
      sourceRevision: '3',
      extra: {
        css: '',
        js: '',
        okf: {
          type: 'Procedure',
          status: 'stable',
          generated: { by: 'human:7', at: '2026-08-14T00:01:00.000Z' }
        }
      }
    }
    global.WIKI.models.pages = {
      query,
      getPageFromDb: vi.fn().mockResolvedValue(updatedPage),
      renderPage: vi.fn()
    }
    global.WIKI.models.knex.table = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue(1) })
    })

    const result = await Page.updatePage({
      id: 17,
      user: owner,
      okfMetadata: {
        type: 'Procedure',
        status: 'stable',
        generated: { by: 'human:999', at: '2026-08-30T00:00:00.000Z' },
        verified: { by: 'human:999', at: '2026-08-30T00:00:00.000Z' }
      },
      replaceOkfMetadata: true,
      expectedSourceRevision: '2'
    })

    const patchedOkf = patch.mock.calls[0][0].extra.okf
    expect(patchedOkf).toMatchObject({
      type: 'Procedure',
      status: 'stable',
      generated: { by: 'human:7', at: expect.any(String) }
    })
    expect(patchedOkf).not.toHaveProperty('verified')
    expect(patchedOkf).not.toHaveProperty('unsafeSecret')
    expect(result).toBe(updatedPage)
    expect(global.WIKI.models.knex.transaction).toHaveBeenCalledOnce()
    expect(query).toHaveBeenNthCalledWith(2, global.WIKI.models.knex)
    expect(global.WIKI.models.pageHistory.addVersion).toHaveBeenCalledWith(expect.objectContaining({
      sourceRevision: '2',
      extra: originalExtra,
      transaction: global.WIKI.models.knex
    }))
  })

  it.each([
    ['a missing replacement', { replaceOkfMetadata: true }, 'INVALID_OKF_ROOT'],
    ['an invalid replacement', { replaceOkfMetadata: true, okfMetadata: [] }, 'INVALID_OKF_ROOT'],
    ['a metadata merge', { okfMetadata: { type: 'Procedure' } }, 'INVALID_TYPE'],
    ['an ordinary content mutation', { content: '# Changed' }, 'INVALID_TYPE']
  ])('rejects invalid stored OKF authority during %s', async (_description, mutation, code) => {
    const originalPage = {
      ...privatePage,
      authorId: 3,
      content: '# Runbook',
      contentType: 'markdown',
      description: '',
      extra: { css: '', js: '', okf: { type: '' } },
      hash: 'private:7:en:secret',
      isPublished: true,
      publishEndDate: '',
      publishStartDate: '',
      sourceRevision: '2',
      title: 'Runbook',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }
    const query = vi.fn().mockReturnValue({ findById: vi.fn().mockResolvedValue(originalPage) })
    global.WIKI.models.pages = { query }

    await expect(Promise.resolve(Page.updatePage({
      id: 17,
      user: { id: 7, permissions: [] },
      expectedSourceRevision: '2',
      ...mutation
    }))).rejects.toMatchObject({ name: 'OkfDocumentError', code })

    expect(query).toHaveBeenCalledOnce()
    expect(global.WIKI.models.knex.transaction).not.toHaveBeenCalled()
    expect(global.WIKI.models.pageHistory.addVersion).not.toHaveBeenCalled()
  })

  it('stamps move provenance, clears verification, and reloads the immutable moved revision through the real move operation', async () => {
    const owner = { id: 7, name: 'Owner', email: 'owner@example.test', permissions: [] }
    const originalExtra = {
      css: '',
      js: '',
      okf: {
        type: 'Reference',
        status: 'stable',
        generated: { by: 'human:3', at: '2026-08-01T00:00:00.000Z' },
        verified: { by: 'human:9', at: '2026-08-02T00:00:00.000Z' }
      }
    }
    const originalPage = {
      ...privatePage,
      authorId: 3,
      content: '# Secret',
      contentType: 'markdown',
      description: '',
      extra: originalExtra,
      hash: 'private:7:en:secret',
      isPublished: true,
      publishEndDate: '',
      publishStartDate: '',
      sourceRevision: '2',
      title: 'secret',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }
    let persistedPage = {
      ...originalPage,
      path: 'renamed',
      title: 'renamed',
      hash: 'private:7:en:renamed',
      sourceRevision: '3'
    }
    const patch = vi.fn(value => {
      persistedPage = { ...persistedPage, ...value }
      return { where: vi.fn().mockResolvedValue(1) }
    })
    const query = vi.fn()
      .mockReturnValueOnce({ findById: vi.fn().mockResolvedValue(originalPage) })
      .mockReturnValueOnce({ findOne: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ patch })
    global.WIKI.models.pages = Page
    vi.spyOn(Page, 'query').mockImplementation(query)
    vi.spyOn(Page, 'getPageFromDb').mockImplementation(async () => persistedPage)
    vi.spyOn(Page, 'deletePageFromCache').mockResolvedValue(undefined)
    vi.spyOn(Page, 'rebuildTree').mockResolvedValue(undefined)

    const operations = (await vi.importFresh('../../operations/pages.ts', import.meta.url)).default
    const { OKF_PRODUCER_CONTEXT } = await import('../../okf/mutation-context.ts')
    await operations.move({
      requester: owner,
      input: {
        id: 17,
        destinationLocale: 'en',
        destinationPath: 'renamed',
        expectedSourceRevision: '2'
      },
      [OKF_PRODUCER_CONTEXT]: 'agent:move-request'
    })

    expect(persistedPage).toMatchObject({
      path: 'renamed',
      title: 'renamed',
      extra: {
        okf: {
          type: 'Reference',
          generated: { by: 'agent:move-request', at: expect.any(String) }
        }
      }
    })
    expect(persistedPage.extra.okf).not.toHaveProperty('verified')
    expect(persistedPage.sourceRevision).toBe('3')
    expect(global.WIKI.models.pageHistory.addVersion).toHaveBeenCalledWith(expect.objectContaining({
      action: 'moved',
      sourceRevision: '2',
      extra: originalExtra
    }))
  })


  it('advances OKF generation provenance when editor conversion rewrites the authoritative format', async () => {
    const owner = { id: 7, permissions: [] }
    const originalGeneratedAt = '2026-08-01T00:00:00.000Z'
    const originalExtra = {
      css: '.original{}',
      js: 'original()',
      okf: {
        type: 'Reference',
        status: 'stable',
        generated: { by: 'human:3', at: originalGeneratedAt },
        verified: [{ by: 'human:9', at: '2026-08-02T00:00:00.000Z' }]
      }
    }
    const originalPage = {
      ...privatePage,
      authorId: 7,
      content: '<h1>Runbook</h1><p>Body</p>',
      contentType: 'html',
      description: 'Original description',
      editorKey: 'html',
      extra: originalExtra,
      hash: 'private:7:en:secret',
      isPublished: true,
      publishEndDate: '',
      publishStartDate: '',
      sourceRevision: '2',
      title: 'Runbook',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }
    const convertedPage = { ...originalPage, content: '# Runbook\n\nBody', contentType: 'markdown', editorKey: 'markdown' }
    const patch = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(1) })
    const query = vi.fn()
      .mockReturnValueOnce({ findById: vi.fn().mockResolvedValue(originalPage) })
      .mockReturnValueOnce({ patch })
    global.WIKI.data.editors = [
      { key: 'html', contentType: 'html' },
      { key: 'markdown', contentType: 'markdown' }
    ]
    global.WIKI.models.pages = {
      query,
      getPageFromDb: vi.fn().mockResolvedValue(convertedPage),
      deletePageFromCache: vi.fn()
    }

    await Page.convertPage({ id: 17, user: owner, editor: 'markdown' })

    const patchValue = patch.mock.calls[0][0]
    expect(patchValue).toMatchObject({
      contentType: 'markdown',
      editorKey: 'markdown',
      extra: {
        css: '.original{}',
        js: 'original()',
        okf: {
          type: 'Reference',
          status: 'stable',
          generated: { by: 'human:7', at: expect.any(String) }
        }
      }
    })
    expect(patchValue.extra.okf.generated.at).not.toBe(originalGeneratedAt)
    expect(global.WIKI.models.pageHistory.addVersion).toHaveBeenCalledWith(expect.objectContaining({ extra: originalExtra }))
  })

  it('preserves OKF generation and trust metadata across visibility-only changes', async () => {
    const owner = { id: 7, permissions: [] }
    const originalExtra = {
      css: '',
      js: '',
      okf: {
        type: 'Reference',
        status: 'stable',
        generated: { by: 'human:3', at: '2026-08-01T00:00:00.000Z' },
        verified: [{ by: 'human:9', at: '2026-08-02T00:00:00.000Z' }]
      }
    }
    const originalPage = {
      ...privatePage,
      authorId: 7,
      content: '# Runbook',
      contentType: 'markdown',
      description: 'Original description',
      extra: originalExtra,
      hash: 'private:7:en:secret',
      isPublished: false,
      publishEndDate: '',
      publishStartDate: '',
      sourceRevision: '2',
      title: 'Runbook',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }
    const updatedPage = { ...originalPage, visibility: 'public', ownerId: null, extra: originalExtra }
    global.WIKI.auth.checkPageAccess.mockReturnValue(true)
    const patch = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(1) })
    const query = vi.fn()
      .mockReturnValueOnce({ findOne: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ patch })
    global.WIKI.models.pages = {
      query,
      getPageFromDb: vi.fn().mockResolvedValueOnce(originalPage).mockResolvedValueOnce(updatedPage),
      deletePageFromCache: vi.fn(),
      rebuildTree: vi.fn(),
      prepareSearchDocument: vi.fn(),
      reconnectLinks: vi.fn()
    }

    const result = await Page.changeVisibility({
      id: 17,
      user: owner,
      visibility: 'public',
      confirmPublication: true,
      skipStorage: true
    })

    expect(result.extra).toEqual(originalExtra)
    expect(patch.mock.calls[0][0]).not.toHaveProperty('extra')
    expect(global.WIKI.models.pageHistory.addVersion).toHaveBeenCalledWith(expect.objectContaining({ extra: originalExtra }))
  })

  it('authorizes public creation against normalized object-shaped tag context', () => {
    const user = { id: 7, permissions: [] }
    const authority = authorityFor(user)
    global.WIKI.auth.checkPageAccess.mockReturnValue(true)

    expect(Page.assertCreateAccess({
      path: 'docs',
      locale: 'en',
      visibility: 'public',
      tags: ['  Restricted ', 'restricted', 'Other'],
      user,
      authority
    })).toEqual(['restricted', 'other'])

    global.WIKI.auth.checkPageAccess.mockClear()
    global.WIKI.auth.checkPageAccess.mockReturnValue(false)
    let denied
    try {
      Page.assertCreateAccess({ path: 'docs', locale: 'en', visibility: 'public', tags: ['restricted'], user, authority })
    } catch (error) {
      denied = error
    }
    expect(denied).toMatchObject({ status: 403 })
  })

  it('keeps private creation owner semantics without applying public tag rules', () => {
    const owner = { id: 7, permissions: [] }
    const ownerAuthority = authorityFor(owner)
    global.WIKI.auth.checkAccess.mockClear()
    global.WIKI.auth.checkAccess.mockReturnValue(false)

    expect(Page.assertCreateAccess({
      path: 'secret',
      locale: 'en',
      visibility: 'private',
      tags: ['  Internal '],
      user: owner,
      authority: ownerAuthority
    })).toEqual(['internal'])
    expect(global.WIKI.auth.checkAccess).not.toHaveBeenCalled()

    const deniedOwner = { id: 2, permissions: [] }
    let denied
    try {
      Page.assertCreateAccess({ path: 'secret', locale: 'en', visibility: 'private', tags: [], user: deniedOwner, authority: authorityFor(deniedOwner) })
    } catch (error) {
      denied = error
    }
    expect(denied).toMatchObject({ status: 403 })
  })

  it('ignores untrusted storage suppression while preserving direct importer suppression', async () => {
    const user = { id: 7, name: 'Owner', email: 'owner@example.test', permissions: [] }
    const createdPage = {
      id: 18,
      content: 'Content',
      localeCode: 'en',
      ownerId: null,
      path: 'docs',
      sourceRevision: '1',
      title: 'Docs',
      updatedAt: null,
      visibility: 'public'
    }
    const duplicateQuery = {
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) })
      })
    }
    const latestQuery = {
      findById: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ updatedAt: '2026-08-15T00:00:00.000Z' })
      })
    }
    const insert = vi.fn().mockResolvedValue(createdPage)
    const pageQuery = vi.spyOn(Page, 'query')
    const arrangeCreateQueries = () => {
      pageQuery
        .mockReset()
        .mockReturnValueOnce(duplicateQuery)
        .mockReturnValueOnce({ insert })
        .mockReturnValueOnce(latestQuery)
    }
    arrangeCreateQueries()
    vi.spyOn(Page, 'getPageFromDb').mockResolvedValue(createdPage)
    vi.spyOn(Page, 'renderPage').mockResolvedValue(undefined)
    vi.spyOn(Page, 'rebuildTree').mockResolvedValue(undefined)
    vi.spyOn(Page, 'reconnectLinks').mockResolvedValue(undefined)
    global.WIKI.config.editors = { available: ['markdown'] }
    global.WIKI.auth.checkPageAccess.mockReturnValue(true)
    const storageFailure = new Error('controlled storage failure')
    global.WIKI.models.storage.pageEvent.mockRejectedValue(storageFailure)
    const operations = (await vi.importFresh('../../operations/pages.ts', import.meta.url)).default
    const input = {
      content: 'Content',
      description: '',
      editor: 'markdown',
      isPublished: true,
      locale: 'en',
      path: 'docs',
      tags: [],
      title: 'Docs',
      visibility: 'public',
      skipStorage: true
    }

    await expect(operations.create({ requester: user, input })).rejects.toBe(storageFailure)
    expect(global.WIKI.models.storage.pageEvent).toHaveBeenCalledTimes(1)

    arrangeCreateQueries()
    global.WIKI.models.storage.pageEvent.mockClear()
    await expect(Page.createPage({ ...input, user })).resolves.toMatchObject({ id: 18, path: 'docs', visibility: 'public' })
    expect(global.WIKI.models.storage.pageEvent).not.toHaveBeenCalled()
  })

  it('rejects a canonical tag transition after real SQLite association and rolls back every write', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    try {
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
        table.text('content').notNullable()
        table.boolean('isPublished').notNullable()
        table.string('publishStartDate').notNullable()
        table.string('publishEndDate').notNullable()
        table.string('toc').notNullable()
        table.text('extra').notNullable()
        table.string('sourceRevision').notNullable().defaultTo('1')
        table.dateTime('createdAt').nullable()
        table.dateTime('updatedAt').nullable()
      })
      await db.schema.createTable('tags', table => {
        table.increments('id')
        table.string('tag').notNullable().unique()
        table.string('title').notNullable()
        table.integer('redirectToId').nullable()
        table.boolean('isArchived').notNullable().defaultTo(false)
      })
      await db.schema.createTable('pageTags', table => {
        table.integer('pageId').notNullable()
        table.integer('tagId').notNullable()
        table.primary(['pageId', 'tagId'])
      })
      await db.schema.createTable('pageMutationOutbox', table => {
        table.string('id').primary()
      })
      await db.schema.createTable('outboxEvents', table => {
        table.string('id').primary()
      })
      await db('tags').insert({ id: 1, tag: 'canonical', title: 'Canonical', redirectToId: null, isArchived: false })
      const seededTags = await db('tags').select('id', 'tag', 'title', 'redirectToId', 'isArchived')
      const user = { id: 7, name: 'Owner', email: 'owner@example.test', permissions: [] }
      const decisions = []

      Page.knex(db)
      global.WIKI.models.knex = db
      global.WIKI.models.pages = Page
      global.WIKI.models.tags = {
        associateTags: async ({ tags, page, transaction }) => {
          if (!Array.isArray(tags) || !tags.includes('historical')) throw new Error('normalized historical tag was not associated')
          const canonical = await transaction('tags').where({ tag: 'canonical' }).first()
          if (!canonical) throw new Error('canonical tag is missing')
          await transaction('pageTags').insert({ pageId: page.id, tagId: canonical.id })
          page.tags = [canonical]
          return true
        }
      }
      global.WIKI.auth.loadPageRuleAuthority.mockImplementation(async (requester, transaction) => ({
        ...authorityFor(requester),
        stage: transaction === undefined ? 'preflight' : 'transaction',
        deniedTags: transaction === undefined ? [] : ['canonical']
      }))
      global.WIKI.auth.checkPageAccess.mockImplementation((requester, permissions, context, authority) => {
        const tagNames = context.tags.map(({ tag }) => tag)
        const allowed =
          authority.requester === requester &&
          permissions.includes('write:pages') &&
          !authority.deniedTags.some(tag => tagNames.includes(tag))
        decisions.push({ requester, context, authority, allowed })
        return allowed
      })

      await expect(Page.createPage({
        content: 'Content',
        description: '',
        editor: 'markdown',
        isPublished: true,
        locale: 'en',
        path: 'docs',
        tags: [' Historical '],
        title: 'Docs',
        user,
        visibility: 'public'
      })).rejects.toMatchObject({
        status: 403,
        name: 'PAGE_CREATE_FORBIDDEN',
        message: 'You do not have permission to create this page.'
      })

      expect(decisions.map(({ requester, context, authority, allowed }) => ({
        requester,
        tags: context.tags.map(({ tag }) => tag),
        stage: authority.stage,
        allowed
      }))).toEqual([
        { requester: user, tags: ['historical'], stage: 'preflight', allowed: true },
        { requester: user, tags: ['canonical'], stage: 'transaction', allowed: false }
      ])
      expect(await db('pages')).toEqual([])
      expect(await db('pageTags')).toEqual([])
      expect(await db('tags').select('id', 'tag', 'title', 'redirectToId', 'isArchived')).toEqual(seededTags)
      expect(await db('pageMutationOutbox')).toEqual([])
      expect(await db('outboxEvents')).toEqual([])
    } finally {
      await db.destroy()
    }
  })


  it('creates a page at a path already represented by a virtual folder', async () => {
    const owner = { id: 7, permissions: [] }
    const createdPage = {
      id: 18,
      localeCode: 'en',
      ownerId: 7,
      path: 'docs',
      updatedAt: null,
      visibility: 'private'
    }
    const duplicateQuery = {
      select: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(undefined) })
      })
    }
    const insert = vi.fn().mockResolvedValue(createdPage)
    const latestQuery = {
      findById: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ updatedAt: '2026-08-15T00:00:00.000Z' })
      })
    }
    const query = vi.fn()
      .mockReturnValueOnce(duplicateQuery)
      .mockReturnValueOnce({ insert })
      .mockReturnValueOnce(latestQuery)
    const virtualFolderLookup = vi.fn().mockResolvedValue({
      isFolder: true,
      localeCode: 'en',
      path: 'docs'
    })
    global.WIKI.models.pageTree = { findFolder: virtualFolderLookup }
    global.WIKI.models.pages = {
      getPageFromDb: vi.fn().mockResolvedValue(createdPage),
      query,
      rebuildTree: vi.fn().mockResolvedValue(undefined),
      renderPage: vi.fn().mockResolvedValue(undefined)
    }

    expect(await Page.createPage({
      content: 'Page at the folder path',
      description: '',
      editor: 'markdown',
      isPublished: true,
      locale: 'en',
      path: 'docs',
      tags: [],
      title: 'Docs',
      user: owner,
      visibility: 'private'
    })).toMatchObject({
      id: 18,
      path: 'docs',
      updatedAt: '2026-08-15T00:00:00.000Z'
    })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      localeCode: 'en',
      ownerId: 7,
      path: 'docs',
      visibility: 'private'
    }))
    expect(virtualFolderLookup).not.toHaveBeenCalled()
  })
})
