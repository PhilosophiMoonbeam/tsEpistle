import { reactive, readonly, ref } from 'vue'
import { OFFLINE_DOCUMENT_PATH, isOwnedPrecacheCacheName } from './pwa-route-policy.ts'

const SERVICE_WORKER_PATH = '/sw.js'
const SERVICE_WORKER_SCOPE = '/'
const SERVER_PROBE_PATH = '/healthz'
const RELOAD_SAFETY_MESSAGE = 'PWA_RELOAD_SAFETY'
const RELOAD_SAFETY_REQUEST_MESSAGE = 'PWA_RELOAD_SAFETY_REQUEST'
const PREPARE_UPDATE_MESSAGE = 'PWA_PREPARE_UPDATE'
const UPDATE_PREPARING_MESSAGE = 'PWA_UPDATE_PREPARING'
const UPDATE_DEFERRED_MESSAGE = 'PWA_UPDATE_DEFERRED'
const UPDATE_ACTIVATING_MESSAGE = 'PWA_UPDATE_ACTIVATING'
const ACTIVATED_UPDATE_MESSAGE = 'PWA_UPDATE_ACTIVATED'
const OFFLINE_READY_MESSAGE = 'PWA_OFFLINE_READY'
const OFFLINE_NOT_READY_MESSAGE = 'PWA_OFFLINE_NOT_READY'
const RETIREMENT_NOTICE_MESSAGE = 'PWA_RETIREMENT_NOTICE'
const OFFLINE_READY_REQUEST_MESSAGE = 'PWA_OFFLINE_READY_REQUEST'
const INSTALL_EVENT = 'beforeinstallprompt'
const INSTALLED_EVENT = 'appinstalled'
const STARTUP_GATE_DEADLINE_MS = 8_000
const PROBE_DEADLINE_MS = 5_000
const WAITING_WORKER_DEADLINE_MS = 8_000
const RELEASE_PATTERN = /^[0-9a-f]{40}$/u

type ServiceWorkerMessageTarget = Pick<ServiceWorker, 'postMessage'>
export type PwaInstallOutcome = 'accepted' | 'dismissed'
type InstallChoice = { outcome: PwaInstallOutcome }
type PwaGlobal = typeof globalThis & {
  siteConfig?: { pwaMode?: unknown }
}

export type BeforeInstallPromptEvent = Event & {
  prompt(): Promise<void>
  userChoice: Promise<InstallChoice>
}

export type PwaMode = 'feature' | 'retirement'
export type PwaConnectionState = 'checking' | 'online' | 'offline' | 'server-unavailable'
export type PwaRegistrationState = 'unsupported' | 'idle' | 'registering' | 'registered' | 'ready' | 'error'
export type PwaUpdateState = 'idle' | 'checking' | 'ready' | 'activating' | 'activated' | 'error'
export type PwaPreparationState = 'idle' | 'checking' | 'collecting' | 'deferred' | 'activating' | 'activated' | 'error'
export type PwaOfflineReadinessState = 'unknown' | 'checking' | 'ready' | 'unavailable'
export type PwaInstallAvailability = 'unavailable' | 'available' | 'installed'

/** Complete facts used for a revision-bound worker safety vote. */
export interface ReloadSafetySnapshot {
  readonly safe: boolean
  readonly revision: string
  readonly actorEpoch?: string | number
}

export type ReloadSafetyProvider = () => ReloadSafetySnapshot | Promise<ReloadSafetySnapshot>

export type PwaLifecycleCallbacks = {
  onReady?: (registration: ServiceWorkerRegistration) => void
  onOfflineReady?: (registration: ServiceWorkerRegistration) => void
  onUpdateReady?: (registration: ServiceWorkerRegistration) => void
  onNeedReload?: () => void
  onError?: (error: unknown) => void
}

export type PwaState = {
  readonly mode: PwaMode
  readonly retirement: boolean
  readonly retirementNotice: boolean
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
  readonly offlineReadiness: PwaOfflineReadinessState
  readonly offlineReady: boolean
  readonly offlineReadyRelease: string | null
  readonly offlineReadyManifestDigest: string | null
  readonly workerRelease: string | null
  readonly updateState: PwaUpdateState
  readonly updateReady: boolean
  readonly updateError: string | null
  readonly preparation: PwaPreparationState
  readonly preparationReason: string | null
  readonly reloadNeeded: boolean
  readonly reloadSafe: boolean | null
  readonly safetyRevision: string | null
  readonly installAvailability: PwaInstallAvailability
  readonly installPromptAvailable: boolean
  readonly installAccepted: boolean
  readonly installOutcome: PwaInstallOutcome | null
  readonly appInstalled: boolean
  readonly installed: boolean
  readonly installError: string | null
  readonly isStandalone: boolean
  readonly error: string | null
}

type MutablePwaState = {
  -readonly [K in keyof PwaState]: PwaState[K]
}

const readPwaMode = (): PwaMode => {
  const globalConfig = (globalThis as PwaGlobal).siteConfig?.pwaMode
  const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="tsepistle-pwa-mode"]')?.getAttribute('content') : null
  const value = typeof meta === 'string' && meta.trim() ? meta.trim().toLowerCase() : globalConfig
  return value === 'retirement' ? 'retirement' : 'feature'
}

const configuredMode = readPwaMode()

/** The process-controlled mode captured by this document at bootstrap. */
export const currentPwaMode = (): PwaMode => configuredMode
const state = reactive<MutablePwaState>({
  mode: configuredMode,
  retirement: configuredMode === 'retirement',
  retirementNotice: configuredMode === 'retirement',
  connection: configuredMode === 'retirement' ? 'server-unavailable' : typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'checking',
  connectionState:
    configuredMode === 'retirement' ? 'server-unavailable' : typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'checking',
  onlineHint: typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
  serverReachable: null,
  serverHealthy: null,
  lastProbeAt: null,
  registration: null,
  registrationState: 'idle',
  registrationError: null,
  controller: null,
  controlled: false,
  offlineReadiness: configuredMode === 'retirement' ? 'unavailable' : 'unknown',
  offlineReady: false,
  offlineReadyRelease: null,
  offlineReadyManifestDigest: null,
  workerRelease: null,
  updateState: 'idle',
  updateReady: false,
  updateError: null,
  preparation: 'idle',
  preparationReason: null,
  reloadNeeded: false,
  reloadSafe: null,
  safetyRevision: null,
  installAvailability: 'unavailable',
  installPromptAvailable: false,
  installAccepted: false,
  installOutcome: null,
  appInstalled: false,
  installed: false,
  installError: null,
  isStandalone: false,
  error: null
})

// `readonly(reactive(...))` gives consumers one stable, reactive, mutation-safe view.
export const pwaState: Readonly<PwaState> = readonly(state)
export type PwaConnectionPresentation = {
  readonly label: string
  readonly tone: 'success' | 'warning' | 'error'
  readonly icon: string
}

type PwaConnectionPresentationState = Pick<PwaState, 'connection' | 'serverReachable' | 'serverHealthy'>

export const pwaConnectionPresentation = (currentState: PwaConnectionPresentationState): PwaConnectionPresentation => {
  if (currentState.connection === 'checking') {
    return { label: 'Checking connection…', tone: 'warning', icon: 'mdi-sync' }
  }
  if (currentState.connection === 'offline') {
    return { label: 'Offline', tone: 'error', icon: 'mdi-wifi-off' }
  }
  if (currentState.connection === 'server-unavailable') {
    return { label: 'Server unavailable', tone: 'error', icon: 'mdi-server-network-off' }
  }
  if (currentState.connection === 'online' && currentState.serverReachable === true && currentState.serverHealthy === true) {
    return { label: 'Connected', tone: 'success', icon: 'mdi-check-network-outline' }
  }
  return { label: 'Connection not verified', tone: 'warning', icon: 'mdi-help-network-outline' }
}

type PromptOffer = {
  event: BeforeInstallPromptEvent
  token: number
}

type AcceptedActivation = {
  nonce: string
  workerId: string
  release: string
  worker: ServiceWorker | null
  activatedWorker: ServiceWorker | null
}

type StartupWorkerIdentity = {
  readonly worker: ServiceWorker
  readonly release: string | null
}

type StartupGateContext = {
  readonly epoch: number
  readonly deadline: number
  readonly cancellations: Set<() => void>
  cancelled: boolean
}

type StartupWait<T> = { readonly kind: 'value'; readonly value: T } | { readonly kind: 'timeout' | 'cancelled' | 'error' }

type SafetyRequestContext = {
  workerId?: string
  release?: string
  roundNonce?: string
}

type ProbeAttempt = {
  epoch: number
  controller: AbortController
  promise: Promise<boolean>
}

let installPrompt: PromptOffer | null = null
let installOfferSequence = 0
let installPromptInFlight: Promise<InstallChoice['outcome'] | null> | undefined
let installListenersAttached = false
let serviceWorkerListenersAttached = false
let registrationInFlight: Promise<ServiceWorkerRegistration | null> | undefined
let initialConnectionProbeStarted = false
let registrationReference: ServiceWorkerRegistration | null = null
let activeController: ServiceWorker | null = null
let safetyProvider: ReloadSafetyProvider = () => ({ safe: true, revision: 'initial' })
let safetySequence = 0
let activeSafetyRequest: { target: ServiceWorkerMessageTarget; context: SafetyRequestContext } | null = null
let connectionEpoch = 0
let activeProbe: ProbeAttempt | undefined
let connectionRetryTimer: ReturnType<typeof setTimeout> | null = null
let connectionRetryDelay = 3_000
let preparationTimer: ReturnType<typeof setTimeout> | null = null
let updateReadyWorker: ServiceWorker | null = null
let updateRequestInFlight: Promise<boolean> | undefined
let callbackSet: PwaLifecycleCallbacks = {}
const observedWorkers = new WeakSet<ServiceWorker>()
let acceptedActivation: AcceptedActivation | null = null
let deferredReloadWorker: ServiceWorker | null = null
const reloadRequestedActivations = new Set<string>()
let readyNotified = false
let offlineReadinessEpoch = 0
let offlineReadyNotifiedRelease: string | null = null
let pageSuspended = false
let updateWakeups: BroadcastChannel | null = null
let startupGatePromise: Promise<'continue' | 'reloading'> | undefined
let startupGateEpoch = 0
let activeStartupGate: StartupGateContext | null = null
let startupGateActive = false
let startupDocumentRelease: string | null = null
let startupBundleRelease: string | null = null
let startupAutomaticRefreshDisabled = false
let startupExplicitRefreshAllowed = false
let startupReloadIssued = false
export const startupRefreshDeferred = ref(false)
const replyPorts = new Map<MessagePort, () => void>()
const startupActivationObservers = new Set<() => void>()
const startupWorkerReleases = new WeakMap<ServiceWorker, string>()
const offlineStartupInstallations = new WeakSet<ServiceWorker>()
const offlineStartupProbing = new WeakSet<ServiceWorker>()
const offlineStartupPrepared = new WeakSet<ServiceWorker>()
const offlineStartupRegistrationChecks = new WeakMap<ServiceWorkerRegistration, () => void>()
const updateReplyPorts = new Map<ServiceWorkerMessageTarget, MessagePort>()
const UPDATE_WAKEUP_CHANNEL = 'tsepistle-pwa-update-connect-v1'
const hasNavigator = (): boolean => typeof navigator !== 'undefined'
const hasWindow = (): boolean => typeof window !== 'undefined' && typeof document !== 'undefined'

