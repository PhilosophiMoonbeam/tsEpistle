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
        knex: vi.fn(),
        pageHistory: { addVersion: vi.fn() },
        pages: {},
        storage: { pageEvent: vi.fn() },
        tags: {}
      },
      scheduler: { registerJob: vi.fn() }
    }
    Page = (await import('../../models/pages.ts')).default
    global.WIKI.models.pages = Page
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalWIKI === undefined) delete global.WIKI
    else global.WIKI = originalWIKI
  })

  const requester = { id: 8, permissions: ['write:pages', 'delete:pages'] }

  it('returns not found before update or editor-conversion details can leak', async () => {
    vi.spyOn(Page, 'query').mockReturnValue({ findById: vi.fn().mockResolvedValue(privatePage) })

    await expect(Page.updatePage({ id: 17, user: requester, content: 'changed' })).rejects.toBeInstanceOf(PageNotFound)
    await expect(Page.convertPage({ id: 17, user: requester, editor: 'markdown' })).rejects.toBeInstanceOf(PageNotFound)
  })

  it('returns not found before move path validation can leak a private id', async () => {
    vi.spyOn(Page, 'query').mockReturnValue({ findById: vi.fn().mockResolvedValue(privatePage) })

    await expect(Page.movePage({
      id: 17,
      user: requester,
      destinationLocale: 'en',
      destinationPath: 'invalid path'
    })).rejects.toBeInstanceOf(PageNotFound)
  })

  it('returns not found for direct deletion by a non-owner', async () => {
    vi.spyOn(Page, 'getPageFromDb').mockResolvedValue(privatePage)

    await expect(Page.deletePage({ id: 17, user: requester })).rejects.toBeInstanceOf(PageNotFound)
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

    await expect(Page.updatePage({
      id: 17,
      user: owner,
      content: 'changed content',
      title: 'Changed title'
    })).resolves.toMatchObject({ content: 'changed content', title: 'Changed title' })

    expect(patch).toHaveBeenCalledWith(expect.objectContaining({
      content: 'changed content',
      description: 'original description',
      isPublished: true,
      publishEndDate: '2030-01-01T00:00:00.000Z',
      publishStartDate: '2026-01-01T00:00:00.000Z',
      title: 'Changed title',
      extra: { css: '.original{}', js: 'original()' }
    }))
    expect(associateTags).not.toHaveBeenCalled()
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
    const insert = vi.fn().mockResolvedValue(1)
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

    await expect(Page.createPage({
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
    })).resolves.toMatchObject({
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
