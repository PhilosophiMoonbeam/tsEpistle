import { afterAll, beforeAll } from '../bun-test.mts'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { graphql } from 'graphql/index.js'
import { authDirectiveTransformer } from '../../graph/directives/auth.ts'

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
    create: vi.fn(),
    remove: vi.fn()
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
vi.mockModule('../../operations/page-protection.ts', import.meta.url, () => ({
  assertPageUnlocked: vi.fn().mockResolvedValue(undefined),
  getPageProtection: vi.fn().mockResolvedValue(undefined),
  isPageProtected: vi.fn().mockResolvedValue(false),
  redactProtectedPageForSearch: vi.fn(async page => page),
  removePageProtection: vi.fn().mockResolvedValue(undefined),
  setPageProtection: vi.fn().mockResolvedValue(undefined),
  syncProtectedPageAssets: vi.fn().mockResolvedValue(undefined),
  unlockPage: vi.fn().mockResolvedValue(undefined)
}))

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
  set: vi.fn().mockReturnThis(),
  status: vi.fn().mockReturnThis(),
  vary: vi.fn().mockReturnThis(),
  json: vi.fn().mockReturnThis()
})

const operationError = (message, { status, code, name }) => {
  const error = new Error(message)
  error.status = status
  error.code = code
  error.name = name
  return error
}

const graphSuccess = () => ({
  succeeded: true,
  errorCode: 0,
  slug: 'ok'
})

const permissionsFor = user =>
  typeof user === 'object' && user !== null && Array.isArray(user.permissions)
    ? user.permissions.filter(permission => typeof permission === 'string')
    : []

const hasAnyPermission = (user, required) => {
  const permissions = permissionsFor(user)
  return Array.isArray(required) && required.some(permission => permissions.includes(permission))
}

const pageTagNames = context =>
  Array.isArray(context?.tags)
    ? context.tags.map(tag => typeof tag === 'string' ? tag : tag?.tag).filter(tag => typeof tag === 'string')
    : null

const authorityFor = requester => ({
  requester,
  permissions: permissionsFor(requester),
  groups: [],
  tagAliases: {}
})

const checkPageAccess = (user, required, context, authority) => {
  if (!authority || authority.requester !== user) return false
  const permissions = Array.isArray(authority.permissions) ? authority.permissions : []
  if (permissions.includes('manage:system')) return true
  if (!Array.isArray(required) || !required.some(permission => permissions.includes(permission))) return false
  const tags = pageTagNames(context)
  if (tags === null) return false
  return !tags.includes('internal') || permissions.includes('read:internal')
}

const graphPageListTypeDefs = `
  directive @auth(requires: [String]) on FIELD_DEFINITION | OBJECT | QUERY

  type Query {
    pages: PageQuery
    contactPage: Page
  }

  type PageQuery {
    list(
      limit: Int
      orderBy: PageOrderBy
      orderByDirection: PageOrderByDirection
      tags: [String!]
      locale: String
      creatorId: Int
      authorId: Int
    ): [PageListItem!]! @auth(requires: ["manage:system", "read:pages"])
  }

  type PageListItem {
    id: Int!
    path: String!
    locale: String!
    title: String
    description: String
    contentType: String!
    isPublished: Boolean! @auth(requires: ["write:pages", "manage:system"])
    visibility: PageVisibility!
    ownerId: Int
    tags: [String]
  }

  type Page {
    path: String!
    localeCode: String
    visibility: PageVisibility!
    ownerId: Int
    tags: [String]
    authorEmail: String
    creatorEmail: String
  }

  enum PageVisibility {
    public
    private
  }

  enum PageOrderBy {
    CREATED
    ID
    PATH
    TITLE
    UPDATED
  }

  enum PageOrderByDirection {
    ASC
    DESC
  }
`

let adapters
let graphPageSchema
let previousWiki

