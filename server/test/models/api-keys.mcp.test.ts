import { afterEach, describe, expect, it, vi } from '../bun-test.mts'

const { sign } = vi.hoisted(() => ({ sign: vi.fn(() => 'signed-key') }))
vi.mockModule('jsonwebtoken', import.meta.url, () => ({ default: { sign } }))

describe('MCP API-key resource binding', () => {
  afterEach(() => {
    vi.resetModules()
    sign.mockClear()
    Reflect.deleteProperty(globalThis, 'WIKI')
  })

  it('derives the resource claim from the active runtime configuration', async () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    const query = vi.fn()
      .mockReturnValueOnce({ insert: vi.fn().mockResolvedValue({ id: 17 }) })
      .mockReturnValueOnce({ findById: vi.fn(() => ({ patch })) })
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

    expect(await ApiKey.createNewKey({ name: 'MCP', expiration: '1h', fullAccess: false, group: 3 })).toBe('signed-key')

    expect(sign).toHaveBeenCalledWith(expect.objectContaining({
      api: 17,
      grp: 3,
      mcpResource: 'https://docs.example.co.uk/mcp',
      mcpResourceVersion: 1
    }), expect.any(Object), expect.objectContaining({ audience: 'urn:wiki:test' }))
    expect(patch).toHaveBeenCalledWith({ key: 'signed-key', isRevoked: false })
  })
})
