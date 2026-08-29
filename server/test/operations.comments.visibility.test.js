const originalWIKI = global.WIKI

class CommentNotFound extends Error {}
class CommentViewForbidden extends Error {}
class CommentGenericError extends Error {}

const pageQuery = page => {
  const query = {
    select: vi.fn().mockReturnThis(),
    findById: vi.fn().mockReturnThis(),
    withGraphJoined: vi.fn().mockReturnThis(),
    modifyGraph: vi.fn((_relation, callback) => {
      callback({ select: vi.fn() })
      return Promise.resolve(page)
    })
  }
  return query
}

describe('comment page identity and private existence isolation', () => {
  beforeEach(() => {
    vi.resetModules()
    global.WIKI = {
      auth: {
        checkAccess: vi.fn((user, permissions) => permissions.some(permission => user?.permissions?.includes(permission)))
      },
      Error: { CommentNotFound, CommentViewForbidden, CommentGenericError },
      data: {
        commentProviders: [],
        commentProvider: { getCommentById: vi.fn() }
      },
      logger: { warn: vi.fn() },
      models: {
        commentProviders: {},
        pages: { query: vi.fn() },
        comments: { query: vi.fn() }
      }
    }
  })

  afterEach(() => {
    if (originalWIKI === undefined) delete global.WIKI
    else global.WIKI = originalWIKI
  })

  it('lists comments by page id for the private owner', async () => {
    const page = { id: 17, localeCode: 'en', path: 'same/path', visibility: 'private', ownerId: 7, tags: [] }
    const query = pageQuery(page)
    global.WIKI.models.pages.query.mockReturnValue(query)
    global.WIKI.models.comments.query.mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue([{
          id: 31,
          pageId: 17,
          name: 'Owner',
          email: 'owner@example.invalid',
          ip: '127.0.0.1'
        }])
      })
    })
    const operations = (await vi.importFresh('../operations/comments.ts', import.meta.url)).default

    expect(await operations.list({ requester: { id: 7, permissions: ['read:comments'] }, pageId: 17 })).toEqual([expect.objectContaining({ id: 31, authorName: 'Owner' })])
    expect(query.findById).toHaveBeenCalledWith(17)
  })

  it('returns the same not-found error for an absent page and another owner private page', async () => {
    const operations = (await vi.importFresh('../operations/comments.ts', import.meta.url)).default
    const requester = { id: 8, permissions: ['read:comments'] }

    global.WIKI.models.pages.query.mockReturnValueOnce(pageQuery(undefined))
    await expect(Promise.resolve(operations.list({ requester, pageId: 17 }))).rejects.toBeInstanceOf(CommentNotFound)

    global.WIKI.models.pages.query.mockReturnValueOnce(pageQuery({
      id: 17,
      localeCode: 'en',
      path: 'same/path',
      visibility: 'private',
      ownerId: 7,
      tags: []
    }))
    await expect(Promise.resolve(operations.list({ requester, pageId: 17 }))).rejects.toBeInstanceOf(CommentNotFound)
  })
})
