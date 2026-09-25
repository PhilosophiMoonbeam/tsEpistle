import { fetchOfflinePageSnapshot, fetchOfflinePrivatePageSnapshot, fetchPagesByTag, type PageListRow } from './pages-api.ts'
import { OfflineGenerationFencedError, OfflinePolicyRevisionFencedError, OfflineStorageError, type OfflineStorage } from './offline-storage.ts'
import { encryptOfflinePrivateRecord, generateOfflineReadingPairId, type OfflinePrivateRecordSelectors } from './offline-crypto.ts'
import { isCurrentOfflineReadingHandle, type OfflineReadingHandleV1 } from './offline-session.ts'
import {
  OfflinePrivateSearchDocumentV1Schema,
  OfflineSnapshotSelectorSchema,
  OFFLINE_AUTOMATIC_PAGE_LIMIT,
  OfflineSyncDiagnosticsSchema,
  type OfflinePagePolicyRecord,
  type OfflinePageSnapshotV1,
  type OfflinePolicySnapshot,
  type OfflinePolicyState,
  type OfflinePrivateSearchDocumentV1,
  type OfflinePrivateSnapshotResponseV1,
  type OfflineSnapshotProvenance,
  type OfflineSnapshotSelector,
  type OfflineSyncDiagnostics,
  type OfflineSyncDiagnosticStatus
} from '../../shared/offline.ts'

export type OfflineSyncFetch = Parameters<typeof fetchOfflinePageSnapshot>[0]

export type OfflineSyncAccount = {
  readonly accountId: number
  readonly authVersion: number
  readonly verified: boolean
}

export type OfflineSyncOutcome = 'success' | 'offline' | 'error' | 'unavailable'
export const OFFLINE_SYNC_COORDINATOR_KEY = 'offline-sync-coordinator'

export type OfflineSyncCoordinatorOptions = {
  storage: OfflineStorage
  siteId: string
  /** Private policy site identity; canonical origin remains siteId. */
  privateSiteId?: string
  fetchImpl: OfflineSyncFetch
  now?: () => string
  isOnline?: () => boolean
  isForeground?: () => boolean
  isRetired?: () => boolean
  /** Optional identity fence for callers that rotate the current client identity. */
  isIdentityValid?: () => boolean
  /** Current server-verified account, or null while signed out/unverified. */
  getCurrentAccount?: () => OfflineSyncAccount | null
  /** Current unlocked private reading handle, if any. */
  getReadingHandle?: () => OfflineReadingHandleV1 | null
  maxConcurrentFetches?: number
  onDiagnostics?: (diagnostics: OfflineSyncDiagnostics) => void | Promise<void>
}

export type OfflineSyncPassResult = {
  status: OfflineSyncDiagnosticStatus
  /** A pass can be complete/partial, offline, or an observed fatal error. */
  outcome: Exclude<OfflineSyncOutcome, 'unavailable'>
  /** Alias useful to callers that model outcomes by kind. */
  kind: Exclude<OfflineSyncOutcome, 'unavailable'>
  attempted: number
  saved: number
  retained: number
  removed: number
  failed: number
  pending: number
  /** Present for an observed error; null for successful, offline, and cancelled passes. */
  error: string | null
  sessionGeneration: number
  policyRevision: number
  diagnostics: OfflineSyncDiagnostics
}

export type OfflineSyncUnavailableResult = {
  status: 'unavailable'
  outcome: 'unavailable'
  kind: 'unavailable'
  error: string
  attempted: 0
  saved: 0
  retained: 0
  removed: 0
  failed: 0
  pending: 0
  sessionGeneration: null
  policyRevision: null
  diagnostics: null
}

export type OfflineSyncResult = OfflineSyncPassResult | OfflineSyncUnavailableResult
/** Public alias for dependency-injected callers that name the service result explicitly. */
export type OfflineSyncServiceResult = OfflineSyncResult

export type OfflineSyncService = {
  reconcile: (reason?: string) => Promise<OfflineSyncResult>
  readOfflinePolicy?: () => Promise<OfflinePolicySnapshot>
  readSnapshotCorpus?: (selector?: OfflineSnapshotSelector) => Promise<Awaited<ReturnType<OfflineStorage['readSnapshotCorpus']>>>
  setManualOfflineIntent?: (selector: OfflineSnapshotSelector, selected: boolean) => Promise<OfflinePagePolicyRecord>
  removeOfflinePage?: (selector: OfflineSnapshotSelector) => Promise<OfflinePagePolicyRecord>
  recordEligibleReaderVisit?: (selector: OfflineSnapshotSelector) => Promise<OfflinePagePolicyRecord>
}

type Candidate = {
  selector: OfflineSnapshotSelector
  tagNames: string[]
}

type MutablePassResult = {
  attempted: number
  saved: number
  retained: number
  removed: number
  failed: number
  pending: number
}

type OperationContext = {
  epoch: number
  controller: AbortController
  signal: AbortSignal
}

const LIFECYCLE_SYNC_REASONS = new Set(['startup', 'pageshow', 'foreground', 'online', 'lifecycle'])
const LIFECYCLE_SYNC_INTERVAL_MS = 60_000

const PUBLIC_INELIGIBILITY_STATUSES = new Set([404, 410, 422])

const currentPrivateHandle = (options: OfflineSyncCoordinatorOptions, _siteId: string): OfflineReadingHandleV1 | null => {
  try {
    const account = options.getCurrentAccount?.()
    const handle = options.getReadingHandle?.()
    if (
      !account ||
      account.verified !== true ||
      !Number.isSafeInteger(account.accountId) ||
      account.accountId < 1 ||
      !Number.isSafeInteger(account.authVersion) ||
      !handle ||
      !isCurrentOfflineReadingHandle(handle)
    )
      return null
    if (
      handle.context.canonicalOrigin !== options.siteId ||
      handle.context.siteId !== (options.privateSiteId ?? options.siteId) ||
      handle.context.accountId !== account.accountId ||
      handle.context.authVersion !== account.authVersion
    )
      return null
    return handle
  } catch {
    return null
  }
}

const privateSearchDocument = (siteId: string, snapshot: OfflinePageSnapshotV1): OfflinePrivateSearchDocumentV1 =>
  OfflinePrivateSearchDocumentV1Schema.parse({
    schemaVersion: snapshot.schemaVersion,
    siteId,
    pageId: snapshot.pageId,
    locale: snapshot.locale,
    path: snapshot.path,
    canonicalPath: snapshot.canonicalPath,
    title: snapshot.title,
    description: snapshot.description,
    searchText: snapshot.searchText.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/gu, ' '),
    capturedAt: snapshot.capturedAt,
    sourceRevision: snapshot.sourceRevision,
    byteSize: 0
  })
