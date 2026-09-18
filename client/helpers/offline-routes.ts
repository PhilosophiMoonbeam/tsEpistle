import type { OfflineSnapshotRecord } from '../../shared/offline.ts'
import { isNetworkOnlyPath } from './pwa-route-policy.ts'

export const OFFLINE_SETTINGS_PATH = '/p/offline'

// Only public document routes from the validated local corpus are navigable.
export function offlinePageHref(record: { siteId: string; snapshot: { canonicalPath: string } }, origin: string): string | null {
  try {
    if (record.siteId !== origin) return null
    const url = new URL(record.snapshot.canonicalPath.startsWith('/') ? record.snapshot.canonicalPath : `/${record.snapshot.canonicalPath}`, origin)
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || isNetworkOnlyPath(url.pathname)) return null
    return url.pathname
  } catch { return null }
}

export function offlineRecordAtUrl(records: readonly OfflineSnapshotRecord[], value: string, origin: string, locale = 'en'): OfflineSnapshotRecord | undefined {
  const url = new URL(value, origin)
  if (url.origin !== origin) return undefined
  return records.find(record => {
    const path = offlinePageHref(record, origin)
    if (!path) return false
    if (url.pathname === path) return true
    // The server also serves its home document at the origin root.
    return url.pathname === '/' && record.snapshot.path === 'home' && record.locale === locale
  })
}


export type OfflineNavigationEntry = { key: string; href: string; title: string; locale: string }

// A sidebar entry promises a readable local copy, not merely an intent to save.
export function offlineNavigationEntries(records: readonly OfflineSnapshotRecord[], origin: string, at = Date.now()): OfflineNavigationEntry[] {
  return records.flatMap(record => {
    const href = offlinePageHref(record, origin)
    if (!href || record.pageId !== record.snapshot.pageId || record.locale !== record.snapshot.locale ||
      (record.snapshot.expiresAt && Date.parse(record.snapshot.expiresAt) <= at)) return []
    return [{ key: `${record.pageId}:${record.locale}`, href, title: record.snapshot.title || record.snapshot.path, locale: record.locale }]
  }).sort((left, right) => left.title.localeCompare(right.title) || left.href.localeCompare(right.href))
}
