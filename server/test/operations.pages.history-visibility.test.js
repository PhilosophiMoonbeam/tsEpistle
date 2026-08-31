const originalWIKI = global.WIKI

class PageNotFound extends Error {}
class PageHistoryForbidden extends Error {}
class PageRestoreForbidden extends Error {}
class PageViewForbidden extends Error {}
class PageUpdateForbidden extends Error {}
class PageDeleteForbidden extends Error {}
class PageMoveForbidden extends Error {}

const pageQuery = page => ({
  select: vi.fn().mockReturnValue({ findById: vi.fn().mockResolvedValue(page) }),
  findById: vi.fn().mockResolvedValue(page)
})

describe('page history visibility boundaries', () => {
  beforeEach(() => {
    vi.resetModules()
    global.WIKI = {
      auth: {
        checkAccess: vi.fn((user, permissions) => permissions.some(permission => user?.permissions?.includes(permission)))
      },
      config: { db: { type: 'postgres' }, lang: { code: 'en' } },
      data: { searchEngine: null },
      Error: { PageNotFound, PageHistoryForbidden, PageRestoreForbidden, PageViewForbidden, PageUpdateForbidden, PageDeleteForbidden, PageMoveForbidden },
      models: {
        knex: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(undefined)
          })
        }),
        pages: {
          query: vi.fn(),
          getPageFromDb: vi.fn(),
          updatePage: vi.fn()
        },
        pageHistory: {
          getHistory: vi.fn(),
          getVersion: vi.fn()
        },
        tags: {}
      }
    }
  })

  afterEach(() => {
    if (originalWIKI === undefined) delete global.WIKI
    else global.WIKI = originalWIKI
  })

  it('passes the requester into history queries so private revisions remain scoped after publication', async () => {
    const requester = { id: 8, permissions: ['read:pages', 'read:history'] }
    global.WIKI.models.pages.query.mockReturnValue(pageQuery({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null
    }))
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null
    })
    global.WIKI.models.pageHistory.getHistory.mockResolvedValue({ trail: [], total: 0 })
    const operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default

    await operations.getHistory({ requester, sessionId: 'session-1', id: 17, offsetPage: 0, offsetSize: 25 })
    expect(global.WIKI.models.pageHistory.getHistory).toHaveBeenCalledWith({
      pageId: 17,
      offsetPage: 0,
      offsetSize: 25,
      requester
    })
  })

  it('returns not found for another owner private history just as for an absent page', async () => {
    const requester = { id: 8, permissions: ['read:history'] }
    const operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default

    global.WIKI.models.pages.query.mockReturnValueOnce(pageQuery(undefined))
    await expect(Promise.resolve(operations.getHistory({ requester, id: 17 }))).rejects.toBeInstanceOf(PageNotFound)

    global.WIKI.models.pages.query.mockReturnValueOnce(pageQuery({
      id: 17,
      path: 'secret',
      localeCode: 'en',
      visibility: 'private',
      ownerId: 7
    }))
    await expect(Promise.resolve(operations.getHistory({ requester, id: 17 }))).rejects.toBeInstanceOf(PageNotFound)
    expect(global.WIKI.models.pageHistory.getHistory).not.toHaveBeenCalled()
  })

  it('cannot restore a hidden private revision after the page is published', async () => {
    const requester = { id: 8, permissions: ['read:pages', 'write:pages'] }
    global.WIKI.models.pages.query.mockReturnValue(pageQuery({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null,
      sourceRevision: '8'
    }))
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null
    })
    global.WIKI.models.pageHistory.getVersion.mockResolvedValue(undefined)
    const operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default

    await expect(Promise.resolve(operations.restore({ requester, sessionId: 'session-1', pageId: 17, versionId: 4, expectedSourceRevision: '8' }))).rejects.toBeInstanceOf(PageNotFound)
    expect(global.WIKI.models.pageHistory.getVersion).toHaveBeenCalledWith({ pageId: 17, versionId: 4, requester })
    expect(global.WIKI.models.pages.updatePage).not.toHaveBeenCalled()
  })

  it('rejects a stale restore before reading or overwriting the selected revision', async () => {
    const requester = { id: 8, permissions: ['read:pages', 'write:pages'] }
    global.WIKI.models.pages.query.mockReturnValue(pageQuery({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null,
      sourceRevision: '9'
    }))
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null
    })
    const operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default

    await expect(Promise.resolve(operations.restore({
      requester,
      sessionId: 'session-1',
      pageId: 17,
      versionId: 4,
      expectedSourceRevision: '8'
    }))).rejects.toMatchObject({ name: 'PAGE_RESTORE_CONFLICT', status: 409 })
    expect(global.WIKI.models.pageHistory.getVersion).not.toHaveBeenCalled()
    expect(global.WIKI.models.pages.updatePage).not.toHaveBeenCalled()
  })

  it('restores canonical content, editor, content type, and tags with a source-revision compare-and-swap', async () => {
    const requester = { id: 8, permissions: ['read:pages', 'write:pages'] }
    const sourceRevision = '8'
    global.WIKI.models.pages.query.mockReturnValue(pageQuery({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null,
      sourceRevision,
      updatedAt: '2026-08-15T00:00:00.000Z'
    }))
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null
    })
    global.WIKI.models.pageHistory.getVersion.mockResolvedValue({
      versionId: 4,
      content: '# Earlier',
      contentType: 'markdown',
      title: 'Earlier',
      description: 'Earlier description',
      editor: 'visual-markdown',
      locale: 'en',
      path: 'published',
      tags: ['release'],
      versionDate: '2026-08-14T00:00:00.000Z',
      visibility: 'public'
    })
    const operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default

    await operations.restore({ requester, sessionId: 'session-1', pageId: 17, versionId: 4, expectedSourceRevision: sourceRevision })

    expect(global.WIKI.models.pages.updatePage).toHaveBeenCalledWith({
      id: 17,
      user: requester,
      content: '# Earlier',
      contentType: 'markdown',
      title: 'Earlier',
      description: 'Earlier description',
      editor: 'visual-markdown',
      tags: ['release'],
      action: 'restored',
      okfRestoreRevision: 4,
      expectedUpdatedAt: '2026-08-15T00:00:00.000Z',
      expectedSourceRevision: sourceRevision
    })
  })

  it('reauthorizes both the current page and move destination against live page rules', async () => {
    const requester = { id: 8, permissions: ['read:pages', 'write:pages'] }
    global.WIKI.auth.checkAccess.mockImplementation((user, permissions, context) =>
      permissions.some(permission => user?.permissions?.includes(permission)) && context?.path !== 'restricted/next'
    )
    global.WIKI.models.pages.query.mockReturnValue(pageQuery({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null,
      tags: [{ id: 1, tag: 'release' }]
    }))
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null
    })
    const operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default

    await expect(Promise.resolve(operations.authorizeMutation({
      kind: 'move',
      input: { id: 17, destinationPath: 'restricted/next', destinationLocale: 'en' },
      requester,
      sessionId: 'session-1'
    }))).rejects.toBeInstanceOf(PageMoveForbidden)
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(requester, expect.arrayContaining(['write:pages']), expect.objectContaining({ path: 'restricted/next', locale: 'en' }))
  })
})
