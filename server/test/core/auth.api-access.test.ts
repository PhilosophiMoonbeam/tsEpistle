
import type { Request, Response } from 'express'
import { DateTime } from 'luxon'


let authenticatedPrincipal: Express.User | false | null = null
type PassportCallback = (
  error: unknown,
  user: Express.User | false | null | undefined,
  info: unknown
) => unknown

const passportAuthenticate = vi.fn((_strategy: string, _options: unknown, callback: PassportCallback) =>
  () => callback(null, authenticatedPrincipal, null)
)

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

const createRequest = (requestPath: string) => ({
  path: requestPath,
  get: vi.fn(),
  logIn: vi.fn((_user, _options, callback) => callback())
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

  test('maps an active API key to its group permissions for GraphQL', async () => {
    const req = createRequest('/graphql')

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


  test('maps an active API key to its group permissions for REST v1', async () => {
    const req = createRequest('/api/v1/pages')

    const next = await authenticate(req)

    expect(next).toHaveBeenCalledWith()
    expect(req.user).toMatchObject({
      permissions: ['read:pages'],
      groups: [3]
    })
  })
  test('rejects API keys from application-internal REST routes', async () => {
    const req = createRequest('/_api/system/info')

    const next = await authenticate(req)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: 'API_KEY_REST_FORBIDDEN',
      status: 403
    }))
    expect(req.user).toBeUndefined()
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

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: 'API_ACCESS_DISABLED',
      status: 403
    }))
  })

  test('invalidates a revoked key immediately after the valid-key cache changes', async () => {
    expect(await authenticate(createRequest('/graphql'))).toHaveBeenCalledWith()

    auth.validApiKeys = []
    const next = await authenticate(createRequest('/graphql'))

    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      code: 'API_KEY_INVALID',
      status: 401
    }))
  })
})
