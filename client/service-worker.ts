type PrecacheManifestEntry = {
  url: string
  revision: string | null
  integrity?: string
}

type WorkerClient = {
  id: string
  url: string
  navigate(url: string): Promise<unknown>
}

type WorkerClients = {
  matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<WorkerClient[]>
}

type WorkerRegistration = {
  scope: string
  unregister(): Promise<boolean>
}

type ServiceWorkerGlobal = typeof globalThis & {
  clients: WorkerClients
  registration: WorkerRegistration
  skipWaiting(): Promise<void>
  __WB_MANIFEST?: readonly PrecacheManifestEntry[]
}

type LifecycleEvent = Event & {
  waitUntil(promise: Promise<unknown>): void
}

type FetchEvent = Event & {
  request: Request
  respondWith(response: Response | Promise<Response>): void
}

type MessageEventLike = Event & {
  data: unknown
  source: WorkerClient | null
}

declare var __WB_MANIFEST: readonly PrecacheManifestEntry[] | undefined

const worker = globalThis as ServiceWorkerGlobal

// The VitePWA injectManifest build replaces this exact expression with the
// generated, filtered shell closure. There is no runtime cache or API cache.
const injectedManifest = globalThis.__WB_MANIFEST
const PRECACHE_MANIFEST: readonly PrecacheManifestEntry[] = Array.isArray(injectedManifest) ? injectedManifest : []

const PRECACHE_CACHE_PREFIX = 'tsepistle-pwa-precache-v1-'
const PRECACHE_CACHE_NAME = `${PRECACHE_CACHE_PREFIX}${manifestDigest(PRECACHE_MANIFEST)}`
const PRECACHE_CACHE_NAME_PATTERN = /^tsepistle-pwa-precache-v1-[0-9a-f]{16}$/u
const OFFLINE_DOCUMENT_PATH = '/_offline'

const OFFLINE_ASSET_PREFIX = '/_assets/'
const RELOAD_SAFETY_MESSAGE = 'PWA_RELOAD_SAFETY'
const ACTIVATE_UPDATE_MESSAGE = 'PWA_ACTIVATE_UPDATE'
const reloadSafety = new Map<string, boolean>()

function manifestDigest(manifest: readonly PrecacheManifestEntry[]): string {
  const revisionSet = [...new Set(manifest.map(entry => JSON.stringify([entry.url, entry.revision])))].sort()
  const serialized = JSON.stringify(revisionSet)
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

function sameOriginURL(value: string): URL | null {
  try {
    const url = new URL(value, worker.location.origin)
    return url.origin === worker.location.origin ? url : null
  } catch {
    return null
  }
}

function normalizedPath(value: string): string | null {
  const url = sameOriginURL(value)
  if (!url || url.search || url.hash) return null
  return url.pathname
}

function precacheURL(entry: PrecacheManifestEntry): string | null {
  const path = normalizedPath(entry.url)
  if (!path) return null
  if (path === OFFLINE_DOCUMENT_PATH) return new URL(path, worker.location.origin).href
  if (path.startsWith(`${OFFLINE_ASSET_PREFIX}js/`) || path.startsWith(`${OFFLINE_ASSET_PREFIX}assets/`)) {
    return new URL(path, worker.location.origin).href
  }
  return null
}

async function installPrecache(): Promise<void> {
  const entries = [...new Set(PRECACHE_MANIFEST.map(precacheURL).filter((url): url is string => url !== null))]
  if (!entries.includes(new URL(OFFLINE_DOCUMENT_PATH, worker.location.origin).href)) {
    throw new Error('The offline document is missing from the service-worker precache manifest.')
  }

  const stagingCache = await caches.open(PRECACHE_CACHE_NAME)
  for (const url of entries) {
    const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }))
    if (!response.ok || response.redirected || response.type !== 'basic') {
      throw new Error(`The offline shell dependency could not be precached: ${url}`)
    }
    await stagingCache.put(url, response)
  }

  const retained = new Set(entries)
  const staleRequests = (await stagingCache.keys()).filter(request => !retained.has(request.url))
  await Promise.all(staleRequests.map(request => stagingCache.delete(request)))
}

async function retireOldPrecacheCaches(): Promise<void> {
  const cacheNames = await caches.keys()
  const oldCacheNames = cacheNames.filter(name => name !== PRECACHE_CACHE_NAME && PRECACHE_CACHE_NAME_PATTERN.test(name))
  await Promise.all(oldCacheNames.map(name => caches.delete(name)))
}

function acceptsHTML(request: Request): boolean {
  const accept = request.headers.get('accept') ?? ''
  return accept
    .split(',')
    .map(value => value.trim().split(';', 1)[0].toLowerCase())
    .includes('text/html')
}

