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

describe('controllers/api rendering endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: jest.fn()
      },
      data: {
        renderers: [
          {
            key: 'markdownCore',
            title: 'Markdown Core',
            description: 'Core markdown renderer.',
            icon: 'mdi-language-markdown',
            input: 'markdown',
            output: 'html',
            props: {
              safeMode: {
                type: 'boolean',
                title: 'Safe Mode',
                order: 1,
                hint: 'Enable benign safety behavior'
              },
              flavor: {
                type: 'string',
                title: 'Flavor',
                order: 2
              }
            },
            unrelatedMetadata: 'do-not-return'
          },
          {
            key: 'emojiRenderer',
            title: 'Emoji Renderer',
            description: 'Adds emoji rendering.',
            icon: 'mdi-emoticon-outline',
            dependsOn: 'markdownCore',
            props: {}
          }
        ]
      },
      models: {
        renderers: {
          getRenderers: jest.fn().mockResolvedValue([
            {
              key: 'markdownCore',
              isEnabled: true,
              config: {
                flavor: 'commonmark',
                safeMode: true,
                internalNote: 'do-not-return'
              },
              privateField: 'do-not-return',
              props: {
                raw: true
              }
            },
            {
              key: 'emojiRenderer',
              isEnabled: false,
              config: {},
              privateField: 'do-not-return'
            }
          ])
        }
      }
    }
  })

  const loadRenderersHandler = () => {
    const express = require('express')
    require('../../controllers/api/rendering')
    const router = express.__routers[0]
    return router.get.mock.calls.find(([path]) => path === '/renderers')[1]
  }

  it('registers rendering renderers route', () => {
    const handler = loadRenderersHandler()

    expect(typeof handler).toBe('function')
  })

  it('is mounted by the API index router', () => {
    const express = require('express')
    expect(() => require('../../controllers/api')).not.toThrow()
    const apiRouter = express.__routers[0]

    expect(apiRouter.use).toHaveBeenCalledWith('/rendering', expect.any(Object))
  })

  it('returns 403 for unauthorized renderer requests without querying renderers', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = loadRenderersHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
    expect(global.WIKI.models.renderers.getRenderers).not.toHaveBeenCalled()
  })

  it('returns allowlisted renderer fields without raw props or internal fields', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadRenderersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: {} }, res, jest.fn())

    expect(global.WIKI.models.renderers.getRenderers).toHaveBeenCalledWith()
    expect(res.json).toHaveBeenCalledWith([
      {
        isEnabled: true,
        key: 'markdownCore',
        title: 'Markdown Core',
        description: 'Core markdown renderer.',
        icon: 'mdi-language-markdown',
        dependsOn: null,
        input: 'markdown',
        output: 'html',
        config: expect.any(Array)
      },
      {
        isEnabled: false,
        key: 'emojiRenderer',
        title: 'Emoji Renderer',
        description: 'Adds emoji rendering.',
        icon: 'mdi-emoticon-outline',
        dependsOn: 'markdownCore',
        input: null,
        output: null,
        config: []
      }
    ])
    const row = res.json.mock.calls[0][0][0]
    expect(row).not.toHaveProperty('props')
    expect(row).not.toHaveProperty('privateField')
    expect(row).not.toHaveProperty('unrelatedMetadata')
    expect(row).not.toHaveProperty('internalNote')
  })

  it('merges config with renderer metadata as JSON strings sorted by config key and omits unknown config keys', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadRenderersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }

    await handler({ user: {} }, res, jest.fn())

    const config = res.json.mock.calls[0][0][0].config
    expect(config.map(row => row.key)).toEqual(['flavor', 'safeMode'])
    expect(config).toEqual([
      {
        key: 'flavor',
        value: JSON.stringify({
          type: 'string',
          title: 'Flavor',
          order: 2,
          value: 'commonmark'
        })
      },
      {
        key: 'safeMode',
        value: JSON.stringify({
          type: 'boolean',
          title: 'Safe Mode',
          order: 1,
          hint: 'Enable benign safety behavior',
          value: true
        })
      }
    ])
  })

  it('forwards unexpected failures to next', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const err = new Error('rendering failed')
    global.WIKI.models.renderers.getRenderers.mockRejectedValue(err)
    const handler = loadRenderersHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn() }
    const next = jest.fn()

    await handler({ user: {} }, res, next)

    expect(next).toHaveBeenCalledWith(err)
    expect(res.json).not.toHaveBeenCalled()
  })
})
