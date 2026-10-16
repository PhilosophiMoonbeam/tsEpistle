import { afterEach, describe, expect, it, vi } from '../bun-test.mts'

const { sign } = vi.hoisted(() => ({ sign: vi.fn(() => 'signed-key') }))
vi.mockModule('jsonwebtoken', import.meta.url, () => ({ default: { sign } }))

describe('service API-key issuance', () => {
  afterEach(() => {
    vi.resetModules()
    sign.mockClear()
    Reflect.deleteProperty(globalThis, 'WIKI')
  })

  it('issues only REST and GraphQL grants even when MCP is enabled', async () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    const insert = vi.fn().mockResolvedValue({ id: 17 })
    const query = vi.fn().mockReturnValue({ insert, findById: vi.fn(() => ({ patch })) })
    Reflect.set(globalThis, 'WIKI', {
      config: {
        agents: { mcp: { enabled: false } },
        auth: { audience: 'urn:wiki:stale' },
        certs: { private: 'stale-private-key' },
        host: 'https://stale.example.test',
        sessionSecret: 'stale-session-secret'
      },
      models: { apiKeys: { query: vi.fn() } }
    })
    const ApiKey = (await vi.importFresh('../../models/apiKeys.ts', import.meta.url)).default
    Reflect.set(globalThis, 'WIKI', {
      config: {
        agents: { mcp: { enabled: true } },
        auth: { audience: 'urn:wiki:test' },
        certs: { private: 'test-private-key' },
        host: 'https://docs.example.co.uk',
        sessionSecret: 'test-session-secret'
      },
      models: { apiKeys: { query } }
    })
    expect(await ApiKey.createNewKey({ name: 'Service', expiration: '1h', fullAccess: false, group: 3 })).toBe('signed-key')
    expect(sign).toHaveBeenCalledWith({ api: 17, grp: 3 }, expect.any(Object), expect.objectContaining({ audience: 'urn:wiki:test' }))
    expect(patch).toHaveBeenCalledWith({ key: 'signed-key', isRevoked: false })
  })
})
