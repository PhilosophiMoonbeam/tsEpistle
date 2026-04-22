describe('graph/resolvers/logging subscription contract', () => {
  beforeEach(() => {
    jest.resetModules()
    global.WIKI = {
      GQLEmitter: {
        asyncIterator: jest.fn().mockReturnValue('livetrail-iterator')
      }
    }
  })

  it('subscribes to the livetrail event stream', () => {
    const resolver = require('../../graph/resolvers/logging')

    expect(resolver.Subscription.loggingLiveTrail.subscribe()).toBe('livetrail-iterator')
    expect(global.WIKI.GQLEmitter.asyncIterator).toHaveBeenCalledWith('livetrail')
  })
})
