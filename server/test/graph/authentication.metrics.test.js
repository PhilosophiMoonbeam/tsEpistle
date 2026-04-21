describe('graph/resolvers/authentication metrics state', () => {
  let saveToDb
  let initMetrics

  beforeEach(() => {
    jest.resetModules()
    saveToDb = jest.fn().mockResolvedValue(true)
    initMetrics = jest.fn().mockResolvedValue(true)

    global.WIKI = {
      config: {
        metrics: {
          isEnabled: false
        }
      },
      configSvc: {
        saveToDb
      },
      metrics: {
        init: initMetrics
      }
    }
  })

  it('returns the current metrics state', () => {
    const resolver = require('../../graph/resolvers/authentication')

    expect(resolver.AuthenticationQuery.metricsState()).toBe(false)
  })

  it('updates the metrics state and reinitializes metrics', async () => {
    const resolver = require('../../graph/resolvers/authentication')

    const result = await resolver.AuthenticationMutation.setMetricsState(null, { enabled: true }, null)

    expect(global.WIKI.config.metrics.isEnabled).toBe(true)
    expect(saveToDb).toHaveBeenCalledWith(['metrics'])
    expect(initMetrics).toHaveBeenCalled()
    expect(result.responseResult.succeeded).toBe(true)
  })

  it('rolls back the runtime state when saving fails', async () => {
    saveToDb.mockRejectedValueOnce(new Error('save failed'))
    const resolver = require('../../graph/resolvers/authentication')

    const result = await resolver.AuthenticationMutation.setMetricsState(null, { enabled: true }, null)

    expect(global.WIKI.config.metrics.isEnabled).toBe(false)
    expect(initMetrics).toHaveBeenCalledTimes(2)
    expect(result.responseResult.succeeded).toBe(false)
  })

  it('rolls back the in-memory state when metrics initialization fails', async () => {
    initMetrics.mockRejectedValueOnce(new Error('init failed'))
    const resolver = require('../../graph/resolvers/authentication')

    const result = await resolver.AuthenticationMutation.setMetricsState(null, { enabled: true }, null)

    expect(global.WIKI.config.metrics.isEnabled).toBe(false)
    expect(saveToDb).not.toHaveBeenCalled()
    expect(result.responseResult.succeeded).toBe(false)
  })
})
