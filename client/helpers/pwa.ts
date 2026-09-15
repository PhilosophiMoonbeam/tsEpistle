import { reactive, readonly } from 'vue'

const SERVICE_WORKER_PATH = '/sw.js'
const SERVICE_WORKER_SCOPE = '/'
const SERVER_PROBE_PATH = '/healthz'
const RELOAD_SAFETY_MESSAGE = 'PWA_RELOAD_SAFETY'
const RELOAD_SAFETY_REQUEST_MESSAGE = 'PWA_RELOAD_SAFETY_REQUEST'
const ACTIVATE_UPDATE_MESSAGE = 'PWA_ACTIVATE_UPDATE'
const ACTIVATED_UPDATE_MESSAGE = 'PWA_UPDATE_ACTIVATED'
const PWA_CHANNEL_NAME = 'tsepistle-pwa'
const INSTALL_EVENT = 'beforeinstallprompt'
const INSTALLED_EVENT = 'appinstalled'

type ServiceWorkerMessageTarget = Pick<ServiceWorker, 'postMessage'>
type InstallChoice = { outcome: 'accepted' | 'dismissed' }

export type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>
  userChoice: Promise<InstallChoice>
}

export type PwaConnectionState = 'checking' | 'online' | 'offline' | 'server-unavailable'
export type PwaRegistrationState = 'unsupported' | 'idle' | 'registering' | 'registered' | 'ready' | 'error'
export type PwaUpdateState = 'idle' | 'checking' | 'ready' | 'activating' | 'activated' | 'error'
export type PwaInstallAvailability = 'unavailable' | 'available' | 'installed'
export type ReloadSafetyProvider = () => boolean | Promise<boolean>

export type PwaLifecycleCallbacks = {
  onReady?: (registration: ServiceWorkerRegistration) => void
  onOfflineReady?: (registration: ServiceWorkerRegistration) => void
  onUpdateReady?: (registration: ServiceWorkerRegistration) => void
  onNeedReload?: () => void
  onError?: (error: unknown) => void
}

export type PwaState = {
  readonly connection: PwaConnectionState
  readonly connectionState: PwaConnectionState
  readonly onlineHint: boolean | null
  readonly serverReachable: boolean | null
  readonly serverHealthy: boolean | null
  readonly lastProbeAt: number | null
  readonly registration: ServiceWorkerRegistration | null
  readonly registrationState: PwaRegistrationState
  readonly registrationError: string | null
  readonly controller: ServiceWorker | null
  readonly controlled: boolean
  readonly offlineReady: boolean
  readonly updateState: PwaUpdateState
  readonly updateReady: boolean
  readonly updateError: string | null
  readonly reloadNeeded: boolean
  readonly reloadSafe: boolean | null
  readonly installAvailability: PwaInstallAvailability
  readonly installPromptAvailable: boolean
  readonly installed: boolean
  readonly installError: string | null
  readonly isStandalone: boolean
  readonly error: string | null
}

type MutablePwaState = {
  -readonly [K in keyof PwaState]: PwaState[K]
}

const state = reactive<MutablePwaState>({
  connection: 'checking',
  connectionState: 'checking',
  onlineHint: typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
  serverReachable: null,
  serverHealthy: null,
  lastProbeAt: null,
  registration: null,
  registrationState: 'idle',
  registrationError: null,
  controller: null,
  controlled: false,
  offlineReady: false,
  updateState: 'idle',
  updateReady: false,
  updateError: null,
  reloadNeeded: false,
  reloadSafe: null,
  installAvailability: 'unavailable',
  installPromptAvailable: false,
  installed: false,
  installError: null,
  isStandalone: false,
  error: null
})

// `readonly(reactive(...))` gives consumers one stable, reactive, mutation-safe view.
export const pwaState: Readonly<PwaState> = readonly(state)

