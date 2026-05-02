const { searchUsers, fetchLastLogins, fetchAdminUsersList, fetchUserDetails } = require('./users-api')

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
