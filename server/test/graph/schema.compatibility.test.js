import path from 'node:path'

import { lexicographicSortSchema, printSchema, printType, validateSchema } from 'graphql/index.js'

describe('GraphQL external compatibility', () => {
  let previousWiki

  beforeEach(() => {
    previousWiki = global.WIKI
    global.WIKI = {
      SERVERPATH: path.resolve(process.cwd(), 'server'),
      ROOTPATH: process.cwd(),
      Error: {},
      app: {},
      auth: { strategies: {} },
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
})