let installPrompt: BeforeInstallPromptEvent | null = null
let installListenersAttached = false
let serviceWorkerListenersAttached = false
let registrationPromise: Promise<ServiceWorkerRegistration | null> | undefined
let registrationReference: ServiceWorkerRegistration | null = null
let activeController: ServiceWorker | null = null
let safetyProvider: ReloadSafetyProvider = () => true
let safetySequence = 0
let probePromise: Promise<boolean> | undefined
let updateRequestInFlight: Promise<boolean> | undefined
let channel: BroadcastChannel | null = null
let callbackSet: PwaLifecycleCallbacks = {}
let observedWaitingWorker: ServiceWorker | null = null
let observedInstallingWorker: ServiceWorker | null = null
type AcceptedActivation = {
  nonce: string
  worker: ServiceWorker | null
  activatedWorker: ServiceWorker | null
}

let acceptedActivation: AcceptedActivation | null = null
let deferredReloadWorker: ServiceWorker | null = null
const reloadRequestedWorkers = new WeakSet<ServiceWorker>()
let readyNotified = false
let updateReadyWorker: ServiceWorker | null = null

const hasWindow = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined'
const hasNavigator = (): boolean => typeof navigator !== 'undefined'

const errorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

const standaloneDisplay = (): boolean => {
  if (!hasWindow() || !hasNavigator()) return false
  const mediaStandalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean }
  return mediaStandalone || navigatorWithStandalone.standalone === true
}

const setConnection = (connection: PwaConnectionState): void => {
  state.connection = connection
  state.connectionState = connection
}

const notifyError = (error: unknown): void => {
  try {
    callbackSet.onError?.(error)
  } catch {
    // Lifecycle callbacks are observers and must not break registration.
  }
}

const notifyReady = (registration: ServiceWorkerRegistration): void => {
  if (readyNotified) return
  readyNotified = true
  try {
    callbackSet.onReady?.(registration)
  } catch {
    // Lifecycle callbacks are observers and must not break registration.
  }
}

const setRegistrationError = (error: unknown, fallback = 'Service worker registration failed.'): void => {
  const message = errorMessage(error, fallback)
  state.registrationState = 'error'
  state.registrationError = message
  state.error = message
  state.updateError = message
  state.updateState = 'error'
  notifyError(error)
}

const currentServiceWorkerContainer = (): ServiceWorkerContainer | null => {
  if (!hasNavigator()) return null
  const candidate = navigator.serviceWorker
  return candidate && typeof candidate.register === 'function' ? candidate : null
}

const workerTargets = (registration: ServiceWorkerRegistration | null): ServiceWorkerMessageTarget[] => {
  const targets: ServiceWorkerMessageTarget[] = []
  const seen = new Set<ServiceWorker>()
  const add = (worker: ServiceWorker | null | undefined): void => {
    if (!worker || seen.has(worker)) return
    seen.add(worker)
    targets.push(worker)
  }
  add(currentServiceWorkerContainer()?.controller)
  add(registration?.active)
  add(registration?.waiting)
  return targets
}

const postToWorkers = (message: unknown, registration = registrationReference): void => {
  for (const worker of workerTargets(registration)) {
    try {
      worker.postMessage(message)
    } catch {
      // A worker can become redundant between selecting it and posting. The
      // registration/controller events will provide the next opportunity.
    }
  }
}

const broadcast = (message: unknown): void => {
  try {
    channel?.postMessage(message)
  } catch {
    // BroadcastChannel is an optional coordination enhancement.
  }
}

