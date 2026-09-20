import { describe, expect, test } from '../../server/test/bun-test.mts'
import { OFFLINE_SAVED_PAGE_OPEN_EVENT, requestOfflineSavedPageOpen } from '../helpers/offline-routes.ts'
import {
  OFFLINE_SEARCH_DOCUMENT_CHARACTER_LIMIT,
  OFFLINE_SEARCH_QUERY_CHARACTER_LIMIT,
  OFFLINE_SEARCH_QUERY_TERM_LIMIT,
  OFFLINE_SEARCH_RESULT_LIMIT,
  OFFLINE_SEARCH_SCORING_CHUNK_CHARACTERS,
  mergeOfflineSearchCorpora,
  normalizeOfflineSearchText,
  prepareOfflineSearchCorpus,
  searchPreparedOfflineDocuments,
  searchPreparedOfflineDocumentsAsync
} from '../helpers/offline-search.ts'

const capturedAt = '2026-09-01T00:00:00.000Z'

const makeDocument = (pageId: number, overrides: Partial<OfflineSearchDocumentV1> = {}): OfflineSearchDocumentV1 => ({
  schemaVersion: 1,
  siteId: 'offline-search-test-site',
  pageId,
  locale: 'en',
  path: `docs/page-${pageId}`,
  canonicalPath: `docs/page-${pageId}`,
  title: `Page ${pageId}`,
  description: '',
  searchText: '',
  capturedAt,
  byteSize: 0,
  ...overrides
})

const pageIds = (results: readonly { document: OfflineSearchDocumentV1 }[]): number[] => results.map(result => result.document.pageId)

