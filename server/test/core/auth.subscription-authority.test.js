import { DateTime } from 'luxon'

describe('core/auth subscription token authority', () => {
  let previousWiki

  beforeEach(() => {
    previousWiki = global.WIKI
  })

  afterEach(() => {
    global.WIKI = previousWiki
    vi.unmockModule('jsonwebtoken', import.meta.url)
    vi.restoreAllMocks()
  })

  const setupModule = async ({ user } = {}) => {
    vi.resetModules()
    const verify = vi.fn()
    vi.mockModule('jsonwebtoken', import.meta.url, () => ({
      default: {
        decode: vi.fn(),
        sign: vi.fn(),
        verify
      }
    }))

    const lookup = {
      withGraphFetched: vi.fn(),
      modifyGraph: vi.fn()
    }
    lookup.withGraphFetched.mockReturnValue(lookup)
    lookup.modifyGraph.mockReturnValue(lookup)
    lookup.then = (resolve, reject) => Promise.resolve(user).then(resolve, reject)
    const findById = vi.fn().mockReturnValue(lookup)
    global.WIKI = {
      config: {
        api: { isEnabled: true },
        auth: {
          audience: 'urn:test-audience',
          tokenExpiration: '30m',
          tokenRenewal: '15m'
        },
        certs: {
          private: 'PRIVATE-KEY',
          public: 'PUBLIC-KEY'
        },
        features: { featurePageComments: true },
        host: 'https://wiki.example.test',
        sessionSecret: 'test-secret'
      },
      configSvc: {},
      events: {},
      lang: {},
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn()
      },
      models: {
        users: {
          query: vi.fn(() => ({ findById }))
        }
      },
      startedAt: DateTime.fromSeconds(100)
    }

    const { default: auth } = await vi.importFresh('../../core/auth.ts', import.meta.url)
    return { auth, findById, verify }
  }

  const activeUser = () => ({
    id: 7,
    isActive: true,
    groups: [{ id: 3, permissions: ['manage:system'] }],
    getGlobalPermissions: vi.fn(() => ['manage:system']),
    getGroups: vi.fn(() => [3])
  })

  it('resolves an unexpired token to the current active user and current group authority', async () => {
    const user = activeUser()
    const { auth, findById, verify } = await setupModule({ user })
    verify.mockReturnValue({ id: 7, iat: 200, exp: 500, groups: [3], permissions: ['read:pages'] })

    await expect(auth.authenticateUserToken('current-token')).resolves.toBe(user)

    expect(verify).toHaveBeenCalledWith('current-token', 'PUBLIC-KEY', {
      audience: 'urn:test-audience',
      issuer: 'urn:wiki.js',
      algorithms: ['RS256']
    })
    expect(findById).toHaveBeenCalledWith(7)
    expect(user.permissions).toEqual(['manage:system'])
    expect(user.groups).toEqual([3])
  })

  it('rejects an expired token before loading the current user', async () => {
    const { auth, findById, verify } = await setupModule({ user: activeUser() })
    verify.mockImplementation(() => {
      throw Object.assign(new Error('jwt expired'), { name: 'TokenExpiredError' })
    })

    await expect(auth.authenticateUserToken('expired-token')).resolves.toBeNull()
    expect(findById).not.toHaveBeenCalled()
  })

  it('rejects a token revoked for its user or any claimed group', async () => {
    const { auth, findById, verify } = await setupModule({ user: activeUser() })
    verify.mockReturnValue({ id: 7, iat: 200, exp: 500, groups: [3], permissions: ['manage:system'] })

    auth.revocationList.set('u7', 201)
    await expect(auth.authenticateUserToken('user-revoked-token')).resolves.toBeNull()
    auth.revocationList.del('u7')
    auth.revocationList.set('g3', 201)
    await expect(auth.authenticateUserToken('group-revoked-token')).resolves.toBeNull()

    expect(findById).not.toHaveBeenCalled()
  })

  it('rejects tokens predating server authority and inactive or missing current users', async () => {
    const inactiveUser = { ...activeUser(), isActive: false }
    const first = await setupModule({ user: inactiveUser })
    first.verify.mockReturnValue({ id: 7, iat: 200, exp: 500, groups: [3], permissions: ['manage:system'] })
    await expect(first.auth.authenticateUserToken('inactive-token')).resolves.toBeNull()

    const missing = await setupModule({ user: undefined })
    missing.verify.mockReturnValue({ id: 7, iat: 200, exp: 500, groups: [3], permissions: ['manage:system'] })
    await expect(missing.auth.authenticateUserToken('missing-user-token')).resolves.toBeNull()

    const stale = await setupModule({ user: activeUser() })
    stale.verify.mockReturnValue({ id: 7, iat: 100, exp: 500, groups: [3], permissions: ['manage:system'] })
    await expect(stale.auth.authenticateUserToken('pre-start-token')).resolves.toBeNull()
  })
})