const createActivationNonce = (): string => {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const noteAcceptedActivation = (nonce: unknown, worker?: ServiceWorker | null): void => {
  if (typeof nonce !== 'string' || nonce.length === 0) return
  const resolvedWorker = worker ?? registrationReference?.waiting ?? null
  if (acceptedActivation?.nonce === nonce) {
    if (!acceptedActivation.worker && resolvedWorker) acceptedActivation.worker = resolvedWorker
    return
  }
  acceptedActivation = { nonce, worker: resolvedWorker, activatedWorker: null }
  deferredReloadWorker = null
  state.updateReady = true
  state.updateState = 'activating'
}

const maybeReloadAcceptedWorker = async (worker: ServiceWorker): Promise<void> => {
  if (reloadRequestedWorkers.has(worker)) return
  deferredReloadWorker = worker
  let safe = false
  try {
    safe = (await safetyProvider()) === true
  } catch {
    safe = false
  }
  state.reloadSafe = safe
  if (!safe) {
    state.reloadNeeded = true
    return
  }
  const activation = acceptedActivation
  if (!activation || (activation.worker !== worker && activation.activatedWorker !== worker)) return
  reloadRequestedWorkers.add(worker)
  state.reloadNeeded = false
  try {
    callbackSet.onNeedReload?.()
  } catch {
    // Lifecycle callbacks are observers and must not break the update.
  }
}

const retryDeferredReload = (): void => {
  if (deferredReloadWorker) void maybeReloadAcceptedWorker(deferredReloadWorker)
}

const reportReloadSafety = async (nonce?: string, target?: ServiceWorkerMessageTarget | null): Promise<boolean> => {
  const sequence = ++safetySequence
  let safe = false
  try {
    safe = (await safetyProvider()) === true
  } catch {
    safe = false
  }
  if (sequence === safetySequence) state.reloadSafe = safe
  const message: { type: string; safe: boolean; nonce?: string } = { type: RELOAD_SAFETY_MESSAGE, safe }
  if (nonce) message.nonce = nonce
  if (target) {
    try {
      target.postMessage(message)
    } catch {
      // A worker can become redundant before the report is sent.
    }
  } else {
    postToWorkers(message)
  }
  broadcast(nonce ? { type: 'safety-report', safe, nonce } : { type: 'safety-report', safe })
  if (sequence === safetySequence) retryDeferredReload()
  return safe
}

const requestSafetyReports = (): void => {
  broadcast({ type: 'safety-request' })
  void reportReloadSafety()
  const activation = acceptedActivation
  if (activation && !activation.activatedWorker && activation.worker) {
    void reportReloadSafety(activation.nonce, activation.worker)
  }
}

const handleActivatedUpdate = (nonce: string, source: ServiceWorkerMessageTarget | null): void => {
  const sourceWorker = source as ServiceWorker | null
  let activation = acceptedActivation
  if (!activation || activation.nonce !== nonce) {
    const currentController = currentServiceWorkerContainer()?.controller ?? null
    if (!sourceWorker || !currentController || sourceWorker !== currentController) return
    noteAcceptedActivation(nonce, sourceWorker)
    activation = acceptedActivation
  }
  if (!activation) return
  const activatedWorker = sourceWorker ?? activation.worker ?? currentServiceWorkerContainer()?.controller ?? null
  if (!activatedWorker) return
  if (!activation.worker && sourceWorker) activation.worker = sourceWorker
  activation.activatedWorker = activatedWorker
  state.updateReady = false
  state.updateState = 'activated'
  state.reloadNeeded = true
  deferredReloadWorker = activatedWorker
  void maybeReloadAcceptedWorker(activatedWorker)
}

const markController = (controller: ServiceWorker | null): void => {
  const previous = activeController
  activeController = controller
  state.controller = controller
  state.controlled = controller !== null
  if (controller && !state.offlineReady && registrationReference) markOfflineReady(registrationReference)
  const activation = acceptedActivation
  const acceptedController = Boolean(controller && activation && (activation.worker === controller || activation.activatedWorker === controller))
  if (controller && previous && controller !== previous && acceptedController) {
    if (activation) activation.activatedWorker = controller
    state.reloadNeeded = true
    deferredReloadWorker = controller
    broadcast({ type: 'reload-needed', nonce: activation?.nonce })
    void maybeReloadAcceptedWorker(controller)
  }
  if (acceptedController && controller) {
    state.updateState = 'activated'
    state.updateReady = false
  }
  requestSafetyReports()
}

const markOfflineReady = (registration: ServiceWorkerRegistration): void => {
  if (state.offlineReady) return
  state.offlineReady = true
  state.registrationState = 'ready'
  try {
    callbackSet.onOfflineReady?.(registration)
  } catch {
    // Lifecycle callbacks are observers and must not break registration.
  }
}

const markUpdateReady = (registration: ServiceWorkerRegistration): void => {
  const waiting = registration.waiting
  if (!waiting) return
  if (acceptedActivation?.worker === null) acceptedActivation.worker = waiting
  const activationPending = acceptedActivation !== null && acceptedActivation.worker === waiting && !acceptedActivation.activatedWorker
  state.updateReady = true
  state.updateState = activationPending ? 'activating' : 'ready'
  state.updateError = null
  if (updateReadyWorker === waiting) return
  updateReadyWorker = waiting
  try {
    callbackSet.onUpdateReady?.(registration)
  } catch {
    // Lifecycle callbacks are observers and must not break registration.
  }
  broadcast({ type: 'update-ready' })
  requestSafetyReports()
}

const observeWorker = (registration: ServiceWorkerRegistration, worker: ServiceWorker | null): void => {
  if (!worker || typeof worker.addEventListener !== 'function') return
  if (worker === observedInstallingWorker || worker === observedWaitingWorker) return
  if (worker.state === 'installing') observedInstallingWorker = worker
  if (worker.state === 'installed' || worker.state === 'activating' || worker.state === 'activated') observedWaitingWorker = worker
  worker.addEventListener('statechange', () => {
    const container = currentServiceWorkerContainer()
    if (worker.state === 'installed') {
      if (container?.controller) markUpdateReady(registration)
      else markOfflineReady(registration)
      return
    }
    if (worker.state === 'activating') {
      state.updateState = 'activating'
      return
    }
    if (worker.state === 'activated') {
      markOfflineReady(registration)
      markController(container?.controller ?? null)
      return
    }
    if (worker.state === 'redundant' && state.updateState === 'activating') {
      state.updateState = 'error'
      state.updateError = 'The service worker update became redundant before activation.'
    }
  })
}

const attachRegistrationListeners = (registration: ServiceWorkerRegistration): void => {
  if (typeof registration.addEventListener === 'function') {
    registration.addEventListener('updatefound', () => {
      observeWorker(registration, registration.installing)
      state.updateError = null
      state.updateState = 'checking'
    })
  }
  observeWorker(registration, registration.installing)
  observeWorker(registration, registration.waiting)
  if (registration.waiting) markUpdateReady(registration)
  if (registration.active) {
    markOfflineReady(registration)
    state.registrationState = 'ready'
  }
}

const attachServiceWorkerListeners = (): void => {
  if (serviceWorkerListenersAttached) return
  const container = currentServiceWorkerContainer()
  if (!container) return
  serviceWorkerListenersAttached = true
  if (typeof container.addEventListener === 'function') {
    container.addEventListener('controllerchange', () => markController(container.controller ?? null))
    container.addEventListener('message', event => {
      const messageEvent = event as MessageEvent
      if (typeof messageEvent.data !== 'object' || messageEvent.data === null) return
      const message = messageEvent.data as { type?: unknown; nonce?: unknown }
      const sourceCandidate = messageEvent.source
      const source = sourceCandidate && typeof sourceCandidate.postMessage === 'function' ? (sourceCandidate as ServiceWorkerMessageTarget) : null
      if (message.type === RELOAD_SAFETY_REQUEST_MESSAGE && typeof message.nonce === 'string' && message.nonce.length > 0) {
        noteAcceptedActivation(message.nonce, source as ServiceWorker | null)
        void reportReloadSafety(message.nonce, source)
        return
      }
      if (message.type === ACTIVATED_UPDATE_MESSAGE && typeof message.nonce === 'string' && message.nonce.length > 0) {
        handleActivatedUpdate(message.nonce, source)
      }
    })
  }
  const ready = container.ready
  if (!ready || typeof ready.then !== 'function') return
  void ready
    .then(registration => {
      if (registrationReference && registration !== registrationReference) return
      registrationReference = registration
      state.registration = registration
      markOfflineReady(registration)
      markController(container.controller ?? null)
      if (registration.waiting) markUpdateReady(registration)
      notifyReady(registration)
    })
    .catch(() => {
      // Registration errors are reported by register(); `ready` can also
      // reject when a browser tears down its service-worker context.
    })
}

const ensureChannel = (): void => {
  if (channel || typeof BroadcastChannel === 'undefined') return
  try {
    channel = new BroadcastChannel(PWA_CHANNEL_NAME)
    channel.addEventListener('message', event => {
      const message = event.data as { type?: unknown; nonce?: unknown }
      if (message.type === 'safety-request') {
        void reportReloadSafety()
        return
      }
      if (message.type === 'activate-update' && typeof message.nonce === 'string' && message.nonce.length > 0) {
        noteAcceptedActivation(message.nonce)
        void reportReloadSafety(message.nonce, acceptedActivation?.worker)
      }
    })
  } catch {
    channel = null
  }
}

const captureInstallPrompt = (event: Event): void => {
  const promptEvent = event as BeforeInstallPromptEvent
  if (typeof promptEvent.prompt !== 'function' || !promptEvent.userChoice) return
  event.preventDefault()
  installPrompt = promptEvent
  state.installAvailability = 'available'
  state.installPromptAvailable = true
  state.installError = null
}

const markInstalled = (): void => {
  installPrompt = null
  state.installAvailability = 'installed'
  state.installPromptAvailable = false
  state.installed = true
  state.installError = null
}

const handleOnlineHint = (): void => {
  state.onlineHint = true
  void retryServerConnection()
}

const handleOfflineHint = (): void => {
  state.onlineHint = false
  state.serverReachable = null
  state.serverHealthy = null
  setConnection('offline')
}

const attachWindowListeners = (): void => {
  if (!hasWindow() || installListenersAttached) return
  installListenersAttached = true
  state.isStandalone = standaloneDisplay()
  state.installed = state.isStandalone
  if (state.isStandalone) state.installAvailability = 'installed'
  window.addEventListener(INSTALL_EVENT, captureInstallPrompt as EventListener)
  window.addEventListener(INSTALLED_EVENT, markInstalled as EventListener)
  window.addEventListener('online', handleOnlineHint)
  window.addEventListener('offline', handleOfflineHint)
}

const registerNow = async (): Promise<ServiceWorkerRegistration | null> => {
  attachWindowListeners()
  ensureChannel()
  const container = currentServiceWorkerContainer()
  if (!container) {
    state.registrationState = 'unsupported'
    return null
  }
  state.registrationState = 'registering'
  state.error = null
  state.registrationError = null
  try {
    const registration = await container.register(SERVICE_WORKER_PATH, { scope: SERVICE_WORKER_SCOPE })
    registrationReference = registration
    state.registration = registration
    state.registrationState = 'registered'
    attachServiceWorkerListeners()
    attachRegistrationListeners(registration)
    markController(container.controller ?? null)
    if (registration.waiting) markUpdateReady(registration)
    if (registration.active) markOfflineReady(registration)
    notifyReady(registration)
    return registration
  } catch (error) {
    setRegistrationError(error)
    return null
  }
}

export function registerPwa(callbacks: PwaLifecycleCallbacks = {}): Promise<ServiceWorkerRegistration | null> {
  callbackSet = { ...callbackSet, ...callbacks }
  attachWindowListeners()
  ensureChannel()
  if (!registrationPromise) {
    const schedule = (): Promise<ServiceWorkerRegistration | null> => {
      if (!hasWindow() || document.readyState !== 'loading') return registerNow()
      let resolveRegistration!: (registration: ServiceWorkerRegistration | null) => void
      const promise = new Promise<ServiceWorkerRegistration | null>(resolve => {
        resolveRegistration = resolve
      })
      document.addEventListener(
        'DOMContentLoaded',
        () => {
          void registerNow().then(resolveRegistration)
        },
        { once: true }
      )
      return promise
    }
    registrationPromise = schedule()
    void registrationPromise.then(() => {
      if (state.serverReachable === null) void retryServerConnection()
    })
  }
  return registrationPromise
}

export async function retryServerConnection(): Promise<boolean> {
  if (probePromise) return probePromise
  if (!hasWindow() || !hasNavigator()) {
    state.serverReachable = null
    state.serverHealthy = null
    setConnection('server-unavailable')
    return false
  }
  state.onlineHint = navigator.onLine
  setConnection('checking')
  probePromise = (async () => {
    try {
      const response = await window.fetch(SERVER_PROBE_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      })
      state.lastProbeAt = Date.now()
      const responseUrl = typeof response.url === 'string' && response.url ? new URL(response.url, window.location.href) : null
      const sameOrigin = !responseUrl || responseUrl.origin === window.location.origin
      state.serverReachable = sameOrigin
      state.serverHealthy = sameOrigin && response.ok
      if (sameOrigin && response.ok) {
        setConnection('online')
        return true
      }
      setConnection('server-unavailable')
      return false
    } catch {
      state.lastProbeAt = Date.now()
      state.serverReachable = false
      state.serverHealthy = false
      setConnection(state.onlineHint === false ? 'offline' : 'server-unavailable')
      return false
    } finally {
      probePromise = undefined
    }
  })()
  return probePromise
}

