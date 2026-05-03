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
        delete: jest.fn(),
        get: jest.fn(),
        patch: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        use: jest.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }
})

describe('controllers/api route shell', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__routers.length = 0
    global.WIKI = {
      models: {
        knex: {}
      }
    }
  })

  const loadRouter = () => {
    const express = require('express')
    expect(() => require('../../controllers/api')).not.toThrow()
    return express.__routers[0]
  }

  it('mounts system, analytics, search, theming, logging, mail, storage, rendering, comments, contribute, locales, groups, and users subrouters', () => {
    const apiRouter = loadRouter()

    expect(apiRouter.use).toHaveBeenCalledWith('/system', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/analytics', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/search', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/theming', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/logging', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/mail', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/storage', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/site', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/rendering', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/comments', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/contribute', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/locales', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/groups', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/users', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/pages', expect.any(Object))
    expect(apiRouter.use).toHaveBeenCalledWith('/auth', expect.any(Object))
  })

  it('returns a JSON 404 for unknown API routes', () => {
    const apiRouter = loadRouter()
    const notFoundHandler = apiRouter.use.mock.calls.find(([handler]) => typeof handler === 'function' && handler.length === 2)[0]
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }

    notFoundHandler({}, res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'Not Found' })
  })

  it('returns a generic JSON 500 for unexpected API failures', () => {
    const apiRouter = loadRouter()
    const errorHandler = apiRouter.use.mock.calls.find(([handler]) => typeof handler === 'function' && handler.length === 4)[0]
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() }
    const err = new Error('boom')

    errorHandler(err, {}, res, jest.fn())

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal Server Error' })
  })
})
