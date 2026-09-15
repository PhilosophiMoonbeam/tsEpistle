import { describe, expect, test } from '../../server/test/bun-test.mts'
import type { OfflineSearchDocumentV1 } from '../../shared/offline.ts'
import { searchOfflineDocuments, searchOfflineDocumentsAsync } from '../helpers/offline-search.ts'

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
  test('ranks exact titles ahead of title prefixes, title tokens, descriptions, and body frequency', () => {
    const documents = [
      makeDocument(1, { title: 'Alpha' }),
      makeDocument(2, { title: 'Alpha handbook' }),
      makeDocument(3, { title: 'The Alpha handbook' }),
      makeDocument(4, { title: 'Handbook', description: 'Alpha appears here', searchText: 'Alpha Alpha Alpha' }),
      makeDocument(5, { title: 'Body low', searchText: 'Alpha' }),
      makeDocument(6, { title: 'Body high', searchText: 'Alpha Alpha Alpha' })
    ]

    expect(pageIds(searchOfflineDocuments(documents, '  ALPHA  '))).toEqual([1, 2, 3, 4, 6, 5])
  })

  test('uses deterministic title, locale, and page ordering for equal matches', () => {
    const documents = [
      makeDocument(30, { title: 'Same title', locale: 'en', searchText: 'needle' }),
      makeDocument(20, { title: 'Same title', locale: 'fr', searchText: 'needle' }),
      makeDocument(10, { title: 'Same title', locale: 'en', searchText: 'needle' }),
      makeDocument(40, { title: 'Another title', locale: 'en', searchText: 'needle' })
    ]
    const expectedOrder = [40, 10, 30, 20]

    expect(pageIds(searchOfflineDocuments(documents, 'needle'))).toEqual(expectedOrder)
    expect(pageIds(searchOfflineDocuments([...documents].reverse(), 'needle'))).toEqual(expectedOrder)
  })

  test('bounds a 100-document corpus to 50 results and ignores records beyond the corpus bound', () => {
    const corpus = Array.from({ length: 100 }, (_, index) => makeDocument(index + 1, {
      title: `Entry ${String(index + 1).padStart(3, '0')}`,
      searchText: 'common-term'
    }))
    const overflow = makeDocument(101, { title: 'Overflow sentinel', searchText: 'overflow-sentinel' })

    const results = searchOfflineDocuments([...corpus, overflow], 'common-term', { limit: 200 })
    expect(results).toHaveLength(50)
    expect(pageIds(results)).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
    expect(searchOfflineDocuments([...corpus, overflow], 'overflow-sentinel')).toEqual([])
  })

  test('normalizes Unicode compatibility forms and whitespace in queries and fields', () => {
    const documents = [
      makeDocument(1, { title: '  ＣＡＦe\u0301  ' }),
      makeDocument(2, { title: 'Whitespace example', searchText: 'release\u000breview' })
    ]

    expect(pageIds(searchOfflineDocuments(documents, '\n café\u00a0'))).toEqual([1])
    expect(pageIds(searchOfflineDocuments(documents, ' release \t review '))).toEqual([2])
  })

  test('rejects an already-aborted signal before synchronous ranking starts', () => {
    const controller = new AbortController()
    controller.abort()
    let error: unknown

    try {
      searchOfflineDocuments([makeDocument(1, { searchText: 'needle' })], 'needle', { signal: controller.signal })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({ name: 'AbortError' })
  })

  test('cancels stale asynchronous ranking between bounded batches', async () => {
    const documents = Array.from({ length: 100 }, (_, index) => makeDocument(index + 1, { searchText: 'stale query' }))
    const controller = new AbortController()
    const staleSearch = searchOfflineDocumentsAsync(documents, 'stale query', { signal: controller.signal })

    controller.abort()
    await expect(staleSearch).rejects.toMatchObject({ name: 'AbortError' })

    const currentSearch = await searchOfflineDocumentsAsync(documents, 'stale query', { limit: 1 })
    expect(pageIds(currentSearch)).toEqual([1])
  })
})
