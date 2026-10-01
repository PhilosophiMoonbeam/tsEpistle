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
        checkAccess: vi.fn((user, permissions) => permissions.every(permission => user?.permissions?.includes(permission)))
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

  it.each([false, true])('returns 403 to an ordinary page reader when metrics enabled=%s', async isEnabled => {
    global.WIKI.config.metrics.isEnabled = isEnabled
    const handler = await loadMetricsHandler()
    const req = { user: { permissions: ['read:pages'] } }
    const res = { sendStatus: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(res.sendStatus).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
    expect(global.WIKI.metrics.render).not.toHaveBeenCalled()
  })

  it('falls through when metrics are disabled', async () => {
    global.WIKI.config.metrics.isEnabled = false
    const handler = await loadMetricsHandler()
    const req = { user: { permissions: ['manage:system'] } }
    const res = { sendStatus: vi.fn() }
    const next = vi.fn()

    await handler(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(global.WIKI.metrics.render).not.toHaveBeenCalled()
  })

  it('serves plain-text Prometheus metrics when enabled and authorized', async () => {
    global.WIKI.config.metrics.isEnabled = true
    const { Gauge, register } = await import('prom-client')
    const { default: metrics } = await vi.importFresh('../../core/metrics.ts', import.meta.url)
    global.WIKI.metrics = metrics
    const gauge = new Gauge({
      name: 'wiki_controller_metrics_probe',
      help: 'Deterministic metric for the controller response',
      registers: [register]
    })
    try {
      gauge.set(17)
      const handler = await loadMetricsHandler()
      const req = { user: { permissions: ['manage:system'] } }
      const res = {
        headers: {},
        body: undefined,
        contentType(value) { this.headers['Content-Type'] = value },
        send(value) { this.body = value },
        status(value) { this.statusCode = value; return this },
        end(value) { this.body = value }
      }
      const next = vi.fn()

      await handler(req, res, next)

      expect(res.headers['Content-Type']).toMatch(/^text\/plain(?:;|$)/)
      expect(res.body).toMatch(/^wiki_controller_metrics_probe 17$/m)
      expect(next).not.toHaveBeenCalled()
    } finally {
      register.removeSingleMetric(gauge.name)
    }
  })
})
