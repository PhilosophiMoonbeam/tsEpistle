vi.mock('prom-client', () => {
  const gauges = []
  const register = {
    contentType: 'text/plain',
    setDefaultLabels: vi.fn(),
    clear: vi.fn(() => {
      gauges.length = 0
    }),
    metrics: vi.fn(async () => {
      const values = []
      for (const gauge of gauges) {
        await gauge.collect.call({
          set: (value) => values.push(`${gauge.name} ${value}`)
        })
      }
      return values.join('\n')
    })
  }

  class Gauge {
    constructor (opts) {
      this.name = opts.name
      this.collect = opts.collect
      gauges.push(this)
    }
  }

  return {
    collectDefaultMetrics: vi.fn(),
    register,
    Gauge
  }
})

const makeCountModel = (total) => ({
  query: () => ({
    count: () => ({
      first: async () => ({ total })
    })
  })
})

describe('core/metrics', () => {
  let previousWiki

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    previousWiki = global.WIKI
    global.WIKI = {
      INSTANCE_ID: 'test-instance',
      config: {
        metrics: {
          isEnabled: true
        }
      },
      logger: {
        info: vi.fn()
      },
      models: {
        groups: makeCountModel(2),
        pages: makeCountModel(5),
        tags: makeCountModel(3),
        users: makeCountModel(7)
      }
    }
  })

  afterEach(() => {
    global.WIKI = previousWiki
  })

  it('collects and renders wiki metrics when enabled', async () => {
    const { default: metrics } = await import('../../core/metrics.ts')
    const promClient = await import('prom-client')
    const res = {
      contentType: vi.fn(),
      send: vi.fn(),
      status: vi.fn(() => ({ end: vi.fn() }))
    }

    await metrics.init()
    await metrics.render(res)

    expect(promClient.collectDefaultMetrics).toHaveBeenCalled()
    expect(promClient.register.setDefaultLabels).toHaveBeenCalledWith({
      WIKI_INSTANCE: 'test-instance'
    })
    expect(res.contentType).toHaveBeenCalledWith('text/plain')
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('wiki_groups_total 2'))
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('wiki_pages_total 5'))
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('wiki_tags_total 3'))
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('wiki_users_total 7'))
  })

  it('clears collectors when disabled', async () => {
    global.WIKI.config.metrics.isEnabled = false
    const { default: metrics } = await import('../../core/metrics.ts')
    const promClient = await import('prom-client')

    await metrics.init()

    expect(promClient.register.clear).toHaveBeenCalled()
  })
})
