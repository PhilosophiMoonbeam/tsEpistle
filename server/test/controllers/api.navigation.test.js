const realExpress = (await import('express')).default

vi.mockModule('express', import.meta.url, () => {
  const routers = []
  const express = {
    Router: () => {
      const router = {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        put: vi.fn(),
        delete: vi.fn(),
        use: vi.fn()
      }
      routers.push(router)
      return router
    },
    __routers: routers
  }

  return { default: express, ...express }
})

const operations = { get: vi.fn(), update: vi.fn() }
const store = { inspect: vi.fn(), save: vi.fn(), initialize: vi.fn() }
vi.mockModule('../../operations/navigation.ts', import.meta.url, () => ({ default: operations }))
vi.mockModule('../../operations/navigation-administration.ts', import.meta.url, () => ({ getNavigationAdministrationStore: () => store }))
const { default: express } = await import('express')

const API_CONTROLLER_NAMES = [
  'analytics',
  'assets',
  'auth',
  'comments',
  'groups',
  'locales',
  'logging',
  'mail',
  'navigation',
  'pages',
  'rendering',
  'search',
  'site',
  'storage',
  'system',
  'theming',
  'users'
]

const loadApiIndexRouter = async () => {
  const subrouters = Object.fromEntries(API_CONTROLLER_NAMES.map(name => [name, {}]))

  for (const name of API_CONTROLLER_NAMES) {
    vi.mockModule(`../../controllers/api/${name}.ts`, import.meta.url, () => ({
      default: subrouters[name]
    }))
  }

  try {
    expect(await vi.importFresh('../../controllers/api/index.ts', import.meta.url)).toBeDefined()
  } finally {
    for (const name of API_CONTROLLER_NAMES) {
      vi.unmockModule(`../../controllers/api/${name}.ts`, import.meta.url)
    }
  }

  return { apiRouter: express.__routers.at(-1), subrouters }
}

let routes
const response = () => { const res = { status: vi.fn(), json: vi.fn(), set: vi.fn() }; res.status.mockReturnValue(res); return res }
beforeEach(async () => {
  express.__routers.length = 0
  global.WIKI = { auth: { checkAccess: vi.fn().mockReturnValue(true) } }
  await vi.importFresh('../../controllers/api/navigation.ts', import.meta.url)
  const router = express.__routers[0]
  routes = Object.fromEntries(['get', 'put', 'post'].flatMap(method => router[method].mock.calls.map(([path, handler]) => [method + path, handler])))
})
describe('Navigation workspace and compatibility API', () => {
  it('checks permission before any inspection or write', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    for (const handler of Object.values(routes)) { const res = response(); await handler({ user: { id: 3 } }, res); expect(res.status).toHaveBeenCalledWith(403) }
    expect(store.inspect).not.toHaveBeenCalled(); expect(store.save).not.toHaveBeenCalled(); expect(operations.update).not.toHaveBeenCalled()
    expect(operations.get).not.toHaveBeenCalled(); expect(store.initialize).not.toHaveBeenCalled()
  })
  it('passes the current actor and review values to the durable store', async () => {
    const req = { user: { id: 7 }, body: { policy: { mode: 'STATIC' }, fingerprint: 'review', reason: 'Clarify navigation' } }, res = response()
    store.save.mockResolvedValue({ activation: 'applied' }); await routes['put/workspace'](req, res)
    expect(store.save).toHaveBeenCalledWith(req.user, req.body); expect(res.json).toHaveBeenCalledWith({ activation: 'applied' }); expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
  it('reports conflicts and redacts unexpected infrastructure errors', async () => {
    const req = { user: { id: 7 }, body: {} }, conflict = response()
    store.save.mockRejectedValue(Object.assign(new Error('Reload the reviewed navigation.'), { status: 409 })); await routes['put/workspace'](req, conflict)
    expect(conflict.status).toHaveBeenCalledWith(409); expect(conflict.json).toHaveBeenCalledWith({ error: 'Reload the reviewed navigation.' })
    store.save.mockRejectedValue(new Error('private-database-connection')); const failure = response(); await routes['put/workspace'](req, failure)
    expect(failure.status).toHaveBeenCalledWith(500); expect(JSON.stringify(failure.json.mock.calls)).not.toContain('private-database-connection')
  })
  it('keeps compatibility reads and writes behind current authority', async () => {
    const req = { user: { id: 7 }, body: { mode: 'TREE', tree: [], expandParent: true } }, res = response()
    operations.get.mockResolvedValue({ config: { mode: 'TREE' }, tree: [] }); await routes['get/'](req, res); expect(operations.get).toHaveBeenCalledWith(req.user)
    operations.update.mockResolvedValue(undefined); await routes['put/'](req, res); expect(operations.update).toHaveBeenCalledWith(req.body, req.user)
  })
  it('supports workspace inspection and runtime recovery', async () => {
    const req = { user: { id: 7 }, body: { fingerprint: 'review' } }, res = response()
    store.inspect.mockResolvedValue({ fingerprint: 'review' }); await routes['get/workspace'](req, res); expect(res.json).toHaveBeenCalledWith({ fingerprint: 'review' })
    store.initialize.mockResolvedValue({ activation: 'needs-attention' }); await routes['post/workspace/activate'](req, res); expect(store.initialize).toHaveBeenCalledWith(req.user, 'review')
  })
  it('denies unauthorized navigation workspace requests through the API index over HTTP', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    const indexUrl = new URL('../../controllers/api/index.ts', import.meta.url)
    const imports = new Bun.Transpiler({ loader: 'ts' }).scan(await Bun.file(indexUrl).text()).imports
    for (const { path } of imports) {
      if (path.startsWith('./') && path !== './navigation.ts') {
        vi.mockModule(new URL(path, indexUrl).href, import.meta.url, () => ({ default: realExpress.Router() }))
      }
    }
    vi.mockModule('express', import.meta.url, () => ({ default: realExpress, ...realExpress }))
    let server
    try {
      const { default: apiRouter } = await vi.importFresh('../../controllers/api/index.ts', import.meta.url)
      const user = { id: 3 }
      const app = realExpress()
      app.use((req, _res, next) => { req.user = user; next() })
      app.use('/_api', apiRouter)
      server = app.listen(0, '127.0.0.1')
      await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Navigation test server did not bind a TCP port')
      const denied = await fetch(`http://127.0.0.1:${address.port}/_api/navigation/workspace`)
      expect(denied.status).toBe(403)
      expect(await denied.json()).toEqual({ error: 'Navigation administration is required.' })
      expect(denied.headers.get('cache-control')).toBe('no-store')
      expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(user, ['manage:navigation', 'manage:system'])
      expect(store.inspect).not.toHaveBeenCalled()
    } finally {
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      vi.mockModule('express', import.meta.url, () => ({ default: express, ...express }))
    }
  })
  it('is mounted by the API index router', async () => { const { apiRouter, subrouters } = await loadApiIndexRouter(); expect(apiRouter.use).toHaveBeenCalledWith('/navigation', subrouters.navigation) })
})