beforeAll(async () => {
  previousWiki = global.WIKI
  global.WIKI = {
    auth: {
      checkAccess: vi.fn((user, required) => hasAnyPermission(user, required)),
      checkPageAccess: vi.fn(checkPageAccess),
      loadPageRuleAuthority: vi.fn(async requester => authorityFor(requester))
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

  graphPageSchema = authDirectiveTransformer(makeExecutableSchema({
    typeDefs: graphPageListTypeDefs,
    resolvers: {
      Query: {
        pages: adapters.pages.resolver.Query.pages,
        contactPage: (_obj, _args, context) => context.page
      },
      PageQuery: { list: adapters.pages.resolver.PageQuery.list },
      Page: adapters.pages.resolver.Page
    }
  }))
})

afterAll(() => {
  global.WIKI = previousWiki
})

beforeEach(() => {
  global.WIKI.auth.checkAccess.mockReset().mockImplementation((user, required) => hasAnyPermission(user, required))
  global.WIKI.auth.checkPageAccess.mockReset().mockImplementation(checkPageAccess)
  global.WIKI.auth.loadPageRuleAuthority.mockReset().mockImplementation(async requester => authorityFor(requester))
  for (const operations of Object.values(operationMocks)) {
    for (const operation of Object.values(operations)) operation.mockReset()
  }
})


describe('REST and GraphQL shared operation parity', () => {
  describe('users', () => {
    it('normalizes search queries and preserves observable result and error transport', async () => {
      const users = [
        { id: 7, name: 'Alice', email: 'alice@example.com', providerKey: 'local', internal: 'not-rest-visible' },
        { id: 8, name: 'Bob', email: 'bob@example.com', providerKey: 'local' }
      ]
      operationMocks.users.search.mockImplementation(query =>
        Promise.resolve(users.filter(user => user.name.toLowerCase().includes(String(query).toLowerCase())))
      )
      const requester = { id: 1, permissions: ['manage:users'] }
      const restResponse = makeResponse()
      const restNext = vi.fn()

      await adapters.users.router.handler('get', '/search')(
        { user: requester, query: { query: '  alice  ' } },
        restResponse,
        restNext
      )
      const graphResult = await adapters.users.resolver.UserQuery.search(null, { query: 'alice' })

      expect(restResponse.json).toHaveBeenCalledWith([
        { id: 7, name: 'Alice', email: 'alice@example.com', providerKey: 'local' }
      ])
      expect(restNext).not.toHaveBeenCalled()
      expect(graphResult.map(user => user.id)).toEqual([7])

      operationMocks.users.search.mockReset().mockRejectedValue(
        operationError('search unavailable', { status: 503, code: 71, name: 'Unavailable' })
      )
      const failedRestResponse = makeResponse()
      const failedRestNext = vi.fn()

      await adapters.users.router.handler('get', '/search')(
        { user: requester, query: { query: ' alice ' } },
        failedRestResponse,
        failedRestNext
      )
      await expect(Promise.resolve(adapters.users.resolver.UserQuery.search(null, { query: 'alice' }))).rejects.toMatchObject({
        status: 503,
        code: 71,
        name: 'Unavailable'
      })

      expect(failedRestNext).toHaveBeenCalledOnce()
      expect(failedRestNext.mock.calls[0][0]).toMatchObject({ status: 503, code: 71, name: 'Unavailable' })
      expect(failedRestResponse.json).not.toHaveBeenCalled()
    })

  })

  describe('groups', () => {
    it('preserves observable group data and query error transport across REST and GraphQL', async () => {
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

      expect(restResponse.json).toHaveBeenCalledWith({ ...group, users: [] })
      expect(restNext).not.toHaveBeenCalled()
      expect(graphResult).toMatchObject({ id: 9, name: 'Editors' })

      operationMocks.groups.get.mockReset().mockRejectedValue(
        operationError('group lookup failed', { status: 503, code: 81, name: 'Unavailable' })
      )
      const failedRestResponse = makeResponse()
      const failedRestNext = vi.fn()

      await adapters.groups.router.handler('get', '/:id')(
        { user: requester, params: { id: '9' } },
        failedRestResponse,
        failedRestNext
      )
      await expect(Promise.resolve(adapters.groups.resolver.GroupQuery.single(null, { id: 9 }))).rejects.toMatchObject({
        status: 503,
        code: 81,
        name: 'Unavailable'
      })

      expect(failedRestNext).toHaveBeenCalledOnce()
      expect(failedRestNext.mock.calls[0][0]).toMatchObject({ status: 503, code: 81, name: 'Unavailable' })
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
      const graphResult = await adapters.groups.resolver.GroupMutation.create(null, { name: 'Editors' }, { req: { user: requester } })

      expect(restResponse.json).toHaveBeenCalledWith({
        succeeded: true,
        message: expect.any(String),
        group: { id: 9, name: 'Editors', isSystem: false }
      })
      expect(graphResult).toMatchObject({
        responseResult: graphSuccess(),
        group: { id: 9, name: 'Editors', isSystem: false }
      })

      operationMocks.groups.create.mockReset().mockRejectedValue(
        operationError('group already exists', { status: 409, code: 82, name: 'Conflict' })
      )
      const failedRestResponse = makeResponse()

      await adapters.groups.router.handler('post', '/')(
        { user: requester, body: { name: ' Editors ' } },
        failedRestResponse,
        vi.fn()
      )
      await expect(Promise.resolve(adapters.groups.resolver.GroupMutation.create(null, { name: 'Editors' }, { req: { user: requester } }))).rejects.toMatchObject({
        status: 409,
        code: 82,
        name: 'Conflict'
      })

      expect(failedRestResponse.status).toHaveBeenCalledWith(409)
      expect(failedRestResponse.json).toHaveBeenCalledWith({ error: expect.any(String) })
    })
  })

  describe('pages', () => {
    it('returns the same authorized page identities and ordering through REST and transformed GraphQL', async () => {
      const pages = [
        {
          id: 22,
          path: 'docs/omega',
          locale: 'en',
          title: 'Omega',
          description: 'The last guide',
          isPublished: true,
          visibility: 'public',
          ownerId: null,
          contentType: 'markdown',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-04T00:00:00.000Z',
          tags: ['docs', 'api']
        },
        {
          id: 21,
          path: 'docs/alpha',
          locale: 'en',
          title: 'Alpha',
          description: 'The first guide',
          isPublished: false,
          visibility: 'public',
          ownerId: null,
          contentType: 'markdown',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
          tags: ['docs', 'api']
        },
        {
          id: 23,
          path: 'docs/other',
          locale: 'en',
          title: 'Other',
          description: 'A different category',
          isPublished: true,
          visibility: 'public',
          ownerId: null,
          contentType: 'markdown',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-01-05T00:00:00.000Z',
          tags: ['other']
        },
        {
          id: 24,
          path: 'docs/francais',
          locale: 'fr',
          title: 'Francais',
          description: 'A translated guide',
          isPublished: true,
          visibility: 'public',
          ownerId: null,
          contentType: 'markdown',
          createdAt: '2026-01-04T00:00:00.000Z',
          updatedAt: '2026-01-06T00:00:00.000Z',
          tags: ['docs', 'api']
        },
        {
          id: 25,
          path: 'docs/private',
          locale: 'en',
          title: 'Private',
          description: 'A private guide',
          isPublished: true,
          visibility: 'private',
          ownerId: 99,
          contentType: 'markdown',
          createdAt: '2026-01-05T00:00:00.000Z',
          updatedAt: '2026-01-07T00:00:00.000Z',
          tags: ['docs', 'api']
        },
        {
          id: 26,
          path: 'docs/internal',
          locale: 'en',
          title: 'Internal',
          description: 'An internally scoped guide',
          isPublished: true,
          visibility: 'public',
          ownerId: null,
          contentType: 'markdown',
          createdAt: '2026-01-06T00:00:00.000Z',
          updatedAt: '2026-01-08T00:00:00.000Z',
          tags: ['docs', 'api', 'internal']
        }
      ]
      operationMocks.pages.list.mockImplementation(async input => {
        const authority = input.authority ?? await global.WIKI.auth.loadPageRuleAuthority(input.requester)
        const requestedTags = Array.isArray(input.tags) ? input.tags.map(tag => String(tag).trim().toLowerCase()) : []
        const authorized = pages.filter(page => {
          if (input.locale !== undefined && page.locale !== input.locale) return false
          if (requestedTags.some(tag => !page.tags.includes(tag))) return false
          if (page.visibility === 'private') {
            return page.ownerId === input.requester?.id || permissionsFor(input.requester).includes('manage:system')
          }
          return global.WIKI.auth.checkPageAccess(
            input.requester,
            ['read:pages'],
            {
              path: page.path,
              locale: page.locale,
              localeCode: page.locale,
              visibility: page.visibility,
              ownerId: page.ownerId,
              tags: page.tags.map(tag => ({ tag }))
            },
            authority
          )
        })
        const direction = String(input.orderByDirection ?? '').toUpperCase() === 'DESC' ? -1 : 1
        const orderBy = String(input.orderBy ?? '').toUpperCase()
        const field = orderBy === 'TITLE' ? 'title' : orderBy === 'PATH' ? 'path' : 'id'
        const ordered = [...authorized].sort((left, right) => {
          const leftValue = left[field]
          const rightValue = right[field]
          if (leftValue === rightValue) return left.id - right.id
          return (leftValue < rightValue ? -1 : 1) * direction
        })
        return Number.isSafeInteger(input.limit) && input.limit > 0 ? ordered.slice(0, input.limit) : ordered
      })

      const reader = { id: 7, permissions: ['read:pages'] }
      const restResponse = makeResponse()
      const restNext = vi.fn()
      const query = {
        tags: ' Docs, API ',
        limit: '2',
        locale: 'en',
        orderBy: 'TITLE',
        orderByDirection: 'DESC'
      }

      await adapters.pages.router.handler('get', '/')(
        { user: reader, query },
        restResponse,
        restNext
      )
      const restPages = restResponse.json.mock.calls[0][0]
      const graphPublic = await graphql({
        schema: graphPageSchema,
        source: '{ pages { list(tags: ["docs", "api"], limit: 2, locale: "en", orderBy: TITLE, orderByDirection: DESC) { id path locale title tags } } }',
        contextValue: { req: { user: reader } }
      })

      expect(restNext).not.toHaveBeenCalled()
      expect(restPages.map(page => page.id)).toEqual([22, 21])
      expect(restPages.map(page => page.title)).toEqual(['Omega', 'Alpha'])
      expect(restPages.every(page => !Object.hasOwn(page, 'isPublished'))).toBe(true)
      expect(graphPublic.errors).toBeUndefined()
      expect(graphPublic.data.pages.list.map(page => page.id)).toEqual([22, 21])
      expect(graphPublic.data.pages.list.map(page => page.title)).toEqual(['Omega', 'Alpha'])

      const graphReaderRestricted = await graphql({
        schema: graphPageSchema,
        source: '{ pages { list(tags: ["docs", "api"], limit: 2, locale: "en", orderBy: TITLE, orderByDirection: DESC) { id isPublished } } }',
        contextValue: { req: { user: reader } }
      })
      expect(graphReaderRestricted.data).toEqual({ pages: null })
      expect(graphReaderRestricted.errors).toHaveLength(1)
      expect(graphReaderRestricted.errors[0].path).toEqual(['pages', 'list', 0, 'isPublished'])

      const writer = { id: 8, permissions: ['read:pages', 'write:pages'] }
      const graphWriter = await graphql({
        schema: graphPageSchema,
        source: '{ pages { list(tags: ["docs", "api"], limit: 2, locale: "en", orderBy: TITLE, orderByDirection: DESC) { id isPublished } } }',
        contextValue: { req: { user: writer } }
      })
      const writerRestResponse = makeResponse()
      await adapters.pages.router.handler('get', '/')(
        { user: writer, query },
        writerRestResponse,
        vi.fn()
      )

      expect(graphWriter.errors).toBeUndefined()
      expect(graphWriter.data.pages.list.map(page => page.id)).toEqual([22, 21])
      expect(graphWriter.data.pages.list.map(page => page.isPublished)).toEqual([true, false])
      expect(writerRestResponse.json.mock.calls[0][0].map(page => page.id)).toEqual([22, 21])
      expect(writerRestResponse.json.mock.calls[0][0].map(page => page.isPublished)).toEqual([true, false])
    })

    it('fails closed for malformed page authorization context in both transports', async () => {
      const malformedPage = {
        id: 31,
        path: 'docs/malformed',
        locale: 'en',
        title: 'Malformed',
        description: 'Incomplete tags',
        isPublished: true,
        visibility: 'public',
        ownerId: null,
        contentType: 'markdown',
        createdAt: '2026-01-09T00:00:00.000Z',
        updatedAt: '2026-01-10T00:00:00.000Z',
        tags: ['']
      }
      operationMocks.pages.list.mockResolvedValue([malformedPage])
      const reader = { id: 7, permissions: ['read:pages'] }
      const restResponse = makeResponse()

      await adapters.pages.router.handler('get', '/')(
        { user: reader, query: {} },
        restResponse,
        vi.fn()
      )
      const graphResult = await graphql({
        schema: graphPageSchema,
        source: '{ pages { list { id isPublished } } }',
        contextValue: { req: { user: reader } }
      })

      expect(restResponse.json.mock.calls[0][0]).toHaveLength(1)
      expect(restResponse.json.mock.calls[0][0][0].id).toBe(31)
      expect(restResponse.json.mock.calls[0][0][0]).not.toHaveProperty('isPublished')
      expect(graphResult.data).toEqual({ pages: null })
      expect(graphResult.errors).toHaveLength(1)
      expect(graphResult.errors[0].path).toEqual(['pages', 'list', 0, 'isPublished'])
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

      expect(restResponse.status).toHaveBeenCalledWith(201)
      expect(restResponse.json).toHaveBeenCalledWith({
        page: expect.objectContaining({
          id: 12,
          path: 'guide',
          capabilities: { viewStewardContacts: false }
        })
      })
      expect(graphResult).toMatchObject({
        responseResult: graphSuccess(),
        page: { id: 12, path: 'guide' }
      })

      operationMocks.pages.create.mockReset().mockRejectedValue(
        operationError('invalid page', { status: 422, code: 92, name: 'ValidationError' })
      )
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

      expect(failedRestResponse.status).toHaveBeenCalledWith(422)
      expect(failedRestResponse.json).toHaveBeenCalledWith({ error: expect.any(String) })
      expect(failedGraphResult).toMatchObject({
        responseResult: {
          succeeded: false,
          errorCode: 92,
          slug: 'ValidationError'
        }
      })
    })

    it('preserves stale deletion conflicts and transport status envelopes', async () => {
      const requester = { id: 1, permissions: ['delete:pages'] }
      const expectedSourceRevision = '17'
      const restResponse = makeResponse()
      operationMocks.pages.remove.mockResolvedValue(undefined)

      await adapters.pages.router.handler('delete', '/:id')(
        { user: requester, sessionID: 'session-1', params: { id: '12' }, body: { expectedSourceRevision } },
        restResponse
      )
      const graphResult = await adapters.pages.resolver.PageMutation.delete(
        null,
        { id: 12, expectedSourceRevision },
        { req: { user: requester, sessionID: 'session-1' } }
      )

      expect(restResponse.json).toHaveBeenCalledWith({ message: expect.any(String) })
      expect(graphResult).toMatchObject({ responseResult: graphSuccess() })

      operationMocks.pages.remove.mockReset().mockRejectedValue(
        operationError('The page changed before deletion.', {
          status: 409,
          code: 409,
          name: 'PageUpdateConflict'
        })
      )
      const staleGraphResult = await adapters.pages.resolver.PageMutation.delete(
        null,
        { id: 12, expectedSourceRevision },
        { req: { user: requester, sessionID: 'session-1' } }
      )

      expect(staleGraphResult).toMatchObject({
        responseResult: {
          succeeded: false,
          errorCode: 409,
          slug: 'PageUpdateConflict'
        }
      })
    })
    it('redacts steward contacts with the effective page writer predicate', async () => {
      const page = {
        path: 'guide',
        localeCode: 'en',
        visibility: 'public',
        ownerId: null,
        tags: [],
        authorEmail: 'author@example.com',
        creatorEmail: 'creator@example.com'
      }
      const writer = { id: 1, permissions: ['read:pages', 'write:pages'] }
      const reader = { id: 2, permissions: ['read:pages'] }
      const systemManager = { id: 99, permissions: ['manage:system'] }
      const authorities = new Map([
        [writer, authorityFor(writer)],
        [reader, authorityFor(reader)],
        [systemManager, authorityFor(systemManager)]
      ])
      global.WIKI.auth.loadPageRuleAuthority.mockImplementation(async requester => {
        const authority = authorities.get(requester)
        if (!authority) throw new Error('Unexpected page-rule requester')
        return authority
      })
      const execute = (requester, source, fields) => graphql({
        schema: graphPageSchema,
        source: `{ contactPage { ${fields} } }`,
        contextValue: { req: { user: requester }, page: source }
      })

      const graphWriter = await execute(writer, page, 'authorEmail creatorEmail')
      const graphSystemManager = await execute(systemManager, page, 'authorEmail')
      const graphReader = await execute(reader, page, 'authorEmail')
      const graphMalformed = await execute(writer, { ...page, tags: undefined }, 'authorEmail')

      expect(graphWriter.errors).toBeUndefined()
      expect(graphWriter.data).toEqual({
        contactPage: {
          authorEmail: 'author@example.com',
          creatorEmail: 'creator@example.com'
        }
      })
      expect(graphSystemManager.errors).toBeUndefined()
      expect(graphSystemManager.data).toEqual({
        contactPage: { authorEmail: 'author@example.com' }
      })
      expect(graphReader.data?.contactPage?.authorEmail ?? null).toBeNull()
      expect(graphReader.errors).toHaveLength(1)
      expect(graphReader.errors[0].path).toEqual(['contactPage', 'authorEmail'])
      expect(graphMalformed.data?.contactPage?.authorEmail ?? null).toBeNull()
      expect(graphMalformed.errors).toHaveLength(1)
      expect(graphMalformed.errors[0].path).toEqual(['contactPage', 'authorEmail'])
      expect(global.WIKI.auth.loadPageRuleAuthority.mock.calls.some(([requester]) => requester === writer)).toBe(true)
      expect(global.WIKI.auth.loadPageRuleAuthority.mock.calls.some(([requester]) => requester === reader)).toBe(true)
      expect(global.WIKI.auth.loadPageRuleAuthority.mock.calls.some(([requester]) => requester === systemManager)).toBe(true)
      expect(global.WIKI.auth.checkPageAccess.mock.calls
        .filter(([requester]) => requester === writer)
        .every(([, , , authority]) => authority?.requester === writer)
      ).toBe(true)
      expect(global.WIKI.auth.checkPageAccess.mock.calls
        .filter(([requester]) => requester === systemManager)
        .every(([, , , authority]) => authority?.requester === systemManager)
      ).toBe(true)
    })
  })

  describe('comments', () => {
    it('normalizes list queries and preserves observable result and error transport', async () => {
      const comments = [
        { id: 31, pageId: 17, content: 'Useful guide' },
        { id: 32, pageId: 18, content: 'Other guide' }
      ]
      operationMocks.comments.list.mockImplementation(async ({ pageId }) =>
        comments.filter(comment => comment.pageId === pageId)
      )
      const requester = { id: 2, permissions: ['read:comments'] }
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

      expect(restResponse.json).toHaveBeenCalledWith([{ id: 31, pageId: 17, content: 'Useful guide' }])
      expect(restNext).not.toHaveBeenCalled()
      expect(graphResult.map(comment => comment.id)).toEqual([31])

      operationMocks.comments.list.mockReset().mockRejectedValue(
        operationError('comment list unavailable', { status: 503, code: 101, name: 'Unavailable' })
      )
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
      ))).rejects.toMatchObject({
        status: 503,
        code: 101,
        name: 'Unavailable'
      })

      expect(failedRestNext).toHaveBeenCalledOnce()
      expect(failedRestNext.mock.calls[0][0]).toMatchObject({ status: 503, code: 101, name: 'Unavailable' })
      expect(failedRestResponse.json).not.toHaveBeenCalled()
    })

    it('maps create mutation success and failure status envelopes per transport', async () => {
      const input = { locale: 'en', path: 'guide', content: 'Useful guide' }
      operationMocks.comments.create.mockResolvedValue(31)
      const requester = { id: 2, permissions: ['write:comments'] }
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

      expect(restResponse.status).toHaveBeenCalledWith(201)
      expect(restResponse.json).toHaveBeenCalledWith({ id: 31 })
      expect(graphResult).toMatchObject({ responseResult: graphSuccess(), id: 31 })

      operationMocks.comments.create.mockReset().mockRejectedValue(
        operationError('comment rejected', { status: 429, code: 102, name: 'RateLimited' })
      )
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

      expect(failedRestResponse.status).toHaveBeenCalledWith(429)
      expect(failedRestResponse.json).toHaveBeenCalledWith({ error: expect.any(String) })
      expect(failedGraphResult).toMatchObject({
        responseResult: {
          succeeded: false,
          errorCode: 102,
          slug: 'RateLimited'
        }
      })
    })
  })
})
