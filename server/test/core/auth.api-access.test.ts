import type { Request, Response } from 'express'
import { DateTime } from 'luxon'

let authenticatedPrincipal: Express.User | false | null = null
type PassportCallback = (error: unknown, user: Express.User | false | null | undefined, info: unknown) => unknown

const passportAuthenticate = vi.fn((_strategy: string, _options: unknown, callback: PassportCallback) => () => callback(null, authenticatedPrincipal, null))

vi.mockModule('passport', import.meta.url, () => ({
  default: {
    authenticate: passportAuthenticate,
    deserializeUser: vi.fn(),
    initialize: vi.fn(),
    serializeUser: vi.fn(),
    use: vi.fn()
  }
}))

const { default: auth } = await import('../../core/auth.ts')

const createRequest = (requestPath: string, mountedRoutePath?: string) =>
  ({
    path: requestPath,
    get: vi.fn(),
    logIn: vi.fn((_user, _options, callback) => callback()),
    ...(mountedRoutePath === undefined ? {} : { route: { path: mountedRoutePath } })
  }) as unknown as Request

const response = {
  cookie: vi.fn(),
  set: vi.fn()
} as unknown as Response

const authenticate = async (request: Request): Promise<ReturnType<typeof vi.fn>> => {
  const next = vi.fn()
  auth.authenticate(request, response, next)
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
  return next
}

describe('API-key authentication boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authenticatedPrincipal = { api: 7, grp: 3 } as Express.User
    auth.validApiKeys = [7]
    auth.groups = {
      '3': {
        id: 3,
        permissions: ['read:pages'],
        pageRules: []
      }
    }
    global.WIKI = {
      config: {
        api: { isEnabled: true },
        auth: {
          audience: 'urn:wiki:test',
          tokenExpiration: '30m',
          tokenRenewal: '15m'
        },
        certs: { private: '', public: '' },
        features: { featurePageComments: true },
        host: 'http://localhost',
        sessionSecret: 'test'
      },
      configSvc: { saveToDb: vi.fn() },
      events: {
        inbound: { on: vi.fn() },
        outbound: { emit: vi.fn() }
      },
      lang: { t: vi.fn() },
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn()
      },
      models: {
        apiKeys: { query: vi.fn() },
        authentication: { getStrategies: vi.fn() },
        groups: { query: vi.fn() },
        users: {
          getGuestUser: vi.fn(),
          query: vi.fn(),
          refreshToken: vi.fn()
        }
      },
      startedAt: DateTime.utc().minus({ days: 1 })
    }
  })

  test.each([
    ['GraphQL', '/graphql'],
    ['REST v1 root', '/api/v1'],
    ['REST v1 resource', '/api/v1/pages'],
    ['REST v1 OpenAPI document', '/api/v1/openapi.json']
  ])('constructs the same active API-key principal for the declared %s transport', async (_transport, requestPath) => {
    const req = createRequest(requestPath)

    const next = await authenticate(req)

    expect(next).toHaveBeenCalledWith()
    expect(req.user).toMatchObject({
      id: 1,
      permissions: ['read:pages'],
      groups: [3]
    })
    expect(req.authContext).toEqual({
      kind: 'apiKey',
      apiKeyId: 7,
      groupId: 3,
      ownershipUserId: null,
      principal: req.user
    })
  })

  test('preserves API-key authentication on the exact separately mounted MCP route', async () => {
    const req = createRequest('/mcp', '/mcp')

    const next = await authenticate(req)

    expect(next).toHaveBeenCalledWith()
    expect(req.authContext).toMatchObject({
      kind: 'apiKey',
      apiKeyId: 7,
      groupId: 3
    })
  })

  test.each([
    ['application-internal REST', '/_api/system/info'],
    ['upload', '/u'],
    ['HTML authentication', '/login'],
    ['HTML page', '/docs/getting-started'],
    ['arbitrary browser', '/admin'],
    ['REST prefix lookalike', '/api/v10/pages'],
    ['MCP outside its dedicated mount', '/mcp']
  ])('rejects the same API key from the %s sink before assigning principal state', async (_sink, requestPath) => {
    const req = createRequest(requestPath)

    const next = await authenticate(req)

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'API_KEY_TRANSPORT_FORBIDDEN',
        status: 403
      })
    )
    expect(req.user).toBeUndefined()
    expect(req.authContext).toBeUndefined()
    expect(req.apiKeyAuth).toBeUndefined()
  })

  test('preserves internal REST access for signed-in user sessions', async () => {
    const sessionUser = { id: 42, permissions: ['manage:system'] } as Express.User
    authenticatedPrincipal = sessionUser
    const req = createRequest('/_api/system/info')

    const next = await authenticate(req)

    expect(req.logIn).toHaveBeenCalledWith(sessionUser, { session: false }, expect.any(Function))
    expect(next).toHaveBeenCalledWith()
    expect(req.authContext).toEqual({
      kind: 'user',
      userId: 42,
      ownershipUserId: 42,
      principal: sessionUser
    })
  })

  test('rejects disabled API access with a stable error', async () => {
    Reflect.set(WIKI.config, 'api', { isEnabled: false })

    const next = await authenticate(createRequest('/graphql'))

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'API_ACCESS_DISABLED',
        status: 403
      })
    )
  })

  test('invalidates a revoked key immediately after the valid-key cache changes', async () => {
    expect(await authenticate(createRequest('/graphql'))).toHaveBeenCalledWith()

    auth.validApiKeys = []
    const next = await authenticate(createRequest('/graphql'))

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'API_KEY_INVALID',
        status: 401
      })
    )
  })
})
