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

    global.WIKI = {
      data: {
        authentication: [
          {
            key: 'local',
            title: 'Local',
            useForm: true,
            props: {
              usernameFormat: { type: 'string', default: 'email' }
            }
          },
          {
            key: 'github',
            title: 'GitHub',
            useForm: false,
            props: {
              clientId: { type: 'string', default: '' }
            }
          }
        ]
      },
      models: {
        authentication: {
          getStrategies: jest.fn().mockResolvedValue([
            {
              key: 'local',
              strategyKey: 'local',
              displayName: 'Local Login',
              order: 1,
              isEnabled: true,
              config: {
                usernameFormat: 'email'
              }
            },
            {
              key: 'github',
              strategyKey: 'github',
              displayName: 'GitHub Login',
              order: 2,
              isEnabled: false,
              config: {
                clientId: 'abc123'
              }
            }
          ])
        }
      }
    }
  })

  const loadHandler = () => {
    const express = require('express')
    require('../../controllers/api/auth')
    return express.__router.get.mock.calls.find(([path]) => path === '/strategies')[1]
  }

  it('registers the auth strategies route', () => {
    const handler = loadHandler()

    expect(typeof handler).toBe('function')
  })

  it('returns only enabled authentication strategies with the public login-safe payload', async () => {
    const handler = loadHandler()
    const res = { json: jest.fn() }

    await handler({}, res, jest.fn())

    expect(global.WIKI.models.authentication.getStrategies).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith([
      {
        key: 'local',
        displayName: 'Local Login',
        order: 1,
        selfRegistration: undefined,
        strategy: {
          key: 'local',
          title: 'Local',
          logo: undefined,
          color: undefined,
          icon: undefined,
          useForm: true,
          usernameType: undefined
        }
      }
    ])
  })

  it('does not expose internal configuration or admin-only auth metadata', async () => {
    const handler = loadHandler()
    const res = { json: jest.fn() }

    await handler({}, res, jest.fn())

    const payload = res.json.mock.calls[0][0][0]
    expect(payload.strategyKey).toBeUndefined()
    expect(payload.isEnabled).toBeUndefined()
    expect(payload.config).toBeUndefined()
    expect(payload.domainWhitelist).toBeUndefined()
    expect(payload.autoEnrollGroups).toBeUndefined()
    expect(payload.strategy.props).toBeUndefined()
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.models.authentication.getStrategies.mockRejectedValueOnce(new Error('db failed'))
    const handler = loadHandler()
    const next = jest.fn()
    const res = { json: jest.fn() }

    await handler({}, res, next)

    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(next.mock.calls[0][0].message).toBe('db failed')
  })
})
