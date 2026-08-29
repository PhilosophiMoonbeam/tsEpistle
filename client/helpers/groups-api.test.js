import { fetchGroupOptions, fetchGroupsList, fetchGroupDetails, createGroup, assignGroupUser, unassignGroupUser, deleteGroup, updateGroup } from './groups-api.ts'

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('groups api helper', () => {
  test('fetches and validates group options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      { id: 1, name: 'Administrators', isSystem: true },
      { id: 3, name: 'Editors', isSystem: false }
    ]))

    expect(await fetchGroupOptions(fetchImpl)).toEqual([
      { id: 1, name: 'Administrators', isSystem: true },
      { id: 3, name: 'Editors', isSystem: false }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/groups', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed group rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      { id: '3', name: 'Editors', isSystem: false }
    ]))

    await expect(Promise.resolve(fetchGroupOptions(fetchImpl, 'Bad groups payload'))).rejects.toThrow('Bad groups payload')
  })

  test('fetches and validates groups list', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        id: 1,
        name: 'Administrators',
        isSystem: true,
        userCount: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
    ]))

    expect(await fetchGroupsList(fetchImpl)).toEqual([
      {
        id: 1,
        name: 'Administrators',
        isSystem: true,
        userCount: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/groups/list', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed groups list rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        id: 1,
        name: 'Administrators',
        isSystem: true,
        userCount: '2',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
    ]))

    await expect(Promise.resolve(fetchGroupsList(fetchImpl, 'Bad groups list payload'))).rejects.toThrow('Bad groups list payload')
  })

  test('fetches and validates group detail payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      id: 3,
      name: 'Editors',
      redirectOnLogin: '/en/home',
      isSystem: false,
      permissions: ['read:pages', 'write:pages'],
      pageRules: [
        {
          id: 'rule-1',
          path: 'docs',
          roles: ['read:pages'],
          match: 'START',
          deny: false,
          locales: ['en']
        }
      ],
      users: [
        { id: 10, name: 'Alice', email: 'alice@example.com' }
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }))

    expect(await fetchGroupDetails(fetchImpl, 3)).toEqual({
      id: 3,
      name: 'Editors',
      redirectOnLogin: '/en/home',
      isSystem: false,
      permissions: ['read:pages', 'write:pages'],
      pageRules: [
        {
          id: 'rule-1',
          path: 'docs',
          roles: ['read:pages'],
          match: 'START',
          deny: false,
          locales: ['en']
        }
      ],
      users: [
        { id: 10, name: 'Alice', email: 'alice@example.com' }
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/groups/3', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed group detail payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      id: 3,
      name: 'Editors',
      redirectOnLogin: '/en/home',
      isSystem: false,
      permissions: ['read:pages'],
      pageRules: [
        {
          id: 'rule-1',
          path: 'docs',
          roles: ['read:pages'],
          match: 'INVALID',
          deny: false,
          locales: ['en']
        }
      ],
      users: [
        { id: 10, name: 'Alice', email: 'alice@example.com' }
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z'
    }))

    await expect(Promise.resolve(fetchGroupDetails(fetchImpl, 3, 'Bad group detail payload'))).rejects.toThrow('Bad group detail payload')
  })

  test('surfaces API error messages for group fetch failures', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:groups is required' })
    })

    await expect(Promise.resolve(fetchGroupOptions(fetchImpl, 'Bad groups fetch'))).rejects.toThrow('manage:groups is required')
  })

  test('creates groups through the REST endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'Group created successfully.',
      group: { id: 3, name: 'Editors', isSystem: false }
    }))

    expect(await createGroup(fetchImpl, 'Editors')).toEqual({
      succeeded: true,
      message: 'Group created successfully.',
      group: { id: 3, name: 'Editors', isSystem: false }
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/groups', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Editors' })
    })
  })

  test('rejects malformed group create responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: false,
      message: 'Nope'
    }))

    await expect(Promise.resolve(createGroup(fetchImpl, 'Editors', 'Bad group create payload'))).rejects.toThrow('Bad group create payload')
  })

  test('surfaces API error messages for failed group creates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      error: 'write:groups, manage:groups, or manage:system is required'
    }, false))

    await expect(Promise.resolve(createGroup(fetchImpl, 'Editors', 'Bad group create'))).rejects.toThrow('write:groups, manage:groups, or manage:system is required')
  })

  test('assigns group users through the REST endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User has been assigned to group.'
    }))

    expect(await assignGroupUser(fetchImpl, 3, 10)).toEqual({
      succeeded: true,
      message: 'User has been assigned to group.'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/groups/3/users/10', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed group user assign responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: false,
      message: 'Nope'
    }))

    await expect(Promise.resolve(assignGroupUser(fetchImpl, 3, 10, 'Bad assign payload'))).rejects.toThrow('Bad assign payload')
  })

  test('surfaces API error messages for failed group user assigns', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      error: 'User is already assigned to group.'
    }, false))

    await expect(Promise.resolve(assignGroupUser(fetchImpl, 3, 10, 'Bad assign'))).rejects.toThrow('User is already assigned to group.')
  })

  test('unassigns group users through the REST endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'User has been unassigned from group.'
    }))

    expect(await unassignGroupUser(fetchImpl, 3, 10)).toEqual({
      succeeded: true,
      message: 'User has been unassigned from group.'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/groups/3/users/10', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed group user unassign responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: false,
      message: 'Nope'
    }))

    await expect(Promise.resolve(unassignGroupUser(fetchImpl, 3, 10, 'Bad unassign payload'))).rejects.toThrow('Bad unassign payload')
  })

  test('surfaces API error messages for failed group user unassigns', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      error: 'Cannot unassign Guest user'
    }, false))

    await expect(Promise.resolve(unassignGroupUser(fetchImpl, 3, 2, 'Bad unassign'))).rejects.toThrow('Cannot unassign Guest user')
  })

  test('deletes groups through the REST endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'Group has been deleted.'
    }))

    expect(await deleteGroup(fetchImpl, 3)).toEqual({
      succeeded: true,
      message: 'Group has been deleted.'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/groups/3', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('rejects malformed group delete responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: false,
      message: 'Nope'
    }))

    await expect(Promise.resolve(deleteGroup(fetchImpl, 3, 'Bad delete payload'))).rejects.toThrow('Bad delete payload')
  })

  test('surfaces API error messages for failed group deletes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      error: 'Cannot delete this group.'
    }, false))

    await expect(Promise.resolve(deleteGroup(fetchImpl, 1, 'Bad delete'))).rejects.toThrow('Cannot delete this group.')
  })

  test('updates groups through the REST endpoint', async () => {
    const payload = {
      name: 'Editors',
      redirectOnLogin: '/docs',
      permissions: ['read:pages'],
      pageRules: [{ id: 'rule-1', path: 'docs', roles: ['read:pages'], match: 'START', deny: false, locales: ['en'] }]
    }
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'Group has been updated.'
    }))

    expect(await updateGroup(fetchImpl, 3, payload)).toEqual({
      succeeded: true,
      message: 'Group has been updated.'
    })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/groups/3', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
  })

  test('rejects malformed group update responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      succeeded: false,
      message: 'Nope'
    }))

    await expect(Promise.resolve(updateGroup(fetchImpl, 3, {}, 'Bad update payload'))).rejects.toThrow('Bad update payload')
  })

  test('surfaces API error messages for failed group updates', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({
      error: 'Some Page Rules contains unsafe or exponential time regex.'
    }, false))

    await expect(Promise.resolve(updateGroup(fetchImpl, 3, {}, 'Bad update'))).rejects.toThrow('Some Page Rules contains unsafe or exponential time regex.')
  })
})
