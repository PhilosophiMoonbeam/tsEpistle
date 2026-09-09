const originalWIKI = global.WIKI

class PageNotFound extends Error {}
class PageHistoryForbidden extends Error {}
class PageRestoreForbidden extends Error {}
class PageViewForbidden extends Error {}
class PageUpdateForbidden extends Error {}
class PageDeleteForbidden extends Error {}
class PageMoveForbidden extends Error {}

const pageProjection = (page, columns) => {
  if (page === undefined) return undefined
  return Object.fromEntries(columns.map(column => {
    const key = String(column).split('.').at(-1)
    return [key, page[key]]
  }))
}

const pageQuery = page => ({
  select: vi.fn((...columns) => ({ findById: vi.fn().mockResolvedValue(pageProjection(page, columns)) })),
  findById: vi.fn().mockResolvedValue(page)
})

const canonicalPage = (overrides = {}) => ({
  id: 17,
  path: 'published',
  localeCode: 'en',
  visibility: 'public',
  ownerId: null,
  sourceRevision: '8',
  updatedAt: '2026-01-02T00:00:00.000Z',
  tags: [],
  ...overrides
})

describe('page history visibility boundaries', () => {
  beforeEach(() => {
    vi.resetModules()
    const checkAccess = vi.fn((user, permissions) => permissions.some(permission => user?.permissions?.includes(permission)))
    global.WIKI = {
      auth: {
        checkAccess,
        checkPageAccess: checkAccess,
        loadPageRuleAuthority: vi.fn(async requester => ({ requester, permissions: [], groups: [], tagAliases: {} }))
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

  it('returns not found for another owner private history just as for an absent page', async () => {
    const requester = { id: 8, permissions: ['read:history'] }
    const operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default

    global.WIKI.models.pages.getPageFromDb.mockResolvedValueOnce(undefined)
    await expect(Promise.resolve(operations.getHistory({ requester, id: 17 }))).rejects.toBeInstanceOf(PageNotFound)

    global.WIKI.models.pages.getPageFromDb.mockResolvedValueOnce(canonicalPage({
      path: 'secret',
      visibility: 'private',
      ownerId: 7
    }))
    await expect(Promise.resolve(operations.getHistory({ requester, id: 17 }))).rejects.toBeInstanceOf(PageNotFound)
    expect(global.WIKI.models.pageHistory.getHistory).not.toHaveBeenCalled()
  })

  it('returns the known tagged public history trail after canonical page authorization', async () => {
    const requester = { id: 8, permissions: ['read:history'] }
    const page = canonicalPage({
      path: 'public/history',
      tags: [{ id: 3, tag: 'release', title: 'Release' }]
    })
    const history = {
      trail: [{
        versionId: 42,
        authorId: 8,
        authorName: 'Editor',
        actionType: 'edit',
        valueBefore: null,
        sourceRevision: '8',
        valueAfter: null,
        versionDate: '2026-08-01T00:00:00.000Z'
      }],
      total: 1
    }
    global.WIKI.auth.checkPageAccess.mockImplementation((user, permissions, context) =>
      user === requester &&
      permissions.some(permission => permission === 'read:pages' || permission === 'read:history') &&
      context?.path === page.path &&
      context?.locale === page.localeCode &&
      context?.tags?.some(tag => tag.tag === 'release')
    )
    global.WIKI.models.pages.query.mockReturnValue(pageQuery(page))
    global.WIKI.models.pages.getPageFromDb.mockImplementation(async id => id === page.id ? page : undefined)
    global.WIKI.models.pageHistory.getHistory.mockResolvedValue(history)
    const operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default

    await expect(Promise.resolve(operations.getHistory({ requester, id: page.id }))).resolves.toEqual(history)
    expect(global.WIKI.models.pages.getPageFromDb).toHaveBeenCalledWith(page.id)
    expect(global.WIKI.auth.checkPageAccess).toHaveBeenCalledWith(
      requester,
      ['read:history'],
      { path: page.path, locale: page.localeCode, tags: page.tags },
      expect.anything()
    )
    expect(global.WIKI.models.pageHistory.getHistory).toHaveBeenCalledWith({
      pageId: page.id,
      offsetPage: 0,
      offsetSize: 100,
      requester
    })
  })
  it('cannot restore a hidden private revision after the page is published', async () => {
    const requester = { id: 8, permissions: ['read:pages', 'write:pages'] }
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue(canonicalPage({ sourceRevision: '8' }))
    global.WIKI.models.pageHistory.getVersion.mockResolvedValue(undefined)
    const operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default

    await expect(Promise.resolve(operations.restore({ requester, sessionId: 'session-1', pageId: 17, versionId: 4, expectedSourceRevision: '8' }))).rejects.toBeInstanceOf(PageNotFound)
    expect(global.WIKI.models.pageHistory.getVersion).toHaveBeenCalledWith({ pageId: 17, versionId: 4, requester })
    expect(global.WIKI.models.pages.updatePage).not.toHaveBeenCalled()
  })

  it('rejects a stale restore before reading or overwriting the selected revision', async () => {
    const requester = { id: 8, permissions: ['read:pages', 'write:pages'] }
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue(canonicalPage({ sourceRevision: '9' }))
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

  it('reauthorizes both the current page and move destination against live page rules', async () => {
    const requester = { id: 8, permissions: ['read:pages', 'write:pages'] }
    global.WIKI.auth.checkAccess.mockImplementation((user, permissions, context) =>
      permissions.some(permission => user?.permissions?.includes(permission)) && context?.path !== 'restricted/next'
    )
    global.WIKI.models.pages.getPageFromDb.mockResolvedValue(canonicalPage({
      tags: [{ id: 1, tag: 'release' }]
    }))
    const operations = (await vi.importFresh('../operations/pages.ts', import.meta.url)).default

    await expect(Promise.resolve(operations.authorizeMutation({
      kind: 'move',
      input: { id: 17, destinationPath: 'restricted/next', destinationLocale: 'en' },
      requester,
      sessionId: 'session-1'
    }))).rejects.toBeInstanceOf(PageMoveForbidden)
  })
})
