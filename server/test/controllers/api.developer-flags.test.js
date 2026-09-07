vi.mockModule('express', import.meta.url, () => {
  const routers = []
  const express = { Router: () => { const router = { get: vi.fn(), post: vi.fn(), put: vi.fn() }; routers.push(router); return router }, __routers: routers }
  return { default: express, ...express }
})

let store
vi.mockModule('../../operations/developer-flags.ts', import.meta.url, () => ({ getDeveloperFlagsWorkspaceStore: () => store }))

const { default: express } = await import('express')
let routes
const response = () => ({ set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn() })

beforeEach(async () => {
  global.WIKI = { auth: { checkAccess: vi.fn().mockReturnValue(true) } }
  store = {
    inspect: vi.fn().mockResolvedValue({}),
    save: vi.fn().mockResolvedValue({ revision: 'a', application: 'needs-attention' }),
    apply: vi.fn().mockResolvedValue({ applied: true, published: true })
  }
  await vi.importFresh('../../controllers/api/developer-flags.ts', import.meta.url)
  const router = express.__routers.at(-1)
  routes = Object.fromEntries(['get', 'post', 'put'].flatMap(method => router[method].mock.calls.map(([path, handler]) => [`${method} ${path}`, handler])))
})

describe('Developer flag workspace HTTP boundary', () => {
  it('requires system access and prevents caching for every workspace route', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    expect(Object.keys(routes)).toHaveLength(3)
    for (const handler of Object.values(routes)) {
      const res = response()
      await handler({ user: {} }, res)
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
      expect(res.status).toHaveBeenCalledWith(403)
    }
    expect(store.inspect).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
    expect(store.apply).not.toHaveBeenCalled()
  })

  it('forwards exact reviewed drafts and request-bound API identity without bearer credentials', async () => {
    const req = {
      user: { id: 1, ownershipUserId: null, groups: [1], authVersion: 2 },
      apiKeyAuth: { apiKeyId: 7, groupId: 1, expiresAt: 1234567890, bearerToken: 'private-api-token' },
      body: { fingerprint: 'review', policy: { ldapdebug: false, sqllog: false }, reason: 'Restore diagnostics' }
    }
    const requester = { user: req.user, apiKey: { id: 7, groupId: 1, expiresAt: 1234567890 } }
    for (const [route, method, body] of [['get /workspace', 'inspect', undefined], ['put /workspace', 'save', req.body], ['post /workspace/apply', 'apply', req.body]]) {
      const res = response()
      await routes[route](req, res)
      expect(store[method]).toHaveBeenCalledWith(...(body === undefined ? [requester] : [requester, body]))
      expect(res.json).toHaveBeenCalled()
    }
    expect(JSON.stringify(store.inspect.mock.calls)).not.toContain('private-api-token')
  })

  it('keeps conflicts actionable and suppresses raw runtime failures', async () => {
    for (const [failure, status, visible] of [
      [Object.assign(new Error('Developer flags changed'), { status: 409 }), 409, 'Developer flags changed'],
      [new Error('private database connection and query bindings'), 503, 'Developer flag administration is unavailable']
    ]) {
      store.inspect.mockRejectedValueOnce(failure)
      const res = response()
      await routes['get /workspace']({ user: { id: 1 } }, res)
      expect(res.status).toHaveBeenCalledWith(status)
      expect(res.json.mock.calls[0][0].error).toContain(visible)
      expect(JSON.stringify(res.json.mock.calls)).not.toContain('private database connection')
    }
  })
})
