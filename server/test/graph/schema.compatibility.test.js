import path from 'node:path'

import { lexicographicSortSchema, printSchema, printType, validateSchema, graphql } from 'graphql/index.js'
const pageOperationMocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  getVersion: vi.fn(),
  getHistory: vi.fn(),
  restore: vi.fn()
}))

vi.mockModule('../../operations/pages.ts', import.meta.url, () => ({ default: pageOperationMocks }))

const permissionsOf = user =>
  typeof user === 'object' && user !== null && Array.isArray(user.permissions)
    ? user.permissions.filter(permission => typeof permission === 'string')
    : []

const allowsAny = (user, required) => permissionsOf(user).some(permission => Array.isArray(required) && required.includes(permission))

describe('GraphQL external compatibility', () => {
  let previousWiki

  beforeEach(() => {
    previousWiki = global.WIKI
    global.WIKI = {
      SERVERPATH: path.resolve(process.cwd(), 'server'),
      ROOTPATH: process.cwd(),
      Error: {},
      app: {},
      auth: {
        strategies: {},
        checkAccess: (user, required) => allowsAny(user, required),
        checkPageAccess: (user, required, _page, authority) => authority?.requester === user && allowsAny(user, required),
        loadPageRuleAuthority: async requester => ({
          requester,
          permissions: permissionsOf(requester),
          groups: [],
          tagAliases: {}
        })
      },
      cache: {},
      config: {
        api: {},
        flags: { ldapdebug: false },
        lang: {},
        mail: {},
        metrics: {},
        nav: {},
        theming: {}
      },
      configSvc: {},
      data: {
        analytics: [],
        authentication: [],
        loggers: [],
        renderers: [],
        searchEngines: [],
        storage: []
      },
      events: { outbound: {} },
      lang: {},
      logger: {
        add: vi.fn(),
        info: vi.fn(),
        warn: vi.fn()
      },
      mail: {},
      metrics: {},
      models: {
        analytics: {},
        apiKeys: {},
        authentication: {},
        locales: {},
        loggers: {},
        navigation: {},
        pages: {},
        renderers: {},
        searchEngines: {},
        storage: {},
        users: {}
      },
      scheduler: {},
      version: 'test'
    }
    for (const operation of Object.values(pageOperationMocks)) operation.mockReset()
  })

  afterEach(() => {
    global.WIKI = previousWiki
  })

  it('builds the production schema with every public root operation', async () => {
    const { createGraphQLArtifacts } = await import('../../graph/index.ts')
    const { schema } = await createGraphQLArtifacts(global.WIKI)

    expect(validateSchema(schema)).toEqual([])

    const sortedSchema = lexicographicSortSchema(schema)
    expect(printSchema(sortedSchema)).toMatchSnapshot('public schema SDL')
    expect([
      sortedSchema.getQueryType(),
      sortedSchema.getMutationType(),
      sortedSchema.getSubscriptionType()
    ].map(rootType => printType(rootType)).join('\n\n')).toMatchSnapshot('root operation contract')
    expect(Object.keys(schema.getQueryType().getFields()).sort()).toEqual([
      'analytics',
      'assets',
      'authentication',
      'comments',
      'contribute',
      'groups',
      'localization',
      'logging',
      'pages',
      'rendering',
      'search',
      'site',
      'system',
      'theming',
      'users'
    ])
    expect(Object.keys(schema.getMutationType().getFields()).sort()).toEqual([
      'analytics',
      'assets',
      'authentication',
      'comments',
      'groups',
      'logging',
      'pages',
      'rendering',
      'search',
      'system',
      'theming',
      'users'
    ])
    expect(Object.keys(schema.getSubscriptionType().getFields())).toEqual(['loggingLiveTrail'])
  })
  it('executes the searchable page contract through the production schema', async () => {
    const { createGraphQLArtifacts } = await import('../../graph/index.ts')
    const { schema } = await createGraphQLArtifacts(global.WIKI)
    const requester = { id: 7, permissions: ['read:pages', 'write:pages', 'read:history'] }
    const reader = { id: 8, permissions: ['read:pages', 'read:history'] }
    const execute = (source, user = requester) => graphql({
      schema,
      source,
      contextValue: { req: { user } }
    })

    pageOperationMocks.create.mockImplementation(async ({ input }) => ({
      id: 42,
      isSearchable: input.isSearchable === undefined ? true : input.isSearchable
    }))
    const created = await execute(`mutation {
      pages {
        create(
          content: "# Guide"
          description: "A guide"
          editor: "markdown"
          isPublished: true
          isSearchable: false
          visibility: public
          locale: "en"
          path: "guide"
          tags: []
          title: "Guide"
        ) {
          responseResult { succeeded errorCode slug }
          page { id isSearchable }
        }
      }
    }`)
    expect(created.errors).toBeUndefined()
    expect(created.data).toEqual({
      pages: {
        create: {
          responseResult: { succeeded: true, errorCode: 0, slug: 'ok' },
          page: { id: 42, isSearchable: false }
        }
      }
    })
    expect(pageOperationMocks.create).toHaveBeenCalledWith({
      requester,
      input: expect.objectContaining({ isSearchable: false })
    })

    const omittedCreate = await execute(`mutation {
      pages {
        create(
          content: "# Guide"
          description: "A guide"
          editor: "markdown"
          isPublished: true
          visibility: public
          locale: "en"
          path: "guide-copy"
          tags: []
          title: "Guide copy"
        ) {
          page { id isSearchable }
        }
      }
    }`)
    expect(omittedCreate.errors).toBeUndefined()
    expect(omittedCreate.data?.pages?.create?.page).toEqual({ id: 42, isSearchable: true })
    expect(Object.hasOwn(pageOperationMocks.create.mock.calls.at(-1)?.[0].input, 'isSearchable')).toBe(false)

    pageOperationMocks.update.mockImplementation(async ({ input }) => ({
      id: input.id,
      isSearchable: Object.hasOwn(input, 'isSearchable') ? input.isSearchable : false
    }))
    const omittedUpdate = await execute(`mutation {
      pages {
        update(id: 42, expectedSourceRevision: "1", title: "Retitled") {
          page { id isSearchable }
        }
      }
    }`)
    expect(omittedUpdate.errors).toBeUndefined()
    expect(omittedUpdate.data?.pages?.update?.page).toEqual({ id: 42, isSearchable: false })
    expect(Object.hasOwn(pageOperationMocks.update.mock.calls.at(-1)?.[0].input, 'isSearchable')).toBe(false)

    const explicitTrueUpdate = await execute(`mutation {
      pages {
        update(id: 42, expectedSourceRevision: "1", isSearchable: true) {
          page { id isSearchable }
        }
      }
    }`)
    expect(explicitTrueUpdate.errors).toBeUndefined()
    expect(explicitTrueUpdate.data?.pages?.update?.page).toEqual({ id: 42, isSearchable: true })

    pageOperationMocks.update.mockReset().mockImplementation(async ({ input }) => {
      if (input.isSearchable === null) {
        const error = new Error('isSearchable must be a boolean')
        Object.assign(error, { status: 422, code: 400, name: 'ValidationError' })
        throw error
      }
      return { id: input.id, isSearchable: input.isSearchable }
    })
    const explicitNull = await execute(`mutation {
      pages {
        update(id: 42, expectedSourceRevision: "1", isSearchable: null) {
          responseResult { succeeded errorCode slug }
        }
      }
    }`)
    expect(explicitNull.errors).toBeUndefined()
    expect(explicitNull.data?.pages?.update?.responseResult).toMatchObject({
      succeeded: false,
      errorCode: 400,
      slug: 'ValidationError'
    })
    expect(pageOperationMocks.update).toHaveBeenCalledWith({
      requester,
      input: expect.objectContaining({ isSearchable: null })
    })

    pageOperationMocks.get.mockResolvedValue({ id: 42, path: 'guide', isSearchable: false })
    const current = await execute('{ pages { single(id: 42) { id path isSearchable } } }', reader)
    expect(current.errors).toBeUndefined()
    expect(current.data).toEqual({
      pages: { single: { id: 42, path: 'guide', isSearchable: false } }
    })

    pageOperationMocks.list.mockResolvedValue([
      { id: 42, path: 'guide', isSearchable: false, visibility: 'public' }
    ])
    const listed = await execute('{ pages { list { id path isSearchable } } }', reader)
    expect(listed.errors).toBeUndefined()
    expect(listed.data).toEqual({
      pages: { list: [{ id: 42, path: 'guide', isSearchable: false }] }
    })

    pageOperationMocks.getVersion.mockResolvedValue({ pageId: 42, versionId: 3, isSearchable: false })
    const version = await execute('{ pages { version(pageId: 42, versionId: 3) { pageId versionId isSearchable } } }', reader)
    expect(version.errors).toBeUndefined()
    expect(version.data).toEqual({
      pages: { version: { pageId: 42, versionId: 3, isSearchable: false } }
    })

    pageOperationMocks.getHistory.mockResolvedValue({
      trail: [{ versionId: 3, actionType: 'edit', isSearchable: false }],
      total: 1
    })
    const history = await execute('{ pages { history(id: 42) { total trail { versionId actionType isSearchable } } } }', reader)
    expect(history.errors).toBeUndefined()
    expect(history.data).toEqual({
      pages: {
        history: {
          total: 1,
          trail: [{ versionId: 3, actionType: 'edit', isSearchable: false }]
        }
      }
    })
    const deniedHistory = await execute('{ pages { history(id: 42) { total } } }', { id: 9, permissions: ['read:pages'] })
    expect(deniedHistory.data).toEqual({ pages: { history: null } })
    expect(deniedHistory.errors).toHaveLength(1)
    expect(deniedHistory.errors[0].path).toEqual(['pages', 'history'])

    pageOperationMocks.restore.mockResolvedValue(undefined)
    const restored = await execute(`mutation {
      pages {
        restore(pageId: 42, versionId: 3, expectedSourceRevision: "1") {
          responseResult { succeeded errorCode slug }
        }
      }
    }`)
    expect(restored.errors).toBeUndefined()
    expect(restored.data).toEqual({
      pages: { restore: { responseResult: { succeeded: true, errorCode: 0, slug: 'ok' } } }
    })
    expect(pageOperationMocks.restore).toHaveBeenCalledWith({
      requester,
      pageId: 42,
      versionId: 3,
      expectedSourceRevision: '1'
    })
  })
})
