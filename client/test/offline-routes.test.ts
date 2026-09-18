import { describe, expect, test } from '../../server/test/bun-test.mts'
import { offlineNavigationEntries, offlinePageHref, offlineRecordAtUrl } from '../helpers/offline-routes.ts'
import type { OfflineSnapshotRecord } from '../../shared/offline.ts'
const origin = 'https://wiki.example.test'
const record = (canonicalPath: string, path = 'guide'): OfflineSnapshotRecord => ({
  siteId: origin, pageId: 7, locale: 'en', snapshot: { canonicalPath, path }
} as OfflineSnapshotRecord)

describe('canonical offline navigation', () => {
  test('uses the saved canonical route, retains fragment matching, and resolves the home alias', () => {
    const guide = record('/en/guide')
    expect(offlinePageHref(guide, origin)).toBe('/en/guide')
    expect(offlineRecordAtUrl([guide], '/en/guide#intro', origin)).toBe(guide)
    expect(offlineRecordAtUrl([guide], '/en/missing', origin)).toBeUndefined()
    const home = record('/en/home', 'home')
    expect(offlineRecordAtUrl([home], '/', origin)).toBe(home)
  })
  test('cannot turn protected, foreign, or executable URLs into offline reader links', () => {
    for (const route of ['/_private/en/secret', '/p/profile', '/_api/users/whoami', '/%5Fprivate/en/secret', '/en/a.js', '//evil.test/en/guide', '/en/guide?token=secret']) {
      expect(offlinePageHref(record(route), origin)).toBeNull()
    }
    expect(offlinePageHref({ ...record('/en/guide'), siteId: 'https://other.test' }, origin)).toBeNull()
    expect(offlineRecordAtUrl([record('/en/guide')], 'https://other.test/en/guide', origin)).toBeUndefined()
  })
})


describe('saved page navigation entries', () => {
  const saved = (id: number, title: string, route = `/en/page-${id}`, expiresAt?: string): OfflineSnapshotRecord => ({
    ...record(route), pageId: id,
    snapshot: { ...record(route).snapshot, pageId: id, locale: 'en', title, expiresAt }
  } as OfflineSnapshotRecord)

  test('lists only readable same-site public copies in title order', () => {
    const at = Date.parse('2026-09-18T12:00:00Z')
    const beta = saved(2, 'Beta')
    const alpha = saved(1, 'Alpha')
    const rows = offlineNavigationEntries([
      beta, alpha, saved(3, 'Expired', '/en/expired', '2026-09-18T11:59:00Z'),
      saved(4, 'Private', '/_private/en/secret'),
      { ...saved(5, 'Foreign'), siteId: 'https://other.test' },
      { ...saved(6, 'Mismatched'), pageId: 7 }
    ], origin, at)
    expect(rows.map(row => row.title)).toEqual(['Alpha', 'Beta'])
    expect(rows.map(row => row.href)).toEqual(['/en/page-1', '/en/page-2'])
    expect(offlineNavigationEntries([], origin, at)).toEqual([])
  })

  test('expires a copy at its known deadline and never fabricates missing copies', () => {
    const page = saved(1, 'Guide', '/en/guide', '2026-09-18T12:00:00Z')
    expect(offlineNavigationEntries([page], origin, Date.parse('2026-09-18T11:59:59Z'))).toHaveLength(1)
    expect(offlineNavigationEntries([page], origin, Date.parse('2026-09-18T12:00:00Z'))).toEqual([])
  })
})
