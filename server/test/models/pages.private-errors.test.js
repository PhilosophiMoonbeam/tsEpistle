import { EventEmitter } from 'node:events'

const originalWIKI = global.WIKI

class PageNotFound extends Error {}
class PageUpdateForbidden extends Error {}
class PageMoveForbidden extends Error {}
class PageDeleteForbidden extends Error {}

const privatePage = {
  id: 17,
  path: 'secret',
  localeCode: 'en',
  visibility: 'private',
  ownerId: 7,
  editorKey: 'markdown'
}

describe('private page mutation existence isolation', () => {
  let Page

  beforeEach(async () => {
    vi.resetModules()
    let insertedProjection
    const knex = vi.fn(table => {
      if (table === 'pages') {
        return {
          select: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              forUpdate: vi.fn().mockReturnValue({
                first: vi.fn().mockResolvedValue({
                  id: 17,
                  sourceRevision: '3',
                  content: 'changed content',
                  localeCode: 'en',
                  path: 'secret',
                  visibility: 'private',
                  ownerId: 7
                })
              })
            })
          })
        }
      }
      if (table === 'pageMutationOutbox') {
        return {
          insert: vi.fn(row => {
            insertedProjection = row
            return { onConflict: vi.fn().mockReturnValue({ ignore: vi.fn().mockResolvedValue([]) }) }
          }),
          where: vi.fn().mockReturnValue({ first: vi.fn(async () => insertedProjection) })
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
      auth: { checkAccess: vi.fn().mockReturnValue(false) },
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
        tags: {}
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
      $relatedQuery: vi.fn()
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
    expect(query).toHaveBeenCalledOnce()
    expect(global.WIKI.models.pageHistory.addVersion).not.toHaveBeenCalled()
  })

  it('stamps producer provenance and clears verification for an authoritative OKF-only change', async () => {
    const owner = { id: 7, permissions: [] }
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
    const updatedPage = { ...originalPage, sourceRevision: '3' }
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
      okfMetadata: { type: 'Procedure', status: 'stable' },
      replaceOkfMetadata: true,
      okfProducer: 'agent:authority-request',
      expectedSourceRevision: '2'
    })

    const patchedOkf = patch.mock.calls[0][0].extra.okf
    expect(patchedOkf).toMatchObject({
      type: 'Procedure',
      generated: { by: 'agent:authority-request', at: expect.any(String) }
    })
    expect(patchedOkf).not.toHaveProperty('verified')
    expect(result).toBe(updatedPage)
    expect(result.sourceRevision).toBe('3')
    expect(patchQuery.where).toHaveBeenCalledTimes(2)
    expect(patchQuery.where).toHaveBeenNthCalledWith(1, 'id', 17)
    expect(patchQuery.where).toHaveBeenNthCalledWith(2, 'sourceRevision', '2')
    expect(global.WIKI.models.pageHistory.addVersion).toHaveBeenCalledWith(expect.objectContaining({
      sourceRevision: '2',
      extra: originalExtra
    }))
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

  it('stamps move provenance, clears verification, and reloads the immutable moved revision', async () => {
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
    const patch = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(1) })
    const query = vi.fn()
      .mockReturnValueOnce({ findById: vi.fn().mockResolvedValue(originalPage) })
      .mockReturnValueOnce({ findOne: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ patch })
    const getPageFromDb = vi.fn().mockResolvedValue({
      ...originalPage,
      path: 'renamed',
      title: 'renamed',
      hash: 'private:7:en:renamed',
      sourceRevision: '3'
    })
    global.WIKI.models.pages = {
      query,
      getPageFromDb,
      deletePageFromCache: vi.fn(),
      rebuildTree: vi.fn()
    }

    await Page.movePage({
      id: 17,
      user: owner,
      destinationLocale: 'en',
      destinationPath: 'renamed',
      expectedSourceRevision: '2',
      okfProducer: 'agent:move-request',
      skipStorage: true
    })

    const patchValue = patch.mock.calls[0][0]
    expect(patchValue).toMatchObject({
      path: 'renamed',
      title: 'renamed',
      extra: {
        okf: {
          type: 'Reference',
          generated: { by: 'agent:move-request', at: expect.any(String) }
        }
      }
    })
    expect(patchValue.extra.okf).not.toHaveProperty('verified')
    expect(getPageFromDb).toHaveBeenCalledWith(17)
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
    const patch = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(1) })
    const query = vi.fn()
      .mockReturnValueOnce({ findOne: vi.fn().mockResolvedValue(undefined) })
      .mockReturnValueOnce({ patch })
    global.WIKI.auth.checkAccess.mockReturnValue(true)
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