const clearConnectionRetry = (): void => {
  if (connectionRetryTimer !== null) clearTimeout(connectionRetryTimer)
  connectionRetryTimer = null
}

const connectionProbeAllowed = (): boolean => hasWindow() && hasNavigator() && !pageSuspended && document.visibilityState !== 'hidden'

const suspendConnectionProbe = (): void => {
  clearConnectionRetry()
  connectionEpoch += 1
  activeProbe?.controller.abort()
  activeProbe = undefined
  if (state.connectionState === 'checking') setConnection(state.onlineHint === false ? 'offline' : 'server-unavailable')
}

const scheduleConnectionRetry = (): void => {
  clearConnectionRetry()
  if (state.mode === 'retirement' || !connectionProbeAllowed() || activeProbe || state.connectionState === 'checking') return
  const online = state.connectionState === 'online'
  connectionRetryTimer = setTimeout(
    () => {
      connectionRetryTimer = null
      if (!connectionProbeAllowed()) return
      if (!online) connectionRetryDelay = Math.min(connectionRetryDelay * 2, 30_000)
      void retryServerConnection({ quiet: true })
    },
    online ? 30_000 : connectionRetryDelay
  )
}

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
  if (!state.offlineReady) state.offlineReadiness = 'unavailable'
  if (state.updateState === 'checking' || state.preparation === 'checking') {
    state.updateState = 'error'
    state.preparation = 'error'
  }
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
  add(registration?.installing)
  return targets
}

const postToWorker = (worker: ServiceWorkerMessageTarget | null | undefined, message: unknown): void => {
  if (!worker || pageSuspended) return
  const type = (message as { type?: unknown })?.type
  const envelope = { type: 'PWA_PORT_REQUEST', message }
  // Votes retain the browser-provided source identity and the round's existing
  // subscription. Readiness uses independent, short-lived reply channels.
  if (type === RELOAD_SAFETY_MESSAGE) {
    try {
      worker.postMessage(envelope)
    } catch {
      /* The worker became redundant. */
    }
    return
  }
  if (typeof MessageChannel === 'undefined') return
  const channel = new MessageChannel()
  const readiness = type === OFFLINE_READY_REQUEST_MESSAGE
  const close = (): void => {
    clearTimeout(timer)
    channel.port1.onmessage = null
    channel.port1.close()
    replyPorts.delete(channel.port1)
    if (updateReplyPorts.get(worker) === channel.port1) updateReplyPorts.delete(worker)
  }
  const timer = setTimeout(close, 30_000)
  replyPorts.set(channel.port1, close)
  if (!readiness) {
    safetySequence += 1
    const previous = updateReplyPorts.get(worker)
    if (previous) replyPorts.get(previous)?.()
    updateReplyPorts.set(worker, channel.port1)
  }
  channel.port1.onmessage = event => {
    // MessagePort events have no ServiceWorker source. Identity comes from the
    // worker to which this document transferred the other end of this channel.
    handleWorkerMessage(event, worker as ServiceWorker)
    if (readiness) close()
  }
  try {
    worker.postMessage(envelope, [channel.port2])
  } catch {
    channel.port2.close()
    close()
  }
}

const attachUpdateWakeups = (): void => {
  if (updateWakeups || pageSuspended || state.mode === 'retirement' || typeof BroadcastChannel === 'undefined') return
  try {
    updateWakeups = new BroadcastChannel(UPDATE_WAKEUP_CHANNEL)
    updateWakeups.onmessage = event => {
      // This is only a wakeup: it supplies no worker identity, vote or round.
      const waiting = registrationReference?.waiting
      if (event.data === 'connect' && waiting && !pageSuspended) postToWorker(waiting, { type: 'PWA_CONNECT' })
    }
  } catch {
    /* Without a wakeup, unresponsive peers make update voting defer. */
  }
}

const clearPreparationTimer = (): void => {
  if (preparationTimer !== null) clearTimeout(preparationTimer)
  preparationTimer = null
}

const startPreparationTimer = (): void => {
  clearPreparationTimer()
  preparationTimer = setTimeout(() => {
    preparationTimer = null
    if (state.preparation !== 'checking' && state.preparation !== 'collecting') return
    state.preparation = 'deferred'
    state.preparationReason = 'The update did not receive a response from every open page. Retry after refreshing or closing older tabs.'
    state.updateState = 'ready'
  }, 20_000)
}

const postToWorkers = (message: unknown, registration = registrationReference): void => {
  for (const worker of workerTargets(registration)) postToWorker(worker, message)
}

const knownWorker = (candidate: ServiceWorker | null, registration = registrationReference): boolean =>
  Boolean(candidate && workerTargets(registration).includes(candidate))
const validRelease = (release: unknown): release is string => typeof release === 'string' && RELEASE_PATTERN.test(release)

const readDocumentRelease = (): string | null => {
  const release = typeof document !== 'undefined' ? document.querySelector('meta[name="tsepistle-pwa-release"]')?.getAttribute('content')?.trim() : null
  return validRelease(release) ? release : null
}

const startupContextIsCurrent = (context: StartupGateContext): boolean =>
  activeStartupGate === context && !context.cancelled && !pageSuspended && context.epoch === startupGateEpoch

const startupNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

const awaitStartup = <T>(context: StartupGateContext, pending: Promise<T>, cancelPending?: () => void): Promise<StartupWait<T>> => {
  const { promise, resolve } = Promise.withResolvers<StartupWait<T>>()
  let settled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const finish = (result: StartupWait<T>): void => {
    if (settled) return
    const finalResult: StartupWait<T> = result.kind === 'value' && startupNow() >= context.deadline ? { kind: 'timeout' } : result
    settled = true
    clearTimeout(timer ?? undefined)
    timer = null
    context.cancellations.delete(cancelForPagehide)
    if (finalResult.kind !== 'value') {
      try {
        cancelPending?.()
      } catch {
        /* Cancellation is best-effort. */
      }
    }
    resolve(finalResult)
  }
  const cancelForPagehide = (): void => finish({ kind: 'cancelled' })
  const remaining = Math.max(0, context.deadline - startupNow())
  if (!startupContextIsCurrent(context)) {
    finish({ kind: 'cancelled' })
    return promise
  }
  if (remaining === 0) {
    finish({ kind: 'timeout' })
    return promise
  }
  context.cancellations.add(cancelForPagehide)
  timer = setTimeout(() => finish({ kind: 'timeout' }), remaining)
  void pending.then(
    value => finish({ kind: 'value', value }),
    () => finish({ kind: 'error' })
  )
  return promise
}
const awaitStartupOrDetached = <T>(context: StartupGateContext | null, pending: Promise<T>, cancelPending?: () => void): Promise<StartupWait<T>> => {
  if (context) return awaitStartup(context, pending, cancelPending)
  const { promise, resolve } = Promise.withResolvers<StartupWait<T>>()
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  const finish = (result: StartupWait<T>): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (result.kind !== 'value') {
      try {
        cancelPending?.()
      } catch {
        /* Cancellation is best-effort. */
      }
    }
    resolve(result)
  }
  timer = setTimeout(() => finish({ kind: 'timeout' }), STARTUP_GATE_DEADLINE_MS)
  void pending.then(
    value => finish({ kind: 'value', value }),
    () => finish({ kind: 'error' })
  )
  return promise
}

const cancelActiveStartupGate = (): void => {
  const context = activeStartupGate
  if (!context) return
  context.cancelled = true
  for (const cancel of [...context.cancellations]) cancel()
}

const startupActivationMatchesCurrentRelease = (activation: AcceptedActivation): boolean =>
  validRelease(startupDocumentRelease) &&
  validRelease(startupBundleRelease) &&
  startupDocumentRelease === startupBundleRelease &&
  activation.release === startupDocumentRelease

const notifyStartupActivationObservers = (): void => {
  for (const observe of startupActivationObservers) observe()
}

const notifyNeedReload = (): boolean => {
  try {
    if (!callbackSet.onNeedReload) return false
    callbackSet.onNeedReload()
    return true
  } catch {
    // Lifecycle callbacks are observers and must not break the update.
    return false
  }
}

const requestExplicitRefreshForAcceptedWorker = async (): Promise<boolean> => {
  const container = currentServiceWorkerContainer()
  const controller = container?.controller ?? null
  const accepted = acceptedActivation
  const activation = controller && accepted && (accepted.worker === controller || accepted.activatedWorker === controller) ? accepted : null
  const release = activation?.release ?? (controller ? startupWorkerReleases.get(controller) : undefined)
  if (
    (!startupRefreshDeferred.value && !state.reloadNeeded) ||
    !controller ||
    controller.state !== 'activated' ||
    !validRelease(release) ||
    startupReloadIssued
  )
    return false
  if (startupDocumentRelease === startupBundleRelease && startupDocumentRelease === release) {
    startupRefreshDeferred.value = false
    startupAutomaticRefreshDisabled = false
    startupExplicitRefreshAllowed = false
    deferredReloadWorker = null
    state.reloadNeeded = false
    return true
  }
  const sequence = ++safetySequence
  const snapshot = await readSafetySnapshot()
  if (
    sequence !== safetySequence ||
    (activation && acceptedActivation !== activation) ||
    pageSuspended ||
    currentServiceWorkerContainer()?.controller !== controller ||
    (startupWorkerReleases.get(controller) !== release && !activation)
  )
    return false
  state.reloadSafe = snapshot.safe
  state.safetyRevision = snapshot.revision
  if (!snapshot.safe) return false
  startupExplicitRefreshAllowed = true
  startupAutomaticRefreshDisabled = false
  startupReloadIssued = true
  if (activation) reloadRequestedActivations.add(activation.nonce)
  deferredReloadWorker = null
  state.reloadNeeded = false
  if (!notifyNeedReload()) {
    startupReloadIssued = false
    startupAutomaticRefreshDisabled = true
    startupRefreshDeferred.value = true
    return false
  }
  startupRefreshDeferred.value = false
  return true
}

