const { fetchGroupOptions, fetchGroupsList, fetchGroupDetails, createGroup } = require('./groups-api')

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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { id: 1, name: 'Administrators', isSystem: true },
      { id: 3, name: 'Editors', isSystem: false }
    ]))

    await expect(fetchGroupOptions(fetchImpl)).resolves.toEqual([
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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { id: '3', name: 'Editors', isSystem: false }
    ]))

    await expect(fetchGroupOptions(fetchImpl, 'Bad groups payload')).rejects.toThrow('Bad groups payload')
  })

  test('fetches and validates groups list', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        id: 1,
        name: 'Administrators',
        isSystem: true,
        userCount: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
    ]))

    await expect(fetchGroupsList(fetchImpl)).resolves.toEqual([
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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        id: 1,
        name: 'Administrators',
        isSystem: true,
        userCount: '2',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
    ]))

    await expect(fetchGroupsList(fetchImpl, 'Bad groups list payload')).rejects.toThrow('Bad groups list payload')
  })

  test('fetches and validates group detail payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
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

    await expect(fetchGroupDetails(fetchImpl, 3)).resolves.toEqual({
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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
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

    await expect(fetchGroupDetails(fetchImpl, 3, 'Bad group detail payload')).rejects.toThrow('Bad group detail payload')
  })

  test('surfaces API error messages for group fetch failures', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:groups is required' })
    })

    await expect(fetchGroupOptions(fetchImpl, 'Bad groups fetch')).rejects.toThrow('manage:groups is required')
  })

  test('creates groups through the REST endpoint', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      succeeded: true,
      message: 'Group created successfully.',
      group: { id: 3, name: 'Editors', isSystem: false }
    }))

    await expect(createGroup(fetchImpl, 'Editors')).resolves.toEqual({
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
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      succeeded: false,
      message: 'Nope'
    }))

    await expect(createGroup(fetchImpl, 'Editors', 'Bad group create payload')).rejects.toThrow('Bad group create payload')
  })

  test('surfaces API error messages for failed group creates', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({
      error: 'write:groups, manage:groups, or manage:system is required'
    }, false))

    await expect(createGroup(fetchImpl, 'Editors', 'Bad group create')).rejects.toThrow('write:groups, manage:groups, or manage:system is required')
  })
})
