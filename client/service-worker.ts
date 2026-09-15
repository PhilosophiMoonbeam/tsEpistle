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
  waitUntil?(promise: Promise<unknown>): void
}

type ActivationIntent = {
  workerId: string
  release: string
  roundNonce: string
}

type SafetyVote = {
  safe: boolean
  revision: string
  actorEpoch?: string | number
}

type PreparationRound = {
  workerId: string
  release: string
  roundNonce: string
  roster: Map<string, string>
  rosterClients: WorkerClient[]
  firstRevisions: Map<string, string>
  votes: Map<string, SafetyVote>
  started: boolean
  checking: boolean
  checkAgain: boolean
  checkPromise: Promise<void> | null
  deadlineTimer: ReturnType<typeof setTimeout> | null
}

const worker = globalThis as ServiceWorkerGlobal

// The delivery build replaces this exact string with the immutable server
// build revision. Keeping it in the worker identity makes worker-only changes
// invalidate the owned cache even when the shell manifest is unchanged.
const PWA_RELEASE_ID = '__TSEPISTLE_PWA_RELEASE__'

// The Vite injectManifest build replaces this exact expression with the
// generated, filtered shell closure. There is no runtime cache or API cache.
const injectedManifest = (globalThis as ServiceWorkerGlobal).__WB_MANIFEST
const PRECACHE_MANIFEST: readonly PrecacheManifestEntry[] = Array.isArray(injectedManifest) ? injectedManifest : []
const MANIFEST_DIGEST = manifestDigest(PRECACHE_MANIFEST, PWA_RELEASE_ID)
const PRECACHE_CACHE_NAME = `${PRECACHE_CACHE_PREFIX}${MANIFEST_DIGEST}`
const COMPLETE_MARKER_URL = new URL(
  `${OFFLINE_DOCUMENT_PATH}?__tsepistle_pwa_complete=${encodeURIComponent(PWA_RELEASE_ID)}-${MANIFEST_DIGEST}`,
  worker.location.origin
).href
const RELOAD_SAFETY_MESSAGE = 'PWA_RELOAD_SAFETY'
const RELOAD_SAFETY_REQUEST_MESSAGE = 'PWA_RELOAD_SAFETY_REQUEST'
const PREPARE_UPDATE_MESSAGE = 'PWA_PREPARE_UPDATE'
const UPDATE_PREPARING_MESSAGE = 'PWA_UPDATE_PREPARING'
const UPDATE_DEFERRED_MESSAGE = 'PWA_UPDATE_DEFERRED'
const UPDATE_ACTIVATING_MESSAGE = 'PWA_UPDATE_ACTIVATING'
const ACTIVATED_UPDATE_MESSAGE = 'PWA_UPDATE_ACTIVATED'
const OFFLINE_READY_MESSAGE = 'PWA_OFFLINE_READY'
const OFFLINE_NOT_READY_MESSAGE = 'PWA_OFFLINE_NOT_READY'
const PREPARATION_DEADLINE_MS = 15_000
const WORKER_ID = createToken()
const PRECACHE_URLS = new Set(precacheEntries().map(value => value.url))
let activationIntent: ActivationIntent | null = null
let preparationRound: PreparationRound | null = null