const maybeReloadAcceptedWorker = async (worker: ServiceWorker): Promise<void> => {
  if (pageSuspended) return
  const activation = acceptedActivation
  if (!activation || (activation.worker !== worker && activation.activatedWorker !== worker) || reloadRequestedActivations.has(activation.nonce)) return
  if (startupActivationMatchesCurrentRelease(activation)) {
    deferredReloadWorker = null
    state.reloadNeeded = false
    startupRefreshDeferred.value = false
    startupAutomaticRefreshDisabled = false
    startupExplicitRefreshAllowed = false
    return
  }
  if (startupGateActive || (startupAutomaticRefreshDisabled && !startupExplicitRefreshAllowed)) {
    deferredReloadWorker = worker
    state.reloadNeeded = true
    return
  }
  deferredReloadWorker = worker
  const sequence = ++safetySequence
  const snapshot = await readSafetySnapshot()
  if (
    sequence !== safetySequence ||
    acceptedActivation !== activation ||
    (startupAutomaticRefreshDisabled && !startupExplicitRefreshAllowed) ||
    startupActivationMatchesCurrentRelease(activation)
  ) {
    if (startupActivationMatchesCurrentRelease(activation)) {
      deferredReloadWorker = null
      state.reloadNeeded = false
      startupRefreshDeferred.value = false
      startupAutomaticRefreshDisabled = false
      startupExplicitRefreshAllowed = false
    }
    return
  }
  state.reloadSafe = snapshot.safe
  state.safetyRevision = snapshot.revision
  if (!snapshot.safe) {
    state.reloadNeeded = true
    return
  }
  // No await occurs after this final actor/epoch/revision check and before the
  // once-per-activated-epoch callback.
  reloadRequestedActivations.add(activation.nonce)
  deferredReloadWorker = null
  state.reloadNeeded = false
  if (startupGateActive) {
    if (startupReloadIssued) return
    startupReloadIssued = true
  }
  if (startupExplicitRefreshAllowed) {
    startupReloadIssued = true
    startupRefreshDeferred.value = false
  }
  notifyNeedReload()
}

const readSafetySnapshot = async (): Promise<ReloadSafetySnapshot> => {
  try {
    const snapshot = await safetyProvider()
    if (
      snapshot &&
      typeof snapshot === 'object' &&
      typeof snapshot.safe === 'boolean' &&
      typeof snapshot.revision === 'string' &&
      snapshot.revision.trim().length > 0
    ) {
      return snapshot
    }
  } catch {
    // An unavailable safety provider is unsafe.
  }
  return { safe: false, revision: `unavailable-${safetySequence}` }
}

const noteAcceptedActivation = (
  nonce: string,
  workerId: string,
  release: string,
  worker: ServiceWorker | null,
  activatedWorker: ServiceWorker | null = null
): void => {
  if (acceptedActivation?.nonce === nonce) {
    if (!acceptedActivation.worker && worker) acceptedActivation.worker = worker
    if (!acceptedActivation.activatedWorker && activatedWorker) acceptedActivation.activatedWorker = activatedWorker
    notifyStartupActivationObservers()
    return
  }
  acceptedActivation = { nonce, workerId, release, worker, activatedWorker }
  deferredReloadWorker = null
  state.reloadNeeded = false
  state.updateReady = true
  state.updateState = 'activating'
  notifyStartupActivationObservers()
}

const retryDeferredReload = (): void => {
  if (deferredReloadWorker) void maybeReloadAcceptedWorker(deferredReloadWorker)
}

const reportReloadSafety = async (context: SafetyRequestContext = {}, target: ServiceWorkerMessageTarget | null = null): Promise<boolean> => {
  if (target) activeSafetyRequest = { target, context }
  const sequence = ++safetySequence
  const snapshot = await readSafetySnapshot()
  if (sequence !== safetySequence) return false
  state.reloadSafe = snapshot.safe
  state.safetyRevision = snapshot.revision
  const message: Record<string, unknown> = {
    type: RELOAD_SAFETY_MESSAGE,
    safe: snapshot.safe,
    revision: snapshot.revision
  }
  if (snapshot.actorEpoch !== undefined) message.actorEpoch = snapshot.actorEpoch
  if (context.workerId) message.workerId = context.workerId
  if (context.release) message.release = context.release
  if (context.roundNonce) message.roundNonce = context.roundNonce
  if (target) postToWorker(target, message)
  else postToWorkers(message)
  retryDeferredReload()
  return snapshot.safe
}

const handleActivatedUpdate = (nonce: string, workerId: string, release: string, source: ServiceWorkerMessageTarget | null): void => {
  clearPreparationTimer()
  const sourceWorker = source as ServiceWorker | null
  let activation = acceptedActivation
  if (!activation || activation.nonce !== nonce) {
    const currentController = currentServiceWorkerContainer()?.controller ?? null
    if (!sourceWorker || sourceWorker !== currentController || !knownWorker(sourceWorker)) return
    noteAcceptedActivation(nonce, workerId, release, sourceWorker, sourceWorker)
    activation = acceptedActivation
  }
  if (!activation) return
  if (activation.workerId !== workerId || activation.release !== release) return
  const activatedWorker = sourceWorker ?? activation.activatedWorker ?? activation.worker
  if (!activatedWorker) return
  activation.activatedWorker = activatedWorker
  state.updateReady = false
  state.updateState = 'activated'
  state.preparation = 'activated'
  state.preparationReason = null
  state.reloadNeeded = true
  deferredReloadWorker = activatedWorker
  void maybeReloadAcceptedWorker(activatedWorker)
}

const markController = (controller: ServiceWorker | null): void => {
  notifyStartupActivationObservers()
  const previous = activeController
  activeController = controller
  state.controller = controller
  state.controlled = controller !== null
  const activation = acceptedActivation
  const acceptedController = Boolean(
    controller && activation && activation.release === state.workerRelease && (activation.worker === controller || activation.activatedWorker === controller)
  )
  if (controller && previous && controller !== previous && acceptedController) {
    if (activation) activation.activatedWorker = controller
    state.reloadNeeded = true
    deferredReloadWorker = controller
    state.updateState = 'activated'
    state.preparation = 'activated'
    void maybeReloadAcceptedWorker(controller)
  }
  if (acceptedController && controller) {
    state.updateState = 'activated'
    state.updateReady = false
  }
  requestOfflineReadiness()
}

const extractMetaContent = (html: string, name: string): string | null => {
  const expected = name.toLowerCase()
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const nameMatch = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(tag)
    const contentMatch = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(tag)
    const actual = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3]
    if (actual?.trim().toLowerCase() === expected) return (contentMatch?.[1] ?? contentMatch?.[2] ?? contentMatch?.[3] ?? '').trim()
  }
  return null
}

const verifyOfflineCache = async (cacheName: string, release: string, manifestDigest: string, markerURL: string): Promise<boolean> => {
  if (!isOwnedPrecacheCacheName(cacheName) || /-candidate-/u.test(cacheName) || typeof caches === 'undefined') return false
  let marker: URL
  try {
    marker = new URL(markerURL, window.location.origin)
  } catch {
    return false
  }
  if (marker.origin !== window.location.origin || marker.pathname !== OFFLINE_DOCUMENT_PATH || !marker.searchParams.has('__tsepistle_pwa_complete'))
    return false
  try {
    const cache = await caches.open(cacheName)
    const shell = await cache.match(new URL(OFFLINE_DOCUMENT_PATH, window.location.origin).href)
    const markerResponse = await cache.match(marker.href)
    if (!shell || !markerResponse) return false
    const markerValue = (await markerResponse.json()) as { release?: unknown; manifestDigest?: unknown; cacheName?: unknown }
    if (markerValue.release !== release || markerValue.manifestDigest !== manifestDigest || markerValue.cacheName !== cacheName) return false
    if (typeof shell.clone === 'function') {
      const shellRelease = extractMetaContent(await shell.clone().text(), 'tsepistle-pwa-release')
      if (shellRelease !== null && shellRelease !== release) return false
    }
    return true
  } catch {
    return false
  }
}
const markOfflineUnavailable = (): void => {
  offlineReadinessEpoch += 1
  state.offlineReady = false
  state.offlineReadiness = 'unavailable'
  state.offlineReadyRelease = null
  state.offlineReadyManifestDigest = null
}

const markOfflineReady = async (
  registration: ServiceWorkerRegistration,
  source: ServiceWorker,
  message: {
    complete?: unknown
    release?: unknown
    manifestDigest?: unknown
    cacheName?: unknown
    shellPath?: unknown
    markerURL?: unknown
  }
): Promise<void> => {
  if (
    state.mode === 'retirement' ||
    message.complete !== true ||
    typeof message.release !== 'string' ||
    message.release.length === 0 ||
    typeof message.manifestDigest !== 'string' ||
    !/^[0-9a-f]{16}$/u.test(message.manifestDigest) ||
    typeof message.cacheName !== 'string' ||
    message.shellPath !== OFFLINE_DOCUMENT_PATH ||
    typeof message.markerURL !== 'string' ||
    !knownWorker(source, registration)
  ) {
    markOfflineUnavailable()
    return
  }
  const release = message.release
  const manifestDigest = message.manifestDigest
  const cacheName = message.cacheName
  const markerURL = message.markerURL
  if (state.workerRelease && state.workerRelease !== release && source !== registration.waiting && source !== registration.installing) return
  const readinessEpoch = ++offlineReadinessEpoch
  state.offlineReadiness = 'checking'
  const verified = await verifyOfflineCache(cacheName, release, manifestDigest, markerURL)
  if (readinessEpoch !== offlineReadinessEpoch || registrationReference !== registration || !knownWorker(source, registration)) return
  if (!verified) {
    markOfflineUnavailable()
    return
  }
  state.offlineReady = true
  state.offlineReadiness = 'ready'
  state.offlineReadyRelease = release
  state.offlineReadyManifestDigest = manifestDigest
  state.workerRelease = release
  state.registrationState = 'ready'
  if (offlineReadyNotifiedRelease === release) return
  offlineReadyNotifiedRelease = release
  try {
    callbackSet.onOfflineReady?.(registration)
  } catch {
    // Lifecycle callbacks are observers and must not break readiness.
  }
}

