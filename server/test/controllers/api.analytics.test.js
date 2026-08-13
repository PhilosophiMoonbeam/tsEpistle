vi.mock('express', () => {
  const routers = []
  const express = {
    Router: () => {
      const router = {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        use: vi.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }

  return { default: express, ...express }
})

import express from 'express'

const API_CONTROLLER_NAMES = [
  'analytics',
  'assets',
  'auth',
  'comments',
  'contribute',
  'groups',
  'locales',
  'logging',
  'mail',
  'navigation',
  'pages',
  'rendering',
  'search',
  'site',
  'storage',
  'system',
  'theming',
  'users'
]

const loadApiIndexRouter = async () => {
  const subrouters = Object.fromEntries(API_CONTROLLER_NAMES.map(name => [name, {}]))

  for (const name of API_CONTROLLER_NAMES) {
    vi.doMock(`../../controllers/api/${name}.ts`, () => ({
      default: subrouters[name]
    }))
  }

  try {
    await expect(import('../../controllers/api/index.ts')).resolves.toBeDefined()
  } finally {
    for (const name of API_CONTROLLER_NAMES) {
      vi.doUnmock(`../../controllers/api/${name}.ts`)
    }
  }

  return { apiRouter: express.__routers.at(-1), subrouters }
}

describe('controllers/api analytics endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: vi.fn()
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
          query: vi.fn(),
          getProviders: vi.fn().mockResolvedValue([
            {
              key: 'google',
              isEnabled: 1,
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
        del: vi.fn().mockResolvedValue(true)
      }
    }

    global.WIKI.models.analytics.query.mockImplementation(() => {
      const query = {
        patch: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(1)
      }
      global.WIKI.models.analytics.__queries = global.WIKI.models.analytics.__queries || []
      global.WIKI.models.analytics.__queries.push(query)
      return query
    })
  })

  const loadHandlers = async () => {
    await import('../../controllers/api/analytics.ts')
    const router = express.__routers[0]
    return {
      providers: router.get.mock.calls.find(([path]) => path === '/providers')[1],
      saveProviders: router.post.mock.calls.find(([path]) => path === '/providers')[1]
    }
  }

  const loadProvidersHandler = async () => (await loadHandlers()).providers

  it('registers analytics provider routes', async () => { const handlers = await loadHandlers()

  expect(typeof handlers.providers).toBe('function')
  expect(typeof handlers.saveProviders).toBe('function') })

  it('is mounted by the API index router', async () => {
    const { apiRouter, subrouters } = await loadApiIndexRouter()

    expect(apiRouter.use).toHaveBeenCalledWith('/analytics', subrouters.analytics)
  })

  it('returns 403 for unauthorized provider requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadProvidersHandler()
    const req = { user: { permissions: [] }, query: {} }
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.models.analytics.getProviders).not.toHaveBeenCalled()
  })

  it('loads providers without an isEnabled query filter by default', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadProvidersHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.models.analytics.getProviders).toHaveBeenCalledWith(undefined)
    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledTimes(1)
  })

  it('returns allowlisted provider fields without raw props, private fields, or unrelated fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadProvidersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {}, query: {} }, res, vi.fn())

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

  it('reads provider definitions after the operation module is loaded', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadProvidersHandler()
    global.WIKI.data.analytics = global.WIKI.data.analytics.map(provider => ({
      ...provider,
      title: 'Runtime Analytics'
    }))
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {}, query: {} }, res, vi.fn())

    expect(res.json.mock.calls[0][0][0].title).toBe('Runtime Analytics')
  })

  it('merges config with provider metadata as JSON strings sorted by config key', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadProvidersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {}, query: {} }, res, vi.fn())

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
    const handler = await loadProvidersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {}, query: { isEnabled: 'true' } }, res, vi.fn())
    await handler({ user: {}, query: { isEnabled: 'false' } }, res, vi.fn())
    await handler({ user: {}, query: { isEnabled: '1' } }, res, vi.fn())
    await handler({ user: {}, query: { isEnabled: true } }, res, vi.fn())

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
    const { saveProviders } = await loadHandlers()
    const req = createSavePayload()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveProviders(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(global.WIKI.models.analytics.query).not.toHaveBeenCalled()
    expect(global.WIKI.cache.del).not.toHaveBeenCalled()
  })

  it('saves providers with GraphQL parity and invalidates analytics cache per provider', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveProviders } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

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
    const { saveProviders } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveProviders({ body: { providers: [{ key: 'google', isEnabled: 'yes', config: [] }] }, user: {} }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid analytics providers payload' })
    expect(global.WIKI.models.analytics.query).not.toHaveBeenCalled()
    expect(global.WIKI.cache.del).not.toHaveBeenCalled()
  })

  it('returns JSON 400 for malformed provider save config JSON', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveProviders } = await loadHandlers()
    const req = createSavePayload()
    req.body.providers[0].config[0].value = '{not-json'
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveProviders(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid analytics providers payload' })
    expect(global.WIKI.cache.del).not.toHaveBeenCalled()
  })

  it('returns JSON 500 for unexpected provider save failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const query = {
      patch: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(new Error('provider save failed'))
    }
    global.WIKI.models.analytics.query.mockReturnValue(query)
    const { saveProviders } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveProviders(createSavePayload(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'provider save failed' })
    expect(global.WIKI.cache.del).not.toHaveBeenCalled()
  })

  it('returns JSON 500 for analytics cache invalidation failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.cache.del.mockRejectedValueOnce(new Error('cache failed'))
    const { saveProviders } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveProviders(createSavePayload(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'cache failed' })
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const err = new Error('analytics failed')
    global.WIKI.models.analytics.getProviders.mockRejectedValue(err)
    const handler = await loadProvidersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }
    const next = vi.fn()

    await handler({ user: {}, query: {} }, res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })
})
