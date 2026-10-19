import express from 'express'

const operations = { get: vi.fn(), update: vi.fn() }
const store = { inspect: vi.fn(), save: vi.fn(), initialize: vi.fn(), inspectMovedPage: vi.fn(), repairMovedPage: vi.fn() }
vi.mockModule('../../operations/navigation.ts', import.meta.url, () => ({ default: operations }))
vi.mockModule('../../operations/navigation-administration.ts', import.meta.url, () => ({ getNavigationAdministrationStore: () => store }))

const originalWiki = global.WIKI
const actor = { id: 7 }
let server, baseUrl

const request = async (path, method = 'GET', body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  })
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('content-type')).toContain('application/json')
  return { status: response.status, body: await response.json() }
}

beforeEach(async () => {
  for (const operation of [...Object.values(operations), ...Object.values(store)]) operation.mockReset()
  global.WIKI = { auth: { checkAccess: vi.fn().mockReturnValue(true) } }
  const { default: router } = await vi.importFresh('../../controllers/api/navigation.ts', import.meta.url)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.user = actor; next() })
  app.use('/_api/navigation', router)
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Navigation test server did not bind a TCP port')
  baseUrl = `http://127.0.0.1:${address.port}/_api/navigation`
})

afterEach(async () => {
  try {
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } finally {
    server = undefined
    global.WIKI = originalWiki
  }
})

afterAll(() => {
  vi.unmockModule('../../operations/navigation.ts', import.meta.url)
  vi.unmockModule('../../operations/navigation-administration.ts', import.meta.url)
})

describe('Navigation workspace and compatibility API over HTTP', () => {
  it('checks current authority before any inspection or write', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    for (const [method, path] of [
      ['GET', '/'], ['PUT', '/'], ['GET', '/workspace'], ['PUT', '/workspace'],
      ['POST', '/workspace/activate'], ['POST', '/workspace/move-review'], ['POST', '/workspace/move-repair']
    ]) {
      expect(await request(path, method, method === 'GET' ? undefined : {})).toEqual({
        status: 403, body: { error: 'Navigation administration is required.' }
      })
    }
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledTimes(7)
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(actor, ['manage:navigation', 'manage:system'])
    for (const operation of [...Object.values(operations), ...Object.values(store)]) expect(operation).not.toHaveBeenCalled()
  })

  it('saves parsed review values for the current actor and serializes the durable result', async () => {
    const body = { policy: { mode: 'STATIC' }, fingerprint: 'review', reason: 'Clarify navigation' }
    store.save.mockResolvedValue({ activation: 'applied' })
    expect(await request('/workspace', 'PUT', body)).toEqual({ status: 200, body: { activation: 'applied' } })
    expect(store.save).toHaveBeenCalledWith(actor, body)
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(actor, ['manage:navigation', 'manage:system'])
  })

  it('preserves typed conflicts but sanitizes unexpected infrastructure errors', async () => {
    store.save.mockRejectedValueOnce(Object.assign(new Error('Reload the reviewed navigation.'), { status: 409 }))
    expect(await request('/workspace', 'PUT', {})).toEqual({ status: 409, body: { error: 'Reload the reviewed navigation.' } })
    store.save.mockRejectedValueOnce(new Error('private-database-connection'))
    expect(await request('/workspace', 'PUT', {})).toEqual({
      status: 500,
      body: { error: 'Navigation administration is temporarily unavailable. Reload to confirm saved settings.' }
    })
  })

  it('reads and updates compatibility navigation with current authority', async () => {
    const navigation = { config: { mode: 'TREE' }, tree: [] }
    operations.get.mockResolvedValue(navigation)
    expect(await request('/')).toEqual({ status: 200, body: navigation })
    expect(operations.get).toHaveBeenCalledWith(actor)
    const body = { mode: 'TREE', tree: [], expandParent: true }
    operations.update.mockResolvedValue(undefined)
    expect(await request('/', 'PUT', body)).toEqual({ status: 200, body: { message: 'Navigation saved successfully.' } })
    expect(operations.update).toHaveBeenCalledWith(body, actor)
  })

  it('inspects the workspace and activates the reviewed fingerprint for the current actor', async () => {
    store.inspect.mockResolvedValue({ fingerprint: 'review' })
    expect(await request('/workspace')).toEqual({ status: 200, body: { fingerprint: 'review' } })
    expect(store.inspect).toHaveBeenCalledWith(actor)
    store.initialize.mockResolvedValue({ activation: 'needs-attention' })
    expect(await request('/workspace/activate', 'POST', { fingerprint: 'review' })).toEqual({ status: 200, body: { activation: 'needs-attention' } })
    expect(store.initialize).toHaveBeenCalledWith(actor, 'review')
  })
})
