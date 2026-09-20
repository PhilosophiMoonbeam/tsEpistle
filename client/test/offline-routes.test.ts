import { describe, expect, test } from '../../server/test/bun-test.mts'
import {
  createOfflineSavedPageOpenRequest,
  offlineNavigationEntries,
  offlinePageHref,
  offlineRecordAtUrl,
  parseOfflineSavedPageOpenRequest
} from '../helpers/offline-routes.ts'
import type { OfflineSnapshotRecord } from '../../shared/offline.ts'
const origin = 'https://wiki.example.test'
const record = (canonicalPath: string, path = 'guide', audience?: 'public' | 'private'): OfflineSnapshotRecord & { audience?: 'public' | 'private' } =>
  ({
    siteId: origin,
    pageId: 7,
    locale: 'en',
    audience,
    snapshot: { canonicalPath, path }
  }) as OfflineSnapshotRecord & { audience?: 'public' | 'private' }

describe('canonical offline navigation', () => {
  test('uses the saved canonical route, retains fragment matching, and resolves the home alias', () => {
    const guide = record('/en/guide')
    expect(offlinePageHref(guide, origin)).toBe('/en/guide')
    expect(offlineRecordAtUrl([guide], '/en/guide#intro', origin)).toBe(guide)
    expect(offlineRecordAtUrl([guide], '/en/missing', origin)).toBeUndefined()
    const home = record('/en/home', 'home')
    expect(offlineRecordAtUrl([home], '/', origin)).toBe(home)
  })

  test('preserves either private corpus namespace without downgrading its audience', () => {
    const privateRoutePage = { ...record('/_private/en/notes', 'notes', 'private'), siteId: 'private-site.example.test' }
    const privateDocumentPage = { ...record('/en/notes', 'notes', 'private'), siteId: 'private-site.example.test' }
    expect(offlinePageHref(privateRoutePage, origin)).toBe('/_private/en/notes')
    expect(offlinePageHref(privateDocumentPage, origin)).toBe('/en/notes')
    expect(offlineRecordAtUrl([privateRoutePage], '/_private/en/notes#today', origin)).toBe(privateRoutePage)
    expect(offlineRecordAtUrl([privateDocumentPage], '/en/notes#today', origin)).toBe(privateDocumentPage)
    expect(offlinePageHref({ ...record('/p/profile', 'profile', 'private'), siteId: 'private-site.example.test' }, origin)).toBeNull()
    expect(offlinePageHref(record('/_private/en/notes', 'notes'), origin)).toBeNull()
  })

  test('validates in-document private open requests against their canonical route', () => {
    const page = { ...record('/en/notes', 'notes', 'private'), siteId: 'private-site.example.test', pageId: 7, locale: 'en' }
    const request = createOfflineSavedPageOpenRequest(page, origin)
    expect(request).toEqual({
      siteId: 'private-site.example.test',
      pageId: 7,
      locale: 'en',
      audience: 'private',
      canonicalPath: '/en/notes'
    })
    expect(parseOfflineSavedPageOpenRequest(request, origin)).toEqual(request)
    expect(parseOfflineSavedPageOpenRequest({ ...request, canonicalPath: '/p/profile' }, origin)).toBeNull()
  })

  test('rejects malformed values and invalid selector boundaries without throwing', () => {
    expect(offlinePageHref(record('/%ZZ'), origin)).toBeNull()
    expect(offlinePageHref(record('https://other.test/en/guide'), origin)).toBeNull()
    expect(offlineRecordAtUrl([record('/en/guide')], '%%%', origin)).toBeUndefined()
    expect(offlineRecordAtUrl([record('/en/guide')], 'https://other.test/en/guide', origin)).toBeUndefined()
  })

  test('cannot turn protected, foreign, or executable URLs into offline reader links', () => {
    for (const route of [
      '/_private/en/secret',
      '/p/profile',
      '/_api/users/whoami',
      '/%5Fprivate/en/secret',
      '/en/a.js',
      '//evil.test/en/guide',
      '/en/guide?token=secret'
    ]) {
      expect(offlinePageHref(record(route), origin)).toBeNull()
    }
    expect(offlinePageHref({ ...record('/en/guide'), siteId: 'https://other.test' }, origin)).toBeNull()
    expect(offlineRecordAtUrl([record('/en/guide')], 'https://other.test/en/guide', origin)).toBeUndefined()
  })
})

describe('saved page navigation entries', () => {
  const saved = (
    id: number,
    title: string,
    route = `/en/page-${id}`,
    expiresAt?: string,
    audience: 'public' | 'private' = 'public'
  ): OfflineSnapshotRecord & { audience: 'public' | 'private' } =>
    ({
      ...record(route, `page-${id}`, audience),
      audience,
      pageId: id,
      snapshot: { ...record(route).snapshot, pageId: id, locale: 'en', title, expiresAt }
    }) as OfflineSnapshotRecord & { audience: 'public' | 'private' }

  test('lists readable same-site copies in title order while retaining audience metadata', () => {
    const at = Date.parse('2026-09-18T12:00:00Z')
    const beta = saved(2, 'Beta')
    const alpha = saved(1, 'Alpha')
    const privatePage = saved(7, 'Private', '/_private/en/private', undefined, 'private')
    const rows = offlineNavigationEntries(
      [
        beta,
        alpha,
        saved(3, 'Expired', '/en/expired', '2026-09-18T11:59:00Z'),
        saved(4, 'Private route without audience', '/_private/en/secret'),
        privatePage,
        { ...saved(5, 'Foreign'), siteId: 'https://other.test' },
        { ...saved(6, 'Mismatched'), pageId: 7 }
      ],
      origin,
      at
    )
    expect(rows.map(row => row.title)).toEqual(['Alpha', 'Beta', 'Private'])
    expect(rows.map(row => row.href)).toEqual(['/en/page-1', '/en/page-2', '/_private/en/private'])
    expect(rows.map(row => row.audience)).toEqual(['public', 'public', 'private'])
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
    expect(offlineNavigationEntries([], origin, at)).toEqual([])
  })

  test('expires a copy at its known deadline and never fabricates missing copies', () => {
    const page = saved(1, 'Guide', '/en/guide', '2026-09-18T12:00:00Z')
    expect(offlineNavigationEntries([page], origin, Date.parse('2026-09-18T11:59:59Z'))).toHaveLength(1)
    expect(offlineNavigationEntries([page], origin, Date.parse('2026-09-18T12:00:00Z'))).toEqual([])
  })
})
