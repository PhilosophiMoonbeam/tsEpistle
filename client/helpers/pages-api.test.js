const { fetchRecentPages } = require('./pages-api')

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('pages api helper', () => {
  test('fetches and validates dashboard recent-pages payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        id: 10,
        locale: 'en',
        path: 'docs/alpha',
        title: 'Alpha',
        updatedAt: '2026-01-03T00:00:00.000Z',
        isPrivate: true
      },
      {
        id: 11,
        locale: 'fr',
        path: 'docs/beta',
        title: 'Beta',
        updatedAt: '2026-01-02T00:00:00.000Z'
      }
    ]))

    await expect(fetchRecentPages(fetchImpl)).resolves.toEqual([
      { id: 10, locale: 'en', path: 'docs/alpha', title: 'Alpha', updatedAt: '2026-01-03T00:00:00.000Z' },
      { id: 11, locale: 'fr', path: 'docs/beta', title: 'Beta', updatedAt: '2026-01-02T00:00:00.000Z' }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/recent', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('accepts empty string fields allowed by the dashboard GraphQL contract', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        id: 12,
        locale: 'en',
        path: '',
        title: '',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ]))

    await expect(fetchRecentPages(fetchImpl)).resolves.toEqual([
      { id: 12, locale: 'en', path: '', title: '', updatedAt: '2026-01-01T00:00:00.000Z' }
    ])
  })

  test('rejects malformed dashboard recent-pages rows', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { id: 10, locale: 'en', path: 'docs/alpha', title: 'Alpha', updatedAt: null }
    ]))

    await expect(fetchRecentPages(fetchImpl, 'Bad recent pages payload')).rejects.toThrow('Bad recent pages payload')
  })

  test('rejects non-array dashboard recent-pages payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ pages: [] }))

    await expect(fetchRecentPages(fetchImpl, 'Bad recent pages payload')).rejects.toThrow('Bad recent pages payload')
  })

  test('surfaces API error messages for failed recent-pages requests', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ error: 'manage:system or read:pages is required' })
    })

    await expect(fetchRecentPages(fetchImpl, 'Bad recent pages payload')).rejects.toThrow('manage:system or read:pages is required')
  })
})
