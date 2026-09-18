import { describe, expect, test } from '../../server/test/bun-test.mts'
import { offlinePageHref, offlineRecordAtUrl } from '../helpers/offline-routes.ts'
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
