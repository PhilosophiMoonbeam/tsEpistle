import type { OfflineSnapshotRecord } from '../../shared/offline.ts'
import { isNetworkOnlyPath } from './pwa-route-policy.ts'

export const OFFLINE_SETTINGS_PATH = '/p/offline'

// Only validated document routes from the in-memory audience-scoped corpus are navigable.

/**
 * Records returned by the storage layer intentionally do not persist audience
 * metadata. Readers attach it to the in-memory projection before constructing
 * links; an absent value remains the historical public/Guest interpretation.
 */
export type OfflineRecordAudience = 'public' | 'private'
export type OfflineRouteRecord = {
  readonly siteId: string
  readonly audience?: OfflineRecordAudience
  readonly snapshot: { readonly canonicalPath: string; readonly path?: string; readonly pageId?: number; readonly locale?: string }
}

export const OFFLINE_SAVED_PAGE_OPEN_EVENT = 'tsepistle:offline-saved-page-open'

export type OfflineSavedPageOpenRequest = {
  readonly siteId: string
  readonly pageId: number
  readonly locale: string
  readonly audience: OfflineRecordAudience
  readonly canonicalPath: string
}

const decodedPath = (path: string): string | null => {
  let decoded = path
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      return null
    }
    if (next === decoded) return decoded
    decoded = next
  }
  try {
    return decodeURIComponent(decoded) === decoded ? decoded : null
  } catch {
    return null
  }
}

const isPrivatePath = (path: string): boolean => {
  const decoded = decodedPath(path)
  return decoded !== null && /^\/_private(?:\/|$)/iu.test(decoded)
}

const isPrivateStaticPath = (path: string): boolean => {
  const decoded = decodedPath(path)
  if (decoded === null || !isPrivatePath(decoded)) return false
  return decoded.indexOf('.', 1) !== -1
}

const audienceFor = (record: OfflineRouteRecord): OfflineRecordAudience => record.audience ?? 'public'

/**
 * Return only the validated canonical document path for the record audience.
 * Private encrypted records may use either the ordinary document namespace or
 * the private route namespace; whichever canonical path was stored is retained.
 */
export function offlinePageHref(record: OfflineRouteRecord, origin: string): string | null {
  try {
    const audience = audienceFor(record)
    const canonicalPath = record.snapshot.canonicalPath
    if (!canonicalPath.startsWith('/') || canonicalPath.startsWith('//')) return null
    if (audience === 'public' && record.siteId !== origin) return null
    const url = new URL(canonicalPath, origin)
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) return null
    const privateRoute = isPrivatePath(url.pathname)
    if (audience === 'private') {
      if (privateRoute) {
        if (isPrivateStaticPath(url.pathname)) return null
      } else if (isNetworkOnlyPath(url.pathname)) {
        return null
      }
    } else if (privateRoute || isNetworkOnlyPath(url.pathname)) {
      return null
    }
    return url.pathname
  } catch {
    return null
  }
}
export function createOfflineSavedPageOpenRequest(
  record: OfflineRouteRecord & { readonly pageId: number; readonly locale: string },
  origin: string
): OfflineSavedPageOpenRequest | null {
  const canonicalPath = offlinePageHref(record, origin)
  if (!canonicalPath || !Number.isSafeInteger(record.pageId) || record.pageId < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,34}$/u.test(record.locale)) return null
  return Object.freeze({
    siteId: record.siteId,
    pageId: record.pageId,
    locale: record.locale,
    audience: audienceFor(record),
    canonicalPath
  })
}

export function parseOfflineSavedPageOpenRequest(value: unknown, origin: string): OfflineSavedPageOpenRequest | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<OfflineSavedPageOpenRequest>
  if (
    typeof candidate.siteId !== 'string' ||
    typeof candidate.pageId !== 'number' ||
    !Number.isSafeInteger(candidate.pageId) ||
    candidate.pageId < 1 ||
    typeof candidate.locale !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{1,34}$/u.test(candidate.locale) ||
    (candidate.audience !== 'public' && candidate.audience !== 'private') ||
    typeof candidate.canonicalPath !== 'string'
  )
    return null
  const record: OfflineRouteRecord = {
    siteId: candidate.siteId,
    audience: candidate.audience,
    snapshot: { canonicalPath: candidate.canonicalPath }
  }
  const canonicalPath = offlinePageHref(record, origin)
  return canonicalPath === candidate.canonicalPath ? (Object.freeze({ ...candidate, canonicalPath }) as OfflineSavedPageOpenRequest) : null
}
export function requestOfflineSavedPageOpen(input: OfflineSavedPageOpenRequest): boolean {
  if (typeof window === 'undefined') return false
  const request = parseOfflineSavedPageOpenRequest(input, window.location.origin)
  if (!request) return false
  const event = new CustomEvent<OfflineSavedPageOpenRequest>(OFFLINE_SAVED_PAGE_OPEN_EVENT, {
    detail: request,
    cancelable: true
  })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

export function offlineRecordAtUrl(
  records: readonly (OfflineSnapshotRecord & { readonly audience?: OfflineRecordAudience })[],
  value: string,
  origin: string,
  locale = 'en'
): OfflineSnapshotRecord | undefined {
  let url: URL
  try {
    url = new URL(value, origin)
  } catch {
    return undefined
  }
  if (url.origin !== origin || url.username || url.password) return undefined
  return records.find(record => {
    const path = offlinePageHref(record, origin)
    if (!path) return false
    if (url.pathname === path) return true
    // The server also serves its home document at the origin root.
    return url.pathname === '/' && record.snapshot.path === 'home' && record.locale === locale && (record.audience ?? 'public') === 'public'
  })
}

export type OfflineNavigationEntry = {
  key: string
  href: string
  title: string
  locale: string
  audience: OfflineRecordAudience
  siteId: string
  pageId: number
  canonicalPath: string
}

// A sidebar entry promises a readable local copy, not merely an intent to save.
export function offlineNavigationEntries(
  records: readonly (OfflineSnapshotRecord & { readonly audience?: OfflineRecordAudience })[],
  origin: string,
  at = Date.now()
): OfflineNavigationEntry[] {
  return records
    .flatMap(record => {
      const href = offlinePageHref(record, origin)
      const audience = record.audience ?? 'public'
      if (
        !href ||
        record.pageId !== record.snapshot.pageId ||
        record.locale !== record.snapshot.locale ||
        (record.snapshot.expiresAt && Date.parse(record.snapshot.expiresAt) <= at)
      )
        return []
      return [
        {
          key: `${audience}:${record.siteId}:${record.pageId}:${record.locale}`,
          href,
          title: record.snapshot.title || record.snapshot.path,
          locale: record.locale,
          audience,
          siteId: record.siteId,
          pageId: record.pageId,
          canonicalPath: href
        }
      ]
    })
    .sort((left, right) => left.title.localeCompare(right.title) || left.href.localeCompare(right.href))
}
