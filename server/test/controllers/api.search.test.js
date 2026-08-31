vi.mockModule('express', import.meta.url, () => {
  const routers = []

  const expressMock = {
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

  return { default: expressMock, ...expressMock }
})

const express = await import('express')

describe('controllers/api search endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: vi.fn()
      },
      data: {
        searchEngine: {
          key: 'beta',
          rebuild: vi.fn().mockResolvedValue(true),
          deactivate: vi.fn().mockResolvedValue(true)
        },
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
          query: vi.fn(),
          initEngine: vi.fn().mockResolvedValue(true),
          getSearchEngines: vi.fn().mockResolvedValue([
            {
              key: 'beta',
              isEnabled: 1,
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
              isEnabled: 0,
              config: {
                indexName: 'docs-index'
              },
              privateField: 'do-not-return'
            }
          ])
        }
      },
      logger: {
        warn: vi.fn()
      }
    }

    global.WIKI.models.searchEngines.query.mockImplementation(() => {
      const query = {
        patch: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(1)
      }
      global.WIKI.models.searchEngines.__lastQuery = query
      global.WIKI.models.searchEngines.__queries = global.WIKI.models.searchEngines.__queries || []
      global.WIKI.models.searchEngines.__queries.push(query)
      return query
    })
  })

  const loadHandlers = async () => {
    await vi.importFresh('../../controllers/api/search.ts', import.meta.url)
    const router = express.__routers[0]
    return {
      engines: router.get.mock.calls.find(([path]) => path === '/engines')[1],
      saveEngines: router.post.mock.calls.find(([path]) => path === '/engines')[1],
      rebuildIndex: router.post.mock.calls.find(([path]) => path === '/rebuild-index')[1]
    }
  }

  const loadEnginesHandler = async () => (await loadHandlers()).engines

  it('registers search routes', async () => {
    const handlers = await loadHandlers()

    expect(typeof handlers.engines).toBe('function')
    expect(typeof handlers.saveEngines).toBe('function')
    expect(typeof handlers.rebuildIndex).toBe('function')
  })


  it('returns 403 for unauthorized engine requests without loading models', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadEnginesHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.models.searchEngines.getSearchEngines).not.toHaveBeenCalled()
  })

  it('loads search engines for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadEnginesHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: { permissions: ['manage:system'] } }, res, vi.fn())

    expect(global.WIKI.models.searchEngines.getSearchEngines).toHaveBeenCalledTimes(1)
    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledTimes(1)
  })

  it('returns engines sorted by title with only allowlisted top-level fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadEnginesHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

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

  it('reads search engine definitions after the operation module is loaded', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadEnginesHandler()
    global.WIKI.data.searchEngines = global.WIKI.data.searchEngines.map(engine => ({
      ...engine,
      title: `Runtime ${engine.key}`
    }))
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

    expect(res.json.mock.calls[0][0].map(engine => engine.title)).toEqual(['Runtime alpha', 'Runtime beta'])
  })

  it('serializes only declared config metadata and persisted values as JSON strings sorted by config key', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadEnginesHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

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
    const handler = await loadEnginesHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }
    const next = vi.fn()

    await handler({ user: {} }, res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })

  const createSavePayload = () => ({
    body: {
      engines: [
        {
          key: 'alpha',
          isEnabled: true,
          config: [
            { key: 'endpoint', value: JSON.stringify({ v: 'https://example.test/alpha' }) },
            { key: 'missingValue', value: JSON.stringify({ label: 'No value key' }) }
          ]
        },
        {
          key: 'beta',
          isEnabled: false,
          config: [
            { key: 'enabledFlag', value: JSON.stringify({ v: false }) }
          ]
        }
      ]
    },
    user: { permissions: ['manage:system'] }
  })

  it('returns JSON 403 for unauthorized engine saves without mutating models', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const { saveEngines } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines(createSavePayload(), res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith({ permissions: ['manage:system'] }, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(global.WIKI.models.searchEngines.query).not.toHaveBeenCalled()
    expect(global.WIKI.data.searchEngine.deactivate).not.toHaveBeenCalled()
    expect(global.WIKI.models.searchEngines.initEngine).not.toHaveBeenCalled()
  })

  it('saves search engines with GraphQL parity and activates the selected engine', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveEngines } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines(createSavePayload(), res)

    const queries = global.WIKI.models.searchEngines.__queries
    expect(queries).toHaveLength(2)
    expect(queries[0].patch).toHaveBeenCalledWith({
      isEnabled: true,
      config: {
        endpoint: 'https://example.test/alpha',
        missingValue: null
      }
    })
    expect(queries[0].where).toHaveBeenCalledWith('key', 'alpha')
    expect(queries[1].patch).toHaveBeenCalledWith({
      isEnabled: false,
      config: {
        enabledFlag: false
      }
    })
    expect(queries[1].where).toHaveBeenCalledWith('key', 'beta')
    expect(global.WIKI.data.searchEngine.deactivate).toHaveBeenCalledTimes(1)
    expect(global.WIKI.models.searchEngines.initEngine).toHaveBeenCalledWith({ activate: true })
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Search Engines updated successfully' })
  })

  it('does not deactivate the current search engine when the selected engine is unchanged', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveEngines } = await loadHandlers()
    const req = createSavePayload()
    req.body.engines[0].isEnabled = false
    req.body.engines[1].isEnabled = true
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines(req, res)

    expect(global.WIKI.data.searchEngine.deactivate).not.toHaveBeenCalled()
    expect(global.WIKI.models.searchEngines.initEngine).toHaveBeenCalledWith({ activate: true })
    expect(res.json).toHaveBeenCalledWith({ message: 'Search Engines updated successfully' })
  })

  it('logs and continues when previous search engine deactivation fails', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const deactivateError = new Error('deactivate failed')
    global.WIKI.data.searchEngine.deactivate.mockRejectedValueOnce(deactivateError)
    const { saveEngines } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines(createSavePayload(), res)

    expect(global.WIKI.logger.warn).toHaveBeenCalledWith('Failed to deactivate previous search engine:', deactivateError)
    expect(global.WIKI.models.searchEngines.initEngine).toHaveBeenCalledWith({ activate: true })
    expect(res.json).toHaveBeenCalledWith({ message: 'Search Engines updated successfully' })
  })

  it('returns JSON 400 for malformed engine save payloads', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveEngines } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines({ body: { engines: [{ key: 'alpha', isEnabled: 'yes', config: [] }] }, user: {} }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid search engines payload' })
    expect(global.WIKI.models.searchEngines.query).not.toHaveBeenCalled()
    expect(global.WIKI.models.searchEngines.initEngine).not.toHaveBeenCalled()
  })

  it('returns JSON 400 for malformed engine save config JSON', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveEngines } = await loadHandlers()
    const req = createSavePayload()
    req.body.engines[0].config[0].value = '{not-json'
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid search engines payload' })
    expect(global.WIKI.models.searchEngines.initEngine).not.toHaveBeenCalled()
  })

  it('returns JSON 500 for unexpected engine save failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const query = {
      patch: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(new Error('save failed'))
    }
    global.WIKI.models.searchEngines.query.mockReturnValue(query)
    const { saveEngines } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines(createSavePayload(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'save failed' })
    expect(global.WIKI.models.searchEngines.initEngine).not.toHaveBeenCalled()
  })

  it('returns 403 for unauthorized rebuild requests without rebuilding', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const { rebuildIndex } = await loadHandlers()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await rebuildIndex(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.data.searchEngine.rebuild).not.toHaveBeenCalled()
  })

  it('rebuilds the search index for authorized requests', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { rebuildIndex } = await loadHandlers()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await rebuildIndex({ user: { permissions: ['manage:system'] } }, res)

    expect(global.WIKI.data.searchEngine.rebuild).toHaveBeenCalledTimes(1)
    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Index rebuilt successfully' })
  })

  it('returns JSON error messages for search index rebuild failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.data.searchEngine.rebuild.mockRejectedValueOnce(new Error('index failed'))
    const { rebuildIndex } = await loadHandlers()
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await rebuildIndex({ user: { permissions: ['manage:system'] } }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'index failed' })
  })
  it('is mounted by the API index router', async () => {
    const modulePaths = [
      '../../controllers/api/analytics.ts',
      '../../controllers/api/assets.ts',
      '../../controllers/api/auth.ts',
      '../../controllers/api/comments.ts',
      '../../controllers/api/content-extensions.ts',
      '../../controllers/api/groups.ts',
      '../../controllers/api/locales.ts',
      '../../controllers/api/logging.ts',
      '../../controllers/api/mail.ts',
      '../../controllers/api/navigation.ts',
      '../../controllers/api/pages.ts',
      '../../controllers/api/rendering.ts',
      '../../controllers/api/search.ts',
      '../../controllers/api/site.ts',
      '../../controllers/api/storage.ts',
      '../../controllers/api/system.ts',
      '../../controllers/api/theming.ts',
      '../../controllers/api/users.ts',
      '../../controllers/api/webhooks.ts'
    ]
    for (const modulePath of modulePaths) {
      vi.mockModule(modulePath, import.meta.url, () => ({ default: {} }))
    }

    try {
      expect(await vi.importFresh('../../controllers/api/index.ts', import.meta.url)).toBeDefined()
      const apiRouter = express.__routers[0]

      expect(apiRouter.use).toHaveBeenCalledWith('/search', expect.any(Object))
    } finally {
      for (const modulePath of modulePaths) {
        vi.unmockModule(modulePath, import.meta.url)
      }
    }
  })
})
