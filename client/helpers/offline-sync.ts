import { fetchOfflinePageSnapshot, fetchPagesByTag, type PageListRow } from './pages-api.ts'
import { OfflineGenerationFencedError, OfflinePolicyRevisionFencedError, OfflineStorageError, type OfflineStorage } from './offline-storage.ts'
import {
  OfflineSnapshotSelectorSchema,
  OFFLINE_AUTOMATIC_PAGE_LIMIT,
  OfflineSyncDiagnosticsSchema,
  type OfflinePagePolicyRecord,
  type OfflinePolicySnapshot,
  type OfflinePolicyState,
  type OfflineSnapshotProvenance,
  type OfflineSnapshotSelector,
  type OfflineSyncDiagnostics,
  type OfflineSyncDiagnosticStatus
} from '../../shared/offline.ts'
export type OfflineSyncFetch = Parameters<typeof fetchOfflinePageSnapshot>[0]

export type OfflineSyncCoordinatorOptions = {
  storage: OfflineStorage
  siteId: string
  fetchImpl: OfflineSyncFetch
  now?: () => string
  isOnline?: () => boolean
  isForeground?: () => boolean
  isRetired?: () => boolean
  maxConcurrentFetches?: number
  onDiagnostics?: (diagnostics: OfflineSyncDiagnostics) => void | Promise<void>
}

export type OfflineSyncPassResult = {
  status: OfflineSyncDiagnosticStatus
  attempted: number
  saved: number
  retained: number
  removed: number
  failed: number
  pending: number
  sessionGeneration: number
  policyRevision: number
  diagnostics: OfflineSyncDiagnostics
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

const DEFAULT_CONCURRENCY = 4
const MAX_DIAGNOSTIC_ERROR = 4096

const errorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined
  const status = Reflect.get(error, 'status')
  return typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined
}

const isAuthoritativeIneligibility = (error: unknown): boolean => {
  const status = errorStatus(error)
  return status === 401 || status === 403 || status === 404 || status === 410 || status === 422
}

const errorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > MAX_DIAGNOSTIC_ERROR ? message.slice(0, MAX_DIAGNOSTIC_ERROR) : message
}

const selectorKey = (selector: OfflineSnapshotSelector): string => `${selector.siteId}\u0000${selector.pageId}\u0000${selector.locale}`

const diagnostic = (state: OfflinePolicyState['syncDiagnostics'], patch: Partial<OfflineSyncDiagnostics>): OfflineSyncDiagnostics =>
  OfflineSyncDiagnosticsSchema.parse({ ...state, ...patch })

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

const runWorkers = async (count: number, worker: () => Promise<void>): Promise<void> => {
  await Promise.all(Array.from({ length: count }, () => worker()))
}

export class OfflineSyncCoordinator {
  private readonly options: OfflineSyncCoordinatorOptions
  private readonly concurrency: number
  private activePass: Promise<OfflineSyncPassResult> | null = null
  private rerunRequested = false
  private disposed = false
  private retired = false
  private started = false
  private readonly onOnline = (): void => {
    void this.reconcile('online')
  }
  private readonly onForeground = (): void => {
    if (hasForeground(this.options)) void this.reconcile('foreground')
  }

