describe('graph/resolvers/authentication metrics state', () => {
  let previousWiki
  let saveToDb
  let initMetrics

  beforeEach(() => {
    vi.resetModules()
    previousWiki = global.WIKI
    saveToDb = vi.fn().mockResolvedValue(true)
    initMetrics = vi.fn().mockResolvedValue(true)

    global.WIKI = {
      ROOTPATH: '/test',
      auth: {
        strategies: {}
      },
      config: {
        flags: {
          ldapdebug: false
        },
        metrics: {
          isEnabled: false
        }
      },
      configSvc: {
        saveToDb
      },
      data: {
        authentication: []
      },
      events: {
        outbound: {
          emit: vi.fn()
        }
      },
      logger: {
        warn: vi.fn()
      },
      metrics: {
        init: initMetrics
      },
      models: {
        authentication: {},
        users: {}
      }
    }
  })

  afterEach(() => {
    global.WIKI = previousWiki
  })
  const loadResolver = async () => {
    const { default: createResolver } = await vi.importFresh('../../graph/resolvers/authentication.ts', import.meta.url)
    return createResolver(global.WIKI)
  }

  it('returns the current metrics state', async () => {
    const resolver = await loadResolver()

    expect(resolver.AuthenticationQuery.metricsState()).toBe(false)
  })

  it('updates the metrics state and reinitializes metrics', async () => {
    const resolver = await loadResolver()

    const result = await resolver.AuthenticationMutation.setMetricsState(null, { enabled: true }, null)

    expect(global.WIKI.config.metrics.isEnabled).toBe(true)
    expect(saveToDb).toHaveBeenCalledWith(['metrics'])
    expect(initMetrics).toHaveBeenCalled()
    expect(result.responseResult.succeeded).toBe(true)
  })

  it('rolls back the runtime state when saving fails', async () => {
    saveToDb.mockRejectedValueOnce(new Error('save failed'))
    const resolver = await loadResolver()

    const result = await resolver.AuthenticationMutation.setMetricsState(null, { enabled: true }, null)

    expect(global.WIKI.config.metrics.isEnabled).toBe(false)
    expect(initMetrics).toHaveBeenCalledTimes(2)
    expect(result.responseResult.succeeded).toBe(false)
  })

  it('rolls back the in-memory state when metrics initialization fails', async () => {
    initMetrics.mockRejectedValueOnce(new Error('init failed'))
    const resolver = await loadResolver()

    const result = await resolver.AuthenticationMutation.setMetricsState(null, { enabled: true }, null)

    expect(global.WIKI.config.metrics.isEnabled).toBe(false)
    expect(saveToDb).not.toHaveBeenCalled()
    expect(result.responseResult.succeeded).toBe(false)
  })
})
