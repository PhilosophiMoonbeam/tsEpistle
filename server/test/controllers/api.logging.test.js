import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_controller_logging_test', import.meta.path)

if (!connection) {
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
    expect(res.flushHeaders).not.toHaveBeenCalled()
    expect(res.write).not.toHaveBeenCalled()
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
    const authorization = Promise.withResolvers()
    workspace.authorizeLive.mockImplementation(() => authorization.promise)
    const firstRequest = request()
    const secondRequest = request()
    const pendingThirdRequest = request()
    const firstResponse = response()
    const secondResponse = response()
    const first = live(firstRequest, firstResponse)
    const second = live(secondRequest, secondResponse)
    let pendingThird

    try {
      expect(workspace.authorizeLive).toHaveBeenCalledTimes(2)
      expect(transport.loggingLiveTrail.subscribe).not.toHaveBeenCalled()
      expect(firstResponse.flushHeaders).not.toHaveBeenCalled()
      expect(secondResponse.flushHeaders).not.toHaveBeenCalled()

      const pendingRejected = response()
      pendingThird = live(pendingThirdRequest, pendingRejected)
      expect(pendingRejected.status).toHaveBeenCalledWith(429)
      await pendingThird

      authorization.resolve()
      await vi.waitFor(() => expect(transport.loggingLiveTrail.subscribe).toHaveBeenCalledTimes(2))
      expect(firstResponse.status).toHaveBeenCalledWith(200)
      expect(secondResponse.status).toHaveBeenCalledWith(200)
      expect(firstResponse.flushHeaders).toHaveBeenCalledTimes(1)
      expect(secondResponse.flushHeaders).toHaveBeenCalledTimes(1)

      const rejected = response()
      await live(request(), rejected)
      expect(rejected.status).toHaveBeenCalledWith(429)
      firstRequest.close()
      secondRequest.close()
      await Promise.all([first, second])
    } finally {
      authorization.resolve()
      await Promise.resolve()
      firstRequest.close()
      secondRequest.close()
      pendingThirdRequest.close()
      await Promise.allSettled([first, second, ...(pendingThird ? [pendingThird] : [])])
      workspace.authorizeLive.mockResolvedValue(undefined)
    }
  })
})
} else {
  const { default: knex } = await import('knex')
  const { default: express } = await import('express')
  const { fileURLToPath } = await import('node:url')
  const { readFile } = await import('node:fs/promises')
  const yaml = await import('js-yaml')
  const { configureTransportRuntime } = await import('../../controllers/_types.ts')
  const { createApiPrincipal } = await import('../../helpers/api-principal.ts')
  const originalWiki = global.WIKI
  const db = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } })
  const wiki = {
    SERVERPATH: fileURLToPath(new URL('../../', import.meta.url)),
    config: { sessionSecret: 'controller-logging-review-key', logLevel: 'info', logFormat: 'default' },
    data: { loggers: [] },
    models: { knex: db },
    auth: { checkAccess: () => true }
  }
  global.WIKI = wiki
  let server, baseUrl
  const request = (method, suffix = '', body, principal = 'account') => fetch(`${baseUrl}/_api/logging/workspace${suffix}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-principal': principal },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

  describe('mounted reviewed Logging store on PostgreSQL', () => {
    beforeAll(async () => {
      const { default: migrations } = await import('../../db/migrator-source.ts')
      await db.migrate.latest({ migrationSource: migrations })
      const now = new Date().toISOString()
      await db('locales').insert({ code: 'en', name: 'English', nativeName: 'English', strings: '{}', createdAt: now, updatedAt: now })
      await db('authentication').insert({ key: 'local', config: '{}', domainWhitelist: '[]', autoEnrollGroups: '[]' })
      await db('editors').insert({ key: 'markdown', config: '{}' }).onConflict('key').ignore()
      await db('users').insert({ id: 1, email: 'admin@example.test', name: 'Administrator', isActive: true, authVersion: 0, createdAt: now, updatedAt: now })
      await db('groups').insert([1, 3].map(id => ({ id, name: `Group ${id}`, permissions: '["manage:system"]', pageRules: '[]', createdAt: now, updatedAt: now })))
      await db('userGroups').insert({ userId: 1, groupId: 1 })
      await db('apiKeys').insert({ id: 21, name: 'Reviewed API principal', key: 'controller-only-key', isRevoked: false, expiration: '2099-01-01T00:00:00.000Z', createdAt: now, updatedAt: now })
      for (const [key, value] of [['logLevel', { v: 'info' }], ['logFormat', { v: 'default' }]]) {
        await db('settings').insert({ key, value: JSON.stringify(value), updatedAt: now }).onConflict('key').merge()
      }
      const source = new URL('../../modules/logging/sentry/definition.yml', import.meta.url)
      const { readModuleDefinition } = await import('../../models/moduleTypes.ts')
      const common = (await import('../../helpers/common.ts')).default
      const definition = readModuleDefinition(yaml.load(await readFile(source, 'utf8')), fileURLToPath(source))
      wiki.data.loggers = [{ ...definition, props: common.parseModuleProps(definition.props) }]
      await db('loggers').insert({ key: 'sentry', isEnabled: false, level: 'warn', config: JSON.stringify({ key: 'https://stored-secret@example.ingest.sentry.io/1', untouched: 'unowned-secret' }) })
      wiki.logger = (await import('../../core/logger.ts')).default.init('controller-logging')
      configureTransportRuntime(wiki)
      const router = (await import('../../controllers/api/logging.ts')).default
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => {
        if (req.headers['x-test-principal'] === 'api' || req.headers['x-test-principal'] === 'missing-key') {
          req.user = createApiPrincipal(21, 3, ['manage:system'])
          if (req.headers['x-test-principal'] === 'api') req.apiKeyAuth = { apiKeyId: 21, groupId: 3, expiresAt: Date.parse('2099-01-01T00:00:00.000Z') / 1000 }
        } else req.user = { id: 1, authVersion: 0 }
        next()
      })
      app.use('/_api/logging', router)
      server = app.listen(0, '127.0.0.1')
      await new Promise(resolve => server.once('listening', resolve))
      baseUrl = `http://127.0.0.1:${server.address().port}`
    }, 60_000)

    afterAll(async () => {
      if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      wiki.logger?.close()
      await db.destroy()
      configureTransportRuntime({})
      global.WIKI = originalWiki
    })

    it('reads redacted account and API-key workspaces and rechecks persisted authority rather than browser ownership', async () => {
      for (const principal of ['account', 'api']) {
        const response = await request('GET', '', undefined, principal)
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        const workspace = await response.json()
        expect(workspace.console).toEqual({ level: 'info', format: 'default' })
        expect(workspace.destinations.find(destination => destination.key === 'sentry')).toMatchObject({ secrets: { key: true }, config: {} })
        expect(JSON.stringify(workspace)).not.toContain('stored-secret')
        expect(JSON.stringify(workspace)).not.toContain('unowned-secret')
        expect(workspace.fingerprint).toMatch(/^[a-f0-9]{64}$/)
      }
      expect((await request('GET', '', undefined, 'missing-key')).status).toBe(403)
      await db('apiKeys').where('id', 21).update({ isRevoked: true })
      expect((await request('GET', '', undefined, 'api')).status).toBe(403)
      expect((await request('GET')).status).toBe(200)
    })

    it('saves a complete reviewed draft without applying it, then applies only its current revision through the real logger', async () => {
      const initial = await (await request('GET')).json()
      const body = {
        fingerprint: initial.fingerprint,
        reason: 'Review structured console output',
        console: { level: 'debug', format: 'json' },
        destinations: initial.destinations.map(destination => ({ key: destination.key, isEnabled: destination.isEnabled, level: destination.level, config: destination.config, secrets: Object.fromEntries(Object.keys(destination.secrets).map(key => [key, { action: 'keep' }])) }))
      }
      const saved = await request('PUT', '', body)
      expect(saved.status).toBe(200)
      const receipt = await saved.json()
      expect(receipt).toMatchObject({ applied: false })
      const current = await (await request('GET')).json()
      expect(current.console).toEqual(body.console)
      expect((await db('settings').where('key', 'logLevel').first()).value).toEqual({ v: 'debug' })
      expect((await db('settings').where('key', 'logFormat').first()).value).toEqual({ v: 'json' })
      expect(current.history[0]).toMatchObject({ id: receipt.revision, actorId: 1, apiKeyId: null, reason: body.reason })
      expect(current.runtime.settingsCurrent).toBe(false)
      expect(wiki.logger.level).toBe('info')
      const applied = await request('POST', '/apply', { fingerprint: current.fingerprint })
      expect(applied.status).toBe(200)
      expect(await applied.json()).toMatchObject({ revision: receipt.revision, applied: true, runtime: { settingsCurrent: true, console: body.console } })
      expect(wiki.logger.level).toBe('debug')
      expect(wiki.logger.loggingRuntime()).toMatchObject({ state: 'ready', console: body.console, destinations: { sentry: { state: 'inactive' } } })
      const beforeRejected = await db('settings').orderBy('key')
      expect((await request('POST', '/apply', { fingerprint: initial.fingerprint })).status).toBe(409)
      expect((await request('PUT', '', { ...body, console: { level: 'error', format: 'json' } })).status).toBe(409)
      await db('groups').where('id', 1).update({ permissions: '[]' })
      expect((await request('POST', '/apply', { fingerprint: current.fingerprint })).status).toBe(403)
      expect(await db('settings').orderBy('key')).toEqual(beforeRejected)
    })
  })
}