export async function promptPwaInstall(): Promise<InstallChoice['outcome'] | null> {
  const promptEvent = installPrompt
  if (!promptEvent || state.installed || state.installAvailability !== 'available') return null
  state.installError = null
  try {
    await promptEvent.prompt()
    const choice = await promptEvent.userChoice
    if (choice.outcome === 'accepted') {
      state.installAvailability = 'installed'
      state.installed = true
    }
    return choice.outcome
  } catch (error) {
    state.installError = errorMessage(error, 'The browser closed the install prompt.')
    return null
  } finally {
    installPrompt = null
    state.installPromptAvailable = false
  }
}

export function setReloadSafetyProvider(provider: ReloadSafetyProvider | null): void {
  safetySequence += 1
  safetyProvider = provider ?? (() => true)
  void reportReloadSafety()
  const activation = acceptedActivation
  if (activation && !activation.activatedWorker && activation.worker) {
    void reportReloadSafety(activation.nonce, activation.worker)
  }
  retryDeferredReload()
}

const requestUpdate = async (): Promise<boolean> => {
  const registration = await registerPwa()
  if (!registration) return false
  ensureChannel()
  state.updateError = null
  state.updateState = 'checking'
  const safe = await reportReloadSafety()
  if (!safe) {
    state.updateState = registration.waiting ? 'ready' : 'idle'
    if (registration.waiting) state.updateReady = true
    return false
  }
  let waiting = registration.waiting
  if (!waiting) {
    try {
      if (typeof registration.update !== 'function') {
        state.updateState = 'error'
        state.updateError = 'The browser cannot check for service worker updates.'
        return false
      }
      await registration.update()
    } catch (error) {
      state.updateState = 'error'
      state.updateError = errorMessage(error, 'The service worker update check failed.')
      notifyError(error)
      return false
    }
    waiting = registration.waiting
  }
  if (!waiting) {
    state.updateState = 'idle'
    return false
  }

  const nonce = createActivationNonce()
  noteAcceptedActivation(nonce, waiting)
  state.updateReady = true
  state.updateState = 'activating'
  try {
    waiting.postMessage({ type: ACTIVATE_UPDATE_MESSAGE, nonce })
  } catch {
    // Registration/state events provide the next opportunity to retry.
  }
  // The waiting worker retains this intent and requests fresh reports from
  // every scoped client before it calls skipWaiting().
  void reportReloadSafety(nonce, waiting)
  broadcast({ type: 'activate-update', nonce })
  return true
}

export function requestPwaUpdate(): Promise<boolean> {
  if (updateRequestInFlight) return updateRequestInFlight
  updateRequestInFlight = requestUpdate().finally(() => {
    updateRequestInFlight = undefined
  })
  return updateRequestInFlight
}

// Capture installability before registration starts as browsers can dispatch
// the event as soon as the document becomes interactive.
attachWindowListeners()

export const PWA_SERVICE_WORKER_PATH = SERVICE_WORKER_PATH
export const PWA_SERVICE_WORKER_SCOPE = SERVICE_WORKER_SCOPE
export const PWA_SERVER_PROBE_PATH = SERVER_PROBE_PATH
