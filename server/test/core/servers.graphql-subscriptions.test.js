import http from 'node:http'

describe('core/servers GraphQL transports', () => {
  let previousWiki

  beforeEach(() => {
    previousWiki = global.WIKI
  })

  afterEach(() => {
    global.WIKI = previousWiki
    vi.unmockModule('graphql-yoga', import.meta.url)
    vi.unmockModule('graphql-ws/use/ws', import.meta.url)
    vi.unmockModule('ws', import.meta.url)
    vi.unmockModule('../../graph/index.ts', import.meta.url)
    vi.restoreAllMocks()
  })

  const setupModule = async () => {
    vi.resetModules()

    const yoga = Object.assign(vi.fn(), {
      graphqlEndpoint: '/graphql',
      getEnveloped: vi.fn()
    })
    const createYoga = vi.fn().mockReturnValue(yoga)
    const maskError = vi.fn((_error, message) => new Error(message))
    const wsServer = {
      close: vi.fn(callback => callback()),
      emit: vi.fn(),
      handleUpgrade: vi.fn()
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

    vi.mockModule('graphql-yoga', import.meta.url, () => ({ createYoga, maskError }))
    vi.mockModule('graphql-ws/use/ws', import.meta.url, () => ({ useServer }))
    vi.mockModule('ws', import.meta.url, () => ({
      default: { Server: WebSocketServer },
      WebSocketServer
    }))
    const createGraphQLArtifacts = vi.fn().mockResolvedValue({ schema: { kind: 'schema' } })
    vi.mockModule('../../graph/index.ts', import.meta.url, () => ({ createGraphQLArtifacts }))

    const app = Object.assign(vi.fn((_request, response) => response.end()), {
      use: vi.fn()
    })
    const collaboration = {
      install: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined)
    }
    const logger = {
      error: vi.fn(),
      info: vi.fn()
    }
    const authenticateUserToken = vi.fn()
    const checkAccess = vi.fn(user => user?.permissions?.includes('manage:system') === true)
    global.WIKI = {
      auth: {
        authenticateUserToken,
        checkAccess
      },
      IS_DEBUG: false,
      app,
      collaboration,
      logger,
      config: {
        bindIP: '127.0.0.1',
        port: 0,
        certs: {
          public: 'PUBLIC-KEY'
        },
        auth: {
          audience: 'urn:test-audience'
        }
      }
    }

    const { default: createServers } = await vi.importFresh('../../core/servers.ts', import.meta.url)
    const servers = createServers(global.WIKI)
    const createHttpServer = () => ({ on: vi.fn(), off: vi.fn() })
    return {
      servers,
      collaboration,
      createGraphQLArtifacts,
      createYoga,
      maskError,
      yoga,
      useServer,
      cleanup,
      WebSocketServer,
      wsServer,
      authenticateUserToken,
      checkAccess,
      createHttpServer
    }
  }

  it('resolves HTTP startup only after the listener is ready', async () => {
    const { servers } = await setupModule()
    await servers.startGraphQL()
    await servers.startHTTP()
    try {
      expect(servers.servers.http.listening).toBe(true)
    } finally {
      await servers.stopServers()
    }
  })

  it('rejects a listen failure and releases acquired transports once', async () => {
    const occupied = http.createServer()
    await new Promise((resolve, reject) => {
      occupied.once('error', reject)
      occupied.listen(0, '127.0.0.1', resolve)
    })
    const address = occupied.address()
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')

    const { servers, collaboration, cleanup } = await setupModule()
    global.WIKI.config.port = address.port
    await servers.startGraphQL()
    try {
      await expect(servers.startHTTP()).rejects.toMatchObject({ code: 'EADDRINUSE' })
      await servers.stopServers()
      expect(cleanup.dispose).toHaveBeenCalledTimes(1)
      expect(collaboration.dispose).toHaveBeenCalledTimes(1)
      expect(servers.servers.http).toBeNull()
    } finally {
      if (servers.servers.http) await servers.stopServers()
      await new Promise((resolve, reject) => {
        occupied.close(error => error ? reject(error) : resolve())
      })
    }
  })

  it('mounts Yoga on the existing GraphQL endpoint', async () => {
    const { servers, createYoga, yoga } = await setupModule()

    await servers.startGraphQL()

    expect(createYoga).toHaveBeenCalledWith(expect.objectContaining({
      schema: { kind: 'schema' },
      graphqlEndpoint: '/graphql',
      logging: global.WIKI.logger,
      maskedErrors: {
        isDev: false,
        maskError: expect.any(Function)
      },
      graphiql: false
    }))
    expect(global.WIKI.app.use).toHaveBeenCalledWith('/graphql', expect.any(Function))
    const request = { kind: 'request' }
    const response = { kind: 'response' }
    global.WIKI.app.use.mock.calls[0][1](request, response, vi.fn())
    expect(yoga).toHaveBeenCalledWith(request, response)
  })

  it('masks unexpected GraphQL causes while retaining classified conflicts', async () => {
    const { servers, createYoga, maskError } = await setupModule()
    await servers.startGraphQL()
    const options = createYoga.mock.calls[0][0]
    const unexpected = new Error('database password is secret')
    const wrappedUnexpected = Object.assign(new Error(unexpected.message), { originalError: unexpected })
    const masked = options.maskedErrors.maskError(wrappedUnexpected, 'Unexpected error.')
    expect(maskError).toHaveBeenCalledWith(wrappedUnexpected, 'Unexpected error.')
    expect(masked.message).toBe('Unexpected error.')

    maskError.mockClear()
    const conflict = Object.assign(new Error('The page changed.'), { status: 409 })
    const wrappedConflict = Object.assign(new Error(conflict.message), { originalError: conflict })
    expect(options.maskedErrors.maskError(wrappedConflict, 'Unexpected error.')).toBe(wrappedConflict)
    expect(maskError).not.toHaveBeenCalled()
  })

  it('attaches graphql-ws to the maintained subscription endpoint', async () => {
    const { servers, useServer, WebSocketServer, createHttpServer } = await setupModule()
    const httpServer = createHttpServer()

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(httpServer)

    expect(WebSocketServer).toHaveBeenCalledWith({ noServer: true })
    expect(httpServer.on).toHaveBeenCalledWith('upgrade', expect.any(Function))
    expect(useServer).toHaveBeenCalledWith(expect.objectContaining({
      onConnect: expect.any(Function),
      onSubscribe: expect.any(Function)
    }), expect.any(Object))
  })
  it('routes only the maintained GraphQL upgrade path', async () => {
    const { servers, wsServer, createHttpServer } = await setupModule()
    const httpServer = createHttpServer()
    wsServer.handleUpgrade.mockImplementation((_request, _socket, _head, connected) => connected({ id: 'client' }))

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(httpServer)
    const upgrade = httpServer.on.mock.calls[0][1]
    upgrade({ url: '/collaboration' }, {}, Buffer.alloc(0))
    expect(wsServer.handleUpgrade).not.toHaveBeenCalled()

    const request = { url: '/graphql-subscriptions?transport=ws' }
    upgrade(request, {}, Buffer.alloc(0))
    expect(wsServer.handleUpgrade).toHaveBeenCalledWith(request, {}, expect.any(Buffer), expect.any(Function))
    expect(wsServer.emit).toHaveBeenCalledWith('connection', { id: 'client' }, request)
  })


  it('accepts a valid connection token for manage:system users', async () => {
    const { servers, useServer, authenticateUserToken, checkAccess, createHttpServer } = await setupModule()
    const user = { id: 7, permissions: ['manage:system'] }
    authenticateUserToken.mockResolvedValue(user)

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(createHttpServer())
    const protocol = useServer.mock.calls[0][0]
    const context = {
      connectionParams: { token: 'direct-token' },
      extra: { request: { headers: {} } }
    }
    await protocol.onConnect(context)

    expect(context.extra).toMatchObject({ token: 'direct-token', user })
    expect(authenticateUserToken).toHaveBeenCalledWith('direct-token')
    expect(checkAccess).toHaveBeenCalledWith(user, ['manage:system'])
  })

  it('falls back to the jwt cookie', async () => {
    const { servers, authenticateUserToken } = await setupModule()
    const user = { id: 9, permissions: ['manage:system'] }
    authenticateUserToken.mockResolvedValue(user)

    await expect(servers.authenticateGraphQLSubscription({}, {
      headers: { cookie: 'foo=bar; jwt=cookie-token' }
    })).resolves.toEqual({ token: 'cookie-token', user })
    expect(authenticateUserToken).toHaveBeenCalledWith('cookie-token')
  })

  it('rejects missing, invalid, and underprivileged credentials', async () => {
    const { servers, authenticateUserToken } = await setupModule()
    const request = { headers: {} }

    await expect(servers.authenticateGraphQLSubscription({}, request)).rejects.toThrow('Unauthorized')
    authenticateUserToken.mockRejectedValueOnce(new Error('invalid token'))
    await expect(servers.authenticateGraphQLSubscription({ token: 'invalid-token' }, request)).rejects.toThrow('Unauthorized')
    authenticateUserToken.mockResolvedValueOnce({ id: 8, permissions: ['read:pages'] })
    await expect(servers.authenticateGraphQLSubscription({ token: 'underprivileged-token' }, request)).rejects.toThrow('Unauthorized')
  })

  it('revalidates an active authorized principal before subscribing and before each event delivery', async () => {
    const { servers, useServer, yoga, authenticateUserToken, createHttpServer } = await setupModule()
    const user = { id: 7, permissions: ['manage:system'] }
    authenticateUserToken.mockResolvedValue(user)
    yoga.getEnveloped.mockReturnValue({
      schema: { kind: 'schema' },
      execute: vi.fn(),
      subscribe: vi.fn(),
      contextFactory: vi.fn().mockResolvedValue({ user }),
      parse: vi.fn().mockReturnValue({ kind: 'document' }),
      validate: vi.fn().mockReturnValue([])
    })

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(createHttpServer())
    const protocol = useServer.mock.calls[0][0]
    const context = {
      connectionParams: { token: 'direct-token' },
      extra: { request: { headers: {}, socket: {} } }
    }
    await protocol.onConnect(context)
    await expect(protocol.onSubscribe(context, 'operation-1', { query: 'subscription { loggingLiveTrail { level } }' })).resolves.toMatchObject({
      schema: { kind: 'schema' },
      document: { kind: 'document' }
    })
    await expect(protocol.onNext(context)).resolves.toBeUndefined()

    expect(authenticateUserToken).toHaveBeenCalledTimes(3)
    expect(authenticateUserToken).toHaveBeenNthCalledWith(1, 'direct-token')
    expect(authenticateUserToken).toHaveBeenNthCalledWith(2, 'direct-token')
    expect(authenticateUserToken).toHaveBeenNthCalledWith(3, 'direct-token')
  })

  it.each(['revoked', 'inactive', 'expired'])('rejects a %s principal at connection time', async () => {
    const { servers, useServer, authenticateUserToken, createHttpServer } = await setupModule()
    authenticateUserToken.mockResolvedValue(null)

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(createHttpServer())
    const protocol = useServer.mock.calls[0][0]
    const context = {
      connectionParams: { token: 'stale-token' },
      extra: { request: { headers: {} } }
    }

    await expect(protocol.onConnect(context)).rejects.toThrow('Unauthorized')
  })

  it('rejects authority revoked after connection before starting a subscription', async () => {
    const { servers, useServer, authenticateUserToken, createHttpServer } = await setupModule()
    const user = { id: 7, permissions: ['manage:system'] }
    authenticateUserToken.mockResolvedValueOnce(user).mockResolvedValueOnce(null)

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(createHttpServer())
    const protocol = useServer.mock.calls[0][0]
    const context = {
      connectionParams: { token: 'revoked-token' },
      extra: { request: { headers: {} } }
    }
    await protocol.onConnect(context)

    await expect(protocol.onSubscribe(context, 'operation-1', { query: 'subscription { loggingLiveTrail { level } }' })).rejects.toThrow('Unauthorized')
  })

  it.each(['revoked', 'inactive', 'expired'])('blocks event delivery when an active %s principal becomes unauthorized', async () => {
    const { servers, useServer, yoga, authenticateUserToken, createHttpServer } = await setupModule()
    const user = { id: 7, permissions: ['manage:system'] }
    authenticateUserToken.mockResolvedValueOnce(user).mockResolvedValueOnce(user).mockResolvedValueOnce(null)
    yoga.getEnveloped.mockReturnValue({
      schema: { kind: 'schema' },
      execute: vi.fn(),
      subscribe: vi.fn(),
      contextFactory: vi.fn().mockResolvedValue({ user }),
      parse: vi.fn().mockReturnValue({ kind: 'document' }),
      validate: vi.fn().mockReturnValue([])
    })

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(createHttpServer())
    const protocol = useServer.mock.calls[0][0]
    const context = {
      connectionParams: { token: 'stale-token' },
      extra: { request: { headers: {}, socket: {} } }
    }
    await protocol.onConnect(context)
    await protocol.onSubscribe(context, 'operation-1', { query: 'subscription { loggingLiveTrail { level } }' })

    await expect(protocol.onNext(context)).rejects.toThrow('Unauthorized')
  })

  it('blocks event delivery after the current user loses manage:system', async () => {
    const { servers, useServer, yoga, authenticateUserToken, createHttpServer } = await setupModule()
    const administrator = { id: 7, permissions: ['manage:system'] }
    const demotedUser = { id: 7, permissions: ['read:pages'] }
    authenticateUserToken.mockResolvedValueOnce(administrator).mockResolvedValueOnce(administrator).mockResolvedValueOnce(demotedUser)
    yoga.getEnveloped.mockReturnValue({
      schema: { kind: 'schema' },
      execute: vi.fn(),
      subscribe: vi.fn(),
      contextFactory: vi.fn().mockResolvedValue({ user: administrator }),
      parse: vi.fn().mockReturnValue({ kind: 'document' }),
      validate: vi.fn().mockReturnValue([])
    })

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(createHttpServer())
    const protocol = useServer.mock.calls[0][0]
    const context = {
      connectionParams: { token: 'demoted-token' },
      extra: { request: { headers: {}, socket: {} } }
    }
    await protocol.onConnect(context)
    await protocol.onSubscribe(context, 'operation-1', { query: 'subscription { loggingLiveTrail { level } }' })

    await expect(protocol.onNext(context)).rejects.toThrow('Unauthorized')
  })

  it('disposes the graphql-ws handler and WebSocket server', async () => {
    const { servers, cleanup, wsServer, createHttpServer } = await setupModule()
    const httpServer = createHttpServer()

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(httpServer)
    await servers.disposeGraphQLSubscriptions(httpServer)

    expect(cleanup.dispose).toHaveBeenCalledTimes(1)
    expect(wsServer.close).toHaveBeenCalledTimes(1)
    expect(httpServer.off).toHaveBeenCalledWith('upgrade', expect.any(Function))
    expect(servers.servers.graph.subscriptions).toEqual([])
  })
})
