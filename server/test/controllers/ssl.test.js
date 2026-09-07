vi.mockModule('express', import.meta.url, () => {
  const router = {
    get: vi.fn(),
    all: vi.fn()
  }

  const expressMock = {
    Router: () => router,
    __router: router
  }

  return { default: expressMock, ...expressMock }
})

const express = await import('express')

const createWiki = host => ({
  config: {
    host,
    letsencrypt: { challenge: false },
    server: { sslRedir: true }
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn()
  },
  servers: { servers: { https: { listening: true } } }
})

const loadRedirectHandler = async wiki => {
  const { default: createSslController } = await vi.importFresh('../../controllers/ssl.ts', import.meta.url)
  createSslController(wiki)
  const route = express.__router.all.mock.calls.find(([path]) => path === '/{*sslRedirectPath}')
  return route && route[1]
}

describe('controllers/ssl HTTPS redirect', () => {
  beforeEach(() => {
    vi.resetModules()
    express.__router.get.mockClear()
    express.__router.all.mockClear()
  })

  it('uses the configured HTTPS authority regardless of the request Host', async () => {
    const wiki = createWiki('https://wiki.example.test:8443')
    const handler = await loadRedirectHandler(wiki)
    const req = {
      secure: false,
      hostname: 'foreign.example.test',
      originalUrl: '/docs/guide?mode=print&return=%2Fstart'
    }
    const res = { redirect: vi.fn(), sendStatus: vi.fn() }
    const next = vi.fn()

    handler(req, res, next)

    expect(res.redirect).toHaveBeenCalledWith('https://wiki.example.test:8443/docs/guide?mode=print&return=%2Fstart')
    expect(res.sendStatus).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('requires the configured public origin to explicitly use HTTPS', async () => {
    const wiki = createWiki('http://wiki.example.test:8080')
    const handler = await loadRedirectHandler(wiki)
    const req = {
      secure: false,
      hostname: 'foreign.example.test',
      originalUrl: '/search?q=redirect%20safety&locale=en'
    }
    const res = { redirect: vi.fn(), sendStatus: vi.fn() }
    const next = vi.fn()

    handler(req, res, next)

    expect(res.redirect).not.toHaveBeenCalled()
    expect(res.sendStatus).toHaveBeenCalledWith(503)
    expect(next).not.toHaveBeenCalled()
  })

  it('keeps authority-like request targets on the configured origin', async () => {
    const wiki = createWiki('https://wiki.example.test')
    const handler = await loadRedirectHandler(wiki)
    const req = {
      secure: false,
      hostname: 'foreign.example.test',
      originalUrl: '//request-target.example.test/phishing?continue=%2Fdocs'
    }
    const res = { redirect: vi.fn(), sendStatus: vi.fn() }
    const next = vi.fn()

    handler(req, res, next)

    expect(res.redirect).toHaveBeenCalledWith('https://wiki.example.test/phishing?continue=%2Fdocs')
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects redirects when the configured host is not a trusted origin', async () => {
    const wiki = createWiki('wiki.example.test')
    const handler = await loadRedirectHandler(wiki)
    const req = {
      secure: false,
      hostname: 'foreign.example.test',
      originalUrl: '/docs?from=home'
    }
    const res = { redirect: vi.fn(), sendStatus: vi.fn() }
    const next = vi.fn()

    handler(req, res, next)

    expect(res.sendStatus).toHaveBeenCalledWith(503)
    expect(res.redirect).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    expect(wiki.logger.warn).toHaveBeenCalledWith(expect.stringContaining('configured site host'))
  })
  it('redirects an insecure request behind a trusted proxy without a native HTTPS listener', async () => {
    const wiki = createWiki('https://wiki.example.test:10443')
    wiki.servers.servers.https = null
    wiki.config.security = { securityTrustProxy: true }
    const handler = await loadRedirectHandler(wiki), next = vi.fn(), res = { redirect: vi.fn(), sendStatus: vi.fn() }
    handler({ secure: false, originalUrl: '/docs?mode=print' }, res, next)
    expect(res.redirect).toHaveBeenCalledWith('https://wiki.example.test:10443/docs?mode=print')
    expect(next).not.toHaveBeenCalled()
    handler({ secure: true, originalUrl: '/docs' }, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.redirect).toHaveBeenCalledTimes(1)
  })
  it('does not create a proxy redirect loop without trusted secure-request information', async () => {
    const wiki = createWiki('https://wiki.example.test')
    wiki.servers.servers.https = null
    const handler = await loadRedirectHandler(wiki), next = vi.fn(), res = { redirect: vi.fn(), sendStatus: vi.fn() }
    handler({ secure: false, originalUrl: '/docs' }, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(res.redirect).not.toHaveBeenCalled()
  })

})

describe('controllers/ssl active HTTP challenge', () => {
  it('serves only the current runtime challenge and ignores old persisted challenge values', async () => {
    express.__router.get.mockClear()
    const wiki = createWiki('https://wiki.example.test')
    wiki.config.letsencrypt.challenge = { token: 'persisted-token', keyAuthorization: 'stale-authorization' }
    wiki.servers.le = { challenge: null }
    const { default: createSslController } = await vi.importFresh('../../controllers/ssl.ts', import.meta.url)
    createSslController(wiki)
    const handler = express.__router.get.mock.calls.find(([path]) => path === '/.well-known/acme-challenge/:token')[1]
    const res = { type: vi.fn(), set: vi.fn(), status: vi.fn(), end: vi.fn(), send: vi.fn() }
    res.status.mockReturnValue(res)
    handler({ params: { token: 'persisted-token' } }, res)
    expect(res.status).toHaveBeenLastCalledWith(418)
    expect(res.send).not.toHaveBeenCalled()
    wiki.servers.le.challenge = { token: 'runtime-token', keyAuthorization: 'current-public-authorization' }
    handler({ params: { token: 'wrong-token' } }, res)
    expect(res.status).toHaveBeenLastCalledWith(406)
    handler({ params: { token: 'runtime-token' } }, res)
    expect(res.send).toHaveBeenLastCalledWith('current-public-authorization')
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.type).toHaveBeenCalledWith('text/plain')
    wiki.servers.le.challenge = null
    handler({ params: { token: 'runtime-token' } }, res)
    expect(res.status).toHaveBeenLastCalledWith(418)
  })
})