class OfflineSyncInvalidatedError extends Error {
  constructor() {
    super('Offline synchronization was invalidated before it could finish.')
    this.name = 'OfflineSyncInvalidatedError'
  }
}
class OfflineSyncPrivateAuthorityError extends Error {
  constructor() {
    super('Private offline authority did not match the current account.')
    this.name = 'OfflineSyncPrivateAuthorityError'
  }
}

const DEFAULT_CONCURRENCY = 4
const MAX_DIAGNOSTIC_ERROR = 4096

const errorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const status = Reflect.get(error, 'status')
  return typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined
}

const isAuthoritativeIneligibility = (error: unknown): boolean => {
  const status = errorStatus(error)
  return status === 403 || status === 404 || status === 410 || status === 422
}

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > MAX_DIAGNOSTIC_ERROR ? message.slice(0, MAX_DIAGNOSTIC_ERROR) : message
}

const selectorKey = (selector: OfflineSnapshotSelector): string => `${selector.siteId}\u0000${selector.pageId}\u0000${selector.locale}`
const pageKey = (selector: OfflineSnapshotSelector): string => `${selector.siteId}\u0000${selector.pageId}`

const diagnostic = (state: OfflinePolicyState['syncDiagnostics'], patch: Partial<OfflineSyncDiagnostics>): OfflineSyncDiagnostics =>
  OfflineSyncDiagnosticsSchema.parse({ ...state, ...patch })

const emptyDiagnostics = (status: OfflineSyncDiagnosticStatus, message: string | null = null): OfflineSyncDiagnostics => {
  const now = new Date().toISOString()
  return OfflineSyncDiagnosticsSchema.parse({
    status,
    lastAttemptAt: now,
    lastSuccessAt: null,
    lastError: message,
    pendingCount: 0,
    retainedCount: 0,
    removedCount: 0
  })
}

const pageCandidate = (page: OfflinePagePolicyRecord): Candidate => ({
  selector: { siteId: page.siteId, pageId: page.pageId, locale: page.locale },
  tagNames: [...page.tagNames]
})

const rowCandidate = (siteId: string, row: PageListRow, tag: string): Candidate | null => {
  const selector = OfflineSnapshotSelectorSchema.safeParse({ siteId, pageId: row.id, locale: row.locale })
  if (!selector.success) return null
  return { selector: selector.data, tagNames: [tag] }
}

