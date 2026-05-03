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
          query: jest.fn(),
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

  const loadSaveRenderersHandler = () => {
    const express = require('express')
    require('../../controllers/api/rendering')
    const router = express.__routers[0]
    return router.post.mock.calls.find(([path]) => path === '/renderers')[1]
  }

  const mockRendererPatch = () => {
    const where = jest.fn().mockResolvedValue(1)
    const patch = jest.fn(() => ({ where }))
    global.WIKI.models.renderers.query.mockReturnValue({ patch })
    return { patch, where }
  }

  it('registers rendering renderers route', () => {
    const handler = loadRenderersHandler()

    expect(typeof handler).toBe('function')
  })

  it('registers rendering renderers save route', () => {
    const handler = loadSaveRenderersHandler()

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

  it('returns JSON 403 for unauthorized renderer save requests without patching renderers', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = loadSaveRenderersHandler()
    const req = { user: { permissions: [] }, body: { renderers: [] } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), sendStatus: jest.fn() }

    await handler(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(global.WIKI.models.renderers.query).not.toHaveBeenCalled()
  })

  it('saves renderer configuration with GraphQL mutation parity', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const { patch, where } = mockRendererPatch()
    const handler = loadSaveRenderersHandler()
    const req = {
      user: { permissions: ['manage:system'] },
      body: {
        renderers: [
          {
            key: 'markdownCore',
            isEnabled: true,
            config: [
              { key: 'safeMode', value: JSON.stringify({ v: false }) },
              { key: 'flavor', value: JSON.stringify({ v: 'commonmark' }) },
              { key: 'missingValue', value: JSON.stringify({ raw: true }) }
            ]
          },
          {
            key: 'emojiRenderer',
            isEnabled: false,
            config: []
          }
        ]
      }
    }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), sendStatus: jest.fn() }

    await handler(req, res, jest.fn())

    expect(patch).toHaveBeenNthCalledWith(1, {
      isEnabled: true,
      config: {
        safeMode: false,
        flavor: 'commonmark',
        missingValue: null
      }
    })
    expect(where).toHaveBeenNthCalledWith(1, 'key', 'markdownCore')
    expect(patch).toHaveBeenNthCalledWith(2, {
      isEnabled: false,
      config: {}
    })
    expect(where).toHaveBeenNthCalledWith(2, 'key', 'emojiRenderer')
    expect(res.json).toHaveBeenCalledWith({ message: 'Renderers updated successfully' })
  })

  it('rejects invalid renderer save payloads before patching', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadSaveRenderersHandler()
    const req = { user: {}, body: { renderers: [{ key: 'markdownCore', isEnabled: 'yes', config: [] }] } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), sendStatus: jest.fn() }

    await handler(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid renderers payload' })
    expect(global.WIKI.models.renderers.query).not.toHaveBeenCalled()
  })

  it('rejects malformed renderer config JSON during save', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    mockRendererPatch()
    const handler = loadSaveRenderersHandler()
    const req = { user: {}, body: { renderers: [{ key: 'markdownCore', isEnabled: true, config: [{ key: 'safeMode', value: '{bad' }] }] } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), sendStatus: jest.fn() }

    await handler(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid renderers payload' })
  })

  it('returns JSON errors when renderer save fails unexpectedly', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const patch = jest.fn(() => ({ where: jest.fn().mockRejectedValue(new Error('database unavailable')) }))
    global.WIKI.models.renderers.query.mockReturnValue({ patch })
    const handler = loadSaveRenderersHandler()
    const req = { user: {}, body: { renderers: [{ key: 'markdownCore', isEnabled: true, config: [] }] } }
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn(), sendStatus: jest.fn() }

    await handler(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'database unavailable' })
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
