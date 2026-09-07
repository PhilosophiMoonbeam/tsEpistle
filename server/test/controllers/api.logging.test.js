vi.mockModule('express', import.meta.url, () => {
  const routers = []
  const express = {
    Router: () => {
      const router = { get: vi.fn(), post: vi.fn(), put: vi.fn() }
      routers.push(router)
      return router
    },
    __routers: routers
  }
  return { default: express, ...express }
})

const { default: express } = await import('express')

describe('reviewed Logging API', () => {
  let workspace
  let systemRequester
  let access
  let transport

  beforeEach(() => {
    vi.resetModules()
    express.__routers.length = 0
    workspace = {
      inspect: vi.fn().mockResolvedValue({ fingerprint: 'f'.repeat(64) }),
      save: vi.fn().mockResolvedValue({ revision: 'save-1', applied: false }),
      apply: vi.fn().mockResolvedValue({ revision: 'apply-1', applied: true }),
      authorizeLive: vi.fn().mockResolvedValue(undefined)
    }
    systemRequester = vi.fn(req => ({ user: req.user, apiKey: req.apiKeyAuth }))
    access = vi.fn().mockReturnValue(true)
    transport = {}
    vi.mockModule('../../operations/logging.ts', import.meta.url, () => ({
      getLoggingWorkspaceStore: () => workspace,
      redactLoggingLiveOutput: value => String(value)
    }))
    vi.mockModule('../../helpers/system-authority.ts', import.meta.url, () => ({ systemRequester }))
    vi.mockModule('../../controllers/_types.ts', import.meta.url, () => ({
      errorStatus: error => error?.status,
      getTransportRuntime: () => transport,
      getWikiAuth: () => ({ checkAccess: access })
    }))
  })

  afterEach(() => {
    vi.unmockModule('../../operations/logging.ts', import.meta.url)
    vi.unmockModule('../../helpers/system-authority.ts', import.meta.url)
    vi.unmockModule('../../controllers/_types.ts', import.meta.url)
  })

  const response = () => ({
    set: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    flushHeaders: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    writableEnded: false
  })
  const handler = async (method, path) => {
    await vi.importFresh('../../controllers/api/logging.ts', import.meta.url)
    const entry = express.__routers.at(-1)[method].mock.calls.find(([registered]) => registered === path)
    return entry?.[1]
  }

  it('reads the workspace through the current authority boundary', async () => {
    const read = await handler('get', '/workspace')
    const req = { user: { id: 1 } }
    const res = response()

    await read(req, res)

    expect(access).toHaveBeenCalledWith(req.user, ['manage:system'])
    expect(systemRequester).toHaveBeenCalledWith(req)
    expect(workspace.inspect).toHaveBeenCalledWith({ user: req.user, apiKey: undefined })
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.json).toHaveBeenCalledWith({ fingerprint: 'f'.repeat(64) })
  })

  it('writes and applies only the reviewed workspace payload', async () => {
    const save = await handler('put', '/workspace')
    const apply = await handler('post', '/workspace/apply')
    const req = { user: { id: 1 }, body: { fingerprint: 'f'.repeat(64), reason: 'Rotate destination policy' } }

    await save(req, response())
    await apply(req, response())

    expect(workspace.save).toHaveBeenCalledWith({ user: req.user, apiKey: undefined }, req.body)
    expect(workspace.apply).toHaveBeenCalledWith({ user: req.user, apiKey: undefined }, req.body)
  })

  it('preserves expected conflict detail while bounding unexpected failures', async () => {
    workspace.save.mockRejectedValueOnce(Object.assign(new Error('Logging settings changed. Reload and review again.'), { status: 409 }))
    workspace.apply.mockRejectedValueOnce(new Error('private transport exception'))
    const save = await handler('put', '/workspace')
    const apply = await handler('post', '/workspace/apply')
    const req = { user: { id: 1 }, body: {} }
    const conflict = response()
    const unavailable = response()

    await save(req, conflict)
    await apply(req, unavailable)

    expect(conflict.status).toHaveBeenCalledWith(409)
    expect(conflict.json).toHaveBeenCalledWith({ error: 'Logging settings changed. Reload and review again.' })
    expect(unavailable.status).toHaveBeenCalledWith(503)
    expect(unavailable.json.mock.calls[0][0].error).not.toContain('private transport exception')
  })

  it('retires direct logger writes after revalidating authority', async () => {
    const retired = await handler('post', '/loggers')
    const req = { user: { id: 1 }, body: { loggers: [] } }
    const res = response()

    await retired(req, res)

    expect(workspace.authorizeLive).toHaveBeenCalledWith({ user: req.user, apiKey: undefined })
    expect(res.status).toHaveBeenCalledWith(410)
    expect(res.json.mock.calls[0][0].error).toContain('/_api/logging/workspace')
  })

  it('does not open a live stream when the logging trail broker is unavailable', async () => {
    const live = await handler('get', '/live')
    const res = response()

    await live({ user: { id: 1 } }, res)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(workspace.authorizeLive).not.toHaveBeenCalled()
    expect(res.flushHeaders).not.toHaveBeenCalled()
  })

  it('reserves a principal slot before authorization so a third simultaneous request is rejected', async () => {
    const live = await handler('get', '/live')
    transport.loggingLiveTrail = {
      subscribe: vi.fn(() => {
        const completion = Promise.withResolvers()
        const source = {
          pendingEvents: 0,
          pendingBytes: 0,
          next: () => completion.promise,
          return: () => {
            completion.resolve({ value: undefined, done: true })
            return Promise.resolve({ value: undefined, done: true })
          },
          [Symbol.asyncIterator] () { return this }
        }
        return source
      })
    }
    const request = () => {
      let close = () => {}
      return {
        user: { id: 1 },
        once: vi.fn((_event, listener) => { close = listener }),
        off: vi.fn(),
        close: () => close()
      }
    }
    const firstRequest = request()
    const secondRequest = request()
    const thirdRequest = request()
    const first = live(firstRequest, response())
    const second = live(secondRequest, response())

    await vi.waitFor(() => expect(transport.loggingLiveTrail.subscribe).toHaveBeenCalledTimes(2))
    const rejected = response()
    await live(thirdRequest, rejected)

    expect(rejected.status).toHaveBeenCalledWith(429)
    firstRequest.close()
    secondRequest.close()
    await Promise.all([first, second])
  })
})
