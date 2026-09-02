import { searchUsers, fetchLastLogins, fetchAdminUsersList, createAdminUser, sendAdminUserWelcomeEmail, updateAdminUser, deleteAdminUser, setAdminUserActive, verifyAdminUser, setAdminUserTfa, fetchUserDetails, updateProfileAppearance } from './users-api.ts'

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
    const fetchImpl = vi.fn()

    expect(await searchUsers(fetchImpl, ' a ')).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('fetches and validates user search results', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      { id: 42, name: 'Alice', email: 'alice@example.com', providerKey: 'local' },
      { id: 77, name: 'Bob', email: 'bob@example.com', providerKey: 'ldap' }
    ]))

    expect(await searchUsers(fetchImpl, ' alice ')).toEqual([
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      { id: '42', name: 'Alice', email: 'alice@example.com', providerKey: 'local' }
    ]))

    await expect(Promise.resolve(searchUsers(fetchImpl, 'alice', 'Bad user search payload'))).rejects.toThrow('Bad user search payload')
  })

  test('fetches and validates dashboard last-logins payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      { id: 42, name: 'Alice', lastLoginAt: '2026-01-03T00:00:00.000Z', email: 'hidden@example.com' },
      { id: 77, name: 'Bob', lastLoginAt: '2026-01-02T00:00:00.000Z' }
    ]))

    expect(await fetchLastLogins(fetchImpl)).toEqual([
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      { id: 42, name: 'Alice', lastLoginAt: null }
    ]))

    await expect(Promise.resolve(fetchLastLogins(fetchImpl, 'Bad last logins payload'))).rejects.toThrow('Bad last logins payload')
  })

  test('fetches and validates admin users list payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
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

    expect(await fetchAdminUsersList(fetchImpl, {
      page: 3,
      pageSize: 15,
      filter: 'ali',
      providerKey: 'local',
      orderBy: 'lastLoginAt',
      orderByDirection: 'desc'
    })).toEqual({
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
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

    await expect(Promise.resolve(fetchAdminUsersList(fetchImpl, {}, 'Bad users list payload'))).rejects.toThrow('Bad users list payload')
  })

  test('surfaces API error messages for failed admin users lists', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      error: 'manage:users or manage:system is required'
    }, false))

    await expect(Promise.resolve(fetchAdminUsersList(fetchImpl, {}, 'Bad users list'))).rejects.toThrow('manage:users or manage:system is required')
  })

  test('creates admin users with the expected REST payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
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

    expect(await createAdminUser(fetchImpl, payload)).toEqual({
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

  test('preserves welcome-mail warnings on successful user creation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User created successfully',
      welcomeEmailError: 'SMTP unavailable'
    }))

    await expect(createAdminUser(fetchImpl, {})).resolves.toEqual({
      succeeded: true,
      message: 'User created successfully',
      welcomeEmailError: 'SMTP unavailable'
    })
  })

  test('sends a welcome email to an existing admin user', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'Welcome email sent successfully'
    }))

    await expect(sendAdminUserWelcomeEmail(fetchImpl, '42')).resolves.toEqual({
      succeeded: true,
      message: 'Welcome email sent successfully'
    })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/42/welcome-email', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    })
  })

  test('rejects malformed admin user create payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      message: 'User created successfully'
    }))

    await expect(Promise.resolve(createAdminUser(fetchImpl, {}, 'Bad user create payload'))).rejects.toThrow('Bad user create payload')
  })

  test('surfaces API error messages for failed admin user creates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      error: 'You are not authorized to assign a user to a group with elevated permissions.'
    }, false))

    await expect(Promise.resolve(createAdminUser(fetchImpl, {}, 'Bad user create'))).rejects.toThrow('You are not authorized to assign a user to a group with elevated permissions.')
  })

  test('updates admin users with the expected REST payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User created successfully'
    }))
    const payload = {
      email: 'alice@example.com',
      name: 'Alice',
      newPassword: '',
      groups: [3, 4],
      location: 'Tallinn',
      jobTitle: 'Architect',
      timezone: 'Europe/Tallinn'
    }

    expect(await updateAdminUser(fetchImpl, '42', payload)).toEqual({
      succeeded: true,
      message: 'User created successfully'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/42', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
  })

  test('rejects invalid admin user update ids before fetching', async () => {
    const fetchImpl = vi.fn()

    await expect(Promise.resolve(updateAdminUser(fetchImpl, '42abc', {}, 'Bad user update'))).rejects.toThrow('Bad user update')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('rejects malformed admin user update payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true
    }))

    await expect(Promise.resolve(updateAdminUser(fetchImpl, 42, {}, 'Bad user update'))).rejects.toThrow('Bad user update')
  })

  test('surfaces API error messages for failed admin user updates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      error: 'Password must be at least 6 characters!'
    }, false))

    await expect(Promise.resolve(updateAdminUser(fetchImpl, 42, {}, 'Bad user update'))).rejects.toThrow('Password must be at least 6 characters!')
  })

  test('deletes admin users with the expected REST payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User deleted successfully'
    }))

    expect(await deleteAdminUser(fetchImpl, '42', 7)).toEqual({
      succeeded: true,
      message: 'User deleted successfully'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/42', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ replaceId: 7 })
    })
  })

  test('rejects invalid admin user delete ids before fetching', async () => {
    const fetchImpl = vi.fn()

    await expect(Promise.resolve(deleteAdminUser(fetchImpl, '42abc', 7, 'Bad user delete'))).rejects.toThrow('Bad user delete')
    await expect(Promise.resolve(deleteAdminUser(fetchImpl, 42, '7abc', 'Bad user delete'))).rejects.toThrow('Bad user delete')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('rejects malformed admin user delete payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true
    }))

    await expect(Promise.resolve(deleteAdminUser(fetchImpl, 42, 7, 'Bad user delete'))).rejects.toThrow('Bad user delete')
  })

  test('surfaces API error messages for failed admin user deletes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      error: 'Cannot delete a protected system account.'
    }, false))

    await expect(Promise.resolve(deleteAdminUser(fetchImpl, 1, 7, 'Bad user delete'))).rejects.toThrow('Cannot delete a protected system account.')
  })

  test('patches admin user active state with the expected REST payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User deactivated successfully'
    }))

    expect(await setAdminUserActive(fetchImpl, '42', false)).toEqual({
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User verified successfully'
    }))

    expect(await verifyAdminUser(fetchImpl, 42)).toEqual({
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
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User 2FA enabled successfully'
    }))

    expect(await setAdminUserTfa(fetchImpl, 42, true)).toEqual({
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
    const fetchImpl = vi.fn()

    await expect(Promise.resolve(setAdminUserActive(fetchImpl, '42abc', true, 'Bad user status'))).rejects.toThrow('Bad user status')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('rejects malformed admin user action payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: false,
      message: 'User activated successfully'
    }))

    await expect(Promise.resolve(setAdminUserActive(fetchImpl, 42, true, 'Bad user status'))).rejects.toThrow('Bad user status')
  })

  test('surfaces API error messages for failed admin user actions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      error: 'Cannot deactivate system accounts.'
    }, false))

    await expect(Promise.resolve(setAdminUserActive(fetchImpl, 1, false, 'Bad user status'))).rejects.toThrow('Cannot deactivate system accounts.')
  })

  test('fetches and validates user detail payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
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

    expect(await fetchUserDetails(fetchImpl, '42')).toEqual({
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
    const fetchImpl = vi.fn()

    await expect(Promise.resolve(fetchUserDetails(fetchImpl, '42abc', 'Bad user detail payload'))).rejects.toThrow('Bad user detail payload')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('rejects malformed user detail payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
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

    await expect(Promise.resolve(fetchUserDetails(fetchImpl, 42, 'Bad user detail payload'))).rejects.toThrow('Bad user detail payload')
  })
  test('updates profile appearance with the expected REST payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ token: 'replacement-jwt' }))

    await expect(updateProfileAppearance(fetchImpl, 'dark')).resolves.toBe('replacement-jwt')

    expect(fetchImpl).toHaveBeenCalledWith('/_api/users/profile/appearance', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ appearance: 'dark' })
    })
  })

  test('rejects profile appearance responses without a non-empty token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ token: '' }))

    await expect(updateProfileAppearance(fetchImpl, 'system', 'Bad appearance response')).rejects.toThrow('Bad appearance response')
  })


  test('surfaces API error messages for failed searches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'a user search admin permission is required' })
    })

    await expect(Promise.resolve(searchUsers(fetchImpl, 'alice', 'Bad user search'))).rejects.toThrow('a user search admin permission is required')
  })
})
