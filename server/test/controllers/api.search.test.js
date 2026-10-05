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

// Load Express after installing the router mock so each fresh controller uses it.
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
          rebuild: vi.fn().mockResolvedValue(true)
        },
        searchEngines: [
          {
            key: 'postgres',
            props: { dictLanguage: { enum: ['english', 'simple'] } }
          },
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
          configure: vi.fn().mockResolvedValue(undefined),
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

  })

  // Fresh controllers intentionally capture the current mocked WIKI/model boundary.
  const loadHandlers = async () => {
    await vi.importFresh('../../controllers/api/search.ts', import.meta.url)
    const router = express.__routers[0]
    return {
      engines: router.get.mock.calls.find(([path]) => path === '/engines')[1],
      indexStatus: router.get.mock.calls.find(([path]) => path === '/index-status')[1],
      saveEngines: router.post.mock.calls.find(([path]) => path === '/engines')[1],
      rebuildIndex: router.post.mock.calls.find(([path]) => path === '/rebuild-index')[1]
    }
  }

  const loadEnginesHandler = async () => (await loadHandlers()).engines

  it('restricts index inspection and reports unsupported engines without a fabricated status', async () => {
    const { indexStatus } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), set: vi.fn() }
    await indexStatus({ user: {} }, res)
    expect(res.status).toHaveBeenCalledWith(403)
    WIKI.auth.checkAccess.mockReturnValue(true)
    await indexStatus({ user: { permissions: ['manage:system'] } }, res)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.json).toHaveBeenLastCalledWith({ engine: 'beta', inspection: null })
  })

  it('returns an unavailable response when inspection fails without exposing database details', async () => {
    WIKI.auth.checkAccess.mockReturnValue(true)
    WIKI.data.searchEngine.inspectIndex = vi.fn().mockRejectedValue(new Error('internal database connection information'))
    const { indexStatus } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn(), set: vi.fn() }
    await indexStatus({ user: { permissions: ['manage:system'] } }, res)
    expect(res.status).toHaveBeenCalledWith(503)
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('internal database connection information')
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

  it('returns engines sorted by title with only allowlisted top-level fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadEnginesHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledTimes(1)

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
      engines: [{
        key: 'postgres',
        isEnabled: true,
        config: [{ key: 'dictLanguage', value: JSON.stringify({ v: 'english' }) }]
      }]
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
    expect(global.WIKI.models.searchEngines.configure).not.toHaveBeenCalled()
  })

  it('returns a successful HTTP response for an enabled PostgreSQL dictionary configuration', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveEngines } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines(createSavePayload(), res)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: expect.any(String) })
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('error')
  })

  it('returns JSON 400 for malformed engine save payloads', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveEngines } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines({ body: { engines: [{ key: 'postgres', isEnabled: 'yes', config: [] }] }, user: {} }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String) })
    expect(global.WIKI.models.searchEngines.configure).not.toHaveBeenCalled()
  })

  it('returns JSON 400 for malformed engine save config JSON', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveEngines } = await loadHandlers()
    const req = createSavePayload()
    req.body.engines[0].config[0].value = '{not-json'
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String) })
    expect(global.WIKI.models.searchEngines.configure).not.toHaveBeenCalled()
  })

  it.each([
    ['a disabled provider', engine => ({ ...engine, isEnabled: false })],
    ['a noncanonical provider', engine => ({ ...engine, key: 'legacy' })],
    ['an unsupported dictionary', engine => ({
      ...engine, config: [{ key: 'dictLanguage', value: JSON.stringify({ v: 'not-a-dictionary' }) }]
    })],
    ['a missing dictionary', engine => ({ ...engine, config: [] })]
  ])('returns JSON 400 for %s without configuring the engine', async (_kind, invalidEngine) => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveEngines } = await loadHandlers()
    const req = createSavePayload()
    req.body.engines[0] = invalidEngine(req.body.engines[0])
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String) })
    expect(WIKI.models.searchEngines.configure).not.toHaveBeenCalled()
  })

  it.each([
    ['plain persistence error', () => new Error('db-secret-search-plain'), 500],
    ['explicit 500 persistence error', () => Object.assign(new Error('db-secret-search-500'), { status: 500 }), 500],
    ['statusful persistence error', () => Object.assign(new Error('db-secret-search-status'), { status: 503 }), 503],
    ['statusful 422 persistence error', () => Object.assign(new Error('db-secret-search-422'), { status: 422 }), 422],
    ['statusful plain-object lookalike', () => ({ name: 'APPLICATION_ERROR', status: 422, message: 'db-secret-search-object' }), 422],
    ['non-Error persistence rejection', () => 'db-secret-search-string', 500]
  ])('redacts %s during search engine saves', async (_kind, failure, status) => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const secret = failure()
    const secretMessage = typeof secret === 'string' ? secret : secret.message
    global.WIKI.models.searchEngines.configure.mockRejectedValueOnce(secret)
    const { saveEngines } = await loadHandlers()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines(createSavePayload(), res)

    expect(res.status).toHaveBeenCalledWith(status)
    expect(res.json).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String) })
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(secretMessage)
  })

  it('redacts 5xx ApplicationError messages from search engine saves', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveEngines } = await loadHandlers()
    // Match the ApplicationError class from the freshly loaded controller module graph.
    const { default: errors } = await import('../../operations/errors.ts')
    const secret = new errors.ApplicationError('db-secret-search-application', { status: 503 })
    global.WIKI.models.searchEngines.configure.mockRejectedValueOnce(secret)
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await saveEngines(createSavePayload(), res)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String) })
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(secret.message)
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
    expect(res.json).toHaveBeenCalledWith({ message: expect.any(String) })
  })

  it.each([
    ['plain error', () => new Error('db-secret-rebuild-plain')],
    ['statusful error', () => Object.assign(new Error('db-secret-rebuild-status'), { status: 503 })],
    ['non-Error rejection', () => 'db-secret-rebuild-string']
  ])('redacts %s from search index rebuild failures and always returns 500', async (_kind, failure) => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const secret = failure()
    global.WIKI.data.searchEngine.rebuild.mockRejectedValueOnce(secret)
    const { rebuildIndex } = await loadHandlers()
    const res = { sendStatus: vi.fn(), json: vi.fn(), status: vi.fn().mockReturnThis() }

    await rebuildIndex({ user: { permissions: ['manage:system'] } }, res)

    expect(global.WIKI.data.searchEngine.rebuild).toHaveBeenCalledTimes(1)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String) })
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(secret instanceof Error ? secret.message : secret)
  })
})
