const { searchUsers, fetchLastLogins, fetchAdminUsersList, createAdminUser, setAdminUserActive, verifyAdminUser, setAdminUserTfa, fetchUserDetails } = require('./users-api')

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('users api helper', () => {
  test('returns an empty array without fetching for short queries', async () => {
    const fetchImpl = jest.fn()

    await expect(searchUsers(fetchImpl, ' a ')).resolves.toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('fetches and validates user search results', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { id: 42, name: 'Alice', email: 'alice@example.com', providerKey: 'local' },
      { id: 77, name: 'Bob', email: 'bob@example.com', providerKey: 'ldap' }
    ]))

    await expect(searchUsers(fetchImpl, ' alice ')).resolves.toEqual([
      { id: 42, name: 'Alice', email: 'alice@example.com', providerKey: 'local' },
      { id: 77, name: 'Bob', email: 'bob@example.com', providerKey: 'ldap' }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/search?query=alice', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed user search rows', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { id: '42', name: 'Alice', email: 'alice@example.com', providerKey: 'local' }
    ]))

    await expect(searchUsers(fetchImpl, 'alice', 'Bad user search payload')).rejects.toThrow('Bad user search payload')
  })

  test('fetches and validates dashboard last-logins payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { id: 42, name: 'Alice', lastLoginAt: '2026-01-03T00:00:00.000Z', email: 'hidden@example.com' },
      { id: 77, name: 'Bob', lastLoginAt: '2026-01-02T00:00:00.000Z' }
    ]))

    await expect(fetchLastLogins(fetchImpl)).resolves.toEqual([
      { id: 42, name: 'Alice', lastLoginAt: '2026-01-03T00:00:00.000Z' },
      { id: 77, name: 'Bob', lastLoginAt: '2026-01-02T00:00:00.000Z' }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/last-logins', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed dashboard last-logins payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { id: 42, name: 'Alice', lastLoginAt: null }
    ]))

    await expect(fetchLastLogins(fetchImpl, 'Bad last logins payload')).rejects.toThrow('Bad last logins payload')
  })

  test('fetches and validates admin users list payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      total: 2,
      users: [
        {
          id: 42,
          name: 'Alice',
          email: 'alice@example.com',
          providerKey: 'local',
          isSystem: false,
          isActive: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-03T00:00:00.000Z',
          password: 'hidden'
        },
        {
          id: 77,
          name: 'Bob',
          email: 'bob@example.com',
          providerKey: 'ldap',
          isSystem: false,
          isActive: false,
          createdAt: '2026-01-02T00:00:00.000Z',
          lastLoginAt: null,
          tfaSecret: 'hidden'
        }
      ]
    }))

    await expect(fetchAdminUsersList(fetchImpl, {
      page: 3,
      pageSize: 15,
      filter: 'ali',
      providerKey: 'local',
      orderBy: 'lastLoginAt',
      orderByDirection: 'desc'
    })).resolves.toEqual({
      total: 2,
      users: [
        {
          id: 42,
          name: 'Alice',
          email: 'alice@example.com',
          providerKey: 'local',
          isSystem: false,
          isActive: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: '2026-01-03T00:00:00.000Z'
        },
        {
          id: 77,
          name: 'Bob',
          email: 'bob@example.com',
          providerKey: 'ldap',
          isSystem: false,
          isActive: false,
          createdAt: '2026-01-02T00:00:00.000Z',
          lastLoginAt: null
        }
      ]
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users?page=3&pageSize=15&filter=ali&providerKey=local&orderBy=lastLoginAt&orderByDirection=desc', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed admin users list payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      total: 1,
      users: [
        {
          id: 42,
          name: 'Alice',
          email: 'alice@example.com',
          providerKey: 'local',
          isSystem: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastLoginAt: null
        }
      ]
    }))

    await expect(fetchAdminUsersList(fetchImpl, {}, 'Bad users list payload')).rejects.toThrow('Bad users list payload')
  })

  test('surfaces API error messages for failed admin users lists', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      error: 'manage:users or manage:system is required'
    }, false))

    await expect(fetchAdminUsersList(fetchImpl, {}, 'Bad users list')).rejects.toThrow('manage:users or manage:system is required')
  })

  test('creates admin users with the expected REST payload', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User created successfully'
    }))
    const payload = {
      providerKey: 'local',
      email: 'alice@example.com',
      passwordRaw: 'temporary-secret',
      name: 'Alice',
      groups: [3, 4],
      mustChangePassword: true,
      sendWelcomeEmail: false
    }

    await expect(createAdminUser(fetchImpl, payload)).resolves.toEqual({
      succeeded: true,
      message: 'User created successfully'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
  })

  test('rejects malformed admin user create payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      message: 'User created successfully'
    }))

    await expect(createAdminUser(fetchImpl, {}, 'Bad user create payload')).rejects.toThrow('Bad user create payload')
  })

  test('surfaces API error messages for failed admin user creates', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      error: 'You are not authorized to assign a user to a group with elevated permissions.'
    }, false))

    await expect(createAdminUser(fetchImpl, {}, 'Bad user create')).rejects.toThrow('You are not authorized to assign a user to a group with elevated permissions.')
  })

  test('patches admin user active state with the expected REST payload', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User deactivated successfully'
    }))

    await expect(setAdminUserActive(fetchImpl, '42', false)).resolves.toEqual({
      succeeded: true,
      message: 'User deactivated successfully'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/42/status', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ isActive: false })
    })
  })

  test('patches admin user verification with the expected REST payload', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User verified successfully'
    }))

    await expect(verifyAdminUser(fetchImpl, 42)).resolves.toEqual({
      succeeded: true,
      message: 'User verified successfully'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/42/verification', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ isVerified: true })
    })
  })

  test('patches admin user 2FA state with the expected REST payload', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User 2FA enabled successfully'
    }))

    await expect(setAdminUserTfa(fetchImpl, 42, true)).resolves.toEqual({
      succeeded: true,
      message: 'User 2FA enabled successfully'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/42/tfa', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ enabled: true })
    })
  })

  test('rejects invalid admin user action ids before fetching', async () => {
    const fetchImpl = jest.fn()

    await expect(setAdminUserActive(fetchImpl, '42abc', true, 'Bad user status')).rejects.toThrow('Bad user status')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('rejects malformed admin user action payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      succeeded: false,
      message: 'User activated successfully'
    }))

    await expect(setAdminUserActive(fetchImpl, 42, true, 'Bad user status')).rejects.toThrow('Bad user status')
  })

  test('surfaces API error messages for failed admin user actions', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      error: 'Cannot deactivate system accounts.'
    }, false))

    await expect(setAdminUserActive(fetchImpl, 1, false, 'Bad user status')).rejects.toThrow('Cannot deactivate system accounts.')
  })

  test('fetches and validates user detail payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      id: 42,
      name: 'Alice',
      email: 'alice@example.com',
      providerKey: 'local',
      providerName: 'Local',
      providerId: 'provider-42',
      providerIs2FACapable: true,
      location: 'Tallinn',
      jobTitle: 'Architect',
      timezone: 'Europe/Tallinn',
      isSystem: false,
      isActive: true,
      isVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastLoginAt: '2026-01-03T00:00:00.000Z',
      tfaIsActive: true,
      groups: [
        { id: 1, name: 'Administrators', description: 'hidden' },
        { id: 3, name: 'Editors' }
      ]
    }))

    await expect(fetchUserDetails(fetchImpl, '42')).resolves.toEqual({
      id: 42,
      name: 'Alice',
      email: 'alice@example.com',
      providerKey: 'local',
      providerName: 'Local',
      providerId: 'provider-42',
      providerIs2FACapable: true,
      location: 'Tallinn',
      jobTitle: 'Architect',
      timezone: 'Europe/Tallinn',
      isSystem: false,
      isActive: true,
      isVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastLoginAt: '2026-01-03T00:00:00.000Z',
      tfaIsActive: true,
      groups: [
        { id: 1, name: 'Administrators' },
        { id: 3, name: 'Editors' }
      ]
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/42', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects invalid user detail ids before fetching', async () => {
    const fetchImpl = jest.fn()

    await expect(fetchUserDetails(fetchImpl, '42abc', 'Bad user detail payload')).rejects.toThrow('Bad user detail payload')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('rejects malformed user detail payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      id: 42,
      name: 'Alice',
      email: 'alice@example.com',
      providerKey: 'local',
      providerName: 'Local',
      providerId: 'provider-42',
      providerIs2FACapable: 'yes',
      location: 'Tallinn',
      jobTitle: 'Architect',
      timezone: 'Europe/Tallinn',
      isSystem: false,
      isActive: true,
      isVerified: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      lastLoginAt: '2026-01-03T00:00:00.000Z',
      tfaIsActive: true,
      groups: [
        { id: 1, name: 'Administrators' }
      ]
    }))

    await expect(fetchUserDetails(fetchImpl, 42, 'Bad user detail payload')).rejects.toThrow('Bad user detail payload')
  })

  test('surfaces API error messages for failed searches', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'a user search admin permission is required' })
    })

    await expect(searchUsers(fetchImpl, 'alice', 'Bad user search')).rejects.toThrow('a user search admin permission is required')
  })
})
