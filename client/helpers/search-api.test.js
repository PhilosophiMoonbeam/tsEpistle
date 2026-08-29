import { fetchSearchEngines, rebuildSearchIndex, saveSearchEngines } from './search-api.ts'

function createJsonResponse (payload, ok = true) {
  return {
    ok,
    headers: {
      get: () => 'application/json; charset=utf-8'
    },
    json: async () => payload
  }
}

describe('search api helper', () => {
  test('requests search engines with same-origin JSON options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([]))

    expect(await fetchSearchEngines(fetchImpl)).toEqual([])

    expect(fetchImpl).toHaveBeenCalledWith('/_api/search/engines', {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('validates and sanitizes search engines', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'db',
        title: 'Database',
        description: 'Built-in search engine.',
        logo: '/db.svg',
        website: 'https://example.test/db',
        isAvailable: true,
        config: [
          {
            key: 'minScore',
            value: JSON.stringify({ type: 'string', title: 'Minimum Score', order: 1, value: '0.5' })
          }
        ]
      }
    ]))

    expect(await fetchSearchEngines(fetchImpl)).toEqual([
      {
        isEnabled: true,
        key: 'db',
        title: 'Database',
        description: 'Built-in search engine.',
        logo: '/db.svg',
        website: 'https://example.test/db',
        isAvailable: true,
        config: [
          {
            key: 'minScore',
            value: { type: 'string', title: 'Minimum Score', order: 1, value: '0.5' }
          }
        ]
      }
    ])
  })

  test('parses config JSON and sorts config by parsed value order with missing orders last', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: false,
        key: 'elastic',
        title: 'Elasticsearch',
        description: 'Elasticsearch engine.',
        logo: '/elastic.svg',
        website: 'https://example.test/elastic',
        isAvailable: true,
        config: [
          {
            key: 'endpoint',
            value: JSON.stringify({ type: 'string', title: 'Endpoint', order: 3, value: 'https://example.test/search' })
          },
          {
            key: 'indexName',
            value: JSON.stringify({ type: 'string', title: 'Index Name', value: 'docs-index' })
          },
          {
            key: 'enabledFlag',
            value: JSON.stringify({ type: 'boolean', title: 'Enabled Flag', order: 1, value: false })
          }
        ]
      }
    ]))

    const engines = await fetchSearchEngines(fetchImpl)

    expect(engines[0].config.map(row => row.key)).toEqual(['enabledFlag', 'endpoint', 'indexName'])
  })

  test('strips extra engine and config fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: false,
        key: 'external',
        title: 'External Search',
        description: 'External search engine.',
        logo: '/external.svg',
        website: 'https://example.test/external',
        isAvailable: true,
        privateField: 'must-not-return',
        props: { raw: true },
        config: [
          {
            key: 'endpoint',
            value: JSON.stringify({ type: 'string', title: 'Endpoint', order: 1, value: 'https://example.test/search' }),
            rawValue: 'must-not-return'
          }
        ]
      }
    ]))

    expect(await fetchSearchEngines(fetchImpl)).toEqual([
      {
        isEnabled: false,
        key: 'external',
        title: 'External Search',
        description: 'External search engine.',
        logo: '/external.svg',
        website: 'https://example.test/external',
        isAvailable: true,
        config: [
          {
            key: 'endpoint',
            value: { type: 'string', title: 'Endpoint', order: 1, value: 'https://example.test/search' }
          }
        ]
      }
    ])
  })

  test('rejects malformed root payloads', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ engines: [] }))

    await expect(Promise.resolve(fetchSearchEngines(fetchImpl, 'Bad search payload'))).rejects.toThrow('Bad search payload')
  })

  test('rejects malformed engine rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: 'yes',
        key: 'db',
        title: 'Database',
        description: 'Built-in search engine.',
        logo: '/db.svg',
        website: 'https://example.test/db',
        isAvailable: true,
        config: []
      }
    ]))

    await expect(Promise.resolve(fetchSearchEngines(fetchImpl, 'Bad search row'))).rejects.toThrow('Bad search row')
  })

  test('rejects malformed config rows', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'db',
        title: 'Database',
        description: 'Built-in search engine.',
        logo: '/db.svg',
        website: 'https://example.test/db',
        isAvailable: true,
        config: [{ key: 12, value: '{}' }]
      }
    ]))

    await expect(Promise.resolve(fetchSearchEngines(fetchImpl, 'Bad search config'))).rejects.toThrow('Bad search config')
  })

  test('rejects malformed config JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse([
      {
        isEnabled: true,
        key: 'db',
        title: 'Database',
        description: 'Built-in search engine.',
        logo: '/db.svg',
        website: 'https://example.test/db',
        isAvailable: true,
        config: [{ key: 'minScore', value: '{not-json' }]
      }
    ]))

    await expect(Promise.resolve(fetchSearchEngines(fetchImpl, 'Bad search JSON'))).rejects.toThrow('Bad search JSON')
  })

  test('propagates API JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      headers: {
        get: () => 'application/json; charset=utf-8'
      },
      json: async () => ({ message: 'manage:system is required' })
    })

    await expect(Promise.resolve(fetchSearchEngines(fetchImpl, 'Bad search load'))).rejects.toThrow('manage:system is required')
  })

  test('rejects non-JSON successful responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(Promise.resolve(fetchSearchEngines(fetchImpl, 'Bad search content type'))).rejects.toThrow('Bad search content type')
  })

  test('saves search engines with same-origin JSON POST options', async () => {
    const engines = [{ key: 'db', isEnabled: true, config: [] }]
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Search Engines updated successfully' }))

    expect(await saveSearchEngines(fetchImpl, engines)).toEqual({ message: 'Search Engines updated successfully' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/search/engines', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ engines })
    })
  })

  test('rejects malformed successful search engine save responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ ok: true }))

    await expect(Promise.resolve(saveSearchEngines(fetchImpl, [], 'Bad save payload'))).rejects.toThrow('Bad save payload')
  })

  test('propagates API JSON errors for search engine saves', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Invalid search engines payload' }, false))

    await expect(Promise.resolve(saveSearchEngines(fetchImpl, [], 'Bad save'))).rejects.toThrow('Invalid search engines payload')
  })

  test('rejects non-JSON successful search engine save responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(Promise.resolve(saveSearchEngines(fetchImpl, [], 'Bad save content type'))).rejects.toThrow('Bad save content type')
  })

  test('rebuilds search index with same-origin JSON options', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ message: 'Index rebuilt successfully' }))

    expect(await rebuildSearchIndex(fetchImpl)).toEqual({ message: 'Index rebuilt successfully' })
    expect(fetchImpl).toHaveBeenCalledWith('/_api/search/rebuild-index', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    })
  })

  test('propagates API JSON errors for search index rebuilds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(createJsonResponse({ error: 'Index rebuild failed' }, false))

    await expect(Promise.resolve(rebuildSearchIndex(fetchImpl, 'Bad rebuild'))).rejects.toThrow('Index rebuild failed')
  })

  test('rejects non-JSON successful search index rebuild responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: () => 'text/plain'
      }
    })

    await expect(Promise.resolve(rebuildSearchIndex(fetchImpl, 'Bad rebuild content type'))).rejects.toThrow('Bad rebuild content type')
  })
})