function manifestDigest(manifest: readonly PrecacheManifestEntry[], release: string): string {
  const revisionSet = [...new Set(manifest.map(entry => JSON.stringify([entry.url, entry.revision])))].sort()
  const serialized = JSON.stringify([release, revisionSet])
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

function createToken(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
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

function precacheEntries(): readonly { entry: PrecacheManifestEntry; url: string }[] {
  const entries: { entry: PrecacheManifestEntry; url: string }[] = []
  const seen = new Set<string>()
  for (const entry of PRECACHE_MANIFEST) {
    const url = precacheURL(entry)
    if (!url || seen.has(url)) continue
    seen.add(url)
    entries.push({ entry, url })
  }
  return entries
}

function responseTypeIsUsable(response: Response): boolean {
  return response.type === 'basic' || response.type === 'default' || response.type === undefined
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

function metaContent(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    if (attribute(tag, 'name')?.trim().toLowerCase() !== name.toLowerCase()) continue
    return attribute(tag, 'content')?.trim() ?? null
  }
  return null
}

function shellDependencies(html: string, shellURL: string, closure: ReadonlySet<string>): string[] {
  const dependencies: string[] = []
  const seen = new Set<string>()
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/giu) ?? []) {
    const isScript = /^<script\b/iu.test(tag)
    const rel = attribute(tag, 'rel')
      ?.split(/\s+/u)
      .map(value => value.toLowerCase()) ?? []
    if (!isScript && !rel.includes('stylesheet') && !rel.includes('modulepreload')) continue
    const raw = isScript ? attribute(tag, 'src') : attribute(tag, 'href')
    if (!raw) continue
    let url: URL
    try {
      url = new URL(raw, shellURL)
    } catch {
      throw new Error('The neutral offline shell contains an invalid dependency URL.')
    }
    if (url.origin !== worker.location.origin || url.search || url.hash || !closure.has(url.href)) {
      throw new Error('The neutral offline shell dependency is outside its release closure.')
    }
    if (!seen.has(url.href)) {
      seen.add(url.href)
      dependencies.push(url.href)
    }
  }
  return dependencies
}

function base64(bytes: Uint8Array): string {
  let value = ''
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
}

async function integrityMatches(response: Response, integrity: string | undefined): Promise<boolean> {
  if (!integrity) return true
  if (typeof response.clone !== 'function' || !globalThis.crypto?.subtle) return false
  const bytes = new Uint8Array(await response.clone().arrayBuffer())
  for (const token of integrity.split(/\s+/u)) {
    const separator = token.indexOf('-')
    if (separator <= 0) continue
    const algorithm = token.slice(0, separator).toLowerCase()
    const hash = token.slice(separator + 1)
    if (!['sha256', 'sha384', 'sha512'].includes(algorithm) || !hash) continue
    const digest = await globalThis.crypto.subtle.digest(algorithm.toUpperCase().replace('SHA', 'SHA-') as AlgorithmIdentifier, bytes)
    if (base64(new Uint8Array(digest)) === hash) return true
  }
  return false
}

type CompletionMetadata = {
  release: string
  manifestDigest: string
  cacheName: string
}

async function completionMetadata(cache: Cache): Promise<CompletionMetadata | null> {
  for (const request of await cache.keys()) {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      continue
    }
    if (url.pathname !== OFFLINE_DOCUMENT_PATH || !url.searchParams.has('__tsepistle_pwa_complete')) continue
    const marker = await cache.match(request)
    if (!marker || !marker.ok) continue
    try {
      const value = (await marker.json()) as Partial<CompletionMetadata>
      if (
        typeof value.release === 'string' &&
        typeof value.manifestDigest === 'string' &&
        typeof value.cacheName === 'string'
      )
        return value as CompletionMetadata
    } catch {
      // An incomplete marker is not evidence that the cache is servable.
    }
  }
  return null
}

async function completeCache(cache: Cache): Promise<boolean> {
  const value = await completionMetadata(cache)
  return Boolean(
    value &&
      value.release === PWA_RELEASE_ID &&
      value.manifestDigest === MANIFEST_DIGEST &&
      value.cacheName === PRECACHE_CACHE_NAME
  )
}

async function cleanupIncompleteCaches(): Promise<void> {
  let names: string[]
  try {
    names = await caches.keys()
  } catch {
    return
  }
  for (const name of names) {
    if (!isOwnedPrecacheCacheName(name)) continue
    try {
      const cache = await caches.open(name)
      if (!(await completionMetadata(cache))) await caches.delete(name)
    } catch {
      // An unreadable owned orphan is left for a later lifecycle; deleting it
      // without proving incompleteness could remove a serving cache.
    }
  }
}

