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
    const user = { id: 3, authVersion: 0 }
    global.WIKI.auth.checkAccess.mockImplementation((principal, permissions) => {
      expect(principal).toBe(user)
      expect(new Set(permissions)).toEqual(new Set(['manage:system']))
      return false
    })
    for (const route of ['get /workspace', 'put /workspace', 'post /workspace/apply', 'post /operations', 'get /operations/:id']) {
      global.WIKI.auth.checkAccess.mockClear()
      const res = response(); await routes[route]({ user }, res)
      expect(global.WIKI.auth.checkAccess).toHaveBeenCalled()
      expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
      expect(res.status).toHaveBeenCalledWith(403)
    }
    for (const operation of Object.values(store)) expect(operation).not.toHaveBeenCalled()
  })
  it('passes exact browser drafts and request IDs to the authoritative store', async () => {
    const user = { id: 1, authVersion: 2 }
    const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const checkId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const workspace = {
      fingerprint: 'review',
      revision: 'policy-1',
      observedAt: '2026-09-10T00:00:00.000Z',
      publicUrl: 'https://wiki.example.test',
      offline: false,
      redirection: { enabled: false, eligible: true, reason: null, trustedProxy: true },
      deployment: { enabled: false, provider: null, format: null, source: 'inline', domain: null, subscriberEmail: null },
      listeners: { httpPort: 3000, httpsPort: null, material: null, replacementMode: null },
      runtimeRedirection: { enabled: false, eligible: true, publicUrl: 'https://wiki.example.test', settingsCurrent: true },
      savedCertificate: null,
      savedCertificateIssue: null,
      history: [],
      operations: []
    }
    const running = {
      id: operationId, kind: 'public-check', state: 'running', phase: 'queued', actorId: user.id, apiKeyId: null,
      reason: '', createdAt: '2026-09-10T00:01:00.000Z', completedAt: null,
      summary: 'Operation recorded. Its outcome will appear here.', result: null
    }
    const failed = {
      ...running, state: 'failed', phase: 'complete', completedAt: '2026-09-10T00:01:05.000Z',
      summary: 'The public connection could not be established.'
    }
    const save = { enabled: true, fingerprint: 'review', reason: 'Enable reviewed redirect', verifiedCheckId: checkId }
    const apply = { fingerprint: 'saved-review' }
    const start = { id: operationId, fingerprint: 'saved-review', kind: 'public-check', reason: '' }
    for (const [route, method, argument, result] of [
      ['get /workspace', 'inspect', undefined, workspace],
      ['put /workspace', 'save', save, { applied: false, enabled: true, revision: 'policy-2' }],
      ['post /workspace/apply', 'applyPolicy', apply, { applied: true, enabled: true, revision: 'policy-2' }],
      ['post /operations', 'start', start, running],
      ['get /operations/:id', 'receipt', operationId, failed]
    ]) {
      store[method].mockResolvedValue(result)
      const req = { user, body: argument, params: { id: operationId } }
      const res = response(); await routes[route](req, res)
      expect(store[method]).toHaveBeenCalledWith(...(argument === undefined ? [{ user }] : [{ user }, argument]))
      expect(res.json).toHaveBeenCalledWith(result)
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
    for (const [error, status, message] of [[Object.assign(new Error('Settings changed'), { status: 409 }), 409, 'Settings changed'], [new Error('private database credential'), 503, undefined]]) {
      store.inspect.mockRejectedValueOnce(error)
      const res = response(); await routes['get /workspace']({ user: { id: 1 } }, res)
      expect(res.status).toHaveBeenCalledWith(status)
      expect(res.json).toHaveBeenCalledWith({ error: message ?? expect.any(String) })
      expect(JSON.stringify(res.json.mock.calls)).not.toContain('private database credential')
    }
  })
})
