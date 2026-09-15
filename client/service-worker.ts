import {
  OFFLINE_ASSET_PREFIX,
  OFFLINE_DOCUMENT_PATH,
  PRECACHE_CACHE_PREFIX,
  acceptsHTML,
  isAllowlistedNavigation,
  isNetworkOnlyPath,
  isOwnedPrecacheCacheName,
  normalizedPath,
  sameOriginURL
} from './helpers/pwa-route-policy.ts'

type PrecacheManifestEntry = {
  url: string
  revision: string | null
  integrity?: string
}

type WorkerClient = {
  id: string
  url: string
  navigate(url: string): Promise<unknown>
  postMessage(message: unknown): void
}

type WorkerClients = {
  matchAll(options?: { type?: string; includeUncontrolled?: boolean }): Promise<WorkerClient[]>
  claim?(): Promise<void>
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

type ActivationIntent = {
  nonce: string
  started: boolean
}

const worker = globalThis as ServiceWorkerGlobal

// The VitePWA injectManifest build replaces this exact expression with the
// generated, filtered shell closure. There is no runtime cache or API cache.
const injectedManifest = (globalThis as ServiceWorkerGlobal).__WB_MANIFEST
const PRECACHE_MANIFEST: readonly PrecacheManifestEntry[] = Array.isArray(injectedManifest) ? injectedManifest : []

const PRECACHE_CACHE_NAME = `${PRECACHE_CACHE_PREFIX}${manifestDigest(PRECACHE_MANIFEST)}`
const RELOAD_SAFETY_MESSAGE = 'PWA_RELOAD_SAFETY'
const RELOAD_SAFETY_REQUEST_MESSAGE = 'PWA_RELOAD_SAFETY_REQUEST'
const ACTIVATE_UPDATE_MESSAGE = 'PWA_ACTIVATE_UPDATE'
const ACTIVATED_UPDATE_MESSAGE = 'PWA_UPDATE_ACTIVATED'
const reloadSafety = new Map<string, boolean>()
let activationIntent: ActivationIntent | null = null
let activationCheckPromise: Promise<void> | null = null
let activationCheckAgain = false

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

function precacheURL(entry: PrecacheManifestEntry): string | null {
  const path = normalizedPath(entry.url, worker.location.origin)
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
  const oldCacheNames = cacheNames.filter(name => name !== PRECACHE_CACHE_NAME && isOwnedPrecacheCacheName(name))
  await Promise.all(oldCacheNames.map(name => caches.delete(name)))
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
  const url = sameOriginURL(request.url, worker.location.origin)
  if (!url) return fetch(request)
  if (isNetworkOnlyPath(url.pathname) && !url.pathname.startsWith(OFFLINE_ASSET_PREFIX)) return fetch(request)
  if (url.pathname === OFFLINE_DOCUMENT_PATH && request.mode === 'navigate' && acceptsHTML(request)) {
    const fallback = await cachedShell()
    if (fallback) return fallback
    return fetch(request)
  }

  const cache = await caches.open(PRECACHE_CACHE_NAME)
  const cached = await cache.match(request)
  if (cached && (url.pathname !== OFFLINE_DOCUMENT_PATH || (request.mode === 'navigate' && acceptsHTML(request)))) return cached

  if (isAllowlistedNavigation(request, worker.location.origin)) return handleNavigation(request)
  return fetch(request)
}

function scopedClient(client: WorkerClient): boolean {
  const clientURL = sameOriginURL(client.url, worker.location.origin)
  const scopeURL = sameOriginURL(worker.registration.scope, worker.location.origin)
  return Boolean(clientURL && scopeURL && clientURL.pathname.startsWith(scopeURL.pathname))
}

async function requestSafetyReports(nonce: string): Promise<void> {
  const clients = (await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(scopedClient)
  const message = { type: RELOAD_SAFETY_REQUEST_MESSAGE, nonce }
  for (const client of clients) {
    try {
      client.postMessage(message)
    } catch {
      // A client can disappear between matchAll() and postMessage(). Its
      // missing acknowledgement intentionally keeps this activation blocked.
    }
  }
}

function scheduleActivationCheck(nonce: string): void {
  if (activationCheckPromise) {
    activationCheckAgain = true
    return
  }

  activationCheckPromise = (async () => {
    const intent = activationIntent
    if (!intent || intent.nonce !== nonce || intent.started) return

    let clients: WorkerClient[]
    try {
      clients = (await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(scopedClient)
    } catch {
      return
    }
    if (activationIntent?.nonce !== nonce || activationIntent.started) return

    const currentIds = new Set(clients.map(client => client.id))
    for (const clientId of reloadSafety.keys()) {
      if (!currentIds.has(clientId)) reloadSafety.delete(clientId)
    }
    if (clients.some(client => reloadSafety.get(client.id) !== true)) return

    intent.started = true
    try {
      await worker.skipWaiting()
    } catch {
      // Keep the intent and allow a later safety report to retry consensus.
      intent.started = false
    }
  })().finally(() => {
    activationCheckPromise = null
    if (activationCheckAgain) {
      activationCheckAgain = false
      if (activationIntent?.nonce === nonce && !activationIntent.started) scheduleActivationCheck(nonce)
    }
  })
}

function activateWhenAllClientsAreSafe(source: WorkerClient | null, nonce: string): void {
  if (!source || !scopedClient(source)) return

  const isNewActivation = activationIntent?.nonce !== nonce
  if (isNewActivation) {
    activationIntent = { nonce, started: false }
    // Reports from a prior accepted update must never satisfy this request.
    reloadSafety.clear()
    void requestSafetyReports(nonce).catch(() => {
      // The intent remains pending; a later report retries the consensus check.
    })
  }
  scheduleActivationCheck(nonce)
}

worker.addEventListener('install', event => {
  ;(event as LifecycleEvent).waitUntil(installPrecache())
})

worker.addEventListener('activate', event => {
  const activationNonce = activationIntent?.nonce ?? null
  ;(event as LifecycleEvent).waitUntil(
    (async () => {
      await retireOldPrecacheCaches()
      if (typeof worker.clients.claim === 'function') await worker.clients.claim()

      if (!activationNonce) return
      const clients = (await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(scopedClient)
      const message = { type: ACTIVATED_UPDATE_MESSAGE, nonce: activationNonce }
      for (const client of clients) {
        try {
          client.postMessage(message)
        } catch {
          // The client may close after claim; controllerchange remains the
          // fallback signal for a client that is still alive.
        }
      }
      activationIntent = null
      reloadSafety.clear()
    })()
  )
})

worker.addEventListener('fetch', event => {
  const fetchEvent = event as FetchEvent
  fetchEvent.respondWith(handleFetch(fetchEvent.request))
})

worker.addEventListener('message', event => {
  const messageEvent = event as MessageEventLike
  if (!messageEvent.source || typeof messageEvent.data !== 'object' || messageEvent.data === null) return
  const message = messageEvent.data as { type?: unknown; safe?: unknown; nonce?: unknown }
  if (
    message.type === RELOAD_SAFETY_MESSAGE &&
    typeof message.safe === 'boolean' &&
    typeof message.nonce === 'string' &&
    message.nonce.length > 0 &&
    activationIntent?.nonce === message.nonce &&
    !activationIntent.started
  ) {
    reloadSafety.set(messageEvent.source.id, message.safe)
    scheduleActivationCheck(message.nonce)
    return
  }
  if (message.type === ACTIVATE_UPDATE_MESSAGE && typeof message.nonce === 'string' && message.nonce.length > 0) {
    activateWhenAllClientsAreSafe(messageEvent.source, message.nonce)
  }
})
