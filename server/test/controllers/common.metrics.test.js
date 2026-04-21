jest.mock('express', () => {
  const router = {
    get: jest.fn(),
    all: jest.fn(),
    use: jest.fn()
  }

  return {
    Router: () => router,
    __router: router
  }
})

describe('controllers/common metrics endpoint', () => {
  beforeEach(() => {
    jest.resetModules()
    const express = require('express')
    express.__router.get.mockClear()
    express.__router.all.mockClear()

    global.WIKI = {
      config: {
        seo: {
          robots: []
        },
        metrics: {
          isEnabled: false
        },
        lang: {
          namespacing: false
        }
      },
      auth: {
        checkAccess: jest.fn()
      },
      metrics: {
        render: jest.fn()
      },
      models: {
        knex: {
          client: {
            pool: {
              numFree: () => 1,
              numUsed: () => 0
            }
          }
        }
      }
    }
  })

  const loadMetricsHandler = () => {
    const express = require('express')
    require('../../controllers/common')
    const metricsCall = express.__router.get.mock.calls.find(([path]) => path === '/metrics')
    return metricsCall && metricsCall[1]
  }

  it('registers a metrics route', () => {
    const handler = loadMetricsHandler()

    expect(typeof handler).toBe('function')
  })

  it('returns 403 when the user is unauthorized', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = loadMetricsHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: jest.fn() }
    const next = jest.fn()

    await handler(req, res, next)

    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('falls through when metrics are disabled', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.metrics.isEnabled = false
    const handler = loadMetricsHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { sendStatus: jest.fn() }
    const next = jest.fn()

    await handler(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(global.WIKI.metrics.render).not.toHaveBeenCalled()
  })

  it('renders metrics when enabled and authorized', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.metrics.isEnabled = true
    const handler = loadMetricsHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { sendStatus: jest.fn() }
    const next = jest.fn()

    await handler(req, res, next)

    expect(global.WIKI.metrics.render).toHaveBeenCalledWith(res)
    expect(next).not.toHaveBeenCalled()
  })
})
