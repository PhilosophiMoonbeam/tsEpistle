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
  servers: { servers: { https: {} } }
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

  it('upgrades a configured HTTP origin while preserving its authority and request path/query', async () => {
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

    expect(res.redirect).toHaveBeenCalledWith('https://wiki.example.test:8080/search?q=redirect%20safety&locale=en')
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

    expect(res.sendStatus).toHaveBeenCalledWith(500)
    expect(res.redirect).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    expect(wiki.logger.warn).toHaveBeenCalledWith(expect.stringContaining('configured site host'))
  })
})
