const { fetchGroupOptions, fetchGroupsList } = require('./groups-api')

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
})
