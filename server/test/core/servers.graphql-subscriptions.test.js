describe('core/servers GraphQL subscription handshake', () => {
  const apolloServerFactory = () => {
    const instances = []
    const ApolloServer = jest.fn().mockImplementation(function ApolloServer(options) {
      this.options = options
      this.applyMiddleware = jest.fn()
      instances.push(this)
    })

    return { ApolloServer, instances }
  }

  const setupModule = () => {
    jest.resetModules()

    const { ApolloServer, instances } = apolloServerFactory()
    const verify = jest.fn()

    jest.doMock('apollo-server-express', () => ({ ApolloServer }))
    jest.doMock('jsonwebtoken', () => ({ verify }))
    jest.doMock('../../graph', () => ({
      typeDefs: ['type Query { ok: Boolean }'],
      resolvers: {},
      schemaDirectives: {}
    }))

    global.WIKI = {
      app: {},
      config: {
        certs: {
          public: 'PUBLIC-KEY'
        },
        auth: {
          audience: 'urn:test-audience'
        }
      }
    }

    const servers = require('../../core/servers')

    return { servers, verify, ApolloServer, instances }
  }

  it('registers the subscription path and applies GraphQL middleware', async () => {
    const { servers, ApolloServer, instances } = setupModule()

    await servers.startGraphQL()

    expect(ApolloServer).toHaveBeenCalledTimes(1)
    expect(instances[0].options.subscriptions.path).toBe('/graphql-subscriptions')
    expect(instances[0].applyMiddleware).toHaveBeenCalledWith({ app: global.WIKI.app, cors: false })
  })

  it('accepts a valid token from connectionParams for manage:system users', async () => {
    const { servers, verify, instances } = setupModule()
    verify.mockReturnValue({ id: 7, permissions: ['manage:system'] })

    await servers.startGraphQL()

    expect(instances[0].options.subscriptions.onConnect({ token: 'direct-token' }, {})).toEqual({
      user: { id: 7, permissions: ['manage:system'] }
    })
    expect(verify).toHaveBeenCalledWith('direct-token', 'PUBLIC-KEY', {
      audience: 'urn:test-audience',
      issuer: 'urn:wiki.js',
      algorithms: ['RS256']
    })
  })

  it('falls back to the jwt cookie when no connection param token is provided', async () => {
    const { servers, verify, instances } = setupModule()
    verify.mockReturnValue({ id: 9, permissions: ['manage:system'] })

    await servers.startGraphQL()

    expect(instances[0].options.subscriptions.onConnect({}, {
      upgradeReq: {
        headers: {
          cookie: 'foo=bar; jwt=cookie-token'
        }
      }
    })).toEqual({
      user: { id: 9, permissions: ['manage:system'] }
    })
    expect(verify).toHaveBeenCalledWith('cookie-token', 'PUBLIC-KEY', expect.any(Object))
  })

  it('rejects invalid JWT verification as Unauthorized', async () => {
    const { servers, verify, instances } = setupModule()
    verify.mockImplementation(() => {
      throw new Error('invalid token')
    })

    await servers.startGraphQL()

    expect(() => instances[0].options.subscriptions.onConnect({ token: 'invalid-token' }, {})).toThrow('Unauthorized')
  })

  it('rejects missing or underprivileged subscription auth as Unauthorized', async () => {
    const { servers, verify, instances } = setupModule()

    await servers.startGraphQL()

    expect(() => instances[0].options.subscriptions.onConnect({}, {})).toThrow('Unauthorized')

    verify.mockReturnValueOnce({ id: 8, permissions: ['read:pages'] })
    expect(() => instances[0].options.subscriptions.onConnect({ token: 'underprivileged-token' }, {})).toThrow('Unauthorized')
  })
})
