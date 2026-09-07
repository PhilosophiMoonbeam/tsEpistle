vi.mockModule('express', import.meta.url, () => {
  const routers = []
  const express = { Router: () => { const router = { get: vi.fn(), post: vi.fn(), put: vi.fn() }; routers.push(router); return router }, __routers: routers }
  return { default: express, ...express }
})
let store
vi.mockModule('../../operations/tls-workspace.ts', import.meta.url, () => ({ getTlsWorkspaceStore: () => store }))
const { default: express } = await import('express')
let routes
const response = () => ({ set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn() })
beforeEach(async () => {
  global.WIKI = { auth: { checkAccess: vi.fn().mockReturnValue(true) } }
  store = { inspect: vi.fn().mockResolvedValue({ operations: [] }), save: vi.fn().mockResolvedValue({ applied: true }), applyPolicy: vi.fn().mockResolvedValue({ applied: true }), start: vi.fn().mockResolvedValue({ id: 'operation', state: 'running' }), receipt: vi.fn().mockResolvedValue({ id: 'operation', state: 'succeeded' }) }
  await vi.importFresh('../../controllers/api/tls.ts', import.meta.url)
  const router = express.__routers.at(-1)
  routes = Object.fromEntries(['get', 'post', 'put'].flatMap(method => router[method].mock.calls.map(([path, handler]) => [`${method} ${path}`, handler])))
})
describe('HTTPS workspace HTTP boundary', () => {
  it('requires system access and disables caching on every route', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    expect(Object.keys(routes)).toHaveLength(5)
    for (const handler of Object.values(routes)) {
      const res = response(); await handler({ user: {} }, res)
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
      expect(res.status).toHaveBeenCalledWith(403)
    }
    for (const operation of Object.values(store)) expect(operation).not.toHaveBeenCalled()
  })
  it('passes exact browser drafts and request IDs to the authoritative store', async () => {
    const req = { user: { id: 1, authVersion: 2 }, body: { fingerprint: 'review', id: 'operation' }, params: { id: 'operation' } }
    for (const [route, method, argument] of [['get /workspace', 'inspect'], ['put /workspace', 'save', req.body], ['post /workspace/apply', 'applyPolicy', req.body], ['post /operations', 'start', req.body], ['get /operations/:id', 'receipt', 'operation']]) {
      const res = response(); await routes[route](req, res)
      expect(store[method]).toHaveBeenCalledWith(...(argument === undefined ? [{ user: req.user }] : [{ user: req.user }, argument]))
      expect(res.json).toHaveBeenCalled()
      if (method === 'start') expect(res.status).toHaveBeenCalledWith(202)
    }
  })
  it('forwards request-bound API identity without copying its bearer token', async () => {
    const req = { user: { id: 1, ownershipUserId: null, groups: [1] }, apiKeyAuth: { apiKeyId: 7, groupId: 1, expiresAt: 1234567890, bearerToken: 'private-api-token' } }
    await routes['get /workspace'](req, response())
    expect(store.inspect).toHaveBeenCalledWith({ user: req.user, apiKey: { id: 7, groupId: 1, expiresAt: 1234567890 } })
    expect(JSON.stringify(store.inspect.mock.calls)).not.toContain('private-api-token')
  })
  it('preserves reviewed conflicts while suppressing raw database or provider failures', async () => {
    for (const [error, status, message] of [[Object.assign(new Error('Settings changed'), { status: 409 }), 409, 'Settings changed'], [new Error('private database credential'), 503, 'HTTPS administration is unavailable']]) {
      store.inspect.mockRejectedValueOnce(error)
      const res = response(); await routes['get /workspace']({ user: { id: 1 } }, res)
      expect(res.status).toHaveBeenCalledWith(status)
      expect(res.json.mock.calls[0][0].error).toContain(message)
      expect(JSON.stringify(res.json.mock.calls)).not.toContain('private database credential')
    }
  })
})
