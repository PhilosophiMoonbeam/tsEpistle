jest.mock('express-brute', () => {
  return jest.fn().mockImplementation(() => ({
    prevent: jest.fn((req, res, next) => next())
  }))
})

jest.mock('../../helpers/brute-knex', () => {
  return jest.fn().mockImplementation(() => ({}))
})

jest.mock('express', () => {
  const router = {
    get: jest.fn(),
    post: jest.fn(),
    use: jest.fn()
  }

  return {
    Router: () => router,
    __router: router
  }
})

describe('controllers/api auth endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__router.get.mockClear()
    express.__router.post.mockClear()

    global.WIKI = {
      config: {
        api: {
          isEnabled: true
        }
      },
      data: {
        authentication: [
          {
            key: 'local',
            title: 'Local',
            useForm: true,
            props: {
              usernameFormat: { type: 'string', default: 'email', order: 2 }, displayName: { type: 'string', default: '', order: 1 }
            }
          },
          {
            key: 'github',
            title: 'GitHub',
            useForm: false,
            props: {
              clientId: { type: 'string', default: '', order: 2 }, clientSharedKey: { type: 'string', default: '', order: 1 }
            }
          }
        ]
      },
      auth: {
        checkAccess: jest.fn().mockReturnValue(true),
        regenerateCertificates: jest.fn().mockResolvedValue(true),
        resetGuestUser: jest.fn().mockResolvedValue(true),
        reloadApiKeys: jest.fn().mockResolvedValue(true),
        activateStrategies: jest.fn().mockResolvedValue(true),
        strategies: {
          local: {
            key: 'local',
            isEnabled: true,
            strategyKey: 'local'
          },
          github: {
            key: 'github',
            isEnabled: true,
            strategyKey: 'github'
          },
          disabledlocal: {
            key: 'disabledlocal',
            isEnabled: false,
            strategyKey: 'local'
          }
        }
      },
      configSvc: {
        saveToDb: jest.fn().mockResolvedValue(true)
      },
      events: {
        outbound: {
          emit: jest.fn()
        }
      },
      models: {
        authentication: {
          query: jest.fn(() => ({
            patch: jest.fn(() => ({ where: jest.fn().mockResolvedValue(1) })),
            insert: jest.fn().mockResolvedValue({}),
            delete: jest.fn(() => ({ where: jest.fn().mockResolvedValue(1) }))
          })),
          getStrategies: jest.fn().mockResolvedValue([
            {
              key: 'local',
              strategyKey: 'local',
              displayName: 'Local Login',
              order: 1,
              isEnabled: true,
              config: {
                usernameFormat: 'email',
                ignoredConfig: 'ignored'
              },
              selfRegistration: false,
              domainWhitelist: ['example.com'],
              autoEnrollGroups: [1]
            },
            {
              key: 'github',
              strategyKey: 'github',
              displayName: 'GitHub Login',
              order: 2,
              isEnabled: false,
              config: {
                clientId: 'abc123',
                clientSharedKey: 'shh'
              },
              selfRegistration: true,
              domainWhitelist: [],
              autoEnrollGroups: []
            }
          ])
        },
        apiKeys: {
          createNewKey: jest.fn().mockResolvedValue('generated-api-key'),
          query: jest.fn(() => ({
            orderBy: jest.fn().mockResolvedValue([]),
            findById: jest.fn(() => ({
              patch: jest.fn().mockResolvedValue(1)
            }))
          }))
        },
        users: {
          query: jest.fn(() => ({
            count: jest.fn(() => ({
              where: jest.fn(() => ({
                first: jest.fn().mockResolvedValue({ total: '0' })
              }))
            }))
          })),
          login: jest.fn(),
          loginTFA: jest.fn(),
          loginChangePassword: jest.fn(),
          loginForgotPassword: jest.fn()
        }
      }
    }
  })

  const loadHandlers = () => {
    const express = require('express')
    require('../../controllers/api/auth')
    const getRouteHandler = (path) => express.__router.get.mock.calls.find(([routePath]) => routePath === path)[1]
    const postRouteHandler = (path) => {
      const call = express.__router.post.mock.calls.find(([routePath]) => routePath === path)
      return call[call.length - 1]
    }
    return {
      adminStrategies: getRouteHandler('/admin/strategies'),
      adminActiveStrategies: getRouteHandler('/admin/active-strategies'),
      strategies: getRouteHandler('/strategies'),
      providers: getRouteHandler('/providers'),
      updateStrategies: postRouteHandler('/strategies'),
      api: getRouteHandler('/api'),
      setApiState: postRouteHandler('/api/state'),
      createApiKey: postRouteHandler('/api/keys'),
      revokeApiKey: postRouteHandler('/api/keys/:id/revoke'),
      regenerateCertificates: postRouteHandler('/certificates/regenerate'),
      resetGuestUser: postRouteHandler('/guest/reset'),
      forgotPassword: postRouteHandler('/forgot-password'),
      login: postRouteHandler('/login'),
      loginTFA: postRouteHandler('/login/tfa'),
      loginChangePassword: postRouteHandler('/login/change-password')
    }
  }

  it('registers the auth routes', () => {
    const handlers = loadHandlers()

    expect(typeof handlers.adminStrategies).toBe('function')
    expect(typeof handlers.adminActiveStrategies).toBe('function')
    expect(typeof handlers.strategies).toBe('function')
    expect(typeof handlers.providers).toBe('function')
    expect(typeof handlers.updateStrategies).toBe('function')
    expect(typeof handlers.api).toBe('function')
    expect(typeof handlers.setApiState).toBe('function')
    expect(typeof handlers.createApiKey).toBe('function')
    expect(typeof handlers.revokeApiKey).toBe('function')
    expect(typeof handlers.regenerateCertificates).toBe('function')
    expect(typeof handlers.resetGuestUser).toBe('function')
    expect(typeof handlers.forgotPassword).toBe('function')
    expect(typeof handlers.login).toBe('function')
    expect(typeof handlers.loginTFA).toBe('function')
    expect(typeof handlers.loginChangePassword).toBe('function')
  })

  it('returns admin authentication strategy definitions with GraphQL-compatible props', async () => {
    const { adminStrategies } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await adminStrategies(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:system'] }, ['manage:system'])
    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        key: 'local',
        title: 'Local',
        isAvailable: false,
        props: [
          { key: 'displayName', value: JSON.stringify({ type: 'string', default: '', order: 1 }) },
          { key: 'usernameFormat', value: JSON.stringify({ type: 'string', default: 'email', order: 2 }) }
        ]
      }),
      expect.objectContaining({
        key: 'github',
        title: 'GitHub',
        isAvailable: false,
        props: [
          { key: 'clientId', value: JSON.stringify({ type: 'string', default: '', order: 2 }) },
          { key: 'clientSharedKey', value: JSON.stringify({ type: 'string', default: '', order: 1 }) }
        ]
      })
    ])
  })

  it('returns 403 for unauthorized admin authentication strategy definitions requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { adminStrategies } = loadHandlers()
    const req = { user: { permissions: ['read:pages'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await adminStrategies(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system is required' })
  })

  it('returns admin active authentication strategies with GraphQL-compatible config', async () => {
    const { adminActiveStrategies } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, query: {} }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await adminActiveStrategies(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:system'] }, ['manage:system'])
    expect(global.WIKI.models.authentication.getStrategies).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith([
      expect.objectContaining({
        key: 'local',
        strategy: expect.objectContaining({ key: 'local', title: 'Local' }),
        config: [
          { key: 'usernameFormat', value: JSON.stringify({ type: 'string', default: 'email', order: 2, value: 'email' }) }
        ],
        order: 1,
        isEnabled: true,
        displayName: 'Local Login',
        selfRegistration: false,
        domainWhitelist: ['example.com'],
        autoEnrollGroups: [1]
      }),
      expect.objectContaining({
        key: 'github',
        strategy: expect.objectContaining({ key: 'github', title: 'GitHub' }),
        config: [
          { key: 'clientId', value: JSON.stringify({ type: 'string', default: '', order: 2, value: 'abc123' }) },
          { key: 'clientSharedKey', value: JSON.stringify({ type: 'string', default: '', order: 1, value: 'shh' }) }
        ],
        order: 2,
        isEnabled: false,
        displayName: 'GitHub Login',
        selfRegistration: true,
        domainWhitelist: [],
        autoEnrollGroups: []
      })
    ])
  })

  it('filters admin active authentication strategies when enabledOnly is true', async () => {
    const { adminActiveStrategies } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, query: { enabledOnly: 'true' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await adminActiveStrategies(req, res, jest.fn())

    expect(res.json.mock.calls[0][0]).toHaveLength(1)
    expect(res.json.mock.calls[0][0][0].key).toBe('local')
  })

  it('forwards admin active authentication strategy failures to next', async () => {
    const next = jest.fn()
    global.WIKI.models.authentication.getStrategies.mockRejectedValueOnce(new Error('auth db down'))
    const { adminActiveStrategies } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] }, query: {} }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await adminActiveStrategies(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('auth db down')
  })

  it('returns only enabled authentication strategies with the public login-safe payload', async () => {
    const { strategies } = loadHandlers()
    const res = { json: jest.fn() }

    await strategies({}, res, jest.fn())

    expect(global.WIKI.models.authentication.getStrategies).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith([
      {
        key: 'local',
        displayName: 'Local Login',
        order: 1,
        selfRegistration: false,
        strategy: {
          key: 'local',
          title: 'Local',
          useForm: true
        }
      }
    ])
  })

  it('returns all configured providers for admin user bootstrap when authorized', async () => {
    const { providers } = loadHandlers()
    const req = { user: { permissions: ['manage:users'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await providers(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:users'] }, ['manage:system', 'write:users', 'manage:users'])
    expect(res.json).toHaveBeenCalledWith([
      {
        key: 'local',
        displayName: 'Local Login',
        order: 1,
        isEnabled: true
      },
      {
        key: 'github',
        displayName: 'GitHub Login',
        order: 2,
        isEnabled: false
      }
    ])
  })

  it('returns 403 for unauthorized admin provider bootstrap requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { providers } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await providers(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system, write:users, or manage:users is required' })
  })

  it('updates authentication strategies through REST with normalized config and side effects', async () => {
    const { updateStrategies } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: {
        strategies: [
          {
            key: 'local',
            strategyKey: 'local',
            displayName: 'Local Login',
            order: 0,
            isEnabled: true,
            config: [{ key: 'usernameFormat', value: JSON.stringify({ v: 'email' }) }],
            selfRegistration: false,
            domainWhitelist: ['example.test'],
            autoEnrollGroups: [1, 2]
          },
          {
            key: 'oidc',
            strategyKey: 'oauth2',
            displayName: 'OIDC',
            order: 1,
            isEnabled: true,
            config: [{ key: 'clientId', value: JSON.stringify({ v: 'abc' }) }],
            selfRegistration: true,
            domainWhitelist: [],
            autoEnrollGroups: []
          }
        ]
      }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateStrategies(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:system'] }, ['manage:system'])
    const queries = global.WIKI.models.authentication.query.mock.results.map(result => result.value)
    expect(queries[0].patch).toHaveBeenCalledWith({
      key: 'local',
      strategyKey: 'local',
      displayName: 'Local Login',
      order: 0,
      isEnabled: true,
      config: { usernameFormat: 'email' },
      selfRegistration: false,
      domainWhitelist: { v: ['example.test'] },
      autoEnrollGroups: { v: [1, 2] }
    })
    expect(queries[0].patch.mock.results[0].value.where).toHaveBeenCalledWith('key', 'local')
    expect(queries[1].insert).toHaveBeenCalledWith({
      key: 'oidc',
      strategyKey: 'oauth2',
      displayName: 'OIDC',
      order: 1,
      isEnabled: true,
      config: { clientId: 'abc' },
      selfRegistration: true,
      domainWhitelist: { v: [] },
      autoEnrollGroups: { v: [] }
    })
    expect(queries[2].delete).toHaveBeenCalled()
    expect(queries[2].delete.mock.results[0].value.where).toHaveBeenCalledWith('key', 'github')
    expect(global.WIKI.auth.activateStrategies).toHaveBeenCalledTimes(1)
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('reloadAuthStrategies')
    expect(res.json).toHaveBeenCalledWith({ message: 'Strategies updated successfully' })
  })

  it('returns 403 for unauthorized authentication strategy updates', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { updateStrategies } = loadHandlers()
    const req = { user: { permissions: [] }, body: { strategies: [] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateStrategies(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system is required' })
    expect(global.WIKI.models.authentication.getStrategies).not.toHaveBeenCalled()
  })

  it.each([
    ['missing strategies', {}],
    ['non-array strategies', { strategies: {} }],
    ['malformed strategy', { strategies: [{ key: 'local' }] }],
    ['malformed config JSON', { strategies: [{ key: 'local', strategyKey: 'local', displayName: 'Local', order: 0, isEnabled: true, config: [{ key: 'usernameFormat', value: '{bad' }], selfRegistration: false, domainWhitelist: [], autoEnrollGroups: [] }] }],
    ['non-string domain', { strategies: [{ key: 'local', strategyKey: 'local', displayName: 'Local', order: 0, isEnabled: true, config: [], selfRegistration: false, domainWhitelist: [7], autoEnrollGroups: [] }] }],
    ['non-integer group', { strategies: [{ key: 'local', strategyKey: 'local', displayName: 'Local', order: 0, isEnabled: true, config: [], selfRegistration: false, domainWhitelist: [], autoEnrollGroups: ['1'] }] }]
  ])('returns 400 for invalid authentication strategy payloads: %s', async (label, body) => {
    const { updateStrategies } = loadHandlers()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateStrategies({ user: { permissions: ['manage:system'] }, body }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'strategies must be an array of valid authentication strategies' })
    expect(global.WIKI.models.authentication.getStrategies).not.toHaveBeenCalled()
  })

  it('returns JSON errors when a removed authentication strategy still has users', async () => {
    global.WIKI.models.users.query.mockImplementationOnce(() => ({
      count: jest.fn(() => ({
        where: jest.fn(() => ({
          first: jest.fn().mockResolvedValue({ total: '1' })
        }))
      }))
    }))
    const { updateStrategies } = loadHandlers()
    const req = {
      user: { permissions: ['manage:system'] },
      body: {
        strategies: [
          {
            key: 'local',
            strategyKey: 'local',
            displayName: 'Local Login',
            order: 0,
            isEnabled: true,
            config: [],
            selfRegistration: false,
            domainWhitelist: [],
            autoEnrollGroups: []
          }
        ]
      }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await updateStrategies(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Cannot delete GitHub Login as 1 or more users are still using it.' })
    expect(global.WIKI.auth.activateStrategies).not.toHaveBeenCalled()
  })

  it('returns admin api bootstrap payload when authorized', async () => {
    const fullKey = '123456789012345678901234567890'
    const orderBy = jest.fn().mockResolvedValueOnce([
      {
        id: 7,
        name: 'Deploy',
        key: fullKey,
        isRevoked: false,
        expiration: '2026-01-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-02-01T00:00:00.000Z',
        extraSecret: 'do-not-return'
      }
    ])
    global.WIKI.models.apiKeys.query.mockReturnValueOnce({ orderBy })
    const { api } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await api(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:api'] }, ['manage:system', 'manage:api'])
    expect(global.WIKI.models.apiKeys.query).toHaveBeenCalledTimes(1)
    expect(orderBy).toHaveBeenCalledWith(['isRevoked', 'name'])
    expect(res.json).toHaveBeenCalledWith({
      enabled: true,
      keys: [
        {
          id: 7,
          name: 'Deploy',
          keyShort: '...' + fullKey.substring(fullKey.length - 20),
          isRevoked: false,
          expiration: '2026-01-01T00:00:00.000Z',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-02-01T00:00:00.000Z'
        }
      ]
    })
    const payload = res.json.mock.calls[0][0]
    expect(payload.keys[0].key).toBeUndefined()
    expect(payload.keys[0].extraSecret).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain(fullKey)
  })

  it('redacts malformed short admin api keys instead of exposing key material', async () => {
    const shortKey = 'abc'
    const boundaryKey = 'x'.repeat(20)
    const orderBy = jest.fn().mockResolvedValueOnce([
      {
        id: 8,
        name: 'Legacy',
        key: shortKey,
        isRevoked: false,
        expiration: '2026-01-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-02-01T00:00:00.000Z'
      },
      {
        id: 9,
        name: 'Boundary',
        key: boundaryKey,
        isRevoked: false,
        expiration: '2026-01-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-02-01T00:00:00.000Z'
      },
      {
        id: 10,
        name: 'Corrupt',
        key: null,
        isRevoked: false,
        expiration: '2026-01-01T00:00:00.000Z',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-02-01T00:00:00.000Z'
      }
    ])
    global.WIKI.models.apiKeys.query.mockReturnValueOnce({ orderBy })
    const { api } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await api(req, res, jest.fn())

    const payload = res.json.mock.calls[0][0]
    expect(payload.keys[0].keyShort).toBe('...[redacted]')
    expect(payload.keys[1].keyShort).toBe('...[redacted]')
    expect(payload.keys[2].keyShort).toBe('...[redacted]')
    expect(JSON.stringify(payload)).not.toContain(shortKey)
    expect(JSON.stringify(payload)).not.toContain(boundaryKey)
  })

  it('normalizes admin api enabled state with strict true semantics', async () => {
    global.WIKI.config.api.isEnabled = 'true'
    const { api } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await api(req, res, jest.fn())

    expect(res.json).toHaveBeenCalledWith({
      enabled: false,
      keys: []
    })
  })

  it('returns 403 for unauthorized admin api bootstrap requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { api } = loadHandlers()
    const req = { user: { permissions: ['manage:users'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await api(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system or manage:api is required' })
    expect(global.WIKI.models.apiKeys.query).not.toHaveBeenCalled()
  })

  it('allows manage:api users to request admin api bootstrap', async () => {
    global.WIKI.auth.checkAccess.mockImplementationOnce((user, permissions) => user.permissions.includes('manage:api') && permissions.includes('manage:api'))
    const { api } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await api(req, res, jest.fn())

    expect(res.status).not.toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({
      enabled: true,
      keys: []
    })
  })

  it('forwards admin api bootstrap query failures to next', async () => {
    const orderBy = jest.fn().mockRejectedValueOnce(new Error('db failed'))
    global.WIKI.models.apiKeys.query.mockReturnValueOnce({ orderBy })
    const { api } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    const next = jest.fn()

    await api(req, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('db failed')
  })

  it('updates admin API state through REST when authorized', async () => {
    const { setApiState } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] }, body: { enabled: false } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await setApiState(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:api'] }, ['manage:system', 'manage:api'])
    expect(global.WIKI.config.api.isEnabled).toBe(false)
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['api'])
    expect(res.json).toHaveBeenCalledWith({ message: 'API State changed successfully' })
  })

  it('rejects malformed admin API state payloads', async () => {
    const { setApiState } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] }, body: { enabled: 'yes' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await setApiState(req, res)

    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'enabled must be a boolean' })
  })

  it('returns JSON errors when admin API state persistence fails', async () => {
    global.WIKI.configSvc.saveToDb.mockRejectedValueOnce(new Error('api save failed'))
    const { setApiState } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] }, body: { enabled: false } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await setApiState(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'api save failed' })
  })

  it('creates admin API keys through REST and reloads runtime keys', async () => {
    const { createApiKey } = loadHandlers()
    const req = {
      user: { permissions: ['manage:api'] },
      body: {
        name: 'Deploy',
        expiration: '1y',
        fullAccess: false,
        group: 7
      }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await createApiKey(req, res)

    expect(global.WIKI.models.apiKeys.createNewKey).toHaveBeenCalledWith({
      name: 'Deploy',
      expiration: '1y',
      fullAccess: false,
      group: 7
    })
    expect(global.WIKI.auth.reloadApiKeys).toHaveBeenCalled()
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('reloadApiKeys')
    expect(res.json).toHaveBeenCalledWith({
      key: 'generated-api-key',
      message: 'API Key created successfully'
    })
  })

  it('rejects malformed admin API key creation payloads', async () => {
    const { createApiKey } = loadHandlers()
    const req = {
      user: { permissions: ['manage:api'] },
      body: {
        name: 'Deploy',
        expiration: '1y',
        fullAccess: 'yes',
        group: 7
      }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await createApiKey(req, res)

    expect(global.WIKI.models.apiKeys.createNewKey).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'fullAccess must be a boolean' })
  })

  it('returns JSON errors when admin API key creation fails', async () => {
    global.WIKI.models.apiKeys.createNewKey.mockRejectedValueOnce(new Error('key backend failed'))
    const { createApiKey } = loadHandlers()
    const req = {
      user: { permissions: ['manage:api'] },
      body: {
        name: 'Deploy',
        expiration: '1y',
        fullAccess: true,
        group: null
      }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await createApiKey(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'key backend failed' })
  })

  it('revokes admin API keys through REST and reloads runtime keys', async () => {
    const patch = jest.fn().mockResolvedValue(1)
    const findById = jest.fn(() => ({ patch }))
    global.WIKI.models.apiKeys.query.mockReturnValueOnce({ findById })
    const { revokeApiKey } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] }, params: { id: '42' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await revokeApiKey(req, res)

    expect(findById).toHaveBeenCalledWith(42)
    expect(patch).toHaveBeenCalledWith({ isRevoked: true })
    expect(global.WIKI.auth.reloadApiKeys).toHaveBeenCalled()
    expect(global.WIKI.events.outbound.emit).toHaveBeenCalledWith('reloadApiKeys')
    expect(res.json).toHaveBeenCalledWith({ message: 'API Key revoked successfully' })
  })

  it.each(['0', '1.9', 'Infinity', '9007199254740992'])('rejects malformed admin API key revoke IDs: %s', async (id) => {
    const { revokeApiKey } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] }, params: { id } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await revokeApiKey(req, res)

    expect(global.WIKI.models.apiKeys.query).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'id must be a positive integer' })
  })

  it('returns JSON errors when admin API key revoke fails', async () => {
    const patch = jest.fn().mockRejectedValue(new Error('revoke backend failed'))
    const findById = jest.fn(() => ({ patch }))
    global.WIKI.models.apiKeys.query.mockReturnValueOnce({ findById })
    const { revokeApiKey } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] }, params: { id: '42' } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await revokeApiKey(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'revoke backend failed' })
  })

  it('returns 403 for unauthorized admin API mutation requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const { setApiState, createApiKey, revokeApiKey } = loadHandlers()
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await setApiState({ user: { permissions: [] }, body: { enabled: true } }, res)
    await createApiKey({ user: { permissions: [] }, body: { name: 'Deploy', expiration: '1y', fullAccess: true, group: null } }, res)
    await revokeApiKey({ user: { permissions: [] }, params: { id: '42' } }, res)

    expect(res.status).toHaveBeenCalledTimes(3)
    expect(res.status).toHaveBeenNthCalledWith(1, 403)
    expect(res.status).toHaveBeenNthCalledWith(2, 403)
    expect(res.status).toHaveBeenNthCalledWith(3, 403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system or manage:api is required' })
  })

  it('regenerates certificates for manage:system users', async () => {
    const { regenerateCertificates } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await regenerateCertificates(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:system'] }, ['manage:system'])
    expect(global.WIKI.auth.regenerateCertificates).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ message: 'Certificates have been regenerated successfully.' })
  })

  it('rejects certificate regeneration for manage:api-only users', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { regenerateCertificates } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await regenerateCertificates(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system is required' })
    expect(global.WIKI.auth.regenerateCertificates).not.toHaveBeenCalled()
  })

  it('returns JSON error messages for certificate regeneration failures', async () => {
    global.WIKI.auth.regenerateCertificates.mockRejectedValueOnce(new Error('cert regen failed'))
    const { regenerateCertificates } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await regenerateCertificates(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'cert regen failed' })
  })

  it('resets the guest user for manage:system users', async () => {
    const { resetGuestUser } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await resetGuestUser(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:system'] }, ['manage:system'])
    expect(global.WIKI.auth.resetGuestUser).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ message: 'Guest user has been reset successfully.' })
  })

  it('rejects guest user reset for manage:api-only users', async () => {
    global.WIKI.auth.checkAccess.mockReturnValueOnce(false)
    const { resetGuestUser } = loadHandlers()
    const req = { user: { permissions: ['manage:api'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await resetGuestUser(req, res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'manage:system is required' })
    expect(global.WIKI.auth.resetGuestUser).not.toHaveBeenCalled()
  })

  it('returns JSON error messages for guest user reset failures', async () => {
    global.WIKI.auth.resetGuestUser.mockRejectedValueOnce(new Error('guest reset failed'))
    const { resetGuestUser } = loadHandlers()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await resetGuestUser(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'guest reset failed' })
  })

  it('does not expose internal configuration or admin-only auth metadata', async () => {
    const { strategies } = loadHandlers()
    const res = { json: jest.fn() }

    await strategies({}, res, jest.fn())

    const payload = res.json.mock.calls[0][0][0]
    expect(payload.strategyKey).toBeUndefined()
    expect(payload.isEnabled).toBeUndefined()
    expect(payload.config).toBeUndefined()
    expect(payload.domainWhitelist).toBeUndefined()
    expect(payload.autoEnrollGroups).toBeUndefined()
    expect(payload.strategy.props).toBeUndefined()
  })

  it('forwards unexpected failures from strategy loading to next', async () => {
    global.WIKI.models.authentication.getStrategies.mockRejectedValueOnce(new Error('db failed'))
    const { strategies } = loadHandlers()
    const next = jest.fn()
    const res = { json: jest.fn() }

    await strategies({}, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('db failed')
  })

  it('returns a generic success payload for forgot-password requests', async () => {
    const { forgotPassword } = loadHandlers()
    const req = {
      body: { email: 'alice@example.com' },
      brute: { reset: jest.fn() }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await forgotPassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginForgotPassword).toHaveBeenCalledWith({
      email: 'alice@example.com'
    }, { req, res })
    expect(req.brute.reset).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Password reset request processed.' })
  })

  it('rejects missing forgot-password input with 400', async () => {
    const { forgotPassword } = loadHandlers()
    const req = {
      body: { email: '' },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await forgotPassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginForgotPassword).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'email is required' })
  })

  it('rejects malformed forgot-password input with 400', async () => {
    const { forgotPassword } = loadHandlers()
    const req = {
      body: { email: { nested: true } },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await forgotPassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginForgotPassword).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'email must be a string' })
  })

  it('forwards unexpected forgot-password failures to next', async () => {
    global.WIKI.models.users.loginForgotPassword.mockRejectedValueOnce(new Error('mail failed'))
    const { forgotPassword } = loadHandlers()
    const req = {
      body: { email: 'alice@example.com' },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()

    await forgotPassword(req, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('mail failed')
  })

  it('rejects non-form auth strategies for REST login', async () => {
    const { login } = loadHandlers()
    const req = { body: { strategy: 'github', username: 'octo', password: 'secret' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await login(req, res, jest.fn())

    expect(global.WIKI.models.users.login).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'REST login only supports form-based strategies' })
  })

  it('rejects disabled form strategies for REST login', async () => {
    const { login } = loadHandlers()
    const req = { body: { strategy: 'disabledlocal', username: 'alice@example.com', password: 'secret' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await login(req, res, jest.fn())

    expect(global.WIKI.models.users.login).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication strategy is disabled' })
  })

  it('returns the login continuation payload for successful REST login and resets brute-force state', async () => {
    global.WIKI.models.users.login.mockResolvedValueOnce({
      mustProvideTFA: true,
      continuationToken: 'tfa-token',
      redirect: '/admin'
    })
    const { login } = loadHandlers()
    const req = {
      body: { strategy: 'local', username: 'alice@example.com', password: 'secret' },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }

    await login(req, res, jest.fn())

    expect(global.WIKI.models.users.login).toHaveBeenCalledWith({
      strategy: 'local',
      username: 'alice@example.com',
      password: 'secret'
    }, { req, res })
    expect(req.brute.reset).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({
      jwt: null,
      mustChangePwd: false,
      mustProvideTFA: true,
      mustSetupTFA: false,
      continuationToken: 'tfa-token',
      redirect: '/admin',
      tfaQRImage: null
    })
  })

  it('rejects malformed form-auth input with 400', async () => {
    const { login } = loadHandlers()
    const req = {
      body: { strategy: 'local', username: { nested: true }, password: ['bad'] },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await login(req, res, jest.fn())

    expect(global.WIKI.models.users.login).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'username and password must be strings' })
  })

  it('forwards login failures to next', async () => {
    global.WIKI.models.users.login.mockRejectedValueOnce(new Error('login failed'))
    const { login } = loadHandlers()
    const req = {
      body: { strategy: 'local', username: 'alice@example.com', password: 'secret' },
      login: jest.fn(),
      logIn: jest.fn()
    }
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() }
    const next = jest.fn()

    await login(req, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('login failed')
  })

  it('rejects missing TFA continuation fields with 400', async () => {
    const { loginTFA } = loadHandlers()
    const req = { body: { securityCode: '', continuationToken: '' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await loginTFA(req, res, jest.fn())

    expect(global.WIKI.models.users.loginTFA).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'securityCode and continuationToken are required' })
  })

  it('returns the login TFA continuation payload and resets brute-force state', async () => {
    global.WIKI.models.users.loginTFA.mockResolvedValueOnce({
      jwt: 'jwt-token',
      redirect: '/'
    })
    const { loginTFA } = loadHandlers()
    const req = {
      body: { securityCode: '123456', continuationToken: 'tfa-token', setup: false },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const res = { json: jest.fn() }

    await loginTFA(req, res, jest.fn())

    expect(global.WIKI.models.users.loginTFA).toHaveBeenCalledWith({
      securityCode: '123456',
      continuationToken: 'tfa-token',
      setup: false
    }, { req, res })
    expect(req.brute.reset).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({
      jwt: 'jwt-token',
      mustChangePwd: false,
      mustProvideTFA: false,
      mustSetupTFA: false,
      continuationToken: null,
      redirect: '/',
      tfaQRImage: null
    })
  })

  it('rejects malformed TFA input with 400', async () => {
    const { loginTFA } = loadHandlers()
    const req = {
      body: { securityCode: 123456, continuationToken: { bad: true }, setup: 'false' },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await loginTFA(req, res, jest.fn())

    expect(global.WIKI.models.users.loginTFA).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'securityCode and continuationToken must be strings' })
  })

  it('rejects missing change-password fields with 400', async () => {
    const { loginChangePassword } = loadHandlers()
    const req = { body: { continuationToken: '', newPassword: '' } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await loginChangePassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginChangePassword).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'continuationToken and newPassword are required' })
  })

  it('returns the change-password continuation payload and resets brute-force state', async () => {
    global.WIKI.models.users.loginChangePassword.mockResolvedValueOnce({
      jwt: 'jwt-token'
    })
    const { loginChangePassword } = loadHandlers()
    const req = {
      body: { continuationToken: 'pwd-token', newPassword: 'new-secret' },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const res = { json: jest.fn() }

    await loginChangePassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginChangePassword).toHaveBeenCalledWith({
      continuationToken: 'pwd-token',
      newPassword: 'new-secret'
    }, { req, res })
    expect(req.brute.reset).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({
      jwt: 'jwt-token',
      mustChangePwd: false,
      mustProvideTFA: false,
      mustSetupTFA: false,
      continuationToken: null,
      redirect: null,
      tfaQRImage: null
    })
  })

  it('rejects malformed change-password input with 400', async () => {
    const { loginChangePassword } = loadHandlers()
    const req = {
      body: { continuationToken: { bad: true }, newPassword: ['short'] },
      brute: { reset: jest.fn() }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await loginChangePassword(req, res, jest.fn())

    expect(global.WIKI.models.users.loginChangePassword).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'continuationToken and newPassword must be strings' })
  })

  it('maps expected auth errors to client-safe status codes', async () => {
    global.WIKI.models.users.login.mockRejectedValueOnce({ message: 'Invalid email / username or password.', code: 1002 })
    global.WIKI.models.users.loginTFA.mockRejectedValueOnce({ message: 'Invalid TFA Security Code or Login Token.', code: 1006 })
    global.WIKI.models.users.loginChangePassword.mockRejectedValueOnce({ message: 'Password must be at least 6 characters!', code: 1012 })
    global.WIKI.models.users.loginTFA.mockRejectedValueOnce({ message: 'Invalid validation token.', code: 1015 })
    global.WIKI.models.users.loginChangePassword.mockRejectedValueOnce({ message: 'This user does not exist.', code: 1016 })
    const { login, loginTFA, loginChangePassword } = loadHandlers()

    const loginReq = {
      body: { strategy: 'local', username: 'alice@example.com', password: 'bad' },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const tfaReq = {
      body: { securityCode: '123456', continuationToken: 'bad-token', setup: false },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const changeReq = {
      body: { continuationToken: 'pwd-token', newPassword: 'short' },
      login: jest.fn(),
      logIn: jest.fn(),
      brute: { reset: jest.fn() }
    }
    const loginRes = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const tfaRes = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const changeRes = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await login(loginReq, loginRes, jest.fn())
    await loginTFA(tfaReq, tfaRes, jest.fn())
    await loginChangePassword(changeReq, changeRes, jest.fn())

    expect(loginRes.status).toHaveBeenCalledWith(401)
    expect(loginRes.json).toHaveBeenCalledWith({ error: 'Invalid email / username or password.' })
    expect(tfaRes.status).toHaveBeenCalledWith(401)
    expect(tfaRes.json).toHaveBeenCalledWith({ error: 'Invalid TFA Security Code or Login Token.' })
    expect(changeRes.status).toHaveBeenCalledWith(400)
    expect(changeRes.json).toHaveBeenCalledWith({ error: 'Password must be at least 6 characters!' })

    const invalidTokenRes = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const missingUserRes = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    await loginTFA(tfaReq, invalidTokenRes, jest.fn())
    await loginChangePassword(changeReq, missingUserRes, jest.fn())

    expect(invalidTokenRes.status).toHaveBeenCalledWith(401)
    expect(invalidTokenRes.json).toHaveBeenCalledWith({ error: 'Invalid validation token.' })
    expect(missingUserRes.status).toHaveBeenCalledWith(401)
    expect(missingUserRes.json).toHaveBeenCalledWith({ error: 'This user does not exist.' })
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.models.users.login.mockRejectedValueOnce(new Error('unexpected login failure'))
    const { login } = loadHandlers()
    const req = {
      body: { strategy: 'local', username: 'alice@example.com', password: 'secret' },
      login: jest.fn(),
      logIn: jest.fn()
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const next = jest.fn()

    await login(req, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('unexpected login failure')
  })
})
