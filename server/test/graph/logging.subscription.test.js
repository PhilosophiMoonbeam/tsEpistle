describe('reviewed logging GraphQL adapters', () => {
  let workspace
  let broker

  beforeEach(() => {
    vi.resetModules()
    workspace = {
      authorizeLive: vi.fn().mockResolvedValue(undefined),
      save: vi.fn(),
      apply: vi.fn(),
      inspect: vi.fn().mockResolvedValue({
        destinations: [{
          key: 'sentry',
          title: 'Sentry',
          description: 'Error tracking',
          logo: null,
          website: null,
          isEnabled: true,
          level: 'warn',
          config: { endpoint: 'diagnostics.example.test' },
          secrets: { key: true, password: false },
          fields: [
            { key: 'key', title: 'DSN', hint: null, type: 'string', sensitive: true, required: false, enum: null },
            { key: 'endpoint', title: 'Endpoint', hint: 'Diagnostic host', type: 'string', sensitive: false, required: false, enum: null },
            { key: 'password', title: 'Password', hint: null, type: 'string', sensitive: true, required: false, enum: null }
          ]
        }]
      })
    }
    broker = {
      subscribe: vi.fn().mockImplementation(() => (async function * () {
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
    await stream.return()

    const revokedStream = await resolver.Subscription.loggingLiveTrail.subscribe(undefined, undefined, context)
    const revokedSource = broker.subscribe.mock.results.at(-1).value
    const closeSource = vi.spyOn(revokedSource, 'return')
    const denied = new Error('Access revoked')
    workspace.authorizeLive.mockRejectedValueOnce(denied)

    await expect(revokedStream.next()).rejects.toBe(denied)
    expect(closeSource).toHaveBeenCalledOnce()
    expect(await revokedStream.next()).toEqual({ value: undefined, done: true })
  })

  it('projects public diagnostics, masks configured secrets, and leaves unset secrets empty', async () => {
    const { default: createResolver } = await vi.importFresh('../../graph/resolvers/logging.ts', import.meta.url)
    const resolver = createResolver({ loggingLiveTrail: broker })
    const context = { req: { user: { id: 1 } } }

    const loggers = await resolver.LoggingQuery.loggers(undefined, { orderBy: 'key' }, context)

    expect(workspace.inspect).toHaveBeenCalledWith({ user: context.req.user })
    expect(JSON.parse(loggers[0].config[0].value)).toMatchObject({ sensitive: true, value: '********' })
    expect(JSON.parse(loggers[0].config[1].value)).toEqual({
      type: 'string',
      title: 'Endpoint',
      hint: 'Diagnostic host',
      sensitive: false,
      value: 'diagnostics.example.test'
    })
    expect(JSON.parse(loggers[0].config[2].value)).toMatchObject({ sensitive: true, value: '' })
  })

  it('returns a schema-shaped error for the retired direct mutation', async () => {
    const { default: createResolver } = await vi.importFresh('../../graph/resolvers/logging.ts', import.meta.url)
    const resolver = createResolver({ loggingLiveTrail: broker })

    const result = await resolver.LoggingMutation.updateLoggers(undefined, { loggers: [] }, { req: { user: { id: 1 } } })

    expect(result.responseResult).toMatchObject({ succeeded: false, errorCode: 1, slug: 'APPLICATION_ERROR' })
    expect(workspace.inspect).not.toHaveBeenCalled()
    expect(workspace.save).not.toHaveBeenCalled()
    expect(workspace.apply).not.toHaveBeenCalled()
  })
})
