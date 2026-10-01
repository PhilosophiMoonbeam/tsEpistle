import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_controller_locales_test', import.meta.path)

if (!connection) {
const store = { inspect: vi.fn(), save: vi.fn(), initialize: vi.fn(), enqueue: vi.fn() }
vi.mockModule('../../operations/locale-administration.ts', import.meta.url, () => ({ getLocaleAdministrationStore: () => store }))
vi.mockModule('express', import.meta.url, () => { const router = { get: vi.fn(), post: vi.fn(), put: vi.fn(), use: vi.fn() }; return { default: { Router: () => router, __router: router } } })
const { default: express } = await import('express')
const originalWiki = global.WIKI
const policy = { locale: 'en', autoUpdate: true, namespacing: false, namespaces: [] }
const response = () => ({ json: vi.fn(), status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis() })
beforeEach(() => {
  global.WIKI = { auth: { checkAccess: vi.fn(() => true) }, config: { lang: { code: 'en', ...policy } }, cache: { get: vi.fn().mockResolvedValue([{ code: 'fr', name: 'French' }]) }, models: { locales: { query: () => ({ select: async () => [{ code: 'en', name: 'English' }] }) } }, lang: { getByNamespace: vi.fn().mockResolvedValue([{ key: 'title', value: 'Hello' }]) } }
  store.inspect.mockResolvedValue({ policy, fingerprint: 'current', history: [], locales: [], operations: [] }); store.save.mockResolvedValue({ activation: 'applied' }); store.initialize.mockResolvedValue({ activation: 'applied' }); store.enqueue.mockResolvedValue({ jobId: 'queued-job' })
})
afterEach(() => { global.WIKI = originalWiki })
const handlers = async () => {
  await vi.importFresh('../../controllers/api/locales.ts', import.meta.url)
  return Object.fromEntries(['get', 'post', 'put'].flatMap(method => express.__router[method].mock.calls.map(([path, handler]) => [method + ' ' + path, handler])))
}
describe('Locale API boundaries', () => {
  it('requires system administration and disables caching for every administrative endpoint', async () => {
    const routes = await handlers(); global.WIKI.auth.checkAccess.mockReturnValue(false)
    for (const name of ['get /workspace', 'put /workspace', 'post /workspace/activate', 'post /workspace/operations', 'get /config', 'post /config', 'post /:code/download']) {
      const res = response(); await routes[name]({ user: { id: 3 }, body: {}, params: { code: 'fr' } }, res)
      expect(res.status).toHaveBeenCalledWith(403); expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    }
    expect(store.inspect).not.toHaveBeenCalled(); expect(store.enqueue).not.toHaveBeenCalled()
  })
  it('passes the current principal, frozen policy, fingerprint and reason to the reviewed store', async () => {
    const routes = await handlers(), user = { id: 1 }, body = { policy, fingerprint: 'review', reason: 'Reviewed settings' }, res = response()
    await routes['put /workspace']({ user, body }, res)
    expect(store.save).toHaveBeenCalledWith(user, body); expect(res.json).toHaveBeenCalledWith({ activation: 'applied' })
  })
  it('returns durable operation acceptance and routes compatibility downloads through the same store', async () => {
    const routes = await handlers(), user = { id: 1 }, res = response()
    await routes['post /workspace/operations']({ user, body: { kind: 'install', code: 'fr', fingerprint: 'review', reason: 'Install French' } }, res)
    expect(res.status).toHaveBeenCalledWith(202); expect(res.json).toHaveBeenCalledWith({ jobId: 'queued-job' })
    const legacy = response(); await routes['post /:code/download']({ user, params: { code: 'fr' } }, legacy)
    expect(legacy.status).toHaveBeenCalledWith(202); expect(store.enqueue).toHaveBeenLastCalledWith(user, expect.objectContaining({ code: 'fr', fingerprint: 'current' }))
    expect(legacy.json).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'queued-job', message: expect.stringContaining('queued') }))
  })
  it('routes compatibility settings through validation and current authority', async () => {
    const routes = await handlers(), user = { id: 1 }, res = response()
    await routes['post /config']({ user, body: policy }, res)
    expect(store.save).toHaveBeenCalledWith(user, expect.objectContaining({ policy, fingerprint: 'current' }))
    const invalid = response(); await routes['post /config']({ user, body: { locale: 'en' } }, invalid); expect(invalid.status).toHaveBeenCalledWith(400)
  })
  it('preserves expected conflicts and redacts unexpected server failures', async () => {
    const routes = await handlers()
    store.inspect.mockRejectedValueOnce(Object.assign(new Error('Settings changed'), { status: 409 }))
    const conflict = response(); await routes['get /workspace']({ user: { id: 1 } }, conflict); expect(conflict.status).toHaveBeenCalledWith(409); expect(conflict.json).toHaveBeenCalledWith({ error: 'Settings changed' })
    store.inspect.mockRejectedValueOnce(new Error('secret database detail'))
    const failed = response(); await routes['get /workspace']({ user: { id: 1 } }, failed); expect(failed.status).toHaveBeenCalledWith(500); expect(JSON.stringify(failed.json.mock.calls)).not.toContain('secret')
  })
  it('retains installed locales missing remotely and serves public translation strings', async () => {
    const routes = await handlers(), list = response(); await routes['get /']({}, list)
    expect(list.json).toHaveBeenCalledWith([expect.objectContaining({ code: 'fr', isInstalled: false }), expect.objectContaining({ code: 'en', isInstalled: true })])
    const strings = response(); await routes['get /:code/strings']({ query: { namespace: 'common' }, params: { code: 'en' } }, strings)
    expect(strings.json).toHaveBeenCalledWith([{ key: 'title', value: 'Hello' }])
  })
})
} else {
  const { default: knex } = await import('knex')
  const { default: express } = await import('express')
  const { fileURLToPath } = await import('node:url')
  const { generateKeyPairSync } = await import('node:crypto')
  const { EventEmitter } = await import('node:events')
  const { configureTransportRuntime } = await import('../../controllers/_types.ts')
  const originalWiki = global.WIKI
  const db = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } })
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  const wiki = {
    SERVERPATH: fileURLToPath(new URL('../../', import.meta.url)),
    config: { sessionSecret: 'controller-locale-review-key', host: 'https://wiki.example.test', lang: { code: 'en', autoUpdate: true, namespacing: false, namespaces: [] } },
    data: { localeNamespaces: ['common'] },
    product: { name: 'tsEpistle' },
    models: { knex: db },
    auth: { checkAccess: () => true },
    cache: { get: async () => [] },
    events: { outbound: new EventEmitter() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  }
  global.WIKI = wiki
  let server, baseUrl
  const request = (method, suffix = '', body, user = 1) => fetch(`${baseUrl}/_api/locales/workspace${suffix}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': String(user) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

  describe('mounted reviewed Locale store on PostgreSQL', () => {
    beforeAll(async () => {
      const { default: migrations } = await import('../../db/migrator-source.ts')
      await db.migrate.latest({ migrationSource: migrations })
      const now = new Date().toISOString()
      await db('locales').insert({ code: 'en', name: 'English', nativeName: 'English', strings: '{}', createdAt: now, updatedAt: now })
      await db('authentication').insert({ key: 'local', config: '{}', domainWhitelist: '[]', autoEnrollGroups: '[]' })
      await db('editors').insert({ key: 'markdown', config: '{}' }).onConflict('key').ignore()
      await db('users').insert([1, 3].map(id => ({ id, email: `admin-${id}@example.test`, name: `Administrator ${id}`, isActive: true, authVersion: 0, createdAt: now, updatedAt: now })))
      await db('groups').insert([1, 3].map(id => ({ id, name: `Group ${id}`, permissions: JSON.stringify(id === 1 ? ['manage:system'] : []), pageRules: '[]', createdAt: now, updatedAt: now })))
      await db('userGroups').insert([{ userId: 1, groupId: 1 }, { userId: 3, groupId: 3 }])
      for (const [key, value] of Object.entries({ lang: wiki.config.lang, sessionSecret: wiki.config.sessionSecret, certs: { public: keys.publicKey, private: keys.privateKey } })) {
        await db('settings').insert({ key, value: JSON.stringify(value), updatedAt: now }).onConflict('key').merge()
      }
      const { default: settings } = await import('../../models/settings.ts')
      const { default: locales } = await import('../../models/locales.ts')
      wiki.models.settings = settings.bindKnex(db)
      wiki.models.locales = locales.bindKnex(db)
      wiki.configSvc = (await import('../../core/config.ts')).default
      wiki.lang = (await import('../../core/localization.ts')).default
      wiki.lang.init()
      await wiki.lang.refreshNamespaces()
      configureTransportRuntime(wiki)
      const router = (await import('../../controllers/api/locales.ts')).default
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => { req.user = { id: Number(req.headers['x-test-user'] ?? 1), authVersion: 0 }; next() })
      app.use('/_api/locales', router)
      server = app.listen(0, '127.0.0.1')
      await new Promise(resolve => server.once('listening', resolve))
      baseUrl = `http://127.0.0.1:${server.address().port}`
    }, 60_000)

    afterAll(async () => {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await db.destroy()
      configureTransportRuntime({})
      global.WIKI = originalWiki
    })

    it('persists reviewed policy and actor/reason history, activates it, and rejects stale or unauthorized writes without mutation', async () => {
      const initialResponse = await request('GET')
      expect(initialResponse.status).toBe(200)
      expect(initialResponse.headers.get('cache-control')).toBe('no-store')
      const initial = await initialResponse.json()
      const body = { policy: { ...initial.policy, autoUpdate: false }, fingerprint: initial.fingerprint, reason: 'Review automatic package updates' }
      const saved = await request('PUT', '', body)
      expect(saved.status).toBe(200)
      expect(await saved.json()).toEqual({ activation: 'applied' })
      const persisted = (await db('settings').where('key', 'lang').first()).value
      const current = await (await request('GET')).json()
      expect(persisted).toMatchObject({ code: 'en', autoUpdate: false, revision: current.history[0].id })
      expect(current.policy).toEqual(body.policy)
      expect(current.history[0]).toMatchObject({ actorId: 1, reason: body.reason, fields: ['autoUpdate'] })
      expect(wiki.lang.appliedRevision).toBe(persisted.revision)
      expect(current.runtime.state).toBe('applied')
      const beforeRejected = await db('settings').orderBy('key')
      expect((await request('PUT', '', { ...body, policy: initial.policy })).status).toBe(409)
      expect((await request('PUT', '', { ...body, fingerprint: current.fingerprint, reason: '' })).status).toBe(400)
      expect((await request('PUT', '', { ...body, fingerprint: current.fingerprint }, 3)).status).toBe(403)
      await db('users').where('id', 1).update({ authVersion: 1 })
      expect((await request('PUT', '', { ...body, fingerprint: current.fingerprint })).status).toBe(403)
      expect(await db('settings').orderBy('key')).toEqual(beforeRejected)
    }, 30_000)
  })
}
