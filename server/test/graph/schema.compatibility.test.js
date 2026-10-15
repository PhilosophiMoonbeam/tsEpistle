import path from 'node:path'

import { graphql } from 'graphql/index.js'

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
  })

  afterEach(() => {
    global.WIKI = previousWiki
  })

  it('denies page history without current history authority through the production schema', async () => {
    const { createGraphQLArtifacts } = await import('../../graph/index.ts')
    const { schema } = await createGraphQLArtifacts(global.WIKI)
    const deniedHistory = await graphql({
      schema,
      source: '{ pages { history(id: 42) { total } } }',
      contextValue: { req: { user: { id: 9, permissions: ['read:pages'] } } }
    })
    expect(deniedHistory.data).toEqual({ pages: { history: null } })
    expect(deniedHistory.errors).toHaveLength(1)
    expect(deniedHistory.errors[0].path).toEqual(['pages', 'history'])
  })
})
