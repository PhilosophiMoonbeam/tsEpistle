describe('core/servers GraphQL transports', () => {
  let previousWiki

  beforeEach(() => {
    previousWiki = global.WIKI
  })

  afterEach(() => {
    global.WIKI = previousWiki
    vi.doUnmock('graphql-yoga')
    vi.doUnmock('graphql-ws/use/ws')
    vi.doUnmock('ws')
    vi.doUnmock('jsonwebtoken')
    vi.doUnmock('../../graph/index.ts')
    vi.restoreAllMocks()
  })

  const setupModule = async () => {
    vi.resetModules()

    const yoga = Object.assign(vi.fn(), {
      graphqlEndpoint: '/graphql',
      getEnveloped: vi.fn()
    })
    const createYoga = vi.fn().mockReturnValue(yoga)
    const wsServer = {
      close: vi.fn(callback => callback())
    }
    const cleanup = {
      dispose: vi.fn(() => new Promise((resolve, reject) => {
        wsServer.close(error => error ? reject(error) : resolve())
      }))
    }
    const useServer = vi.fn().mockReturnValue(cleanup)
    const WebSocketServer = vi.fn(function () {
      return wsServer
    })
    const verify = vi.fn()

    vi.doMock('graphql-yoga', () => ({ createYoga }))
    vi.doMock('graphql-ws/use/ws', () => ({ useServer }))
    vi.doMock('ws', () => ({
      default: { Server: WebSocketServer },
      WebSocketServer
    }))
    vi.doMock('jsonwebtoken', () => ({
      default: { verify }
    }))
    vi.doMock('../../graph/index.ts', () => ({
      schema: { kind: 'schema' }
    }))

    global.WIKI = {
      IS_DEBUG: false,
      app: {
        use: vi.fn()
      },
      config: {
        certs: {
          public: 'PUBLIC-KEY'
        },
        auth: {
          audience: 'urn:test-audience'
        }
      }
    }

    const { default: servers } = await import('../../core/servers.ts')
    return { servers, createYoga, yoga, useServer, cleanup, WebSocketServer, wsServer, verify }
  }

  it('mounts Yoga on the existing GraphQL endpoint', async () => {
    const { servers, createYoga, yoga } = await setupModule()

    await servers.startGraphQL()

    expect(createYoga).toHaveBeenCalledWith(expect.objectContaining({
      schema: { kind: 'schema' },
      graphqlEndpoint: '/graphql',
      maskedErrors: false,
      graphiql: false
    }))
    expect(global.WIKI.app.use).toHaveBeenCalledWith('/graphql', expect.any(Function))
    const request = { kind: 'request' }
    const response = { kind: 'response' }
    global.WIKI.app.use.mock.calls[0][1](request, response, vi.fn())
    expect(yoga).toHaveBeenCalledWith(request, response)
  })

  it('attaches graphql-ws to the maintained subscription endpoint', async () => {
    const { servers, useServer, WebSocketServer } = await setupModule()
    const httpServer = { kind: 'http-server' }

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(httpServer)

    expect(WebSocketServer).toHaveBeenCalledWith({
      server: httpServer,
      path: '/graphql-subscriptions'
    })
    expect(useServer).toHaveBeenCalledWith(expect.objectContaining({
      onConnect: expect.any(Function),
      onSubscribe: expect.any(Function)
    }), expect.any(Object))
  })

  it('accepts a valid connection token for manage:system users', async () => {
    const { servers, useServer, verify } = await setupModule()
    const user = { id: 7, permissions: ['manage:system'] }
    verify.mockReturnValue(user)

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions({})
    const protocol = useServer.mock.calls[0][0]
    const context = {
      connectionParams: { token: 'direct-token' },
      extra: { request: { headers: {} } }
    }
    protocol.onConnect(context)

    expect(context.extra.user).toBe(user)
    expect(verify).toHaveBeenCalledWith('direct-token', 'PUBLIC-KEY', {
      audience: 'urn:test-audience',
      issuer: 'urn:wiki.js',
      algorithms: ['RS256']
    })
  })

  it('falls back to the jwt cookie', async () => {
    const { servers, verify } = await setupModule()
    const user = { id: 9, permissions: ['manage:system'] }
    verify.mockReturnValue(user)

    expect(servers.authenticateGraphQLSubscription({}, {
      headers: { cookie: 'foo=bar; jwt=cookie-token' }
    })).toBe(user)
    expect(verify).toHaveBeenCalledWith('cookie-token', 'PUBLIC-KEY', expect.any(Object))
  })

  it('rejects missing, invalid, and underprivileged credentials', async () => {
    const { servers, verify } = await setupModule()
    const request = { headers: {} }

    expect(() => servers.authenticateGraphQLSubscription({}, request)).toThrow('Unauthorized')
    verify.mockImplementationOnce(() => {
      throw new Error('invalid token')
    })
    expect(() => servers.authenticateGraphQLSubscription({ token: 'invalid-token' }, request)).toThrow('Unauthorized')
    verify.mockReturnValueOnce({ id: 8, permissions: ['read:pages'] })
    expect(() => servers.authenticateGraphQLSubscription({ token: 'underprivileged-token' }, request)).toThrow('Unauthorized')
  })

  it('disposes the graphql-ws handler and WebSocket server', async () => {
    const { servers, cleanup, wsServer } = await setupModule()
    const httpServer = { kind: 'http-server' }

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(httpServer)
    await servers.disposeGraphQLSubscriptions(httpServer)

    expect(cleanup.dispose).toHaveBeenCalledTimes(1)
    expect(wsServer.close).toHaveBeenCalledTimes(1)
    expect(servers.servers.graph.subscriptions).toEqual([])
  })
})
