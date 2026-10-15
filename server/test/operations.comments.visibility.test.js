const assertUnlocked = vi.fn().mockResolvedValue(undefined)
vi.mockModule('../operations/page-protection.ts', import.meta.url, () => ({ assertPageUnlocked: assertUnlocked }))
const originalWIKI = global.WIKI

class CommentNotFound extends Error {}
class CommentViewForbidden extends Error {}
class CommentGenericError extends Error {}
class BruteTooManyAttempts extends Error {}
const authorityFor = requester => ({
  requester,
  permissions: requester?.permissions ?? [],
  groups: [],
  tagAliases: {}
})

const rateLimitKnex = () => {
  const counters = new Map()
  const tables = {
    commentProviders: [{ key: 'default', isEnabled: true }],
    settings: [{ key: 'features', value: { featurePageComments: true } }],
    pages: [], pageTags: [], tags: [], pageAccessPasswords: [], pageUnlockGrants: [],
    comments: [], commentAnnotations: []
  }
  const knex = table => {
    if (!(table in tables)) throw new Error(`Unexpected discussion table: ${table}`)
    let rows = tables[table].map(row => ({ ...row, ...Object.fromEntries(Object.entries(row).map(([key, value]) => [`${table}.${key}`, value])) }))
    const project = columns => rows.map(row => columns.length
      ? Object.fromEntries(columns.map(column => [column.split('.').at(-1), row[column]]))
      : Object.fromEntries(Object.entries(row).filter(([key]) => !key.includes('.'))))
    const query = {
      where(column, value) {
        const entries = typeof column === 'object' ? Object.entries(column) : [[column, value]]
        rows = rows.filter(row => entries.every(([key, expected]) => row[key] === expected))
        return query
      },
      whereIn(column, values) { rows = rows.filter(row => values.includes(row[column])); return query },
      join(other, left, right) {
        rows = rows.flatMap(row => tables[other].map(item => ({
          ...row, ...Object.fromEntries(Object.entries(item).map(([key, value]) => [`${other}.${key}`, value]))
        })).filter(item => item[left] === item[right]))
        return query
      },
      forShare() { return query },
      orderBy(column) { rows.sort((a, b) => a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0); return query },
      first(...columns) { return Promise.resolve(project(columns)[0]) },
      select(...columns) { return Promise.resolve(project(columns)) },
      then(resolve, reject) { return Promise.resolve(project([])).then(resolve, reject) }
    }
    return query
  }
  knex.tables = tables
  knex.transaction = callback => callback(knex)
  knex.raw = vi.fn(async (sql, [key, expire, now]) => {
    if (sql.trimStart().startsWith('SELECT')) return { rows: [] }
    const current = counters.get(key)
    const startsNewWindow = current === undefined || current.expire === null || current.expire <= now
    const row = startsNewWindow ? { points: 1, expire } : { points: current.points + 1, expire: current.expire }
    counters.set(key, row)
    return { rows: [row] }
  })
  return knex
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
        checkAccess: vi.fn((user, permissions) => permissions.some(permission => user?.permissions?.includes(permission))),
        checkPageAccess: vi.fn((user, permissions, _context, authority) =>
          authority?.requester === user && permissions.some(permission => authority.permissions.includes(permission))
        ),
        loadPageRuleAuthority: vi.fn(async requester => authorityFor(requester))
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
    const comments = [
      { id: 31, pageId: 17, name: 'Owner', email: 'owner@example.invalid', ip: '127.0.0.1' },
      { id: 32, pageId: 18, name: 'Other owner', email: 'other@example.invalid', ip: '127.0.0.2' }
    ]
    global.WIKI.models.knex.tables.pages = [page]
    global.WIKI.models.knex.tables.comments = comments.map(row => ({ ...row, replyTo: 0, isHidden: false }))
    global.WIKI.models.knex.tables.commentAnnotations = [{
      id: 41, commentId: 31, position: 0, note: 'Owner passage',
      anchor: { exact: 'quote', prefix: '', suffix: '', heading: null, offset: 0 },
      revision: 1, resolvedAt: null, resolvedById: null,
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'
    }, {
      id: 42, commentId: 32, position: 0, note: 'Another private page',
      anchor: { exact: 'secret', prefix: '', suffix: '', heading: null, offset: 0 },
      revision: 1, resolvedAt: null, resolvedById: null,
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'
    }]
    const filters = []
    const commentQuery = {
      where: vi.fn((column, value) => {
        filters.push(row => row[column] === value)
        return commentQuery
      }),
      orderBy: vi.fn(async () => comments.filter(row => filters.every(filter => filter(row))))
    }
    global.WIKI.models.comments.query.mockReturnValue(commentQuery)
    const operations = (await vi.importFresh('../operations/comments.ts', import.meta.url)).default

    const rows = await operations.list({ requester: { id: 7, permissions: ['read:comments'] }, pageId: 17, sessionId: 'reader-session' })
    expect(rows).toEqual([expect.objectContaining({ id: 31, authorName: 'Owner' })])
    expect(rows[0].annotations).toEqual([expect.objectContaining({ id: 41, note: 'Owner passage' })])
    expect(query.findById).toHaveBeenCalledWith(17)
    expect(assertUnlocked).toHaveBeenCalledWith(expect.objectContaining({
      requester: { id: 7, permissions: ['read:comments'] },
      pageId: 17,
      sessionId: 'reader-session',
      authority: expect.objectContaining({ requester: expect.anything() })
    }))
  })

  it('projects replies with unavailable ancestry as standalone visible comments', async () => {
    const page = { id: 17, localeCode: 'en', path: 'same/path', visibility: 'private', ownerId: 7, tags: [] }
    global.WIKI.models.pages.query.mockReturnValue(pageQuery(page))
    global.WIKI.models.knex.tables.pages = [page]
    global.WIKI.models.knex.tables.comments = [
      { id: 31, pageId: 17, replyTo: 0, isHidden: true },
      { id: 32, pageId: 17, replyTo: 31, isHidden: false },
      { id: 33, pageId: 17, replyTo: 999, isHidden: false }
    ]
    global.WIKI.models.knex.tables.commentAnnotations = [{
      id: 41, commentId: 31, position: 0, note: 'Hidden root annotation',
      anchor: { exact: 'secret', prefix: '', suffix: '', heading: null, offset: 0 },
      revision: 1, resolvedAt: null, resolvedById: null,
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z'
    }]
    global.WIKI.models.comments.query.mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue([
          { id: 31, pageId: 17, replyTo: 0, isHidden: true, content: 'Hidden root', render: '<p>Hidden root</p>', name: 'Owner', createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z' },
          { id: 32, pageId: 17, replyTo: 31, isHidden: false, content: 'Visible reply', render: '<p>Visible reply</p>', name: 'Reader', createdAt: '2026-08-14T00:01:00.000Z', updatedAt: '2026-08-14T00:01:00.000Z' },
          { id: 33, pageId: 17, replyTo: 999, isHidden: false, content: 'Legacy orphan', render: '<p>Legacy orphan</p>', name: 'Reader', createdAt: '2026-08-14T00:02:00.000Z', updatedAt: '2026-08-14T00:02:00.000Z' }
        ])
      })
    })
    const operations = (await vi.importFresh('../operations/comments.ts', import.meta.url)).default

    const rows = await operations.list({ requester: { id: 7, permissions: ['read:comments'] }, pageId: 17 })
    expect(rows.map(row => ({ id: row.id, replyTo: row.replyTo }))).toEqual([{ id: 32, replyTo: 0 }, { id: 33, replyTo: 0 }])
    expect(rows.map(row => row.annotations)).toEqual([[], []])
  })

  it('returns the same not-found error for an absent page and another owner private page', async () => {
    const operations = (await vi.importFresh('../operations/comments.ts', import.meta.url)).default
    const requester = { id: 8, permissions: ['read:comments'] }

    global.WIKI.models.pages.query.mockReturnValueOnce(pageQuery(undefined))
    const missingError = await operations.list({ requester, pageId: 17 }).catch(error => error)
    expect(missingError).toBeInstanceOf(CommentNotFound)
    expect(missingError).toMatchObject({ status: 404 })
    expect(global.WIKI.models.comments.query).not.toHaveBeenCalled()

    global.WIKI.models.pages.query.mockReturnValueOnce(pageQuery({
      id: 17,
      localeCode: 'en',
      path: 'same/path',
      visibility: 'private',
      ownerId: 7,
      tags: []
    }))
    const privateError = await operations.list({ requester, pageId: 17 }).catch(error => error)
    expect(privateError).toBeInstanceOf(CommentNotFound)
    expect(privateError).toMatchObject({ status: 404 })
    expect(global.WIKI.models.comments.query).not.toHaveBeenCalled()
    const envelope = error => ({ status: error.status, name: error.name, message: error.message })
    expect(envelope(privateError)).toEqual(envelope(missingError))
  })

  it('returns an HTTP-compatible not-found status for a hidden comment', async () => {
    global.WIKI.models.comments.query.mockReturnValue({ findById: vi.fn().mockResolvedValue({ id: 31, pageId: 17, isHidden: true }) })
    const operations = (await vi.importFresh('../operations/comments.ts', import.meta.url)).default
    await expect(operations.get({ requester: { id: 7, permissions: ['read:comments'] }, id: 31 })).rejects.toMatchObject({ status: 404 })
    expect(global.WIKI.models.pages.query).not.toHaveBeenCalled()
  })

  it('enforces create throttle decisions for repeated keys, different users, and expired windows', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    global.WIKI.models.comments.postNewComment
      .mockResolvedValueOnce(41)
      .mockResolvedValueOnce(42)
      .mockResolvedValueOnce(43)
    const operations = (await vi.importFresh('../operations/comments.ts', import.meta.url)).default
    const requester = { id: 7, permissions: ['write:comments'] }
    const input = { pageId: 17, content: 'first' }

    const createComment = () => operations.create({ requester, ip: '192.0.2.10', input })

    await expect(createComment()).resolves.toBe(41)
    const limited = await createComment().catch(error => error)
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
    await expect(createComment()).resolves.toBe(43)
    expect(global.WIKI.models.comments.postNewComment).toHaveBeenCalledTimes(3)
  })
})
