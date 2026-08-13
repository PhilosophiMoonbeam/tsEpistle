vi.mock('express', () => {
  const router = {
    delete: vi.fn(),
    get: vi.fn(),
    patch: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    use: vi.fn()
  }

  const expressMock = {
    Router: () => router,
    __router: router
  }

  return { default: expressMock, ...expressMock }
})

import * as express from 'express'

describe('controllers/api pages endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__router.delete.mockClear()
    express.__router.get.mockClear()
    express.__router.patch.mockClear()
    express.__router.post.mockClear()
    express.__router.put.mockClear()

    global.WIKI = {
      auth: {
        checkAccess: vi.fn().mockReturnValue(true)
      },
      config: {
        db: {
          type: 'postgres'
        }
      },
      models: {
        knex: vi.fn(),
        tags: {
          query: vi.fn().mockReturnValue({
            deleteById: vi.fn().mockResolvedValue(1),
            findById: vi.fn().mockReturnValue({
              $relatedQuery: vi.fn().mockReturnValue({
                unrelate: vi.fn().mockResolvedValue(1)
              }),
              patch: vi.fn().mockResolvedValue(1)
            })
          })
        },
        pages: {
          deletePage: vi.fn().mockResolvedValue(undefined),
          getPageFromDb: vi.fn().mockResolvedValue({
            id: 7,
            path: 'docs/alpha',
            hash: 'abc123',
            title: 'Alpha',
            description: 'Alpha description',
            isPrivate: false,
            isPublished: true,
            privateNS: null,
            publishStartDate: null,
            publishEndDate: null,
            contentType: 'markdown',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
            editorKey: 'markdown',
            localeCode: 'en',
            authorId: 2,
            authorName: 'Author',
            authorEmail: 'author@example.com',
            creatorId: 1,
            creatorName: 'Creator',
            creatorEmail: 'creator@example.com',
            extra: { js: 'console.log(1)', css: '.x{}' }
          }),
          query: vi.fn().mockReturnValue({
            column: vi.fn().mockReturnValue({
              withGraphJoined: vi.fn().mockReturnValue({
                modifyGraph: vi.fn((relation, applyGraphModifier) => {
                  const builder = { select: vi.fn() }
                  applyGraphModifier(builder)
                  return {
                    orderBy: vi.fn().mockReturnValue({
                      limit: vi.fn().mockResolvedValue([
                        {
                          id: 10,
                          locale: 'en',
                          path: 'docs/alpha',
                          title: 'Alpha',
                          updatedAt: '2026-01-03T00:00:00.000Z',
                          tags: [{ tag: 'alpha' }],
                          isPrivate: true
                        },
                        {
                          id: 11,
                          locale: 'fr',
                          path: 'docs/beta',
                          title: 'Beta',
                          updatedAt: '2026-01-02T00:00:00.000Z',
                          tags: [{ tag: 'beta' }]
                        }
                      ])
                    }),
                    __tagBuilder: builder
                  }
                })
              })
            })
          })
        }
      }
    }
  })

  const loadHandler = async () => {
    await import('../../controllers/api/pages.ts')
    return {
      deletePage: express.__router.delete.mock.calls.find(([path]) => path === '/:id')[1],
      deleteTag: express.__router.delete.mock.calls.find(([path]) => path === '/tags/:id')[1],
      getPage: express.__router.get.mock.calls.find(([path]) => path === '/:id')[1],
      links: express.__router.get.mock.calls.find(([path]) => path === '/links')[1],
      listPages: express.__router.get.mock.calls.find(([path]) => path === '/')[1],
      listTags: express.__router.get.mock.calls.find(([path]) => path === '/tags')[1],
      recent: express.__router.get.mock.calls.find(([path]) => path === '/recent')[1],
      updateTag: express.__router.patch.mock.calls.find(([path]) => path === '/tags/:id')[1],
      tree: express.__router.get.mock.calls.find(([path]) => path === '/tree')[1]
    }
  }

  it('lists root page tree entries when parent is zero', async () => {
    const rows = [{
      id: 1,
      path: 'home',
      title: 'Home',
      isFolder: 0,
      isPrivate: 0,
      pageId: 1,
      parent: null,
      localeCode: 'en'
    }]
    const orderBy = vi.fn().mockResolvedValue(rows)
    const queryBuilder = {
      where: vi.fn((applyWhere) => {
        const whereBuilder = {
          andWhere: vi.fn(),
          andWhereNotNull: vi.fn(),
          orWhereIn: vi.fn(),
          where: vi.fn(),
          whereNull: vi.fn()
        }
        applyWhere(whereBuilder)
        return { orderBy }
      })
    }
    global.WIKI.models.knex.mockReturnValue(queryBuilder)
    const { tree } = await loadHandler()
    const req = { query: { locale: 'en', mode: 'ALL', parent: '0' }, user: { id: 1 } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }
    const next = vi.fn()

    await tree(req, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith([{
      ...rows[0],
      isFolder: false,
      isPrivate: false,
      parent: 0,
      locale: 'en'
    }])
    expect(queryBuilder.where).toHaveBeenCalledOnce()
    expect(orderBy).toHaveBeenCalledOnce()
  })

  it('registers the page list route', async () => {
    const { listPages } = await loadHandler()

    expect(typeof listPages).toBe('function')
  })

  it('lists pages with GraphQL-compatible query semantics and access filtering', async () => {
    const rows = [
      {
        id: 10,
        locale: 'en',
        path: 'docs/alpha',
        title: 'Alpha',
        description: 'Alpha description',
        isPublished: true,
        isPrivate: false,
        privateNS: '',
        contentType: 'markdown',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        tags: [{ tag: 'alpha' }, { tag: 'docs' }]
      },
      {
        id: 11,
        locale: 'fr',
        path: 'docs/beta',
        title: 'Beta',
        description: 'Beta description',
        isPublished: false,
        isPrivate: true,
        privateNS: 'team',
        contentType: 'markdown',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z',
        tags: [{ tag: 'beta' }]
      }
    ]
    const queryBuilder = {
      limit: vi.fn(),
      where: vi.fn(),
      whereIn: vi.fn(),
      orderBy: vi.fn()
    }
    const modify = vi.fn((applyQueryModifier) => {
      applyQueryModifier(queryBuilder)
      return Promise.resolve(rows)
    })
    const tagBuilder = { select: vi.fn() }
    const modifyGraph = vi.fn((relation, applyGraphModifier) => {
      applyGraphModifier(tagBuilder)
      return { modify }
    })
    const withGraphJoined = vi.fn().mockReturnValue({ modifyGraph })
    const column = vi.fn().mockReturnValue({ withGraphJoined })
    global.WIKI.models.pages.query.mockReturnValueOnce({ column })
    global.WIKI.auth.checkAccess
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const { listPages } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, query: { locale: 'en', limit: '50', orderBy: 'UPDATED', orderByDirection: 'DESC', tags: 'alpha, docs' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await listPages(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(1, { permissions: ['read:pages'] }, ['manage:system', 'read:pages'])
    expect(column).toHaveBeenCalledWith([
      'pages.id',
      'path',
      { locale: 'localeCode' },
      'title',
      'description',
      'isPublished',
      'isPrivate',
      'privateNS',
      'contentType',
      'createdAt',
      'updatedAt'
    ])
    expect(withGraphJoined).toHaveBeenCalledWith('tags')
    expect(modifyGraph).toHaveBeenCalledWith('tags', expect.any(Function))
    expect(tagBuilder.select).toHaveBeenCalledWith('tag')
    expect(queryBuilder.limit).toHaveBeenCalledWith(50)
    expect(queryBuilder.where).toHaveBeenCalledWith('localeCode', 'en')
    expect(queryBuilder.whereIn).toHaveBeenCalledWith('tags.tag', ['alpha', 'docs'])
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('updatedAt', 'desc')
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(2, { permissions: ['read:pages'] }, ['read:pages'], { path: 'docs/alpha', locale: 'en' })
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(3, { permissions: ['read:pages'] }, ['read:pages'], { path: 'docs/beta', locale: 'fr' })
    expect(res.json).toHaveBeenCalledWith([
      {
        id: 10,
        locale: 'en',
        path: 'docs/alpha',
        title: 'Alpha',
        description: 'Alpha description',
        isPublished: true,
        isPrivate: false,
        privateNS: '',
        contentType: 'markdown',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
        tags: ['alpha', 'docs']
      }
    ])
  })

  it('returns 403 for unauthorized page list requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { listPages } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, query: {} }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await listPages(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system or read:pages is required' })
    expect(global.WIKI.models.pages.query).not.toHaveBeenCalled()
  })

  it('forwards unexpected page list failures to next', async () => {
    const next = vi.fn()
    global.WIKI.models.pages.query.mockReturnValueOnce({
      column: vi.fn().mockReturnValue({
        withGraphJoined: vi.fn().mockReturnValue({
          modifyGraph: vi.fn((relation, applyGraphModifier) => {
            applyGraphModifier({ select: vi.fn() })
            return {
              modify: vi.fn().mockRejectedValue(new Error('page list db down'))
            }
          })
        })
      })
    })
    const { listPages } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, query: {} }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await listPages(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('page list db down')
  })

  it('registers the page tags route', async () => {
    const { listTags } = await loadHandler()

    expect(typeof listTags).toBe('function')
  })

  it('lists unique page tags with GraphQL-compatible access filtering and tag ordering', async () => {
    const withGraphJoined = vi.fn().mockResolvedValue([
      {
        locale: 'en',
        path: 'docs/public',
        tags: [
          { id: 2, tag: 'zeta', title: 'Zeta', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' },
          { id: 1, tag: 'alpha', title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z' }
        ]
      },
      {
        locale: 'fr',
        path: 'docs/private',
        tags: [
          { id: 3, tag: 'hidden', title: 'Hidden', createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-06T00:00:00.000Z' }
        ]
      },
      {
        locale: 'en',
        path: 'docs/duplicate',
        tags: [
          { id: 2, tag: 'zeta', title: 'Zeta Duplicate', createdAt: '2026-01-07T00:00:00.000Z', updatedAt: '2026-01-08T00:00:00.000Z' }
        ]
      }
    ])
    const column = vi.fn().mockReturnValue({ withGraphJoined })
    global.WIKI.models.pages.query.mockReturnValueOnce({ column })
    global.WIKI.auth.checkAccess
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    const { listTags } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await listTags(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(1, { permissions: ['read:pages'] }, ['manage:system', 'read:pages'])
    expect(column).toHaveBeenCalledWith([
      'path',
      { locale: 'localeCode' }
    ])
    expect(withGraphJoined).toHaveBeenCalledWith('tags')
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(2, { permissions: ['read:pages'] }, ['read:pages'], { path: 'docs/public', locale: 'en' })
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(3, { permissions: ['read:pages'] }, ['read:pages'], { path: 'docs/private', locale: 'fr' })
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(4, { permissions: ['read:pages'] }, ['read:pages'], { path: 'docs/duplicate', locale: 'en' })
    expect(res.json).toHaveBeenCalledWith([
      { id: 1, tag: 'alpha', title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z' },
      { id: 2, tag: 'zeta', title: 'Zeta', createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' }
    ])
  })

  it('returns 403 for unauthorized page tag list requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { listTags } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await listTags(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system or read:pages is required' })
    expect(global.WIKI.models.pages.query).not.toHaveBeenCalled()
  })

  it('forwards unexpected page tag list failures to next', async () => {
    const next = vi.fn()
    const withGraphJoined = vi.fn().mockRejectedValue(new Error('tags db down'))
    const column = vi.fn().mockReturnValue({ withGraphJoined })
    global.WIKI.models.pages.query.mockReturnValueOnce({ column })
    const { listTags } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await listTags(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('tags db down')
  })

  it('registers the recent pages route', async () => {
    const { recent } = await loadHandler()

    expect(typeof recent).toBe('function')
  })

  it('returns the minimal dashboard recent-pages payload for authorized requests', async () => {
    const { recent } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await recent(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(1, { permissions: ['read:pages'] }, ['manage:system', 'read:pages'])
    expect(global.WIKI.models.pages.query).toHaveBeenCalled()
    const queryBuilder = global.WIKI.models.pages.query.mock.results[0].value
    expect(queryBuilder.column).toHaveBeenCalledWith(['pages.id', 'path', { locale: 'localeCode' }, 'title', 'updatedAt'])
    const columnBuilder = queryBuilder.column.mock.results[0].value
    expect(columnBuilder.withGraphJoined).toHaveBeenCalledWith('tags')
    const tagJoinBuilder = columnBuilder.withGraphJoined.mock.results[0].value
    expect(tagJoinBuilder.modifyGraph).toHaveBeenCalledWith('tags', expect.any(Function))
    const modifiedBuilder = tagJoinBuilder.modifyGraph.mock.results[0].value
    expect(modifiedBuilder.__tagBuilder.select).toHaveBeenCalledWith('tag')
    expect(modifiedBuilder.orderBy).toHaveBeenCalledWith('updatedAt', 'desc')
    expect(modifiedBuilder.orderBy.mock.results[0].value.limit).toHaveBeenCalledWith(10)
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(2, { permissions: ['read:pages'] }, ['read:pages'], { path: 'docs/alpha', locale: 'en', tags: [{ tag: 'alpha' }] })
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(3, { permissions: ['read:pages'] }, ['read:pages'], { path: 'docs/beta', locale: 'fr', tags: [{ tag: 'beta' }] })
    expect(res.json).toHaveBeenCalledWith([
      { id: 10, locale: 'en', path: 'docs/alpha', title: 'Alpha', updatedAt: '2026-01-03T00:00:00.000Z' },
      { id: 11, locale: 'fr', path: 'docs/beta', title: 'Beta', updatedAt: '2026-01-02T00:00:00.000Z' }
    ])
  })

  it('filters pages that fail per-row page access checks', async () => {
    global.WIKI.auth.checkAccess
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const { recent } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await recent(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith([
      { id: 10, locale: 'en', path: 'docs/alpha', title: 'Alpha', updatedAt: '2026-01-03T00:00:00.000Z' }
    ])
  })

  it('returns 403 for unauthorized recent-pages requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { recent } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await recent(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system or read:pages is required' })
    expect(global.WIKI.models.pages.query).not.toHaveBeenCalled()
  })

  it('forwards unexpected recent-pages failures to next', async () => {
    const next = vi.fn()
    global.WIKI.models.pages.query.mockReturnValueOnce({
      column: vi.fn().mockReturnValue({
        withGraphJoined: vi.fn().mockReturnValue({
          modifyGraph: vi.fn((relation, applyGraphModifier) => {
            applyGraphModifier({ select: vi.fn() })
            return {
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockRejectedValue(new Error('pages db down'))
              })
            }
          })
        })
      })
    })
    const { recent } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await recent(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('pages db down')
  })

  it('registers the page links route before the page detail route', async () => {
    const { links } = await loadHandler()
    const routes = express.__router.get.mock.calls.map(([path]) => path)

    expect(typeof links).toBe('function')
    expect(routes.indexOf('/links')).toBeGreaterThan(-1)
    expect(routes.indexOf('/links')).toBeLessThan(routes.indexOf('/:id'))
  })

  it('returns GraphQL-compatible page links with default database join semantics', async () => {
    const rows = [
      { id: 1, path: 'docs/home', title: 'Home', link: 'docs/target', locale: 'en' },
      { id: 1, path: 'docs/home', title: 'Home', link: 'docs/other', locale: 'fr' },
      { id: 2, path: 'docs/target', title: 'Target', link: null, locale: null }
    ]
    const chain = {
      column: vi.fn().mockReturnThis(),
      fullOuterJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(rows)
    }
    global.WIKI.models.knex.mockReturnValueOnce(chain)
    const { links } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, query: { locale: 'en' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await links(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(1, { permissions: ['read:pages'] }, ['manage:system', 'read:pages'])
    expect(global.WIKI.models.knex).toHaveBeenCalledWith('pages')
    expect(chain.column).toHaveBeenCalledWith({ id: 'pages.id' }, { path: 'pages.path' }, 'title', { link: 'pageLinks.path' }, { locale: 'pageLinks.localeCode' })
    expect(chain.fullOuterJoin).toHaveBeenCalledWith('pageLinks', 'pages.id', 'pageLinks.pageId')
    expect(chain.where).toHaveBeenCalledWith({ 'pages.localeCode': 'en' })
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(2, { permissions: ['read:pages'] }, ['read:pages'], { path: 'docs/home', locale: 'en' })
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(3, { permissions: ['read:pages'] }, ['read:pages'], { path: 'docs/target', locale: 'en' })
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(7, { permissions: ['read:pages'] }, ['read:pages'], { path: null, locale: null })
    expect(res.json).toHaveBeenCalledWith([
      { id: 1, title: 'Home', path: 'en/docs/home', links: ['en/docs/target', 'fr/docs/other'] },
      { id: 2, title: 'Target', path: 'en/docs/target', links: [] }
    ])
  })

  it('returns GraphQL-compatible page links with mysql-style union semantics', async () => {
    global.WIKI.config.db.type = 'mysql'
    const rows = [
      { id: 1, path: 'docs/home', title: 'Home', link: 'docs/target', locale: 'en' }
    ]
    const primary = {
      column: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      unionAll: vi.fn().mockResolvedValue(rows)
    }
    const secondary = {
      column: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis()
    }
    global.WIKI.models.knex
      .mockReturnValueOnce(primary)
      .mockReturnValueOnce(secondary)
    const { links } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, query: { locale: 'en' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await links(req, res, vi.fn())

    expect(global.WIKI.models.knex).toHaveBeenNthCalledWith(1, 'pages')
    expect(global.WIKI.models.knex).toHaveBeenNthCalledWith(2, 'pageLinks')
    expect(primary.leftJoin).toHaveBeenCalledWith('pageLinks', 'pages.id', 'pageLinks.pageId')
    expect(secondary.leftJoin).toHaveBeenCalledWith('pages', 'pageLinks.pageId', 'pages.id')
    expect(primary.unionAll).toHaveBeenCalledWith(secondary)
    expect(res.json).toHaveBeenCalledWith([
      { id: 1, title: 'Home', path: 'en/docs/home', links: ['en/docs/target'] }
    ])
  })

  it('filters page links when source or target page access is denied', async () => {
    const rows = [
      { id: 1, path: 'docs/home', title: 'Home', link: 'docs/target', locale: 'en' },
      { id: 2, path: 'docs/hidden-source', title: 'Hidden Source', link: 'docs/target', locale: 'en' },
      { id: 3, path: 'docs/hidden-target', title: 'Hidden Target', link: 'docs/secret', locale: 'en' }
    ]
    const chain = {
      column: vi.fn().mockReturnThis(),
      fullOuterJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(rows)
    }
    global.WIKI.models.knex.mockReturnValueOnce(chain)
    global.WIKI.auth.checkAccess
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const { links } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, query: { locale: 'en' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await links(req, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith([
      { id: 1, title: 'Home', path: 'en/docs/home', links: ['en/docs/target'] }
    ])
  })

  it('returns 400 for invalid page links locale requests', async () => {
    const { links } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, query: { locale: '' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await links(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'locale must be a non-empty string' })
    expect(global.WIKI.models.knex).not.toHaveBeenCalled()
  })

  it('returns 403 for unauthorized page links requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { links } = await loadHandler()
    const req = { user: { permissions: ['manage:api'] }, query: { locale: 'en' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await links(req, res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system or read:pages is required' })
    expect(global.WIKI.models.knex).not.toHaveBeenCalled()
  })

  it('forwards unexpected page links failures to next', async () => {
    const next = vi.fn()
    const chain = {
      column: vi.fn().mockReturnThis(),
      fullOuterJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(new Error('links db down'))
    }
    global.WIKI.models.knex.mockReturnValueOnce(chain)
    const { links } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, query: { locale: 'en' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await links(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('links db down')
  })

  it('registers the page detail route', async () => {
    const { getPage } = await loadHandler()

    expect(typeof getPage).toBe('function')
  })

  it('returns GraphQL-compatible page details for authorized page detail requests', async () => {
    global.WIKI.auth.checkAccess
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
    const { getPage } = await loadHandler()
    const req = { user: { permissions: ['manage:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(1, { permissions: ['manage:pages'] }, ['read:pages', 'manage:system'])
    expect(global.WIKI.models.pages.getPageFromDb).toHaveBeenCalledWith(7)
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(2, { permissions: ['manage:pages'] }, ['manage:pages', 'delete:pages'], { path: 'docs/alpha', locale: 'en' })
    expect(global.WIKI.auth.checkAccess).toHaveBeenNthCalledWith(3, { permissions: ['manage:pages'] }, ['write:pages', 'manage:system'])
    expect(res.json).toHaveBeenCalledWith({
      id: 7,
      path: 'docs/alpha',
      hash: 'abc123',
      title: 'Alpha',
      description: 'Alpha description',
      isPrivate: false,
      isPublished: true,
      privateNS: null,
      publishStartDate: null,
      publishEndDate: null,
      contentType: 'markdown',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      editor: 'markdown',
      locale: 'en',
      authorId: 2,
      authorName: 'Author',
      authorEmail: 'author@example.com',
      creatorId: 1,
      creatorName: 'Creator',
      creatorEmail: 'creator@example.com'
    })
  })

  it.each([
    ['0'],
    ['1.9'],
    ['Infinity'],
    ['9007199254740992']
  ])('rejects invalid page detail ids: %s', async (id) => {
    const { getPage } = await loadHandler()
    const req = { user: { permissions: ['manage:pages'] }, params: { id } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
    expect(global.WIKI.models.pages.getPageFromDb).not.toHaveBeenCalled()
  })

  it('returns 404 when page detail is missing', async () => {
    global.WIKI.models.pages.getPageFromDb.mockResolvedValueOnce(null)
    const { getPage } = await loadHandler()
    const req = { user: { permissions: ['manage:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'This page does not exist.' })
  })

  it('returns 403 when page detail route access is denied', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { getPage } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'read:pages or manage:system is required' })
    expect(global.WIKI.models.pages.getPageFromDb).not.toHaveBeenCalled()
  })

  it('returns 403 when scoped page detail access is denied', async () => {
    global.WIKI.auth.checkAccess
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const { getPage } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'You are not authorized to view this page.' })
  })

  it('returns 403 when page detail field access is denied', async () => {
    global.WIKI.auth.checkAccess
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const { getPage } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'write:pages or manage:system is required' })
  })

  it('forwards unexpected page detail failures to next', async () => {
    const next = vi.fn()
    global.WIKI.auth.checkAccess.mockReturnValueOnce(true)
    global.WIKI.models.pages.getPageFromDb.mockRejectedValueOnce(new Error('page db down'))
    const { getPage } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await getPage(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('page db down')
  })

  it('registers the page delete route', async () => {
    const { deletePage } = await loadHandler()

    expect(typeof deletePage).toBe('function')
  })

  it('requires delete:pages or manage:system for page deletes', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { deletePage } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deletePage(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['read:pages'] }, ['delete:pages', 'manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'delete:pages or manage:system is required' })
    expect(global.WIKI.models.pages.deletePage).not.toHaveBeenCalled()
  })

  it.each([
    ['0'],
    ['1.9'],
    ['Infinity'],
    ['9007199254740992']
  ])('rejects invalid page delete ids: %s', async (id) => {
    const { deletePage } = await loadHandler()
    const req = { user: { permissions: ['delete:pages'] }, params: { id } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deletePage(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
    expect(global.WIKI.models.pages.deletePage).not.toHaveBeenCalled()
  })

  it('deletes pages through the model with GraphQL-compatible user context', async () => {
    const { deletePage } = await loadHandler()
    const req = { user: { id: 5, permissions: ['delete:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deletePage(req, res)

    expect(global.WIKI.models.pages.deletePage).toHaveBeenCalledWith({
      id: 7,
      user: { id: 5, permissions: ['delete:pages'] }
    })
    expect(res.json).toHaveBeenCalledWith({ message: 'Page has been deleted.' })
  })

  it('maps page delete not-found failures to JSON 404 errors', async () => {
    const err = new Error('This page does not exist.')
    err.name = 'PageNotFound'
    global.WIKI.models.pages.deletePage.mockRejectedValueOnce(err)
    const { deletePage } = await loadHandler()
    const req = { user: { permissions: ['delete:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deletePage(req, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'This page does not exist.' })
  })

  it('maps page delete model authorization failures to JSON 403 errors', async () => {
    const err = new Error('You are not authorized to delete this page.')
    err.name = 'PageDeleteForbidden'
    global.WIKI.models.pages.deletePage.mockRejectedValueOnce(err)
    const { deletePage } = await loadHandler()
    const req = { user: { permissions: ['delete:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deletePage(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'You are not authorized to delete this page.' })
  })

  it('returns JSON errors for unexpected page delete failures', async () => {
    global.WIKI.models.pages.deletePage.mockRejectedValueOnce(new Error('page db down'))
    const { deletePage } = await loadHandler()
    const req = { user: { permissions: ['delete:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deletePage(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'page db down' })
  })

  it('registers the tag update route', async () => {
    const { updateTag } = await loadHandler()

    expect(typeof updateTag).toBe('function')
  })

  it('requires manage:system for tag updates', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { updateTag } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, params: { id: '7' }, body: { tag: 'News', title: 'News' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTag(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['read:pages'] }, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system is required' })
    expect(global.WIKI.models.tags.query).not.toHaveBeenCalled()
  })

  it.each([
    ['0'],
    ['1.9'],
    ['Infinity'],
    ['9007199254740992']
  ])('rejects invalid tag update ids: %s', async (id) => {
    const { updateTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id }, body: { tag: 'News', title: 'News' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTag(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
    expect(global.WIKI.models.tags.query).not.toHaveBeenCalled()
  })

  it.each([
    [{ tag: 12, title: 'News' }, 'tag must be a string'],
    [{ tag: 'News', title: null }, 'title must be a string']
  ])('rejects malformed tag update payloads', async (body, error) => {
    const { updateTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' }, body }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTag(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error })
    expect(global.WIKI.models.tags.query).not.toHaveBeenCalled()
  })

  it('updates tags with GraphQL-compatible trim and lowercase semantics', async () => {
    const { updateTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' }, body: { tag: '  News  ', title: '  Current News  ' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTag(req, res)

    const tagsQuery = global.WIKI.models.tags.query.mock.results[0].value
    expect(tagsQuery.findById).toHaveBeenCalledWith(7)
    const tagPatch = tagsQuery.findById.mock.results[0].value
    expect(tagPatch.patch).toHaveBeenCalledWith({ tag: 'news', title: 'Current News' })
    expect(res.json).toHaveBeenCalledWith({ message: 'Tag has been updated successfully.' })
  })

  it('allows empty strings to preserve existing updateTag GraphQL write semantics', async () => {
    const { updateTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' }, body: { tag: '', title: '' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTag(req, res)

    const tagsQuery = global.WIKI.models.tags.query.mock.results[0].value
    expect(tagsQuery.findById.mock.results[0].value.patch).toHaveBeenCalledWith({ tag: '', title: '' })
    expect(res.json).toHaveBeenCalledWith({ message: 'Tag has been updated successfully.' })
  })

  it('returns a JSON 404 when a tag update affects no rows', async () => {
    global.WIKI.models.tags.query.mockReturnValueOnce({
      findById: vi.fn().mockReturnValue({
        patch: vi.fn().mockResolvedValue(0)
      })
    })
    const { updateTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' }, body: { tag: 'News', title: 'News' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTag(req, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'This tag does not exist.' })
  })

  it('returns JSON errors for unexpected tag update failures', async () => {
    global.WIKI.models.tags.query.mockReturnValueOnce({
      findById: vi.fn().mockReturnValue({
        patch: vi.fn().mockRejectedValue(new Error('tag db down'))
      })
    })
    const { updateTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' }, body: { tag: 'News', title: 'News' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await updateTag(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'tag db down' })
  })

  it('registers the tag delete route', async () => {
    const { deleteTag } = await loadHandler()

    expect(typeof deleteTag).toBe('function')
  })

  it('requires manage:system for tag deletes', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { deleteTag } = await loadHandler()
    const req = { user: { permissions: ['read:pages'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteTag(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['read:pages'] }, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system is required' })
    expect(global.WIKI.models.tags.query).not.toHaveBeenCalled()
  })

  it.each([
    ['0'],
    ['1.9'],
    ['Infinity'],
    ['9007199254740992']
  ])('rejects invalid tag delete ids: %s', async (id) => {
    const { deleteTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteTag(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
    expect(global.WIKI.models.tags.query).not.toHaveBeenCalled()
  })

  it('deletes tags with GraphQL-compatible unrelate-then-delete semantics', async () => {
    const { deleteTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteTag(req, res)

    const findQuery = global.WIKI.models.tags.query.mock.results[0].value
    expect(findQuery.findById).toHaveBeenCalledWith(7)
    const tagToDel = findQuery.findById.mock.results[0].value
    expect(tagToDel.$relatedQuery).toHaveBeenCalledWith('pages')
    expect(tagToDel.$relatedQuery.mock.results[0].value.unrelate).toHaveBeenCalled()
    const deleteQuery = global.WIKI.models.tags.query.mock.results[1].value
    expect(deleteQuery.deleteById).toHaveBeenCalledWith(7)
    expect(res.json).toHaveBeenCalledWith({ message: 'Tag has been deleted.' })
  })

  it('returns a JSON 404 when deleting a missing tag', async () => {
    global.WIKI.models.tags.query.mockReturnValueOnce({
      findById: vi.fn().mockResolvedValue(null)
    })
    const { deleteTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteTag(req, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'This tag does not exist.' })
  })

  it('returns JSON errors for unexpected tag delete failures', async () => {
    global.WIKI.models.tags.query.mockReturnValueOnce({
      findById: vi.fn().mockReturnValue({
        $relatedQuery: vi.fn().mockReturnValue({
          unrelate: vi.fn().mockRejectedValue(new Error('unrelate failed'))
        })
      })
    })
    const { deleteTag } = await loadHandler()
    const req = { user: { permissions: ['manage:system'] }, params: { id: '7' } }
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() }

    await deleteTag(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'unrelate failed' })
  })
})
