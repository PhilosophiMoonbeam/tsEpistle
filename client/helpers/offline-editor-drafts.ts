import { OfflineDraftPayloadV1Schema, type OfflineDraftEnvelopeV1, type OfflineDraftPayloadV1, type OfflineDraftState } from '../../shared/offline.ts'
import { isPageEditorKey, type PageEditorKey } from '../../shared/page-editors.ts'
import { OfflineDraftConflictError, openOfflineStorage, type OfflineStorage } from './offline-storage.ts'
import {
  decryptOfflineDraft,
  decryptOfflineSubmissionForReconciliation,
  encryptOfflineDraft,
  invalidateOfflineSession,
  isCurrentOfflineDraftKey,
  requestDraftKey,
  type OfflineDraftKeyHandle
} from './offline-crypto.ts'

const DEFAULT_CAPTURE_DEBOUNCE_MS = 750
const POSITIVE_SAFE_INTEGER = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const NONNEGATIVE_SAFE_INTEGER = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export type OfflineEditorDraftIdentity = {
  readonly editorKey: PageEditorKey
  readonly pageId: number | null
  readonly createIdentity: string | null
  readonly locale: string
  readonly path: string
  readonly baseSourceRevision: string | null
  readonly baseUpdatedAt: string | null
}

export type OfflineEditorDraftValues = {
  readonly title: string
  readonly description: string
  readonly content: string
}

export type OfflineDraftRecovery = {
  readonly recordId: string
  readonly draftRevision: number
  readonly payload: OfflineDraftPayloadV1
}

export type OfflineDraftSubmission = {
  readonly recordId: string
  readonly sessionGeneration: number
  readonly draftRevision: number
  readonly submissionId: string
}

export type OfflineDraftSubmissionRecovery = {
  readonly submission: OfflineDraftSubmission
  readonly payload: OfflineDraftPayloadV1
}

export type OfflineEditorDraftView = {
  readonly state: OfflineDraftState | null
  readonly candidate: OfflineDraftRecovery | null
  readonly candidates: readonly OfflineDraftRecovery[]
  readonly submissionCandidates: readonly OfflineDraftSubmissionRecovery[]
  readonly committed: boolean
  readonly inFlight: boolean
  readonly error: string | null
}

export type OfflineEditorDraftCoordinatorOptions = {
  readonly fetchImpl: typeof window.fetch
  readonly isAuthenticated: () => boolean
  readonly accountId: () => number
  readonly isOfflineBoundaryReady?: () => boolean
  readonly getIdentity: () => OfflineEditorDraftIdentity
  readonly getValues: () => OfflineEditorDraftValues
  readonly applyDraft?: (payload: OfflineDraftPayloadV1) => void
  readonly isDirty?: () => boolean
  readonly isOnline?: () => boolean
  readonly storage?: OfflineStorage
  readonly debounceMs?: number
  readonly onChange?: (view: OfflineEditorDraftView) => void
}

type DraftState = {
  state: OfflineDraftState | null
  candidate: OfflineDraftRecovery | null
  candidates: OfflineDraftRecovery[]
  submissionCandidates: OfflineDraftSubmissionRecovery[]
  committed: boolean
  inFlight: boolean
  error: string | null
}

type CurrentDraft = {
  recordId: string
  draftRevision: number
  payload: OfflineDraftPayloadV1
}

type SubmissionOutcome = 'success' | 'conflict' | 'locked' | 'invalid' | 'outcome-unknown'

const clonePayload = (payload: OfflineDraftPayloadV1): OfflineDraftPayloadV1 => ({ ...payload })

const cloneRecovery = (recovery: OfflineDraftRecovery | null): OfflineDraftRecovery | null =>
  recovery === null
    ? null
    : {
        recordId: recovery.recordId,
        draftRevision: recovery.draftRevision,
        payload: clonePayload(recovery.payload)
      }