async function installPrecache(): Promise<void> {
  const entries = precacheEntries()
  const offlineURL = new URL(OFFLINE_DOCUMENT_PATH, worker.location.origin).href
  const closure = new Set(entries.map(value => value.url))
  if (!closure.has(offlineURL)) throw new Error('The offline document is missing from the service-worker precache manifest.')

  await cleanupIncompleteCaches()
  const cache = await caches.open(PRECACHE_CACHE_NAME)
  if (await completeCache(cache)) {
    PRECACHE_URLS.clear()
    for (const url of closure) PRECACHE_URLS.add(url)
    return
  }

  let installed = false
  try {
    for (const request of await cache.keys()) await cache.delete(request)
    for (const { entry, url } of entries) {
      const response = await fetch(new Request(url, { cache: 'reload', credentials: 'same-origin' }))
      if (response.status !== 200 || response.redirected || !responseTypeIsUsable(response) || !(await integrityMatches(response, entry.integrity))) {
        throw new Error(`The offline shell dependency could not be precached: ${url}`)
      }
      if (url === offlineURL) {
        const shell = await response.clone().text()
        if (metaContent(shell, 'tsepistle-pwa-mode') !== 'feature') throw new Error('The neutral offline shell is not in feature mode.')
        if (metaContent(shell, 'tsepistle-pwa-release') !== PWA_RELEASE_ID) {
          throw new Error('The neutral offline shell belongs to a different release.')
        }
        shellDependencies(shell, url, closure)
      }
      await cache.put(url, response)
    }
    for (const url of closure) {
      if (!(await cache.match(url))) throw new Error(`The offline shell closure is incomplete: ${url}`)
    }
    await cache.put(
      COMPLETE_MARKER_URL,
      new Response(
        JSON.stringify({ release: PWA_RELEASE_ID, manifestDigest: MANIFEST_DIGEST, cacheName: PRECACHE_CACHE_NAME }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    )
    if (!(await completeCache(cache))) throw new Error('The offline shell completion marker could not be verified.')
    PRECACHE_URLS.clear()
    for (const url of closure) PRECACHE_URLS.add(url)
    installed = true
  } finally {
    if (!installed) await caches.delete(PRECACHE_CACHE_NAME).catch(() => undefined)
  }
}

async function retireOldPrecacheCaches(): Promise<void> {
  const current = await caches.open(PRECACHE_CACHE_NAME)
  if (!(await completeCache(current))) return
  const cacheNames = await caches.keys()
  await Promise.all(
    cacheNames
      .filter(name => name !== PRECACHE_CACHE_NAME && isOwnedPrecacheCacheName(name))
      .map(name => caches.delete(name).catch(() => false))
  )
}

async function cachedShell(): Promise<Response | undefined> {
  try {
    const cache = await caches.open(PRECACHE_CACHE_NAME)
    if (!(await completeCache(cache))) return undefined
    return (await cache.match(new URL(OFFLINE_DOCUMENT_PATH, worker.location.origin).href)) ?? undefined
  } catch {
    return undefined
  }
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
  if (isNetworkOnlyPath(url.pathname) && !url.pathname.toLowerCase().startsWith(OFFLINE_ASSET_PREFIX)) return fetch(request)

  if (url.pathname === OFFLINE_DOCUMENT_PATH && request.mode === 'navigate' && acceptsHTML(request)) {
    const fallback = await cachedShell()
    if (fallback) return fallback
    return fetch(request)
  }

  if (PRECACHE_URLS.has(url.href)) {
    try {
      const cache = await caches.open(PRECACHE_CACHE_NAME)
      if (await completeCache(cache)) {
        const cached = await cache.match(url.href)
        if (cached) return cached
      }
    } catch {
      // Cache Storage is optional. Healthy network assets must continue.
    }
    return fetch(request)
  }

  if (isAllowlistedNavigation(request, worker.location.origin)) return handleNavigation(request)
  return fetch(request)
}

function scopedClient(client: WorkerClient): boolean {
  const clientURL = sameOriginURL(client.url, worker.location.origin)
  const scopeURL = sameOriginURL(worker.registration.scope, worker.location.origin)
  if (!clientURL || !scopeURL) return false
  const scopePath = scopeURL.pathname.endsWith('/') ? scopeURL.pathname : `${scopeURL.pathname}/`
  return clientURL.pathname === scopeURL.pathname || clientURL.pathname.startsWith(scopePath)
}

async function scopedClients(): Promise<WorkerClient[]> {
  return (await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(scopedClient)
}

function post(client: WorkerClient, message: unknown): void {
  try {
    client.postMessage(message)
  } catch {
    // A client can disappear between matchAll() and postMessage().
  }
}

function postRound(round: PreparationRound, message: unknown): void {
  for (const client of round.rosterClients) post(client, message)
}

function roundMessage(round: PreparationRound, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    workerId: round.workerId,
    release: round.release,
    roundNonce: round.roundNonce,
    ...extra
  }
}

function sameRoster(round: PreparationRound, clients: readonly WorkerClient[]): boolean {
  if (clients.length !== round.roster.size) return false
  for (const client of clients) {
    if (round.roster.get(client.id) !== client.url) return false
  }
  return true
}

async function deferRound(round: PreparationRound, reason: string): Promise<void> {
  if (preparationRound !== round) return
  preparationRound = null
  if (round.deadlineTimer !== null) clearTimeout(round.deadlineTimer)
  postRound(round, roundMessage(round, UPDATE_DEFERRED_MESSAGE, { reason }))
}

function schedulePreparationCheck(round: PreparationRound): Promise<void> | null {
  if (preparationRound !== round || round.started) return null
  if (round.checking) {
    round.checkAgain = true
    return round.checkPromise
  }
  round.checking = true
  const checkPromise = (async () => {
    const clients = await scopedClients().catch(() => null)
    if (preparationRound !== round || round.started) return
    if (!clients || !sameRoster(round, clients)) {
      await deferRound(round, 'client-roster-changed')
      return
    }
    for (const client of clients) {
      const vote = round.votes.get(client.id)
      if (!vote || !vote.safe || vote.revision !== round.firstRevisions.get(client.id)) return
    }

    const finalClients = await scopedClients().catch(() => null)
    if (preparationRound !== round || round.started) return
    if (!finalClients || !sameRoster(round, finalClients)) {
      await deferRound(round, 'client-roster-changed')
      return
    }

    // This is the irreversible boundary. No await occurs between the final
    // roster check and skipWaiting().
    round.started = true
    if (round.deadlineTimer !== null) clearTimeout(round.deadlineTimer)
    activationIntent = { workerId: round.workerId, release: round.release, roundNonce: round.roundNonce }
    postRound(round, roundMessage(round, UPDATE_ACTIVATING_MESSAGE))
    try {
      await worker.skipWaiting()
    } catch {
      postRound(round, roundMessage(round, UPDATE_DEFERRED_MESSAGE, { reason: 'skip-waiting-failed' }))
      preparationRound = null
    }
  })().finally(() => {
    round.checking = false
    round.checkPromise = null
    if (round.checkAgain) {
      round.checkAgain = false
      schedulePreparationCheck(round)
    }
  })
  round.checkPromise = checkPromise
  return checkPromise
}

async function startPreparation(source: WorkerClient): Promise<void> {
  if (!scopedClient(source)) return
  const initialRound = preparationRound
  if (initialRound) {
    post(source, roundMessage(initialRound, UPDATE_PREPARING_MESSAGE, { phase: initialRound.started ? 'activating' : 'collecting' }))
    return
  }
  const clients = await scopedClients().catch(() => [])
  const currentRound = preparationRound
  if (currentRound) {
    post(source, roundMessage(currentRound, UPDATE_PREPARING_MESSAGE, { phase: currentRound.started ? 'activating' : 'collecting' }))
    return
  }
  if (!clients.some(client => client.id === source.id)) return
  const round: PreparationRound = {
    workerId: WORKER_ID,
    release: PWA_RELEASE_ID,
    roundNonce: createToken(),
    roster: new Map(clients.map(client => [client.id, client.url])),
    rosterClients: clients,
    firstRevisions: new Map(),
    votes: new Map(),
    started: false,
    checking: false,
    checkAgain: false,
    checkPromise: null,
    deadlineTimer: null
  }
  preparationRound = round
  round.deadlineTimer = setTimeout(() => {
    void deferRound(round, 'preparation-deadline')
  }, PREPARATION_DEADLINE_MS)
  postRound(round, roundMessage(round, UPDATE_PREPARING_MESSAGE, { phase: 'collecting', clientCount: clients.length }))
  for (const client of clients) {
    post(
      client,
      roundMessage(round, RELOAD_SAFETY_REQUEST_MESSAGE, {
        clientId: client.id
      })
    )
  }
}

async function acceptSafetyVote(
  source: WorkerClient,
  message: { workerId?: unknown; release?: unknown; roundNonce?: unknown; safe?: unknown; revision?: unknown; actorEpoch?: unknown }
): Promise<void> {
  const round = preparationRound
  if (
    !round ||
    round.started ||
    message.workerId !== round.workerId ||
    message.release !== round.release ||
    message.roundNonce !== round.roundNonce ||
    typeof message.safe !== 'boolean' ||
    typeof message.revision !== 'string' ||
    message.revision.length === 0 ||
    !round.roster.has(source.id)
  )
    return
  const priorRevision = round.firstRevisions.get(source.id)
  if (priorRevision !== undefined && priorRevision !== message.revision) {
    await deferRound(round, 'safety-revision-changed')
    return
  }
  round.firstRevisions.set(source.id, message.revision)
  const vote: SafetyVote = { safe: message.safe, revision: message.revision }
  if (typeof message.actorEpoch === 'string' || typeof message.actorEpoch === 'number') vote.actorEpoch = message.actorEpoch
  round.votes.set(source.id, vote)
  const check = schedulePreparationCheck(round)
  if (check) await check
}

async function sendOfflineReady(target?: WorkerClient | null): Promise<void> {
  const cache = await caches.open(PRECACHE_CACHE_NAME).catch(() => null)
  const complete = cache ? await completeCache(cache).catch(() => false) : false
  const message = complete
    ? {
        type: OFFLINE_READY_MESSAGE,
        complete: true,
        release: PWA_RELEASE_ID,
        manifestDigest: MANIFEST_DIGEST,
        cacheName: PRECACHE_CACHE_NAME,
        shellPath: OFFLINE_DOCUMENT_PATH,
        markerURL: COMPLETE_MARKER_URL
      }
    : {
        type: OFFLINE_NOT_READY_MESSAGE,
        complete: false,
        release: PWA_RELEASE_ID,
        manifestDigest: MANIFEST_DIGEST,
        cacheName: PRECACHE_CACHE_NAME,
        shellPath: OFFLINE_DOCUMENT_PATH
      }
  if (target) {
    post(target, message)
    return
  }
  for (const client of await scopedClients().catch(() => [])) post(client, message)
}

worker.addEventListener('install', event => {
  ;(event as LifecycleEvent).waitUntil(installPrecache())
})

worker.addEventListener('activate', event => {
  ;(event as LifecycleEvent).waitUntil(
    (async () => {
      await cleanupIncompleteCaches()
      await retireOldPrecacheCaches().catch(() => undefined)
      if (typeof worker.clients.claim === 'function') await worker.clients.claim().catch(() => undefined)
      await sendOfflineReady()

      const intent = activationIntent
      if (!intent) return
      const clients = await scopedClients().catch(() => [])
      const message = {
        type: ACTIVATED_UPDATE_MESSAGE,
        workerId: intent.workerId,
        release: intent.release,
        roundNonce: intent.roundNonce
      }
      for (const client of clients) post(client, message)
      activationIntent = null
      preparationRound = null
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
  const message = messageEvent.data as {
    type?: unknown
    workerId?: unknown
    release?: unknown
    roundNonce?: unknown
    safe?: unknown
    revision?: unknown
    actorEpoch?: unknown
  }
  if (message.type === PREPARE_UPDATE_MESSAGE) {
    const preparation = startPreparation(messageEvent.source)
    if (typeof messageEvent.waitUntil === 'function') messageEvent.waitUntil(preparation)
    else void preparation
    return
  }
  if (message.type === RELOAD_SAFETY_MESSAGE) {
    const vote = acceptSafetyVote(messageEvent.source, message)
    if (typeof messageEvent.waitUntil === 'function') messageEvent.waitUntil(vote)
    else void vote
    return
  }
  if (message.type === 'PWA_OFFLINE_READY_REQUEST') {
    const readiness = sendOfflineReady(messageEvent.source)
    if (typeof messageEvent.waitUntil === 'function') messageEvent.waitUntil(readiness)
  }
})

export const PWA_SERVICE_WORKER_RELEASE = PWA_RELEASE_ID
export const PWA_SERVICE_WORKER_CACHE_NAME = PRECACHE_CACHE_NAME
