export interface PwaRequestLike {
  readonly method: string
  readonly mode: string
  readonly url: string
  readonly headers: { get(name: string): string | null }
  readonly destination?: string
}

export const PRECACHE_CACHE_PREFIX = 'tsepistle-pwa-precache-v1-'
export const OFFLINE_DOCUMENT_PATH = '/_offline'
export const OFFLINE_SETTINGS_PATH = '/p/offline'
export const OFFLINE_ASSET_PREFIX = '/_assets/'

const PRECACHE_CACHE_NAME_PATTERN = /^tsepistle-pwa-precache-v1-[0-9a-f]{16}$/u
const PRECACHE_ORPHAN_CACHE_NAME_PATTERN = /^tsepistle-pwa-precache-v1-[0-9a-f]{16}-candidate-[0-9a-z-]+$/u
const HTML_MEDIA_TYPE = 'text/html'

// Keep this table explicit. These roots are server-owned or carry credentials,
// and therefore must never receive a neutral-document fallback. Matching is
// deliberately case-insensitive because server routing is case-insensitive.
const NETWORK_ONLY_PATH_ROOTS = [
  '/_api',
  '/api',
  '/graphql',
  '/mcp',
  '/login',
  '/logout',
  '/register',
  '/auth',
  '/session',
  '/unlock',
  '/_unlock',
  '/verify',
  '/login-reset',
  '/u',
  '/upload',
  '/uploads',
  '/setup',
  '/admin',
  '/a',
  '/p',
  '/profile',
  '/_admin',
  '/_private',
  '/_userav',
  '/d',
  '/e',
  '/h',
  '/s',
  '/i',
  '/t',
  '/sw.js',
  '/service-worker.js',
  '/sw-tombstone.js',
  '/health',
  '/healthz',
  '/metrics',
  '/robots.txt',
  '/manifest',
  '/manifest.json',
  '/manifest.webmanifest',
  OFFLINE_DOCUMENT_PATH,
  '/_assets'
] as const

// Any path with a dot is treated as a static resource unless a more specific
// route-family rule already matched it. Never synthesize an HTML document for
// an extension that this table does not know about.
const isStaticPath = (path: string): boolean => path.indexOf('.', 1) !== -1

const decodePath = (path: string): string | null => {
  let decoded = path
  // URL.pathname keeps escaped separators and reserved roots encoded. Decode
  // repeatedly only while the value changes, with a small hard bound that
  // prevents malicious nested escapes from becoming a work amplifier.
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
    if (decodeURIComponent(decoded) !== decoded) return null
  } catch {
    return null
  }
  return decoded
}

const pathIsRootOrNested = (path: string, root: string): boolean => {
  const lowerPath = path.toLowerCase()
  const lowerRoot = root.toLowerCase()
  return lowerPath === lowerRoot || lowerPath.startsWith(`${lowerRoot}/`)
}

export function sameOriginURL(value: string, origin: string): URL | null {
  try {
    const expectedOrigin = new URL(origin).origin
    const url = new URL(value, expectedOrigin)
    return url.origin === expectedOrigin ? url : null
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
  const header = request.headers.get('accept')
  if (!header) return false
  for (const candidate of header.split(',')) {
    const parameters = candidate.split(';')
    if (parameters.shift()?.trim().toLowerCase() !== HTML_MEDIA_TYPE) continue
    let quality = 1
    let qualityWasInvalid = false
    for (const parameter of parameters) {
      const [name, ...valueParts] = parameter.split('=')
      if (name?.trim().toLowerCase() !== 'q') continue
      const value = valueParts.join('=').trim()
      if (!/^(?:0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?)$/u.test(value)) {
        qualityWasInvalid = true
        break
      }
      quality = Number(value)
    }
    if (!qualityWasInvalid && quality > 0) return true
  }
  return false
}

export function isNetworkOnlyPath(path: string): boolean {
  const decoded = decodePath(path)
  if (decoded === null) return true
  return isStaticPath(decoded) || NETWORK_ONLY_PATH_ROOTS.some(root => pathIsRootOrNested(decoded, root))
}

export function isAllowlistedNavigation(request: PwaRequestLike, origin: string): boolean {
  if (request.method.toUpperCase() !== 'GET' || request.mode !== 'navigate' || !acceptsHTML(request)) return false
  const url = sameOriginURL(request.url, origin)
  if (url?.pathname === OFFLINE_SETTINGS_PATH && !url.search) return true
  if (!url || url.pathname === OFFLINE_DOCUMENT_PATH || isNetworkOnlyPath(url.pathname)) return false
  const decodedPath = decodePath(url.pathname)
  if (decodedPath === null || isNetworkOnlyPath(decodedPath)) return false
  // Ordinary wiki documents are extensionless; this avoids turning an unknown
  // asset or download URL into an HTML response. Check decoded paths so an
  // escaped extension cannot bypass the boundary.
  return decodedPath === '/' || !isStaticPath(decodedPath)
}

export function isOwnedPrecacheCacheName(name: string): boolean {
  return PRECACHE_CACHE_NAME_PATTERN.test(name) || PRECACHE_ORPHAN_CACHE_NAME_PATTERN.test(name)
}
