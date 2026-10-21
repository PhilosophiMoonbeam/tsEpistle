import { describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { connectExternalMcpOAuth } from './agent-control-api.ts'

const endpointId = '00000000-0000-4000-8000-000000000198'

describe('Google MCP client boundary', () => {
  it('accepts only the exact Google authorization origin and path before browser navigation', async () => {
    const valid = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=public-client&state=opaque&code_challenge=challenge'
    const fetcher = vi.fn(async () => Response.json({ authorizationUrl: valid }))
    expect(await connectExternalMcpOAuth(fetcher as typeof fetch, 'csrf', endpointId)).toBe(valid)
    for (const authorizationUrl of [
      'https://accounts.google.com.evil.example/o/oauth2/v2/auth',
      'https://accounts.google.com@evil.example/o/oauth2/v2/auth',
      'https://user:password@accounts.google.com/o/oauth2/v2/auth',
      'http://accounts.google.com/o/oauth2/v2/auth',
      'https://accounts.google.com:8443/o/oauth2/v2/auth',
      'https://accounts.google.com/other',
      '/o/oauth2/v2/auth',
      'javascript:alert(1)',
      valid + '#unexpected'
    ]) {
      fetcher.mockImplementation(async () => Response.json({ authorizationUrl }))
      await expect(connectExternalMcpOAuth(fetcher as typeof fetch, 'csrf', endpointId)).rejects.toMatchObject({ status: 502 })
    }
  })

})
