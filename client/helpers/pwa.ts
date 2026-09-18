import { reactive, readonly } from 'vue'
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
const PROBE_DEADLINE_MS = 5_000
const WAITING_WORKER_DEADLINE_MS = 8_000

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
  connection: configuredMode === 'retirement' ? 'server-unavailable' : 'checking',
  connectionState: configuredMode === 'retirement' ? 'server-unavailable' : 'checking',
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
let updateRequestInFlight: Promise<boolean> | undefined
let callbackSet: PwaLifecycleCallbacks = {}
const observedWorkers = new WeakSet<ServiceWorker>()
let acceptedActivation: AcceptedActivation | null = null
let deferredReloadWorker: ServiceWorker | null = null
const reloadRequestedActivations = new Set<string>()
let readyNotified = false
let offlineReadinessEpoch = 0
let offlineReadyNotifiedRelease: string | null = null
let updateReadyWorker: ServiceWorker | null = null
let pageSuspended = false
let updateWakeups: BroadcastChannel | null = null
let preparationTimer: ReturnType<typeof setTimeout> | null = null
const replyPorts = new Map<MessagePort, () => void>()
const updateReplyPorts = new Map<ServiceWorkerMessageTarget, MessagePort>()
const UPDATE_WAKEUP_CHANNEL = 'tsepistle-pwa-update-connect-v1'

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
    try { worker.postMessage(envelope) } catch { /* The worker became redundant. */ }
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
  } catch { /* Without a wakeup, unresponsive peers make update voting defer. */ }
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
    return
  }
  acceptedActivation = { nonce, workerId, release, worker, activatedWorker }
  deferredReloadWorker = null
  state.reloadNeeded = false
  state.updateReady = true
  state.updateState = 'activating'
}

const maybeReloadAcceptedWorker = async (worker: ServiceWorker): Promise<void> => {
  if (pageSuspended) return
  const activation = acceptedActivation
  if (!activation || (activation.worker !== worker && activation.activatedWorker !== worker) || reloadRequestedActivations.has(activation.nonce)) return
  deferredReloadWorker = worker
  const sequence = ++safetySequence
  const snapshot = await readSafetySnapshot()
  if (sequence !== safetySequence || acceptedActivation !== activation) return
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
  try {
    callbackSet.onNeedReload?.()
  } catch {
    // Lifecycle callbacks are observers and must not break the update.
  }
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

const handleOnlineHint = (): void => {
  connectionEpoch += 1
  activeProbe?.controller.abort()
  state.onlineHint = true
  void retryServerConnection()
}

const handleOfflineHint = (): void => {
  connectionEpoch += 1
  activeProbe?.controller.abort()
  state.onlineHint = false
  state.serverReachable = null
  state.serverHealthy = null
  setConnection('offline')
}

const attachWindowListeners = (): void => {
  if (!hasWindow() || installListenersAttached) return
  installListenersAttached = true
  updateStandaloneState()
  attachUpdateWakeups()
  window.addEventListener('pagehide', () => {
    pageSuspended = true
    safetySequence += 1
    offlineReadinessEpoch += 1
    clearPreparationTimer()
    for (const close of replyPorts.values()) close()
    updateWakeups?.close()
    updateWakeups = null
  })
  window.addEventListener('pageshow', () => {
    pageSuspended = false
    attachUpdateWakeups()
    requestOfflineReadiness()
    const waiting = registrationReference?.waiting
    if (waiting) postToWorker(waiting, { type: 'PWA_CONNECT' })
    retryDeferredReload()
  })
  window.addEventListener(INSTALL_EVENT, captureInstallPrompt as EventListener)
  window.addEventListener(INSTALLED_EVENT, markInstalled as EventListener)
  window.addEventListener('online', handleOnlineHint)
  window.addEventListener('offline', handleOfflineHint)
  window.addEventListener('visibilitychange', () => {
    updateStandaloneState()
    if (document.visibilityState === 'hidden') return
    requestOfflineReadiness()
    retryDeferredReload()
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
  if (state.mode === 'retirement') {
    state.registrationState = 'unsupported'
    markOfflineUnavailable()
    return Promise.resolve(null)
  }
  if (!initialConnectionProbeStarted) {
    initialConnectionProbeStarted = true
    void retryServerConnection()
  }
  if (registrationReference) return Promise.resolve(registrationReference)
  if (registrationInFlight) return registrationInFlight
  const scheduled = scheduleRegistration()
  registrationInFlight = scheduled.finally(() => {
    registrationInFlight = undefined
  })
  return registrationInFlight
}

export async function retryServerConnection(): Promise<boolean> {
  const epoch = ++connectionEpoch
  activeProbe?.controller.abort()
  if (!hasWindow() || !hasNavigator()) {
    state.serverReachable = null
    state.serverHealthy = null
    setConnection('server-unavailable')
    return false
  }
  state.onlineHint = typeof navigator.onLine === 'boolean' ? navigator.onLine : null
  state.serverReachable = null
  state.serverHealthy = null
  setConnection('checking')
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
  void reportReloadSafety()
  const request = activeSafetyRequest
  if (request && registrationReference && workerTargets(registrationReference).includes(request.target as ServiceWorker)) {
    void reportReloadSafety(request.context, request.target)
  } else if (request) {
    activeSafetyRequest = null
  }
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
  updateReadyWorker = waiting
  state.updateReady = true
  state.updateState = 'ready'
  state.preparation = 'checking'
  attachUpdateWakeups()
  updateWakeups?.postMessage('connect')
  startPreparationTimer()
  postToWorker(waiting, { type: PREPARE_UPDATE_MESSAGE })
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