  constructor(options: OfflineSyncCoordinatorOptions) {
    if (!options || typeof options !== 'object') throw new Error('Offline sync coordinator options are required.')
    if (typeof options.storage !== 'object' || options.storage === null || typeof options.storage.readOfflinePolicy !== 'function')
      throw new Error('Offline storage is required.')
    const siteId = typeof options.siteId === 'string' ? options.siteId.trim() : ''
    if (siteId.length < 1 || siteId.length > 256) throw new Error('Offline site identity is required.')
    if (typeof options.fetchImpl !== 'function') throw new Error('Offline sync fetch implementation is required.')
    this.options = { ...options, siteId }
    this.concurrency = normalizeConcurrency(options.maxConcurrentFetches)
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
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onForeground)
    void this.reconcile('startup')
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onForeground)
  }

  retire(): void {
    this.retired = true
    this.stop()
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    this.rerunRequested = false
  }

  reconcile(_reason = 'manual'): Promise<OfflineSyncPassResult> {
    if (this.disposed || this.retired) {
      return Promise.resolve({
        status: 'offline',
        attempted: 0,
        saved: 0,
        retained: 0,
        removed: 0,
        failed: 0,
        pending: 0,
        sessionGeneration: 0,
        policyRevision: 0,
        diagnostics: {
          status: 'offline',
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastError: null,
          pendingCount: 0,
          retainedCount: 0,
          removedCount: 0
        }
      })
    }
    if (this.activePass) {
      this.rerunRequested = true
      return this.activePass
    }
    const pass = this.runCoalescedPass()
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

  private canRun(): boolean {
    return !this.disposed && !this.retired && !(this.options.isRetired?.() ?? false) && hasNetwork(this.options) && hasForeground(this.options)
  }

  private async runCoalescedPass(): Promise<OfflineSyncPassResult> {
    let result = await this.runPass()
    while (this.rerunRequested && this.canRun()) {
      this.rerunRequested = false
      result = await this.runPass()
    }
    this.rerunRequested = false
    return result
  }

  private async runPass(): Promise<OfflineSyncPassResult> {
    const policy = await this.options.storage.readOfflinePolicy()
    const generation = policy.sessionGeneration
    const revision = policy.state.policyRevision
    const attemptAt = this.currentTime()
    if (!this.canRun()) {
      const nextDiagnostics = diagnostic(policy.state.syncDiagnostics, {
        status: 'offline',
        lastAttemptAt: attemptAt,
        pendingCount: 0
      })
      const persisted = await this.persistDiagnostics(nextDiagnostics, generation, revision)
      return this.makeResult('offline', generation, revision, persisted, { attempted: 0, saved: 0, retained: 0, removed: 0, failed: 0, pending: 0 })
    }

    const runningDiagnostics = diagnostic(policy.state.syncDiagnostics, {
      status: 'running',
      lastAttemptAt: attemptAt,
      lastError: null
    })
    await this.persistDiagnostics(runningDiagnostics, generation, revision)
    const result: MutablePassResult = { attempted: 0, saved: 0, retained: 0, removed: 0, failed: 0, pending: 0 }
    let firstError: string | null = null
    let discoveryFailures = 0
    let fence = false

    let topAutomatic: OfflinePagePolicyRecord[] = []
    try {
      topAutomatic = policy.state.automaticSavingEnabled
        ? await this.options.storage.selectTopAutomaticPages({
            expectedSessionGeneration: generation,
            expectedPolicyRevision: revision,
            siteId: this.options.siteId,
            limit: OFFLINE_AUTOMATIC_PAGE_LIMIT,
            asOf: attemptAt
          })
        : []
      await this.options.storage.updateAutomaticSelections(
        topAutomatic.map(page => ({ siteId: page.siteId, pageId: page.pageId, locale: page.locale })),
        { expectedSessionGeneration: generation, expectedPolicyRevision: revision, siteId: this.options.siteId, asOf: attemptAt }
      )
    } catch (error) {
      if (this.isFence(error)) return this.fencedResult(policy, result)
      firstError = errorMessage(error)
      result.failed += 1
    }

    const tagResults = new Map<string, OfflineSnapshotSelector[]>()
    if (!fence && this.canRun()) {
      for (const tag of policy.state.selectedTags) {
        try {
          const rows = await fetchPagesByTag(this.options.fetchImpl, tag)
          const selectors: OfflineSnapshotSelector[] = []
          const seen = new Set<string>()
          for (const row of rows) {
            const candidate = rowCandidate(this.options.siteId, row, tag)
            if (!candidate) continue
            const key = selectorKey(candidate.selector)
            if (seen.has(key)) continue
            seen.add(key)
            selectors.push(candidate.selector)
          }
          tagResults.set(tag, selectors)
          await this.options.storage.synchronizeTagProvenance(tag, selectors, {
            expectedSessionGeneration: generation,
            expectedPolicyRevision: revision
          })
        } catch (error) {
          if (this.isFence(error)) {
            fence = true
            break
          }
          discoveryFailures += 1
          result.failed += 1
          result.retained += 1
          if (firstError === null) firstError = errorMessage(error)
        }
      }
    }

    if (fence) return this.fencedResult(policy, result)
    if (!this.canRun()) {
      return this.finishResult(policy, generation, revision, result, firstError, discoveryFailures > 0)
    }

    let currentPolicy = policy
    try {
      currentPolicy = await this.options.storage.readOfflinePolicy({
        expectedSessionGeneration: generation,
        expectedPolicyRevision: revision
      })
    } catch (error) {
      if (this.isFence(error)) return this.fencedResult(policy, result)
      throw error
    }

    const candidates = new Map<string, Candidate>()
    for (const page of currentPolicy.pages) {
      if (page.siteId !== this.options.siteId) continue
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
    const entries = [...candidates.values()]
    result.pending = entries.length
    let nextCandidateIndex = 0
    await runWorkers(Math.min(this.concurrency, Math.max(1, entries.length)), async () => {
      while (true) {
        const index = nextCandidateIndex
        nextCandidateIndex += 1
        if (index >= entries.length) return
        result.pending = Math.max(0, result.pending - 1)
        result.attempted += 1
        const candidate = entries[index]
        const page = pagesByKey.get(selectorKey(candidate.selector))
        if (!page || page.excluded) {
          result.retained += 1
          continue
        }
        if (!this.canRun()) {
          result.retained += 1
          result.pending = Math.max(0, entries.length - nextCandidateIndex)
          return
        }
        try {
          const snapshot = await fetchOfflinePageSnapshot(this.options.fetchImpl, candidate.selector.pageId)
          if (snapshot.pageId !== candidate.selector.pageId || snapshot.locale !== candidate.selector.locale)
            throw new Error('Offline snapshot identity did not match the discovered page.')
          await this.options.storage.putSnapshot(this.options.siteId, snapshot, {
            expectedSessionGeneration: generation,
            expectedPolicyRevision: revision,
            provenance: provenanceFor(page, candidate)
          })
          result.saved += 1
        } catch (error) {
          if (this.isFence(error)) {
            fence = true
            return
          }
          result.retained += 1
          if (isAuthoritativeIneligibility(error)) {
            try {
              await this.options.storage.markPageIneligible(candidate.selector, {
                expectedSessionGeneration: generation,
                expectedPolicyRevision: revision
              })
              result.removed += 1
              result.retained = Math.max(0, result.retained - 1)
            } catch (removalError) {
              if (this.isFence(removalError)) fence = true
              result.failed += 1
              if (firstError === null) firstError = errorMessage(removalError)
            }
          } else {
            result.failed += 1
            try {
              await this.options.storage.setPageAvailability(candidate.selector, 'transient-failure', {
                expectedSessionGeneration: generation,
                expectedPolicyRevision: revision
              })
            } catch (availabilityError) {
              if (this.isFence(availabilityError)) fence = true
              if (firstError === null) firstError = errorMessage(availabilityError)
            }
          }
          if (firstError === null && !isAuthoritativeIneligibility(error)) firstError = errorMessage(error)
        }
      }
    })

    if (fence) return this.fencedResult(policy, result)
    if (!this.canRun()) return this.finishResult(policy, generation, revision, result, firstError, true)
    try {
      result.removed += await this.options.storage.pruneUnselectedPageBodies({
        expectedSessionGeneration: generation,
        expectedPolicyRevision: revision
      })
    } catch (error) {
      if (this.isFence(error)) return this.fencedResult(policy, result)
      result.failed += 1
      if (firstError === null) firstError = errorMessage(error)
    }
    return this.finishResult(policy, generation, revision, result, firstError, discoveryFailures > 0)
  }

  private async finishResult(
    policy: OfflinePolicySnapshot,
    generation: number,
    revision: number,
    result: MutablePassResult,
    firstError: string | null,
    discoveryFailed: boolean
  ): Promise<OfflineSyncPassResult> {
    const partial = discoveryFailed || result.failed > 0 || result.pending > 0
    const status: OfflineSyncDiagnosticStatus = partial ? 'partial' : 'complete'
    const currentTime = this.currentTime()
    const nextDiagnostics = diagnostic(policy.state.syncDiagnostics, {
      status,
      lastAttemptAt: currentTime,
      lastSuccessAt: partial ? policy.state.syncDiagnostics.lastSuccessAt : currentTime,
      lastError: firstError,
      pendingCount: result.pending,
      retainedCount: result.retained,
      removedCount: result.removed
    })
    const persisted = await this.persistDiagnostics(nextDiagnostics, generation, revision)
    return this.makeResult(status, generation, revision, persisted, result)
  }

  private async persistDiagnostics(diagnostics: OfflineSyncDiagnostics, generation: number, revision: number): Promise<OfflineSyncDiagnostics> {
    try {
      const persisted = await this.options.storage.updateSyncDiagnostics(diagnostics, {
        expectedSessionGeneration: generation,
        expectedPolicyRevision: revision
      })
      try {
        await this.options.onDiagnostics?.(persisted.syncDiagnostics)
      } catch {
        // Observers cannot undo a committed diagnostic.
      }
      return persisted.syncDiagnostics
    } catch (error) {
      if (this.isFence(error)) {
        this.rerunRequested = true
        return diagnostics
      }
      return diagnostics
    }
  }
  private makeResult(
    status: OfflineSyncDiagnosticStatus,
    generation: number,
    revision: number,
    diagnostics: OfflineSyncDiagnostics,
    result: MutablePassResult
  ): OfflineSyncPassResult {
    return {
      status,
      attempted: result.attempted,
      saved: result.saved,
      retained: result.retained,
      removed: result.removed,
      failed: result.failed,
      pending: result.pending,
      sessionGeneration: generation,
      policyRevision: revision,
      diagnostics
    }
  }

  private fencedResult(policy: OfflinePolicySnapshot, result: MutablePassResult): OfflineSyncPassResult {
    this.rerunRequested = true
    const diagnostics = diagnostic(policy.state.syncDiagnostics, {
      status: 'partial',
      lastError: 'Offline policy or session changed while synchronization was in flight.',
      pendingCount: result.pending,
      retainedCount: result.retained,
      removedCount: result.removed
    })
    return this.makeResult('partial', policy.sessionGeneration, policy.state.policyRevision, diagnostics, result)
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
}

export const createOfflineSyncCoordinator = (options: OfflineSyncCoordinatorOptions): OfflineSyncCoordinator => new OfflineSyncCoordinator(options)
