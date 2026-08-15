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

describe('controllers/api logging endpoints', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: vi.fn()
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
          query: vi.fn(),
          getLoggers: vi.fn().mockResolvedValue([
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

  const loadLoggersRouter = async () => {
    await import('../../controllers/api/logging.ts')
    return express.__routers[0]
  }

  const loadLoggersHandler = async () => {
    const router = await loadLoggersRouter()
    return router.get.mock.calls.find(([path]) => path === '/loggers')[1]
  }

  const saveLoggersHandler = async () => {
    const router = await loadLoggersRouter()
    return router.post.mock.calls.find(([path]) => path === '/loggers')[1]
  }

  it('registers logging loggers route', async () => { const handler = await loadLoggersHandler()

  expect(typeof handler).toBe('function') })

  it('is mounted by the API index router', async () => {
    const { apiRouter, subrouters } = await loadApiIndexRouter()

    expect(apiRouter.use).toHaveBeenCalledWith('/logging', subrouters.logging)
  })

  it('returns 403 for unauthorized logger requests without querying loggers', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadLoggersHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler(req, res, vi.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.models.loggers.getLoggers).not.toHaveBeenCalled()
  })

  it('returns allowlisted logger fields sorted by title without raw props or internal fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadLoggersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

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

  it('uses current logger metadata and preserves PostgreSQL booleans', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadLoggersHandler()
    global.WIKI.data.loggers = [{
      key: 'late',
      title: 'Late Logger',
      description: 'Loaded after route initialization.',
      logo: '/late.svg',
      website: 'https://example.test/late-logger',
      props: {}
    }]
    global.WIKI.models.loggers.getLoggers.mockResolvedValue([{
      key: 'late',
      isEnabled: true,
      level: 'info',
      config: {}
    }])
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

    expect(res.json).toHaveBeenCalledWith([{
      isEnabled: true,
      key: 'late',
      title: 'Late Logger',
      description: 'Loaded after route initialization.',
      logo: '/late.svg',
      website: 'https://example.test/late-logger',
      level: 'info',
      config: []
    }])
  })

  it('merges config with logger metadata as JSON strings sorted by config key', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await loadLoggersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }

    await handler({ user: {} }, res, vi.fn())

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

  it('registers logging save loggers route', async () => { const handler = await saveLoggersHandler()

  expect(typeof handler).toBe('function') })

  it('returns JSON 403 for unauthorized logger saves without patching loggers', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await saveLoggersHandler()
    const req = { user: { permissions: [] }, body: { loggers: [] } }
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler(req, res)

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(global.WIKI.models.loggers.query).not.toHaveBeenCalled()
  })

  it('returns JSON 400 for malformed logger save payloads', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = await saveLoggersHandler()
    const invalidPayloads = [
      {},
      { loggers: 'not-array' },
      { loggers: [null] },
      { loggers: [{ key: 'alpha', isEnabled: 'yes', level: 'info', config: [] }] },
      { loggers: [{ key: 'alpha', isEnabled: true, level: 42, config: [] }] },
      { loggers: [{ key: 'alpha', isEnabled: true, level: 'info', config: [{ key: 'endpoint', value: 42 }] }] }
    ]

    for (const body of invalidPayloads) {
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
      await handler({ user: {}, body }, res)
      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid loggers payload' })
    }
    expect(global.WIKI.models.loggers.query).not.toHaveBeenCalled()
  })

  it('patches logger rows by key preserving GraphQL config string semantics', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const patch = vi.fn().mockReturnThis()
    const where = vi.fn().mockResolvedValue(1)
    global.WIKI.models.loggers.query.mockReturnValue({ patch, where })
    const handler = await saveLoggersHandler()
    const loggers = [
      {
        key: 'alpha',
        isEnabled: true,
        level: 'debug',
        config: [
          { key: 'endpoint', value: JSON.stringify({ v: 'https://log.example.test' }) },
          { key: 'redact', value: JSON.stringify({ v: true }) }
        ]
      },
      {
        key: 'beta',
        isEnabled: false,
        level: 'warn',
        config: []
      }
    ]
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({ user: {}, body: { loggers } }, res)

    expect(global.WIKI.models.loggers.query).toHaveBeenCalledTimes(2)
    expect(patch).toHaveBeenNthCalledWith(1, {
      isEnabled: true,
      level: 'debug',
      config: {
        endpoint: JSON.stringify({ v: 'https://log.example.test' }),
        redact: JSON.stringify({ v: true })
      }
    })
    expect(where).toHaveBeenNthCalledWith(1, 'key', 'alpha')
    expect(patch).toHaveBeenNthCalledWith(2, {
      isEnabled: false,
      level: 'warn',
      config: {}
    })
    expect(where).toHaveBeenNthCalledWith(2, 'key', 'beta')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Loggers updated successfully' })
  })

  it('returns JSON 500 for unexpected logger save failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.models.loggers.query.mockReturnValue({
      patch: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(new Error('patch failed'))
    })
    const handler = await saveLoggersHandler()
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }

    await handler({
      user: {},
      body: {
        loggers: [{ key: 'alpha', isEnabled: true, level: 'info', config: [] }]
      }
    }, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'patch failed' })
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const err = new Error('logging failed')
    global.WIKI.models.loggers.getLoggers.mockRejectedValue(err)
    const handler = await loadLoggersHandler()
    const res = { sendStatus: vi.fn(), json: vi.fn() }
    const next = vi.fn()

    await handler({ user: {} }, res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })
})
