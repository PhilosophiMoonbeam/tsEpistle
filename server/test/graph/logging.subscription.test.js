describe('graph/resolvers/logging subscription contract', () => {
  let previousWiki

  beforeEach(() => {
    vi.resetModules()
    previousWiki = global.WIKI
    global.WIKI = {
      GQLEmitter: {
        asyncIterableIterator: vi.fn().mockReturnValue('livetrail-iterator')
      },
      data: {
        loggers: []
      },
      models: {
        loggers: {}
      }
    }
  })

  afterEach(() => {
    global.WIKI = previousWiki
  })

  it('subscribes to the livetrail event stream', async () => {
    const { default: resolver } = await import('../../graph/resolvers/logging.ts')

    expect(resolver.Subscription.loggingLiveTrail.subscribe()).toBe('livetrail-iterator')
    expect(global.WIKI.GQLEmitter.asyncIterableIterator).toHaveBeenCalledWith('livetrail')
  })
})
