vi.mockModule('express', import.meta.url, () => {
  const routers = []
  const express = { Router: () => { const router = { get: vi.fn(), post: vi.fn(), put: vi.fn() }; routers.push(router); return router }, __routers: routers }
  return { default: express, ...express }
})
let store
vi.mockModule('../../operations/mail-workspace.ts', import.meta.url, () => ({ getMailWorkspaceStore: () => store }))
const { default: express } = await import('express')
let routes
const response = () => ({ set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn() })
beforeEach(async () => {
  global.WIKI = { auth: { checkAccess: vi.fn().mockReturnValue(true) } }
  store = { inspect: vi.fn().mockResolvedValue({ policy: {}, secrets: { pass: true }, checks: [] }), save: vi.fn().mockResolvedValue({ revision: 'revision', applied: true }), apply: vi.fn().mockResolvedValue({ applied: true }), preview: vi.fn().mockResolvedValue({ html: '<p>Sample</p>' }), receipt: vi.fn().mockResolvedValue({ id: 'check', state: 'succeeded' }),
    startCheck: vi.fn().mockResolvedValue({ id: 'check', state: 'running' }), configuration: { inspect: vi.fn().mockResolvedValue({}) } }
  await vi.importFresh('../../controllers/api/mail.ts', import.meta.url)
  const router = express.__routers.at(-1)
  routes = Object.fromEntries(['get', 'post', 'put'].flatMap(method => router[method].mock.calls.map(([path, handler]) => [`${method} ${path}`, handler])))
})
describe('Mail workspace HTTP boundary', () => {
  it('requires system access and prevents caching for every route', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    for (const handler of Object.values(routes)) {
      const res = response(); await handler({ user: {} }, res)
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
      expect(res.status).toHaveBeenCalledWith(403)
    }
    expect(store.inspect).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled(); expect(store.startCheck).not.toHaveBeenCalled()
  })
  it('passes current principals and exact drafts to authoritative operations', async () => {
    const req = { user: { id: 1, authVersion: 2 }, body: { fingerprint: 'review', recipient: 'fixture@example.test' }, params: { key: 'account-welcome', id: 'check' } }
    for (const [route, method, argument] of [['get /workspace', 'inspect'], ['put /workspace', 'save', req.body], ['post /workspace/apply', 'apply', req.body], ['get /templates/:key', 'preview', 'account-welcome'], ['post /checks', 'startCheck', req.body],
      ['get /checks/:id', 'receipt', 'check']]) {
      const res = response(); await routes[route](req, res)
      expect(store[method]).toHaveBeenCalledWith(...(argument === undefined ? [req.user] : [req.user, argument]))
      expect(res.json).toHaveBeenCalled()
      if (method === 'startCheck') expect(res.status).toHaveBeenCalledWith(202)
    }
  })
  it('retires every raw credential or unreviewed legacy endpoint', async () => {
    for (const route of ['get /config', 'post /config', 'post /test']) {
      const req = { user: { id: 1 } }, res = response(); await routes[route](req, res)
      expect(store.configuration.inspect).toHaveBeenCalledWith(req.user); expect(res.status).toHaveBeenCalledWith(410)
    }
    expect(store.save).not.toHaveBeenCalled(); expect(store.startCheck).not.toHaveBeenCalled()
  })
  it('retains actionable access/conflict errors and suppresses raw provider or database errors', async () => {
    for (const [error, status, visible] of [[Object.assign(new Error('Settings changed'), { status: 409 }), 409, 'Settings changed'], [new Error('smtp secret and private details'), 503, 'Mail administration is unavailable']]) {
      store.inspect.mockRejectedValueOnce(error)
      const res = response(); await routes['get /workspace']({ user: { id: 1 } }, res)
      expect(res.status).toHaveBeenCalledWith(status); expect(res.json.mock.calls[0][0].error).toContain(visible)
      expect(JSON.stringify(res.json.mock.calls)).not.toContain('smtp secret')
    }
  })
})
