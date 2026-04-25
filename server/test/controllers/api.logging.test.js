jest.mock('express', () => {
  const routers = []

  return {
    Router: () => {
      const router = {
        get: jest.fn(),
        post: jest.fn(),
        use: jest.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }
})

describe('controllers/api logging endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: jest.fn()
      },
      data: {
        loggers: [
          {
            key: 'alpha',
            title: 'Alpha Logger',
            description: 'Alpha logging provider.',
            logo: '/alpha.svg',
            website: 'https://example.test/alpha-logger',
            props: {
              endpoint: {
                type: 'string',
                title: 'Endpoint',
                order: 2,
                hint: 'Example endpoint label'
              },
              redact: {
                type: 'boolean',
                title: 'Redact Values',
                order: 1
              },
              unusedField: {
                type: 'string',
                title: 'Unused Field'
              }
            },
            unrelatedMetadata: 'do-not-return'
          },
          {
            key: 'beta',
            title: 'Beta Logger',
            description: 'Beta logging provider.',
            logo: '/beta.svg',
            website: 'https://example.test/beta-logger',
            props: {}
          }
        ]
      },
      models: {
        loggers: {
          getLoggers: jest.fn().mockResolvedValue([
            {
              key: 'beta',
              isEnabled: false,
              level: 'warn',
              config: {},
              privateField: 'do-not-return',
              props: {
                raw: true
              }
            },
            {
              key: 'alpha',
              isEnabled: true,
              level: 'info',
              config: {
                endpoint: 'example-endpoint',
                redact: true
              },
              privateField: 'do-not-return',
              internalConfig: {
                raw: 'do-not-return'
              }
            }
          ])
        }
      }
    }
  })

  const loadLoggersHandler = () => {
    const express = require('express')
    require('../../controllers/api/logging')
    const router = express.__routers[0]
    return router.get.mock.calls.find(([path]) => path === '/loggers')[1]
  }

  it('registers logging loggers route', () => {
    const handler = loadLoggersHandler()

    expect(typeof handler).toBe('function')
  })

  it('is mounted by the API index router', () => {
    const express = require('express')
    expect(() => require('../../controllers/api')).not.toThrow()
    const apiRouter = express.__routers[0]

    expect(apiRouter.use).toHaveBeenCalledWith('/logging', expect.any(Object))
  })

  it('returns 403 for unauthorized logger requests without querying loggers', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = loadLoggersHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.models.loggers.getLoggers).not.toHaveBeenCalled()
  })

  it('returns allowlisted logger fields sorted by title without raw props or internal fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadLoggersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: {} }, res, jest.fn())

    expect(global.WIKI.models.loggers.getLoggers).toHaveBeenCalledWith()
    expect(res.json).toHaveBeenCalledWith([
      {
        isEnabled: true,
        key: 'alpha',
        title: 'Alpha Logger',
        description: 'Alpha logging provider.',
        logo: '/alpha.svg',
        website: 'https://example.test/alpha-logger',
        level: 'info',
        config: expect.any(Array)
      },
      {
        isEnabled: false,
        key: 'beta',
        title: 'Beta Logger',
        description: 'Beta logging provider.',
        logo: '/beta.svg',
        website: 'https://example.test/beta-logger',
        level: 'warn',
        config: []
      }
    ])
    const row = res.json.mock.calls[0][0][0]
    expect(row).not.toHaveProperty('props')
    expect(row).not.toHaveProperty('privateField')
    expect(row).not.toHaveProperty('internalConfig')
    expect(row).not.toHaveProperty('unrelatedMetadata')
  })

  it('merges config with logger metadata as JSON strings sorted by config key', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadLoggersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: {} }, res, jest.fn())

    const config = res.json.mock.calls[0][0][0].config
    expect(config.map(row => row.key)).toEqual(['endpoint', 'redact'])
    expect(config).toEqual([
      {
        key: 'endpoint',
        value: JSON.stringify({
          type: 'string',
          title: 'Endpoint',
          order: 2,
          hint: 'Example endpoint label',
          value: 'example-endpoint'
        })
      },
      {
        key: 'redact',
        value: JSON.stringify({
          type: 'boolean',
          title: 'Redact Values',
          order: 1,
          value: true
        })
      }
    ])
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const err = new Error('logging failed')
    global.WIKI.models.loggers.getLoggers.mockRejectedValue(err)
    const handler = loadLoggersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }
    const next = jest.fn()

    await handler({ user: {} }, res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })
})
