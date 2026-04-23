const { fetchAuthStrategies, fetchAdminAuthProviders, submitAuthRequest, submitStatusRequest } = require('./auth-api')

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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { key: 'zeta', order: 20 },
      { key: 'alpha', order: 5 },
      { key: 'middle', order: 10 }
    ]))

    await expect(fetchAuthStrategies(fetchImpl)).resolves.toEqual([
      { key: 'alpha', order: 5 },
      { key: 'middle', order: 10 },
      { key: 'zeta', order: 20 }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/auth/strategies', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('fetches and sorts admin auth providers by order', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { key: 'local', displayName: 'Local Login', order: '1', isEnabled: true }
    ]))

    await expect(fetchAdminAuthProviders(fetchImpl, 'Bad providers payload')).rejects.toThrow('Bad providers payload')
  })

  test('submits auth request as JSON and returns parsed body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ jwt: 'token', redirect: '/' }))

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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'Invalid credentials' }, false, 401))

    await expect(submitAuthRequest(fetchImpl, '/_api/auth/login', {
      strategy: 'local',
      username: 'alice@example.com',
      password: 'wrong'
    })).rejects.toThrow('Invalid credentials')
  })

  test('falls back to generic error when non-ok response is not JSON', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ redirect: '/' }))

    await expect(submitAuthRequest(fetchImpl, '/_api/auth/login', {
      strategy: 'local'
    }, 'Generic auth error')).rejects.toThrow('Generic auth error')
  })

  test('rejects TFA continuation responses without a continuation token', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ mustProvideTFA: true }))

    await expect(submitAuthRequest(fetchImpl, '/_api/auth/login', {
      strategy: 'local'
    }, 'Generic auth error')).rejects.toThrow('Generic auth error')
  })

  test('rejects setup-TFA responses without required setup data', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      mustSetupTFA: true,
      continuationToken: 'continuation-only'
    }))

    await expect(submitAuthRequest(fetchImpl, '/_api/auth/login', {
      strategy: 'local'
    }, 'Generic auth error')).rejects.toThrow('Generic auth error')
  })

  test('submits status request as JSON and returns parsed body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Password reset request processed.' }))

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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ success: true }))

    await expect(submitStatusRequest(fetchImpl, '/_api/auth/forgot-password', {
      email: 'alice@example.com'
    }, 'Generic status error')).rejects.toThrow('Generic status error')
  })
})
