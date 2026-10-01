import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_controller_mail_test', import.meta.path)

if (!connection) {
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
} else {
  const { default: knex } = await import('knex')
  const { default: express } = await import('express')
  const { default: net } = await import('node:net')
  const { fileURLToPath } = await import('node:url')
  const { randomUUID } = await import('node:crypto')
  const { configureTransportRuntime } = await import('../../controllers/_types.ts')
  const originalWiki = global.WIKI
  const db = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } })
  const sockets = new Set()
  const envelopes = []
  const messages = []
  const smtp = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    socket.write('220 controller.test ESMTP\r\n')
    let buffer = '', data = null
    socket.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const end = buffer.indexOf('\r\n')
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data !== null) {
          if (line === '.') {
            messages.push(data.join('\r\n'))
            data = null
            socket.write('250 Message accepted\r\n')
          } else data.push(line.startsWith('..') ? line.slice(1) : line)
          continue
        }
        const command = line.split(' ')[0].toUpperCase()
        if (command === 'EHLO') socket.write('250-controller.test\r\n250 AUTH PLAIN\r\n')
        else if (command === 'AUTH') {
          const fields = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8').split('\0')
          socket.write(fields[1] === 'x' && fields[2] === 'controller-smtp-secret' ? '235 Authentication accepted\r\n' : '535 Authentication rejected\r\n')
        } else if (command === 'MAIL' || command === 'RCPT') {
          envelopes.push(line)
          socket.write('250 Envelope accepted\r\n')
        } else if (command === 'DATA') {
          data = []
          socket.write('354 End with a single dot\r\n')
        } else if (command === 'QUIT') socket.end('221 Goodbye\r\n')
        else if (command === 'RSET' || command === 'NOOP') socket.write('250 OK\r\n')
        else socket.write('500 Unsupported SMTP command\r\n')
      }
    })
  })
  const wiki = {
    SERVERPATH: fileURLToPath(new URL('../../', import.meta.url)),
    config: { sessionSecret: 'controller-mail-review-key', title: 'Controller mail site', company: 'Wiki team', host: 'https://wiki.example.test', logoUrl: '', offline: false, lang: { code: 'en', namespaces: [], namespacing: false } },
    data: { localeNamespaces: ['common'] },
    models: { knex: db },
    auth: { checkAccess: () => true },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Error: { MailNotConfigured: Error, MailTemplateFailed: Error }
  }
  global.WIKI = wiki
  let server, baseUrl, checkId
  const request = (method, suffix, body, user = 1) => fetch(`${baseUrl}/_api/mail${suffix}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': String(user) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })

  describe('mounted reviewed Mail store and real SMTP runtime on PostgreSQL', () => {
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
      await new Promise(resolve => smtp.listen(0, '127.0.0.1', resolve))
      wiki.config.mail = { enabled: true, senderName: 'Wiki team', senderEmail: 'wiki@example.test', host: '127.0.0.1', port: smtp.address().port, tlsMode: 'plain', verifySSL: true, user: 'x', pass: 'controller-smtp-secret', useDKIM: false, dkimPrivateKey: 'retained-inactive-private-key' }
      for (const [key, value] of Object.entries({ mail: wiki.config.mail, offline: { v: false }, host: { v: wiki.config.host }, title: { v: wiki.config.title } })) {
        await db('settings').insert({ key, value: JSON.stringify(value), updatedAt: now }).onConflict('key').merge()
      }
      const { default: locales } = await import('../../models/locales.ts')
      wiki.models.locales = locales.bindKnex(db)
      wiki.lang = (await import('../../core/localization.ts')).default
      wiki.lang.init()
      await wiki.lang.refreshNamespaces()
      wiki.mail = (await import('../../core/mail.ts')).createMailRuntime(wiki)
      wiki.mail.init()
      configureTransportRuntime(wiki)
      const router = (await import('../../controllers/api/mail.ts')).default
      const app = express()
      app.use(express.json())
      app.use((req, _res, next) => { req.user = { id: Number(req.headers['x-test-user'] ?? 1), authVersion: 0 }; next() })
      app.use('/_api/mail', router)
      server = app.listen(0, '127.0.0.1')
      await new Promise(resolve => server.once('listening', resolve))
      baseUrl = `http://127.0.0.1:${server.address().port}`
    }, 60_000)

    afterAll(async () => {
      try {
        if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        if (checkId) await vi.waitFor(async () => expect((await db('mailChecks').where('id', checkId).first())?.state).not.toBe('running'), { timeout: 3000 })
      } finally {
        wiki.mail?.close()
        for (const socket of sockets) socket.destroy()
        if (smtp.listening) await new Promise(resolve => smtp.close(resolve))
        await db.destroy()
        configureTransportRuntime({})
        global.WIKI = originalWiki
      }
    })

    it('reads, saves, reapplies, renders and confirms a diagnostic receipt without losing review or request identity', async () => {
      const read = await request('GET', '/workspace')
      expect(read.status).toBe(200)
      expect(read.headers.get('cache-control')).toBe('no-store')
      const initial = await read.json()
      expect(initial.secrets).toEqual({ pass: true, dkimPrivateKey: true })
      expect(JSON.stringify(initial)).not.toContain('controller-smtp-secret')
      expect(JSON.stringify(initial)).not.toContain('retained-inactive-private-key')
      const body = { policy: { ...initial.policy, senderName: 'Reviewed controller sender' }, secrets: { pass: { action: 'keep' }, dkimPrivateKey: { action: 'keep' } }, fingerprint: initial.fingerprint, reason: 'Review sender identity' }
      const saved = await request('PUT', '/workspace', body)
      expect(saved.status).toBe(200)
      const savedReceipt = await saved.json()
      expect(savedReceipt.applied).toBe(true)
      expect((await db('settings').where('key', 'mail').first()).value).toMatchObject({ senderName: body.policy.senderName, pass: 'controller-smtp-secret' })
      const current = await (await request('GET', '/workspace')).json()
      expect(current.policy).toEqual(body.policy)
      expect(current.history[0]).toMatchObject({ id: savedReceipt.revision, actorId: 1, reason: body.reason })
      expect(current.runtime).toMatchObject({ allocated: true, settingsCurrent: true, state: 'ready' })
      wiki.mail.close()
      expect(wiki.mail.runtime().active).toBe(false)
      const applied = await request('POST', '/workspace/apply', { fingerprint: current.fingerprint })
      expect(applied.status).toBe(200)
      expect(await applied.json()).toEqual({ revision: savedReceipt.revision, applied: true })
      expect(wiki.mail.runtime()).toMatchObject({ active: true, state: 'ready' })
      const preview = await request('GET', '/templates/account-welcome')
      expect(preview.status).toBe(200)
      const rendered = await preview.json()
      expect(rendered.key).toBe('account-welcome')
      expect(rendered.html).toContain('href="https://wiki.example.test/login"')
      expect(rendered.html).toContain('lang="en"')
      expect(rendered.text).toContain('https://wiki.example.test/login')
      expect(messages).toEqual([])
      const beforeRejected = await db('settings').orderBy('key')
      expect((await request('PUT', '/workspace', { ...body, policy: initial.policy })).status).toBe(409)
      expect((await request('POST', '/workspace/apply', { fingerprint: initial.fingerprint })).status).toBe(409)
      expect((await request('POST', '/workspace/apply', { fingerprint: current.fingerprint }, 3)).status).toBe(403)
      expect(await db('settings').orderBy('key')).toEqual(beforeRejected)
      const id = randomUUID()
      const diagnostic = { id, kind: 'test', fingerprint: current.fingerprint, recipient: 'recipient@example.test', confirmSend: true }
      expect((await request('POST', '/checks', { ...diagnostic, confirmSend: false })).status).toBe(400)
      expect(await db('mailChecks').where('id', id)).toEqual([])
      expect(messages).toEqual([])
      checkId = id
      const accepted = await request('POST', '/checks', diagnostic)
      expect(accepted.status).toBe(202)
      expect(await accepted.json()).toMatchObject({ id, kind: 'test', actorId: 1, recipient: diagnostic.recipient, configurationRevision: savedReceipt.revision })
      await vi.waitFor(async () => expect((await db('mailChecks').where('id', id).first()).state).toBe('succeeded'), { timeout: 3000 })
      const receipt = await request('GET', `/checks/${id}`)
      expect(receipt.status).toBe(200)
      expect(await receipt.json()).toMatchObject({ id, state: 'succeeded', actorId: 1, recipient: diagnostic.recipient, configurationRevision: savedReceipt.revision })
      expect(envelopes).toEqual(['MAIL FROM:<wiki@example.test>', 'RCPT TO:<recipient@example.test>'])
      expect(messages).toHaveLength(1)
      expect(messages[0]).toContain('From: Reviewed controller sender <wiki@example.test>')
      expect(messages[0]).toContain('To: recipient@example.test')
      expect((await request('GET', `/checks/${randomUUID()}`)).status).toBe(404)
    }, 30_000)
  })
}
