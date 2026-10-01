const store = { inspect: vi.fn(), save: vi.fn(), configuration: { inspect: vi.fn() }, actions: { enqueue: vi.fn(), decide: vi.fn() } }
vi.mockModule('../../operations/storage-workspace-runtime.ts', import.meta.url, () => ({ getStorageWorkspaceStore: () => store }))
vi.mockModule('express', import.meta.url, () => {
  const router = { get: vi.fn(), post: vi.fn(), put: vi.fn(), use: vi.fn() }
  return { default: { Router: () => router, __router: router } }
})
const { default: express } = await import('express')
const user = { id: 1, authVersion: 0 },
  response = () => ({ set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn() })
beforeEach(() => {
  global.WIKI = { auth: { checkAccess: vi.fn(() => true) } }
  store.inspect.mockResolvedValue({ targets: [], runtime: [], operations: [] })
  store.save.mockResolvedValue({ revision: 'saved', operation: null })
  store.configuration.inspect.mockResolvedValue({})
  store.actions.enqueue.mockResolvedValue({ id: 'operation', jobId: 'job' })
  store.actions.decide.mockResolvedValue(undefined)
})
const handlers = async () => {
  await vi.importFresh('../../controllers/api/storage.ts', import.meta.url)
  return Object.fromEntries(
    ['get', 'post', 'put'].flatMap(method => express.__router[method].mock.calls.map(([path, handler]) => [method + ' ' + path, handler]))
  )
}
describe('Reviewed Storage HTTP endpoints', () => {
  it('passes current principals and complete immutable reviews to the authoritative stores', async () => {
    const routes = await handlers(),
      body = { targets: [], fingerprint: 'review', reason: 'Reviewed publication', apply: true }
    let res = response()
    await routes['get /workspace']({ user }, res)
    expect(store.inspect).toHaveBeenCalledWith(user)
    res = response()
    await routes['put /workspace']({ user, body }, res)
    expect(store.save).toHaveBeenCalledWith(user, { targets: [], fingerprint: 'review', reason: 'Reviewed publication' }, true)
    const action = { targetKey: 'disk', handler: 'dump', fingerprint: 'review', reason: 'Reviewed export', confirmation: 'EXPORT CONTENT' }
    res = response()
    await routes['post /operations']({ user, body: action }, res)
    expect(store.actions.enqueue).toHaveBeenCalledWith(user, action)
    expect(res.status).toHaveBeenCalledWith(202)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
  it('uses the addressed receipt when cancelling or resolving, ignoring a body ID', async () => {
    const routes = await handlers()
    for (const kind of ['cancel', 'resolve']) {
      const res = response()
      await routes[`post /operations/:id/${kind}`](
        { user, params: { id: 'addressed' }, body: { id: 'other', reason: 'Decision', fingerprint: 'review', confirmation: 'CHECKED' } },
        res
      )
      expect(store.actions.decide).toHaveBeenCalledWith(user, { id: 'addressed', reason: 'Decision', fingerprint: 'review', confirmation: 'CHECKED' }, kind)
    }
  })
  it('denies all endpoints before reading configuration or operation details', async () => {
    const routes = await handlers()
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    for (const handler of Object.values(routes)) {
      const res = response()
      await handler({ user, params: { id: 'operation' }, body: {} }, res)
      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    }
    expect(store.inspect).not.toHaveBeenCalled()
    expect(store.configuration.inspect).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
    expect(store.actions.enqueue).not.toHaveBeenCalled()
    expect(store.actions.decide).not.toHaveBeenCalled()
  })
  it('requires an explicit application choice and rejects an ambiguous settings publication', async () => {
    const routes = await handlers()
    for (const apply of [undefined, 'true', 1]) {
      const res = response()
      await routes['put /workspace']({ user, body: { apply } }, res)
      expect(res.status).toHaveBeenCalledWith(400)
    }
    expect(store.save).not.toHaveBeenCalled()
  })
  it('preserves expected conflicts and redacts unexpected failures', async () => {
    const routes = await handlers()
    store.save.mockRejectedValue(Object.assign(Error('Settings changed. Reload.'), { status: 409 }))
    let res = response()
    await routes['put /workspace']({ user, body: { apply: true } }, res)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'Settings changed. Reload.' })
    store.inspect.mockRejectedValue(Error('database password private-secret'))
    res = response()
    await routes['get /workspace']({ user }, res)
    expect(res.status).toHaveBeenCalledWith(503)
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('private-secret')
  })
  it('retires all previous private endpoints without allowing unreviewed mutations or raw runtime state reads', async () => {
    const routes = await handlers()
    for (const route of ['get /targets', 'get /status', 'put /targets', 'post /actions/execute']) {
      const res = response()
      await routes[route]({ user, body: { targets: [], targetKey: 'disk', handler: 'dump' } }, res)
      expect(res.status).toHaveBeenCalledWith(410)
    }
    expect(store.configuration.inspect).toHaveBeenCalledTimes(4)
    expect(store.save).not.toHaveBeenCalled()
    expect(store.actions.enqueue).not.toHaveBeenCalled()
    store.configuration.inspect.mockRejectedValue(Object.assign(Error('Current access required.'), { status: 403 }))
    const res = response()
    await routes['get /targets']({ user }, res)
    expect(res.status).toHaveBeenCalledWith(403)
  })
})