const requestOfflineReadiness = (): void => {
  if (pageSuspended || state.mode === 'retirement' || !registrationReference) return
  if (!state.offlineReady) state.offlineReadiness = 'checking'
  postToWorkers({ type: OFFLINE_READY_REQUEST_MESSAGE }, registrationReference)
}

const handleUpdatePreparing = (
  message: { workerId?: unknown; release?: unknown; roundNonce?: unknown; phase?: unknown },
  source: ServiceWorkerMessageTarget | null
): void => {
  const sourceWorker = source as ServiceWorker | null
  if (
    !sourceWorker ||
    !knownWorker(sourceWorker) ||
    typeof message.workerId !== 'string' ||
    typeof message.release !== 'string' ||
    typeof message.roundNonce !== 'string' ||
    (message.phase !== 'collecting' && message.phase !== 'activating')
  )
    return
  state.workerRelease = message.release
  state.updateReady = true
  state.preparation = message.phase
  state.preparationReason = null
  state.updateState = message.phase === 'activating' ? 'activating' : 'ready'
  if (message.phase === 'activating') {
    clearPreparationTimer()
    noteAcceptedActivation(message.roundNonce, message.workerId, message.release, sourceWorker)
    if (currentServiceWorkerContainer()?.controller === sourceWorker) handleActivatedUpdate(message.roundNonce, message.workerId, message.release, sourceWorker)
  } else {
    startPreparationTimer()
  }
}

const handleUpdateDeferred = (
  message: { workerId?: unknown; release?: unknown; roundNonce?: unknown; reason?: unknown },
  source: ServiceWorkerMessageTarget | null
): void => {
  const sourceWorker = source as ServiceWorker | null
  if (
    !sourceWorker ||
    !knownWorker(sourceWorker) ||
    typeof message.workerId !== 'string' ||
    typeof message.release !== 'string' ||
    typeof message.roundNonce !== 'string'
  )
    return
  if (acceptedActivation?.nonce === message.roundNonce) acceptedActivation = null
  clearPreparationTimer()
  state.preparation = 'deferred'
  state.preparationReason = typeof message.reason === 'string' ? message.reason : 'The update was deferred until every document is safe.'
  state.updateState = 'ready'
  state.updateReady = Boolean(registrationReference?.waiting)
  state.updateError = null
}

const retryDeferredPreparationWhenSafe = (): void => {
  if (pageSuspended || state.mode === 'retirement' || state.preparation !== 'deferred') return
  void reportReloadSafety().then(safe => {
    if (
      safe &&
      !pageSuspended &&
      !startupGateActive &&
      !startupRefreshDeferred.value &&
      !startupAutomaticRefreshDisabled &&
      state.preparation === 'deferred' &&
      registrationReference?.waiting
    )
      void requestPwaUpdateAutomatically()
  })
}

const observeWorker = (registration: ServiceWorkerRegistration, worker: ServiceWorker | null): void => {
  if (!worker || typeof worker.addEventListener !== 'function' || observedWorkers.has(worker)) return
  observedWorkers.add(worker)
  worker.addEventListener('statechange', () => {
    const container = currentServiceWorkerContainer()
    if (worker.state === 'installed') {
      if (container?.controller && worker !== container.controller) markUpdateReady(registration)
      requestOfflineReadiness()
      return
    }
    if (worker.state === 'activating') {
      state.updateState = 'activating'
      state.preparation = 'activating'
      return
    }
    if (worker.state === 'activated') {
      markController(container?.controller ?? null)
      requestOfflineReadiness()
      return
    }
    if (worker.state === 'redundant') {
      const port = updateReplyPorts.get(worker)
      if (port) replyPorts.get(port)?.()
      const initialInstallFailure = !registration.active && !container?.controller && registration.waiting !== worker
      if (initialInstallFailure) {
        registrationReference = null
        state.registration = null
        state.controller = null
        state.controlled = false
        activeController = null
        setRegistrationError(new Error('The service worker installation became redundant.'))
      } else if (worker === updateReadyWorker && state.updateState === 'activating') {
        state.updateState = 'error'
        state.preparation = 'error'
        state.updateError = 'The service worker update became redundant before activation.'
      }
    }
  })
}

const markUpdateReady = (registration: ServiceWorkerRegistration): void => {
  const waiting = registration.waiting
  if (!waiting) return
  state.updateReady = true
  state.updateState = state.preparation === 'activating' ? 'activating' : 'ready'
  state.updateError = null
  if (updateReadyWorker === waiting) return
  updateReadyWorker = waiting
  try {
    callbackSet.onUpdateReady?.(registration)
  } catch {
    // Lifecycle callbacks are observers and must not break registration.
  }
  // A waiting worker can remain idle indefinitely without this request. The
  // worker still requires a current safe vote from every open page before it
  // calls skipWaiting(), so starting preparation cannot discard editor work.
  queueMicrotask(() => {
    if (
      !pageSuspended &&
      !startupGateActive &&
      !startupRefreshDeferred.value &&
      !startupAutomaticRefreshDisabled &&
      registrationReference === registration &&
      registration.waiting === waiting
    )
      void requestPwaUpdateAutomatically()
  })
}

const attachRegistrationListeners = (registration: ServiceWorkerRegistration): void => {
  if (typeof registration.addEventListener === 'function') {
    registration.addEventListener('updatefound', () => {
      observeWorker(registration, registration.installing)
      state.updateError = null
      state.updateState = 'checking'
      state.preparation = 'checking'
      state.preparationReason = null
      state.updateReady = false
      updateReadyWorker = null
    })
  }
  observeWorker(registration, registration.installing)
  observeWorker(registration, registration.waiting)
  if (registration.waiting) markUpdateReady(registration)
  if (registration.active) {
    observeWorker(registration, registration.active)
    requestOfflineReadiness()
  }
}

const handleWorkerMessage = (messageEvent: Pick<MessageEvent, 'data'>, source: ServiceWorker): void => {
  if (pageSuspended || !knownWorker(source)) return
  if (typeof messageEvent.data !== 'object' || messageEvent.data === null) return
  const message = messageEvent.data as {
    type?: unknown
    workerId?: unknown
    release?: unknown
    roundNonce?: unknown
    safe?: unknown
    revision?: unknown
    actorEpoch?: unknown
    phase?: unknown
    reason?: unknown
    complete?: unknown
    manifestDigest?: unknown
    cacheName?: unknown
    shellPath?: unknown
    markerURL?: unknown
  }
  if (message.type === RETIREMENT_NOTICE_MESSAGE) {
    state.retirementNotice = true
    markOfflineUnavailable()
    return
  }
  if (message.type === RELOAD_SAFETY_REQUEST_MESSAGE && source) {
    void reportReloadSafety(
      {
        workerId: typeof message.workerId === 'string' ? message.workerId : undefined,
        release: typeof message.release === 'string' ? message.release : undefined,
        roundNonce: typeof message.roundNonce === 'string' ? message.roundNonce : undefined
      },
      source
    )
    return
  }
  if (message.type === OFFLINE_READY_MESSAGE && source) {
    const registration = registrationReference
    if (registration) void markOfflineReady(registration, source as ServiceWorker, message)
    return
  }
  if (message.type === OFFLINE_NOT_READY_MESSAGE && source && knownWorker(source as ServiceWorker)) {
    const registration = registrationReference
    const release = message.release
    if (
      registration &&
      (!state.workerRelease ||
        typeof release !== 'string' ||
        release === state.workerRelease ||
        source === registration.waiting ||
        source === registration.installing)
    )
      markOfflineUnavailable()
    return
  }
  if (message.type === UPDATE_PREPARING_MESSAGE) {
    handleUpdatePreparing(message, source)
    return
  }
  if (message.type === UPDATE_DEFERRED_MESSAGE) {
    handleUpdateDeferred(message, source)
    return
  }
  if (
    message.type === UPDATE_ACTIVATING_MESSAGE &&
    typeof message.workerId === 'string' &&
    typeof message.release === 'string' &&
    typeof message.roundNonce === 'string'
  ) {
    clearPreparationTimer()
    noteAcceptedActivation(message.roundNonce, message.workerId, message.release, source as ServiceWorker | null)
    state.preparation = 'activating'
    if (currentServiceWorkerContainer()?.controller === source) handleActivatedUpdate(message.roundNonce, message.workerId, message.release, source)
    return
  }
  if (
    message.type === ACTIVATED_UPDATE_MESSAGE &&
    typeof message.workerId === 'string' &&
    typeof message.release === 'string' &&
    typeof message.roundNonce === 'string'
  ) {
    handleActivatedUpdate(message.roundNonce, message.workerId, message.release, source)
  }
}

