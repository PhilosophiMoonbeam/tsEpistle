import { describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type { PwaLifecycleCallbacks, PwaState, ReloadSafetyProvider } from '../helpers/pwa.ts'

const ORIGIN = 'https://wiki.example.test'
const RELEASE = 'release-a'
const DIGEST = '0123456789abcdef'
const CACHE_NAME = 'tsepistle-pwa-precache-v1-abcdef0123456789'
const SHELL_URL = `${ORIGIN}/_offline`
const MARKER_URL = `${SHELL_URL}?__tsepistle_pwa_complete=${encodeURIComponent(RELEASE)}-${DIGEST}`

type HarnessEvent = { readonly [key: string]: unknown }
type Listener = (event: HarnessEvent) => void

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

  emit(type: string, values: Record<string, unknown> = {}): void {
    const event: HarnessEvent = { ...values, type }
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

class MemoryCache {
  readonly entries = new Map<string, Response>()

  async match(request: Request | string): Promise<Response | undefined> {
    const url = typeof request === 'string' ? request : request.url
    return this.entries.get(url)?.clone()
  }

  async put(request: Request | string, response: Response): Promise<void> {
    const url = typeof request === 'string' ? request : request.url
    this.entries.set(url, response.clone())
  }
}

class MemoryCaches {
  readonly stores = new Map<string, MemoryCache>()

  async open(name: string): Promise<MemoryCache> {
    let cache = this.stores.get(name)
    if (!cache) {
      cache = new MemoryCache()
      this.stores.set(name, cache)
    }
    return cache
  }
}

class TestPort {
  peer!: TestPort
  closed = false
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage(data: unknown): void {
    if (!this.closed && !this.peer.closed) this.peer.onmessage?.({ data })
  }
  close(): void { this.closed = true }
}

class TestMessageChannel {
  port1 = new TestPort()
  port2 = new TestPort()
  constructor() {
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

class TestBroadcastChannel {
  static instances = new Set<TestBroadcastChannel>()
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: unknown[] = []
  constructor(readonly name: string) { TestBroadcastChannel.instances.add(this) }
  postMessage(data: unknown): void { this.sent.push(data) }
  close(): void { TestBroadcastChannel.instances.delete(this) }
}

type WorkerLike = {
  state: string
  messages: unknown[]
  addEventListener: (type: string, listener: Listener) => void
  replies: { type: string; port: TestPort }[]
  postMessage: (message: unknown, ports?: TestPort[]) => void
}

type RegistrationLike = {
  scope: string
  active: WorkerLike | null
  waiting: WorkerLike | null
  installing: WorkerLike | null
  addEventListener: (type: string, listener: Listener) => void
  removeEventListener: (type: string, listener: Listener) => void
}

type PwaModule = {
  readonly pwaState: PwaState
  registerPwa(callbacks?: PwaLifecycleCallbacks): Promise<RegistrationLike | null>
  setReloadSafetyProvider(provider: ReloadSafetyProvider | null): void
  requestPwaUpdate(): Promise<boolean>
  retryServerConnection(): Promise<boolean>
}

type PwaHarness = {
  readonly module: PwaModule
  readonly windowHub: EventHub
  readonly workerHub: EventHub
  readonly caches: MemoryCaches
  readonly activeWorker: WorkerLike
  readonly registration: RegistrationLike
  readonly container: { controller: WorkerLike | null }
  readonly registerCalls: unknown[][]
  readonly fetchCalls: string[]
  setRegisterImplementation(implementation: () => Promise<RegistrationLike>): void
  setFetchImplementation(implementation: () => Promise<Response>): void
  sendWorkerMessage(data: unknown, source?: WorkerLike): void
  restore(): void
}

let importSequence = 0

const defineGlobal = (name: string, value: unknown, originals: Map<string, PropertyDescriptor | undefined>): void => {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

const shell = (release: string): Response => new Response(`<!doctype html><head><meta name="tsepistle-pwa-release" content="${release}"></head>`, {
  headers: { 'Content-Type': 'text/html' }
})

const createWorker = (hub: EventHub): WorkerLike => {
  const worker: WorkerLike = {
    state: 'activated',
    messages: [],
    replies: [],
    addEventListener: hub.addEventListener.bind(hub),
    postMessage(message: unknown, ports: TestPort[] = []) {
      worker.messages.push(message)
      const envelope = message as { message: { type: string } }
      if (ports[0]) worker.replies.push({ type: envelope.message.type, port: ports[0] })
    }
  }
  return worker
}

const createHarness = async (mode: 'feature' | 'retirement' = 'feature'): Promise<PwaHarness> => {
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const windowHub = new EventHub()
  const workerHub = new EventHub()
  const caches = new MemoryCaches()
  const activeWorker = createWorker(new EventHub())
  const registration: RegistrationLike = {
    scope: `${ORIGIN}/`,
    active: activeWorker,
    waiting: null,
    installing: null,
    addEventListener: workerHub.addEventListener.bind(workerHub),
    removeEventListener: workerHub.removeEventListener.bind(workerHub)
  }
  const registerCalls: unknown[][] = []
  const fetchCalls: string[] = []
  let fetchImplementation = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  let registerImplementation = async (): Promise<RegistrationLike> => registration
  const container = {
    controller: activeWorker as WorkerLike | null,
    register: async (...args: unknown[]) => {
      registerCalls.push(args)
      return await registerImplementation()
    },
    addEventListener: workerHub.addEventListener.bind(workerHub),
    removeEventListener: workerHub.removeEventListener.bind(workerHub)
  }
  const document = {
    createElement: () => ({}),
    readyState: 'complete',
    querySelector: (selector: string) =>
      mode === 'retirement' && selector === 'meta[name="tsepistle-pwa-mode"]'
        ? { getAttribute: () => 'retirement' }
        : null,
    addEventListener: (_type: string, _listener: Listener) => undefined,
    removeEventListener: (_type: string, _listener: Listener) => undefined
  }
  const window = {
    location: { origin: ORIGIN, href: `${ORIGIN}/` },
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    fetch: async (input: string) => {
      fetchCalls.push(input)
      return await fetchImplementation()
    },
    addEventListener: windowHub.addEventListener.bind(windowHub),
    removeEventListener: windowHub.removeEventListener.bind(windowHub)
  }
  const navigator = { onLine: true, serviceWorker: container }
  defineGlobal('window', window, originals)
  defineGlobal('document', document, originals)
  defineGlobal('navigator', navigator, originals)
  defineGlobal('caches', caches, originals)
  defineGlobal('MessageChannel', TestMessageChannel, originals)
  defineGlobal('BroadcastChannel', TestBroadcastChannel, originals)
  const module = await vi.importFresh<PwaModule>(`../helpers/pwa.ts?lifecycle=${importSequence++}`, import.meta.url)
  return {
    module,
    windowHub,
    workerHub,
    caches,
    activeWorker,
    registration,
    container,
    registerCalls,
    fetchCalls,
    setFetchImplementation(implementation) { fetchImplementation = implementation },
    setRegisterImplementation(implementation) {
      registerImplementation = implementation
    },
    sendWorkerMessage(data, source = activeWorker) {
      const readiness = (data as { type: string }).type.startsWith('PWA_OFFLINE_')
      const matches = (reply: { type: string; port: TestPort }) => !reply.port.peer.closed &&
        (readiness ? reply.type === 'PWA_OFFLINE_READY_REQUEST' : reply.type === 'PWA_CONNECT')
      if (!source.replies.some(matches) && (source === registration.active || source === container.controller || source === registration.waiting)) {
        const waiting = registration.waiting
        registration.waiting = source
        windowHub.emit('pageshow')
        registration.waiting = waiting
      }
      source.replies.findLast(matches)?.port.postMessage(data)
    },
    restore() {
      windowHub.emit('pagehide')
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  }
}

const readyMessage = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'PWA_OFFLINE_READY',
  complete: true,
  release: RELEASE,
  manifestDigest: DIGEST,
  cacheName: CACHE_NAME,
  shellPath: '/_offline',
  markerURL: MARKER_URL,
  ...overrides
})

describe('PWA helper lifecycle', () => {
  it('uses the new envelope and drops pending replies across pagehide and BFCache restoration', async () => {
    const harness = await createHarness()
    try {
      await harness.module.registerPwa()
      expect(harness.activeWorker.messages.length).toBeGreaterThan(0)
      expect(harness.activeWorker.messages.every(message => (message as { type: string }).type === 'PWA_PORT_REQUEST')).toBe(true)
      const oldPorts = harness.activeWorker.replies.map(reply => reply.port)
      harness.windowHub.emit('pagehide', { persisted: true })
      expect(oldPorts.every(port => port.peer.closed)).toBe(true)
      expect(TestBroadcastChannel.instances.size).toBe(0)
      for (const port of oldPorts) port.postMessage(readyMessage())
      harness.workerHub.emit('message', { source: harness.activeWorker, data: readyMessage() })
      expect(harness.module.pwaState.offlineReady).toBe(false)

      const cache = await harness.caches.open(CACHE_NAME)
      await cache.put(SHELL_URL, shell(RELEASE))
      await cache.put(MARKER_URL, new Response(JSON.stringify({ release: RELEASE, manifestDigest: DIGEST, cacheName: CACHE_NAME })))
      harness.windowHub.emit('pageshow', { persisted: true })
      expect(TestBroadcastChannel.instances.size).toBe(1)
      harness.sendWorkerMessage(readyMessage())
      await vi.waitFor(() => expect(harness.module.pwaState.offlineReady).toBe(true))
    } finally { harness.restore() }
  })

  it('uses wakeups only to reconnect the known waiting worker and bounds an unanswered preparation', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    try {
      await harness.module.registerPwa()
      const waiting = createWorker(new EventHub())
      harness.registration.waiting = waiting
      const wakeup = [...TestBroadcastChannel.instances][0]!
      wakeup.onmessage?.({ data: { type: 'PWA_UPDATE_ACTIVATED', workerId: 'forged' } })
      expect(waiting.messages).toHaveLength(0)
      wakeup.onmessage?.({ data: 'connect' })
      expect(waiting.messages.at(-1)).toMatchObject({ type: 'PWA_PORT_REQUEST', message: { type: 'PWA_CONNECT' } })
      expect(harness.module.pwaState.preparation).not.toBe('activated')
      await harness.module.requestPwaUpdate()
      expect(wakeup.sent).toEqual(['connect'])
      expect(waiting.messages.at(-1)).toMatchObject({ type: 'PWA_PORT_REQUEST', message: { type: 'PWA_PREPARE_UPDATE' } })
      await vi.advanceTimersByTimeAsync(20_001)
      expect(harness.module.pwaState.preparation).toBe('deferred')
      expect(harness.module.pwaState.preparationReason).toContain('Retry')
    } finally { harness.restore(); vi.useRealTimers() }
  })

  it('cancels an old async safety response when its update port is replaced', async () => {
    const harness = await createHarness()
    try {
      await harness.module.registerPwa()
      const waiting = createWorker(new EventHub())
      harness.registration.waiting = waiting
      let finish!: (value: { safe: boolean; revision: string }) => void
      const pending = new Promise<{ safe: boolean; revision: string }>(resolve => { finish = resolve })
      harness.module.setReloadSafetyProvider(() => pending)
      harness.windowHub.emit('pageshow')
      const old = waiting.replies.findLast(reply => reply.type === 'PWA_CONNECT')!.port
      old.postMessage({ type: 'PWA_RELOAD_SAFETY_REQUEST', workerId: 'worker', release: RELEASE, roundNonce: 'round' })
      harness.windowHub.emit('pageshow')
      finish({ safe: true, revision: 'old-clean' })
      await Promise.resolve()
      await Promise.resolve()
      expect(waiting.messages.some(message => (message as { message: { type: string } }).message.type === 'PWA_RELOAD_SAFETY')).toBe(false)
      expect(old.peer.closed).toBe(true)
    } finally { harness.restore() }
  })

  it('probes an initially online server during registration without browser online events or explicit Retry', async () => {
    const harness = await createHarness()
    try {
      expect(harness.module.pwaState.connectionState).toBe('checking')
      await harness.module.registerPwa()

      await vi.waitFor(() => expect(harness.module.pwaState.connectionState).toBe('online'))
      expect(harness.module.pwaState.serverReachable).toBe(true)
      expect(harness.module.pwaState.serverHealthy).toBe(true)
      expect(harness.fetchCalls).toEqual(['/healthz'])
    } finally {
      harness.restore()
    }
  })

  it('does not repeat the automatic initial health probe on repeated registration calls', async () => {
    const harness = await createHarness()
    try {
      await harness.module.registerPwa()
      await vi.waitFor(() => expect(harness.module.pwaState.connectionState).toBe('online'))
      expect(harness.fetchCalls).toEqual(['/healthz'])

      await harness.module.registerPwa()
      expect(harness.fetchCalls).toEqual(['/healthz'])
    } finally {
      harness.restore()
    }
  })

  it('allows an explicit Retry after an initial registration failure', async () => {
    const harness = await createHarness()
    try {
      let attempts = 0
      harness.setRegisterImplementation(async () => {
        attempts += 1
        if (attempts === 1) throw new Error('initial registration failed')
        return harness.registration
      })
      const onError = vi.fn()
      const first = await harness.module.registerPwa({ onError })
      expect(first).toBeNull()
      expect(harness.module.pwaState.registrationState).toBe('error')
      expect(harness.module.pwaState.registrationError).toBe('initial registration failed')
      expect(onError).toHaveBeenCalledTimes(1)

      const second = await harness.module.registerPwa()
      expect(second).toBe(harness.registration)
      expect(harness.registerCalls).toHaveLength(2)
      expect(harness.module.pwaState.registrationState).toBe('registered')
      expect(harness.module.pwaState.registrationError).toBeNull()
    } finally {
      harness.restore()
    }
  })

  it('observes an initial installing worker that becomes redundant so Retry can recover', async () => {
    const harness = await createHarness()
    const installingHub = new EventHub()
    const failedWorker = createWorker(installingHub)
    harness.registration.active = null
    harness.container.controller = null
    harness.registration.installing = failedWorker
    try {
      const first = await harness.module.registerPwa()
      expect(first).toBe(harness.registration)
      failedWorker.state = 'redundant'
      installingHub.emit('statechange')
      expect(harness.module.pwaState.registrationState).toBe('error')
      expect(harness.module.pwaState.registrationError).toContain('installation became redundant')

      harness.registration.active = harness.activeWorker
      harness.container.controller = harness.activeWorker
      const second = await harness.module.registerPwa()
      expect(second).toBe(harness.registration)
      expect(harness.module.pwaState.registrationState).toBe('registered')
    } finally {
      harness.restore()
    }
  })

  it('requires a verified acknowledged shell cache before advertising offline readiness', async () => {
    const harness = await createHarness()
    try {
      const onOfflineReady = vi.fn()
      await harness.module.registerPwa({ onOfflineReady })
      expect(harness.module.pwaState.offlineReady).toBe(false)
      expect(harness.module.pwaState.offlineReadiness).toBe('checking')

      // An acknowledgement with no cache is not sufficient.
      harness.sendWorkerMessage(readyMessage())
      await vi.waitFor(() => expect(harness.module.pwaState.offlineReadiness).toBe('unavailable'))
      expect(onOfflineReady).not.toHaveBeenCalled()

      const cache = await harness.caches.open(CACHE_NAME)
      await cache.put(SHELL_URL, shell('release-b'))
      await cache.put(MARKER_URL, new Response(JSON.stringify({ release: RELEASE, manifestDigest: DIGEST, cacheName: CACHE_NAME })))
      harness.sendWorkerMessage(readyMessage())
      await vi.waitFor(() => expect(harness.module.pwaState.offlineReadiness).toBe('unavailable'))
      expect(onOfflineReady).not.toHaveBeenCalled()

      await cache.put(SHELL_URL, shell(RELEASE))
      harness.sendWorkerMessage(readyMessage())
      await vi.waitFor(() => expect(harness.module.pwaState.offlineReadiness).toBe('ready'))
      expect(harness.module.pwaState.offlineReady).toBe(true)
      expect(harness.module.pwaState.offlineReadyRelease).toBe(RELEASE)
      expect(harness.module.pwaState.offlineReadyManifestDigest).toBe(DIGEST)
      expect(onOfflineReady).toHaveBeenCalledTimes(1)

      // Eviction makes readiness unavailable again even though registration remains active.
      cache.entries.clear()
      harness.sendWorkerMessage(readyMessage())
      await vi.waitFor(() => expect(harness.module.pwaState.offlineReadiness).toBe('unavailable'))
      expect(harness.module.pwaState.offlineReady).toBe(false)
    } finally {
      harness.restore()
    }
  })

  it('defers an activated update while unsafe and reloads once after a fresh safe revision', async () => {
    const harness = await createHarness()
    try {
      const onNeedReload = vi.fn()
      await harness.module.registerPwa({ onNeedReload })
      harness.module.setReloadSafetyProvider(() => ({ safe: false, revision: 'dirty-revision', actorEpoch: 'actor-1' }))
      const activation = {
        workerId: 'worker-1',
        release: RELEASE,
        roundNonce: 'round-1'
      }
      harness.sendWorkerMessage({ type: 'PWA_UPDATE_PREPARING', ...activation, phase: 'activating' })
      harness.sendWorkerMessage({ type: 'PWA_UPDATE_ACTIVATED', ...activation })
      await vi.waitFor(() => expect(harness.module.pwaState.reloadSafe).toBe(false))
      expect(harness.module.pwaState.reloadNeeded).toBe(true)
      expect(onNeedReload).not.toHaveBeenCalled()

      harness.module.setReloadSafetyProvider(() => ({ safe: true, revision: 'clean-revision', actorEpoch: 'actor-2' }))
      await vi.waitFor(() => expect(onNeedReload).toHaveBeenCalledTimes(1))
      expect(harness.module.pwaState.reloadSafe).toBe(true)
      expect(harness.module.pwaState.safetyRevision).toBe('clean-revision')

    } finally {
      harness.restore()
    }
  })
  it('reloads a safe document at most once for duplicate activation messages', async () => {
    const harness = await createHarness()
    try {
      const onNeedReload = vi.fn()
      await harness.module.registerPwa({ onNeedReload })
      harness.module.setReloadSafetyProvider(() => ({ safe: true, revision: 'stable-revision', actorEpoch: 'actor-1' }))
      const activation = {
        workerId: 'worker-1',
        release: RELEASE,
        roundNonce: 'round-1'
      }
      harness.sendWorkerMessage({ type: 'PWA_UPDATE_PREPARING', ...activation, phase: 'activating' })
      harness.sendWorkerMessage({ type: 'PWA_UPDATE_PREPARING', ...activation, phase: 'activating' })
      harness.sendWorkerMessage({ type: 'PWA_UPDATE_ACTIVATED', ...activation })
      harness.sendWorkerMessage({ type: 'PWA_UPDATE_ACTIVATED', ...activation })
      await vi.waitFor(() => expect(onNeedReload).toHaveBeenCalledTimes(1))
      expect(onNeedReload).toHaveBeenCalledTimes(1)
      expect(harness.module.pwaState.reloadNeeded).toBe(false)
      expect(harness.module.pwaState.reloadSafe).toBe(true)
      expect(harness.module.pwaState.safetyRevision).toBe('stable-revision')
    } finally {
      harness.restore()
    }
  })

  it('ignores an activation message from a replaced worker after restart', async () => {
    const harness = await createHarness()
    try {
      const onNeedReload = vi.fn()
      await harness.module.registerPwa({ onNeedReload })
      harness.module.setReloadSafetyProvider(() => ({ safe: true, revision: 'stable-revision' }))
      const previousWorker = harness.activeWorker
      const replacement = createWorker(new EventHub())
      harness.registration.active = replacement
      harness.container.controller = replacement
      harness.workerHub.emit('controllerchange')
      const activation = {
        workerId: 'worker-restarted',
        release: RELEASE,
        roundNonce: 'round-restarted'
      }

      harness.sendWorkerMessage({ type: 'PWA_UPDATE_ACTIVATED', ...activation }, previousWorker)
      expect(onNeedReload).not.toHaveBeenCalled()
      expect(harness.module.pwaState.reloadNeeded).toBe(false)

      harness.sendWorkerMessage({ type: 'PWA_UPDATE_ACTIVATED', ...activation }, replacement)
      await vi.waitFor(() => expect(onNeedReload).toHaveBeenCalledTimes(1))
      expect(onNeedReload).toHaveBeenCalledTimes(1)
    } finally {
      harness.restore()
    }
  })

  it('keeps a new unsafe document after skipWaiting until its current revision becomes safe', async () => {
    const harness = await createHarness()
    try {
      const onNeedReload = vi.fn()
      await harness.module.registerPwa({ onNeedReload })
      let snapshot = { safe: false, revision: 'dirty-revision-a' }
      harness.module.setReloadSafetyProvider(() => snapshot)
      const activation = {
        workerId: 'worker-1',
        release: RELEASE,
        roundNonce: 'round-1'
      }

      // A document opened after skipWaiting receives activation without voting in the frozen round.
      harness.sendWorkerMessage({ type: 'PWA_UPDATE_ACTIVATED', ...activation })
      await vi.waitFor(() => expect(harness.module.pwaState.reloadSafe).toBe(false))
      expect(harness.module.pwaState.reloadNeeded).toBe(true)
      expect(harness.module.pwaState.safetyRevision).toBe('dirty-revision-a')
      expect(onNeedReload).not.toHaveBeenCalled()

      snapshot = { safe: false, revision: 'dirty-revision-b' }
      harness.module.setReloadSafetyProvider(() => snapshot)
      await vi.waitFor(() => expect(harness.module.pwaState.safetyRevision).toBe('dirty-revision-b'))
      expect(harness.module.pwaState.reloadSafe).toBe(false)
      expect(harness.module.pwaState.reloadNeeded).toBe(true)
      expect(onNeedReload).not.toHaveBeenCalled()

      snapshot = { safe: true, revision: 'clean-revision' }
      harness.module.setReloadSafetyProvider(() => snapshot)
      await vi.waitFor(() => expect(onNeedReload).toHaveBeenCalledTimes(1))
      expect(harness.module.pwaState.reloadSafe).toBe(true)
      expect(harness.module.pwaState.reloadNeeded).toBe(false)
      expect(harness.module.pwaState.safetyRevision).toBe('clean-revision')
    } finally {
      harness.restore()
    }
  })

  it('suppresses registration in retirement mode', async () => {
    const harness = await createHarness('retirement')
    try {
      const registration = await harness.module.registerPwa()
      expect(registration).toBeNull()
      expect(harness.registerCalls).toHaveLength(0)
      expect(harness.module.pwaState.registrationState).toBe('unsupported')
      expect(harness.module.pwaState.offlineReadiness).toBe('unavailable')
    } finally {
      harness.restore()
    }
  })
})


describe('foreground connection recovery', () => {
  it('recovers from an unavailable server without requiring another browser online event', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    try {
      harness.setFetchImplementation(async () => { throw new Error('Network transition') })
      await harness.module.registerPwa()
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.module.pwaState.connectionState).toBe('server-unavailable')
      expect(harness.fetchCalls).toHaveLength(1)
      harness.setFetchImplementation(async () => new Response('{}', { status: 200 }))
      await vi.advanceTimersByTimeAsync(3_000)
      expect(harness.fetchCalls).toHaveLength(2)
      expect(harness.module.pwaState.connectionState).toBe('online')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(harness.fetchCalls).toHaveLength(2)
    } finally { harness.restore(); vi.useRealTimers() }
  })

  it('recovers while the browser still reports offline and keeps the offline UI during the probe', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    try {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
      harness.setFetchImplementation(async () => { throw new Error('Disconnected') })
      await harness.module.registerPwa()
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.module.pwaState.connectionState).toBe('offline')
      let finishProbe = (_response: Response): void => {}
      harness.setFetchImplementation(() => new Promise(resolve => { finishProbe = resolve }))
      await vi.advanceTimersByTimeAsync(3_000)
      expect(harness.fetchCalls).toHaveLength(2)
      expect(harness.module.pwaState.connectionState).toBe('offline')
      finishProbe(new Response('{}', { status: 200 }))
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.module.pwaState.onlineHint).toBe(false)
      expect(harness.module.pwaState.connectionState).toBe('online')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(harness.fetchCalls).toHaveLength(2)
    } finally { harness.restore(); vi.useRealTimers() }
  })

  it('backs off unsuccessful offline probes to a thirty-second cap without showing checking', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    try {
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
      const observedStates: string[] = []
      harness.setFetchImplementation(async () => {
        observedStates.push(harness.module.pwaState.connectionState)
        throw new Error('Disconnected')
      })
      await harness.module.registerPwa()
      await vi.advanceTimersByTimeAsync(0)
      let attempts = 1
      for (const delay of [3_000, 6_000, 12_000, 24_000, 30_000, 30_000]) {
        await vi.advanceTimersByTimeAsync(delay - 100)
        expect(harness.fetchCalls).toHaveLength(attempts)
        await vi.advanceTimersByTimeAsync(100)
        expect(harness.fetchCalls).toHaveLength(++attempts)
        expect(harness.module.pwaState.connectionState).toBe('offline')
      }
      expect(observedStates.slice(1)).toEqual(Array(6).fill('offline'))
    } finally { harness.restore(); vi.useRealTimers() }
  })

  it('allows immediate manual retry without switching the unavailable UI to checking', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    try {
      harness.setFetchImplementation(async () => new Response('{}', { status: 503 }))
      await harness.module.registerPwa()
      await vi.advanceTimersByTimeAsync(1)
      let finishProbe = (_response: Response): void => {}
      harness.setFetchImplementation(() => new Promise(resolve => { finishProbe = resolve }))
      const retry = harness.module.retryServerConnection()
      expect(harness.fetchCalls).toHaveLength(2)
      expect(harness.module.pwaState.connectionState).toBe('server-unavailable')
      finishProbe(new Response('{}', { status: 200 }))
      expect(await retry).toBe(true)
      expect(harness.module.pwaState.connectionState).toBe('online')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(harness.fetchCalls).toHaveLength(2)
    } finally { harness.restore(); vi.useRealTimers() }
  })

  it('suspends recovery while hidden or leaving the document and resumes when visible', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    try {
      harness.setFetchImplementation(async () => new Response('{}', { status: 503 }))
      await harness.module.registerPwa()
      await vi.advanceTimersByTimeAsync(1)
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      harness.windowHub.emit('visibilitychange')
      harness.windowHub.emit('online')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(harness.fetchCalls).toHaveLength(1)
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      harness.windowHub.emit('visibilitychange')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(harness.fetchCalls).toHaveLength(2)
      harness.windowHub.emit('pagehide')
      harness.windowHub.emit('online')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(harness.fetchCalls).toHaveLength(2)
      harness.windowHub.emit('pageshow')
      await vi.advanceTimersByTimeAsync(6_000)
      expect(harness.fetchCalls).toHaveLength(3)
    } finally { harness.restore(); vi.useRealTimers() }
  })

  it('fences a pending probe on suspension so its late success cannot restore a hidden app', async () => {
    vi.useFakeTimers()
    const harness = await createHarness()
    try {
      harness.setFetchImplementation(async () => { throw new Error('Disconnected') })
      await harness.module.registerPwa()
      await vi.advanceTimersByTimeAsync(1)
      let finishProbe = (_response: Response): void => {}
      harness.setFetchImplementation(() => new Promise(resolve => { finishProbe = resolve }))
      await vi.advanceTimersByTimeAsync(3_000)
      harness.windowHub.emit('pagehide')
      finishProbe(new Response('{}', { status: 200 }))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(harness.module.pwaState.connectionState).toBe('server-unavailable')
      expect(harness.fetchCalls).toHaveLength(2)
      harness.setFetchImplementation(async () => new Response('{}', { status: 200 }))
      harness.windowHub.emit('pageshow')
      await vi.advanceTimersByTimeAsync(6_000)
      expect(harness.module.pwaState.connectionState).toBe('online')
      expect(harness.fetchCalls).toHaveLength(3)
    } finally { harness.restore(); vi.useRealTimers() }
  })
})
