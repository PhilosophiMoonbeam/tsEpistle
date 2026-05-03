jest.mock('express-brute', () => {
  return jest.fn().mockImplementation(() => ({
    prevent: jest.fn((req, res, next) => next())
  }))
})

jest.mock('../../helpers/brute-knex', () => {
  return jest.fn().mockImplementation(() => ({}))
})

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

describe('controllers/api theming endpoints', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__routers.length = 0

    global.WIKI = {
      auth: {
        checkAccess: jest.fn()
      },
      config: {
        theming: {
          theme: 'default',
          iconset: 'mdi',
          darkMode: false,
          tocPosition: 'right',
          injectCSS: '.contents{color:red}',
          injectHead: '<meta name="test" content="head">',
          injectBody: '<div>body</div>',
          privateSetting: 'do-not-return'
        }
      },
      models: {
        knex: {}
      },
      configSvc: {
        saveToDb: jest.fn()
      }
    }
  })

  const loadConfigHandler = () => {
    const express = require('express')
    require('../../controllers/api/theming')
    const router = express.__routers[0]
    return router.get.mock.calls.find(([path]) => path === '/config')[1]
  }

  const loadSaveHandler = () => {
    const express = require('express')
    require('../../controllers/api/theming')
    const router = express.__routers[0]
    return router.post.mock.calls.find(([path]) => path === '/config')[1]
  }

  it('registers config route', () => {
    const handler = loadConfigHandler()

    expect(typeof handler).toBe('function')
  })

  it('registers config save route', () => {
    const handler = loadSaveHandler()

    expect(typeof handler).toBe('function')
  })

  it('is mounted by the API index router', () => {
    const express = require('express')
    expect(() => require('../../controllers/api')).not.toThrow()
    const apiRouter = express.__routers[0]

    expect(apiRouter.use).toHaveBeenCalledWith('/theming', expect.any(Object))
  })

  it('returns 403 for unauthorized config requests without JSON', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = loadConfigHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: jest.fn(), json: jest.fn(), set: jest.fn() }

    handler(req, res, jest.fn())

    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(res.json).not.toHaveBeenCalled()
  })

  it('returns 403 for unauthorized config save requests without saving', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = loadSaveHandler()
    const req = { user: { permissions: [] }, body: { theme: 'default' } }
    const res = { sendStatus: jest.fn(), json: jest.fn(), status: jest.fn().mockReturnThis() }

    await handler(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' })
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
    expect(res.sendStatus).not.toHaveBeenCalled()
  })

  it('checks manage:theme and manage:system access', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadConfigHandler()
    const req = { user: { permissions: ['manage:theme'] } }
    const res = { sendStatus: jest.fn(), json: jest.fn(), set: jest.fn() }

    handler(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:theme', 'manage:system'])
  })

  it('checks manage:theme and manage:system access for config save', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadSaveHandler()
    const req = {
      user: { permissions: ['manage:theme'] },
      body: {
        theme: 'default',
        iconset: 'mdi',
        darkMode: false,
        tocPosition: 'left'
      }
    }
    const res = { sendStatus: jest.fn(), json: jest.fn(), status: jest.fn().mockReturnThis() }

    await handler(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:theme', 'manage:system'])
  })

  it('rejects invalid theme config save payloads before persisting', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadSaveHandler()
    const req = {
      user: {},
      body: {
        theme: 'default',
        iconset: 'mdi',
        darkMode: 'false'
      }
    }
    const res = { sendStatus: jest.fn(), json: jest.fn(), status: jest.fn().mockReturnThis() }

    await handler(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid theme config payload' })
    expect(global.WIKI.configSvc.saveToDb).not.toHaveBeenCalled()
  })

  it('returns exactly the expected config fields for authorized requests', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadConfigHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn(), set: jest.fn() }

    handler({ user: {} }, res, jest.fn())

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.json).toHaveBeenCalledWith({
      theme: 'default',
      iconset: 'mdi',
      darkMode: false,
      tocPosition: 'right',
      injectCSS: expect.any(String),
      injectHead: '<meta name="test" content="head">',
      injectBody: '<div>body</div>'
    })
    expect(Object.keys(res.json.mock.calls[0][0]).sort()).toEqual([
      'darkMode',
      'iconset',
      'injectBody',
      'injectCSS',
      'injectHead',
      'theme',
      'tocPosition'
    ])
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('privateSetting')
  })

  it('allows manage:theme users when checkAccess returns true', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadConfigHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn(), set: jest.fn() }

    handler({ user: { permissions: ['manage:theme'] } }, res, jest.fn())

    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledTimes(1)
  })

  it('defaults tocPosition to left when config value is falsy', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.theming.tocPosition = ''
    const handler = loadConfigHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn(), set: jest.fn() }

    handler({ user: {} }, res, jest.fn())

    expect(res.json.mock.calls[0][0].tocPosition).toBe('left')
  })

  it('beautifies injectCSS using the GraphQL read behavior', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.theming.injectCSS = '.contents{color:red}.sidebar{display:none}'
    const handler = loadConfigHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn(), set: jest.fn() }

    handler({ user: {} }, res, jest.fn())

    expect(res.json.mock.calls[0][0].injectCSS).toContain('.contents')
    expect(res.json.mock.calls[0][0].injectCSS).toContain('color: red')
    expect(res.json.mock.calls[0][0].injectCSS).toContain('.sidebar')
    expect(res.json.mock.calls[0][0].injectCSS).toContain('display: none')
  })

  it('returns injectHead and injectBody unchanged', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.theming.injectHead = '<!-- head marker -->'
    global.WIKI.config.theming.injectBody = '<section data-test="body"></section>'
    const handler = loadConfigHandler()
    const res = { sendStatus: jest.fn(), json: jest.fn(), set: jest.fn() }

    handler({ user: {} }, res, jest.fn())

    expect(res.json.mock.calls[0][0].injectHead).toBe('<!-- head marker -->')
    expect(res.json.mock.calls[0][0].injectBody).toBe('<section data-test="body"></section>')
  })

  it('saves theme config with GraphQL mutation parity', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadSaveHandler()
    const req = {
      user: { permissions: ['manage:theme'] },
      body: {
        theme: 'default',
        iconset: 'fa',
        darkMode: true,
        tocPosition: '',
        injectCSS: '.contents{color:red}',
        injectHead: '<meta name="saved" content="head">',
        injectBody: '<div>saved body</div>'
      }
    }
    const res = { sendStatus: jest.fn(), json: jest.fn(), status: jest.fn().mockReturnThis() }

    await handler(req, res, jest.fn())

    expect(global.WIKI.config.theming).toMatchObject({
      theme: 'default',
      iconset: 'fa',
      darkMode: true,
      tocPosition: 'left',
      injectHead: '<meta name="saved" content="head">',
      injectBody: '<div>saved body</div>',
      privateSetting: 'do-not-return'
    })
    expect(global.WIKI.config.theming.injectCSS).toBe('.contents{color:red}')
    expect(global.WIKI.configSvc.saveToDb).toHaveBeenCalledWith(['theming'])
    expect(res.json).toHaveBeenCalledWith({ message: 'Theme config updated' })
  })

  it('defaults missing optional injection fields to empty strings on save', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadSaveHandler()
    const req = {
      user: {},
      body: {
        theme: 'default',
        iconset: 'mdi',
        darkMode: false,
        tocPosition: 'right'
      }
    }
    const res = { sendStatus: jest.fn(), json: jest.fn(), status: jest.fn().mockReturnThis() }

    await handler(req, res, jest.fn())

    expect(global.WIKI.config.theming.injectCSS).toBe('')
    expect(global.WIKI.config.theming.injectHead).toBe('')
    expect(global.WIKI.config.theming.injectBody).toBe('')
    expect(res.json).toHaveBeenCalledWith({ message: 'Theme config updated' })
  })

  it('returns JSON errors when theme config save fails', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.configSvc.saveToDb.mockRejectedValue(new Error('database unavailable'))
    const handler = loadSaveHandler()
    const req = {
      user: {},
      body: {
        theme: 'default',
        iconset: 'mdi',
        darkMode: false,
        tocPosition: 'left',
        injectCSS: '',
        injectHead: '',
        injectBody: ''
      }
    }
    const res = { sendStatus: jest.fn(), json: jest.fn(), status: jest.fn().mockReturnThis() }

    await handler(req, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'database unavailable' })
  })
})
