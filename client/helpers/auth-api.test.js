import {
  fetchAuthStrategies,
  fetchAdminApiBootstrap,
  setAdminApiState,
  revokeAdminApiKey,
  createAdminApiKey,
  submitAuthRequest,
  submitStatusRequest
} from './auth-api.ts'

function createJsonResponse(payload, ok = true, status = ok ? 200 : 400) {
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
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse([
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
      ])
    )

    expect(await fetchAuthStrategies(fetchImpl)).toEqual([
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

  test('fetches admin API bootstrap with sanitized key rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        enabled: true,
        createFullAccess: false,
        assignableGroups: [],
        extraRoot: 'ignored',
        keys: [
          {
            id: 7,
            name: 'Deploy',
            keyShort: '...12345678901234567890',
            grant: { groupId: null, mcpResource: null, mcpResourceVersion: null },
            canRevoke: false,
            key: '[REDACTED]',
            isRevoked: false,
            expiration: '2026-01-01T00:00:00.000Z',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-02-01T00:00:00.000Z',
            extraSecret: 'ignored'
          }
        ]
      })
    )

    expect(await fetchAdminApiBootstrap(fetchImpl)).toEqual({
      enabled: true,
      createFullAccess: false,
      assignableGroups: [],
      keys: [
        {
          id: 7,
          name: 'Deploy',
          keyShort: '...12345678901234567890',
          canRevoke: false,
          grant: { groupId: null, mcpResource: null, mcpResourceVersion: null },
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ enabled: 'true', createFullAccess: false, assignableGroups: [], keys: [] }))

    await expect(Promise.resolve(fetchAdminApiBootstrap(fetchImpl, 'Bad API bootstrap payload'))).rejects.toThrow('Bad API bootstrap payload')
  })

  test('rejects malformed admin API key rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        enabled: false,
        createFullAccess: false,
        assignableGroups: [],
        keys: [
          {
            id: 7,
            name: 'Deploy',
            keyShort: '',
            canRevoke: false,
            isRevoked: false,
            expiration: '2026-01-01T00:00:00.000Z',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-02-01T00:00:00.000Z'
          }
        ]
      })
    )

    await expect(Promise.resolve(fetchAdminApiBootstrap(fetchImpl, 'Bad API key row'))).rejects.toThrow('Bad API key row')
  })

  test('rejects admin API key rows with unredacted keyShort values', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        enabled: false,
        createFullAccess: false,
        assignableGroups: [],
        keys: [
          {
            id: 7,
            name: 'Deploy',
            keyShort: 'visible-key-material',
            canRevoke: false,
            isRevoked: false,
            expiration: '2026-01-01T00:00:00.000Z',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-02-01T00:00:00.000Z'
          }
        ]
      })
    )

    await expect(Promise.resolve(fetchAdminApiBootstrap(fetchImpl, 'Bad API key row'))).rejects.toThrow('Bad API key row')
  })

  test('accepts intentionally redacted admin API key placeholders', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        enabled: false,
        createFullAccess: false,
        assignableGroups: [],
        keys: [
          {
            id: 7,
            name: 'Legacy',
            keyShort: '...[redacted]',
            grant: { groupId: null, mcpResource: null, mcpResourceVersion: null },
            canRevoke: false,
            isRevoked: false,
            expiration: '2026-01-01T00:00:00.000Z',
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-02-01T00:00:00.000Z'
          }
        ]
      })
    )

    expect(await fetchAdminApiBootstrap(fetchImpl)).toEqual({
      enabled: false,
      createFullAccess: false,
      assignableGroups: [],
      keys: [
        {
          id: 7,
          name: 'Legacy',
          keyShort: '...[redacted]',
          canRevoke: false,
          grant: { groupId: null, mcpResource: null, mcpResourceVersion: null },
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

    await expect(Promise.resolve(fetchAdminApiBootstrap(fetchImpl, 'Generic API bootstrap error'))).rejects.toThrow('manage:api required')
  })

  test('falls back to generic error when admin API bootstrap success is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: {
        get: () => ''
      }
    })

    await expect(Promise.resolve(fetchAdminApiBootstrap(fetchImpl, 'Generic API bootstrap error'))).rejects.toThrow('Generic API bootstrap error')
  })

  test('updates admin API state through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'API State changed successfully' }))

    expect(await setAdminApiState(fetchImpl, true)).toEqual({ message: 'API State changed successfully' })
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

    await expect(Promise.resolve(setAdminApiState(fetchImpl, 'yes', 'Bad API state'))).rejects.toThrow('enabled must be a boolean')
  })

  test('revokes admin API keys through REST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'API Key revoked successfully' }))

    expect(await revokeAdminApiKey(fetchImpl, 7)).toEqual({ message: 'API Key revoked successfully' })
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

    await expect(Promise.resolve(revokeAdminApiKey(fetchImpl, 7, 'Bad revoke'))).rejects.toThrow('missing key')
  })

  test('creates admin API keys through REST and returns the generated key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        key: 'generated-api-key',
        message: 'API Key created successfully'
      })
    )

    expect(
      await createAdminApiKey(fetchImpl, {
        name: 'Deploy',
        expiration: '1y',
        fullAccess: false,
        group: 7
      })
    ).toEqual({
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

    await expect(
      Promise.resolve(
        createAdminApiKey(
          fetchImpl,
          {
            name: 'Deploy',
            expiration: '1y',
            fullAccess: true,
            group: null
          },
          'Bad key creation'
        )
      )
    ).rejects.toThrow('Bad key creation')
  })

  test('surfaces admin API key creation REST JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'name must be a non-empty string' }, false))

    await expect(
      Promise.resolve(
        createAdminApiKey(
          fetchImpl,
          {
            name: '',
            expiration: '1y',
            fullAccess: true,
            group: null
          },
          'Bad key creation'
        )
      )
    ).rejects.toThrow('name must be a non-empty string')
  })

  test('submits auth request as JSON and returns parsed body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ authenticated: true, redirect: '/' }))

    expect(
      await submitAuthRequest(fetchImpl, '/_api/auth/login', {
        strategy: 'local',
        username: 'alice@example.com',
        password: 'secret'
      })
    ).toEqual({ authenticated: true, redirect: '/' })

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
  test('accepts unauthenticated TFA continuations while reserving completion for authenticated responses', async () => {
    const payload = {
      authenticated: false,
      mustProvideTFA: true,
      continuationToken: 'tfa-token',
      redirect: '/admin'
    }
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))

    await expect(
      submitAuthRequest(fetchImpl, '/_api/auth/login', { strategy: 'local' })
    ).resolves.toEqual(payload)
  })

  test('rejects authenticated challenge payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      authenticated: true,
      mustChangePwd: true,
      continuationToken: 'password-token'
    }))

    await expect(
      submitAuthRequest(fetchImpl, '/_api/auth/login', { strategy: 'local' })
    ).rejects.toThrow('Authentication request failed')
  })

  test('throws API JSON error messages for expected auth failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Invalid credentials' }, false, 401))

    await expect(
      Promise.resolve(
        submitAuthRequest(fetchImpl, '/_api/auth/login', {
          strategy: 'local',
          username: 'alice@example.com',
          password: 'wrong'
        })
      )
    ).rejects.toThrow('Invalid credentials')
  })

  test('falls back to generic error when non-ok response is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: {
        get: () => 'text/html'
      }
    })

    await expect(
      Promise.resolve(
        submitAuthRequest(
          fetchImpl,
          '/_api/auth/login',
          {
            strategy: 'local'
          },
          'Generic auth error'
        )
      )
    ).rejects.toThrow('Generic auth error')
  })

  test('rejects malformed successful auth payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ redirect: '/' }))

    await expect(
      Promise.resolve(
        submitAuthRequest(
          fetchImpl,
          '/_api/auth/login',
          {
            strategy: 'local'
          },
          'Generic auth error'
        )
      )
    ).rejects.toThrow('Generic auth error')
  })

  test('rejects TFA continuation responses without a continuation token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ authenticated: false, mustProvideTFA: true }))
    await expect(
      Promise.resolve(
        submitAuthRequest(
          fetchImpl,
          '/_api/auth/login',
          {
            strategy: 'local'
          },
          'Generic auth error'
        )
      )
    ).rejects.toThrow('Generic auth error')
  })

  test('rejects setup-TFA responses without required setup data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        authenticated: false,
        mustSetupTFA: true,
        continuationToken: 'continuation-only'
      })
    )

    await expect(
      Promise.resolve(
        submitAuthRequest(
          fetchImpl,
          '/_api/auth/login',
          {
            strategy: 'local'
          },
          'Generic auth error'
        )
      )
    ).rejects.toThrow('Generic auth error')
  })

  test('accepts setup-TFA responses with QR and manual setup data', async () => {
    const payload = {
      authenticated: false,
      mustSetupTFA: true,
      continuationToken: 'setup-token',
      tfaQRImage: '<svg></svg>',
      tfaSecret: 'JBSWY3DPEHPK3PXP'
    }
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse(payload))

    expect(
      await submitAuthRequest(
        fetchImpl,
        '/_api/auth/login',
        {
          strategy: 'local'
        },
        'Generic auth error'
      )
    ).toEqual(payload)
  })

  test('submits status request as JSON and returns parsed body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Password reset request processed.' }))

    expect(
      await submitStatusRequest(
        fetchImpl,
        '/_api/auth/forgot-password',
        {
          email: 'alice@example.com'
        },
        'Generic status error'
      )
    ).toEqual({ message: 'Password reset request processed.' })

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

    await expect(
      Promise.resolve(
        submitStatusRequest(
          fetchImpl,
          '/_api/auth/forgot-password',
          {
            email: 'alice@example.com'
          },
          'Generic status error'
        )
      )
    ).rejects.toThrow('Generic status error')
  })

})
