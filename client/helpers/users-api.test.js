const { searchUsers } = require('./users-api')

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
