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

describe('controllers/api comments endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: jest.fn()
      },
      data: {
        commentProviders: [
          {
            key: 'default',
            title: 'Default Comments',
            description: 'Built-in comments provider.',
            logo: '/_assets/comments/default.svg',
            website: 'https://example.invalid/comments/default',
            isAvailable: true,
            props: {
              displayMode: {
                type: 'string',
                title: 'Display Mode',
                order: 2
              },
              requireApproval: {
                type: 'boolean',
                title: 'Require Approval',
                order: 1,
                hint: 'Require approval before publishing.'
              }
            },
            unrelatedMetadata: 'do-not-return'
          },
          {
            key: 'external',
            title: 'External Comments',
            description: 'External comments provider.',
            logo: '/_assets/comments/external.svg',
            website: 'https://example.invalid/comments/external',
            isAvailable: false,
            props: {}
          }
        ]
      },
      models: {
        commentProviders: {
          query: jest.fn(),
          initProvider: jest.fn().mockResolvedValue(true),
          getProviders: jest.fn().mockResolvedValue([
            {
              key: 'default',
              isEnabled: true,
              config: {
                displayMode: 'compact',
                requireApproval: true,
                undeclaredSetting: 'do-not-return'
              },
              privateField: 'do-not-return',
              props: {
                raw: true
              }
            },
            {
              key: 'external',
              isEnabled: false,
              config: {},
              privateField: 'do-not-return'
            }
          ])
        }
      }
    }

    global.WIKI.models.commentProviders.query.mockImplementation(() => {
      const query = {
        patch: jest.fn().mockReturnThis(),
        where: jest.fn().mockResolvedValue(1)
      }
      global.WIKI.models.commentProviders.__queries = global.WIKI.models.commentProviders.__queries || []
      global.WIKI.models.commentProviders.__queries.push(query)
      return query
    })
  })

  const loadHandlers = () => {
    const express = require('express')
    require('../../controllers/api/comments')
    const router = express.__routers[0]
    return {
      providers: router.get.mock.calls.find(([path]) => path === '/providers')[1],
      saveProviders: router.post.mock.calls.find(([path]) => path === '/providers')[1]
    }
  }

  const loadProvidersHandler = () => loadHandlers().providers

  it('registers comments providers routes', () => {
    const handlers = loadHandlers()

    expect(typeof handlers.providers).toBe('function')
    expect(typeof handlers.saveProviders).toBe('function')
  })

  it('is mounted by the API index router', () => {
    const express = require('express')
    expect(() => require('../../controllers/api')).not.toThrow()
    const apiRouter = express.__routers[0]

    expect(apiRouter.use).toHaveBeenCalledWith('/comments', expect.any(Object))
  })

  it('returns 403 for unauthorized provider requests without querying providers', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = loadProvidersHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.models.commentProviders.getProviders).not.toHaveBeenCalled()
  })

  it('returns allowlisted provider fields without raw props or internal fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadProvidersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: {} }, res, jest.fn())

    expect(global.WIKI.models.commentProviders.getProviders).toHaveBeenCalledWith()
    expect(res.json).toHaveBeenCalledWith([
      {
        isEnabled: true,
        key: 'default',
        title: 'Default Comments',
        description: 'Built-in comments provider.',
        logo: '/_assets/comments/default.svg',
        website: 'https://example.invalid/comments/default',
        isAvailable: true,
        config: expect.any(Array)
      },
      {
        isEnabled: false,
        key: 'external',
        title: 'External Comments',
        description: 'External comments provider.',
        logo: '/_assets/comments/external.svg',
        website: 'https://example.invalid/comments/external',
        isAvailable: false,
        config: []
      }
    ])
    const row = res.json.mock.calls[0][0][0]
    expect(row).not.toHaveProperty('props')
    expect(row).not.toHaveProperty('privateField')
    expect(row).not.toHaveProperty('unrelatedMetadata')
    expect(row).not.toHaveProperty('undeclaredSetting')
  })

  it('merges config with provider metadata as JSON strings sorted by config key and omits unknown config keys', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadProvidersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: {} }, res, jest.fn())

    const config = res.json.mock.calls[0][0][0].config
    expect(config.map(row => row.key)).toEqual(['displayMode', 'requireApproval'])
    expect(config).toEqual([
      {
        key: 'displayMode',
        value: JSON.stringify({
          type: 'string',
          title: 'Display Mode',
          order: 2,
          value: 'compact'
        })
      },
      {
        key: 'requireApproval',
        value: JSON.stringify({
          type: 'boolean',
          title: 'Require Approval',
          order: 1,
          hint: 'Require approval before publishing.',
          value: true
        })
      }
    ])
  })

  const createSavePayload = () => ({
    body: {
      providers: [
        {
          key: 'default',
          isEnabled: true,
          config: [
            { key: 'displayMode', value: JSON.stringify({ v: 'expanded' }) },
            { key: 'missingValue', value: JSON.stringify({ label: 'No value key' }) }
          ]
        },
        {
          key: 'external',
          isEnabled: false,
          config: [
            { key: 'endpoint', value: JSON.stringify({ v: 'https://example.invalid/comments' }) }
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
    expect(global.WIKI.models.commentProviders.query).not.toHaveBeenCalled()
    expect(global.WIKI.models.commentProviders.initProvider).not.toHaveBeenCalled()
  })

  it('saves providers with GraphQL parity and initializes the active comment provider', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveProviders } = loadHandlers()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await saveProviders(createSavePayload(), res)

    const queries = global.WIKI.models.commentProviders.__queries
    expect(queries).toHaveLength(2)
    expect(queries[0].patch).toHaveBeenCalledWith({
      isEnabled: true,
      config: {
        displayMode: 'expanded',
        missingValue: null
      }
    })
    expect(queries[0].where).toHaveBeenCalledWith('key', 'default')
    expect(queries[1].patch).toHaveBeenCalledWith({
      isEnabled: false,
      config: {
        endpoint: 'https://example.invalid/comments'
      }
    })
    expect(queries[1].where).toHaveBeenCalledWith('key', 'external')
    expect(global.WIKI.models.commentProviders.initProvider).toHaveBeenCalledTimes(1)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith({ message: 'Comment Providers updated successfully' })
  })

  it('returns JSON 400 for malformed provider save payloads', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveProviders } = loadHandlers()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await saveProviders({ body: { providers: [{ key: 'default', isEnabled: 'yes', config: [] }] }, user: {} }, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid comment providers payload' })
    expect(global.WIKI.models.commentProviders.query).not.toHaveBeenCalled()
    expect(global.WIKI.models.commentProviders.initProvider).not.toHaveBeenCalled()
  })

  it('returns JSON 400 for malformed provider save config JSON', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { saveProviders } = loadHandlers()
    const req = createSavePayload()
    req.body.providers[0].config[0].value = '{not-json'
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await saveProviders(req, res)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid comment providers payload' })
    expect(global.WIKI.models.commentProviders.initProvider).not.toHaveBeenCalled()
  })

  it('returns JSON 500 for unexpected provider save failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const query = {
      patch: jest.fn().mockReturnThis(),
      where: jest.fn().mockRejectedValue(new Error('comment save failed'))
    }
    global.WIKI.models.commentProviders.query.mockReturnValue(query)
    const { saveProviders } = loadHandlers()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await saveProviders(createSavePayload(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'comment save failed' })
    expect(global.WIKI.models.commentProviders.initProvider).not.toHaveBeenCalled()
  })

  it('returns JSON 500 for comment provider initialization failures', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.models.commentProviders.initProvider.mockRejectedValueOnce(new Error('init failed'))
    const { saveProviders } = loadHandlers()
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    await saveProviders(createSavePayload(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'init failed' })
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const err = new Error('comments failed')
    global.WIKI.models.commentProviders.getProviders.mockRejectedValue(err)
    const handler = loadProvidersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }
    const next = jest.fn()

    await handler({ user: {} }, res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })
})
