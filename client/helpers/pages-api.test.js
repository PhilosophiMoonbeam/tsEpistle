const { deletePage, deletePageTag, fetchPageTags, fetchRecentPages, updatePageTag } = require('./pages-api')

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
  test('fetches and validates admin page tags payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      {
        id: 1,
        tag: 'alpha',
        title: 'Alpha',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        extra: 'ignored'
      },
      {
        id: 2,
        tag: 'zeta',
        title: null,
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-04T00:00:00.000Z'
      }
    ]))

    await expect(fetchPageTags(fetchImpl)).resolves.toEqual([
      { id: 1, tag: 'alpha', title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
      { id: 2, tag: 'zeta', title: null, createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z' }
    ])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/tags', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('accepts empty string tag values allowed by the tag update contract', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { id: 1, tag: '', title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }
    ]))

    await expect(fetchPageTags(fetchImpl)).resolves.toEqual([
      { id: 1, tag: '', title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }
    ])
  })

  test('rejects malformed admin page tags rows', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse([
      { id: 1, tag: 12, title: 'Alpha', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }
    ]))

    await expect(fetchPageTags(fetchImpl, 'Bad page tags payload')).rejects.toThrow('Bad page tags payload')
  })

  test('rejects non-array admin page tags payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ tags: [] }))

    await expect(fetchPageTags(fetchImpl, 'Bad page tags payload')).rejects.toThrow('Bad page tags payload')
  })

  test('surfaces API error messages for failed page tags requests', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'manage:system or read:pages is required' }, false))

    await expect(fetchPageTags(fetchImpl, 'Bad page tags payload')).rejects.toThrow('manage:system or read:pages is required')
  })

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

  test('deletes pages with same-origin JSON DELETE', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Page has been deleted.' }))

    await expect(deletePage(fetchImpl, 7)).resolves.toEqual({ message: 'Page has been deleted.' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/7', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('surfaces API error messages for failed page delete requests', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'This page does not exist.' }, false))

    await expect(deletePage(fetchImpl, 7)).rejects.toThrow('This page does not exist.')
  })

  test('rejects malformed successful page delete responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({}))

    await expect(deletePage(fetchImpl, 7, 'Bad page delete response')).rejects.toThrow('Bad page delete response')
  })

  test('updates page tags with same-origin JSON PATCH', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Tag has been updated successfully.' }))

    await expect(updatePageTag(fetchImpl, 7, '  News  ', '  Current News  ')).resolves.toEqual({ message: 'Tag has been updated successfully.' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/tags/7', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ tag: '  News  ', title: '  Current News  ' })
    })
  })

  test('surfaces API error messages for failed tag update requests', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'This tag does not exist.' }, false))

    await expect(updatePageTag(fetchImpl, 7, 'News', 'News')).rejects.toThrow('This tag does not exist.')
  })

  test('rejects malformed successful tag update responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({}))

    await expect(updatePageTag(fetchImpl, 7, 'News', 'News', 'Bad tag update response')).rejects.toThrow('Bad tag update response')
  })

  test('deletes page tags with same-origin JSON DELETE', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ message: 'Tag has been deleted.' }))

    await expect(deletePageTag(fetchImpl, 7)).resolves.toEqual({ message: 'Tag has been deleted.' })

    expect(fetchImpl).toHaveBeenCalledWith('/_api/pages/tags/7', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('surfaces API error messages for failed tag delete requests', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({ error: 'This tag does not exist.' }, false))

    await expect(deletePageTag(fetchImpl, 7)).rejects.toThrow('This tag does not exist.')
  })

  test('rejects malformed successful tag delete responses', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(createJsonResponse({}))

    await expect(deletePageTag(fetchImpl, 7, 'Bad tag delete response')).rejects.toThrow('Bad tag delete response')
  })
})