const attachServiceWorkerListeners = (): void => {
  if (serviceWorkerListenersAttached) return
  const container = currentServiceWorkerContainer()
  if (!container) return
  serviceWorkerListenersAttached = true
  if (typeof container.addEventListener === 'function') {
    container.addEventListener('controllerchange', () => markController(container.controller ?? null))
    // Retirement workers predate the port protocol. Their notice cannot vote
    // for an update or establish offline readiness.
    container.addEventListener('message', event => {
      if ((event.data as { type?: unknown } | null)?.type === RETIREMENT_NOTICE_MESSAGE) {
        handleWorkerMessage(event, event.source as ServiceWorker)
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
      attachRegistrationListeners(registration)
      markController(container.controller ?? null)
      if (registration.waiting) markUpdateReady(registration)
      requestOfflineReadiness()
      notifyReady(registration)
    })
    .catch(error => {
      if (!registrationReference) setRegistrationError(error, 'The service worker readiness check failed.')
    })
}

const captureInstallPrompt = (event: Event): void => {
  const promptEvent = event as BeforeInstallPromptEvent
  if (typeof promptEvent.prompt !== 'function' || !promptEvent.userChoice) return
  event.preventDefault()
  installOfferSequence += 1
  installPrompt = { event: promptEvent, token: installOfferSequence }
  state.installAvailability = 'available'
  state.installPromptAvailable = true
  state.installError = null
}

const updateStandaloneState = (): void => {
  const standalone = standaloneDisplay()
  state.isStandalone = standalone
  state.installed = standalone || state.appInstalled
  if (standalone || state.appInstalled) state.installAvailability = 'installed'
  else if (!installPrompt) state.installAvailability = 'unavailable'
}

const markInstalled = (): void => {
  installPrompt = null
  state.appInstalled = true
  state.installed = true
  state.installAvailability = 'installed'
  state.installPromptAvailable = false
  state.installError = null
}

const recheckOfflineStartupRegistration = (): void => {
  const registration = registrationReference
  if (registration) offlineStartupRegistrationChecks.get(registration)?.()
}
const handleOnlineHint = (): void => {
  state.onlineHint = true
  recheckOfflineStartupRegistration()
  if (connectionProbeAllowed()) void retryServerConnection()
}

const handleOfflineHint = (): void => {
  suspendConnectionProbe()
  connectionRetryDelay = 3_000
  state.onlineHint = false
  state.serverReachable = null
  state.serverHealthy = null
  setConnection('offline')
  scheduleConnectionRetry()
}

/** Re-read the browser hint at interaction/resume boundaries, even if its event was missed. */
export function observeBrowserConnection(): void {
  if (state.mode !== 'retirement' && hasNavigator() && navigator.onLine === false && state.onlineHint !== false) handleOfflineHint()
}

/** A failed transport request invalidates an earlier successful health check. */
export function reportServerConnectionFailure(): void {
  if (state.mode === 'retirement') return
  suspendConnectionProbe()
  state.onlineHint = hasNavigator() && typeof navigator.onLine === 'boolean' ? navigator.onLine : null
  state.serverReachable = false
  state.serverHealthy = false
  connectionRetryDelay = 3_000
  setConnection(state.onlineHint === false ? 'offline' : 'server-unavailable')
  scheduleConnectionRetry()
}

const resumeConnection = (): void => {
  observeBrowserConnection()
  recheckOfflineStartupRegistration()
  if (state.mode === 'retirement' || !connectionProbeAllowed() || activeProbe) return
  if (state.connectionState === 'online') void retryServerConnection({ quiet: true })
  else scheduleConnectionRetry()
}

const attachWindowListeners = (): void => {
  if (!hasWindow() || installListenersAttached) return
  installListenersAttached = true
  updateStandaloneState()
  attachUpdateWakeups()
  window.addEventListener('pagehide', () => {
    cancelActiveStartupGate()
    startupGateEpoch += 1
    pageSuspended = true
    suspendConnectionProbe()
    safetySequence += 1
    offlineReadinessEpoch += 1
    clearPreparationTimer()
    for (const close of replyPorts.values()) close()
    updateWakeups?.close()
    updateWakeups = null
  })
  window.addEventListener('pageshow', () => {
    pageSuspended = false
    resumeConnection()
    attachUpdateWakeups()
    requestOfflineReadiness()
    const waiting = registrationReference?.waiting
    if (waiting) postToWorker(waiting, { type: 'PWA_CONNECT' })
    retryDeferredReload()
    if (waiting && state.preparation !== 'deferred' && state.preparation !== 'activating' && state.preparation !== 'activated') {
      // A pagehide can close the preparation port before the worker replies.
      // Rejoin or restart that round when this document becomes active again.
      void requestPwaUpdateAutomatically()
    } else {
      retryDeferredPreparationWhenSafe()
    }
  })
  window.addEventListener(INSTALL_EVENT, captureInstallPrompt as EventListener)
  window.addEventListener(INSTALLED_EVENT, markInstalled as EventListener)
  window.addEventListener('online', handleOnlineHint)
  window.addEventListener('offline', handleOfflineHint)
  window.addEventListener('focus', resumeConnection)
  window.addEventListener('visibilitychange', () => {
    updateStandaloneState()
    if (document.visibilityState === 'hidden') {
      suspendConnectionProbe()
      return
    }
    resumeConnection()
    requestOfflineReadiness()
    retryDeferredReload()
    retryDeferredPreparationWhenSafe()
  })
  const displayMedia = window.matchMedia?.('(display-mode: standalone)')
  displayMedia?.addEventListener?.('change', updateStandaloneState)
}

const registerNow = async (): Promise<ServiceWorkerRegistration | null> => {
  attachWindowListeners()
  if (state.mode === 'retirement') {
    state.registrationState = 'unsupported'
    markOfflineUnavailable()
    return null
  }
  const container = currentServiceWorkerContainer()
  if (!container) {
    state.registrationState = 'unsupported'
    state.offlineReadiness = 'unavailable'
    return null
  }
  state.registrationState = 'registering'
  state.error = null
  state.registrationError = null
  state.offlineReadiness = 'checking'
  readyNotified = false
  try {
    const registration = await container.register(SERVICE_WORKER_PATH, { scope: SERVICE_WORKER_SCOPE })
    registrationReference = registration
    state.registration = registration
    state.registrationState = 'registered'
    attachServiceWorkerListeners()
    attachRegistrationListeners(registration)
    markController(container.controller ?? null)
    if (registration.waiting) markUpdateReady(registration)
    requestOfflineReadiness()
    notifyReady(registration)
    return registration
  } catch (error) {
    setRegistrationError(error)
    return null
  }
}

const scheduleRegistration = (): Promise<ServiceWorkerRegistration | null> => {
  if (!hasWindow() || document.readyState !== 'loading') return registerNow()
  return new Promise(resolve => {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        void registerNow().then(resolve)
      },
      { once: true }
    )
  })
}

export function registerPwa(callbacks: PwaLifecycleCallbacks = {}): Promise<ServiceWorkerRegistration | null> {
  callbackSet = { ...callbackSet, ...callbacks }
  attachWindowListeners()
  observeBrowserConnection()
  if (state.mode === 'retirement') {
    state.registrationState = 'unsupported'
    markOfflineUnavailable()
    return Promise.resolve(null)
  }
  if (!initialConnectionProbeStarted) {
    initialConnectionProbeStarted = true
    if (connectionProbeAllowed()) void retryServerConnection()
    else setConnection(state.onlineHint === false ? 'offline' : 'server-unavailable')
  }
  if (registrationReference) return Promise.resolve(registrationReference)
  if (registrationInFlight) return registrationInFlight
  const scheduled = scheduleRegistration()
  registrationInFlight = scheduled.finally(() => {
    registrationInFlight = undefined
  })
  return registrationInFlight
}

export async function retryServerConnection(options: { quiet?: boolean; reusePending?: boolean } = {}): Promise<boolean> {
  if (hasWindow() && (pageSuspended || document.visibilityState === 'hidden')) return false
  if (options.reusePending && activeProbe) return activeProbe.promise
  clearConnectionRetry()
  const epoch = ++connectionEpoch
  activeProbe?.controller.abort()
  if (!hasWindow() || !hasNavigator()) {
    state.serverReachable = null
    state.serverHealthy = null
    setConnection('server-unavailable')
    return false
  }
  state.onlineHint = typeof navigator.onLine === 'boolean' ? navigator.onLine : null
  // Keep the saved-page UI stable while quietly checking for a connection.
  if (!options.quiet && !['offline', 'server-unavailable'].includes(state.connectionState)) {
    state.serverReachable = null
    state.serverHealthy = null
    setConnection('checking')
  }
  const controller = new AbortController()
  let rejectTimeout = (_reason?: unknown): void => {}
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject
  })
  const timeout = setTimeout(() => {
    controller.abort()
    rejectTimeout(new Error('The server health check timed out.'))
  }, PROBE_DEADLINE_MS)
  const promise = (async () => {
    try {
      const response = await Promise.race([
        window.fetch(SERVER_PROBE_PATH, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: controller.signal
        }),
        timeoutPromise
      ])
      if (epoch !== connectionEpoch) return false
      state.lastProbeAt = Date.now()
      const responseUrl = typeof response.url === 'string' && response.url ? new URL(response.url, window.location.href) : null
      const sameOrigin = !responseUrl || responseUrl.origin === window.location.origin
      state.serverReachable = sameOrigin
      state.serverHealthy = sameOrigin && response.ok
      if (sameOrigin && response.ok) connectionRetryDelay = 3_000
      setConnection(sameOrigin && response.ok ? 'online' : 'server-unavailable')
      return sameOrigin && response.ok
    } catch {
      if (epoch !== connectionEpoch) return false
      state.lastProbeAt = Date.now()
      state.serverReachable = false
      state.serverHealthy = false
      setConnection(state.onlineHint === false ? 'offline' : 'server-unavailable')
      return false
    } finally {
      clearTimeout(timeout)
      if (activeProbe?.epoch === epoch) activeProbe = undefined
      if (epoch === connectionEpoch) scheduleConnectionRetry()
    }
  })()
  activeProbe = { epoch, controller, promise }
  return promise
}

export async function promptPwaInstall(): Promise<PwaInstallOutcome | null> {
  if (installPromptInFlight) return installPromptInFlight
  const offer = installPrompt
  if (!offer || state.installed || state.isStandalone || state.installAvailability !== 'available') return null
  state.installError = null
  const prompt = (async () => {
    try {
      await offer.event.prompt()
      const choice = await offer.event.userChoice
      if (choice.outcome !== 'accepted' && choice.outcome !== 'dismissed') throw new Error('The browser returned an invalid install choice.')
      if (choice.outcome === 'accepted') {
        state.installAccepted = true
        state.installOutcome = 'accepted'
      } else {
        state.installOutcome = 'dismissed'
      }
      return choice.outcome
    } catch (error) {
      state.installError = errorMessage(error, 'The browser closed the install prompt.')
      return null
    } finally {
      if (installPrompt?.token === offer.token) {
        installPrompt = null
        state.installPromptAvailable = false
        state.installAvailability = state.installed ? 'installed' : 'unavailable'
      }
    }
  })()
  const inFlight = prompt.finally(() => {
    installPromptInFlight = undefined
  })
  installPromptInFlight = inFlight
  return inFlight
}

