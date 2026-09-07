describe('reviewed logging GraphQL adapters', () => {
  let workspace
  let broker

  beforeEach(() => {
    vi.resetModules()
    workspace = {
      authorizeLive: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({
        destinations: [{
          key: 'sentry',
          title: 'Sentry',
          description: 'Error tracking',
          logo: null,
          website: null,
          isEnabled: true,
          level: 'warn',
          config: {},
          secrets: { key: true },
          fields: [{ key: 'key', title: 'DSN', hint: null, type: 'string', sensitive: true, required: false, enum: null }]
        }]
      })
    }
    broker = {
      subscribe: vi.fn().mockReturnValue((async function * () {
        yield {
          type: 'line',
          line: {
            timestamp: new Date('2026-02-01T00:00:00.000Z'),
            level: 'warn',
            output: 'token=private-token'
          }
        }
      })())
    }
    vi.mockModule('../../operations/logging.ts', import.meta.url, () => ({
      getLoggingWorkspaceStore: () => workspace,
      redactLoggingLiveOutput: value => String(value).replace(/token=[^\s]+/g, 'token=[redacted]')
    }))
  })

  afterEach(() => vi.unmockModule('../../operations/logging.ts', import.meta.url))

  it('revalidates a subscription before it can receive a redacted live record', async () => {
    const { default: createResolver } = await vi.importFresh('../../graph/resolvers/logging.ts', import.meta.url)
    const resolver = createResolver({ loggingLiveTrail: broker })
    const context = { req: { user: { id: 1 } } }

    const stream = await resolver.Subscription.loggingLiveTrail.subscribe(undefined, undefined, context)
    const event = await stream.next()

    expect(workspace.authorizeLive).toHaveBeenCalledWith({ user: context.req.user })
    expect(broker.subscribe).toHaveBeenCalledTimes(1)
    expect(event.value.loggingLiveTrail.output).toBe('token=[redacted]')
  })

  it('projects the legacy read adapter without exposing stored credentials', async () => {
    const { default: createResolver } = await vi.importFresh('../../graph/resolvers/logging.ts', import.meta.url)
    const resolver = createResolver({ loggingLiveTrail: broker })
    const context = { req: { user: { id: 1 } } }

    const loggers = await resolver.LoggingQuery.loggers(undefined, { orderBy: 'key' }, context)

    expect(workspace.inspect).toHaveBeenCalledWith({ user: context.req.user })
    expect(JSON.stringify(loggers)).not.toContain('private-token')
    expect(JSON.parse(loggers[0].config[0].value)).toMatchObject({ sensitive: true, value: '********' })
  })

  it('returns a schema-shaped error for the retired direct mutation', async () => {
    const { default: createResolver } = await vi.importFresh('../../graph/resolvers/logging.ts', import.meta.url)
    const resolver = createResolver({ loggingLiveTrail: broker })

    const result = await resolver.LoggingMutation.updateLoggers(undefined, { loggers: [] }, { req: { user: { id: 1 } } })

    expect(result.responseResult.succeeded).toBe(false)
    expect(result.responseResult.message).toContain('reviewed workspace')
    expect(workspace.inspect).not.toHaveBeenCalled()
  })
})
