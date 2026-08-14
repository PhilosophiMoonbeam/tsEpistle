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
})