export function notifyReloadSafetyChanged(): void {
  safetySequence += 1
  let safetyReport = reportReloadSafety()
  const request = activeSafetyRequest
  if (request && registrationReference && workerTargets(registrationReference).includes(request.target as ServiceWorker)) {
    safetyReport = reportReloadSafety(request.context, request.target)
  } else if (request) {
    activeSafetyRequest = null
  }
  void safetyReport.then(safe => {
    if (
      safe &&
      !pageSuspended &&
      !startupGateActive &&
      !startupRefreshDeferred.value &&
      !startupAutomaticRefreshDisabled &&
      state.preparation === 'deferred' &&
      registrationReference?.waiting
    )
      void requestPwaUpdateAutomatically()
  })
  retryDeferredReload()
}

export function setReloadSafetyProvider(provider: ReloadSafetyProvider | null): void {
  safetyProvider = provider ?? (() => ({ safe: true, revision: 'default' }))
  notifyReloadSafetyChanged()
}
const waitForWaitingWorker = async (registration: ServiceWorkerRegistration): Promise<ServiceWorker | null> => {
  if (registration.waiting) return registration.waiting
  if (typeof registration.addEventListener !== 'function') return null
  return new Promise(resolve => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (worker: ServiceWorker | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      registration.removeEventListener?.('updatefound', onUpdateFound)
      resolve(worker)
    }
    const onUpdateFound = (): void => {
      const installing = registration.installing
      if (!installing) return
      observeWorker(registration, installing)
      installing.addEventListener?.('statechange', () => {
        if (installing.state === 'installed' && registration.waiting) finish(registration.waiting)
        if (installing.state === 'redundant') finish(null)
      })
    }
    timer = setTimeout(() => finish(registration.waiting ?? null), WAITING_WORKER_DEADLINE_MS)
    registration.addEventListener('updatefound', onUpdateFound, { once: false })
    onUpdateFound()
  })
}

const prepareWaitingWorker = (registration: ServiceWorkerRegistration, waiting: ServiceWorker): boolean => {
  if (state.mode === 'retirement' || registrationReference !== registration || registration.waiting !== waiting) return false
  state.updateError = null
  updateReadyWorker = waiting
  state.updateReady = true
  state.updateState = 'ready'
  state.preparation = 'checking'
  state.preparationReason = null
  attachUpdateWakeups()
  updateWakeups?.postMessage('connect')
  startPreparationTimer()
  postToWorker(waiting, { type: PREPARE_UPDATE_MESSAGE })
  return true
}

const requestUpdate = async (): Promise<boolean> => {
  if (state.mode === 'retirement') return false
  const registration = await registerPwa()
  if (!registration) return false
  state.updateError = null
  state.updateState = 'checking'
  state.preparation = 'checking'
  state.preparationReason = null
  let waiting = registration.waiting
  if (!waiting) {
    try {
      if (typeof registration.update !== 'function') throw new Error('The browser cannot check for service worker updates.')
      await registration.update()
    } catch (error) {
      state.updateState = 'error'
      state.preparation = 'error'
      state.updateError = errorMessage(error, 'The service worker update check failed.')
      notifyError(error)
      return false
    }
    waiting = await waitForWaitingWorker(registration)
  }
  if (!waiting) {
    state.updateState = 'idle'
    state.preparation = 'idle'
    state.updateReady = false
    return false
  }
  return prepareWaitingWorker(registration, waiting)
}

const probeStartupWorker = (
  context: StartupGateContext | null,
  registration: ServiceWorkerRegistration,
  worker: ServiceWorker
): Promise<StartupWait<StartupWorkerIdentity | null>> => {
  if (!knownWorker(worker, registration) || typeof MessageChannel === 'undefined') return Promise.resolve({ kind: 'value', value: null })
  const channel = new MessageChannel()
  const { promise, resolve } = Promise.withResolvers<StartupWorkerIdentity | null>()
  let settled = false
  const close = (): void => {
    if (settled) return
    settled = true
    channel.port1.onmessage = null
    channel.port1.close()
    channel.port2.close()
    replyPorts.delete(channel.port1)
    resolve(null)
  }
  replyPorts.set(channel.port1, close)
  channel.port1.onmessage = event => {
    if (settled) return
    const message = event.data as {
      type?: unknown
      release?: unknown
      complete?: unknown
      manifestDigest?: unknown
      cacheName?: unknown
      shellPath?: unknown
      markerURL?: unknown
    } | null
    if (!message || (message.type !== OFFLINE_READY_MESSAGE && message.type !== OFFLINE_NOT_READY_MESSAGE)) {
      close()
      return
    }
    const release = validRelease(message.release) ? message.release : null
    if (release) startupWorkerReleases.set(worker, release)
    if (message.type === OFFLINE_READY_MESSAGE) {
      void markOfflineReady(registration, worker, message)
    } else {
      const currentRelease = message.release
      if (
        registrationReference === registration &&
        (!state.workerRelease ||
          typeof currentRelease !== 'string' ||
          currentRelease === state.workerRelease ||
          worker === registration.waiting ||
          worker === registration.installing)
      )
        markOfflineUnavailable()
    }
    settled = true
    channel.port1.onmessage = null
    channel.port1.close()
    channel.port2.close()
    replyPorts.delete(channel.port1)
    resolve({ worker, release })
  }
  // The reply port is transferred to this exact worker, binding its release to that source.
  try {
    worker.postMessage({ type: 'PWA_PORT_REQUEST', message: { type: OFFLINE_READY_REQUEST_MESSAGE } }, [channel.port2])
  } catch {
    close()
  }
  return awaitStartupOrDetached(context, promise, close)
}

const waitForNewStartupWaitingWorker = (
  context: StartupGateContext,
  registration: ServiceWorkerRegistration,
  previousWaiting: ServiceWorker | null
): Promise<StartupWait<ServiceWorker | null>> => {
  const { promise, resolve } = Promise.withResolvers<ServiceWorker | null>()
  let settled = false
  const installingWorkers: ServiceWorker[] = []
  const cleanup = (): void => {
    registration.removeEventListener?.('updatefound', onUpdateFound)
    for (const worker of installingWorkers) worker.removeEventListener?.('statechange', check)
  }
  const finish = (worker: ServiceWorker | null): void => {
    if (settled) return
    settled = true
    cleanup()
    resolve(worker)
  }
  const check = (): void => {
    const waiting = registration.waiting
    if (waiting && waiting !== previousWaiting && waiting.state === 'installed') finish(waiting)
  }
  const onUpdateFound = (): void => {
    const installing = registration.installing
    if (!installing || installingWorkers.includes(installing)) return
    installingWorkers.push(installing)
    observeWorker(registration, installing)
    installing.addEventListener?.('statechange', check)
    check()
  }
  registration.addEventListener?.('updatefound', onUpdateFound)
  onUpdateFound()
  check()
  return awaitStartup(context, promise, () => finish(null))
}

const waitForStartupActivation = (
  context: StartupGateContext,
  container: ServiceWorkerContainer,
  registration: ServiceWorkerRegistration,
  worker: ServiceWorker,
  release: string
): Promise<StartupWait<AcceptedActivation | null>> => {
  const { promise, resolve } = Promise.withResolvers<AcceptedActivation | null>()
  let settled = false
  const cleanup = (): void => {
    container.removeEventListener?.('controllerchange', check)
    worker.removeEventListener?.('statechange', check)
    registration.removeEventListener?.('updatefound', check)
    startupActivationObservers.delete(check)
  }
  const finish = (activation: AcceptedActivation | null): void => {
    if (settled) return
    settled = true
    cleanup()
    resolve(activation)
  }
  const check = (): void => {
    const activation = acceptedActivation
    if (
      worker.state === 'activated' &&
      container.controller === worker &&
      activation?.release === release &&
      (activation.worker === worker || activation.activatedWorker === worker)
    )
      finish(activation)
  }
  container.addEventListener?.('controllerchange', check)
  worker.addEventListener?.('statechange', check)
  registration.addEventListener?.('updatefound', check)
  startupActivationObservers.add(check)
  check()
  return awaitStartup(context, promise, () => finish(null))
}

const waitForStartupController = (context: StartupGateContext, container: ServiceWorkerContainer, worker: ServiceWorker): Promise<StartupWait<boolean>> => {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  let settled = false
  const cleanup = (): void => {
    container.removeEventListener?.('controllerchange', check)
    worker.removeEventListener?.('statechange', check)
    startupActivationObservers.delete(check)
  }
  const finish = (): void => {
    if (settled) return
    settled = true
    cleanup()
    resolve(true)
  }
  const check = (): void => {
    if (worker.state === 'activated' && container.controller === worker) finish()
  }
  container.addEventListener?.('controllerchange', check)
  worker.addEventListener?.('statechange', check)
  startupActivationObservers.add(check)
  check()
  return awaitStartup(context, promise, () => {
    if (settled) return
    settled = true
    cleanup()
    resolve(false)
  })
}

