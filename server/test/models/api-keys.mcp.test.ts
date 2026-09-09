import { afterEach, describe, expect, it, vi } from '../bun-test.mts'

const { sign } = vi.hoisted(() => ({ sign: vi.fn(() => 'signed-key') }))
vi.mockModule('jsonwebtoken', import.meta.url, () => ({ default: { sign } }))

describe('MCP API-key resource binding', () => {
  afterEach(() => {
    vi.resetModules()
    sign.mockClear()
    Reflect.deleteProperty(globalThis, 'WIKI')
  })

  it.each([undefined, true, false])('derives resource binding from current configuration and explicit opt-out: %s', async mcpAccess => {
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
    expect(await ApiKey.createNewKey({ name: 'MCP', expiration: '1h', fullAccess: false, group: 3, ...(mcpAccess === undefined ? {} : { mcpAccess }) })).toBe('signed-key')
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({
      api: 17,
      grp: 3,
      ...(mcpAccess === false ? {} : { mcpResource: 'https://docs.example.co.uk/mcp', mcpResourceVersion: 1 })
    }), expect.any(Object), expect.objectContaining({ audience: 'urn:wiki:test' }))
    if (mcpAccess === false) expect(sign.mock.calls[0]?.[0]).not.toHaveProperty('mcpResource')
    expect(patch).toHaveBeenCalledWith({ key: 'signed-key', isRevoked: false })
  })
})