const mergeCandidate = (target: Map<string, Candidate>, candidate: Candidate): void => {
  const key = selectorKey(candidate.selector)
  const existing = target.get(key)
  if (!existing) {
    target.set(key, { selector: candidate.selector, tagNames: [...candidate.tagNames] })
    return
  }
  for (const tag of candidate.tagNames) if (!existing.tagNames.includes(tag)) existing.tagNames.push(tag)
  existing.tagNames.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

const provenanceFor = (page: OfflinePagePolicyRecord, candidate: Candidate): OfflineSnapshotProvenance => ({
  manual: page.manual,
  automatic: page.automatic,
  tagNames: candidate.tagNames.length > 0 ? candidate.tagNames : [...page.tagNames]
})

const hasNetwork = (options: OfflineSyncCoordinatorOptions): boolean => {
  if (options.isOnline) return options.isOnline()
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

const hasForeground = (options: OfflineSyncCoordinatorOptions): boolean => {
  if (options.isForeground) return options.isForeground()
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

const normalizeConcurrency = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_CONCURRENCY
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) throw new Error('Offline sync concurrency is invalid.')
  return value
}

const compareSelectors = (left: OfflineSnapshotSelector, right: OfflineSnapshotSelector): number => {
  if (left.siteId !== right.siteId) return left.siteId < right.siteId ? -1 : 1
  if (left.pageId !== right.pageId) return left.pageId - right.pageId
  return left.locale < right.locale ? -1 : left.locale > right.locale ? 1 : 0
}

const isCandidateEligible = (page: OfflinePagePolicyRecord, siteId: string): boolean =>
  page.siteId === siteId && !page.excluded && page.availability !== 'ineligible'

const rankedAutomaticPages = (policy: OfflinePolicySnapshot, siteId: string, asOf: string): OfflinePagePolicyRecord[] => {
  const asOfMs = Date.parse(asOf)
  const eligible = (page: OfflinePagePolicyRecord): boolean => isCandidateEligible(page, siteId)
  const visitCandidates = policy.pages
    .filter(
      (page: OfflinePagePolicyRecord) =>
        eligible(page) && page.visitCount > 0 && page.lastVisitedAt !== null && asOfMs - Date.parse(page.lastVisitedAt) < 60 * 24 * 60 * 60 * 1000
    )
    .sort((left: OfflinePagePolicyRecord, right: OfflinePagePolicyRecord) => {
      if (left.visitCount !== right.visitCount) return right.visitCount - left.visitCount
      if (left.lastVisitedAt !== right.lastVisitedAt)
        return left.lastVisitedAt === null ? 1 : right.lastVisitedAt === null ? -1 : right.lastVisitedAt.localeCompare(left.lastVisitedAt)
      return compareSelectors(
        { siteId: left.siteId, pageId: left.pageId, locale: left.locale },
        { siteId: right.siteId, pageId: right.pageId, locale: right.locale }
      )
    })
  const editedCandidates = policy.pages
    .filter((page: OfflinePagePolicyRecord) => eligible(page) && page.lastEditedAt !== null)
    .sort((left: OfflinePagePolicyRecord, right: OfflinePagePolicyRecord) => {
      const leftEditedAt = left.lastEditedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(left.lastEditedAt)
      const rightEditedAt = right.lastEditedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(right.lastEditedAt)
      if (leftEditedAt !== rightEditedAt) return rightEditedAt - leftEditedAt
      return compareSelectors(
        { siteId: left.siteId, pageId: left.pageId, locale: left.locale },
        { siteId: right.siteId, pageId: right.pageId, locale: right.locale }
      )
    })
  const candidates = editedCandidates[0] === undefined ? visitCandidates : [editedCandidates[0], ...visitCandidates]
  const selected: OfflinePagePolicyRecord[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = pageKey({ siteId: candidate.siteId, pageId: candidate.pageId, locale: candidate.locale })
    if (seen.has(key)) continue
    seen.add(key)
    selected.push(candidate)
  }
  return selected
}

const selectedWorkCount = (policy: OfflinePolicySnapshot, siteId: string): number =>
  policy.pages.filter(
    (page: OfflinePagePolicyRecord) =>
      page.siteId === siteId && !page.excluded && (page.manual || page.tag || (policy.state.automaticSavingEnabled && page.automatic))
  ).length

const bodyKeysFromCorpus = (corpus: { snapshots: readonly { siteId: string; pageId: number; locale: string }[] }): Set<string> =>
  new Set(corpus.snapshots.map(snapshot => `${snapshot.siteId}\u0000${snapshot.pageId}\u0000${snapshot.locale}`))

const countBodyKeysForPage = (bodyKeys: Set<string>, selector: OfflineSnapshotSelector): number => {
  const prefix = pageKey(selector) + '\u0000'
  let count = 0
  for (const key of bodyKeys) if (key.startsWith(prefix)) count += 1
  return count
}

const countRemovedBodyKeys = (before: Set<string>, after: Set<string>, siteId: string): number => {
  let count = 0
  const prefix = siteId + '\u0000'
  for (const key of before) if (key.startsWith(prefix) && !after.has(key)) count += 1
  return count
}

const outcomeForStatus = (status: OfflineSyncDiagnosticStatus): Exclude<OfflineSyncOutcome, 'unavailable'> => {
  if (status === 'complete') return 'success'
  if (status === 'offline') return 'offline'
  return 'error'
}

export const createOfflineSyncUnavailableResult = (reason: string): OfflineSyncUnavailableResult => ({
  status: 'unavailable',
  outcome: 'unavailable',
  kind: 'unavailable',
  error: errorMessage(reason),
  attempted: 0,
  saved: 0,
  retained: 0,
  removed: 0,
  failed: 0,
  pending: 0,
  sessionGeneration: null,
  policyRevision: null,
  diagnostics: null
})

export class OfflineSyncCoordinator {
  private readonly options: OfflineSyncCoordinatorOptions
  private readonly concurrency: number
  private activePass: Promise<OfflineSyncPassResult> | null = null
  private activeAbortController: AbortController | null = null
  private operationEpoch = 0
  private rerunRequested = false
  private pendingReason: string | null = null
  private disposed = false
  private retired = false
  private started = false
  private readonly onOnline = (): void => this.observe('online')
  private readonly onOffline = (): void => this.invalidateActiveOperation()
  private readonly onForeground = (): void => {
    if (hasForeground(this.options)) this.observe('foreground')
    else this.invalidateActiveOperation()
  }
  private readonly onPageHide = (): void => this.invalidateActiveOperation()
  private readonly onPageShow = (): void => {
    if (hasForeground(this.options)) this.observe('pageshow')
  }

  constructor(options: OfflineSyncCoordinatorOptions) {
    if (!options || typeof options !== 'object') throw new Error('Offline sync coordinator options are required.')
    if (typeof options.storage !== 'object' || options.storage === null || typeof options.storage.readOfflinePolicy !== 'function')
      throw new Error('Offline storage is required.')
    const siteId = typeof options.siteId === 'string' ? options.siteId.trim() : ''
    const privateSiteId = options.privateSiteId === undefined ? undefined : typeof options.privateSiteId === 'string' ? options.privateSiteId.trim() : ''
    if (siteId.length < 1 || siteId.length > 256 || (privateSiteId !== undefined && (privateSiteId.length < 1 || privateSiteId.length > 256)))
      throw new Error('Offline site identity is required.')
    if (typeof options.fetchImpl !== 'function') throw new Error('Offline sync fetch implementation is required.')
    this.options = { ...options, siteId, ...(privateSiteId === undefined ? {} : { privateSiteId }) }
    this.concurrency = normalizeConcurrency(options.maxConcurrentFetches)
  }

  private currentStorageHandle(): OfflineReadingHandleV1 | null {
    return currentPrivateHandle(this.options, this.options.siteId)
  }

  async readOfflinePolicy(): Promise<OfflinePolicySnapshot> {
    const handle = this.currentStorageHandle()
    return this.options.storage.readOfflinePolicy(handle ? { readingHandle: handle } : {})
  }

  async readSnapshotCorpus(selector?: OfflineSnapshotSelector): Promise<Awaited<ReturnType<OfflineStorage['readSnapshotCorpus']>>> {
    const handle = this.currentStorageHandle()
    return this.options.storage.readSnapshotCorpus(handle ? { readingHandle: handle, selector } : { selector })
  }

  async setManualOfflineIntent(selector: OfflineSnapshotSelector, selected: boolean): Promise<OfflinePagePolicyRecord> {
    const handle = this.currentStorageHandle()
    const policy = await this.readOfflinePolicy()
    return this.options.storage.setManualOfflineIntent(selector, selected, {
      expectedSessionGeneration: policy.sessionGeneration,
      expectedPolicyRevision: policy.state.policyRevision,
      ...(handle ? { readingHandle: handle } : {})
    })
  }

  async removeOfflinePage(selector: OfflineSnapshotSelector): Promise<OfflinePagePolicyRecord> {
    const handle = this.currentStorageHandle()
    const policy = await this.readOfflinePolicy()
    return this.options.storage.removeOfflinePage(selector, {
      expectedSessionGeneration: policy.sessionGeneration,
      expectedPolicyRevision: policy.state.policyRevision,
      ...(handle ? { readingHandle: handle } : {})
    })
  }

  async recordEligibleReaderVisit(selector: OfflineSnapshotSelector): Promise<OfflinePagePolicyRecord> {
    const handle = this.currentStorageHandle()
    const policy = await this.readOfflinePolicy()
    return this.options.storage.recordEligibleReaderVisit(selector, {
      expectedSessionGeneration: policy.sessionGeneration,
      expectedPolicyRevision: policy.state.policyRevision,
      ...(handle ? { readingHandle: handle } : {})
    })
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get isRetired(): boolean {
    return this.retired
  }

  start(): void {
    if (this.disposed || this.retired || this.started) return
    this.started = true
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline)
      window.addEventListener('offline', this.onOffline)
      window.addEventListener('pagehide', this.onPageHide)
      window.addEventListener('pageshow', this.onPageShow)
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onForeground)
    this.observe('startup')
  }

  stop(): void {
    if (this.started) {
      this.started = false
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', this.onOnline)
        window.removeEventListener('offline', this.onOffline)
        window.removeEventListener('pagehide', this.onPageHide)
        window.removeEventListener('pageshow', this.onPageShow)
      }
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onForeground)
    }
    this.invalidateActiveOperation()
  }

  retire(): void {
    if (this.retired) return
    this.retired = true
    this.invalidateActiveOperation()
    this.stop()
  }

  /** Invalidates a pass without permanently retiring the coordinator. */
  invalidateIdentity(): void {
    this.invalidateActiveOperation()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.invalidateActiveOperation()
    this.stop()
    this.rerunRequested = false
  }

  reconcile(reason = 'manual'): Promise<OfflineSyncPassResult> {
    if (this.disposed || this.retired) return Promise.resolve(this.inactiveResult())
    if (this.activePass) {
      // Preserve wakeups that arrive during an offline/cancelled pass. A recent
      // successful pass makes lifecycle followups cheap; explicit work wins.
      this.rerunRequested = true
      if (this.pendingReason === null || LIFECYCLE_SYNC_REASONS.has(this.pendingReason) || reason === 'manual') this.pendingReason = reason
      return this.activePass
    }
    const pass = this.runCoalescedPass(reason)
    this.activePass = pass
    void pass.then(
      () => {
        if (this.activePass === pass) this.activePass = null
      },
      () => {
        if (this.activePass === pass) this.activePass = null
      }
    )
    return pass
  }

  /** Starts a lifecycle pass and observes unexpected promise failures. */
  observe(reason = 'lifecycle'): void {
    void this.reconcile(reason).catch(error => {
      void this.publishBackgroundFailure(error).catch(() => {
        // A closed or unavailable store cannot accept a diagnostic; the initiating UI still owns the explicit result.
      })
    })
  }

  private invalidateActiveOperation(): void {
    this.operationEpoch += 1
    this.activeAbortController?.abort()
  }

  private canRun(): boolean {
    return !this.disposed && !this.retired && this.identityIsValid() && this.contextIsAvailable()
  }

  private contextIsAvailable(): boolean {
    try {
      return hasNetwork(this.options) && hasForeground(this.options)
    } catch {
      return false
    }
  }

  private identityIsValid(): boolean {
    try {
      if (this.options.isRetired?.() === true) return false
      return this.options.isIdentityValid ? this.options.isIdentityValid() : true
    } catch {
      return false
    }
  }

  private operationIsCurrent(context: OperationContext, requireContext: boolean): boolean {
    if (this.operationEpoch !== context.epoch || context.signal.aborted || this.disposed || this.retired) return false
    if (!this.identityIsValid()) return false
    return !requireContext || this.contextIsAvailable()
  }

  private assertCurrent(context: OperationContext, requireContext: boolean): void {
    if (this.operationIsCurrent(context, requireContext)) return
    context.controller.abort()
    throw new OfflineSyncInvalidatedError()
  }

  private async awaitCurrent<T>(promise: Promise<T>, context: OperationContext, requireContext: boolean): Promise<T> {
    try {
      const value = await promise
      this.assertCurrent(context, requireContext)
      return value
    } catch (error) {
      if (error instanceof OfflineSyncInvalidatedError) throw error
      if (!this.operationIsCurrent(context, requireContext)) {
        context.controller.abort()
        throw new OfflineSyncInvalidatedError()
      }
      throw error
    }
  }

  private cancellableFetch(context: OperationContext): OfflineSyncFetch {
    return (input, init) => {
      this.assertCurrent(context, true)
      const requestInit = { ...init, signal: context.signal } as Parameters<OfflineSyncFetch>[1]
      return this.awaitCurrent(this.options.fetchImpl(input, requestInit), context, true)
    }
  }

  private async runCoalescedPass(reason: string): Promise<OfflineSyncPassResult> {
    let result = await this.runPass(reason)
    while (this.rerunRequested && this.canRun()) {
      this.rerunRequested = false
      const nextReason = this.pendingReason ?? 'policy-change'
      this.pendingReason = null
      result = await this.runPass(nextReason)
    }
    this.rerunRequested = false
    this.pendingReason = null
    return result
  }

  private async runPass(reason: string): Promise<OfflineSyncPassResult> {
    const controller = new AbortController()
    const context: OperationContext = { epoch: this.operationEpoch, controller, signal: controller.signal }
    this.activeAbortController = controller
    const result: MutablePassResult = { attempted: 0, saved: 0, retained: 0, removed: 0, failed: 0, pending: 0 }
    let policy: OfflinePolicySnapshot | null = null
    try {
      const policyHandle = currentPrivateHandle(this.options, this.options.siteId)
      policy = await this.awaitCurrent(this.options.storage.readOfflinePolicy(policyHandle ? { readingHandle: policyHandle } : {}), context, false)
      this.assertCurrent(context, false)
      const diagnostics = policy.state.syncDiagnostics
      const successAge = Date.parse(this.currentTime()) - Date.parse(diagnostics.lastSuccessAt ?? '')
      if (
        LIFECYCLE_SYNC_REASONS.has(reason) &&
        this.canRun() &&
        diagnostics.status === 'complete' &&
        diagnostics.pendingCount === 0 &&
        successAge >= 0 &&
        successAge < LIFECYCLE_SYNC_INTERVAL_MS
      ) {
        return this.makeResult('complete', policy.sessionGeneration, policy.state.policyRevision, diagnostics, result)
      }
      return await this.runPassBody(context, policy, result, reason === 'manual')
    } catch (error) {
      if (error instanceof OfflineSyncInvalidatedError) return this.cancelledResult(policy, result)
      return await this.errorResult(context, policy, result, error)
    } finally {
      // A failed concurrent worker can finish the pass while another request is still pending.
      controller.abort()
      if (this.activeAbortController === controller) this.activeAbortController = null
    }
  }

  private async runPassBody(
    context: OperationContext,
    policy: OfflinePolicySnapshot,
    result: MutablePassResult,
    retryDenied: boolean
  ): Promise<OfflineSyncPassResult> {
    const privateStorageHandle = currentPrivateHandle(this.options, this.options.siteId)
    const policySiteId = privateStorageHandle?.context.siteId ?? this.options.siteId
    // A verified account can still save public pages before private reading is
    // set up or while its vault is locked. This branch uses only the Guest
    // snapshot endpoint and the public policy; private pages require a handle.
    const storageOptions = <T extends Record<string, unknown>>(options: T): T & { readonly readingHandle?: OfflineReadingHandleV1 } =>
      privateStorageHandle ? { ...options, readingHandle: privateStorageHandle } : options
    const generation = policy.sessionGeneration
    let revision = policy.state.policyRevision
    const attemptAt = this.currentTime()
    if (!this.canRun()) {
      result.pending = selectedWorkCount(policy, policySiteId)
      const nextDiagnostics = diagnostic(policy.state.syncDiagnostics, {
        status: 'offline',
        lastAttemptAt: attemptAt,
        pendingCount: result.pending,
        retainedCount: 0,
        removedCount: 0
      })
      const persisted = await this.persistDiagnostics(nextDiagnostics, generation, revision, context, false)
      return this.makeResult('offline', generation, revision, persisted.diagnostics, result)
    }

    this.assertCurrent(context, true)
    const runningDiagnostics = diagnostic(policy.state.syncDiagnostics, {
      status: 'running',
      lastAttemptAt: attemptAt,
      lastError: null
    })
    const persistedRunning = await this.persistDiagnostics(runningDiagnostics, generation, revision, context, true)
    revision = persistedRunning.policyRevision
    this.assertCurrent(context, true)
    const cancellableFetch = this.cancellableFetch(context)
    let firstError: string | null = null
    let discoveryFailures = 0
    let fence = false
    let currentPolicy = policy
    let bodyKeys = new Set<string>()
    const retainedBodyKeys = new Set<string>()

    try {
      const corpusBefore = await this.awaitCurrent(
        this.options.storage.readSnapshotCorpus(storageOptions({ expectedSessionGeneration: generation, expectedPolicyRevision: revision })),
        context,
        true
      )
      bodyKeys = bodyKeysFromCorpus(corpusBefore)
      let topAutomatic: OfflinePagePolicyRecord[] = []
      try {
        topAutomatic = policy.state.automaticSavingEnabled
          ? await this.awaitCurrent(
              this.options.storage.selectTopAutomaticPages(
                storageOptions({
                  expectedSessionGeneration: generation,
                  expectedPolicyRevision: revision,
                  siteId: policySiteId,
                  limit: OFFLINE_AUTOMATIC_PAGE_LIMIT,
                  asOf: attemptAt
                })
              ),
              context,
              true
            )
          : []
        await this.awaitCurrent(
          this.options.storage.updateAutomaticSelections(
            topAutomatic.map(page => ({ siteId: page.siteId, pageId: page.pageId, locale: page.locale })),
            storageOptions({ expectedSessionGeneration: generation, expectedPolicyRevision: revision, siteId: policySiteId, asOf: attemptAt })
          ),
          context,
          true
        )
        const corpusAfterSelection = await this.awaitCurrent(
          this.options.storage.readSnapshotCorpus(storageOptions({ expectedSessionGeneration: generation, expectedPolicyRevision: revision })),
          context,
          true
        )
        const selectedBodyKeys = bodyKeysFromCorpus(corpusAfterSelection)
        result.removed += countRemovedBodyKeys(bodyKeys, selectedBodyKeys, policySiteId)
        bodyKeys = selectedBodyKeys
      } catch (error) {
        if (this.isFence(error)) return this.fencedResult(policy, result)
        if (this.isFatalStorageError(error)) throw error
        firstError = errorMessage(error)
        result.failed += 1
      }

      const tagResults = new Map<string, OfflineSnapshotSelector[]>()
      if (!fence && this.canRun()) {
        for (const tag of policy.state.selectedTags) {
          this.assertCurrent(context, true)
          try {
            const rows = await this.awaitCurrent(fetchPagesByTag(cancellableFetch, tag), context, true)
            const selectors: OfflineSnapshotSelector[] = []
            const seen = new Set<string>()
            for (const row of rows) {
              const candidate = rowCandidate(policySiteId, row, tag)
              if (!candidate) continue
              const key = selectorKey(candidate.selector)
              if (seen.has(key)) continue
              seen.add(key)
              selectors.push(candidate.selector)
            }
            tagResults.set(tag, selectors)
            await this.awaitCurrent(
              this.options.storage.synchronizeTagProvenance(
                tag,
                selectors,
                storageOptions({
                  expectedSessionGeneration: generation,
                  expectedPolicyRevision: revision
                })
              ),
              context,
              true
            )
          } catch (error) {
            if (error instanceof OfflineSyncInvalidatedError) throw error
            if (this.isFence(error)) {
              fence = true
              break
            }
            if (this.isFatalStorageError(error)) throw error
            discoveryFailures += 1
            result.failed += 1
            for (const page of policy.pages) {
              if (page.siteId !== policySiteId || !page.tag || !page.tagNames.includes(tag)) continue
              const retainedKey = selectorKey({ siteId: page.siteId, pageId: page.pageId, locale: page.locale })
              if (bodyKeys.has(retainedKey) && !retainedBodyKeys.has(retainedKey)) {
                retainedBodyKeys.add(retainedKey)
                result.retained += 1
              }
            }
            if (firstError === null) firstError = errorMessage(error)
          }
        }
      }

      if (fence) return this.fencedResult(policy, result)
      this.assertCurrent(context, true)
      currentPolicy = await this.awaitCurrent(
        this.options.storage.readOfflinePolicy(storageOptions({ expectedSessionGeneration: generation, expectedPolicyRevision: revision })),
        context,
        true
      )

      if (retryDenied) {
        const selectedPageIds = new Set(
          currentPolicy.pages.filter(page => page.siteId === policySiteId && !page.excluded && (page.manual || page.tag)).map(page => page.pageId)
        )
        const retryPageIds = new Set(
          currentPolicy.pages
            .filter(page => page.siteId === policySiteId && selectedPageIds.has(page.pageId) && page.availability === 'ineligible')
            .map(page => page.pageId)
        )
        // A denial covers every locale of a page. Clear the old observation, not
        // the user's selection/exclusion flags; only the server can admit a body.
        for (const page of currentPolicy.pages) {
          if (page.siteId !== policySiteId || !retryPageIds.has(page.pageId) || page.availability !== 'ineligible') continue
          await this.awaitCurrent(
            this.options.storage.setPageAvailability(
              { siteId: page.siteId, pageId: page.pageId, locale: page.locale },
              'unknown',
              storageOptions({
                expectedSessionGeneration: generation,
                expectedPolicyRevision: revision
              })
            ),
            context,
            true
          )
        }
        if (retryPageIds.size > 0)
          currentPolicy = await this.awaitCurrent(
            this.options.storage.readOfflinePolicy(storageOptions({ expectedSessionGeneration: generation, expectedPolicyRevision: revision })),
            context,
            true
          )
      }

      const candidates = new Map<string, Candidate>()
      for (const page of currentPolicy.pages) {
        if (page.siteId !== policySiteId) continue
        const automaticEligible = currentPolicy.state.automaticSavingEnabled && page.automatic
        if (page.excluded || (!page.manual && !page.tag && !automaticEligible)) continue
        mergeCandidate(candidates, pageCandidate(page))
      }
      for (const selectors of tagResults.values()) {
        for (const selector of selectors) {
          const page = currentPolicy.pages.find((candidate: OfflinePagePolicyRecord) => candidate.key === selectorKey(selector))
          if (page && !page.excluded) mergeCandidate(candidates, pageCandidate(page))
          else if (!page) mergeCandidate(candidates, { selector, tagNames: [] })
        }
      }

      const pagesByKey = new Map<string, OfflinePagePolicyRecord>(
        currentPolicy.pages.map((page: OfflinePagePolicyRecord): [string, OfflinePagePolicyRecord] => [page.key, page])
      )
      const entries: Candidate[] = [...candidates.values()]
      const queue = entries.slice()
      const queuedKeys = new Set(queue.map(candidate => selectorKey(candidate.selector)))
      const attemptedKeys = new Set<string>()
      const attemptedPageKeys = new Set<string>()
      const automaticSelectionKeys = new Set<string>(
        currentPolicy.state.automaticSavingEnabled
          ? currentPolicy.pages
              .filter(page => page.siteId === policySiteId && page.automatic && isCandidateEligible(page, policySiteId))
              .map(page => pageKey({ siteId: page.siteId, pageId: page.pageId, locale: page.locale }))
          : []
      )
      const ranked = currentPolicy.state.automaticSavingEnabled ? rankedAutomaticPages(currentPolicy, policySiteId, attemptAt) : []
      let nextAutomaticIndex = 0
      let nextQueueIndex = 0
      result.pending = queue.length

      const bodyForCandidate = (candidate: Candidate): number => countBodyKeysForPage(bodyKeys, candidate.selector)
      const retainBodyForCandidate = (candidate: Candidate): number => {
        const key = selectorKey(candidate.selector)
        if (!bodyKeys.has(key) || retainedBodyKeys.has(key)) return 0
        retainedBodyKeys.add(key)
        return 1
      }
      const updateQueuedCandidate = (candidate: Candidate): void => {
        const key = selectorKey(candidate.selector)
        const existing = queue.findIndex(entry => selectorKey(entry.selector) === key)
        if (existing >= 0) queue[existing] = candidate
        else {
          queue.push(candidate)
          queuedKeys.add(key)
          result.pending += 1
        }
      }
      const selectedAutomaticSelectors = (): OfflineSnapshotSelector[] => {
        const selected: OfflineSnapshotSelector[] = []
        for (const selectedKey of automaticSelectionKeys) {
          const selectedPage = [...pagesByKey.values()].find(
            page =>
              page.siteId === policySiteId &&
              page.automatic &&
              isCandidateEligible(page, policySiteId) &&
              pageKey({ siteId: page.siteId, pageId: page.pageId, locale: page.locale }) === selectedKey
          )
          if (selectedPage) selected.push({ siteId: selectedPage.siteId, pageId: selectedPage.pageId, locale: selectedPage.locale })
        }
        return selected
      }
      const refreshAutomaticSelectionKeys = (): void => {
        automaticSelectionKeys.clear()
        for (const page of pagesByKey.values()) {
          if (!page.automatic || !isCandidateEligible(page, policySiteId)) continue
          automaticSelectionKeys.add(pageKey({ siteId: page.siteId, pageId: page.pageId, locale: page.locale }))
        }
      }
      const selectReplacement = (): OfflinePagePolicyRecord | null => {
        while (nextAutomaticIndex < ranked.length) {
          const candidate = ranked[nextAutomaticIndex++]
          const immutableKey = pageKey({ siteId: candidate.siteId, pageId: candidate.pageId, locale: candidate.locale })
          if (automaticSelectionKeys.has(immutableKey) || attemptedPageKeys.has(immutableKey)) continue
          const current = pagesByKey.get(candidate.key)
          if (!current || !isCandidateEligible(current, policySiteId)) continue
          return current
        }
        return null
      }

      let commitTail: Promise<void> = Promise.resolve()
      const commit = async (operation: () => Promise<void>): Promise<void> => {
        let release!: () => void
        const previous = commitTail
        commitTail = new Promise<void>(resolve => {
          release = resolve
        })
        await this.awaitCurrent(previous, context, true)
        try {
          this.assertCurrent(context, true)
          await operation()
          this.assertCurrent(context, true)
        } finally {
          release()
        }
      }

      await runWorkers(Math.min(this.concurrency, Math.max(1, queue.length)), async () => {
        while (true) {
          this.assertCurrent(context, true)
          const index = nextQueueIndex++
          if (index >= queue.length) return
          const candidate = queue[index]
          const key = selectorKey(candidate.selector)
          result.pending = Math.max(0, result.pending - 1)
          if (attemptedKeys.has(key)) continue
          const page = pagesByKey.get(key)
          if (!page || page.excluded || page.availability === 'ineligible') continue
          attemptedKeys.add(key)
          attemptedPageKeys.add(pageKey(candidate.selector))
          result.attempted += 1
          let privateHandle: OfflineReadingHandleV1 | null = currentPrivateHandle(this.options, this.options.siteId)
          let privateAttempted = false
          try {
            this.assertCurrent(context, true)
            let snapshot: OfflinePageSnapshotV1 | null = null
            let privateResponse: OfflinePrivateSnapshotResponseV1 | null = null
            try {
              snapshot = await this.awaitCurrent(fetchOfflinePageSnapshot(cancellableFetch, candidate.selector.pageId), context, true)
            } catch (publicError) {
              const publicStatus = errorStatus(publicError)
              privateHandle = currentPrivateHandle(this.options, this.options.siteId)
              if (!privateHandle || publicStatus === undefined || !PUBLIC_INELIGIBILITY_STATUSES.has(publicStatus)) throw publicError
              privateAttempted = true
              privateResponse = await this.awaitCurrent(fetchOfflinePrivatePageSnapshot(cancellableFetch, candidate.selector.pageId), context, true)
              if (
                privateResponse.context.canonicalOrigin !== privateHandle.context.canonicalOrigin ||
                privateResponse.context.siteId !== privateHandle.context.siteId ||
                privateResponse.context.accountId !== privateHandle.context.accountId ||
                privateResponse.context.authVersion !== privateHandle.context.authVersion
              )
                throw new OfflineSyncPrivateAuthorityError()
              snapshot = privateResponse.snapshot
            }
            if (!snapshot || snapshot.pageId !== candidate.selector.pageId || snapshot.locale !== candidate.selector.locale)
              throw new Error('Offline snapshot identity did not match the discovered page.')
            this.assertCurrent(context, true)
            await commit(async () => {
              const currentPage = pagesByKey.get(key)
              if (!currentPage || currentPage.excluded || currentPage.availability === 'ineligible') return
              this.assertCurrent(context, true)
              if (!privateHandle) {
                await this.awaitCurrent(
                  this.options.storage.putSnapshot(this.options.siteId, snapshot!, {
                    expectedSessionGeneration: generation,
                    expectedPolicyRevision: revision,
                    provenance: provenanceFor(currentPage, candidate),
                    signal: context.signal
                  }),
                  context,
                  true
                )
              } else {
                const pairId = generateOfflineReadingPairId()
                const currentRevision = await this.awaitCurrent(
                  this.options.storage.privateSnapshotRevision(privateHandle, candidate.selector, {
                    expectedSessionGeneration: generation
                  }),
                  context,
                  true
                )
                const nextRecordRevision = currentRevision === null ? 1 : currentRevision + 1
                const selectors: OfflinePrivateRecordSelectors = {
                  pageId: snapshot!.pageId,
                  locale: snapshot!.locale,
                  recordRevision: nextRecordRevision,
                  pairId
                }
                const privatePayload: OfflinePrivateSnapshotResponseV1 = privateResponse ?? {
                  schemaVersion: 1,
                  audience: 'private',
                  context: {
                    canonicalOrigin: privateHandle.context.canonicalOrigin,
                    siteId: privateHandle.context.siteId,
                    accountId: privateHandle.context.accountId,
                    authVersion: privateHandle.context.authVersion
                  },
                  snapshot: snapshot!
                }
                const body = await encryptOfflinePrivateRecord(privateHandle, 'snapshot', privatePayload, selectors)
                const search = await encryptOfflinePrivateRecord(
                  privateHandle,
                  'search',
                  privateSearchDocument(privateHandle.context.siteId, snapshot!),
                  selectors
                )
                const nextPolicyRevision = revision + 1
                const nextPage = { ...currentPage, availability: 'available' as const }
                const nextState = { ...currentPolicy.state, policyRevision: nextPolicyRevision }
                await this.awaitCurrent(
                  this.options.storage.putPrivateSnapshotRecords(body, search, {
                    expectedSessionGeneration: generation,
                    expectedRecordRevision: currentRevision,
                    expectedPolicyRevision: revision,
                    readingHandle: privateHandle,
                    policyPage: nextPage,
                    policyState: nextState
                  }),
                  context,
                  true
                )
                revision = nextPolicyRevision
              }
              this.assertCurrent(context, true)
              bodyKeys.add(key)
              result.saved += 1
            })
          } catch (error) {
            if (error instanceof OfflineSyncInvalidatedError) throw error
            if (this.isFence(error)) {
              fence = true
              return
            }
            if (this.isFatalStorageError(error)) throw error
            const status = errorStatus(error)
            if (privateAttempted && privateHandle && (status === 401 || error instanceof OfflineSyncPrivateAuthorityError)) {
              await this.options.storage.retireReadingVault(storageOptions({ expectedSessionGeneration: generation }))
              this.retire()
              return
            }
            const authoritative = isAuthoritativeIneligibility(error)
            if (authoritative) {
              await commit(async () => {
                const currentPage = pagesByKey.get(key)
                if (!currentPage || currentPage.excluded) return
                const removedBodies = bodyForCandidate(candidate)
                this.assertCurrent(context, true)
                const ineligible =
                  privateAttempted && privateHandle
                    ? await this.awaitCurrent(
                        this.options.storage.markPrivatePageIneligible(privateHandle, candidate.selector, {
                          expectedSessionGeneration: generation,
                          expectedPolicyRevision: revision
                        }),
                        context,
                        true
                      )
                    : await this.awaitCurrent(
                        this.options.storage.markPageIneligible(candidate.selector, {
                          expectedSessionGeneration: generation,
                          expectedPolicyRevision: revision
                        }),
                        context,
                        true
                      )
                revision += 1
                pagesByKey.set(key, ineligible)
                for (const bodyKey of [...bodyKeys]) {
                  if (!bodyKey.startsWith(pageKey(candidate.selector) + '\u0000')) continue
                  bodyKeys.delete(bodyKey)
                  if (retainedBodyKeys.delete(bodyKey)) result.retained = Math.max(0, result.retained - 1)
                }
                result.removed += removedBodies
                const immutableKey = pageKey(candidate.selector)
                if (!automaticSelectionKeys.delete(immutableKey) || !currentPolicy.state.automaticSavingEnabled) return
                while (true) {
                  const replacement = selectReplacement()
                  if (!replacement) return
                  const selectedSelectors = selectedAutomaticSelectors()
                  selectedSelectors.push({ siteId: replacement.siteId, pageId: replacement.pageId, locale: replacement.locale })
                  const selectedPages = await this.awaitCurrent(
                    this.options.storage.updateAutomaticSelections(
                      selectedSelectors,
                      storageOptions({
                        expectedSessionGeneration: generation,
                        expectedPolicyRevision: revision,
                        siteId: policySiteId,
                        asOf: attemptAt
                      })
                    ),
                    context,
                    true
                  )
                  for (const selectedPage of selectedPages) if (selectedPage.siteId === policySiteId) pagesByKey.set(selectedPage.key, selectedPage)
                  refreshAutomaticSelectionKeys()
                  const replacementPage = selectedPages.find(selectedPage => selectedPage.key === replacement.key)
                  if (!replacementPage || !replacementPage.automatic) continue
                  if (attemptedKeys.has(replacement.key)) return
                  updateQueuedCandidate(pageCandidate(replacementPage))
                  return
                }
              })
            } else {
              await commit(async () => {
                result.retained += retainBodyForCandidate(candidate)
                result.failed += 1
                this.assertCurrent(context, true)
                await this.awaitCurrent(
                  this.options.storage.setPageAvailability(
                    candidate.selector,
                    'transient-failure',
                    storageOptions({
                      expectedSessionGeneration: generation,
                      expectedPolicyRevision: revision
                    })
                  ),
                  context,
                  true
                )
                if (privateStorageHandle) revision += 1
              })
              if (firstError === null) firstError = errorMessage(error)
            }
          }
        }
      })
      this.assertCurrent(context, true)

      if (fence) return this.fencedResult(policy, result)
      this.assertCurrent(context, true)
      const corpusBeforePrune = bodyKeys
      await this.awaitCurrent(
        this.options.storage.pruneUnselectedPageBodies(
          storageOptions({
            expectedSessionGeneration: generation,
            expectedPolicyRevision: revision
          })
        ),
        context,
        true
      )
      const corpusAfterPrune = bodyKeysFromCorpus(
        await this.awaitCurrent(
          this.options.storage.readSnapshotCorpus(storageOptions({ expectedSessionGeneration: generation, expectedPolicyRevision: revision })),
          context,
          true
        )
      )
      result.removed += countRemovedBodyKeys(corpusBeforePrune, corpusAfterPrune, policySiteId)
      bodyKeys = corpusAfterPrune
      const deniedSelections = [...pagesByKey.values()].filter(
        page => page.siteId === policySiteId && !page.excluded && (page.manual || page.tag) && page.availability === 'ineligible'
      ).length
      if (deniedSelections > 0) {
        result.failed += deniedSelections
        firstError ??= `${deniedSelections === 1 ? 'A selected page is' : `${deniedSelections} selected pages are`} not available for offline use. Retry or remove the selection in Saved pages.`
      }
      return await this.finishResult(policy, generation, revision, result, firstError, discoveryFailures > 0, context)
    } catch (error) {
      if (error instanceof OfflineSyncInvalidatedError) return this.cancelledResult(policy, result)
      if (this.isFence(error)) return this.fencedResult(policy, result)
      throw error
    }
  }

  private async finishResult(
    policy: OfflinePolicySnapshot,
    generation: number,
    revision: number,
    result: MutablePassResult,
    firstError: string | null,
    discoveryFailed: boolean,
    context: OperationContext
  ): Promise<OfflineSyncPassResult> {
    const partial = discoveryFailed || result.failed > 0 || result.pending > 0
    const status: OfflineSyncDiagnosticStatus = partial ? 'partial' : 'complete'
    const currentTime = this.currentTime()
    const resultError = partial ? (firstError ?? 'Offline synchronization did not complete.') : null
    const nextDiagnostics = diagnostic(policy.state.syncDiagnostics, {
      status,
      lastAttemptAt: currentTime,
      lastSuccessAt: partial ? policy.state.syncDiagnostics.lastSuccessAt : currentTime,
      lastError: resultError,
      pendingCount: result.pending,
      retainedCount: result.retained,
      removedCount: result.removed
    })
    const persisted = await this.persistDiagnostics(nextDiagnostics, generation, revision, context, true)
    return this.makeResult(status, generation, revision, persisted.diagnostics, result, resultError)
  }

  private async persistDiagnostics(
    diagnostics: OfflineSyncDiagnostics,
    generation: number,
    revision: number,
    context: OperationContext,
    requireContext: boolean
  ): Promise<{ readonly diagnostics: OfflineSyncDiagnostics; readonly policyRevision: number }> {
    this.assertCurrent(context, requireContext)
    try {
      const persisted = await this.awaitCurrent(
        this.options.storage.updateSyncDiagnostics(diagnostics, {
          expectedSessionGeneration: generation,
          expectedPolicyRevision: revision,
          ...(currentPrivateHandle(this.options, this.options.siteId) ? { readingHandle: currentPrivateHandle(this.options, this.options.siteId)! } : {})
        }),
        context,
        requireContext
      )
      this.assertCurrent(context, false)
      try {
        this.assertCurrent(context, false)
        const publication = this.options.onDiagnostics?.(persisted.syncDiagnostics)
        if (publication) await this.awaitCurrent(Promise.resolve(publication), context, false)
        this.assertCurrent(context, false)
      } catch (error) {
        if (error instanceof OfflineSyncInvalidatedError) throw error
        // Observers cannot undo a committed diagnostic.
      }
      return { diagnostics: persisted.syncDiagnostics, policyRevision: persisted.policyRevision }
    } catch (error) {
      if (error instanceof OfflineSyncInvalidatedError) throw error
      if (this.isFence(error)) {
        this.rerunRequested = true
        return { diagnostics, policyRevision: revision }
      }
      throw error
    }
  }

  private async errorResult(
    context: OperationContext,
    policy: OfflinePolicySnapshot | null,
    result: MutablePassResult,
    error: unknown
  ): Promise<OfflineSyncPassResult> {
    result.failed = Math.max(1, result.failed)
    const message = errorMessage(error)
    let currentPolicy = policy
    const handle = currentPrivateHandle(this.options, this.options.siteId)
    if (handle) {
      try {
        currentPolicy = await this.options.storage.readOfflinePolicy({
          readingHandle: handle,
          expectedSessionGeneration: policy?.sessionGeneration
        })
      } catch {
        // Preserve the initiating policy when a failed store cannot be reread.
      }
    }
    const generation = currentPolicy?.sessionGeneration ?? 0
    const revision = currentPolicy?.state.policyRevision ?? 0
    const base = currentPolicy?.state.syncDiagnostics ?? emptyDiagnostics('error', message)
    const diagnostics = diagnostic(base, {
      status: 'error',
      lastAttemptAt: this.safeCurrentTime(),
      lastError: message,
      pendingCount: result.pending,
      retainedCount: result.retained,
      removedCount: result.removed
    })
    let published = false
    if (policy && this.operationIsCurrent(context, false)) {
      try {
        await this.persistDiagnostics(diagnostics, generation, revision, context, false)
        published = true
      } catch {
        // The original fatal storage error is represented by this explicit result.
      }
    }
    if (!published && this.operationIsCurrent(context, false)) {
      try {
        this.assertCurrent(context, false)
        const publication = this.options.onDiagnostics?.(diagnostics)
        if (publication) await this.awaitCurrent(Promise.resolve(publication), context, false)
      } catch {
        // Teardown and observer failures must never become unhandled lifecycle rejections.
      }
    }
    return this.makeResult('error', generation, revision, diagnostics, result, message)
  }

  private async publishBackgroundFailure(error: unknown): Promise<void> {
    const controller = new AbortController()
    const context: OperationContext = { epoch: this.operationEpoch, controller, signal: controller.signal }
    const message = errorMessage(error)
    try {
      const policy = await this.awaitCurrent(this.options.storage.readOfflinePolicy(), context, false)
      const diagnostics = diagnostic(policy.state.syncDiagnostics, {
        status: 'error',
        lastAttemptAt: this.safeCurrentTime(),
        lastError: message
      })
      await this.persistDiagnostics(diagnostics, policy.sessionGeneration, policy.state.policyRevision, context, false)
    } catch {
      // If storage is closed or the context is gone there is no safe diagnostic write.
    }
  }

  private makeResult(
    status: OfflineSyncDiagnosticStatus,
    generation: number,
    revision: number,
    diagnostics: OfflineSyncDiagnostics,
    result: MutablePassResult,
    error: string | null = null
  ): OfflineSyncPassResult {
    const outcome = outcomeForStatus(status)
    return {
      status,
      outcome,
      kind: outcome,
      attempted: result.attempted,
      saved: result.saved,
      retained: result.retained,
      removed: result.removed,
      failed: result.failed,
      pending: result.pending,
      error,
      sessionGeneration: generation,
      policyRevision: revision,
      diagnostics
    }
  }

  private inactiveResult(): OfflineSyncPassResult {
    return this.makeResult('offline', 0, 0, emptyDiagnostics('offline'), {
      attempted: 0,
      saved: 0,
      retained: 0,
      removed: 0,
      failed: 0,
      pending: 0
    })
  }

  private cancelledResult(policy: OfflinePolicySnapshot | null, result: MutablePassResult): OfflineSyncPassResult {
    const diagnostics = policy
      ? diagnostic(policy.state.syncDiagnostics, {
          status: 'offline',
          pendingCount: result.pending,
          retainedCount: result.retained,
          removedCount: result.removed
        })
      : emptyDiagnostics('offline')
    return this.makeResult('offline', policy?.sessionGeneration ?? 0, policy?.state.policyRevision ?? 0, diagnostics, result)
  }

  private fencedResult(policy: OfflinePolicySnapshot, result: MutablePassResult): OfflineSyncPassResult {
    this.rerunRequested = true
    const message = 'Offline policy or session changed while synchronization was in flight.'
    const diagnostics = diagnostic(policy.state.syncDiagnostics, {
      status: 'partial',
      lastError: message,
      pendingCount: result.pending,
      retainedCount: result.retained,
      removedCount: result.removed
    })
    return this.makeResult('partial', policy.sessionGeneration, policy.state.policyRevision, diagnostics, result, message)
  }

  private safeCurrentTime(): string {
    try {
      return this.currentTime()
    } catch {
      return new Date().toISOString()
    }
  }

  private currentTime(): string {
    const value = this.options.now ? this.options.now() : new Date().toISOString()
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Offline sync clock returned an invalid time.')
    return value
  }

  private isFence(error: unknown): boolean {
    return (
      error instanceof OfflineGenerationFencedError ||
      error instanceof OfflinePolicyRevisionFencedError ||
      (error instanceof OfflineStorageError && (error.code === 'generation-fenced' || error.code === 'policy-revision-fenced'))
    )
  }

  private isFatalStorageError(error: unknown): boolean {
    return error instanceof OfflineStorageError && !this.isFence(error)
  }
}

const runWorkers = async (count: number, worker: () => Promise<void>): Promise<void> => {
  await Promise.all(Array.from({ length: count }, () => worker()))
}

export const createOfflineSyncCoordinator = (options: OfflineSyncCoordinatorOptions): OfflineSyncCoordinator => new OfflineSyncCoordinator(options)
