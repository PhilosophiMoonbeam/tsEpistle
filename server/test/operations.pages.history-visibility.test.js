const originalWIKI = global.WIKI

class PageNotFound extends Error {}
class PageHistoryForbidden extends Error {}
class PageRestoreForbidden extends Error {}
class PageViewForbidden extends Error {}
class PageUpdateForbidden extends Error {}

const pageQuery = page => ({
  select: vi.fn().mockReturnValue({ findById: vi.fn().mockResolvedValue(page) })
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
      Error: { PageNotFound, PageHistoryForbidden, PageRestoreForbidden, PageViewForbidden, PageUpdateForbidden },
      models: {
        knex: vi.fn(),
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
    const requester = { id: 8, permissions: ['read:history'] }
    global.WIKI.models.pages.query.mockReturnValue(pageQuery({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null
    }))
    global.WIKI.models.pageHistory.getHistory.mockResolvedValue({ trail: [], total: 0 })
    const operations = (await import('../operations/pages.ts')).default

    await operations.getHistory({ requester, id: 17, offsetPage: 0, offsetSize: 25 })
    expect(global.WIKI.models.pageHistory.getHistory).toHaveBeenCalledWith({
      pageId: 17,
      offsetPage: 0,
      offsetSize: 25,
      requester
    })
  })

  it('returns not found for another owner private history just as for an absent page', async () => {
    const requester = { id: 8, permissions: ['read:history'] }
    const operations = (await import('../operations/pages.ts')).default

    global.WIKI.models.pages.query.mockReturnValueOnce(pageQuery(undefined))
    await expect(operations.getHistory({ requester, id: 17 })).rejects.toBeInstanceOf(PageNotFound)

    global.WIKI.models.pages.query.mockReturnValueOnce(pageQuery({
      id: 17,
      path: 'secret',
      localeCode: 'en',
      visibility: 'private',
      ownerId: 7
    }))
    await expect(operations.getHistory({ requester, id: 17 })).rejects.toBeInstanceOf(PageNotFound)
    expect(global.WIKI.models.pageHistory.getHistory).not.toHaveBeenCalled()
  })

  it('cannot restore a hidden private revision after the page is published', async () => {
    const requester = { id: 8, permissions: ['write:pages'] }
    global.WIKI.models.pages.query.mockReturnValue(pageQuery({
      id: 17,
      path: 'published',
      localeCode: 'en',
      visibility: 'public',
      ownerId: null
    }))
    global.WIKI.models.pageHistory.getVersion.mockResolvedValue(undefined)
    const operations = (await import('../operations/pages.ts')).default

    await expect(operations.restore({ requester, pageId: 17, versionId: 4 })).rejects.toBeInstanceOf(PageNotFound)
    expect(global.WIKI.models.pageHistory.getVersion).toHaveBeenCalledWith({ pageId: 17, versionId: 4, requester })
    expect(global.WIKI.models.pages.updatePage).not.toHaveBeenCalled()
  })
})
