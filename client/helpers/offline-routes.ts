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
