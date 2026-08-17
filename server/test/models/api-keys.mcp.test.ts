import { afterEach, describe, expect, it, vi } from 'vitest'

const { sign } = vi.hoisted(() => ({ sign: vi.fn(() => 'signed-key') }))
vi.mock('jsonwebtoken', () => ({ default: { sign } }))

describe('MCP API-key resource binding', () => {
  afterEach(() => {
    vi.resetModules()
    sign.mockClear()
    Reflect.deleteProperty(globalThis, 'WIKI')
  })

  it('derives the resource claim from any configured Wiki domain', async () => {
    const patch = vi.fn().mockResolvedValue(undefined)
    const query = vi.fn()
      .mockReturnValueOnce({ insert: vi.fn().mockResolvedValue({ id: 17 }) })
      .mockReturnValueOnce({ findById: vi.fn(() => ({ patch })) })
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
    const ApiKey = (await import('../../models/apiKeys.ts')).default

    await expect(ApiKey.createNewKey({ name: 'MCP', expiration: '1h', fullAccess: false, group: 3 })).resolves.toBe('signed-key')

    expect(sign).toHaveBeenCalledWith(expect.objectContaining({
      api: 17,
      grp: 3,
      mcpResource: 'https://docs.example.co.uk/mcp',
      mcpResourceVersion: 1
    }), expect.any(Object), expect.objectContaining({ audience: 'urn:wiki:test' }))
    expect(patch).toHaveBeenCalledWith({ key: 'signed-key', isRevoked: false })
  })
})
