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

type WorkerLike = {
  state: string
  messages: unknown[]
  addEventListener: (type: string, listener: Listener) => void
  postMessage: (message: unknown) => void
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
    addEventListener: hub.addEventListener.bind(hub),
    postMessage(message: unknown) {
      worker.messages.push(message)
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
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    },
    addEventListener: windowHub.addEventListener.bind(windowHub),
    removeEventListener: windowHub.removeEventListener.bind(windowHub)
  }
  const navigator = { onLine: true, serviceWorker: container }
  defineGlobal('window', window, originals)
  defineGlobal('document', document, originals)
  defineGlobal('navigator', navigator, originals)
  defineGlobal('caches', caches, originals)
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
    setRegisterImplementation(implementation) {
      registerImplementation = implementation
    },
    sendWorkerMessage(data, source = activeWorker) {
      workerHub.emit('message', { data, source })
    },
    restore() {
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
