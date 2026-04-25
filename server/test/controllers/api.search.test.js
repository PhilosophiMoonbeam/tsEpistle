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

describe('controllers/api search endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: jest.fn()
      },
      data: {
        searchEngines: [
          {
            key: 'beta',
            title: 'Beta Search',
            description: 'Beta search engine.',
            logo: '/beta.svg',
            website: 'https://example.test/beta',
            isAvailable: true,
            props: {
              endpoint: {
                type: 'string',
                title: 'Endpoint',
                order: 2,
                hint: 'Benign test endpoint.'
              },
              enabledFlag: {
                type: 'boolean',
                title: 'Enabled Flag',
                order: 1
              }
            },
            rawMetadata: 'do-not-return'
          },
          {
            key: 'alpha',
            title: 'Alpha Search',
            description: 'Alpha search engine.',
            logo: '/alpha.svg',
            website: 'https://example.test/alpha',
            isAvailable: false,
            props: {
              indexName: {
                type: 'string',
                title: 'Index Name',
                order: 1
              }
            }
          }
        ]
      },
      models: {
        searchEngines: {
          getSearchEngines: jest.fn().mockResolvedValue([
            {
              key: 'beta',
              isEnabled: true,
              config: {
                zUndeclared: 'must-not-return',
                endpoint: 'https://example.test/search',
                enabledFlag: false
              },
              props: {
                raw: true
              },
              privateField: 'do-not-return',
              internalConfig: {
                raw: 'do-not-return'
              }
            },
            {
              key: 'alpha',
              isEnabled: false,
              config: {
                indexName: 'docs-index'
              },
              privateField: 'do-not-return'
            }
          ])
        }
      }
    }
  })

  const loadEnginesHandler = () => {
    const express = require('express')
    require('../../controllers/api/search')
    const router = express.__routers[0]
    return router.get.mock.calls.find(([path]) => path === '/engines')[1]
  }

  it('registers search engines route', () => {
    const handler = loadEnginesHandler()

    expect(typeof handler).toBe('function')
  })

  it('is mounted by the API index router', () => {
    const express = require('express')
    expect(() => require('../../controllers/api')).not.toThrow()
    const apiRouter = express.__routers[0]

    expect(apiRouter.use).toHaveBeenCalledWith('/search', expect.any(Object))
  })

  it('returns 403 for unauthorized engine requests without loading models', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = loadEnginesHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.models.searchEngines.getSearchEngines).not.toHaveBeenCalled()
  })

  it('loads search engines for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadEnginesHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: { permissions: ['manage:system'] } }, res, jest.fn())

    expect(global.WIKI.models.searchEngines.getSearchEngines).toHaveBeenCalledTimes(1)
    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledTimes(1)
  })

  it('returns engines sorted by title with only allowlisted top-level fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadEnginesHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: {} }, res, jest.fn())

    expect(res.json).toHaveBeenCalledWith([
      {
        isEnabled: false,
        key: 'alpha',
        title: 'Alpha Search',
        description: 'Alpha search engine.',
        logo: '/alpha.svg',
        website: 'https://example.test/alpha',
        isAvailable: false,
        config: expect.any(Array)
      },
      {
        isEnabled: true,
        key: 'beta',
        title: 'Beta Search',
        description: 'Beta search engine.',
        logo: '/beta.svg',
        website: 'https://example.test/beta',
        isAvailable: true,
        config: expect.any(Array)
      }
    ])

    for (const row of res.json.mock.calls[0][0]) {
      expect(row).not.toHaveProperty('props')
      expect(row).not.toHaveProperty('privateField')
      expect(row).not.toHaveProperty('internalConfig')
      expect(row).not.toHaveProperty('rawMetadata')
    }
  })

  it('serializes only declared config metadata and persisted values as JSON strings sorted by config key', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadEnginesHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: {} }, res, jest.fn())

    const betaConfig = res.json.mock.calls[0][0].find(row => row.key === 'beta').config
    expect(betaConfig.map(row => row.key)).toEqual(['enabledFlag', 'endpoint'])
    expect(betaConfig).toEqual([
      {
        key: 'enabledFlag',
        value: JSON.stringify({
          type: 'boolean',
          title: 'Enabled Flag',
          order: 1,
          value: false
        })
      },
      {
        key: 'endpoint',
        value: JSON.stringify({
          type: 'string',
          title: 'Endpoint',
          order: 2,
          hint: 'Benign test endpoint.',
          value: 'https://example.test/search'
        })
      }
    ])
    expect(betaConfig.find(row => row.key === 'zUndeclared')).toBeUndefined()
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const err = new Error('search failed')
    global.WIKI.models.searchEngines.getSearchEngines.mockRejectedValue(err)
    const handler = loadEnginesHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }
    const next = jest.fn()

    await handler({ user: {} }, res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })
})
