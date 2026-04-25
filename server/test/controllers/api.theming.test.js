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
      }
    }
  })

  const loadConfigHandler = () => {
    const express = require('express')
    require('../../controllers/api/theming')
    const router = express.__routers[0]
    return router.get.mock.calls.find(([path]) => path === '/config')[1]
  }

  it('registers config route', () => {
    const handler = loadConfigHandler()

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

  it('checks manage:theme and manage:system access', () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    const handler = loadConfigHandler()
    const req = { user: { permissions: ['manage:theme'] } }
    const res = { sendStatus: jest.fn(), json: jest.fn(), set: jest.fn() }

    handler(req, res, jest.fn())

    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(req.user, ['manage:theme', 'manage:system'])
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
})
