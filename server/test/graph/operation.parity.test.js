const operationMocks = vi.hoisted(() => ({
  users: {
    search: vi.fn(),
    setActive: vi.fn()
  },
  groups: {
    get: vi.fn(),
    listUsers: vi.fn(),
    create: vi.fn()
  },
  pages: {
    list: vi.fn(),
    create: vi.fn()
  },
  comments: {
    list: vi.fn(),
    create: vi.fn()
  }
}))

vi.mockModule('../../operations/users.ts', import.meta.url, () => ({ default: operationMocks.users }))
vi.mockModule('../../operations/groups.ts', import.meta.url, () => ({ default: operationMocks.groups }))
vi.mockModule('../../operations/pages.ts', import.meta.url, () => ({ default: operationMocks.pages }))
vi.mockModule('../../operations/comments.ts', import.meta.url, () => ({ default: operationMocks.comments }))

vi.mockModule('express', import.meta.url, () => {
  const Router = () => {
    const routes = new Map()
    const router = {
      handler (method, path) {
        const handler = routes.get(`${method} ${path}`)
        if (!handler) throw new Error(`Route not registered: ${method} ${path}`)
        return handler
      }
    }

    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
      router[method] = vi.fn((path, ...handlers) => {
        routes.set(`${method} ${path}`, handlers.at(-1))
        return router
      })
    }

    return router
  }
  const expressMock = { Router }
  return { default: expressMock, ...expressMock }
})

const makeResponse = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn().mockReturnThis()
})

const expectEquivalentOperationInputs = (operation, input) => {
  expect(operation).toHaveBeenCalledTimes(2)
  expect(operation).toHaveBeenNthCalledWith(1, input)
  expect(operation).toHaveBeenNthCalledWith(2, input)
}

const operationError = (message, { status, code, name }) => {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.name = name
  return error
}

const graphSuccess = message => ({
  succeeded: true,
  errorCode: 0,
  slug: 'ok',
  message
})

let adapters
let previousWiki

beforeAll(async () => {
  previousWiki = global.WIKI
  global.WIKI = {
    auth: {
      checkAccess: vi.fn().mockReturnValue(true)
    }
  }

  const [
    usersController,
    usersResolver,
    groupsController,
    groupsResolver,
    pagesController,
    pagesResolver,
    commentsController,
    commentsResolver
  ] = await Promise.all([
    import('../../controllers/api/users.ts'),
    import('../../graph/resolvers/user.ts'),
    import('../../controllers/api/groups.ts'),
    import('../../graph/resolvers/group.ts'),
    import('../../controllers/api/pages.ts'),
    import('../../graph/resolvers/page.ts'),
    import('../../controllers/api/comments.ts'),
    import('../../graph/resolvers/comment.ts')
  ])

  adapters = {
    users: { router: usersController.default, resolver: usersResolver.default },
    groups: { router: groupsController.default, resolver: groupsResolver.default },
    pages: { router: pagesController.default, resolver: pagesResolver.default },
    comments: { router: commentsController.default, resolver: commentsResolver.default }
  }
})

afterAll(() => {
  global.WIKI = previousWiki
})

beforeEach(() => {
  global.WIKI.auth.checkAccess.mockReturnValue(true)
})

