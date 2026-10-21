import { describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { connectExternalMcpOAuth, listAvailableExternalMcp } from './agent-control-api.ts'
import { createExternalMcpOAuthDraft, externalMcpOAuthInput } from './external-mcp-oauth-form.ts'

const endpointId = '00000000-0000-4000-8000-000000000198'

describe('External MCP OAuth client boundary', () => {
  it('allows provider-neutral HTTPS authorization and rejects unsafe browser navigation', async () => {
    const fetcher = vi.fn(async () => Response.json({ authorizationUrl: '' }))
    for (const authorizationUrl of [
      'https://identity.example.net/tenant/oauth/authorize?client_id=public-client&state=opaque&code_challenge=challenge',
      'https://login.example.org:8443/authorize',
      'https://accounts.example.com/oauth2/authorize?state=opaque'
    ]) {
      fetcher.mockImplementation(async () => Response.json({ authorizationUrl }))
      await expect(connectExternalMcpOAuth(fetcher as typeof fetch, 'csrf', endpointId)).resolves.toBe(authorizationUrl)
    }
    for (const authorizationUrl of [
      'http://identity.example.net/authorize',
      'https://user:password@identity.example.net/authorize',
      'https://identity.example.net/authorize#access_token=secret',
      '/authorize',
      '//identity.example.net/authorize',
      'javascript:alert(1)',
      'data:text/html,unsafe',
      ' https://identity.example.net/authorize',
      'https://identity.example.net/author\nize',
      'https://identity.example.net/authorize?state=' + 'x'.repeat(16_384)
    ]) {
      fetcher.mockImplementation(async () => Response.json({ authorizationUrl }))
      await expect(connectExternalMcpOAuth(fetcher as typeof fetch, 'csrf', endpointId)).rejects.toMatchObject({ status: 502 })
    }
  })

  it('exposes only safe OAuth endpoint metadata even if a response contains credential fields', async () => {
    const fetcher = vi.fn(async () => Response.json({ servers: [{
      id: endpointId, displayName: 'Independent provider', endpointUrl: 'https://tools.example.net/mcp', destinationHost: 'tools.example.net', namespace: 'external:test',
      scope: 'admin', ownerId: null, status: 'enabled', revision: 1, authMode: 'oauth', secretConfigured: false, groupIds: [1], trust: 'untrusted', createdAt: '', updatedAt: '',
      secretValue: 'bearer-secret', secretReference: 'private-keyring-reference',
      oauth: { preset: 'unsupported-provider', issuer: 'https://identity.example.net', registrationMode: 'preregistered', clientId: 'public-client-id', tokenEndpointAuthMethod: 'client_secret_basic', clientSecretConfigured: true, clientSecretValue: 'oauth-secret', clientSecretReference: 'private-client-reference' }
    }] }))
    const [server] = await listAvailableExternalMcp(fetcher as typeof fetch, 'csrf')
    expect(server?.oauth?.clientSecretConfigured).toBe(true)
    expect(server?.oauth?.issuer).toBe('https://identity.example.net')
    expect(server).not.toHaveProperty('secretValue')
    expect(server).not.toHaveProperty('secretReference')
    expect(server?.oauth).not.toHaveProperty('clientSecretValue')
    expect(server?.oauth).not.toHaveProperty('clientSecretReference')
    expect(server?.oauth).not.toHaveProperty('preset')
  })

  it('omits unchanged write-only secrets, distinguishes explicit clear, and drops inactive registration credentials', () => {
    const draft = createExternalMcpOAuthDraft({ registrationMode: 'preregistered', clientId: 'client', tokenEndpointAuthMethod: 'client_secret_basic', clientSecretConfigured: true })
    expect(externalMcpOAuthInput(draft)).not.toHaveProperty('clientSecretValue')
    draft.clientSecret = 'replacement-secret'
    expect(externalMcpOAuthInput(draft)?.clientSecretValue).toBe('replacement-secret')
    draft.clearClientSecret = true
    expect(externalMcpOAuthInput(draft)?.clientSecretValue).toBeNull()
    draft.registrationMode = 'automatic'
    const automatic = externalMcpOAuthInput(draft)
    expect(automatic).not.toHaveProperty('clientSecretValue')
    expect(automatic).not.toHaveProperty('clientId')
    expect(automatic).not.toHaveProperty('tokenEndpointAuthMethod')
    draft.issuer = ' https://identity.example.net '
    draft.scopes = 'read:tools\nwrite:tools  profile'
    expect(externalMcpOAuthInput(draft)).toEqual({
      issuer: 'https://identity.example.net',
      scopes: ['read:tools', 'write:tools', 'profile'],
      registrationMode: 'automatic'
    })
  })
})
