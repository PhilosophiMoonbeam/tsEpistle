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
const operations = { getConfig: vi.fn(), updateConfig: vi.fn() }
const store = { inspect: vi.fn(), save: vi.fn(), initialize: vi.fn() }
vi.mockModule('../../operations/theming.ts', import.meta.url, () => ({ default: operations }))
vi.mockModule('../../operations/theme-administration.ts', import.meta.url, () => ({ getThemeAdministrationStore: () => store }))
const { default: express } = await import('express')
const { configureTransportRuntime } = await import('../../controllers/_types.ts')
let routes
const response = () => { const res = { status: vi.fn(), json: vi.fn(), sendStatus: vi.fn(), set: vi.fn() }; res.status.mockReturnValue(res); return res }
beforeEach(async () => {
  for (const mock of [...Object.values(operations), ...Object.values(store)]) mock.mockReset()
  express.__routers.length = 0
  global.WIKI = { auth: { checkAccess: vi.fn().mockReturnValue(true) } }
  configureTransportRuntime({ auth: global.WIKI.auth })
  await vi.importFresh('../../controllers/api/theming.ts', import.meta.url)
  const router = express.__routers.at(-1)
  routes = Object.fromEntries(['get', 'put', 'post'].flatMap(method => router[method].mock.calls.map(([path, handler]) => [method + path, handler])))
})
afterAll(() => configureTransportRuntime({}))
describe('Theme configuration and reviewed workspace API', () => {
  it('enforces permission before inspecting or mutating', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    for (const [key, handler] of Object.entries(routes)) {
      const res = response()
      await handler({ user: { id: 3 } }, res)
      expect(key === 'get/config' ? res.sendStatus : res.status).toHaveBeenCalledWith(403)
    }
    expect(store.inspect).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled(); expect(operations.updateConfig).not.toHaveBeenCalled()
  })
  it('passes the authenticated principal and reviewed fields to the durable store', async () => {
    const req = {
      user: { id: 7 },
      body: { policy: { theme: 'default' }, fingerprint: 'review', reason: 'Improve reading', ignored: 'not persisted' }
    }, res = response()
    store.save.mockResolvedValue({ activation: 'applied' })
    await routes['put/workspace'](req, res)
    expect(store.save).toHaveBeenCalledWith(req.user, {
      policy: req.body.policy,
      fingerprint: req.body.fingerprint,
      reason: req.body.reason
    })
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.json).toHaveBeenCalledWith({ activation: 'applied' })
  })
  it('returns conflicts and redacts unexpected errors', async () => {
    const req = { user: { id: 7 }, body: {} }
    store.save.mockRejectedValue(Object.assign(new Error('Reload the saved review.'), { status: 409 }))
    const conflict = response(); await routes['put/workspace'](req, conflict)
    expect(conflict.status).toHaveBeenCalledWith(409); expect(conflict.json).toHaveBeenCalledWith({ error: 'Reload the saved review.' })
    store.save.mockRejectedValue(new Error('postgres://private-database-detail'))
    const failure = response(); await routes['put/workspace'](req, failure)
    expect(failure.status).toHaveBeenCalledWith(500); expect(JSON.stringify(failure.json.mock.calls)).not.toContain('private-database-detail')
  })
  it('returns forbidden for custom source changes through reviewed and compatibility REST paths', async () => {
    const forbidden = Object.assign(new Error('Full system administration is required to change custom theme code.'), { status: 403 })
    store.save.mockRejectedValue(forbidden)
    const workspace = response()
    await routes['put/workspace']({ user: { id: 7 }, body: { policy: {}, fingerprint: 'review', reason: 'Change source' } }, workspace)
    expect(workspace.status).toHaveBeenCalledWith(403)
    expect(workspace.json).toHaveBeenCalledWith({ error: forbidden.message })
    operations.updateConfig.mockRejectedValue(forbidden)
    const compatibility = response()
    await routes['post/config']({ user: { id: 7 }, body: { injectCSS: '' } }, compatibility)
    expect(compatibility.status).toHaveBeenCalledWith(403)
    expect(compatibility.json).toHaveBeenCalledWith({ error: forbidden.message })
  })
  it('passes legacy writes through current authority checks', async () => {
    const req = { user: { id: 7 }, body: { theme: 'default' } }, res = response()
    operations.updateConfig.mockResolvedValue(undefined)
    await routes['post/config'](req, res)
    expect(operations.updateConfig).toHaveBeenCalledWith(req.body, req.user)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.json).toHaveBeenCalledWith({ message: 'Theme config updated' })
  })
  it('supports current workspace inspection and runtime recovery', async () => {
    const req = { user: { id: 7 }, body: { fingerprint: 'review' } }
    store.inspect.mockResolvedValue({ fingerprint: 'review' }); store.initialize.mockResolvedValue({ activation: 'needs-attention' })
    const get = response(); await routes['get/workspace'](req, get); expect(get.json).toHaveBeenCalledWith({ fingerprint: 'review' })
    const activate = response(); await routes['post/workspace/activate'](req, activate); expect(store.initialize).toHaveBeenCalledWith(req.user, 'review')
  })
})
