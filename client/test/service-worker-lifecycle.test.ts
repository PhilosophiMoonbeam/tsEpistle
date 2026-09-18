import { describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { PRECACHE_CACHE_PREFIX } from '../helpers/pwa-route-policy.ts'

const ORIGIN = 'https://wiki.example.test'
const RELEASE_PLACEHOLDER = '__TSEPISTLE_PWA_RELEASE__'
const SHELL_URL = `${ORIGIN}/_offline`
const JS_URL = `${ORIGIN}/_assets/js/offline-entry.js`
const CSS_URL = `${ORIGIN}/_assets/assets/offline.css`

type HarnessEvent = {
  readonly [key: string]: unknown
  readonly waitUntil: (promise: Promise<unknown>) => void
  readonly respondWith: (response: Response | Promise<Response>) => void
}

type Listener = (event: HarnessEvent) => void

type DispatchResult = {
  readonly waits: Promise<unknown>[]
  readonly response: Response | Promise<Response> | undefined
}

class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>()

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string, values: Record<string, unknown> = {}): DispatchResult {
    const waits: Promise<unknown>[] = []
    let response: Response | Promise<Response> | undefined
    const event: HarnessEvent = {
      ...values,
      type,
      waitUntil(value: Promise<unknown>) {
        waits.push(Promise.resolve(value))
      },
      respondWith(value: Response | Promise<Response>) {
        response = value
      }
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
    return { waits, response }
  }
}

class MemoryCache {
  readonly entries = new Map<string, Response>()

  constructor(private readonly owner: MemoryCaches, readonly name: string) {}

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map(url => new Request(url))
  }

  async match(request: Request | string): Promise<Response | undefined> {
    const url = typeof request === 'string' ? request : request.url
    return this.entries.get(url)?.clone()
  }

  async put(request: Request | string, response: Response): Promise<void> {
    if (this.owner.failPut) throw new Error(`Cache put failed for ${this.name}`)
    const url = typeof request === 'string' ? request : request.url
    this.entries.set(url, response.clone())
  }

  async delete(request: Request | string): Promise<boolean> {
    const url = typeof request === 'string' ? request : request.url
    return this.entries.delete(url)
  }
}

class MemoryCaches {
  readonly stores = new Map<string, MemoryCache>()
  denyOpen = false
  failPut = false
  openCalls = 0

  async open(name: string): Promise<MemoryCache> {
    this.openCalls += 1
    if (this.denyOpen) throw new Error('Cache Storage denied')
    let cache = this.stores.get(name)
    if (!cache) {
      cache = new MemoryCache(this, name)
      this.stores.set(name, cache)
    }
    return cache
  }

  async keys(): Promise<string[]> {
    return [...this.stores.keys()]
  }

  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name)
  }
}

type TestClient = {
  id: string
  url: string
  messages: unknown[]
  postMessage(message: unknown): void
}

type WorkerModule = {
  readonly PWA_SERVICE_WORKER_RELEASE: string
  readonly PWA_SERVICE_WORKER_CACHE_NAME: string
}

type WorkerHarness = {
  readonly hub: EventHub
  readonly caches: MemoryCaches
  readonly clients: { list: TestClient[]; matchAll: (options?: unknown) => Promise<TestClient[]> }
  readonly registration: { scope: string }
  readonly worker: WorkerModule
  readonly dispatchInstall: () => Promise<void>
  readonly dispatchActivate: () => Promise<void>
  readonly dispatchFetch: (request: Request) => Promise<Response>
  readonly dispatchMessage: (source: TestClient, data: unknown) => Promise<void>
  readonly restore: () => void
  skipWaitingCalls: number
}

let importSequence = 0

const shell = (release = RELEASE_PLACEHOLDER): string => `<!doctype html>
<html><head>
<meta name="tsepistle-pwa-mode" content="feature">
<meta name="tsepistle-pwa-release" content="${release}">
<link rel="modulepreload" href="/_assets/js/offline-entry.js">
<link rel="stylesheet" href="/_assets/assets/offline.css">
<script type="module" src="/_assets/js/offline-entry.js"></script>
</head><body>offline</body></html>
`

const manifest = [
  { url: '/_offline', revision: 'shell-revision' },
  { url: '/_assets/js/offline-entry.js', revision: 'js-revision' },
  { url: '/_assets/assets/offline.css', revision: 'css-revision' }
] as const

