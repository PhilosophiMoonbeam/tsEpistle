import express from 'express'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const store = { inspect: vi.fn(), save: vi.fn(), erase: vi.fn() }
vi.mockModule('../../operations/analytics-administration.ts', import.meta.url, () => ({
  getAnalyticsAdministrationStore: () => store
}))
const { default: analyticsRouter } = await import('../../controllers/api/analytics.ts')

const originalWiki = global.WIKI
const user = { id: 1, authVersion: 0 }
const workspace = () => ({
  policy: {
    localEnabled: false,
    externalEnabled: false,
    audience: 'everyone',
    excludeAdministrators: true,
    respectPrivacySignals: true,
    excludedPaths: [],
    retentionDays: 90
  },
  fingerprint: 'f'.repeat(64),
  providers: [{
    key: 'plausible',
    title: 'Plausible',
    description: 'Traffic',
    isAvailable: true,
    isEnabled: false,
    website: 'https://plausible.io',
    fields: [{ key: 'domain', title: 'Domain', hint: 'Site domain' }],
    config: { domain: 'wiki.example.test' }
  }]
})

describe('Reviewed Analytics HTTP and compatibility endpoints', () => {
  let server
  let baseURL

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.user = user
      next()
    })
    app.use('/_api/analytics', analyticsRouter)
    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Analytics test server did not bind a TCP port')
    baseURL = `http://127.0.0.1:${address.port}/_api/analytics`
  })

  afterAll(async () => {
    try {
      if (server?.listening) {
        await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve())
          server.closeAllConnections()
        })
      }
    } finally {
      global.WIKI = originalWiki
    }
  })

  beforeEach(() => {
    global.WIKI = { auth: { checkAccess: vi.fn(() => true) } }
    for (const fn of Object.values(store)) fn.mockReset()
    store.inspect.mockResolvedValue(workspace())
    store.save.mockResolvedValue({ revision: 'saved' })
    store.erase.mockResolvedValue({ revision: 'erased', erasedRows: 2 })
  })

  const request = async (method, path, body, status = 200) => {
    const response = await fetch(baseURL + path, {
      method,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    expect(response.status).toBe(status)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-type')).toMatch(/^application\/json\b/)
    return response.json()
  }

  it('admits parsed review bodies and the authenticated principal at all workspace routes', async () => {
    const body = {
      policy: { localEnabled: true },
      providers: [],
      fingerprint: 'review',
      reason: 'Reviewed change'
    }
    for (const [method, path, operation] of [
      ['GET', '/workspace', 'inspect'],
      ['PUT', '/workspace', 'save'],
      ['POST', '/workspace/erase', 'erase']
    ]) {
      const json = await request(method, path, method === 'GET' ? undefined : body)
      expect(json).toBeInstanceOf(Object)
      // Admission and complete JSON-body delivery are contracts, not store-result echoes.
      expect(store[operation]).toHaveBeenCalledTimes(1)
      expect(store[operation]).toHaveBeenCalledWith(...(operation === 'inspect' ? [user, undefined] : [user, body]))
    }
  })

  it('denies every HTTP endpoint before reading provider or counter data or publishing', async () => {
    global.WIKI.auth.checkAccess.mockReturnValue(false)
    for (const [method, path] of [
      ['GET', '/workspace'],
      ['PUT', '/workspace'],
      ['POST', '/workspace/erase'],
      ['GET', '/providers'],
      ['POST', '/providers']
    ]) {
      expect(await request(method, path, method === 'GET' ? undefined : {}, 403))
        .toEqual({ error: 'manage:system is required' })
    }
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledTimes(5)
    expect(global.WIKI.auth.checkAccess).toHaveBeenCalledWith(user, ['manage:system'])
    expect(store.inspect).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
    expect(store.erase).not.toHaveBeenCalled()
  })

  it('preserves conflict feedback but redacts unexpected database failures over HTTP', async () => {
    store.save.mockRejectedValue(Object.assign(new Error('Analytics settings changed.'), { status: 409 }))
    expect(await request('PUT', '/workspace', {}, 409)).toEqual({ error: 'Analytics settings changed.' })

    store.inspect.mockRejectedValue(new Error('database password secret'))
    const json = await request('GET', '/workspace', undefined, 500)
    expect(json).toEqual({
      error: 'Analytics administration is temporarily unavailable. Reload to confirm saved settings.'
    })
    expect(JSON.stringify(json)).not.toContain('secret')
  })

  it('serializes compatible provider field envelopes rather than exposing store fields', async () => {
    const providers = await request('GET', '/providers')
    expect(store.inspect).toHaveBeenCalledWith(user)
    expect(providers).toHaveLength(1)
    expect(providers[0]).toEqual({
      key: 'plausible',
      title: 'Plausible',
      description: 'Traffic',
      isAvailable: true,
      isEnabled: false,
      website: 'https://plausible.io',
      logo: '',
      config: [{ key: 'domain', value: expect.any(String) }]
    })
    expect(JSON.parse(providers[0].config[0].value)).toEqual({
      type: 'string', title: 'Domain', hint: 'Site domain', order: 0, value: 'wiki.example.test'
    })
  })

  it('publishes legacy patches once with the current fingerprint and paused collection policy', async () => {
    expect(await request('POST', '/providers', {
      providers: [{
        key: 'plausible',
        isEnabled: true,
        config: [{ key: 'domain', value: '{"v":"new.example.test"}' }]
      }]
    })).toEqual({ message: 'Providers updated successfully' })
    expect(store.inspect).toHaveBeenCalledWith(user)
    expect(store.save).toHaveBeenCalledTimes(1)
    expect(store.save).toHaveBeenCalledWith(user, {
      policy: {
        localEnabled: false,
        externalEnabled: false,
        audience: 'everyone',
        excludeAdministrators: true,
        respectPrivacySignals: true,
        excludedPaths: [],
        retentionDays: 90
      },
      providers: [{ key: 'plausible', isEnabled: true, config: { domain: 'new.example.test' } }],
      fingerprint: 'f'.repeat(64),
      reason: expect.any(String)
    })
    const reason = store.save.mock.calls[0][1].reason.trim()
    expect(reason.length).toBeGreaterThanOrEqual(3)
    expect(reason.length).toBeLessThanOrEqual(1000)
  })

  it('rejects duplicate, unknown, prototype and malformed legacy fields before publication', async () => {
    for (const config of [
      [{ key: '__proto__', value: '{"v":"bad"}' }],
      [{ key: 'unknown', value: '{"v":"bad"}' }],
      [{ key: 'domain', value: 'broken' }],
      [{ key: 'domain', value: '{"v":{}}' }],
      [{ key: 'domain', value: '{"v":"one"}' }, { key: 'domain', value: '{"v":"two"}' }]
    ]) {
      expect(await request('POST', '/providers', {
        providers: [{ key: 'plausible', isEnabled: true, config }]
      }, 400)).toEqual({ error: 'Invalid analytics providers payload' })
    }
    expect(store.inspect).toHaveBeenCalledTimes(5)
    expect(store.save).not.toHaveBeenCalled()
  })
})
