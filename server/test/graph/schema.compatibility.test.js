const path = require('path')
const { validateSchema } = require('graphql')
const { makeExecutableSchema } = require('graphql-tools')

describe('GraphQL external compatibility', () => {
  let previousWiki

  beforeEach(() => {
    jest.resetModules()
    previousWiki = global.WIKI
    global.WIKI = {
      SERVERPATH: path.resolve(__dirname, '../..'),
      logger: {
        add: jest.fn(),
        info: jest.fn()
      },
      version: 'test'
    }
  })

  afterEach(() => {
    global.WIKI = previousWiki
  })

  it('builds the production schema with every public root operation', () => {
    const schema = makeExecutableSchema(require('../../graph'))

    expect(validateSchema(schema)).toEqual([])
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
