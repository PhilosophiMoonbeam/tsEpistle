const { fetchContributors } = require('./contribute-api')

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('contribute api helper', () => {
  test('requests contributors with same-origin JSON options', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([]))

    await expect(fetchContributors(fetchImpl)).resolves.toEqual([])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/contribute/contributors', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('validates and sanitizes contributor rows', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        id: 'one',
        source: 'github',
        name: 'Ada',
        joined: '2024-01-02',
        website: 'https://example.invalid',
        twitter: 'https://twitter.com/ada',
        avatar: 'https://example.invalid/avatar.png',
        privateField: 'must-not-return'
      }
    ]))

    await expect(fetchContributors(fetchImpl)).resolves.toEqual([
      {
        id: 'one',
        source: 'github',
        name: 'Ada',
        joined: '2024-01-02',
        website: 'https://example.invalid',
        twitter: 'https://twitter.com/ada',
        avatar: 'https://example.invalid/avatar.png'
      }
    ])
  })

  test('allows null optional website, twitter, and avatar fields', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        id: 'two',
        source: 'patreon',
        name: 'Grace',
        joined: '2024-03-04',
        website: null,
        twitter: null,
        avatar: null
      }
    ]))

    await expect(fetchContributors(fetchImpl)).resolves.toEqual([
      {
        id: 'two',
        source: 'patreon',
        name: 'Grace',
        joined: '2024-03-04',
        website: null,
        twitter: null,
        avatar: null
      }
    ])
  })

  test('rejects malformed root payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ contributors: [] }))

    await expect(fetchContributors(fetchImpl, 'Bad contributors payload')).rejects.toThrow('Bad contributors payload')
  })

  test('rejects malformed contributor rows with invalid required fields', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        id: 123,
        source: 'github',
        name: 'Ada',
        joined: '2024-01-02',
        website: null,
        twitter: null,
        avatar: null
      }
    ]))

    await expect(fetchContributors(fetchImpl, 'Bad contributors row')).rejects.toThrow('Bad contributors row')
  })

  test('rejects malformed contributor rows with invalid optional fields', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        id: 'one',
        source: 'github',
        name: 'Ada',
        joined: '2024-01-02',
        website: false,
        twitter: null,
        avatar: null
      }
    ]))

    await expect(fetchContributors(fetchImpl, 'Bad contributors optional')).rejects.toThrow('Bad contributors optional')
  })

  test('propagates API JSON errors', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ message: 'contributors unavailable' })
    })

    await expect(fetchContributors(fetchImpl, 'Bad contributors load')).rejects.toThrow('contributors unavailable')
  })

  test('rejects non-JSON successful responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(fetchContributors(fetchImpl, 'Bad contributors content type')).rejects.toThrow('Bad contributors content type')
  })
})
