import { fetchAuthStrategies, fetchAdminAuthActiveStrategies, fetchAdminAuthProviders, fetchAdminAuthStrategies, fetchAdminApiBootstrap, updateAdminAuthStrategies, setAdminApiState, revokeAdminApiKey, createAdminApiKey, submitAuthRequest, submitStatusRequest, regenerateAuthCertificates, resetGuestUser } from './auth-api.ts'

function createJsonResponse (payload, ok = true, status = ok ? 200 : 400) {
  return {
    ok,
    status,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('auth api helper', () => {
  test('fetches and sorts auth strategies by order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        key: 'zeta',
        displayName: 'Zeta',
        order: 20,
        selfRegistration: false,
        strategy: {
          useForm: false,
          usernameType: 'email',
          color: '#333333',
          icon: 'mdi-login'
        }
      },
      {
        key: 'alpha',
        displayName: 'Alpha',
        order: 5,
        selfRegistration: true,
        strategy: {
          useForm: true,
          usernameType: 'email',
          color: '#111111',
          icon: 'mdi-account'
        }
      },
      {
        key: 'middle',
        displayName: 'Middle',
        order: 10,
        selfRegistration: false,
        strategy: {
          useForm: true,
          usernameType: 'username',
          color: '#222222',
          icon: 'mdi-account-key'
        }
      }
    ]))

    await expect(fetchAuthStrategies(fetchImpl)).resolves.toEqual([
      {
        key: 'alpha',
        displayName: 'Alpha',
        order: 5,
        selfRegistration: true,
        strategy: {
          useForm: true,
          usernameType: 'email',
          color: '#111111',
          icon: 'mdi-account'
        }
      },
      {
        key: 'middle',
        displayName: 'Middle',
        order: 10,
        selfRegistration: false,
        strategy: {
          useForm: true,
          usernameType: 'username',
          color: '#222222',
          icon: 'mdi-account-key'
        }
      },
      {
        key: 'zeta',
        displayName: 'Zeta',
        order: 20,
        selfRegistration: false,
        strategy: {
          useForm: false,
          usernameType: 'email',
          color: '#333333',
          icon: 'mdi-login'
        }
      }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/strategies', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('fetches and normalizes admin authentication strategies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        key: 'github',
        title: 'GitHub',
        isAvailable: true,
        props: [
          { key: 'clientId', value: JSON.stringify({ type: 'string', order: 2, default: '' }) },
          { key: 'clientSharedKey', value: JSON.stringify({ type: 'string', order: 1, default: '' }) }
        ],
        extra: 'ignored'
      },
      {
        key: 'local',
        title: 'Local',
        isAvailable: true,
        props: []
      }
    ]))

    await expect(fetchAdminAuthStrategies(fetchImpl)).resolves.toEqual([
      expect.objectContaining({
        key: 'github',
        title: 'GitHub',
        isAvailable: true,
        isDisabled: false,
        props: [
          { key: 'clientSharedKey', type: 'string', order: 1, default: '' },
          { key: 'clientId', type: 'string', order: 2, default: '' }
        ],
        extra: 'ignored'
      }),
      expect.objectContaining({
        key: 'local',
        isAvailable: true,
        isDisabled: true,
        props: []
      })
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/admin/strategies', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed admin authentication strategy payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([{ key: 'github', isAvailable: true, props: [{ key: 'clientId', value: '{' }] }]))

    await expect(fetchAdminAuthStrategies(fetchImpl, 'Bad strategies payload')).rejects.toThrow('Bad strategies payload')
  })

  test('surfaces REST errors for admin authentication strategy definitions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'manage:system is required' }, false))

    await expect(fetchAdminAuthStrategies(fetchImpl, 'Bad strategies payload')).rejects.toThrow('manage:system is required')
  })

  test('fetches and normalizes admin active authentication strategies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        key: 'github',
        strategy: { key: 'github', title: 'GitHub' },
        config: [
          { key: 'clientId', value: JSON.stringify({ type: 'string', order: 2, value: 'abc' }) },
          { key: 'clientSharedKey', value: JSON.stringify({ type: 'string', order: 1, sensitive: true, value: '********' }) }
        ],
        order: 2,
        isEnabled: true,
        displayName: 'GitHub Login',
        selfRegistration: false,
        domainWhitelist: [],
        autoEnrollGroups: []
      },
      {
        key: 'local',
        strategy: { key: 'local', title: 'Local' },
        config: [],
        order: 1,
        isEnabled: true,
        displayName: 'Local Login',
        selfRegistration: false,
        domainWhitelist: [],
        autoEnrollGroups: []
      }
    ]))

    await expect(fetchAdminAuthActiveStrategies(fetchImpl)).resolves.toEqual([
      expect.objectContaining({
        key: 'local',
        order: 1,
        config: []
      }),
      expect.objectContaining({
        key: 'github',
        order: 2,
        config: [
          { key: 'clientSharedKey', value: { type: 'string', order: 1, sensitive: true, value: '********' } },
          { key: 'clientId', value: { type: 'string', order: 2, value: 'abc' } }
        ]
      })
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/admin/active-strategies', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed admin active authentication strategy payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([{ key: 'github', strategy: { key: 'github' }, config: [{ key: 'clientId', value: '{' }], order: 1, isEnabled: true, displayName: 'GitHub', selfRegistration: false, domainWhitelist: [], autoEnrollGroups: [] }]))

    await expect(fetchAdminAuthActiveStrategies(fetchImpl, 'Bad active payload')).rejects.toThrow('Bad active payload')
  })

  test('surfaces REST errors for admin active authentication strategies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'manage:system is required' }, false))

    await expect(fetchAdminAuthActiveStrategies(fetchImpl, 'Bad active payload')).rejects.toThrow('manage:system is required')
  })

  test('fetches and sorts admin auth providers by order', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      { key: 'github', displayName: 'GitHub Login', order: 2, isEnabled: false },
      { key: 'local', displayName: 'Local Login', order: 1, isEnabled: true }
    ]))

    await expect(fetchAdminAuthProviders(fetchImpl)).resolves.toEqual([
      { key: 'local', displayName: 'Local Login', order: 1, isEnabled: true },
      { key: 'github', displayName: 'GitHub Login', order: 2, isEnabled: false }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/providers', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed admin auth providers payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      { key: 'local', displayName: 'Local Login', order: '1', isEnabled: true }
    ]))

    await expect(fetchAdminAuthProviders(fetchImpl, 'Bad providers payload')).rejects.toThrow('Bad providers payload')
  })

  test('fetches admin API bootstrap with sanitized key rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      enabled: true,
      extraRoot: 'ignored',
      keys: [
        {
          id: 7,
          name: 'Deploy',
          keyShort: '...12345678901234567890',
          key: '[REDACTED]',
          isRevoked: false,
          expiration: '2026-01-01T00:00:00.000Z',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-02-01T00:00:00.000Z',
          extraSecret: 'ignored'
        }
      ]
    }))

    await expect(fetchAdminApiBootstrap(fetchImpl)).resolves.toEqual({
      enabled: true,
      keys: [
        {
          id: 7,
          name: 'Deploy',
          keyShort: '...12345678901234567890',
          isRevoked: false,
          expiration: '2026-01-01T00:00:00.000Z',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-02-01T00:00:00.000Z'
        }
      ]
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/api', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed admin API bootstrap root payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ enabled: 'true', keys: [] }))

    await expect(fetchAdminApiBootstrap(fetchImpl, 'Bad API bootstrap payload')).rejects.toThrow('Bad API bootstrap payload')
  })

  test('rejects malformed admin API key rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      enabled: false,
      keys: [
        {
          id: 7,
          name: 'Deploy',
          keyShort: '',
          isRevoked: false,
          expiration: '2026-01-01T00:00:00.000Z',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-02-01T00:00:00.000Z'
        }
      ]
    }))

    await expect(fetchAdminApiBootstrap(fetchImpl, 'Bad API key row')).rejects.toThrow('Bad API key row')
  })

  test('rejects admin API key rows with unredacted keyShort values', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      enabled: false,
      keys: [
        {
          id: 7,
          name: 'Deploy',
          keyShort: 'visible-key-material',
          isRevoked: false,
          expiration: '2026-01-01T00:00:00.000Z',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-02-01T00:00:00.000Z'
        }
      ]
    }))

    await expect(fetchAdminApiBootstrap(fetchImpl, 'Bad API key row')).rejects.toThrow('Bad API key row')
  })

  test('accepts intentionally redacted admin API key placeholders', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      enabled: false,
      keys: [
        {
          id: 7,
          name: 'Legacy',
          keyShort: '...[redacted]',
          isRevoked: false,
          expiration: '2026-01-01T00:00:00.000Z',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-02-01T00:00:00.000Z'
        }
      ]
    }))

    await expect(fetchAdminApiBootstrap(fetchImpl)).resolves.toEqual({
      enabled: false,
      keys: [
        {
          id: 7,
          name: 'Legacy',
          keyShort: '...[redacted]',
          isRevoked: false,
          expiration: '2026-01-01T00:00:00.000Z',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-02-01T00:00:00.000Z'
        }
      ]
    })
  })

  test('throws API JSON error messages for admin API bootstrap failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'manage:api required' }, false, 403))

    await expect(fetchAdminApiBootstrap(fetchImpl, 'Generic API bootstrap error')).rejects.toThrow('manage:api required')
  })

  test('falls back to generic error when admin API bootstrap success is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: {
        get: () => ''
      }
    })

    await expect(fetchAdminApiBootstrap(fetchImpl, 'Generic API bootstrap error')).rejects.toThrow('Generic API bootstrap error')
  })

  test('updates admin API state through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'API State changed successfully' }))

    await expect(setAdminApiState(fetchImpl, true)).resolves.toEqual({ message: 'API State changed successfully' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/api/state', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ enabled: true })
    })
  })

  test('surfaces API state REST JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'enabled must be a boolean' }, false))

    await expect(setAdminApiState(fetchImpl, 'yes', 'Bad API state')).rejects.toThrow('enabled must be a boolean')
  })

  test('revokes admin API keys through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'API Key revoked successfully' }))

    await expect(revokeAdminApiKey(fetchImpl, 7)).resolves.toEqual({ message: 'API Key revoked successfully' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/api/keys/7/revoke', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })
  })

  test('surfaces API key revoke REST JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'missing key' }, false))

    await expect(revokeAdminApiKey(fetchImpl, 7, 'Bad revoke')).rejects.toThrow('missing key')
  })

  test('creates admin API keys through REST and returns the generated key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      key: 'generated-api-key',
      message: 'API Key created successfully'
    }))

    await expect(createAdminApiKey(fetchImpl, {
      name: 'Deploy',
      expiration: '1y',
      fullAccess: false,
      group: 7
    })).resolves.toEqual({
      key: 'generated-api-key',
      message: 'API Key created successfully'
    })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/api/keys', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Deploy',
        expiration: '1y',
        fullAccess: false,
        group: 7
      })
    })
  })

  test('rejects malformed admin API key creation success payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'API Key created successfully' }))

    await expect(createAdminApiKey(fetchImpl, {
      name: 'Deploy',
      expiration: '1y',
      fullAccess: true,
      group: null
    }, 'Bad key creation')).rejects.toThrow('Bad key creation')
  })

  test('surfaces admin API key creation REST JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'name must be a non-empty string' }, false))

    await expect(createAdminApiKey(fetchImpl, {
      name: '',
      expiration: '1y',
      fullAccess: true,
      group: null
    }, 'Bad key creation')).rejects.toThrow('name must be a non-empty string')
  })

  test('submits auth request as JSON and returns parsed body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ jwt: 'token', redirect: '/' }))

    await expect(submitAuthRequest(fetchImpl, '/_api/auth/login', {
      strategy: 'local',
      username: 'alice@example.com',
      password: 'secret'
    })).resolves.toEqual({ jwt: 'token', redirect: '/' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        strategy: 'local',
        username: 'alice@example.com',
        password: 'secret'
      })
    })
  })

  test('throws API JSON error messages for expected auth failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Invalid credentials' }, false, 401))

    await expect(submitAuthRequest(fetchImpl, '/_api/auth/login', {
      strategy: 'local',
      username: 'alice@example.com',
      password: 'wrong'
    })).rejects.toThrow('Invalid credentials')
  })

  test('falls back to generic error when non-ok response is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: {
        get: () => 'text/html'
      }
    })

    await expect(submitAuthRequest(fetchImpl, '/_api/auth/login', {
      strategy: 'local'
    }, 'Generic auth error')).rejects.toThrow('Generic auth error')
  })

  test('rejects malformed successful auth payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ redirect: '/' }))

    await expect(submitAuthRequest(fetchImpl, '/_api/auth/login', {
      strategy: 'local'
    }, 'Generic auth error')).rejects.toThrow('Generic auth error')
  })

  test('rejects TFA continuation responses without a continuation token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ mustProvideTFA: true }))

    await expect(submitAuthRequest(fetchImpl, '/_api/auth/login', {
      strategy: 'local'
    }, 'Generic auth error')).rejects.toThrow('Generic auth error')
  })

  test('rejects setup-TFA responses without required setup data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      mustSetupTFA: true,
      continuationToken: 'continuation-only'
    }))

    await expect(submitAuthRequest(fetchImpl, '/_api/auth/login', {
      strategy: 'local'
    }, 'Generic auth error')).rejects.toThrow('Generic auth error')
  })

  test('accepts setup-TFA responses with QR and manual setup data', async () => {
    const payload = {
      mustSetupTFA: true,
      continuationToken: 'setup-token',
      tfaQRImage: '<svg></svg>',
      tfaSecret: 'JBSWY3DPEHPK3PXP'
    }
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))

    await expect(submitAuthRequest(fetchImpl, '/_api/auth/login', {
      strategy: 'local'
    }, 'Generic auth error')).resolves.toEqual(payload)
  })

  test('submits status request as JSON and returns parsed body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Password reset request processed.' }))

    await expect(submitStatusRequest(fetchImpl, '/_api/auth/forgot-password', {
      email: 'alice@example.com'
    }, 'Generic status error')).resolves.toEqual({ message: 'Password reset request processed.' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/forgot-password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: 'alice@example.com'
      })
    })
  })

  test('rejects malformed successful status payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ success: true }))

    await expect(submitStatusRequest(fetchImpl, '/_api/auth/forgot-password', {
      email: 'alice@example.com'
    }, 'Generic status error')).rejects.toThrow('Generic status error')
  })

  test('regenerates auth certificates through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Certificates have been regenerated successfully.' }))

    await expect(regenerateAuthCertificates(fetchImpl)).resolves.toEqual({ message: 'Certificates have been regenerated successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/certificates/regenerate', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })
  })

  test('surfaces API errors for auth certificate regeneration', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'cert regen failed' }, false, 500))

    await expect(regenerateAuthCertificates(fetchImpl)).rejects.toThrow('cert regen failed')
  })

  test('resets the guest user through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Guest user has been reset successfully.' }))

    await expect(resetGuestUser(fetchImpl)).resolves.toEqual({ message: 'Guest user has been reset successfully.' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/guest/reset', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })
  })

  test('surfaces API errors for guest user reset', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'guest reset failed' }, false, 500))

    await expect(resetGuestUser(fetchImpl)).rejects.toThrow('guest reset failed')
  })

  test('updates admin authentication strategies with same-origin JSON POST options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Strategies updated successfully' }))
    const strategies = [{ key: 'local', strategyKey: 'local', config: [], displayName: 'Local', order: 0, isEnabled: true, selfRegistration: false, domainWhitelist: [], autoEnrollGroups: [] }]

    await expect(updateAdminAuthStrategies(fetchImpl, strategies)).resolves.toEqual({ message: 'Strategies updated successfully' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/strategies', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ strategies })
    })
  })

  test('rejects malformed admin authentication strategy update payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(updateAdminAuthStrategies(fetchImpl, [], 'Bad strategy update')).rejects.toThrow('Bad strategy update')
  })

  test('propagates admin authentication strategy REST JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Cannot delete Local as 1 or more users are still using it.' }, false))

    await expect(updateAdminAuthStrategies(fetchImpl, [], 'Bad strategy update')).rejects.toThrow('Cannot delete Local as 1 or more users are still using it.')
  })
})