const client = (id: string): TestClient => ({
  id,
  url: `${ORIGIN}/en/${id}`,
  messages: [],
  postMessage(message: unknown) {
    this.messages.push(message)
  }
})

const requestLike = (url: string, mode: string, accept = 'text/html'): Request =>
  ({
    method: 'GET',
    mode,
    url,
    headers: new Headers({ Accept: accept })
  }) as unknown as Request

const defineGlobal = (name: string, value: unknown, originals: Map<string, PropertyDescriptor | undefined>): void => {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

const createHarness = async (options: {
  shell?: string
  fetch?: (url: string) => Response | Promise<Response>
  onSkipWaiting?: () => void | Promise<void>
} = {}): Promise<WorkerHarness> => {
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const hub = new EventHub()
  const caches = new MemoryCaches()
  const clients = {
    list: [] as TestClient[],
    matchAll: async (_options?: unknown) => [...clients.list]
  }
  const registration = { scope: `${ORIGIN}/` }
  let skipWaitingCalls = 0
  const networkFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (options.fetch) return await options.fetch(url)
    if (url === SHELL_URL) return new Response(options.shell ?? shell())
    if (url === JS_URL) return new Response('export default 1')
    if (url === CSS_URL) return new Response('body { color: black; }')
    return new Response(`network:${url}`)
  }
  defineGlobal('location', { origin: ORIGIN, href: `${ORIGIN}/` }, originals)
  defineGlobal('caches', caches, originals)
  defineGlobal('clients', clients, originals)
  defineGlobal('registration', registration, originals)
  defineGlobal('skipWaiting', async () => {
    skipWaitingCalls += 1
    await options.onSkipWaiting?.()
  }, originals)
  defineGlobal('__WB_MANIFEST', manifest, originals)
  defineGlobal('fetch', networkFetch, originals)
  defineGlobal('addEventListener', hub.addEventListener.bind(hub), originals)
  defineGlobal('removeEventListener', hub.removeEventListener.bind(hub), originals)

  const worker = await vi.importFresh<WorkerModule>(`../service-worker.ts?lifecycle=${importSequence++}`, import.meta.url)
  const restore = (): void => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
  return {
    hub,
    caches,
    clients,
    registration,
    worker,
    dispatchInstall: async () => {
      const event = hub.emit('install')
      await Promise.all(event.waits)
    },
    dispatchActivate: async () => {
      const event = hub.emit('activate')
      await Promise.all(event.waits)
    },
    dispatchFetch: async request => {
      const event = hub.emit('fetch', { request })
      return await (event.response ?? networkFetch(request))
    },
    dispatchMessage: async (source, data) => {
      const event = hub.emit('message', { source, data })
      await Promise.all(event.waits)
    },
    restore,
    get skipWaitingCalls() {
      return skipWaitingCalls
    }
  }
}

const completeMarkerURL = (digest = '0123456789abcdef'): string =>
  `${SHELL_URL}?__tsepistle_pwa_complete=${encodeURIComponent(RELEASE_PLACEHOLDER)}-${digest}`

const seedCompleteCache = async (caches: MemoryCaches, name: string, release = RELEASE_PLACEHOLDER, digest = '0123456789abcdef'): Promise<MemoryCache> => {
  const cache = await caches.open(name)
  await cache.put(SHELL_URL, new Response(shell(release)))
  await cache.put(
    completeMarkerURL(digest),
    new Response(JSON.stringify({ release, manifestDigest: digest, cacheName: name }), { headers: { 'Content-Type': 'application/json' } })
  )
  return cache
}

const ownedPriorCacheName = `${PRECACHE_CACHE_PREFIX}abcdef0123456789`