const adoptStartupRegistration = (container: ServiceWorkerContainer, registration: ServiceWorkerRegistration): void => {
  registrationReference = registration
  state.registration = registration
  state.registrationState = 'registered'
  state.error = null
  state.registrationError = null
  if (!state.offlineReady) state.offlineReadiness = 'checking'
  attachServiceWorkerListeners()
  attachRegistrationListeners(registration)
  markController(container.controller ?? null)
  if (registration.waiting) markUpdateReady(registration)
  requestOfflineReadiness()
  notifyReady(registration)
}
const watchOfflineStartupRegistration = (registration: ServiceWorkerRegistration): void => {
  const previousCheck = offlineStartupRegistrationChecks.get(registration)
  if (previousCheck) {
    previousCheck()
    return
  }
  const documentRelease = startupDocumentRelease
  if (!validRelease(documentRelease) || documentRelease !== startupBundleRelease) return

  const checkStartupWorkers = (): void => {
    if (pageSuspended || state.mode === 'retirement' || registrationReference !== registration) return
    const active = currentServiceWorkerContainer()?.controller ?? registration.active
    const waiting = registration.waiting
    const installing = registration.installing
    if (installing && installing.state !== 'installed' && installing.state !== 'redundant') {
      startupAutomaticRefreshDisabled = true
      return
    }

    const workers = [...new Set([active, waiting].filter((worker): worker is ServiceWorker => Boolean(worker)))]
    for (const worker of workers) {
      if (startupWorkerReleases.has(worker) || offlineStartupProbing.has(worker)) continue
      offlineStartupProbing.add(worker)
      void probeStartupWorker(null, registration, worker).then(result => {
        offlineStartupProbing.delete(worker)
        if (result.kind === 'value' && result.value?.release && registrationReference === registration && workerTargets(registration).includes(worker))
          checkStartupWorkers()
      })
    }

    // Keep incompatible active-worker reloads locked while allowing a verified matching waiter to join the vote.
    const activeMatches = !active || startupWorkerReleases.get(active) === documentRelease
    const waitingMatches = !waiting || startupWorkerReleases.get(waiting) === documentRelease
    startupAutomaticRefreshDisabled = !activeMatches || !waitingMatches
    if (!waiting || !waitingMatches) return
    if (activeMatches) {
      if (!pageSuspended) void requestPwaUpdateAutomatically()
      return
    }
    queueMicrotask(() => {
      if (
        !pageSuspended &&
        !startupGateActive &&
        registrationReference === registration &&
        registration.waiting === waiting &&
        !offlineStartupPrepared.has(waiting) &&
        prepareWaitingWorker(registration, waiting)
      )
        offlineStartupPrepared.add(waiting)
    })
  }

  const observeInstallingWorker = (): void => {
    const installing = registration.installing
    if (!installing) return
    startupAutomaticRefreshDisabled = true
    if (offlineStartupInstallations.has(installing)) return
    offlineStartupInstallations.add(installing)
    installing.addEventListener?.('statechange', () => {
      if (installing.state === 'installed' || installing.state === 'redundant') checkStartupWorkers()
    })
  }
  offlineStartupRegistrationChecks.set(registration, checkStartupWorkers)

  registration.addEventListener?.('updatefound', observeInstallingWorker)
  observeInstallingWorker()
  checkStartupWorkers()
}

const attachOfflineStartupRegistration = (): void => {
  const registration = registrationReference
  if (registration) {
    watchOfflineStartupRegistration(registration)
    return
  }
  if (registrationInFlight) {
    void registrationInFlight
      .then(attached => {
        if (attached && !pageSuspended) watchOfflineStartupRegistration(attached)
      })
      .catch(notifyError)
    return
  }

  const container = currentServiceWorkerContainer()
  if (!container) return
  state.registrationState = 'registering'
  state.error = null
  state.registrationError = null
  state.offlineReadiness = 'checking'
  // This background path reuses an existing registration and never calls registration.update().
  const discoverRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
    let existing: ServiceWorkerRegistration | null | undefined = null
    if (typeof container.getRegistration === 'function') {
      try {
        existing = await container.getRegistration(SERVICE_WORKER_SCOPE)
      } catch {
        // A failed discovery can still recover through the normal registration path.
      }
    }
    if (!existing) return registerNow()
    adoptStartupRegistration(container, existing)
    return existing
  }
  const discovery = discoverRegistration()
  const inFlight = discovery.finally(() => {
    registrationInFlight = undefined
  })
  registrationInFlight = inFlight
  void inFlight
    .then(attached => {
      if (attached && !pageSuspended) watchOfflineStartupRegistration(attached)
    })
    .catch(notifyError)
}

const deferStartupRefresh = (reason: string): 'continue' => {
  startupAutomaticRefreshDisabled = true
  startupExplicitRefreshAllowed = false
  startupRefreshDeferred.value = true
  state.preparation = 'deferred'
  state.preparationReason = reason
  return 'continue'
}

const reloadStaleBundleBeforeMount = async (
  context: StartupGateContext,
  registration: ServiceWorkerRegistration,
  worker: ServiceWorker
): Promise<'continue' | 'reloading'> => {
  if (!startupContextIsCurrent(context)) return 'continue'
  if (
    !validRelease(startupDocumentRelease) ||
    !validRelease(startupBundleRelease) ||
    startupDocumentRelease === startupBundleRelease ||
    worker.state !== 'activated' ||
    (currentServiceWorkerContainer()?.controller !== worker && registration.active !== worker) ||
    startupReloadIssued
  )
    return deferStartupRefresh('The stale application bundle could not be refreshed safely.')
  const safety = await awaitStartup(context, readSafetySnapshot())
  if (!startupContextIsCurrent(context)) return 'continue'
  if (safety.kind !== 'value') {
    if (safety.kind === 'cancelled') return 'continue'
    return deferStartupRefresh('The startup refresh safety check did not complete.')
  }
  if (startupNow() >= context.deadline) return deferStartupRefresh('The startup refresh check completed after the deadline.')
  if (worker.state !== 'activated' || (currentServiceWorkerContainer()?.controller !== worker && registration.active !== worker))
    return deferStartupRefresh('The active worker changed during the startup refresh check.')
  state.reloadSafe = safety.value.safe
  state.safetyRevision = safety.value.revision
  if (!safety.value.safe) return deferStartupRefresh('The startup refresh was deferred because this document is not safe to reload.')
  const activation = acceptedActivation
  startupReloadIssued = true
  startupAutomaticRefreshDisabled = true
  if (activation?.release === startupDocumentRelease && (activation.worker === worker || activation.activatedWorker === worker))
    reloadRequestedActivations.add(activation.nonce)
  deferredReloadWorker = null
  state.reloadNeeded = false
  if (!notifyNeedReload()) {
    startupReloadIssued = false
    return deferStartupRefresh('The update is ready. Use the update action to refresh this page.')
  }
  startupRefreshDeferred.value = false
  return 'reloading'
}

const finishStartupAfterActivation = (context: StartupGateContext, activation: AcceptedActivation): 'continue' | 'reloading' => {
  if (!startupContextIsCurrent(context)) return 'continue'
  if (startupActivationMatchesCurrentRelease(activation)) {
    startupRefreshDeferred.value = false
    startupAutomaticRefreshDisabled = false
    startupExplicitRefreshAllowed = false
    deferredReloadWorker = null
    state.reloadNeeded = false
    return 'continue'
  }
  if (startupNow() >= context.deadline) return deferStartupRefresh('The matching worker activated after the startup deadline.')
  if (!startupDocumentRelease || activation.release !== startupDocumentRelease || !validRelease(startupBundleRelease) || startupReloadIssued)
    return deferStartupRefresh('The active service worker or document release could not be verified safely.')
  startupReloadIssued = true
  startupAutomaticRefreshDisabled = true
  startupRefreshDeferred.value = false
  reloadRequestedActivations.add(activation.nonce)
  deferredReloadWorker = null
  state.reloadNeeded = false
  if (!notifyNeedReload()) {
    startupReloadIssued = false
    return deferStartupRefresh('The update is ready. Use the update action to refresh this page.')
  }
  return 'reloading'
}