describe('offline search', () => {
  test('ranks exact titles ahead of title prefixes, title tokens, descriptions, and body frequency', async () => {
    const documents = [
      makeDocument(1, { title: 'Alpha' }),
      makeDocument(2, { title: 'Alpha handbook' }),
      makeDocument(3, { title: 'The Alpha handbook' }),
      makeDocument(4, { title: 'Handbook', description: 'Alpha appears here', searchText: 'Alpha Alpha Alpha' }),
      makeDocument(5, { title: 'Body low', searchText: 'Alpha' }),
      makeDocument(6, { title: 'Body high', searchText: 'Alpha Alpha Alpha' })
    ]
    const corpus = await prepareOfflineSearchCorpus(documents)

    expect(pageIds(searchPreparedOfflineDocuments(corpus, '  ALPHA  ').results)).toEqual([1, 2, 3, 4, 6, 5])
  })

  test('requires every query term while matching them across fields', async () => {
    const corpus = await prepareOfflineSearchCorpus([
      makeDocument(1, { title: 'Visual Markdown Browser' }),
      makeDocument(2, { title: 'Visual HTML Browser' }),
      makeDocument(3, { title: 'Visual guide', searchText: 'Markdown reference' })
    ])

    expect(pageIds(searchPreparedOfflineDocuments(corpus, 'Visual Markdown').results)).toEqual([1, 3])
    expect(pageIds((await searchPreparedOfflineDocumentsAsync(corpus, 'Visual Markdown')).results)).toEqual([1, 3])
  })

  test('uses deterministic title, locale, and page ordering for equal matches', async () => {
    const documents = [
      makeDocument(30, { title: 'Same title', locale: 'en', searchText: 'needle' }),
      makeDocument(20, { title: 'Same title', locale: 'fr', searchText: 'needle' }),
      makeDocument(10, { title: 'Same title', locale: 'en', searchText: 'needle' }),
      makeDocument(40, { title: 'Another title', locale: 'en', searchText: 'needle' })
    ]
    const corpus = await prepareOfflineSearchCorpus(documents)
    const reversedCorpus = await prepareOfflineSearchCorpus([...documents].reverse())
    const expectedOrder = [40, 10, 30, 20]

    expect(pageIds(searchPreparedOfflineDocuments(corpus, 'needle').results)).toEqual(expectedOrder)
    expect(pageIds(searchPreparedOfflineDocuments(reversedCorpus, 'needle').results)).toEqual(expectedOrder)
  })

  test('reuses one prepared corpus for synchronous and asynchronous queries', async () => {
    const corpus = await prepareOfflineSearchCorpus([
      makeDocument(1, { title: 'Prepared title', description: 'Prepared description', searchText: 'Prepared body' }),
      makeDocument(2, { title: 'Other page', searchText: 'Prepared body' })
    ])

    expect(pageIds(searchPreparedOfflineDocuments(corpus, 'prepared').results)).toEqual([1, 2])
    expect(pageIds((await searchPreparedOfflineDocumentsAsync(corpus, 'description')).results)).toEqual([1])
  })

  test('unions public and private prepared corpora while private identities win', async () => {
    const publicDocument = makeDocument(1, { title: 'Public page' })
    const publicCollision = makeDocument(2, { title: 'Public projection' })
    const privateCollision = makeDocument(2, { title: 'Private page' })
    const privateDocument = makeDocument(3, { siteId: 'private-site-id', title: 'Private notes' })
    const publicCorpus = await prepareOfflineSearchCorpus([publicDocument, publicCollision])
    const privateCorpus = await prepareOfflineSearchCorpus([privateCollision, privateDocument])

    const merged = mergeOfflineSearchCorpora(publicCorpus, privateCorpus)

    expect(pageIds(searchPreparedOfflineDocuments(merged, '').results)).toEqual([3, 2, 1])
    expect(searchPreparedOfflineDocuments(merged, 'private').results.map(result => result.document.title)).toEqual(['Private notes', 'Private page'])
  })

  test('requests in-document private saved-page activation without changing canonical links', () => {
    const originalWindow = (globalThis as typeof globalThis & { window?: unknown }).window
    const events: CustomEvent[] = []
    const windowMock = {
      location: { origin: 'https://wiki.example.test' },
      dispatchEvent(event: Event): boolean {
        events.push(event as CustomEvent)
        event.preventDefault()
        return true
      }
    }
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: windowMock })
    try {
      expect(
        requestOfflineSavedPageOpen({
          siteId: 'private-site-id',
          pageId: 1,
          locale: 'en',
          audience: 'private',
          canonicalPath: '/_private/en/x'
        })
      ).toBe(true)
      expect(
        requestOfflineSavedPageOpen({
          siteId: 'private-site-id',
          pageId: 2,
          locale: 'en',
          audience: 'private',
          canonicalPath: '/en/x'
        })
      ).toBe(true)
      const canonicalPaths = events.map(event => {
        const detail = event.detail
        if (!detail || typeof detail !== 'object' || !('canonicalPath' in detail) || typeof detail.canonicalPath !== 'string') return ''
        return detail.canonicalPath
      })
      expect(events.map((event, index) => [event.type, canonicalPaths[index]] as const)).toEqual([
        [OFFLINE_SAVED_PAGE_OPEN_EVENT, '/_private/en/x'],
        [OFFLINE_SAVED_PAGE_OPEN_EVENT, '/en/x']
      ])
    } finally {
      if (originalWindow === undefined) delete (globalThis as typeof globalThis & { window?: unknown }).window
      else Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow })
    }
  })

  test('bounds a 100-document corpus to 50 results and ignores records beyond the corpus bound', async () => {
    const documents = Array.from({ length: 100 }, (_, index) =>
      makeDocument(index + 1, {
        title: `Entry ${String(index + 1).padStart(3, '0')}`,
        searchText: 'common-term'
      })
    )
    const overflow = makeDocument(101, { title: 'Overflow sentinel', searchText: 'overflow-sentinel' })
    const corpus = await prepareOfflineSearchCorpus([...documents, overflow])

    const results = searchPreparedOfflineDocuments(corpus, 'common-term', { limit: OFFLINE_SEARCH_RESULT_LIMIT + 1 })
    expect(results.results).toHaveLength(50)
    expect(pageIds(results.results)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
    expect(results.hasMore).toBe(true)
    expect(searchPreparedOfflineDocuments(corpus, 'overflow-sentinel').results).toEqual([])
  })

  test('inspects only the first 100 candidates before validation or deduplication', async () => {
    const duplicate = makeDocument(1, { title: 'Duplicate without marker' })
    const invalid = { ...makeDocument(2), pageId: 0 } as unknown as OfflineSearchDocumentV1
    const firstHundred = Array.from({ length: 100 }, (_, index) => (index % 2 === 0 ? duplicate : invalid))
    const corpus = await prepareOfflineSearchCorpus([...firstHundred, makeDocument(101, { title: 'Candidate 101', searchText: 'overflow-sentinel' })])
    const response = searchPreparedOfflineDocuments(corpus, 'overflow-sentinel')

    expect(response).toEqual({ results: [], hasMore: false })
  })

  test('bounds normalized query terms and compatibility-expanded characters', async () => {
    const terms = Array.from({ length: OFFLINE_SEARCH_QUERY_TERM_LIMIT + 1 }, (_, index) => `term${String(index + 1).padStart(3, '0')}x`)
    const termCorpus = await prepareOfflineSearchCorpus([
      makeDocument(1, { searchText: terms[terms.length - 1]! }),
      makeDocument(2, { searchText: terms.slice(0, -1).join(' ') })
    ])
    expect(pageIds(searchPreparedOfflineDocuments(termCorpus, terms.join(' ')).results)).toEqual([2])

    const expandedQuery = `${'\uFDFA'.repeat(40)} trailing`
    const expandedCorpus = await prepareOfflineSearchCorpus([makeDocument(3, { searchText: 'trailing' })])
    expect(searchPreparedOfflineDocuments(expandedCorpus, expandedQuery).results).toEqual([])
    expect(normalizeOfflineSearchText('\uFDFA'.repeat(40)).length).toBeGreaterThan(OFFLINE_SEARCH_QUERY_CHARACTER_LIMIT)
  })

  test('bounds scoring characters per document without admitting a marker beyond the budget', async () => {
    const beyondBudget = 'x'.repeat(OFFLINE_SEARCH_DOCUMENT_CHARACTER_LIMIT) + ' beyond-budget'
    const insideBudget = `needle ${'x'.repeat(OFFLINE_SEARCH_DOCUMENT_CHARACTER_LIMIT)}`
    const corpus = await prepareOfflineSearchCorpus([makeDocument(1, { searchText: beyondBudget }), makeDocument(2, { searchText: insideBudget })])

    const response = searchPreparedOfflineDocuments(corpus, 'beyond-budget')
    expect(response).toEqual({ results: [], hasMore: false })
    expect(pageIds(searchPreparedOfflineDocuments(corpus, 'needle').results)).toEqual([2])
  })

  test('reports more only when a matching result exceeds the effective limit', async () => {
    const noMatches = searchPreparedOfflineDocuments(await prepareOfflineSearchCorpus([makeDocument(1, { searchText: 'other' })]), 'missing')
    const oneMatch = searchPreparedOfflineDocuments(await prepareOfflineSearchCorpus([makeDocument(1, { searchText: 'needle' })]), 'needle')
    const exactlyFifty = searchPreparedOfflineDocuments(
      await prepareOfflineSearchCorpus(Array.from({ length: 50 }, (_, index) => makeDocument(index + 1, { searchText: 'needle' }))),
      'needle'
    )
    const fiftyOne = searchPreparedOfflineDocuments(
      await prepareOfflineSearchCorpus(Array.from({ length: 51 }, (_, index) => makeDocument(index + 1, { searchText: 'needle' }))),
      'needle'
    )
    const elevenAtTen = searchPreparedOfflineDocuments(
      await prepareOfflineSearchCorpus(Array.from({ length: 11 }, (_, index) => makeDocument(index + 1, { searchText: 'needle' }))),
      'needle',
      { limit: 10 }
    )

    expect(noMatches.hasMore).toBe(false)
    expect(oneMatch.hasMore).toBe(false)
    expect(exactlyFifty.results).toHaveLength(50)
    expect(exactlyFifty.hasMore).toBe(false)
    expect(fiftyOne.results).toHaveLength(50)
    expect(fiftyOne.hasMore).toBe(true)
    expect(elevenAtTen.results).toHaveLength(10)
    expect(elevenAtTen.hasMore).toBe(true)
  })

  test('normalizes Unicode compatibility forms and whitespace in queries and fields', async () => {
    const documents = [makeDocument(1, { title: '  ＣＡＦe\u0301  ' }), makeDocument(2, { title: 'Whitespace example', searchText: 'release\u000breview' })]
    const corpus = await prepareOfflineSearchCorpus(documents)

    expect(pageIds(searchPreparedOfflineDocuments(corpus, '\n café\u00a0').results)).toEqual([1])
    expect(pageIds(searchPreparedOfflineDocuments(corpus, ' release \t review ').results)).toEqual([2])
  })
  test('rejects an already-aborted signal before synchronous ranking starts', async () => {
    const controller = new AbortController()
    controller.abort()
    const corpus = await prepareOfflineSearchCorpus([makeDocument(1, { searchText: 'needle' })])
    let error: unknown

    try {
      searchPreparedOfflineDocuments(corpus, 'needle', { signal: controller.signal })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({ name: 'AbortError' })
  })

  test('cancels stale asynchronous scoring within one chunk before the latest query', async () => {
    const staleBody = `stale query ${'x'.repeat(OFFLINE_SEARCH_SCORING_CHUNK_CHARACTERS * 2)}`
    const documents = [
      ...Array.from({ length: 99 }, (_, index) => makeDocument(index + 1, { searchText: staleBody })),
      makeDocument(100, { title: 'Current', searchText: staleBody })
    ]
    const corpus = await prepareOfflineSearchCorpus(documents)
    const controller = new AbortController()
    const staleSearch = searchPreparedOfflineDocumentsAsync(corpus, 'stale query', { signal: controller.signal })
    queueMicrotask(() => controller.abort())

    await expect(staleSearch).rejects.toMatchObject({ name: 'AbortError' })

    const currentSearch = await searchPreparedOfflineDocumentsAsync(corpus, 'current', { limit: 1 })
    expect(pageIds(currentSearch.results)).toEqual([100])
  })
  test('bounds raw field input before compatibility normalization', async () => {
    const originalNormalize = String.prototype.normalize
    const observedInputLengths: number[] = []
    String.prototype.normalize = function (...args: Parameters<string['normalize']>): string {
      observedInputLengths.push(this.length)
      return originalNormalize.apply(this, args)
    }
    try {
      await prepareOfflineSearchCorpus([makeDocument(1, { searchText: `${'\uFDFA'.repeat(OFFLINE_SEARCH_DOCUMENT_CHARACTER_LIMIT)} overflow` })])
    } finally {
      String.prototype.normalize = originalNormalize
    }
    expect(observedInputLengths.length).toBeGreaterThan(0)
    expect(Math.max(...observedInputLengths)).toBeLessThanOrEqual(OFFLINE_SEARCH_DOCUMENT_CHARACTER_LIMIT)
  })

  test('aborts preparation during a maximum-corpus near-limit workload', async () => {
    const documents = Array.from({ length: 100 }, (_, index) => makeDocument(index + 1, { searchText: 'x'.repeat(OFFLINE_SEARCH_DOCUMENT_CHARACTER_LIMIT) }))
    const controller = new AbortController()
    const preparation = prepareOfflineSearchCorpus(documents, { signal: controller.signal })
    let settled = false
    void preparation.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    controller.abort()
    await expect(preparation).rejects.toMatchObject({ name: 'AbortError' })
  })
})
