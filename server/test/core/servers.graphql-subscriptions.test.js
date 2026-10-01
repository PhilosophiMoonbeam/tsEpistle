import http from 'node:http'
import express from 'express'
import { buildSchema, GraphQLError } from 'graphql'
import { createYoga as dependencyCreateYoga, maskError as dependencyMaskError } from 'graphql-yoga'

// Capture the real dependency before Bun's module mocks replace its live exports.
const realYoga = { createYoga: dependencyCreateYoga, maskError: dependencyMaskError }

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

  const setupModule = async ({ realHttp = false } = {}) => {
    vi.resetModules()

    const yoga = Object.assign(vi.fn(), {
      graphqlEndpoint: '/graphql',
      getEnveloped: vi.fn()
    })
    const createYoga = realHttp ? realYoga.createYoga : vi.fn().mockReturnValue(yoga)
    const maskError = realYoga.maskError
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

    vi.mockModule('graphql-yoga', import.meta.url, () => ({ createYoga, maskError, renderGraphiQL: vi.fn(() => '<html><head></head><body><noscript></noscript></body></html>') }))
    vi.mockModule('graphql-ws/use/ws', import.meta.url, () => ({ useServer }))
    vi.mockModule('ws', import.meta.url, () => ({
      default: { Server: WebSocketServer },
      WebSocketServer
    }))
    const createGraphQLArtifacts = vi.fn().mockResolvedValue({
      schema: realHttp ? buildSchema('type Query { greeting: String }') : { kind: 'schema' }
    })
    vi.mockModule('../../graph/index.ts', import.meta.url, () => ({ createGraphQLArtifacts }))

    const app = realHttp ? express() : Object.assign(vi.fn((_request, response) => response.end()), {
      use: vi.fn()
    })
    const collaboration = {
      install: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined)
    }
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn()
    }
    const authenticateUserToken = vi.fn()
    const checkAccess = vi.fn((user, permissions = []) =>
      user?.permissions?.includes('manage:system') === true ||
      permissions.some(permission => user?.permissions?.includes(permission) === true)
    )
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
        },
        host: 'https://wiki.example.test'
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

  it('executes GraphQL over HTTP at the existing endpoint', async () => {
    const { servers } = await setupModule({ realHttp: true })
    try {
      await servers.startGraphQL()
      await servers.startHTTP()
      const address = servers.servers.http.address()
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
      const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' })
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ data: { __typename: 'Query' } })
    } finally {
      await servers.stopServers()
    }
  })

  it('serves GraphiQL only to users with API administration access', async () => {
    const { servers, createYoga, checkAccess } = await setupModule()
    await servers.startGraphQL()
    const { graphiql } = createYoga.mock.calls[0][0]
    const request = {}
    const permissions = ['manage:system', 'manage:api']

    expect(graphiql(request, { req: { user: { permissions: ['manage:api'] } } })).toEqual(expect.objectContaining({ subscriptionsProtocol: 'WS', credentials: 'same-origin', shouldPersistHeaders: false }))
    expect(graphiql(request, { req: { user: { permissions: ['read:pages'] } } })).toBe(false)
    expect(graphiql(request, {})).toBe(false)
    expect(checkAccess).toHaveBeenCalledWith({ permissions: ['manage:api'] }, permissions)
  })

  it('masks unexpected GraphQL causes while retaining classified conflicts', async () => {
    const { servers, createYoga } = await setupModule()
    await servers.startGraphQL()
    const options = createYoga.mock.calls[0][0]
    expect(options.maskedErrors.isDev).toBe(false)
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const unexpected = new Error('database password is secret')
      const wrappedUnexpected = new GraphQLError(unexpected.message, { originalError: unexpected })
      const masked = options.maskedErrors.maskError(wrappedUnexpected, 'Unexpected error.')
      expect(masked).not.toBe(wrappedUnexpected)
      expect(masked.message).not.toContain(unexpected.message)
      expect(JSON.stringify(masked.toJSON())).not.toContain(unexpected.message)

      const conflict = Object.assign(new Error('The page changed.'), { status: 409 })
      const wrappedConflict = new GraphQLError(conflict.message, { originalError: conflict })
      expect(options.maskedErrors.maskError(wrappedConflict, 'Unexpected error.')).toBe(wrappedConflict)
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
    }
  })

  it('keeps WebSocket upgrade admission under the shared HTTP listener', async () => {
    const { servers, WebSocketServer, createHttpServer } = await setupModule()
    const httpServer = createHttpServer()

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(httpServer)

    expect(WebSocketServer).toHaveBeenCalledWith({ noServer: true })
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

    const request = { url: '/graphql-subscriptions?transport=ws', headers: { origin: 'https://wiki.example.test' } }
    upgrade(request, {}, Buffer.alloc(0))
    expect(wsServer.handleUpgrade).toHaveBeenCalledWith(request, {}, expect.any(Buffer), expect.any(Function))
    expect(wsServer.emit).toHaveBeenCalledWith('connection', { id: 'client' }, request)
    const rejectedSocket = { destroy: vi.fn() }
    upgrade({ url: '/graphql-subscriptions', headers: { origin: 'https://foreign.example.test' } }, rejectedSocket, Buffer.alloc(0))
    expect(wsServer.handleUpgrade).toHaveBeenCalledTimes(1)
    expect(rejectedSocket.destroy).toHaveBeenCalledTimes(1)
  })

  it('accepts the HttpOnly cookie for manage:system users', async () => {
    const { servers, useServer, authenticateUserToken, checkAccess, createHttpServer } = await setupModule()
    const user = { id: 7, permissions: ['manage:system'] }
    authenticateUserToken.mockResolvedValue(user)

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(createHttpServer())
    const protocol = useServer.mock.calls[0][0]
    const context = {
      connectionParams: { token: 'ignored-client-token' },
      extra: { request: { headers: { cookie: 'foo=bar; jwt=cookie-token' } } }
    }
    await protocol.onConnect(context)

    expect(context.extra).toMatchObject({ token: 'cookie-token', user })
    expect(authenticateUserToken).toHaveBeenCalledWith('cookie-token')
    expect(checkAccess).toHaveBeenCalledWith(user, ['manage:system'])
  })


  it('rejects missing, invalid, and underprivileged credentials', async () => {
    const { servers, authenticateUserToken } = await setupModule()
    const request = { headers: {} }

    await expect(servers.authenticateGraphQLSubscription({}, request)).rejects.toThrow('Unauthorized')
    authenticateUserToken.mockRejectedValueOnce(new Error('invalid token'))
    await expect(servers.authenticateGraphQLSubscription({}, { headers: { cookie: 'jwt=invalid-token' } })).rejects.toThrow('Unauthorized')
    authenticateUserToken.mockResolvedValueOnce({ id: 8, permissions: ['read:pages'] })
    await expect(servers.authenticateGraphQLSubscription({}, { headers: { cookie: 'jwt=underprivileged-token' } })).rejects.toThrow('Unauthorized')
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
      connectionParams: { token: 'ignored-client-token' },
      extra: { request: { headers: { cookie: 'jwt=direct-token' }, socket: {} } }
    }
    await protocol.onConnect(context)
    await expect(protocol.onSubscribe(context, 'operation-1', { query: 'subscription { loggingLiveTrail { level } }' })).resolves.toMatchObject({
      schema: { kind: 'schema' },
      document: { kind: 'document' }
    })
    await protocol.onNext(context)

    expect(authenticateUserToken).toHaveBeenCalledTimes(3)
    expect(authenticateUserToken).toHaveBeenNthCalledWith(1, 'direct-token')
    expect(authenticateUserToken).toHaveBeenNthCalledWith(2, 'direct-token')
    expect(authenticateUserToken).toHaveBeenNthCalledWith(3, 'direct-token')
  })

  it('rejects an unauthorized principal at connection time', async () => {
    const { servers, useServer, authenticateUserToken, createHttpServer } = await setupModule()
    authenticateUserToken.mockResolvedValue(null)

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(createHttpServer())
    const protocol = useServer.mock.calls[0][0]
    const context = {
      connectionParams: { token: 'stale-token' },
      extra: { request: { headers: { cookie: 'jwt=stale-token' } } }
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
      extra: { request: { headers: { cookie: 'jwt=revoked-token' } } }
    }
    await protocol.onConnect(context)

    await expect(protocol.onSubscribe(context, 'operation-1', { query: 'subscription { loggingLiveTrail { level } }' })).rejects.toThrow('Unauthorized')
  })

  it('blocks event delivery when an active principal becomes unauthorized', async () => {
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
      extra: { request: { headers: { cookie: 'jwt=stale-token' }, socket: {} } }
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
      extra: { request: { headers: { cookie: 'jwt=demoted-token' }, socket: {} } }
    }
    await protocol.onConnect(context)
    await protocol.onSubscribe(context, 'operation-1', { query: 'subscription { loggingLiveTrail { level } }' })

    await expect(protocol.onNext(context)).rejects.toThrow('Unauthorized')
  })

  it('disposes the graphql-ws handler and unregisters its installed upgrade listener', async () => {
    const { servers, cleanup, createHttpServer } = await setupModule()
    const httpServer = createHttpServer()

    await servers.startGraphQL()
    servers.installGraphQLSubscriptions(httpServer)
    const upgradeListener = httpServer.on.mock.calls[0][1]
    await servers.disposeGraphQLSubscriptions(httpServer)

    expect(cleanup.dispose).toHaveBeenCalledTimes(1)
    expect(httpServer.off).toHaveBeenCalledWith('upgrade', upgradeListener)
    expect(servers.servers.graph.subscriptions).toEqual([])
  })
})
