import { SITE_LOGO_PNG_BYTE_LIMIT } from '../../shared/site-logo.ts'

export const OFFLINE_BRANDING_CACHE_NAME = 'tsepistle-pwa-branding-v1'
export const OFFLINE_DEFAULT_LOGO_PATH = '/_assets/svg/icon-tsepistle.svg'
const MANAGED_LOGO_PATH = /^\/_site-logo\/([0-9a-f]{64})\/logo\.png$/u
const LOGO_SLOT_PATH = '/_site-logo/offline-logo'
const LOGO_PATH_HEADER = 'X-Tsepistle-Logo-Path'
type LogoFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
let warming: { url: string; promise: Promise<boolean> } | undefined
let writeEpoch = 0

// Only server-generated public PNGs and the exact bundled logo are presentation.
export function offlineLogoPath(value: unknown, origin: string): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value, origin)
    if (url.origin !== origin || url.username || url.password || url.search || url.hash ||
      (value !== url.pathname && value !== url.href)) return null
    return url.pathname === OFFLINE_DEFAULT_LOGO_PATH || MANAGED_LOGO_PATH.test(url.pathname) ? url.pathname : null
  } catch { return null }
}

export function isOfflineManagedLogo(value: unknown, origin: string): boolean {
  const path = offlineLogoPath(value, origin)
  return path !== null && MANAGED_LOGO_PATH.test(path)
}

async function verifiedLogo(response: Response, path: string): Promise<Response | undefined> {
  const hash = MANAGED_LOGO_PATH.exec(path)?.[1]
  if (!hash || response.status !== 200 || response.redirected ||
    !['basic', 'default'].includes(response.type) || response.headers.get('content-type')?.toLowerCase() !== 'image/png' ||
    Number(response.headers.get('content-length')) > SITE_LOGO_PNG_BYTE_LIMIT || !response.body) {
    void response.body?.cancel().catch(() => undefined)
    return undefined
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > SITE_LOGO_PNG_BYTE_LIMIT) return undefined
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  if (![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return undefined
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== hash) return undefined
  return new Response(bytes, { headers: { 'Content-Type': 'image/png', [LOGO_PATH_HEADER]: path } })
}

export async function cachedOfflineLogo(value: unknown, origin: string): Promise<Response | undefined> {
  const path = offlineLogoPath(value, origin)
  if (!path || !MANAGED_LOGO_PATH.test(path) || typeof caches === 'undefined') return undefined
  try {
    const cache = await caches.open(OFFLINE_BRANDING_CACHE_NAME)
    const response = await cache.match(new URL(LOGO_SLOT_PATH, origin).href)
    if (!response || response.headers.get(LOGO_PATH_HEADER) !== path) return undefined
    return await verifiedLogo(response, path)
  } catch { return undefined }
}

// One atomic slot bounds storage even when multiple tabs warm different logos.
// Branding is optional and never participates in offline-shell readiness.
export function rememberOfflineLogo(value: unknown, origin: string, fetchImpl: LogoFetch = fetch): Promise<boolean> {
  const path = offlineLogoPath(value, origin)
  if (!path || !MANAGED_LOGO_PATH.test(path) || typeof caches === 'undefined') {
    writeEpoch += 1
    warming = undefined
    return Promise.resolve(false)
  }
  const url = new URL(path, origin).href
  if (warming?.url === url) return warming.promise
  const epoch = ++writeEpoch
  const promise = (async () => {
    try {
      if (await cachedOfflineLogo(path, origin)) return true
      const response = await fetchImpl(url, { credentials: 'omit', redirect: 'error', cache: 'no-cache', signal: AbortSignal.timeout(8_000) })
      const verified = await verifiedLogo(response, path)
      if (!verified || epoch !== writeEpoch) return false
      const cache = await caches.open(OFFLINE_BRANDING_CACHE_NAME)
      if (epoch !== writeEpoch) return false
      await cache.put(new URL(LOGO_SLOT_PATH, origin).href, verified)
      return true
    } catch { return false }
    finally { if (epoch === writeEpoch) warming = undefined }
  })()
  warming = { url, promise }
  return promise
}
