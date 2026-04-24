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

describe('controllers/api analytics endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: jest.fn()
      },
      data: {
        analytics: [
          {
            key: 'google',
            title: 'Google Analytics',
            description: 'Google analytics provider.',
            isAvailable: true,
            logo: '/google.svg',
            website: 'https://analytics.google.com',
            props: {
              trackingId: {
                type: 'string',
                title: 'Tracking ID',
                order: 2,
                privateMetadata: 'allowed metadata field'
              },
              anonymizeIp: {
                type: 'boolean',
                title: 'Anonymize IP',
                order: 1
              },
              unusedField: {
                type: 'string',
                title: 'Unused Field'
              }
            },
            unrelatedMetadata: 'do-not-return'
          }
        ]
      },
      models: {
        analytics: {
          getProviders: jest.fn().mockResolvedValue([
            {
              key: 'google',
              isEnabled: true,
              config: {
                trackingId: 'example-tracking-id',
                anonymizeIp: false
              },
              privateField: 'do-not-return',
              props: {
                raw: true
              },
              internalConfig: {
                raw: 'do-not-return'
              }
            }
          ])
        }
      }
    }
  })

  const loadProvidersHandler = () => {
    const express = require('express')
    require('../../controllers/api/analytics')
    const router = express.__routers[0]
    return router.get.mock.calls.find(([path]) => path === '/providers')[1]
  }

  it('registers analytics provider route', () => {
    const handler = loadProvidersHandler()

    expect(typeof handler).toBe('function')
  })

  it('is mounted by the API index router', () => {
    const express = require('express')
    expect(() => require('../../controllers/api')).not.toThrow()
    const apiRouter = express.__routers[0]

    expect(apiRouter.use).toHaveBeenCalledWith('/analytics', expect.any(Object))
  })

  it('returns 403 for unauthorized provider requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = loadProvidersHandler()
    const req = { user: { permissions: [] }, query: {} }
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.models.analytics.getProviders).not.toHaveBeenCalled()
  })

  it('loads providers without an isEnabled query filter by default', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadProvidersHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler(req, res, jest.fn())

    expect(global.WIKI.models.analytics.getProviders).toHaveBeenCalledWith(undefined)
    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledTimes(1)
  })

  it('returns allowlisted provider fields without raw props, private fields, or unrelated fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadProvidersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: {}, query: {} }, res, jest.fn())

    expect(res.json).toHaveBeenCalledWith([
      {
        isEnabled: true,
        key: 'google',
        title: 'Google Analytics',
        description: 'Google analytics provider.',
        isAvailable: true,
        logo: '/google.svg',
        website: 'https://analytics.google.com',
        config: expect.any(Array)
      }
    ])
    const row = res.json.mock.calls[0][0][0]
    expect(row).not.toHaveProperty('props')
    expect(row).not.toHaveProperty('privateField')
    expect(row).not.toHaveProperty('internalConfig')
    expect(row).not.toHaveProperty('unrelatedMetadata')
  })

  it('merges config with provider metadata as JSON strings sorted by config key', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadProvidersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: {}, query: {} }, res, jest.fn())

    const config = res.json.mock.calls[0][0][0].config
    expect(config.map(row => row.key)).toEqual(['anonymizeIp', 'trackingId'])
    expect(config).toEqual([
      {
        key: 'anonymizeIp',
        value: JSON.stringify({
          type: 'boolean',
          title: 'Anonymize IP',
          order: 1,
          value: false
        })
      },
      {
        key: 'trackingId',
        value: JSON.stringify({
          type: 'string',
          title: 'Tracking ID',
          order: 2,
          privateMetadata: 'allowed metadata field',
          value: 'example-tracking-id'
        })
      }
    ])
  })

  it('converts only literal true and false isEnabled query values to booleans', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadProvidersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: {}, query: { isEnabled: 'true' } }, res, jest.fn())
    await handler({ user: {}, query: { isEnabled: 'false' } }, res, jest.fn())
    await handler({ user: {}, query: { isEnabled: '1' } }, res, jest.fn())
    await handler({ user: {}, query: { isEnabled: true } }, res, jest.fn())

    expect(global.WIKI.models.analytics.getProviders).toHaveBeenNthCalledWith(1, true)
    expect(global.WIKI.models.analytics.getProviders).toHaveBeenNthCalledWith(2, false)
    expect(global.WIKI.models.analytics.getProviders).toHaveBeenNthCalledWith(3, undefined)
    expect(global.WIKI.models.analytics.getProviders).toHaveBeenNthCalledWith(4, undefined)
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const err = new Error('analytics failed')
    global.WIKI.models.analytics.getProviders.mockRejectedValue(err)
    const handler = loadProvidersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }
    const next = jest.fn()

    await handler({ user: {}, query: {} }, res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })
})