const runPwaStartupGate = async (bundleRelease: string, callbacks: PwaLifecycleCallbacks): Promise<'continue' | 'reloading'> => {
  callbackSet = { ...callbackSet, ...callbacks }
  attachWindowListeners()
  observeBrowserConnection()
  if (!initialConnectionProbeStarted && state.mode !== 'retirement') {
    initialConnectionProbeStarted = true
    if (connectionProbeAllowed()) void retryServerConnection()
    else setConnection(state.onlineHint === false ? 'offline' : 'server-unavailable')
  }
  if (state.mode === 'retirement') {
    state.registrationState = 'unsupported'
    markOfflineUnavailable()
    return 'continue'
  }

  const epoch = ++startupGateEpoch
  const context: StartupGateContext = {
    epoch,
    deadline: startupNow() + STARTUP_GATE_DEADLINE_MS,
    cancellations: new Set(),
    cancelled: false
  }
  activeStartupGate = context
  startupGateActive = true
  startupRefreshDeferred.value = false
  startupReloadIssued = false
  startupExplicitRefreshAllowed = false
  startupDocumentRelease = readDocumentRelease()
  startupBundleRelease = validRelease(bundleRelease) ? bundleRelease : null
  const releaseEvidenceValid = startupDocumentRelease !== null && startupBundleRelease !== null
  startupAutomaticRefreshDisabled = true

  const leave = (result: 'continue' | 'reloading'): 'continue' | 'reloading' => {
    if (activeStartupGate === context) activeStartupGate = null
    startupGateActive = false
    for (const cancel of [...context.cancellations]) cancel()
    context.cancellations.clear()
    return result
  }
  const continueDeferred = (reason: string): 'continue' => {
    if (!startupContextIsCurrent(context)) return 'continue'
    return deferStartupRefresh(reason)
  }

  try {
    const container = currentServiceWorkerContainer()
    if (!container) {
      state.registrationState = 'unsupported'
      state.offlineReadiness = 'unavailable'
      startupAutomaticRefreshDisabled = true
      if (releaseEvidenceValid && startupDocumentRelease !== startupBundleRelease)
        return leave(continueDeferred('The service worker is unavailable while the document and application releases differ.'))
      return leave('continue')
    }
    if (releaseEvidenceValid && startupDocumentRelease === startupBundleRelease && hasNavigator() && navigator.onLine === false) {
      attachOfflineStartupRegistration()
      return leave('continue')
    }
    if (typeof container.getRegistration !== 'function') {
      state.registrationState = 'unsupported'
      state.offlineReadiness = 'unavailable'
      startupAutomaticRefreshDisabled = true
      if (releaseEvidenceValid && startupDocumentRelease !== startupBundleRelease)
        return leave(continueDeferred('The service worker is unavailable while the document and application releases differ.'))
      return leave('continue')
    }

    let registration: ServiceWorkerRegistration | null = null
    state.registrationState = 'registering'
    const existing = await awaitStartup(context, container.getRegistration(SERVICE_WORKER_SCOPE))
    if (existing.kind !== 'value') {
      if (existing.kind === 'cancelled') return leave('continue')
      if (!registrationReference) return leave(continueDeferred('The service worker registration could not be checked before startup.'))
      registration = registrationReference
    } else {
      registration = existing.value ?? registrationReference
    }
    if (!registration) {
      const installing = await awaitStartup(context, container.register(SERVICE_WORKER_PATH, { scope: SERVICE_WORKER_SCOPE }))
      if (installing.kind !== 'value') {
        if (installing.kind === 'cancelled') return leave('continue')
        setRegistrationError(new Error('The service worker could not be registered before startup.'))
        return leave(continueDeferred('The service worker release could not be verified before startup.'))
      }
      registration = installing.value
    }
    if (!startupContextIsCurrent(context)) return leave('continue')
    adoptStartupRegistration(container, registration)
    if (!releaseEvidenceValid) {
      startupAutomaticRefreshDisabled = true
      return leave('continue')
    }
    if (hasNavigator() && navigator.onLine === false) {
      if (startupDocumentRelease !== startupBundleRelease) return leave(continueDeferred('The document and application releases differ while offline.'))
      watchOfflineStartupRegistration(registration)
      return leave('continue')
    }
    const documentRelease = startupDocumentRelease as string
    const currentController = container.controller
    if (!currentController && documentRelease === startupBundleRelease && !registration.active && !registration.waiting) {
      startupAutomaticRefreshDisabled = false
      return leave('continue')
    }

    const identities = new Map<ServiceWorker, StartupWorkerIdentity>()
    const disableAutomaticRefreshForUnverifiedWaitingWorker = (): void => {
      const waiting = registration.waiting
      startupAutomaticRefreshDisabled = Boolean(waiting && identities.get(waiting)?.release !== documentRelease)
    }
    const workers = [...new Set([currentController, registration.active, registration.waiting].filter((worker): worker is ServiceWorker => Boolean(worker)))]
    const pendingProbes = workers.map(worker => ({
      worker,
      promise: probeStartupWorker(context, registration, worker)
    }))
    while (pendingProbes.length) {
      const completed = await Promise.race(
        pendingProbes.map(async pending => ({
          pending,
          result: await pending.promise
        }))
      )
      const pendingIndex = pendingProbes.indexOf(completed.pending)
      if (pendingIndex >= 0) pendingProbes.splice(pendingIndex, 1)
      if (!startupContextIsCurrent(context)) return leave('continue')
      if (completed.result.kind !== 'value' || !completed.result.value?.release) continue
      const identity = completed.result.value
      identities.set(identity.worker, identity)
      if (identity.release !== documentRelease) continue
      if (identity.worker === currentController && documentRelease === startupBundleRelease && container.controller === currentController) {
        disableAutomaticRefreshForUnverifiedWaitingWorker()
        return leave('continue')
      }
      if (
        documentRelease !== startupBundleRelease &&
        identity.worker === currentController &&
        container.controller === currentController &&
        currentController?.state === 'activated'
      )
        return leave(await reloadStaleBundleBeforeMount(context, registration, currentController))
      if (identity.worker === registration.active) {
        if (documentRelease === startupBundleRelease) {
          disableAutomaticRefreshForUnverifiedWaitingWorker()
          return leave('continue')
        }
        if (identity.worker.state === 'activated') return leave(await reloadStaleBundleBeforeMount(context, registration, identity.worker))
      }
      if (identity.worker === registration.waiting) break
    }

    const activeWorker = registration.active
    const activeIdentity = activeWorker ? (identities.get(activeWorker) ?? null) : null
    if (activeWorker && activeIdentity?.release === documentRelease) {
      if (documentRelease === startupBundleRelease) {
        disableAutomaticRefreshForUnverifiedWaitingWorker()
        return leave('continue')
      }
      if (activeWorker.state === 'activated') return leave(await reloadStaleBundleBeforeMount(context, registration, activeWorker))
      const activation = acceptedActivation
      if (
        container.controller === activeWorker &&
        activation?.release === documentRelease &&
        (activation.worker === activeWorker || activation.activatedWorker === activeWorker)
      )
        return leave(finishStartupAfterActivation(context, activation))
      if (activation?.release === documentRelease && (activation.worker === activeWorker || activation.activatedWorker === activeWorker)) {
        const activated = await waitForStartupActivation(context, container, registration, activeWorker, documentRelease)
        if (!startupContextIsCurrent(context)) return leave('continue')
        if (activated.kind === 'value' && activated.value) return leave(finishStartupAfterActivation(context, activated.value))
        if (activated.kind === 'cancelled') return leave('continue')
      }
      const controlling =
        container.controller === activeWorker ? { kind: 'value' as const, value: true } : await waitForStartupController(context, container, activeWorker)
      if (!startupContextIsCurrent(context)) return leave('continue')
      if (controlling.kind === 'cancelled') return leave('continue')
      if (controlling.kind === 'value' && controlling.value) return leave(await reloadStaleBundleBeforeMount(context, registration, activeWorker))
      return leave(continueDeferred('The matching active worker did not control this document before startup.'))
    }

    let targetWaiting = registration.waiting
    let targetIdentity = targetWaiting ? (identities.get(targetWaiting) ?? null) : null
    if (targetWaiting && (!targetIdentity || targetIdentity.release !== documentRelease)) {
      const previousWaiting = targetWaiting
      if (startupNow() >= context.deadline)
        return leave(continueDeferred('The startup release check reached its deadline before waiting for a matching worker.'))
      let updatePromise: Promise<ServiceWorkerRegistration> | null = null
      try {
        if (!registration.installing) {
          if (typeof registration.update !== 'function') throw new Error('The browser cannot check service worker updates.')
          updatePromise = registration.update()
        }
      } catch (error) {
        setRegistrationError(error, 'The service worker update check failed.')
        return leave(continueDeferred('A safe matching worker could not be found.'))
      }
      if (updatePromise) {
        const updateResult = await awaitStartup(context, updatePromise)
        if (updateResult.kind !== 'value') {
          if (updateResult.kind === 'cancelled') return leave('continue')
          return leave(continueDeferred('The bounded service worker update check did not complete.'))
        }
      }
      if (!startupContextIsCurrent(context)) return leave('continue')
      const changedWaiting = await waitForNewStartupWaitingWorker(context, registration, previousWaiting)
      if (!startupContextIsCurrent(context)) return leave('continue')
      if (changedWaiting.kind !== 'value' || !changedWaiting.value) {
        if (changedWaiting.kind === 'cancelled') return leave('continue')
        return leave(continueDeferred('No new matching worker finished installation before startup.'))
      }
      targetWaiting = changedWaiting.value
      const identity = await probeStartupWorker(context, registration, targetWaiting)
      if (!startupContextIsCurrent(context)) return leave('continue')
      if (identity.kind !== 'value' || !identity.value?.release) {
        return leave(continueDeferred('The newly installed worker did not provide a verifiable release.'))
      }
      targetIdentity = identity.value
    } else if (!targetWaiting) {
      if (startupNow() >= context.deadline)
        return leave(continueDeferred('The startup release check reached its deadline before waiting for a matching worker.'))
      let updatePromise: Promise<ServiceWorkerRegistration> | null = null
      try {
        if (!registration.installing) {
          if (typeof registration.update !== 'function') throw new Error('The browser cannot check service worker updates.')
          updatePromise = registration.update()
        }
      } catch (error) {
        setRegistrationError(error, 'The service worker update check failed.')
        return leave(continueDeferred('A safe matching worker could not be found.'))
      }
      if (updatePromise) {
        const updateResult = await awaitStartup(context, updatePromise)
        if (updateResult.kind !== 'value') {
          if (updateResult.kind === 'cancelled') return leave('continue')
          return leave(continueDeferred('The bounded service worker update check did not complete.'))
        }
      }
      if (!startupContextIsCurrent(context)) return leave('continue')
      const changedWaiting = await waitForNewStartupWaitingWorker(context, registration, null)
      if (!startupContextIsCurrent(context)) return leave('continue')
      if (changedWaiting.kind !== 'value' || !changedWaiting.value) {
        if (changedWaiting.kind === 'cancelled') return leave('continue')
        return leave(continueDeferred('No matching worker finished installation before startup.'))
      }
      targetWaiting = changedWaiting.value
      const identity = await probeStartupWorker(context, registration, targetWaiting)
      if (!startupContextIsCurrent(context)) return leave('continue')
      if (identity.kind !== 'value' || !identity.value?.release) {
        return leave(continueDeferred('The newly installed worker did not provide a verifiable release.'))
      }
      targetIdentity = identity.value
    }

    if (!targetWaiting || !targetIdentity || targetIdentity.release !== documentRelease)
      return leave(continueDeferred('The waiting worker does not match the current document release.'))
    if (startupNow() >= context.deadline) return leave(continueDeferred('The matching worker was found after the startup deadline.'))

    const prepared = prepareWaitingWorker(registration, targetWaiting)
    if (!prepared) return leave(continueDeferred('The matching worker was replaced before it could receive safe votes.'))
    const activated = await waitForStartupActivation(context, container, registration, targetWaiting, documentRelease)
    if (!startupContextIsCurrent(context)) return leave('continue')
    if (activated.kind !== 'value' || !activated.value) {
      if (activated.kind === 'cancelled') return leave('continue')
      return leave(continueDeferred('The matching worker did not activate before the startup deadline.'))
    }
    return leave(finishStartupAfterActivation(context, activated.value))
  } catch (error) {
    if (context.cancelled || pageSuspended) return leave('continue')
    notifyError(error)
    return leave(continueDeferred('The service worker release could not be verified safely.'))
  } finally {
    if (activeStartupGate === context) activeStartupGate = null
    startupGateActive = false
    context.cancellations.clear()
  }
}

/** Reconcile document, Vite bundle, and service-worker releases before mounting. */
export function preparePwaStartup(bundleRelease: string, callbacks: PwaLifecycleCallbacks = {}): Promise<'continue' | 'reloading'> {
  callbackSet = { ...callbackSet, ...callbacks }
  if (!startupGatePromise) startupGatePromise = runPwaStartupGate(bundleRelease, callbacks)
  return startupGatePromise
}

const requestPwaUpdateAutomatically = (): Promise<boolean> => {
  if ((startupRefreshDeferred.value || startupAutomaticRefreshDisabled) && !startupExplicitRefreshAllowed) return Promise.resolve(false)
  if (updateRequestInFlight) return updateRequestInFlight
  updateRequestInFlight = requestUpdate().finally(() => {
    updateRequestInFlight = undefined
  })
  return updateRequestInFlight
}

export function requestPwaUpdate(): Promise<boolean> {
  startupExplicitRefreshAllowed = true
  return requestExplicitRefreshForAcceptedWorker().then(refreshed => refreshed || requestPwaUpdateAutomatically())
}

// Capture installability before registration starts as browsers can dispatch
// the event as soon as the document becomes interactive.
attachWindowListeners()

export const PWA_SERVICE_WORKER_PATH = SERVICE_WORKER_PATH
export const PWA_SERVICE_WORKER_SCOPE = SERVICE_WORKER_SCOPE
export const PWA_SERVER_PROBE_PATH = SERVER_PROBE_PATH
