jest.mock('prom-client', () => {
  const gauges = []
  const register = {
    contentType: 'text/plain',
    setDefaultLabels: jest.fn(),
    clear: jest.fn(() => {
      gauges.length = 0
    }),
    metrics: jest.fn(async () => {
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
    collectDefaultMetrics: jest.fn(),
    register,
    Gauge
  }
}, { virtual: true })

const makeCountModel = (total) => ({
  query: () => ({
    count: () => ({
      first: async () => ({ total })
    })
  })
})

describe('core/metrics', () => {
  beforeEach(() => {
    jest.resetModules()
    global.WIKI = {
      INSTANCE_ID: 'test-instance',
      config: {
        metrics: {
          isEnabled: true
        }
      },
      logger: {
        info: jest.fn()
      },
      models: {
        groups: makeCountModel(2),
        pages: makeCountModel(5),
        tags: makeCountModel(3),
        users: makeCountModel(7)
      }
    }
  })

  it('collects and renders wiki metrics when enabled', async () => {
    const metrics = require('../../core/metrics')
    const promClient = require('prom-client')
    const res = {
      contentType: jest.fn(),
      send: jest.fn(),
      status: jest.fn(() => ({ end: jest.fn() }))
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
    const metrics = require('../../core/metrics')
    const promClient = require('prom-client')

    await metrics.init()

    expect(promClient.register.clear).toHaveBeenCalled()
  })
})