describe('REST and GraphQL shared operation parity', () => {
  describe('users', () => {
    it('normalizes search queries into the same operation call and preserves query transport behavior', async () => {
      const users = [
        { id: 7, name: 'Alice', email: 'alice@example.com', providerKey: 'local', internal: 'not-rest-visible' }
      ]
      operationMocks.users.search.mockResolvedValue(users)
      const requester = { id: 1, permissions: ['manage:users'] }
      const restResponse = makeResponse()
      const restNext = vi.fn()

      await adapters.users.router.handler('get', '/search')(
        { user: requester, query: { query: '  alice  ' } },
        restResponse,
        restNext
      )
      const graphResult = await adapters.users.resolver.UserQuery.search(null, { query: 'alice' })

      expectEquivalentOperationInputs(operationMocks.users.search, 'alice')
      expect(restResponse.json).toHaveBeenCalledWith([
        { id: 7, name: 'Alice', email: 'alice@example.com', providerKey: 'local' }
      ])
      expect(restNext).not.toHaveBeenCalled()
      expect(graphResult).toBe(users)

      operationMocks.users.search.mockClear()
      const failure = operationError('search unavailable', { status: 503, code: 71, name: 'Unavailable' })
      operationMocks.users.search.mockRejectedValue(failure)
      const failedRestResponse = makeResponse()
      const failedRestNext = vi.fn()

      await adapters.users.router.handler('get', '/search')(
        { user: requester, query: { query: ' alice ' } },
        failedRestResponse,
        failedRestNext
      )
      await expect(Promise.resolve(adapters.users.resolver.UserQuery.search(null, { query: 'alice' }))).rejects.toBe(failure)

      expectEquivalentOperationInputs(operationMocks.users.search, 'alice')
      expect(failedRestNext).toHaveBeenCalledWith(failure)
      expect(failedRestResponse.json).not.toHaveBeenCalled()
    })

    it('normalizes activation mutations and maps success and errors per transport', async () => {
      operationMocks.users.setActive.mockResolvedValue(undefined)
      const requester = { id: 1, permissions: ['manage:users'] }
      const restResponse = makeResponse()

      await adapters.users.router.handler('patch', '/:id/status')(
        { user: requester, params: { id: '42' }, body: { isActive: true } },
        restResponse,
        vi.fn()
      )
      const graphResult = await adapters.users.resolver.UserMutation.activate(null, { id: 42 })

      const expectedInput = { id: 42, isActive: true }
      expectEquivalentOperationInputs(operationMocks.users.setActive, expectedInput)
      expect(restResponse.json).toHaveBeenCalledWith({
        succeeded: true,
        message: 'User activated successfully'
      })
      expect(graphResult).toEqual({ responseResult: graphSuccess('User activated successfully') })

      operationMocks.users.setActive.mockClear()
      const failure = operationError('activation denied', { status: 409, code: 73, name: 'Conflict' })
      operationMocks.users.setActive.mockRejectedValue(failure)
      const failedRestResponse = makeResponse()

      await adapters.users.router.handler('patch', '/:id/status')(
        { user: requester, params: { id: '42' }, body: { isActive: true } },
        failedRestResponse,
        vi.fn()
      )
      const failedGraphResult = await adapters.users.resolver.UserMutation.activate(null, { id: 42 })

      expectEquivalentOperationInputs(operationMocks.users.setActive, expectedInput)
      expect(failedRestResponse.status).toHaveBeenCalledWith(409)
      expect(failedRestResponse.json).toHaveBeenCalledWith({ error: 'activation denied' })
      expect(failedGraphResult).toEqual({
        responseResult: { succeeded: false, errorCode: 73, slug: 'Conflict', message: 'activation denied' }
      })
    })
  })

  describe('groups', () => {
    it('normalizes single-group queries into the same operation call and preserves query transport behavior', async () => {
      const group = {
        id: 9,
        name: 'Editors',
        redirectOnLogin: '/edit',
        isSystem: false,
        permissions: ['write:pages'],
        pageRules: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
      operationMocks.groups.get.mockResolvedValue(group)
      operationMocks.groups.listUsers.mockResolvedValue([])
      const requester = { id: 1, permissions: ['manage:groups'] }
      const restResponse = makeResponse()
      const restNext = vi.fn()

      await adapters.groups.router.handler('get', '/:id')(
        { user: requester, params: { id: '9' } },
        restResponse,
        restNext
      )
      const graphResult = await adapters.groups.resolver.GroupQuery.single(null, { id: 9 })

      expectEquivalentOperationInputs(operationMocks.groups.get, 9)
      expect(restResponse.json).toHaveBeenCalledWith({ ...group, users: [] })
      expect(restNext).not.toHaveBeenCalled()
      expect(graphResult).toBe(group)

      operationMocks.groups.get.mockClear()
      const failure = operationError('group lookup failed', { status: 503, code: 81, name: 'Unavailable' })
      operationMocks.groups.get.mockRejectedValue(failure)
      const failedRestResponse = makeResponse()
      const failedRestNext = vi.fn()

      await adapters.groups.router.handler('get', '/:id')(
        { user: requester, params: { id: '9' } },
        failedRestResponse,
        failedRestNext
      )
      await expect(Promise.resolve(adapters.groups.resolver.GroupQuery.single(null, { id: 9 }))).rejects.toBe(failure)

      expectEquivalentOperationInputs(operationMocks.groups.get, 9)
      expect(failedRestNext).toHaveBeenCalledWith(failure)
      expect(failedRestResponse.json).not.toHaveBeenCalled()
    })

    it('normalizes create mutations and maps success and errors per transport', async () => {
      const group = { id: 9, name: 'Editors', isSystem: false }
      operationMocks.groups.create.mockResolvedValue(group)
      const requester = { id: 1, permissions: ['manage:groups'] }
      const restResponse = makeResponse()

      await adapters.groups.router.handler('post', '/')(
        { user: requester, body: { name: '  Editors  ' } },
        restResponse,
        vi.fn()
      )
      const graphResult = await adapters.groups.resolver.GroupMutation.create(null, { name: 'Editors' })

      expectEquivalentOperationInputs(operationMocks.groups.create, 'Editors')
      expect(restResponse.json).toHaveBeenCalledWith({
        succeeded: true,
        message: 'Group created successfully.',
        group
      })
      expect(graphResult).toEqual({ responseResult: graphSuccess('Group created successfully.'), group })

      operationMocks.groups.create.mockClear()
      const failure = operationError('group already exists', { status: 409, code: 82, name: 'Conflict' })
      operationMocks.groups.create.mockRejectedValue(failure)
      const failedRestResponse = makeResponse()

      await adapters.groups.router.handler('post', '/')(
        { user: requester, body: { name: ' Editors ' } },
        failedRestResponse,
        vi.fn()
      )
      await expect(Promise.resolve(adapters.groups.resolver.GroupMutation.create(null, { name: 'Editors' }))).rejects.toBe(failure)

      expectEquivalentOperationInputs(operationMocks.groups.create, 'Editors')
      expect(failedRestResponse.status).toHaveBeenCalledWith(409)
      expect(failedRestResponse.json).toHaveBeenCalledWith({ error: 'group already exists' })
    })
  })

  describe('pages', () => {
    it('normalizes list queries into the same operation call and preserves query transport behavior', async () => {
      const pages = [{
        id: 12,
        path: 'guide',
        locale: 'en',
        title: 'Guide',
        description: 'A guide',
        isPublished: true,
        visibility: 'public',
        ownerId: null,
        contentType: 'markdown',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        tags: ['docs', 'api']
      }]
      operationMocks.pages.list.mockResolvedValue(pages)
      const requester = { id: 1, permissions: ['read:pages'] }
      const normalizedQuery = {
        requester,
        tags: ['docs', 'api'],
        limit: 5,
        creatorId: 8,
        locale: 'en',
        orderBy: 'title',
        orderByDirection: 'asc'
      }
      const restResponse = makeResponse()
      const restNext = vi.fn()

      await adapters.pages.router.handler('get', '/')(
        {
          user: requester,
          query: {
            tags: ' Docs, API ',
            limit: '5',
            creatorId: '8',
            locale: 'en',
            orderBy: 'title',
            orderByDirection: 'asc'
          }
        },
        restResponse,
        restNext
      )
      const graphResult = await adapters.pages.resolver.PageQuery.list(
        null,
        {
          tags: ['docs', 'api'],
          limit: 5,
          creatorId: 8,
          locale: 'en',
          orderBy: 'title',
          orderByDirection: 'asc'
        },
        { req: { user: requester } }
      )

      expectEquivalentOperationInputs(operationMocks.pages.list, normalizedQuery)
      expect(restResponse.json).toHaveBeenCalledWith(pages)
      expect(restNext).not.toHaveBeenCalled()
      expect(graphResult).toBe(pages)

      operationMocks.pages.list.mockClear()
      const failure = operationError('page list unavailable', { status: 503, code: 91, name: 'Unavailable' })
      operationMocks.pages.list.mockRejectedValue(failure)
      const failedRestResponse = makeResponse()
      const failedRestNext = vi.fn()

      await adapters.pages.router.handler('get', '/')(
        {
          user: requester,
          query: {
            tags: 'docs,api',
            limit: '5',
            creatorId: '8',
            locale: 'en',
            orderBy: 'title',
            orderByDirection: 'asc'
          }
        },
        failedRestResponse,
        failedRestNext
      )
      await expect(Promise.resolve(adapters.pages.resolver.PageQuery.list(
        null,
        {
          tags: ['docs', 'api'],
          limit: 5,
          creatorId: 8,
          locale: 'en',
          orderBy: 'title',
          orderByDirection: 'asc'
        },
        { req: { user: requester } }
      ))).rejects.toBe(failure)

      expectEquivalentOperationInputs(operationMocks.pages.list, normalizedQuery)
      expect(failedRestNext).toHaveBeenCalledWith(failure)
      expect(failedRestResponse.json).not.toHaveBeenCalled()
    })

    it('normalizes create mutations and maps success and errors per transport', async () => {
      const pageInput = { locale: 'en', path: 'guide', content: '# Guide' }
      const page = { id: 12, ...pageInput }
      operationMocks.pages.create.mockResolvedValue(page)
      const requester = { id: 1, permissions: ['write:pages'] }
      const restResponse = makeResponse()

      await adapters.pages.router.handler('post', '/')(
        { user: requester, body: pageInput },
        restResponse
      )
      const graphResult = await adapters.pages.resolver.PageMutation.create(
        null,
        pageInput,
        { req: { user: requester } }
      )

      const expectedInput = { requester, input: pageInput }
      expectEquivalentOperationInputs(operationMocks.pages.create, expectedInput)
      expect(restResponse.status).toHaveBeenCalledWith(201)
      expect(restResponse.json).toHaveBeenCalledWith({ page })
      expect(graphResult).toEqual({ responseResult: graphSuccess('Page created successfully.'), page })

      operationMocks.pages.create.mockClear()
      const failure = operationError('invalid page', { status: 422, code: 92, name: 'ValidationError' })
      operationMocks.pages.create.mockRejectedValue(failure)
      const failedRestResponse = makeResponse()

      await adapters.pages.router.handler('post', '/')(
        { user: requester, body: pageInput },
        failedRestResponse
      )
      const failedGraphResult = await adapters.pages.resolver.PageMutation.create(
        null,
        pageInput,
        { req: { user: requester } }
      )

      expectEquivalentOperationInputs(operationMocks.pages.create, expectedInput)
      expect(failedRestResponse.status).toHaveBeenCalledWith(422)
      expect(failedRestResponse.json).toHaveBeenCalledWith({ error: 'invalid page' })
      expect(failedGraphResult).toEqual({
        responseResult: { succeeded: false, errorCode: 92, slug: 'ValidationError', message: 'invalid page' }
      })
    })
  })

  describe('comments', () => {
    it('passes list queries to the same operation and preserves query transport behavior', async () => {
      const comments = [{ id: 31, content: 'Useful guide' }]
      operationMocks.comments.list.mockResolvedValue(comments)
      const requester = { id: 2, permissions: ['read:comments'] }
      const expectedInput = { requester, pageId: 17 }
      const restResponse = makeResponse()
      const restNext = vi.fn()

      await adapters.comments.router.handler('get', '/')(
        { user: requester, query: { pageId: '17' } },
        restResponse,
        restNext
      )
      const graphResult = await adapters.comments.resolver.CommentQuery.list(
        null,
        { pageId: 17 },
        { req: { user: requester } }
      )

      expectEquivalentOperationInputs(operationMocks.comments.list, expectedInput)
      expect(restResponse.json).toHaveBeenCalledWith(comments)
      expect(restNext).not.toHaveBeenCalled()
      expect(graphResult).toBe(comments)

      operationMocks.comments.list.mockClear()
      const failure = operationError('comment list unavailable', { status: 503, code: 101, name: 'Unavailable' })
      operationMocks.comments.list.mockRejectedValue(failure)
      const failedRestResponse = makeResponse()
      const failedRestNext = vi.fn()

      await adapters.comments.router.handler('get', '/')(
        { user: requester, query: { pageId: '17' } },
        failedRestResponse,
        failedRestNext
      )
      await expect(Promise.resolve(adapters.comments.resolver.CommentQuery.list(
        null,
        { pageId: 17 },
        { req: { user: requester } }
      ))).rejects.toBe(failure)

      expectEquivalentOperationInputs(operationMocks.comments.list, expectedInput)
      expect(failedRestNext).toHaveBeenCalledWith(failure)
      expect(failedRestResponse.json).not.toHaveBeenCalled()
    })

    it('passes create mutations to the same operation and maps success and errors per transport', async () => {
      const input = { locale: 'en', path: 'guide', content: 'Useful guide' }
      operationMocks.comments.create.mockResolvedValue(31)
      const requester = { id: 2, permissions: ['write:comments'] }
      const expectedInput = { requester, ip: '192.0.2.10', input }
      const restResponse = makeResponse()

      await adapters.comments.router.handler('post', '/')(
        { user: requester, ip: '192.0.2.10', body: input },
        restResponse
      )
      const graphResult = await adapters.comments.resolver.CommentMutation.create(
        null,
        input,
        { req: { user: requester, ip: '192.0.2.10' } }
      )

      expectEquivalentOperationInputs(operationMocks.comments.create, expectedInput)
      expect(restResponse.status).toHaveBeenCalledWith(201)
      expect(restResponse.json).toHaveBeenCalledWith({ id: 31 })
      expect(graphResult).toEqual({ responseResult: graphSuccess('New comment posted successfully'), id: 31 })

      operationMocks.comments.create.mockClear()
      const failure = operationError('comment rejected', { status: 429, code: 102, name: 'RateLimited' })
      operationMocks.comments.create.mockRejectedValue(failure)
      const failedRestResponse = makeResponse()

      await adapters.comments.router.handler('post', '/')(
        { user: requester, ip: '192.0.2.10', body: input },
        failedRestResponse
      )
      const failedGraphResult = await adapters.comments.resolver.CommentMutation.create(
        null,
        input,
        { req: { user: requester, ip: '192.0.2.10' } }
      )

      expectEquivalentOperationInputs(operationMocks.comments.create, expectedInput)
      expect(failedRestResponse.status).toHaveBeenCalledWith(429)
      expect(failedRestResponse.json).toHaveBeenCalledWith({ error: 'comment rejected' })
      expect(failedGraphResult).toEqual({
        responseResult: { succeeded: false, errorCode: 102, slug: 'RateLimited', message: 'comment rejected' }
      })
    })
  })
})
