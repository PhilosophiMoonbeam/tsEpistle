jest.mock('express', () => {
  const routers = []

  return {
    Router: () => {
      const router = {
        get: jest.fn(),
        post: jest.fn(),
        patch: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
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
          query: jest.fn(),
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
      },
      cache: {
        del: jest.fn().mockResolvedValue(true)
      }
    }

    global.WIKI.models.analytics.query.mockImplementation(() => {
      const query = {
        patch: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(1)
      }
      global.WIKI.models.analytics.__queries = global.WIKI.models.analytics.__queries || []
      global.WIKI.models.analytics.__queries.push(query)
      return query
    })
  })

  const loadHandlers = () => {
    const express = require('express')
    require('../../controllers/api/analytics')
    const router = express.__routers[0]
    return {
      providers: router.get.mock.calls.find(([path]) => path === '/providers')[1],
      saveProviders: router.post.mock.calls.find(([path]) => path === '/providers')[1]
    }
  }

  const loadProvidersHandler = () => loadHandlers().providers

  it('registers analytics provider routes', () => {
    const handlers = loadHandlers()

    expect(typeof handlers.providers).toBe('function')
    expect(typeof handlers.saveProviders).toBe('function')
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

  const createSavePayload = () => ({
    body: {
      providers: [
        {
          key: 'google',
          isEnabled: true,
          config: [
            { key: 'trackingId', value: JSON.stringify({ v: 'UA-123' }) },
            { key: 'missingValue', value: JSON.stringify({ label: 'No value key' }) }
          ]
        },
        {
          key: 'matomo',
          isEnabled: false,
          config: [
            { key: 'siteId', value: JSON.stringify({ v: '2' }) }
          ]
        }
      ]
    },
    user: { permissions: ['manage:system'] }
  })

  it('returns JSON 403 for unauthorized provider saves without mutating models', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const { saveProviders } = loadHandlers()
    const req = createSavePayload()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await saveProviders(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(global.WIKI.models.analytics.query).not.toHaveBeenCalled()
    expect(global.WIKI.cache.del).not.toHaveBeenCalled()
  })

  it('saves providers with GraphQL parity and invalidates analytics cache per provider', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveProviders } = loadHandlers()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await saveProviders(createSavePayload(), res)

    const queries = global.WIKI.models.analytics.__queries
    expect(queries).toHaveLength(2)
    expect(queries[0].patch).toHaveBeenCalledWith({
      isEnabled: true,
      config: {
        trackingId: 'UA-123',
        missingValue: null
      }
    })
    expect(queries[0].where).toHaveBeenCalledWith('key', 'google')
    expect(queries[1].patch).toHaveBeenCalledWith({
      isEnabled: false,
      config: {
        siteId: '2'
      }
    })
    expect(queries[1].where).toHaveBeenCalledWith('key', 'matomo')
    expect(global.WIKI.cache.del).toHaveBeenCalledTimes(2)
    expect(global.WIKI.cache.del).toHaveBeenNthCalledWith(1, 'analytics')
    expect(global.WIKI.cache.del).toHaveBeenNthCalledWith(2, 'analytics')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Providers updated successfully' })
  })

  it('returns JSON 400 for malformed provider save payloads', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveProviders } = loadHandlers()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await saveProviders({ body: { providers: [{ key: 'google', isEnabled: 'yes', config: [] }] }, user: {} }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid analytics providers payload' })
    expect(global.WIKI.models.analytics.query).not.toHaveBeenCalled()
    expect(global.WIKI.cache.del).not.toHaveBeenCalled()
  })

  it('returns JSON 400 for malformed provider save config JSON', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveProviders } = loadHandlers()
    const req = createSavePayload()
    req.body.providers[0].config[0].value = '{not-json'
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await saveProviders(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid analytics providers payload' })
    expect(global.WIKI.cache.del).not.toHaveBeenCalled()
  })

  it('returns JSON 500 for unexpected provider save failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const query = {
      patch: jest.fn().mockReturnThis(),
      where: jest.fn().mockRejectedValue(new Error('provider save failed'))
    }
    global.WIKI.models.analytics.query.mockReturnValue(query)
    const { saveProviders } = loadHandlers()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await saveProviders(createSavePayload(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'provider save failed' })
    expect(global.WIKI.cache.del).not.toHaveBeenCalled()
  })

  it('returns JSON 500 for analytics cache invalidation failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.cache.del.mockRejectedValueOnce(new Error('cache failed'))
    const { saveProviders } = loadHandlers()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await saveProviders(createSavePayload(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'cache failed' })
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
