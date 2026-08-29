vi.mockModule('express', import.meta.url, () => {
  const router = {
    get: vi.fn(),
    all: vi.fn(),
    post: vi.fn(),
    use: vi.fn()
  }

  const expressMock = {
    Router: () => router,
    __router: router
  }

  return { default: expressMock, ...expressMock }
})

const express = await import('express')

describe('controllers/common metrics endpoint', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__router.get.mockClear()
    express.__router.all.mockClear()
    express.__router.post.mockClear()

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
        checkAccess: vi.fn()
      },
      metrics: {
        render: vi.fn()
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

  const loadMetricsHandler = async () => {
    const { default: createCommonController } = await vi.importFresh('../../controllers/common.ts', import.meta.url)
    createCommonController(global.WIKI)
    const metricsCall = express.__router.get.mock.calls.find(([path]) => path === '/metrics')
    return metricsCall && metricsCall[1]
  }

  it('registers a metrics route', async () => {
    const handler = await loadMetricsHandler()

    expect(typeof handler).toBe('function')
  })

  it('returns 403 when the user is unauthorized', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const handler = await loadMetricsHandler()
    const req = { user: { permissions: [] } }
    const res = { sendStatus: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('falls through when metrics are disabled', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.metrics.isEnabled = false
    const handler = await loadMetricsHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { sendStatus: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(global.WIKI.metrics.render).not.toHaveBeenCalled()
  })

  it('renders metrics when enabled and authorized', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(true)
    global.WIKI.config.metrics.isEnabled = true
    const handler = await loadMetricsHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { sendStatus: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(global.WIKI.metrics.render).toHaveBeenCalledWith(res)
    expect(next).not.toHaveBeenCalled()
  })
})