describe('service worker lifecycle', () => {
  it('leaves protected navigation, APIs, streams, downloads, and third-party requests to the browser', async () => {
    const harness = await createHarness({ fetch: () => { throw new Error('Worker must not fetch passthrough requests') } })
    try {
      for (const path of ['/a', '/a/general', '/h/en/home', '/e/en/home', '/_api/pages', '/graphql', '/login', '/files/report.pdf']) {
        expect(harness.hub.emit('fetch', { request: requestLike(`${ORIGIN}${path}`, 'navigate') }).response).toBeUndefined()
      }
      expect(harness.hub.emit('fetch', { request: requestLike('https://other.example/asset.js', 'cors') }).response).toBeUndefined()
      expect(harness.hub.emit('fetch', { request: new Request(`${ORIGIN}/_api/pages`, { method: 'POST' }) }).response).toBeUndefined()
    } finally {
      harness.restore()
    }
  })

  it('opens the cached offline library directly without allowing protected or non-navigation fallbacks', async () => {
    let online = true
    const harness = await createHarness({
      fetch: async url => {
        if (!online) throw new Error('Network is offline')
        return new Response(url === SHELL_URL ? shell() : 'asset')
      }
    })
    try {
      await harness.dispatchInstall()
      online = false
      for (const path of ['/_offline', '/_offline?pageId=1&locale=en']) {
        const response = await harness.dispatchFetch(requestLike(`${ORIGIN}${path}`, 'navigate'))
        expect(await response.text()).toContain('offline')
      }
      for (const path of ['/_offline/nested', '/_api/users/whoami', '/login', '/logout', '/_private/en/notes']) {
        await expect(harness.dispatchFetch(requestLike(`${ORIGIN}${path}`, 'navigate'))).rejects.toThrow('Network is offline')
      }
      await expect(harness.dispatchFetch(requestLike(SHELL_URL, 'cors'))).rejects.toThrow('Network is offline')
      await expect(harness.dispatchFetch(requestLike(SHELL_URL, 'navigate', 'application/json'))).rejects.toThrow('Network is offline')
    } finally {
      harness.restore()
    }
  })

  it.each(['fetch', 'put'] as const)('preserves the prior complete cache and removes a failed %s candidate', async failure => {
    const harness = await createHarness({
      fetch: failure === 'fetch'
        ? async url => {
            if (url === CSS_URL) throw new Error('Injected network failure')
            return url === SHELL_URL ? new Response(shell()) : new Response('asset')
          }
        : undefined
    })
    try {
      const prior = await seedCompleteCache(harness.caches, ownedPriorCacheName)
      const unrelated = await harness.caches.open('unrelated-application-cache')
      await unrelated.put(`${ORIGIN}/private`, new Response('private data'))
      if (failure === 'put') harness.caches.failPut = true

      await expect(harness.dispatchInstall()).rejects.toThrow()
      expect(harness.caches.stores.has(harness.worker.PWA_SERVICE_WORKER_CACHE_NAME)).toBe(false)
      expect(harness.caches.stores.has(ownedPriorCacheName)).toBe(true)
      expect(await (await prior.match(SHELL_URL))?.text()).toContain('offline')
      expect(await (await prior.match(completeMarkerURL()))?.json()).toMatchObject({ cacheName: ownedPriorCacheName })
      expect(harness.caches.stores.has('unrelated-application-cache')).toBe(true)
    } finally {
      harness.restore()
    }
  })

  it('cleans an incomplete owned orphan on the next lifecycle without touching unrelated caches', async () => {
    const harness = await createHarness()
    try {
      const orphan = `${PRECACHE_CACHE_PREFIX}0123456789abcdef-candidate-terminated`
      const orphanCache = await harness.caches.open(orphan)
      await orphanCache.put(SHELL_URL, new Response(shell()))
      const unrelated = await harness.caches.open('browser-unrelated')
      await unrelated.put(`${ORIGIN}/unrelated`, new Response('keep'))

      await harness.dispatchInstall()
      expect(harness.caches.stores.has(orphan)).toBe(false)
      expect(harness.caches.stores.has('browser-unrelated')).toBe(true)
      expect(harness.caches.stores.has(harness.worker.PWA_SERVICE_WORKER_CACHE_NAME)).toBe(true)
      const current = harness.caches.stores.get(harness.worker.PWA_SERVICE_WORKER_CACHE_NAME)!
      const marker = (await current.keys()).find(request => new URL(request.url).searchParams.has('__tsepistle_pwa_complete'))
      expect(marker).toBeDefined()
    } finally {
      harness.restore()
    }
  })

  it('rejects a mixed-release shell before publishing any completion marker', async () => {
    const harness = await createHarness({ shell: shell('fedcba9876543210fedcba9876543210fedcba98') })
    try {
      const prior = await seedCompleteCache(harness.caches, ownedPriorCacheName)
      await expect(harness.dispatchInstall()).rejects.toThrow('different release')
      expect(harness.caches.stores.has(harness.worker.PWA_SERVICE_WORKER_CACHE_NAME)).toBe(false)
      expect(harness.caches.stores.has(ownedPriorCacheName)).toBe(true)
      expect(await (await prior.match(SHELL_URL))?.text()).toContain('offline')
    } finally {
      harness.restore()
    }
  })

  it('keeps healthy navigation and precached asset fetches online when Cache Storage is denied', async () => {
    const networkRequests: string[] = []
    const harness = await createHarness({
      fetch: async url => {
        networkRequests.push(url)
        return new Response(`online:${url}`)
      }
    })
    try {
      harness.caches.denyOpen = true
      const navigation = await harness.dispatchFetch(requestLike(`${ORIGIN}/en/guide`, 'navigate'))
      expect(await navigation.text()).toBe(`online:${ORIGIN}/en/guide`)
      const asset = await harness.dispatchFetch(requestLike(JS_URL, 'no-cors', '*/*'))
      expect(await asset.text()).toBe(`online:${JS_URL}`)
      expect(networkRequests).toEqual([`${ORIGIN}/en/guide`, JS_URL])
      expect(harness.caches.openCalls).toBe(1)
    } finally {
      harness.restore()
    }
  })

  it('coalesces competing preparation initiators and activates only after every current client votes safely', async () => {
    const harness = await createHarness()
    const first = client('first')
    const second = client('second')
    harness.clients.list = [first, second]
    try {
      await harness.dispatchMessage(first, { type: 'PWA_PREPARE_UPDATE' })
      const preparing = first.messages.find(message => (message as { type?: unknown }).type === 'PWA_UPDATE_PREPARING') as {
        workerId: string
        release: string
        roundNonce: string
      }
      expect(preparing).toBeDefined()
      expect(first.messages.filter(message => (message as { type?: unknown }).type === 'PWA_RELOAD_SAFETY_REQUEST')).toHaveLength(1)
      expect(second.messages.filter(message => (message as { type?: unknown }).type === 'PWA_RELOAD_SAFETY_REQUEST')).toHaveLength(1)

      await harness.dispatchMessage(second, { type: 'PWA_PREPARE_UPDATE' })
      expect(first.messages.filter(message => (message as { type?: unknown }).type === 'PWA_RELOAD_SAFETY_REQUEST')).toHaveLength(1)
      expect(second.messages.filter(message => (message as { type?: unknown }).type === 'PWA_UPDATE_PREPARING')).toHaveLength(2)

      const vote = (source: TestClient, revision: string, safe: boolean) => harness.dispatchMessage(source, {
        type: 'PWA_RELOAD_SAFETY',
        workerId: preparing.workerId,
        release: preparing.release,
        roundNonce: preparing.roundNonce,
        safe,
        revision
      })
      await vote(first, 'first-revision', true)
      expect(harness.skipWaitingCalls).toBe(0)
      await vote(second, 'second-revision', true)
      expect(harness.skipWaitingCalls).toBe(1)
      expect(first.messages.filter(message => (message as { type?: unknown }).type === 'PWA_UPDATE_ACTIVATING')).toHaveLength(1)
      expect(second.messages.filter(message => (message as { type?: unknown }).type === 'PWA_UPDATE_ACTIVATING')).toHaveLength(1)
      await vote(first, 'first-revision', true)
      expect(harness.skipWaitingCalls).toBe(1)
    } finally {
      harness.restore()
    }
  })

  it('defers a round when a new client appears before the final roster check or a client votes unsafe', async () => {
    const harness = await createHarness()
    const first = client('first')
    const second = client('second')
    const third = client('third')
    harness.clients.list = [first, second]
    try {
      await harness.dispatchMessage(first, { type: 'PWA_PREPARE_UPDATE' })
      const preparing = first.messages.find(message => (message as { type?: unknown }).type === 'PWA_UPDATE_PREPARING') as {
        workerId: string
        release: string
        roundNonce: string
      }
      harness.clients.list = [first, second, third]
      const vote = (source: TestClient, revision: string, safe: boolean) => harness.dispatchMessage(source, {
        type: 'PWA_RELOAD_SAFETY',
        workerId: preparing.workerId,
        release: preparing.release,
        roundNonce: preparing.roundNonce,
        safe,
        revision
      })
      await vote(first, 'first-revision', true)
      expect(harness.skipWaitingCalls).toBe(0)
      expect(first.messages.at(-1)).toMatchObject({ type: 'PWA_UPDATE_DEFERRED', reason: 'client-roster-changed' })

      const unsafeHarness = await createHarness()
      const unsafeFirst = client('unsafe-first')
      const unsafeSecond = client('unsafe-second')
      const unsafeThird = client('unsafe-third')
      unsafeHarness.clients.list = [unsafeFirst, unsafeSecond]
      try {
        await unsafeHarness.dispatchMessage(unsafeFirst, { type: 'PWA_PREPARE_UPDATE' })
        const unsafePreparing = unsafeFirst.messages.find(message => (message as { type?: unknown }).type === 'PWA_UPDATE_PREPARING') as {
          workerId: string
          release: string
          roundNonce: string
        }
        const unsafeVote = (source: TestClient, revision: string, safe: boolean) => unsafeHarness.dispatchMessage(source, {
          type: 'PWA_RELOAD_SAFETY',
          workerId: unsafePreparing.workerId,
          release: unsafePreparing.release,
          roundNonce: unsafePreparing.roundNonce,
          safe,
          revision
        })
        await unsafeVote(unsafeFirst, 'first-revision', true)
        await unsafeVote(unsafeSecond, 'second-revision', false)
        expect(unsafeHarness.skipWaitingCalls).toBe(0)
        unsafeHarness.clients.list = [unsafeFirst, unsafeSecond, unsafeThird]
        await unsafeVote(unsafeFirst, 'first-revision', true)
        expect(unsafeHarness.skipWaitingCalls).toBe(0)
        expect(unsafeFirst.messages.at(-1)).toMatchObject({ type: 'PWA_UPDATE_DEFERRED', reason: 'client-roster-changed' })
      } finally {
        unsafeHarness.restore()
      }
    } finally {
      harness.restore()
    }
  })
  it('keeps one current preparation round when duplicate initiators race', async () => {
    const harness = await createHarness()
    const first = client('first')
    const second = client('second')
    harness.clients.list = [first, second]
    try {
      await Promise.all([
        harness.dispatchMessage(first, { type: 'PWA_PREPARE_UPDATE' }),
        harness.dispatchMessage(second, { type: 'PWA_PREPARE_UPDATE' })
      ])
      const preparingMessages = [...first.messages, ...second.messages].filter(
        message => (message as { type?: unknown }).type === 'PWA_UPDATE_PREPARING'
      ) as Array<{ workerId: string; release: string; roundNonce: string }>
      const rounds = new Set(preparingMessages.map(message => `${message.workerId}:${message.roundNonce}`))
      expect(rounds).toHaveLength(1)
      expect(first.messages.filter(message => (message as { type?: unknown }).type === 'PWA_RELOAD_SAFETY_REQUEST')).toHaveLength(1)
      expect(second.messages.filter(message => (message as { type?: unknown }).type === 'PWA_RELOAD_SAFETY_REQUEST')).toHaveLength(1)

      const preparing = preparingMessages[0]!
      const vote = (source: TestClient, revision: string) => harness.dispatchMessage(source, {
        type: 'PWA_RELOAD_SAFETY',
        workerId: preparing.workerId,
        release: preparing.release,
        roundNonce: preparing.roundNonce,
        safe: true,
        revision
      })
      await Promise.all([
        vote(first, 'first-revision'),
        vote(first, 'first-revision'),
        vote(second, 'second-revision'),
        vote(second, 'second-revision')
      ])
      expect(harness.skipWaitingCalls).toBe(1)
      expect(first.messages.filter(message => (message as { type?: unknown }).type === 'PWA_UPDATE_ACTIVATING')).toHaveLength(1)
      expect(second.messages.filter(message => (message as { type?: unknown }).type === 'PWA_UPDATE_ACTIVATING')).toHaveLength(1)
    } finally {
      harness.restore()
    }
  })

  it('defers an expired round when a roster client never supplies a vote', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    const first = client('first')
    const second = client('second')
    harness.clients.list = [first, second]
    try {
      await harness.dispatchMessage(first, { type: 'PWA_PREPARE_UPDATE' })
      const preparing = first.messages.find(message => (message as { type?: unknown }).type === 'PWA_UPDATE_PREPARING') as {
        workerId: string
        release: string
        roundNonce: string
      }
      await harness.dispatchMessage(first, {
        type: 'PWA_RELOAD_SAFETY',
        workerId: preparing.workerId,
        release: preparing.release,
        roundNonce: preparing.roundNonce,
        safe: true,
        revision: 'first-revision'
      })
      expect(harness.skipWaitingCalls).toBe(0)

      await vi.advanceTimersByTimeAsync(15_001)
      expect(harness.skipWaitingCalls).toBe(0)
      expect(first.messages.at(-1)).toMatchObject({ type: 'PWA_UPDATE_DEFERRED', reason: 'preparation-deadline' })
      expect(second.messages.at(-1)).toMatchObject({ type: 'PWA_UPDATE_DEFERRED', reason: 'preparation-deadline' })

      await harness.dispatchMessage(second, {
        type: 'PWA_RELOAD_SAFETY',
        workerId: preparing.workerId,
        release: preparing.release,
        roundNonce: preparing.roundNonce,
        safe: true,
        revision: 'second-revision'
      })
      expect(harness.skipWaitingCalls).toBe(0)
    } finally {
      harness.restore()
      vi.useRealTimers()
    }
  })

  it('defers immediately when a roster client closes before the final vote', async () => {
    const harness = await createHarness()
    const first = client('first')
    const second = client('second')
    harness.clients.list = [first, second]
    try {
      await harness.dispatchMessage(first, { type: 'PWA_PREPARE_UPDATE' })
      const preparing = first.messages.find(message => (message as { type?: unknown }).type === 'PWA_UPDATE_PREPARING') as {
        workerId: string
        release: string
        roundNonce: string
      }
      harness.clients.list = [first]
      await harness.dispatchMessage(first, {
        type: 'PWA_RELOAD_SAFETY',
        workerId: preparing.workerId,
        release: preparing.release,
        roundNonce: preparing.roundNonce,
        safe: true,
        revision: 'first-revision'
      })
      expect(harness.skipWaitingCalls).toBe(0)
      expect(first.messages.at(-1)).toMatchObject({ type: 'PWA_UPDATE_DEFERRED', reason: 'client-roster-changed' })
      await harness.dispatchMessage(second, {
        type: 'PWA_RELOAD_SAFETY',
        workerId: preparing.workerId,
        release: preparing.release,
        roundNonce: preparing.roundNonce,
        safe: true,
        revision: 'second-revision'
      })
      expect(harness.skipWaitingCalls).toBe(0)
      expect(first.messages.filter(message => (message as { type?: unknown }).type === 'PWA_UPDATE_ACTIVATING')).toHaveLength(0)
      expect(second.messages.filter(message => (message as { type?: unknown }).type === 'PWA_UPDATE_ACTIVATING')).toHaveLength(0)
    } finally {
      harness.restore()
    }
  })

  it('rejects votes from a previous worker after a service-worker restart', async () => {
    const first = client('first')
    const second = client('second')
    const original = await createHarness()
    original.clients.list = [first, second]
    let previousRound: { workerId: string; release: string; roundNonce: string }
    try {
      await original.dispatchMessage(first, { type: 'PWA_PREPARE_UPDATE' })
      previousRound = first.messages.find(message => (message as { type?: unknown }).type === 'PWA_UPDATE_PREPARING') as {
        workerId: string
        release: string
        roundNonce: string
      }
      original.clients.list = [first]
      await original.dispatchMessage(first, {
        type: 'PWA_RELOAD_SAFETY',
        workerId: previousRound.workerId,
        release: previousRound.release,
        roundNonce: previousRound.roundNonce,
        safe: true,
        revision: 'first-revision'
      })
    } finally {
      original.restore()
    }

    const restarted = await createHarness()
    restarted.clients.list = [first, second]
    try {
      await restarted.dispatchMessage(first, { type: 'PWA_PREPARE_UPDATE' })
      const currentRound = [...first.messages].reverse().find(message => (message as { type?: unknown }).type === 'PWA_UPDATE_PREPARING') as {
        workerId: string
        release: string
        roundNonce: string
      }
      expect(currentRound.workerId).not.toBe(previousRound!.workerId)
      expect(currentRound.roundNonce).not.toBe(previousRound!.roundNonce)

      const vote = (source: TestClient, round: { workerId: string; release: string; roundNonce: string }, revision: string) =>
        restarted.dispatchMessage(source, {
          type: 'PWA_RELOAD_SAFETY',
          workerId: round.workerId,
          release: round.release,
          roundNonce: round.roundNonce,
          safe: true,
          revision
        })
      await vote(first, previousRound!, 'first-revision')
      await vote(second, previousRound!, 'second-revision')
      expect(restarted.skipWaitingCalls).toBe(0)

      await vote(first, currentRound, 'first-revision')
      await vote(second, currentRound, 'second-revision')
      expect(restarted.skipWaitingCalls).toBe(1)
    } finally {
      restarted.restore()
    }
  })

  it('defers a round when a client changes its safety revision', async () => {
    const harness = await createHarness()
    const first = client('first')
    const second = client('second')
    harness.clients.list = [first, second]
    try {
      await harness.dispatchMessage(first, { type: 'PWA_PREPARE_UPDATE' })
      const preparing = first.messages.find(message => (message as { type?: unknown }).type === 'PWA_UPDATE_PREPARING') as {
        workerId: string
        release: string
        roundNonce: string
      }
      const vote = (revision: string) => harness.dispatchMessage(first, {
        type: 'PWA_RELOAD_SAFETY',
        workerId: preparing.workerId,
        release: preparing.release,
        roundNonce: preparing.roundNonce,
        safe: true,
        revision
      })
      await vote('revision-a')
      await vote('revision-b')
      expect(harness.skipWaitingCalls).toBe(0)
      expect(first.messages.at(-1)).toMatchObject({ type: 'PWA_UPDATE_DEFERRED', reason: 'safety-revision-changed' })

      await harness.dispatchMessage(second, {
        type: 'PWA_RELOAD_SAFETY',
        workerId: preparing.workerId,
        release: preparing.release,
        roundNonce: preparing.roundNonce,
        safe: true,
        revision: 'second-revision'
      })
      expect(harness.skipWaitingCalls).toBe(0)
    } finally {
      harness.restore()
    }
  })

  it('freezes the roster at skipWaiting and notifies a later unsafe client without adding it to consensus', async () => {
    const first = client('first')
    const second = client('second')
    const late = client('late')
    let harness: WorkerHarness | undefined
    harness = await createHarness({
      onSkipWaiting: () => {
        harness?.clients.list.push(late)
      }
    })
    harness.clients.list = [first, second]
    try {
      await harness.dispatchInstall()
      await harness.dispatchMessage(first, { type: 'PWA_PREPARE_UPDATE' })
      const preparing = first.messages.find(message => (message as { type?: unknown }).type === 'PWA_UPDATE_PREPARING') as {
        workerId: string
        release: string
        roundNonce: string
      }
      const vote = (source: TestClient, revision: string) => harness!.dispatchMessage(source, {
        type: 'PWA_RELOAD_SAFETY',
        workerId: preparing.workerId,
        release: preparing.release,
        roundNonce: preparing.roundNonce,
        safe: true,
        revision
      })
      await vote(first, 'first-revision')
      await vote(second, 'second-revision')
      expect(harness.skipWaitingCalls).toBe(1)
      expect(harness.clients.list).toEqual([first, second, late])
      expect(late.messages.filter(message => (message as { type?: unknown }).type === 'PWA_UPDATE_ACTIVATING')).toHaveLength(0)

      await harness.dispatchActivate()
      expect(late.messages.filter(message => (message as { type?: unknown }).type === 'PWA_UPDATE_ACTIVATED')).toHaveLength(1)
      expect(first.messages.filter(message => (message as { type?: unknown }).type === 'PWA_UPDATE_ACTIVATING')).toHaveLength(1)
      expect(second.messages.filter(message => (message as { type?: unknown }).type === 'PWA_UPDATE_ACTIVATING')).toHaveLength(1)
    } finally {
      harness.restore()
    }
  })
})
