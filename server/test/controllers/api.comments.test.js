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
  })

  const loadProvidersHandler = () => {
    const express = require('express')
    require('../../controllers/api/comments')
    const router = express.__routers[0]
    return router.get.mock.calls.find(([path]) => path === '/providers')[1]
  }

  it('registers comments providers route', () => {
    const handler = loadProvidersHandler()

    expect(typeof handler).toBe('function')
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