const randomIdentifier = (): string => {
  const cryptoObject = globalThis.crypto
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID()
  if (cryptoObject?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoObject.getRandomValues(bytes)
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  }
  return `offline-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
const cloneSubmissionRecovery = (recovery: OfflineDraftSubmissionRecovery): OfflineDraftSubmissionRecovery => ({
  submission: { ...recovery.submission },
  payload: clonePayload(recovery.payload)
})

const cloneCandidates = (candidates: readonly OfflineDraftRecovery[]): OfflineDraftRecovery[] =>
  candidates.map(candidate => ({
    recordId: candidate.recordId,
    draftRevision: candidate.draftRevision,
    payload: clonePayload(candidate.payload)
  }))

/** Stable opaque identity for a create-page editor session. */
export const createOfflineDraftIdentity = (): string => randomIdentifier()

const isSubmission = (envelope: OfflineDraftEnvelopeV1): boolean => envelope.submissionId !== null

const sameEditorIdentity = (payload: OfflineDraftPayloadV1, identity: OfflineEditorDraftIdentity): boolean => {
  if (payload.editorKey !== identity.editorKey) return false
  if (identity.pageId !== null) return payload.pageId === identity.pageId
  return payload.pageId === null && payload.createIdentity !== null && payload.createIdentity === identity.createIdentity
}

const sameText = (payload: OfflineDraftPayloadV1, values: OfflineEditorDraftValues): boolean =>
  payload.title === values.title && payload.description === values.description && payload.content === values.content

const sameSubmissionIdentity = (payload: OfflineDraftPayloadV1, identity: OfflineEditorDraftIdentity): boolean =>
  payload.editorKey === identity.editorKey && payload.pageId === identity.pageId && payload.locale === identity.locale && payload.path === identity.path
const compareRecovery = (left: OfflineDraftRecovery, right: OfflineDraftRecovery): number => {
  if (left.draftRevision !== right.draftRevision) return left.draftRevision - right.draftRevision
  if (left.payload.updatedAt !== right.payload.updatedAt) return left.payload.updatedAt < right.payload.updatedAt ? -1 : 1
  return left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0
}

const stateForCapture = (state: OfflineDraftState | null, reviewRequired: boolean): OfflineDraftState =>
  reviewRequired || state === 'needs-review' ? 'needs-review' : 'local'
const safeIdentity = (raw: OfflineEditorDraftIdentity): OfflineEditorDraftIdentity => {
  if (!isPageEditorKey(raw.editorKey)) throw new TypeError('The editor key is not supported for offline drafts.')
  const pageId = raw.pageId === null ? null : raw.pageId
  if (pageId !== null && !POSITIVE_SAFE_INTEGER(pageId)) throw new TypeError('The page identity is invalid for an offline draft.')
  if (pageId === null && (typeof raw.createIdentity !== 'string' || raw.createIdentity.trim().length < 1)) {
    throw new TypeError('The create identity is missing for an offline draft.')
  }
  return {
    editorKey: raw.editorKey,
    pageId,
    createIdentity: pageId === null ? raw.createIdentity : null,
    locale: raw.locale,
    path: raw.path,
    baseSourceRevision: raw.baseSourceRevision,
    baseUpdatedAt: raw.baseUpdatedAt
  }
}

const safeValues = (raw: OfflineEditorDraftValues): OfflineEditorDraftValues => ({
  title: raw.title,
  description: raw.description,
  content: raw.content
})

const immutableSubmissionMatches = (left: OfflineDraftSubmission, right: OfflineDraftEnvelopeV1): boolean =>
  left.recordId === right.recordId &&
  left.sessionGeneration === right.sessionGeneration &&
  left.draftRevision === right.draftRevision &&
  left.submissionId === right.submissionId

/**
 * Coordinates encrypted editor text with the bounded offline storage adapter.
 * It never submits a mutation itself: callers explicitly prepare and complete a
 * foreground submission through the existing page-write path.
 */
export class OfflineEditorDraftCoordinator {
  private readonly options: OfflineEditorDraftCoordinatorOptions
  private readonly debounceMs: number
  private readonly ownsStorage: boolean
  private storage: OfflineStorage | null
  private storagePromise: Promise<OfflineStorage> | null = null
  private keyHandle: OfflineDraftKeyHandle | null = null
  private keyGeneration: number | null = null
  private captureTimer: ReturnType<typeof setTimeout> | null = null
  private capturePromise: Promise<boolean> | null = null
  private captureRequestedVersion = 0
  private committedCaptureVersion = 0
  private transitionPromise: Promise<boolean> | null = null
  private destroyed = false
  private reviewRequired = false
  private currentDraft: CurrentDraft | null = null
  private activeSubmission: OfflineDraftSubmission | null = null
  private activeSubmissionPayload: OfflineDraftPayloadV1 | null = null
  private submissionSourceDraft: CurrentDraft | null = null
  private draftState: DraftState = {
    state: null,
    candidate: null,
    candidates: [],
    submissionCandidates: [],
    committed: false,
    inFlight: false,
    error: null
  }

  constructor(options: OfflineEditorDraftCoordinatorOptions) {
    this.options = options
    this.debounceMs =
      Number.isFinite(options.debounceMs) && (options.debounceMs ?? 0) >= 0
        ? Math.floor(options.debounceMs ?? DEFAULT_CAPTURE_DEBOUNCE_MS)
        : DEFAULT_CAPTURE_DEBOUNCE_MS
    this.storage = options.storage ?? null
    this.ownsStorage = options.storage === undefined
  }

  get view(): OfflineEditorDraftView {
    return {
      state: this.draftState.state,
      candidate: cloneRecovery(this.draftState.candidate),
      candidates: cloneCandidates(this.draftState.candidates),
      submissionCandidates: this.draftState.submissionCandidates.map(cloneSubmissionRecovery),
      committed: this.draftState.committed,
      inFlight: this.draftState.inFlight,
      error: this.draftState.error
    }
  }

  get hasCommittedDraft(): boolean {
    return this.draftState.committed
  }

  get hasCommittedCurrentValues(): boolean {
    if (!this.currentDraft) return false
    try {
      return sameText(this.currentDraft.payload, this.currentValues())
    } catch {
      return false
    }
  }
  get hasInFlightWork(): boolean {
    return this.draftState.inFlight || this.captureTimer !== null || this.capturePromise !== null || this.activeSubmission !== null
  }

  get hasUnresolvedSubmission(): boolean {
    return this.activeSubmission !== null || this.draftState.submissionCandidates.length > 0
  }

  get candidate(): OfflineDraftRecovery | null {
    return cloneRecovery(this.draftState.candidate)
  }

  get candidates(): readonly OfflineDraftRecovery[] {
    return cloneCandidates(this.draftState.candidates)
  }

  get submissionCandidates(): readonly OfflineDraftSubmissionRecovery[] {
    return this.draftState.submissionCandidates.map(cloneSubmissionRecovery)
  }

  get state(): OfflineDraftState | null {
    return this.draftState.state
  }
  isAuthenticatedUser(): boolean {
    try {
      if (!this.options.isAuthenticated()) return false
      if (this.options.isOfflineBoundaryReady?.() === false) return false
      return POSITIVE_SAFE_INTEGER(this.options.accountId())
    } catch {
      return false
    }
  }

  private emit(): void {
    try {
      this.options.onChange?.(this.view)
    } catch {
      // A view callback is presentation-only and must not affect persistence.
    }
  }

  private setState(patch: Partial<DraftState>): void {
    this.draftState = { ...this.draftState, ...patch }
    this.emit()
  }

  private async getStorage(): Promise<OfflineStorage> {
    if (this.storage) return this.storage
    if (!this.storagePromise) {
      this.storagePromise = openOfflineStorage().then(storage => {
        if (this.destroyed) {
          storage.close()
          throw new Error('The offline editor draft coordinator was disposed.')
        }
        this.storage = storage
        return storage
      })
    }
    return this.storagePromise
  }

  private async ensureSession(signal?: AbortSignal): Promise<{ storage: OfflineStorage; handle: OfflineDraftKeyHandle } | null> {
    if (this.destroyed || !this.isAuthenticatedUser()) return null
    const accountId = this.options.accountId()
    if (!POSITIVE_SAFE_INTEGER(accountId)) return null
    const storage = await this.getStorage()
    const generation = await storage.currentSessionGeneration()
    if (!this.isAuthenticatedUser()) return null
    const existing = this.keyHandle
    if (
      existing &&
      this.keyGeneration === generation &&
      existing.context.accountId === accountId &&
      existing.sessionGeneration === generation &&
      isCurrentOfflineDraftKey(existing)
    ) {
      return { storage, handle: existing }
    }
    if (existing) {
      invalidateOfflineSession(existing.sessionGeneration)
      this.keyHandle = null
      this.keyGeneration = null
      this.currentDraft = null
      this.activeSubmission = null
      this.activeSubmissionPayload = null
      this.submissionSourceDraft = null
      this.reviewRequired = false
      this.setState({
        state: null,
        candidate: null,
        candidates: [],
        submissionCandidates: [],
        committed: false,
        inFlight: false,
        error: null
      })
    }
    const handle = await requestDraftKey(this.options.fetchImpl, {
      expectedAccountId: accountId,
      expectedSessionGeneration: generation,
      signal
    })
    if (handle.context.accountId !== accountId || handle.sessionGeneration !== generation || !NONNEGATIVE_SAFE_INTEGER(handle.context.authVersion)) {
      invalidateOfflineSession(handle.sessionGeneration)
      throw new Error('The verified offline draft session did not match the current owner.')
    }
    if (!this.isAuthenticatedUser()) {
      invalidateOfflineSession(handle.sessionGeneration)
      return null
    }
    this.keyHandle = handle
    this.keyGeneration = generation
    return { storage, handle }
  }

  private async listMatchingRecords(
    storage: OfflineStorage,
    handle: OfflineDraftKeyHandle,
    identity: OfflineEditorDraftIdentity
  ): Promise<OfflineDraftRecovery[]> {
    const records = await storage.listDraftEnvelopes(handle.context.accountId, {
      expectedSessionGeneration: handle.sessionGeneration
    })
    const matches: OfflineDraftRecovery[] = []
    for (const envelope of records) {
      // These selectors are a race/selection aid, never a confidentiality boundary.
      if (
        envelope.accountId !== handle.context.accountId ||
        envelope.authVersion !== handle.context.authVersion ||
        envelope.keyVersion !== handle.context.keyVersion ||
        envelope.sessionGeneration !== handle.sessionGeneration ||
        isSubmission(envelope)
      )
        continue
      let payload: OfflineDraftPayloadV1
      try {
        payload = await decryptOfflineDraft(handle, envelope)
      } catch {
        // Wrong-owner, malformed, and undecryptable records stay opaque/delete-only.
        continue
      }
      if (!sameEditorIdentity(payload, identity) && !(identity.pageId === null && sameSubmissionIdentity(payload, identity))) continue
      matches.push({ recordId: envelope.recordId, draftRevision: envelope.draftRevision, payload })
    }
    return matches.sort(compareRecovery)
  }

  private async listMatchingSubmissions(
    storage: OfflineStorage,
    handle: OfflineDraftKeyHandle,
    identity: OfflineEditorDraftIdentity
  ): Promise<OfflineDraftSubmissionRecovery[]> {
    const records = await storage.listDraftEnvelopes(handle.context.accountId, {
      expectedSessionGeneration: handle.sessionGeneration
    })
    const matches: OfflineDraftSubmissionRecovery[] = []
    for (const envelope of records) {
      if (
        envelope.accountId !== handle.context.accountId ||
        envelope.authVersion !== handle.context.authVersion ||
        envelope.keyVersion !== handle.context.keyVersion ||
        !isSubmission(envelope)
      )
        continue
      let payload: OfflineDraftPayloadV1
      try {
        if (envelope.sessionGeneration === handle.sessionGeneration) {
          payload = await decryptOfflineDraft(handle, envelope)
        } else {
          payload = await decryptOfflineSubmissionForReconciliation(handle, envelope)
          const replacement = await encryptOfflineDraft(handle, payload, {
            recordId: envelope.recordId,
            draftRevision: envelope.draftRevision,
            submissionId: envelope.submissionId
          })
          if (typeof storage.rewrapSubmission !== 'function') continue
          await storage.rewrapSubmission(envelope, replacement, {
            expectedSessionGeneration: handle.sessionGeneration
          })
        }
      } catch {
        // Wrong-owner, malformed, and undecryptable receipts remain opaque.
        continue
      }
      if (!sameSubmissionIdentity(payload, identity)) continue
      matches.push({
        submission: {
          recordId: envelope.recordId,
          sessionGeneration: handle.sessionGeneration,
          draftRevision: envelope.draftRevision,
          submissionId: envelope.submissionId!
        },
        payload
      })
    }
    return matches.sort((left, right) => {
      if (left.payload.updatedAt !== right.payload.updatedAt) return left.payload.updatedAt < right.payload.updatedAt ? -1 : 1
      return left.submission.recordId < right.submission.recordId ? -1 : left.submission.recordId > right.submission.recordId ? 1 : 0
    })
  }

  private currentIdentity(): OfflineEditorDraftIdentity {
    return safeIdentity(this.options.getIdentity())
  }

  private currentValues(): OfflineEditorDraftValues {
    return safeValues(this.options.getValues())
  }

  private payloadFor(state: OfflineDraftState, identity: OfflineEditorDraftIdentity, values: OfflineEditorDraftValues): OfflineDraftPayloadV1 {
    return OfflineDraftPayloadV1Schema.parse({
      editorKey: identity.editorKey,
      pageId: identity.pageId,
      createIdentity: identity.createIdentity,
      locale: identity.locale,
      path: identity.path,
      baseSourceRevision: identity.baseSourceRevision,
      baseUpdatedAt: identity.baseUpdatedAt,
      updatedAt: new Date().toISOString(),
      state,
      title: values.title,
      description: values.description,
      content: values.content
    })
  }

  /** Acquire the current online key and surface only matching, decryptable records. */
  async initialize(signal?: AbortSignal): Promise<OfflineEditorDraftView> {
    if (this.destroyed || !this.isAuthenticatedUser()) return this.view
    try {
      const session = await this.ensureSession(signal)
      if (!session || this.destroyed) return this.view
      const identity = this.currentIdentity()
      const values = this.currentValues()
      const matches = await this.listMatchingRecords(session.storage, session.handle, identity)
      const submissions = await this.listMatchingSubmissions(session.storage, session.handle, identity)
      const newest = matches[matches.length - 1]
      const isNewer = newest !== undefined && !sameText(newest.payload, values)
      this.currentDraft =
        newest !== undefined && !isNewer ? { recordId: newest.recordId, draftRevision: newest.draftRevision, payload: clonePayload(newest.payload) } : null
      const onlineReview = this.options.isOnline?.() === true
      this.reviewRequired = onlineReview || newest?.payload.state === 'needs-review'
      const candidateChoices = isNewer ? matches : []
      const candidate =
        candidateChoices.length === 1
          ? {
              ...candidateChoices[0]!,
              payload:
                this.reviewRequired && candidateChoices[0]!.payload.state === 'local'
                  ? { ...candidateChoices[0]!.payload, state: 'needs-review' as const }
                  : candidateChoices[0]!.payload
            }
          : null
      const newestSubmission = submissions[submissions.length - 1]
      const state =
        newestSubmission?.payload.state ??
        candidate?.payload.state ??
        (this.currentDraft ? (this.reviewRequired ? 'needs-review' : this.currentDraft.payload.state) : null)
      this.setState({
        state,
        candidate,
        candidates: candidateChoices,
        submissionCandidates: submissions,
        committed: matches.length > 0 || submissions.length > 0,
        error: null
      })
      return this.view
    } catch {
      // No key or failed storage verification must not expose draft metadata.
      this.setState({ candidate: null, candidates: [], submissionCandidates: [], error: 'A verified connection is required to recover local drafts.' })
      return this.view
    }
  }

  /** Queue an encrypted local capture while the editor remains dirty. */
  scheduleCapture(): void {
    if (this.destroyed || !this.isAuthenticatedUser() || this.options.isDirty?.() === false) return
    this.captureRequestedVersion += 1
    if (this.captureTimer !== null) clearTimeout(this.captureTimer)
    this.captureTimer = setTimeout(() => {
      this.captureTimer = null
      void this.captureNow()
    }, this.debounceMs)
  }

  private async captureInternal(force: boolean, stateOverride?: OfflineDraftState): Promise<boolean> {
    if (this.destroyed || !this.isAuthenticatedUser()) return false
    if (!force && this.options.isDirty?.() === false) return false
    const versionAtStart = this.captureRequestedVersion
    let session: { storage: OfflineStorage; handle: OfflineDraftKeyHandle } | null = null
    try {
      session = await this.ensureSession()
      if (!session || this.destroyed) return false
      const identity = this.currentIdentity()
      const values = this.currentValues()
      const nextState = stateOverride ?? stateForCapture(this.currentDraft?.payload.state ?? this.draftState.state, this.reviewRequired)
      const payload = this.payloadFor(nextState, identity, values)
      const recordId = this.currentDraft?.recordId ?? randomIdentifier()
      const previousRevision = this.currentDraft?.draftRevision ?? 0
      const draftRevision = Math.max(1, previousRevision + 1)
      const envelope = await encryptOfflineDraft(session.handle, payload, {
        recordId,
        draftRevision,
        submissionId: null
      })
      if (!this.isAuthenticatedUser() || !isCurrentOfflineDraftKey(session.handle)) return false
      await session.storage.putDraft(envelope, {
        expectedSessionGeneration: session.handle.sessionGeneration,
        expectedDraftRevision: this.currentDraft ? previousRevision : null,
        expectedSubmissionId: null
      })
      if (this.destroyed) return false
      this.currentDraft = { recordId, draftRevision, payload: clonePayload(payload) }
      let valuesStillCurrent = false
      try {
        valuesStillCurrent = sameText(payload, this.currentValues())
      } catch {
        valuesStillCurrent = false
      }
      if (valuesStillCurrent && versionAtStart === this.captureRequestedVersion) this.committedCaptureVersion = versionAtStart
      this.setState({ state: this.activeSubmission ? 'publishing' : payload.state, committed: true, error: null })
      return true
    } catch (error) {
      if (error instanceof OfflineDraftConflictError) this.reviewRequired = true
      this.setState({ error: 'Your changes could not be saved on this device.' })
      return false
    }
  }

  /** Immediately commit the latest editor text; true means IDB commit completed. */
  async captureNow(options: { force?: boolean; state?: OfflineDraftState } = {}): Promise<boolean> {
    if (this.captureTimer !== null) {
      clearTimeout(this.captureTimer)
      this.captureTimer = null
    }
    if (options.force === true) this.captureRequestedVersion += 1
    if (this.capturePromise) return this.capturePromise
    const operation = this.captureInternal(options.force === true, options.state)
    this.capturePromise = operation
    this.setState({ inFlight: true })
    let succeeded = false
    try {
      succeeded = await operation
      return succeeded
    } finally {
      if (this.capturePromise === operation) this.capturePromise = null
      this.setState({ inFlight: false })
      if (succeeded && this.captureRequestedVersion > this.committedCaptureVersion && !this.destroyed && this.isAuthenticatedUser()) {
        void this.captureNow()
      }
    }
  }

  /** Apply the reviewed local candidate, never publishing it implicitly. */
  async restoreCandidate(recordId?: string): Promise<OfflineDraftPayloadV1 | null> {
    const candidate =
      (recordId === undefined ? this.draftState.candidate : this.draftState.candidates.find(item => item.recordId === recordId)) ??
      (this.draftState.candidates.length === 1 ? this.draftState.candidates[0] : null)
    if (!candidate || this.destroyed || !this.isAuthenticatedUser()) return null
    try {
      if (!sameEditorIdentity(candidate.payload, this.currentIdentity()) && !sameSubmissionIdentity(candidate.payload, this.currentIdentity())) return null
      const payload = clonePayload(candidate.payload)
      this.options.applyDraft?.(payload)
      this.currentDraft = {
        recordId: candidate.recordId,
        draftRevision: candidate.draftRevision,
        payload
      }
      this.reviewRequired = true
      this.setState({
        state: 'needs-review',
        candidate: null,
        candidates: this.draftState.candidates.filter(item => item.recordId !== candidate.recordId),
        committed: true,
        error: null
      })
      return payload
    } catch {
      this.setState({ error: 'The local draft could not be restored.' })
      return null
    }
  }

  private async deleteRecord(recordId: string, draftRevision: number, submissionId: string | null): Promise<boolean> {
    if (!this.storage || !this.keyHandle) return false
    try {
      return await this.storage.deleteDraft(recordId, {
        expectedSessionGeneration: this.keyHandle.sessionGeneration,
        expectedDraftRevision: draftRevision,
        expectedSubmissionId: submissionId
      })
    } catch {
      return false
    }
  }

  /** Explicitly discard a reviewed local candidate. */
  async discardCandidate(recordId?: string): Promise<boolean> {
    const candidate =
      (recordId === undefined ? this.draftState.candidate : this.draftState.candidates.find(item => item.recordId === recordId)) ??
      (this.draftState.candidates.length === 1 ? this.draftState.candidates[0] : null)
    if (!candidate || this.destroyed || !this.isAuthenticatedUser()) return false
    const deleted = await this.deleteRecord(candidate.recordId, candidate.draftRevision, null)
    if (!deleted) {
      this.setState({ error: 'The local draft could not be discarded.' })
      return false
    }
    if (this.currentDraft?.recordId === candidate.recordId) this.currentDraft = null
    const candidates = this.draftState.candidates.filter(item => item.recordId !== candidate.recordId)
    this.setState({ candidate: null, candidates, state: candidates.length > 0 ? 'needs-review' : null, committed: candidates.length > 0, error: null })
    return true
  }

  /** Explicitly discard the current mutable local draft before leaving the editor. */
  async discardCurrentDraft(): Promise<boolean> {
    if (this.destroyed || !this.isAuthenticatedUser()) return true
    const current = this.currentDraft
    if (!current) return this.draftState.candidate === null && this.draftState.candidates.length === 0 ? true : this.discardCandidate()
    const deleted = await this.deleteRecord(current.recordId, current.draftRevision, null)
    if (!deleted) {
      this.setState({ error: 'The local draft could not be discarded.' })
      return false
    }
    this.currentDraft = null
    this.setState({ state: null, committed: this.draftState.submissionCandidates.length > 0, candidate: null, candidates: [], error: null })
    return true
  }

  /** Delete one immutable receipt after an explicit user decision. */
  async deleteSubmission(recordId: string): Promise<boolean> {
    const candidate = this.draftState.submissionCandidates.find(item => item.submission.recordId === recordId)
    if (!candidate || this.destroyed || !this.isAuthenticatedUser()) return false
    const deleted = await this.deleteRecord(candidate.submission.recordId, candidate.submission.draftRevision, candidate.submission.submissionId)
    if (!deleted) {
      this.setState({ error: 'The immutable submission receipt could not be deleted.' })
      return false
    }
    const submissionCandidates = this.draftState.submissionCandidates.filter(item => item.submission.recordId !== recordId)
    const state = submissionCandidates[submissionCandidates.length - 1]?.payload.state ?? (this.currentDraft ? this.currentDraft.payload.state : null)
    this.setState({ submissionCandidates, state, committed: this.currentDraft !== null || submissionCandidates.length > 0, error: null })
    return true
  }

  /**
   * Resolve a verified immutable receipt without replaying it. `continue` turns
   * its decrypted values into a fresh mutable draft; it never sends a request.
   */
  async resolveSubmission(recordId: string, resolution: 'discard' | 'continue'): Promise<boolean> {
    const candidate = this.draftState.submissionCandidates.find(item => item.submission.recordId === recordId)
    if (!candidate || this.destroyed || !this.isAuthenticatedUser()) return false
    if (resolution === 'discard') return this.deleteSubmission(recordId)
    if (!this.storage || !this.keyHandle || !isCurrentOfflineDraftKey(this.keyHandle)) return false
    const payload = OfflineDraftPayloadV1Schema.parse({ ...candidate.payload, state: 'needs-review', updatedAt: new Date().toISOString() })
    const recordIdForDraft = randomIdentifier()
    try {
      const envelope = await encryptOfflineDraft(this.keyHandle, payload, {
        recordId: recordIdForDraft,
        draftRevision: 1,
        submissionId: null
      })
      await this.storage.putDraft(envelope, {
        expectedSessionGeneration: this.keyHandle.sessionGeneration,
        expectedDraftRevision: null,
        expectedSubmissionId: null
      })
      if (!(await this.deleteRecord(candidate.submission.recordId, candidate.submission.draftRevision, candidate.submission.submissionId))) {
        this.setState({ error: 'The immutable submission receipt remains retained for review.' })
        return false
      }
      this.currentDraft = { recordId: recordIdForDraft, draftRevision: 1, payload: clonePayload(payload) }
      this.reviewRequired = true
      const submissionCandidates = this.draftState.submissionCandidates.filter(item => item.submission.recordId !== recordId)
      this.setState({ state: 'needs-review', submissionCandidates, committed: true, error: null })
      return true
    } catch {
      this.setState({ error: 'The local draft could not be continued as a new review.' })
      return false
    }
  }

  private async findSubmissionEnvelope(submission: OfflineDraftSubmission): Promise<OfflineDraftEnvelopeV1 | null> {
    if (!this.storage || !this.keyHandle) return null
    const records = await this.storage.listDraftEnvelopes(this.keyHandle.context.accountId, {
      expectedSessionGeneration: this.keyHandle.sessionGeneration
    })
    return records.find(record => immutableSubmissionMatches(submission, record)) ?? null
  }

  private async persistSubmissionState(submission: OfflineDraftSubmission, state: OfflineDraftState): Promise<boolean> {
    if (!this.storage || !this.keyHandle || !isCurrentOfflineDraftKey(this.keyHandle)) return false
    try {
      const envelope = await this.findSubmissionEnvelope(submission)
      if (!envelope || envelope.submissionId === null) return false
      if (
        envelope.accountId !== this.keyHandle.context.accountId ||
        envelope.authVersion !== this.keyHandle.context.authVersion ||
        envelope.keyVersion !== this.keyHandle.context.keyVersion
      )
        return false
      const payload = await decryptOfflineDraft(this.keyHandle, envelope)
      const nextPayload = OfflineDraftPayloadV1Schema.parse({ ...payload, state, updatedAt: new Date().toISOString() })
      const nextEnvelope = await encryptOfflineDraft(this.keyHandle, nextPayload, {
        recordId: submission.recordId,
        draftRevision: submission.draftRevision,
        submissionId: submission.submissionId
      })
      await this.storage.putDraft(nextEnvelope, {
        expectedSessionGeneration: this.keyHandle.sessionGeneration,
        expectedDraftRevision: submission.draftRevision,
        expectedSubmissionId: submission.submissionId
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Freeze the current text into an immutable encrypted receipt before a page
   * mutation. The caller must submit it through the existing foreground save.
   */
  async prepareSubmission(): Promise<OfflineDraftSubmission | null> {
    if (
      this.destroyed ||
      !this.isAuthenticatedUser() ||
      this.activeSubmission ||
      this.draftState.submissionCandidates.length > 0 ||
      this.draftState.state === 'publishing' ||
      this.draftState.state === 'outcome-unknown'
    )
      return null
    if (this.draftState.candidate || this.draftState.candidates.length > 0) return null
    if (!(await this.captureNow({ force: true }))) return null
    try {
      const session = await this.ensureSession()
      const sourceDraft = this.currentDraft
      if (!session || !sourceDraft) return null
      const submissionId = randomIdentifier()
      const payload = OfflineDraftPayloadV1Schema.parse({
        ...sourceDraft.payload,
        state: 'publishing',
        updatedAt: new Date().toISOString()
      })
      const envelope = await encryptOfflineDraft(session.handle, payload, {
        recordId: randomIdentifier(),
        draftRevision: sourceDraft.draftRevision,
        submissionId
      })
      await session.storage.putDraft(envelope, {
        expectedSessionGeneration: session.handle.sessionGeneration,
        expectedDraftRevision: null,
        expectedSubmissionId: null
      })
      const submission: OfflineDraftSubmission = {
        recordId: envelope.recordId,
        sessionGeneration: envelope.sessionGeneration,
        draftRevision: envelope.draftRevision,
        submissionId: envelope.submissionId!
      }
      this.activeSubmission = submission
      this.activeSubmissionPayload = clonePayload(payload)
      this.submissionSourceDraft = {
        recordId: sourceDraft.recordId,
        draftRevision: sourceDraft.draftRevision,
        payload: clonePayload(sourceDraft.payload)
      }
      this.reviewRequired = false
      this.setState({ state: 'publishing', committed: true, inFlight: true, error: null })
      return submission
    } catch {
      this.setState({ error: 'The page was not submitted because the encrypted draft receipt could not be committed.' })
      return null
    }
  }

  /** Persist a server outcome and remove an immutable receipt only on proof of success. */
  async completeSubmission(submission: OfflineDraftSubmission, outcome: SubmissionOutcome): Promise<boolean> {
    if (this.destroyed) return false
    const active = this.activeSubmission
    if (
      !active ||
      active.recordId !== submission.recordId ||
      active.sessionGeneration !== submission.sessionGeneration ||
      active.draftRevision !== submission.draftRevision ||
      active.submissionId !== submission.submissionId
    )
      return false
    if (outcome === 'success') {
      if (this.captureTimer !== null && !(await this.captureNow())) {
        await this.persistSubmissionState(submission, 'outcome-unknown')
        this.activeSubmission = null
        this.activeSubmissionPayload = null
        this.submissionSourceDraft = null
        this.setState({
          state: 'outcome-unknown',
          inFlight: false,
          committed: true,
          error: 'The server saved the page, but edits made while publishing could not be confirmed on this device.'
        })
        return false
      }
      if (this.capturePromise) await this.capturePromise
      const deleted = await this.deleteRecord(submission.recordId, submission.draftRevision, submission.submissionId)
      if (!deleted) {
        const persisted = await this.persistSubmissionState(submission, 'outcome-unknown')
        const payload = this.activeSubmissionPayload
          ? OfflineDraftPayloadV1Schema.parse({ ...this.activeSubmissionPayload, state: 'outcome-unknown', updatedAt: new Date().toISOString() })
          : null
        this.activeSubmission = null
        this.activeSubmissionPayload = null
        this.setState({
          state: 'outcome-unknown',
          submissionCandidates: persisted && payload ? [{ submission, payload }] : this.draftState.submissionCandidates,
          inFlight: false,
          committed: true,
          error: 'The server response was received, but the local submission receipt could not be finalized.'
        })
        return false
      }
      const sourceDraft = this.submissionSourceDraft
      const currentDraft = this.currentDraft
      if (sourceDraft && currentDraft && sourceDraft.recordId === currentDraft.recordId && sameText(sourceDraft.payload, currentDraft.payload)) {
        await this.deleteRecord(currentDraft.recordId, currentDraft.draftRevision, null)
        this.currentDraft = null
      }
      this.activeSubmission = null
      this.activeSubmissionPayload = null
      this.submissionSourceDraft = null
      const currentState = this.currentDraft?.payload.state ?? null
      this.setState({ state: currentState, committed: this.currentDraft !== null, inFlight: false, error: null })
      return true
    }

    const nextState: OfflineDraftState = outcome === 'conflict' ? 'conflict' : outcome === 'outcome-unknown' ? 'outcome-unknown' : 'locked'
    const persisted = await this.persistSubmissionState(submission, nextState)
    const payload = this.activeSubmissionPayload
      ? OfflineDraftPayloadV1Schema.parse({ ...this.activeSubmissionPayload, state: nextState, updatedAt: new Date().toISOString() })
      : null
    this.activeSubmission = null
    this.activeSubmissionPayload = null
    this.submissionSourceDraft = null
    this.setState({
      state: nextState,
      submissionCandidates: persisted && payload && nextState !== 'locked' ? [{ submission, payload }] : [],
      committed: true,
      inFlight: false,
      error: persisted ? null : 'The immutable submission receipt is retained for review.'
    })
    if (outcome === 'locked' || outcome === 'invalid') invalidateOfflineSession(submission.sessionGeneration)
    return persisted
  }

  /** Reconnection changes local work to review-required; it never submits automatically. */
  async markReconnected(): Promise<boolean> {
    if (this.destroyed || !this.isAuthenticatedUser()) return false
    this.reviewRequired = true
    const current = this.currentDraft
    if (!current || current.payload.state === 'needs-review') {
      if (this.draftState.state === 'local') this.setState({ state: 'needs-review' })
      return true
    }
    if (this.transitionPromise) return this.transitionPromise
    const operation = (async () => {
      const session = await this.ensureSession()
      if (!session) return false
      const payload = { ...current.payload, state: 'needs-review' as const, updatedAt: new Date().toISOString() }
      const parsed = OfflineDraftPayloadV1Schema.parse(payload)
      const envelope = await encryptOfflineDraft(session.handle, parsed, {
        recordId: current.recordId,
        draftRevision: current.draftRevision + 1,
        submissionId: null
      })
      await session.storage.putDraft(envelope, {
        expectedSessionGeneration: session.handle.sessionGeneration,
        expectedDraftRevision: current.draftRevision,
        expectedSubmissionId: null
      })
      this.currentDraft = { recordId: current.recordId, draftRevision: current.draftRevision + 1, payload: parsed }
      this.setState({ state: 'needs-review', committed: true, error: null })
      return true
    })()
    this.transitionPromise = operation
    try {
      return await operation
    } catch {
      this.setState({ state: 'needs-review', error: 'Reconnect was detected; review the local draft before publishing.' })
      return false
    } finally {
      if (this.transitionPromise === operation) this.transitionPromise = null
    }
  }

  /** Lock local projections at an auth/session boundary without revealing metadata. */
  lock(): void {
    if (this.keyHandle) invalidateOfflineSession(this.keyHandle.sessionGeneration)
    this.keyHandle = null
    this.keyGeneration = null
    this.currentDraft = null
    this.activeSubmission = null
    this.activeSubmissionPayload = null
    this.submissionSourceDraft = null
    this.reviewRequired = false
    this.draftState = {
      state: 'locked',
      candidate: null,
      candidates: [],
      submissionCandidates: [],
      committed: false,
      inFlight: false,
      error: null
    }
    this.emit()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.captureTimer !== null) clearTimeout(this.captureTimer)
    this.captureTimer = null
    this.capturePromise = null
    this.transitionPromise = null
    this.keyHandle = null
    this.keyGeneration = null
    this.currentDraft = null
    this.activeSubmission = null
    this.activeSubmissionPayload = null
    this.submissionSourceDraft = null
    if (this.ownsStorage) this.storage?.close()
    this.storage = null
  }
}

export type { OfflineDraftState }
