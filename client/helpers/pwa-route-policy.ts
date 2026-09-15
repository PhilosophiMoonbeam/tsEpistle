export interface PwaRequestLike {
  readonly method: string
  readonly mode: string
  readonly url: string
  readonly headers: { get(name: string): string | null }
  readonly destination?: string
}

export const PRECACHE_CACHE_PREFIX = 'tsepistle-pwa-precache-v1-'
export const OFFLINE_DOCUMENT_PATH = '/_offline'
export const OFFLINE_ASSET_PREFIX = '/_assets/'

const PRECACHE_CACHE_NAME_PATTERN = /^tsepistle-pwa-precache-v1-[0-9a-f]{16}$/u
const HTML_ACCEPT_PATTERN = /(?:^|,)\s*text\/html(?:\s*;|\s*,|\s*$)/i
const NETWORK_ONLY_PATH_PATTERNS = [
  /^\/_api(?:\/|$)/u,
  /^\/api(?:\/|$)/u,
  /^\/graphql(?:\/|$)/u,
  /^\/mcp(?:\/|$)/u,
  /^\/(?:login|logout|register|unlock|auth|session)(?:\/|$)/u,
  /^\/(?:setup|admin|uploads?)(?:\/|$)/u,
  /^\/(?:a|p)(?:\/|$)/u,
  /^\/_private(?:\/|$)/u,
  /^\/(?:d|e|h|s|i|t)(?:\/|$)/u,
  /^\/_admin(?:\/|$)/u,
  /^\/_userav(?:\/|$)/u,
  /^\/(?:sw\.js|sw-tombstone\.js|manifest\.webmanifest|robots\.txt|healthz|metrics)(?:\/|$)/u,
  /^\/_assets(?:\/|$)/u
] as const

export function sameOriginURL(value: string, origin: string): URL | null {
  try {
    const url = new URL(value, origin)
    return url.origin === origin ? url : null
  } catch {
    return null
  }
}

export function normalizedPath(value: string, origin: string): string | null {
  const url = sameOriginURL(value, origin)
  if (!url || url.search || url.hash) return null
  return url.pathname
}

export function acceptsHTML(request: Pick<PwaRequestLike, 'headers'>): boolean {
  return HTML_ACCEPT_PATTERN.test(request.headers.get('accept') ?? '')
}

export function isNetworkOnlyPath(path: string): boolean {
  for (const pattern of NETWORK_ONLY_PATH_PATTERNS) {
    if (pattern.test(path)) return true
  }
  return false
}

export function isAllowlistedNavigation(request: PwaRequestLike, origin: string): boolean {
  if (request.method !== 'GET' || request.mode !== 'navigate' || !acceptsHTML(request)) return false
  const url = sameOriginURL(request.url, origin)
  if (!url || url.pathname === OFFLINE_DOCUMENT_PATH || isNetworkOnlyPath(url.pathname)) return false
  // Ordinary wiki documents are extensionless; this avoids turning an unknown
  // asset or download URL into an HTML response.
  return url.pathname === '/' || url.pathname.indexOf('.', 1) === -1
}

export function isOwnedPrecacheCacheName(name: string): boolean {
  return PRECACHE_CACHE_NAME_PATTERN.test(name)
}
