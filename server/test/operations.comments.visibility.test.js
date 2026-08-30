const originalWIKI = global.WIKI

class CommentNotFound extends Error {}
class CommentViewForbidden extends Error {}
class CommentGenericError extends Error {}
class BruteTooManyAttempts extends Error {}

const rateLimitKnex = () => {
  const rows = new Map()
  return {
    raw: vi.fn(async (_query, [key, expire, now]) => {
      const current = rows.get(key)
      const startsNewWindow = current === undefined || current.expire === null || current.expire <= now
      const row = startsNewWindow
        ? { points: 1, expire }
        : { points: current.points + 1, expire: current.expire }
      rows.set(key, row)
      return { rows: [row] }
    })
  }
}

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
      Error: { BruteTooManyAttempts, CommentNotFound, CommentViewForbidden, CommentGenericError },
      data: {
        commentProviders: [],
        commentProvider: { getCommentById: vi.fn() }
      },
      logger: { warn: vi.fn() },
      models: {
        knex: rateLimitKnex(),
        commentProviders: {},
        pages: { query: vi.fn() },
        comments: {
          query: vi.fn(),
          postNewComment: vi.fn()
        }
      }
    }
  })

  afterEach(() => {
    if (originalWIKI === undefined) delete global.WIKI
    else global.WIKI = originalWIKI
    vi.restoreAllMocks()
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

  it('shares the durable create throttle across transports, keys, and windows', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    global.WIKI.models.comments.postNewComment
      .mockResolvedValueOnce(41)
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(43)
    const operations = (await vi.importFresh('../operations/comments.ts', import.meta.url)).default
    const requester = { id: 7, permissions: ['write:comments'] }
    const input = { pageId: 17, content: 'first' }

    const graphCreate = () => operations.create({ requester, ip: '192.0.2.10', input })
    const restCreate = () => operations.create({ requester, ip: '192.0.2.10', input })

    await expect(graphCreate()).resolves.toBe(41)
    const limited = await restCreate().catch(error => error)
    expect(limited).toBeInstanceOf(BruteTooManyAttempts)
    expect(limited).toMatchObject({
      status: 429,
      retryAfterMilliseconds: 15_000
    })
    await expect(operations.create({
      requester: { id: 8, permissions: ['write:comments'] },
      ip: '192.0.2.10',
      input
    })).resolves.toBe(42)

    Date.now.mockReturnValue(16_000)
    await expect(restCreate()).resolves.toBe(43)
    expect(global.WIKI.models.comments.postNewComment).toHaveBeenCalledTimes(3)
  })
})