function isNetworkOnlyPath(path: string): boolean {
  return [
    /^\/_api(?:\/|$)/,
    /^\/api(?:\/|$)/,
    /^\/graphql(?:\/|$)/,
    /^\/mcp(?:\/|$)/,
    /^\/(?:login|logout|register|unlock|auth|session)(?:\/|$)/,
    /^\/(?:setup|admin|uploads?)(?:\/|$)/,
    /^\/(?:a|p)(?:\/|$)/,
    /^\/(?:d|e|h|s|i|t)(?:\/|$)/,
    /^\/_admin(?:\/|$)/,
    /^\/_userav(?:\/|$)/,
    /^\/(?:sw\.js|sw-tombstone\.js|manifest\.webmanifest|robots\.txt|healthz|metrics)(?:\/|$)/,
    /^\/_assets(?:\/|$)/
  ].some(pattern => pattern.test(path))
}

function allowlistedNavigation(request: Request): boolean {
  if (request.method !== 'GET' || request.mode !== 'navigate' || !acceptsHTML(request)) return false
  const url = sameOriginURL(request.url)
  if (!url || url.pathname === OFFLINE_DOCUMENT_PATH || isNetworkOnlyPath(url.pathname)) return false
  // Ordinary wiki documents are extensionless; this avoids turning an unknown
  // asset or download URL into an HTML response.
  return url.pathname === '/' || !url.pathname.slice(1).includes('.')
}

async function cachedShell(): Promise<Response | undefined> {
  const cache = await caches.open(PRECACHE_CACHE_NAME)
  return cache.match(new URL(OFFLINE_DOCUMENT_PATH, worker.location.origin).href)
}

async function handleNavigation(request: Request): Promise<Response> {
  try {
    // A non-error server response, including 401/403/404, remains authoritative.
    return await fetch(request)
  } catch (error) {
    const fallback = await cachedShell()
    if (fallback) return fallback
    throw error
  }
}

async function handleFetch(request: Request): Promise<Response> {
  if (request.method !== 'GET') return fetch(request)
  const url = sameOriginURL(request.url)
  if (!url) return fetch(request)
  if (isNetworkOnlyPath(url.pathname) && !url.pathname.startsWith(OFFLINE_ASSET_PREFIX)) return fetch(request)

  const cache = await caches.open(PRECACHE_CACHE_NAME)
  const cached = await cache.match(request)
  if (cached && (url.pathname !== OFFLINE_DOCUMENT_PATH || (request.mode === 'navigate' && acceptsHTML(request)))) return cached

  if (allowlistedNavigation(request)) return handleNavigation(request)
  return fetch(request)
}

function scopedClient(client: WorkerClient): boolean {
  const clientURL = sameOriginURL(client.url)
  const scopeURL = sameOriginURL(worker.registration.scope)
  return Boolean(clientURL && scopeURL && clientURL.pathname.startsWith(scopeURL.pathname))
}

async function activateWhenAllClientsAreSafe(source: WorkerClient | null): Promise<void> {
  if (!source || !scopedClient(source)) return
  const clients = (await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(scopedClient)
  const currentIds = new Set(clients.map(client => client.id))
  for (const clientId of reloadSafety.keys()) {
    if (!currentIds.has(clientId)) reloadSafety.delete(clientId)
  }
  if (reloadSafety.get(source.id) !== true || clients.some(client => reloadSafety.get(client.id) !== true)) return
  await worker.skipWaiting()
}
worker.addEventListener('install', event => {
  ;(event as LifecycleEvent).waitUntil(installPrecache())
})

worker.addEventListener('activate', event => {
  // Activation is deliberately natural. Existing clients remain controlled by
  // the old worker until they close, or every active client opts into reload.
  ;(event as LifecycleEvent).waitUntil(retireOldPrecacheCaches())
})

worker.addEventListener('fetch', event => {
  const fetchEvent = event as FetchEvent
  fetchEvent.respondWith(handleFetch(fetchEvent.request))
})

worker.addEventListener('message', event => {
  const messageEvent = event as MessageEventLike
  if (!messageEvent.source || typeof messageEvent.data !== 'object' || messageEvent.data === null) return
  const message = messageEvent.data as { type?: unknown; safe?: unknown }
  if (message.type === RELOAD_SAFETY_MESSAGE && typeof message.safe === 'boolean') {
    reloadSafety.set(messageEvent.source.id, message.safe)
    return
  }
  if (message.type === ACTIVATE_UPDATE_MESSAGE) void activateWhenAllClientsAreSafe(messageEvent.source)
})
