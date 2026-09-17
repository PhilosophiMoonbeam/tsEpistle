import { OfflineDraftPayloadV1Schema, type OfflineDraftEnvelopeV1, type OfflineDraftPayloadV1, type OfflineDraftState } from '../../shared/offline.ts'
import { isPageEditorKey, type PageEditorKey } from '../../shared/page-editors.ts'
import { OfflineDraftConflictError, openOfflineStorage, type OfflineStorage } from './offline-storage.ts'
import {
  decryptOfflineDraft,
  decryptOfflineDraftForReconciliation,
  decryptOfflineSubmissionForReconciliation,
  encryptOfflineDraft,
  isCurrentOfflineDraftKey,
  requestDraftKey,
  type OfflineDraftKeyHandle
} from './offline-crypto.ts'
import { requestOfflineIdentityBoundary } from './offline-session.ts'

export type OfflineActorEpoch = string | number
type ActorEpoch = OfflineActorEpoch
const POSITIVE_SAFE_INTEGER = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
const NONNEGATIVE_SAFE_INTEGER = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const DEFAULT_CAPTURE_DEBOUNCE_MS = 750

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

/** The complete immutable snapshot handed to the foreground page writer. */
export type PreparedOfflineSubmission = Readonly<{
  readonly submission: OfflineDraftSubmission
  readonly recordId: string
  readonly sessionGeneration: number
  readonly draftRevision: number
  readonly submissionId: string
  readonly envelope: OfflineDraftEnvelopeV1
  readonly payload: OfflineDraftPayloadV1
  readonly sourceEnvelope: OfflineDraftEnvelopeV1 | null
  readonly sourcePayload: OfflineDraftPayloadV1 | null
  readonly editVersion: number
  readonly actorEpoch: ActorEpoch
  readonly identity: OfflineEditorDraftIdentity
  readonly baseSourceRevision: string | null
  readonly baseUpdatedAt: string | null
}>

export type OfflineSubmissionOutcome =
  | {
      readonly kind: 'success'
      readonly identity?: OfflineEditorDraftIdentity
      readonly baseSourceRevision?: string | null
      readonly baseUpdatedAt?: string | null
      readonly postWriteError?: string | null
    }
  | {
      readonly kind: 'rejected'
      readonly status: number
      readonly reason?: string
    }
  | {
      readonly kind: 'unknown'
      readonly status?: number
      readonly reason?: string
    }
  | {
      readonly kind: 'post-write'
      readonly status?: number
      readonly reason?: string
    }

/** Kept as a public name for callers that model an outcome separately. */
export type SubmissionOutcome = OfflineSubmissionOutcome

export type OfflineEditorDraftView = {
  readonly state: OfflineDraftState | null
  readonly candidate: OfflineDraftRecovery | null
  readonly candidates: readonly OfflineDraftRecovery[]
  readonly submissionCandidates: readonly OfflineDraftSubmissionRecovery[]
  readonly committed: boolean
  readonly inFlight: boolean
  readonly error: string | null
}

export type OfflineEditorReloadSafetySnapshot = {
  readonly safe: boolean
  readonly revision: string
  readonly actorEpoch?: ActorEpoch
}

export type OfflineEditorReloadSafetyFacts = {
  readonly dirtyMetadata?: boolean
  readonly mergeState?: boolean
  readonly collaborationBacklog?: boolean | number
  readonly routeIdentity?: string
}

export type OfflineEditorDraftCoordinatorOptions = {
  readonly fetchImpl: typeof window.fetch
  readonly isAuthenticated: () => boolean
  readonly accountId: () => number
  readonly isOfflineBoundaryReady?: () => boolean
  readonly getIdentity: () => OfflineEditorDraftIdentity
  readonly getValues: () => OfflineEditorDraftValues
  readonly detachedApply?: (payload: OfflineDraftPayloadV1) => void
  readonly detachedReplace?: (payload: OfflineDraftPayloadV1) => void
  readonly detachedClear?: () => void
  readonly detachForDraft?: () => void
  readonly getActorEpoch?: () => ActorEpoch
  readonly getReloadSafetyFacts?: () => OfflineEditorReloadSafetyFacts
  readonly isDirty?: () => boolean
  readonly isOnline?: () => boolean
  readonly storage?: OfflineStorage
  readonly debounceMs?: number
  readonly onChange?: (view: OfflineEditorDraftView) => void
  readonly onSafetyChange?: (snapshot: OfflineEditorReloadSafetySnapshot) => void
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
  envelope: OfflineDraftEnvelopeV1
}

type CaptureSnapshot = {
  readonly values: OfflineEditorDraftValues
  readonly identity: OfflineEditorDraftIdentity
  readonly editVersion: number
  readonly stateOverride?: OfflineDraftState
}

type InternalPrepared = {
  readonly publicValue: PreparedOfflineSubmission
  readonly envelope: OfflineDraftEnvelopeV1
  readonly payload: OfflineDraftPayloadV1
  readonly sourceEnvelope: OfflineDraftEnvelopeV1 | null
  readonly sourcePayload: OfflineDraftPayloadV1 | null
  readonly actorEpoch: ActorEpoch
}

type SubmissionOutcomeKind = 'success' | 'rejected' | 'unknown' | 'post-write'

const clonePayload = (payload: OfflineDraftPayloadV1): OfflineDraftPayloadV1 => ({ ...payload })
const cloneIdentity = (identity: OfflineEditorDraftIdentity): OfflineEditorDraftIdentity => ({ ...identity })
const cloneEnvelope = (envelope: OfflineDraftEnvelopeV1): OfflineDraftEnvelopeV1 => ({
  ...envelope,
  nonce: new Uint8Array(envelope.nonce),
  ciphertext: new Uint8Array(envelope.ciphertext)
})

const freezeEnvelope = (envelope: OfflineDraftEnvelopeV1): OfflineDraftEnvelopeV1 => Object.freeze(cloneEnvelope(envelope))
const freezePayload = (payload: OfflineDraftPayloadV1): OfflineDraftPayloadV1 => Object.freeze(clonePayload(payload))

const cloneRecovery = (recovery: OfflineDraftRecovery | null): OfflineDraftRecovery | null =>
  recovery === null
    ? null
    : {
        recordId: recovery.recordId,
        draftRevision: recovery.draftRevision,
        payload: clonePayload(recovery.payload)
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

/** Stable opaque identity for a create-page editor session. */
export const createOfflineDraftIdentity = (): string => randomIdentifier()

const isSubmission = (envelope: OfflineDraftEnvelopeV1): boolean => envelope.submissionId !== null

const sameEditorIdentity = (payload: OfflineDraftPayloadV1, identity: OfflineEditorDraftIdentity): boolean => {
  if (payload.editorKey !== identity.editorKey) return false
  if (identity.pageId !== null) return payload.pageId === identity.pageId
  return payload.pageId === null && payload.createIdentity !== null && payload.createIdentity === identity.createIdentity
}

const sameFullIdentity = (left: OfflineEditorDraftIdentity, right: OfflineEditorDraftIdentity): boolean =>
  left.editorKey === right.editorKey &&
  left.pageId === right.pageId &&
  left.createIdentity === right.createIdentity &&
  left.locale === right.locale &&
  left.path === right.path &&
  left.baseSourceRevision === right.baseSourceRevision &&
  left.baseUpdatedAt === right.baseUpdatedAt

const sameText = (payload: OfflineDraftPayloadV1, values: OfflineEditorDraftValues): boolean =>
  payload.title === values.title && payload.description === values.description && payload.content === values.content

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => left.byteLength === right.byteLength && left.every((value, index) => value === right[index])

const sameEnvelope = (left: OfflineDraftEnvelopeV1, right: OfflineDraftEnvelopeV1): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.recordId === right.recordId &&
  left.accountId === right.accountId &&
  left.authVersion === right.authVersion &&
  left.keyVersion === right.keyVersion &&
  left.sessionGeneration === right.sessionGeneration &&
  left.draftRevision === right.draftRevision &&
  left.submissionId === right.submissionId &&
  sameBytes(left.nonce, right.nonce) &&
  sameBytes(left.ciphertext, right.ciphertext)

const sameSubmission = (left: OfflineDraftSubmission, right: OfflineDraftSubmission): boolean =>
  left.recordId === right.recordId &&
  left.sessionGeneration === right.sessionGeneration &&
  left.draftRevision === right.draftRevision &&
  left.submissionId === right.submissionId

const compareRecovery = (left: OfflineDraftRecovery, right: OfflineDraftRecovery): number => {
  if (left.draftRevision !== right.draftRevision) return left.draftRevision - right.draftRevision
  if (left.payload.updatedAt !== right.payload.updatedAt) return left.payload.updatedAt < right.payload.updatedAt ? -1 : 1
  return left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0
}

const stateForCapture = (state: OfflineDraftState | null, reviewRequired: boolean): OfflineDraftState =>
  state === 'unavailable' ? 'unavailable' : reviewRequired || state === 'needs-review' ? 'needs-review' : 'local'

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

const makeSubmission = (envelope: OfflineDraftEnvelopeV1): OfflineDraftSubmission => ({
  recordId: envelope.recordId,
  sessionGeneration: envelope.sessionGeneration,
  draftRevision: envelope.draftRevision,
  submissionId: envelope.submissionId!
})

const makePayload = (
  state: OfflineDraftState,
  identity: OfflineEditorDraftIdentity,
  values: OfflineEditorDraftValues,
  updatedAt = new Date().toISOString()
): OfflineDraftPayloadV1 =>
  OfflineDraftPayloadV1Schema.parse({
    editorKey: identity.editorKey,
    pageId: identity.pageId,
    createIdentity: identity.createIdentity,
    locale: identity.locale,
    path: identity.path,
    baseSourceRevision: identity.baseSourceRevision,
    baseUpdatedAt: identity.baseUpdatedAt,
    updatedAt,
    state,
    title: values.title,
    description: values.description,
    content: values.content
  })

const statusForOutcome = (outcome: OfflineSubmissionOutcome): { kind: SubmissionOutcomeKind; status: number | null; reason: string | null } => {
  if (outcome.kind === 'success') return { kind: 'success', status: null, reason: outcome.postWriteError ?? null }
  if (outcome.kind === 'rejected') return { kind: 'rejected', status: outcome.status, reason: outcome.reason ?? null }
  if (outcome.kind === 'post-write') return { kind: 'post-write', status: outcome.status ?? null, reason: outcome.reason ?? null }
  return { kind: 'unknown', status: outcome.status ?? null, reason: outcome.reason ?? null }
}

/**
 * Serializes every mutable transition for one editor draft. Network callers
 * explicitly prepare and complete a foreground submission; this class never
 * replays a mutation or rewrites an immutable receipt.
 */
export class OfflineEditorDraftCoordinator {
  private readonly options: OfflineEditorDraftCoordinatorOptions
  private readonly debounceMs: number
  private readonly ownsStorage: boolean
  private storage: OfflineStorage | null
  private storagePromise: Promise<OfflineStorage> | null = null
  private keyHandle: OfflineDraftKeyHandle | null = null
  private keyGeneration: number | null = null
  private keyActorEpoch: ActorEpoch | null = null
  private captureTimer: ReturnType<typeof setTimeout> | null = null
  private capturePromise: Promise<boolean> | null = null
  private capturePromiseVersion = 0
  private discardPromise: Promise<boolean> | null = null
  private discarding = false
  private transitionTail: Promise<unknown> = Promise.resolve()
  private transitionPending = 0
  private destroyed = false
  private reviewRequired = false
  private unavailableLatched = false
  private latestEditVersion = 0
  private committedEditVersion = 0
  private currentDraft: CurrentDraft | null = null
  private activePrepared: InternalPrepared | null = null
  private draftState: DraftState = {
    state: null,
    candidate: null,
    candidates: [],
    submissionCandidates: [],
    committed: false,
    inFlight: false,
    error: null
  }
  private readonly envelopes = new Map<string, OfflineDraftEnvelopeV1>()
  private outcomeKind: SubmissionOutcomeKind | null = null
  private outcomeStatus: number | null = null
  private safetyCounter = 0

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

  get reloadSafetySnapshot(): OfflineEditorReloadSafetySnapshot {
    let actorEpoch: ActorEpoch | undefined
    try {
      actorEpoch = this.readActorEpoch()
    } catch {
      actorEpoch = undefined
    }
    let facts: OfflineEditorReloadSafetyFacts = {}
    try {
      facts = this.options.getReloadSafetyFacts?.() ?? {}
    } catch {
      facts = { dirtyMetadata: true }
    }
    const valuesCommitted = this.currentDraft === null ? this.options.isDirty?.() !== true : this.hasCommittedCurrentValues
    const metadataDirty = facts.dirtyMetadata === true
    const mergeState = facts.mergeState === true
    const collaborationBacklog = facts.collaborationBacklog === true || (typeof facts.collaborationBacklog === 'number' && facts.collaborationBacklog > 0)
    const safe =
      !this.destroyed &&
      valuesCommitted &&
      !metadataDirty &&
      !mergeState &&
      !collaborationBacklog &&
      this.transitionPending === 0 &&
      this.captureTimer === null &&
      this.activePrepared === null &&
      this.draftState.submissionCandidates.length === 0 &&
      this.draftState.error === null
    const revision = `${this.safetyCounter}:${this.latestEditVersion}:${this.committedEditVersion}:${facts.routeIdentity ?? ''}:${safe ? 'safe' : 'unsafe'}`
    return actorEpoch === undefined ? { safe, revision } : { safe, revision, actorEpoch }
  }

  get hasCommittedDraft(): boolean {
    return this.draftState.committed
  }

  get hasCommittedCurrentValues(): boolean {
    if (!this.currentDraft) return false
    try {
      return sameText(this.currentDraft.payload, this.currentValues()) && this.committedEditVersion >= this.latestEditVersion
    } catch {
      return false
    }
  }

  get hasInFlightWork(): boolean {
    return this.draftState.inFlight || this.captureTimer !== null || this.transitionPending > 0
  }

  get hasUnresolvedSubmission(): boolean {
    return this.activePrepared !== null || this.draftState.submissionCandidates.length > 0
  }

  get submissionOutcome(): SubmissionOutcomeKind | null {
    return this.outcomeKind
  }

  get submissionStatus(): number | null {
    return this.outcomeStatus
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
      // Presentation callbacks cannot affect persistence.
    }
    this.safetyCounter += 1
    try {
      this.options.onSafetyChange?.(this.reloadSafetySnapshot)
    } catch {
      // Lifecycle callbacks cannot affect persistence.
    }
  }

  private setState(patch: Partial<DraftState>): void {
    if (this.destroyed) return
    if (patch.state === 'unavailable') this.unavailableLatched = true
    const effectivePatch =
      this.unavailableLatched && patch.state !== undefined && patch.state !== 'unavailable' ? { ...patch, state: 'unavailable' as const } : patch
    this.draftState = { ...this.draftState, ...effectivePatch }
    this.emit()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.transitionPending += 1
    if (!this.destroyed) this.setState({ inFlight: true })
    const previous = this.transitionTail
    const run = previous.catch(() => undefined).then(() => operation())
    const settled = run.then(
      value => {
        this.transitionPending = Math.max(0, this.transitionPending - 1)
        if (!this.destroyed) this.setState({ inFlight: this.transitionPending > 0 })
        return value
      },
      error => {
        this.transitionPending = Math.max(0, this.transitionPending - 1)
        if (!this.destroyed) this.setState({ inFlight: this.transitionPending > 0 })
        throw error
      }
    )
    this.transitionTail = settled.then(
      () => undefined,
      () => undefined
    )
    return settled
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

  private readActorEpoch(): ActorEpoch {
    const supplied = this.options.getActorEpoch?.()
    if (typeof supplied === 'string' || (typeof supplied === 'number' && Number.isSafeInteger(supplied))) return supplied
    return `${this.options.accountId()}`
  }
  private clearTransientReferences(): void {
    this.keyHandle = null
    this.keyGeneration = null
    this.keyActorEpoch = null
    this.currentDraft = null
    this.activePrepared = null
    this.reviewRequired = false
    this.envelopes.clear()
    this.outcomeKind = null
    this.outcomeStatus = null
  }

  private async ensureSession(signal?: AbortSignal): Promise<{ storage: OfflineStorage; handle: OfflineDraftKeyHandle; actorEpoch: ActorEpoch } | null> {
    if (this.destroyed || !this.isAuthenticatedUser()) return null
    const accountId = this.options.accountId()
    if (!POSITIVE_SAFE_INTEGER(accountId)) return null
    const actorEpoch = this.readActorEpoch()
    const storage = await this.getStorage()
    const generation = await storage.currentSessionGeneration()
    if (!this.isAuthenticatedUser() || this.readActorEpoch() !== actorEpoch) return null
    const existing = this.keyHandle
    if (
      existing &&
      this.keyGeneration === generation &&
      this.keyActorEpoch === actorEpoch &&
      existing.context.accountId === accountId &&
      existing.sessionGeneration === generation &&
      isCurrentOfflineDraftKey(existing)
    ) {
      return { storage, handle: existing, actorEpoch }
    }
    if (existing) this.clearTransientReferences()
    const handle = await requestDraftKey(this.options.fetchImpl, {
      expectedAccountId: accountId,
      expectedSessionGeneration: generation,
      signal
    })
    if (
      handle.context.accountId !== accountId ||
      handle.sessionGeneration !== generation ||
      !NONNEGATIVE_SAFE_INTEGER(handle.context.authVersion) ||
      !this.isAuthenticatedUser() ||
      this.readActorEpoch() !== actorEpoch ||
      !isCurrentOfflineDraftKey(handle)
    ) {
      throw new Error('The verified offline draft session did not match the current owner.')
    }
    this.keyHandle = handle
    this.keyGeneration = generation
    this.keyActorEpoch = actorEpoch
    return { storage, handle, actorEpoch }
  }

  private fenceCurrent(actorEpoch: ActorEpoch, handle?: OfflineDraftKeyHandle): boolean {
    if (this.destroyed || !this.isAuthenticatedUser()) return false
    try {
      if (this.readActorEpoch() !== actorEpoch) return false
    } catch {
      return false
    }
    return handle === undefined || isCurrentOfflineDraftKey(handle)
  }

  private currentIdentity(): OfflineEditorDraftIdentity {
    return safeIdentity(this.options.getIdentity())
  }

  private currentValues(): OfflineEditorDraftValues {
    return safeValues(this.options.getValues())
  }

  private async listMatchingRecords(
    storage: OfflineStorage,
    handle: OfflineDraftKeyHandle,
    identity: OfflineEditorDraftIdentity,
    actorEpoch: ActorEpoch
  ): Promise<OfflineDraftRecovery[]> {
    const records = await storage.listDraftEnvelopes(handle.context.accountId, { expectedSessionGeneration: handle.sessionGeneration })
    const matches: OfflineDraftRecovery[] = []
    for (const envelope of records) {
      if (!this.fenceCurrent(actorEpoch, handle)) return []
      const currentGeneration = envelope.sessionGeneration === handle.sessionGeneration
      const olderGeneration = envelope.sessionGeneration < handle.sessionGeneration
      if (
        envelope.accountId !== handle.context.accountId ||
        envelope.authVersion !== handle.context.authVersion ||
        envelope.keyVersion !== handle.context.keyVersion ||
        (!currentGeneration && !olderGeneration) ||
        isSubmission(envelope)
      )
        continue
      try {
        let payload: OfflineDraftPayloadV1
        let retained = cloneEnvelope(envelope)
        if (currentGeneration) {
          payload = await decryptOfflineDraft(handle, envelope)
        } else {
          payload = await decryptOfflineDraftForReconciliation(handle, envelope)
          if (!sameEditorIdentity(payload, identity) || payload.locale !== identity.locale) continue
          if (typeof storage.recoverOrdinaryDraft !== 'function') continue
          const replacement = await encryptOfflineDraft(handle, payload, {
            recordId: envelope.recordId,
            draftRevision: envelope.draftRevision,
            submissionId: null
          })
          retained = cloneEnvelope(
            await storage.recoverOrdinaryDraft(envelope, replacement, {
              expectedSessionGeneration: handle.sessionGeneration
            })
          )
        }
        if (!this.fenceCurrent(actorEpoch, handle)) return []
        if (!sameEditorIdentity(payload, identity) || payload.locale !== identity.locale) continue
        this.envelopes.set(retained.recordId, retained)
        matches.push({ recordId: retained.recordId, draftRevision: retained.draftRevision, payload })
      } catch {
        // Wrong-owner, malformed, and undecryptable rows remain opaque.
      }
    }
    return matches.sort(compareRecovery)
  }

  private async listMatchingSubmissions(
    storage: OfflineStorage,
    handle: OfflineDraftKeyHandle,
    identity: OfflineEditorDraftIdentity,
    actorEpoch: ActorEpoch
  ): Promise<OfflineDraftSubmissionRecovery[]> {
    const records = await storage.listDraftEnvelopes(handle.context.accountId, { expectedSessionGeneration: handle.sessionGeneration })
    const matches: OfflineDraftSubmissionRecovery[] = []
    for (const envelope of records) {
      if (!this.fenceCurrent(actorEpoch, handle)) return []
      if (
        envelope.accountId !== handle.context.accountId ||
        envelope.authVersion !== handle.context.authVersion ||
        envelope.keyVersion !== handle.context.keyVersion ||
        !isSubmission(envelope)
      )
        continue
      let payload: OfflineDraftPayloadV1
      let retained = cloneEnvelope(envelope)
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
          if (typeof storage.rewrapSubmission === 'function') {
            try {
              retained = cloneEnvelope(
                await storage.rewrapSubmission(envelope, replacement, {
                  expectedSessionGeneration: handle.sessionGeneration
                })
              )
            } catch {
              retained = cloneEnvelope(envelope)
            }
          }
        }
        if (!this.fenceCurrent(actorEpoch, handle)) return []
      } catch {
        // Wrong-owner, malformed, and undecryptable receipts remain opaque.
        continue
      }
      if (!sameEditorIdentity(payload, identity) && !(identity.pageId !== null && payload.pageId === identity.pageId)) continue
      this.envelopes.set(retained.recordId, cloneEnvelope(retained))
      const submission = makeSubmission(retained)
      const unknownPayload = OfflineDraftPayloadV1Schema.parse({ ...payload, state: 'outcome-unknown' })
      matches.push({ submission, payload: unknownPayload })
    }
    return matches.sort((left, right) => {
      if (left.payload.updatedAt !== right.payload.updatedAt) return left.payload.updatedAt < right.payload.updatedAt ? -1 : 1
      return left.submission.recordId < right.submission.recordId ? -1 : left.submission.recordId > right.submission.recordId ? 1 : 0
    })
  }

  private async initializeInternal(signal?: AbortSignal): Promise<OfflineEditorDraftView> {
    if (this.destroyed || !this.isAuthenticatedUser()) return this.view
    const session = await this.ensureSession(signal)
    if (!session || this.destroyed) return this.view
    const identity = this.currentIdentity()
    const values = this.currentValues()
    const matches = await this.listMatchingRecords(session.storage, session.handle, identity, session.actorEpoch)
    const submissions = await this.listMatchingSubmissions(session.storage, session.handle, identity, session.actorEpoch)
    if (!this.fenceCurrent(session.actorEpoch, session.handle)) return this.view
    const newest = matches[matches.length - 1]
    const isNewer = newest !== undefined && !sameText(newest.payload, values)
    this.currentDraft =
      newest !== undefined && !isNewer
        ? {
            recordId: newest.recordId,
            draftRevision: newest.draftRevision,
            payload: clonePayload(newest.payload),
            envelope: cloneEnvelope(this.envelopes.get(newest.recordId)!)
          }
        : null
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
    this.unavailableLatched = state === 'unavailable'
    this.draftState = {
      ...this.draftState,
      state,
      candidate,
      candidates: candidateChoices,
      submissionCandidates: submissions,
      committed: matches.length > 0 || submissions.length > 0,
      error: null
    }
    this.emit()
    return this.view
  }
  async initialize(signal?: AbortSignal): Promise<OfflineEditorDraftView> {
    await this.enqueue(async () => {
      try {
        await this.initializeInternal(signal)
      } catch {
        this.setState({ candidate: null, candidates: [], submissionCandidates: [], error: 'A verified connection is required to recover local drafts.' })
      }
    })
    return this.view
  }

  private captureVersion(editVersion?: number, force = false): number {
    const requested = editVersion === undefined ? this.latestEditVersion + (force || this.latestEditVersion === 0 ? 1 : 0) : editVersion
    if (!NONNEGATIVE_SAFE_INTEGER(requested)) throw new TypeError('The editor version is invalid.')
    this.latestEditVersion = Math.max(this.latestEditVersion, requested)
    return requested
  }

  /** Queue a capture and resolve only after this edit version or a newer one is durable. */
  captureThrough(editVersion: number, stateOverride?: OfflineDraftState): Promise<boolean> {
    if (this.destroyed || this.discarding) return Promise.resolve(false)
    const version = this.captureVersion(editVersion)
    const unavailableOverride = stateOverride === 'unavailable'
    if (stateOverride === undefined && version <= this.committedEditVersion && this.hasCommittedCurrentValues) {
      if (this.unavailableLatched && this.draftState.state !== 'unavailable') this.setState({ state: 'unavailable' })
      return Promise.resolve(true)
    }
    if (!unavailableOverride && this.capturePromise && version <= this.capturePromiseVersion) return this.capturePromise
    const operation = this.enqueue(async () => {
      if (this.destroyed || this.discarding || !this.isAuthenticatedUser()) {
        if (unavailableOverride && !this.destroyed) {
          this.unavailableLatched = true
          this.setState({ state: 'unavailable' })
        }
        return false
      }
      if (unavailableOverride) this.unavailableLatched = true
      try {
        const snapshot: CaptureSnapshot = {
          values: this.currentValues(),
          identity: this.currentIdentity(),
          editVersion: Math.max(version, this.latestEditVersion),
          stateOverride
        }
        const captured = await this.captureInternal(snapshot, true)
        if (unavailableOverride) {
          this.unavailableLatched = true
          this.setState({ state: 'unavailable' })
        }
        return captured
      } catch {
        if (unavailableOverride) {
          this.unavailableLatched = true
          this.setState({ state: 'unavailable', error: 'Your changes could not be saved on this device.' })
        } else {
          this.setState({ error: 'Your changes could not be saved on this device.' })
        }
        return false
      }
    })
    if (unavailableOverride) return operation
    this.capturePromiseVersion = Math.max(this.capturePromiseVersion, version)
    const shared = operation.then(
      result => {
        if (this.capturePromise === shared) {
          this.capturePromise = null
          this.capturePromiseVersion = 0
        }
        return result
      },
      error => {
        if (this.capturePromise === shared) {
          this.capturePromise = null
          this.capturePromiseVersion = 0
        }
        throw error
      }
    )
    this.capturePromise = shared
    return shared
  }

  /** Queue an encrypted local capture while the editor remains dirty. */
  scheduleCapture(editVersion?: number): void {
    if (this.destroyed || this.discarding || !this.isAuthenticatedUser() || this.options.isDirty?.() === false) return
    const version = this.captureVersion(editVersion, true)
    if (this.captureTimer !== null) clearTimeout(this.captureTimer)
    this.captureTimer = setTimeout(() => {
      this.captureTimer = null
      void this.captureThrough(version).catch(() => undefined)
    }, this.debounceMs)
    this.emit()
  }

  /** Immediately commit the current editor text. */
  captureNow(options: { force?: boolean; state?: OfflineDraftState; editVersion?: number } = {}): Promise<boolean> {
    if (this.captureTimer !== null) {
      clearTimeout(this.captureTimer)
      this.captureTimer = null
    }
    if (this.discarding) return Promise.resolve(false)
    const version = this.captureVersion(options.editVersion, options.force === true)
    return this.captureThrough(version, options.state)
  }

  private async captureInternal(snapshot: CaptureSnapshot, force: boolean): Promise<boolean> {
    if (this.destroyed || this.discarding || !this.isAuthenticatedUser()) return false
    if (!force && this.options.isDirty?.() === false) return false
    const session = await this.ensureSession()
    if (!session || !this.fenceCurrent(session.actorEpoch, session.handle)) return false
    const previous = this.currentDraft
    const frozenSource = this.activePrepared?.sourceEnvelope ?? null
    const previousIsFrozenSource =
      frozenSource !== null && previous !== null && previous.recordId === frozenSource.recordId && previous.draftRevision === frozenSource.draftRevision
    const captureIdentity = previous
      ? {
          ...snapshot.identity,
          baseSourceRevision: previous.payload.baseSourceRevision,
          baseUpdatedAt: previous.payload.baseUpdatedAt
        }
      : snapshot.identity
    const nextState =
      snapshot.stateOverride ??
      (this.unavailableLatched ? 'unavailable' : stateForCapture(previous?.payload.state ?? this.draftState.state, this.reviewRequired))
    const payload = makePayload(nextState, captureIdentity, snapshot.values)
    const recordId = previousIsFrozenSource ? randomIdentifier() : (previous?.recordId ?? randomIdentifier())
    const previousRevision = previousIsFrozenSource ? frozenSource.draftRevision : (previous?.draftRevision ?? 0)
    const draftRevision = Math.max(1, previousRevision + 1)
    const envelope = await encryptOfflineDraft(session.handle, payload, {
      recordId,
      draftRevision,
      submissionId: null
    })
    if (!this.fenceCurrent(session.actorEpoch, session.handle)) return false
    try {
      await session.storage.putDraft(envelope, {
        expectedSessionGeneration: session.handle.sessionGeneration,
        expectedDraftRevision: previous && !previousIsFrozenSource ? previousRevision : null,
        expectedSubmissionId: null
      })
    } catch (error) {
      if (error instanceof OfflineDraftConflictError) {
        this.reviewRequired = true
        this.setState({ state: 'needs-review', error: 'Your local draft changed before it could be saved; review the available versions.' })
      } else {
        this.setState({ error: 'Your changes could not be saved on this device.' })
      }
      return false
    }
    if (!this.fenceCurrent(session.actorEpoch, session.handle)) return false
    const savedEnvelope = cloneEnvelope(envelope)
    const savedPayload = clonePayload(payload)
    this.envelopes.set(recordId, savedEnvelope)
    this.currentDraft = { recordId, draftRevision, payload: savedPayload, envelope: savedEnvelope }
    this.committedEditVersion = Math.max(this.committedEditVersion, snapshot.editVersion)
    this.setState({ state: this.activePrepared ? 'publishing' : payload.state, committed: true, error: null })
    return true
  }

  private selectedCandidate(recordId?: string): OfflineDraftRecovery | null {
    return (
      (recordId === undefined ? this.draftState.candidate : this.draftState.candidates.find(item => item.recordId === recordId)) ??
      (this.draftState.candidates.length === 1 ? this.draftState.candidates[0]! : null)
    )
  }

  private selectedSubmission(recordId: string): OfflineDraftSubmissionRecovery | null {
    return this.draftState.submissionCandidates.find(item => item.submission.recordId === recordId) ?? null
  }

  private detachEditor(): void {
    try {
      this.options.detachForDraft?.()
    } catch {
      // A detach callback is a boundary; persistence remains authoritative.
    }
  }

  private applyDetachedPayload(payload: OfflineDraftPayloadV1, replace: boolean): void {
    this.detachEditor()
    const callback = replace ? this.options.detachedReplace : this.options.detachedApply
    callback?.(clonePayload(payload))
  }

  /** Apply a durable candidate only after detaching collaboration/editor state. */
  async applyDetachedCandidate(recordId?: string): Promise<OfflineDraftPayloadV1 | null> {
    return this.enqueue(async () => {
      const candidate = this.selectedCandidate(recordId)
      if (!candidate || this.destroyed || !this.isAuthenticatedUser()) return null
      try {
        if (!sameEditorIdentity(candidate.payload, this.currentIdentity())) return null
        this.applyDetachedPayload(candidate.payload, false)
        const envelope = this.envelopes.get(candidate.recordId)
        if (envelope)
          this.currentDraft = {
            recordId: candidate.recordId,
            draftRevision: candidate.draftRevision,
            payload: clonePayload(candidate.payload),
            envelope: cloneEnvelope(envelope)
          }
        this.reviewRequired = true
        const candidates = this.draftState.candidates.filter(item => item.recordId !== candidate.recordId)
        this.setState({ state: 'needs-review', candidate: null, candidates, committed: true, error: null })
        return clonePayload(candidate.payload)
      } catch {
        this.setState({ error: 'The local draft could not be restored.' })
        return null
      }
    })
  }

  /** Replace editor content from a selected candidate; submission replacements are atomic. */
  async replaceDetachedCandidate(payload: OfflineDraftPayloadV1, recordId?: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.destroyed || !this.isAuthenticatedUser()) return false
      let parsed: OfflineDraftPayloadV1
      try {
        parsed = OfflineDraftPayloadV1Schema.parse(payload)
      } catch {
        this.setState({ error: 'The local draft could not be replaced.' })
        return false
      }
      const submissionCandidate = recordId === undefined ? null : this.selectedSubmission(recordId)
      if (submissionCandidate) {
        const session = await this.ensureSession()
        if (!session || !this.fenceCurrent(session.actorEpoch, session.handle)) return false
        const expectedSource = this.currentDraft && this.currentDraft.envelope.submissionId === null ? cloneEnvelope(this.currentDraft.envelope) : null
        if (!expectedSource) {
          this.setState({ error: 'The unresolved submission has no mutable source draft to replace.' })
          return false
        }
        const forkPayload = OfflineDraftPayloadV1Schema.parse({ ...parsed, state: 'needs-review', updatedAt: new Date().toISOString() })
        const fork = await encryptOfflineDraft(session.handle, forkPayload, {
          recordId: randomIdentifier(),
          draftRevision: expectedSource.draftRevision + 1,
          submissionId: null
        })
        const receiptRecordId = recordId
        if (receiptRecordId === undefined) return false
        const receipt = this.envelopes.get(receiptRecordId)
        if (!receipt) return false
        try {
          await session.storage.finalizeSubmission({
            expectedSessionGeneration: session.handle.sessionGeneration,
            expectedReceipt: cloneEnvelope(receipt),
            expectedSource,
            expectedSurvivingFork: null,
            survivingFork: fork
          })
        } catch {
          this.setState({ error: 'The unresolved submission receipt remains retained for review.' })
          return false
        }
        this.envelopes.delete(receiptRecordId)
        this.envelopes.set(fork.recordId, cloneEnvelope(fork))
        this.currentDraft = { recordId: fork.recordId, draftRevision: fork.draftRevision, payload: clonePayload(forkPayload), envelope: cloneEnvelope(fork) }
        this.reviewRequired = true
        let applied = true
        try {
          this.applyDetachedPayload(forkPayload, true)
        } catch {
          applied = false
        }
        const submissionCandidates = this.draftState.submissionCandidates.filter(item => item.submission.recordId !== receiptRecordId)
        this.setState({
          state: 'needs-review',
          submissionCandidates,
          committed: true,
          error: applied ? null : 'The local review fork was saved, but the editor could not be replaced.'
        })
        return applied
      }
      try {
        this.applyDetachedPayload(parsed, true)
        this.reviewRequired = true
        this.setState({ state: 'needs-review', error: null })
        return true
      } catch {
        this.setState({ error: 'The local draft could not be replaced.' })
        return false
      }
    })
  }

  /** Explicitly clear a candidate/receipt only after the durable delete succeeds. */
  async clearDetachedCandidate(recordId?: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.destroyed || !this.isAuthenticatedUser()) return false
      const candidate = this.selectedCandidate(recordId)
      const submission = recordId === undefined ? null : this.selectedSubmission(recordId)
      const target = candidate?.recordId ?? submission?.submission.recordId ?? null
      if (!target) return true
      const envelope = this.envelopes.get(target)
      const session = await this.ensureSession()
      if (!session || !envelope || !this.fenceCurrent(session.actorEpoch, session.handle)) return false
      let deleted = false
      try {
        deleted = await session.storage.deleteDraft(target, {
          expectedSessionGeneration: session.handle.sessionGeneration,
          expectedDraftRevision: envelope.draftRevision,
          expectedSubmissionId: envelope.submissionId
        })
      } catch {
        this.setState({ error: 'The local draft could not be discarded.' })
        return false
      }
      if (!deleted) return false
      this.envelopes.delete(target)
      if (this.currentDraft?.recordId === target) this.currentDraft = null
      try {
        this.detachEditor()
        this.options.detachedClear?.()
      } catch {
        // The durable deletion remains authoritative if editor cleanup fails.
      }
      const candidates = this.draftState.candidates.filter(item => item.recordId !== target)
      const submissionCandidates = this.draftState.submissionCandidates.filter(item => item.submission.recordId !== target)
      this.setState({
        candidate: null,
        candidates,
        submissionCandidates,
        state:
          submissionCandidates.length > 0
            ? 'outcome-unknown'
            : candidates.length > 0
              ? 'needs-review'
              : this.currentDraft
                ? this.currentDraft.payload.state
                : null,
        committed: this.currentDraft !== null || candidates.length > 0 || submissionCandidates.length > 0,
        error: null
      })
      return true
    })
  }

  async discardCurrentDraft(): Promise<boolean> {
    if (this.discardPromise) return this.discardPromise
    this.discarding = true
    if (this.captureTimer !== null) {
      clearTimeout(this.captureTimer)
      this.captureTimer = null
    }
    const operation = this.enqueue(async () => {
      if (this.destroyed || !this.isAuthenticatedUser()) return true
      const current = this.currentDraft
      if (!current) return true
      const session = await this.ensureSession()
      if (!session || !this.fenceCurrent(session.actorEpoch, session.handle)) {
        this.setState({ error: 'The local draft could not be discarded.' })
        return false
      }
      try {
        const deleted = await session.storage.deleteDraft(current.recordId, {
          expectedSessionGeneration: session.handle.sessionGeneration,
          expectedDraftRevision: current.draftRevision,
          expectedSubmissionId: null
        })
        if (!deleted) {
          this.setState({ error: 'The local draft could not be discarded.' })
          return false
        }
        this.envelopes.delete(current.recordId)
        this.currentDraft = null
        this.setState({
          state: this.draftState.submissionCandidates.length > 0 ? 'outcome-unknown' : this.draftState.candidates.length > 0 ? 'needs-review' : null,
          committed: this.draftState.candidates.length > 0 || this.draftState.submissionCandidates.length > 0,
          error: null
        })
        return true
      } catch {
        this.setState({ error: 'The local draft could not be discarded.' })
        return false
      }
    })
    const shared = operation.then(
      result => {
        if (this.discardPromise === shared) {
          this.discardPromise = null
          this.discarding = false
        }
        return result
      },
      error => {
        if (this.discardPromise === shared) {
          this.discardPromise = null
          this.discarding = false
        }
        throw error
      }
    )
    this.discardPromise = shared
    return shared
  }

  private async findStoredSubmission(
    session: { storage: OfflineStorage; handle: OfflineDraftKeyHandle },
    prepared: InternalPrepared
  ): Promise<OfflineDraftEnvelopeV1 | null> {
    const records = await session.storage.listDraftEnvelopes(session.handle.context.accountId, {
      expectedSessionGeneration: session.handle.sessionGeneration
    })
    const found = records.find(record => sameEnvelope(record, prepared.envelope))
    return found ? cloneEnvelope(found) : null
  }

  private async prepareInternal(snapshot: CaptureSnapshot): Promise<PreparedOfflineSubmission | null> {
    if (
      this.destroyed ||
      !this.isAuthenticatedUser() ||
      this.activePrepared ||
      this.draftState.submissionCandidates.length > 0 ||
      this.draftState.candidate ||
      this.draftState.candidates.length > 0
    )
      return null
    const session = await this.ensureSession()
    if (!session || !this.fenceCurrent(session.actorEpoch, session.handle)) return null
    const sourceState = stateForCapture(this.currentDraft?.payload.state ?? this.draftState.state, this.reviewRequired)
    const sourceMatches =
      this.currentDraft !== null &&
      sameText(this.currentDraft.payload, snapshot.values) &&
      sameFullIdentity(
        {
          editorKey: this.currentDraft.payload.editorKey,
          pageId: this.currentDraft.payload.pageId,
          createIdentity: this.currentDraft.payload.createIdentity,
          locale: this.currentDraft.payload.locale,
          path: this.currentDraft.payload.path,
          baseSourceRevision: this.currentDraft.payload.baseSourceRevision,
          baseUpdatedAt: this.currentDraft.payload.baseUpdatedAt
        },
        snapshot.identity
      )
    let sourceEnvelope: OfflineDraftEnvelopeV1
    let sourcePayload: OfflineDraftPayloadV1
    if (sourceMatches && this.currentDraft) {
      sourceEnvelope = cloneEnvelope(this.currentDraft.envelope)
      sourcePayload = clonePayload(this.currentDraft.payload)
    } else {
      sourcePayload = makePayload(sourceState, snapshot.identity, snapshot.values)
      sourceEnvelope = await encryptOfflineDraft(session.handle, sourcePayload, {
        recordId: this.currentDraft?.recordId ?? randomIdentifier(),
        draftRevision: Math.max(1, (this.currentDraft?.draftRevision ?? 0) + (this.currentDraft ? 1 : 0)),
        submissionId: null
      })
      await session.storage.putDraft(sourceEnvelope, {
        expectedSessionGeneration: session.handle.sessionGeneration,
        expectedDraftRevision: this.currentDraft ? this.currentDraft.draftRevision : null,
        expectedSubmissionId: null
      })
      this.currentDraft = {
        recordId: sourceEnvelope.recordId,
        draftRevision: sourceEnvelope.draftRevision,
        payload: clonePayload(sourcePayload),
        envelope: cloneEnvelope(sourceEnvelope)
      }
      this.envelopes.set(sourceEnvelope.recordId, cloneEnvelope(sourceEnvelope))
      this.committedEditVersion = Math.max(this.committedEditVersion, snapshot.editVersion)
    }
    const submissionId = randomIdentifier()
    const submissionPayload = makePayload('publishing', snapshot.identity, snapshot.values)
    const receiptEnvelope = await encryptOfflineDraft(session.handle, submissionPayload, {
      recordId: randomIdentifier(),
      draftRevision: sourceEnvelope.draftRevision,
      submissionId
    })
    if (!this.fenceCurrent(session.actorEpoch, session.handle)) return null
    await session.storage.putDraft(receiptEnvelope, {
      expectedSessionGeneration: session.handle.sessionGeneration,
      expectedDraftRevision: null,
      expectedSubmissionId: null
    })
    const receipt = cloneEnvelope(receiptEnvelope)
    const source = cloneEnvelope(sourceEnvelope)
    const submission = makeSubmission(receipt)
    const publicValue = Object.freeze({
      submission: Object.freeze({ ...submission }),
      recordId: submission.recordId,
      sessionGeneration: submission.sessionGeneration,
      draftRevision: submission.draftRevision,
      submissionId: submission.submissionId,
      envelope: freezeEnvelope(receipt),
      payload: freezePayload(submissionPayload),
      sourceEnvelope: freezeEnvelope(source),
      sourcePayload: freezePayload(sourcePayload),
      editVersion: snapshot.editVersion,
      actorEpoch: session.actorEpoch,
      identity: Object.freeze(cloneIdentity(snapshot.identity)),
      baseSourceRevision: snapshot.identity.baseSourceRevision,
      baseUpdatedAt: snapshot.identity.baseUpdatedAt
    })
    this.activePrepared = {
      publicValue,
      envelope: receipt,
      payload: clonePayload(submissionPayload),
      sourceEnvelope: source,
      sourcePayload: clonePayload(sourcePayload),
      actorEpoch: session.actorEpoch
    }
    this.envelopes.set(receipt.recordId, cloneEnvelope(receipt))
    this.outcomeKind = null
    this.outcomeStatus = null
    this.reviewRequired = false
    this.setState({ state: 'publishing', committed: true, error: null })
    return publicValue
  }

  /** Freeze one exact editor snapshot and commit its immutable receipt before network dispatch. */
  prepareSubmission(options: { readonly editVersion?: number } = {}): Promise<PreparedOfflineSubmission | null> {
    if (this.destroyed || !this.isAuthenticatedUser()) return Promise.resolve(null)
    let snapshot: CaptureSnapshot
    try {
      const editVersion = this.captureVersion(options.editVersion, true)
      snapshot = { values: this.currentValues(), identity: this.currentIdentity(), editVersion }
    } catch {
      return Promise.resolve(null)
    }
    return this.enqueue(async () => {
      try {
        return await this.prepareInternal(snapshot)
      } catch {
        this.setState({ error: 'The page was not submitted because the encrypted draft receipt could not be committed.' })
        return null
      }
    })
  }

  private async captureNewerDuringCompletion(prepared: InternalPrepared): Promise<boolean> {
    let values: OfflineEditorDraftValues
    let identity: OfflineEditorDraftIdentity
    try {
      values = this.currentValues()
      identity = this.currentIdentity()
    } catch {
      return false
    }
    const newer = this.latestEditVersion > prepared.publicValue.editVersion || !sameText(prepared.payload, values)
    if (!newer) return true
    const snapshot: CaptureSnapshot = {
      values,
      identity,
      editVersion: Math.max(this.latestEditVersion, prepared.publicValue.editVersion + 1)
    }
    return this.captureInternal(snapshot, true)
  }

  private async finalizeKnownOutcome(
    prepared: InternalPrepared,
    outcome: Extract<OfflineSubmissionOutcome, { kind: 'success' | 'rejected' | 'post-write' }>,
    state: OfflineDraftState | null
  ): Promise<boolean> {
    const session = await this.ensureSession()
    if (!session || !this.fenceCurrent(prepared.actorEpoch, session.handle)) return false
    const receipt = await this.findStoredSubmission(session, prepared)
    if (!receipt) return false
    const current = this.currentDraft
    const expectedSource = prepared.sourceEnvelope ? cloneEnvelope(prepared.sourceEnvelope) : null
    const expectedSurvivingFork = current && expectedSource && current.recordId !== expectedSource.recordId ? cloneEnvelope(current.envelope) : null
    const preparedSourceRevision = prepared.sourceEnvelope?.draftRevision ?? 0
    let survivingFork: OfflineDraftEnvelopeV1 | null = null
    let survivingForkPayload: OfflineDraftPayloadV1 | null = null
    if (outcome.kind !== 'rejected') {
      if (current && expectedSource && current.draftRevision > preparedSourceRevision) {
        const identity =
          outcome.kind === 'success' && outcome.identity
            ? {
                ...outcome.identity,
                baseSourceRevision: outcome.baseSourceRevision ?? outcome.identity.baseSourceRevision,
                baseUpdatedAt: outcome.baseUpdatedAt ?? outcome.identity.baseUpdatedAt
              }
            : this.currentIdentity()
        const values = { title: current.payload.title, description: current.payload.description, content: current.payload.content }
        survivingForkPayload = makePayload(stateForCapture(current.payload.state, this.reviewRequired), identity, values)
        survivingFork = await encryptOfflineDraft(session.handle, survivingForkPayload, {
          recordId: current.recordId,
          draftRevision: current.draftRevision + 1,
          submissionId: null
        })
      }
    } else {
      const identity = this.currentIdentity()
      const sourcePayload = current?.payload ?? prepared.sourcePayload ?? prepared.payload
      const values = { title: sourcePayload.title, description: sourcePayload.description, content: sourcePayload.content }
      survivingForkPayload = makePayload(state ?? 'needs-review', identity, values)
      survivingFork = await encryptOfflineDraft(session.handle, survivingForkPayload, {
        recordId:
          expectedSurvivingFork?.recordId ??
          (current && expectedSource && current.recordId !== expectedSource.recordId ? current.recordId : randomIdentifier()),
        draftRevision: Math.max(1, (current?.draftRevision ?? prepared.sourceEnvelope?.draftRevision ?? 0) + 1),
        submissionId: null
      })
    }
    if (!this.fenceCurrent(prepared.actorEpoch, session.handle)) return false
    const result = await session.storage.finalizeSubmission({
      expectedSessionGeneration: session.handle.sessionGeneration,
      expectedReceipt: receipt,
      expectedSource,
      expectedSurvivingFork,
      survivingFork
    })
    if (expectedSurvivingFork) this.envelopes.delete(expectedSurvivingFork.recordId)
    this.envelopes.delete(receipt.recordId)
    if (expectedSource) this.envelopes.delete(expectedSource.recordId)
    if (result.survivingFork) {
      const fork = cloneEnvelope(result.survivingFork)
      const forkPayload = survivingForkPayload ?? this.currentDraft?.payload ?? prepared.sourcePayload ?? prepared.payload
      this.envelopes.set(fork.recordId, fork)
      this.currentDraft = { recordId: fork.recordId, draftRevision: fork.draftRevision, payload: clonePayload(forkPayload), envelope: fork }
    } else {
      this.currentDraft = null
    }
    this.activePrepared = null
    this.outcomeKind = outcome.kind
    this.outcomeStatus = outcome.kind === 'rejected' || outcome.kind === 'post-write' ? (outcome.status ?? null) : null
    const error = outcome.kind === 'success' ? (outcome.postWriteError ?? null) : outcome.kind === 'post-write' ? (outcome.reason ?? null) : null
    this.setState({
      state: result.survivingFork ? (survivingForkPayload?.state ?? state) : null,
      committed: result.survivingFork !== null,
      submissionCandidates: [],
      inFlight: false,
      error
    })
    return true
  }

  /** Consume a prepared receipt exactly once; known success never becomes unknown. */
  completeSubmission(prepared: PreparedOfflineSubmission, outcome: OfflineSubmissionOutcome): Promise<boolean> {
    return this.enqueue(async () => {
      const active = this.activePrepared
      if (!active || !sameSubmission(active.publicValue.submission, prepared.submission) || !sameEnvelope(active.envelope, prepared.envelope)) return false
      if (!this.fenceCurrent(active.actorEpoch, this.keyHandle ?? undefined)) return false
      const status = statusForOutcome(outcome)
      this.outcomeKind = status.kind
      this.outcomeStatus = status.status
      if (outcome.kind === 'rejected' && outcome.status === 401) {
        try {
          await this.captureNewerDuringCompletion(active)
        } catch {
          // The identity boundary below still fences every old-generation result.
        }
        await requestOfflineIdentityBoundary({
          accountId: active.envelope.accountId,
          reason: 'unauthorized'
        })
        return false
      }
      if (outcome.kind === 'unknown') {
        const captured = await this.captureNewerDuringCompletion(active)
        const unknownPayload = OfflineDraftPayloadV1Schema.parse({ ...active.payload, state: 'outcome-unknown' })
        this.setState({
          state: 'outcome-unknown',
          submissionCandidates: [{ submission: active.publicValue.submission, payload: unknownPayload }],
          committed: true,
          inFlight: false,
          error: captured ? status.reason : 'The outcome is unknown; the immutable submission receipt remains retained for review.'
        })
        return captured
      }
      if (outcome.kind === 'post-write') {
        const newerCaptured = await this.captureNewerDuringCompletion(active)
        if (!newerCaptured) {
          this.setState({
            state: 'publishing',
            committed: true,
            inFlight: false,
            error: outcome.reason ?? 'The page write succeeded, but newer local changes could not be committed.'
          })
          return false
        }
        const finalized = await this.finalizeKnownOutcome(active, outcome, this.currentDraft?.payload.state ?? 'needs-review')
        if (!finalized) {
          this.setState({
            state: 'publishing',
            committed: true,
            inFlight: false,
            error: outcome.reason ?? 'The page write succeeded, but local finalization needs attention.'
          })
          return false
        }
        return true
      }
      const newerCaptured = await this.captureNewerDuringCompletion(active)
      if (!newerCaptured) {
        this.setState({
          state: outcome.kind === 'success' ? 'publishing' : 'needs-review',
          committed: true,
          inFlight: false,
          error: 'The server result is known, but newer local changes could not be committed.'
        })
        return false
      }
      if (outcome.kind === 'success') {
        const finalized = await this.finalizeKnownOutcome(active, outcome, null)
        if (!finalized) {
          this.setState({
            state: 'publishing',
            committed: true,
            inFlight: false,
            error: 'The page was saved, but the local submission receipt could not be finalized.'
          })
          return false
        }
        return true
      }
      const nextState: OfflineDraftState = outcome.status === 409 ? 'conflict' : outcome.status === 403 || outcome.status === 404 ? 'unavailable' : 'locked'
      const finalized = await this.finalizeKnownOutcome(active, outcome, nextState)
      if (!finalized) {
        this.setState({ state: 'publishing', committed: true, inFlight: false, error: 'The immutable submission receipt remains retained for review.' })
        return false
      }
      return true
    })
  }

  /** Reconnection changes local work to review-required; it never submits automatically. */
  markReconnected(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.destroyed || !this.isAuthenticatedUser()) return false
      if (this.unavailableLatched || this.currentDraft?.payload.state === 'unavailable' || this.draftState.state === 'unavailable') {
        this.unavailableLatched = true
        this.setState({ state: 'unavailable' })
        return true
      }
      this.reviewRequired = true
      const current = this.currentDraft
      if (!current || current.payload.state === 'needs-review') {
        if (this.draftState.state === 'local') this.setState({ state: 'needs-review' })
        return true
      }
      try {
        const session = await this.ensureSession()
        if (!session || !this.fenceCurrent(session.actorEpoch, session.handle)) return false
        const payload = makePayload(
          'needs-review',
          {
            editorKey: current.payload.editorKey,
            pageId: current.payload.pageId,
            createIdentity: current.payload.createIdentity,
            locale: current.payload.locale,
            path: current.payload.path,
            baseSourceRevision: current.payload.baseSourceRevision,
            baseUpdatedAt: current.payload.baseUpdatedAt
          },
          {
            title: current.payload.title,
            description: current.payload.description,
            content: current.payload.content
          }
        )
        const envelope = await encryptOfflineDraft(session.handle, payload, {
          recordId: current.recordId,
          draftRevision: current.draftRevision + 1,
          submissionId: null
        })
        await session.storage.putDraft(envelope, {
          expectedSessionGeneration: session.handle.sessionGeneration,
          expectedDraftRevision: current.draftRevision,
          expectedSubmissionId: null
        })
        this.currentDraft = {
          recordId: current.recordId,
          draftRevision: envelope.draftRevision,
          payload: clonePayload(payload),
          envelope: cloneEnvelope(envelope)
        }
        this.envelopes.set(envelope.recordId, cloneEnvelope(envelope))
        this.setState({ state: 'needs-review', committed: true, error: null })
        return true
      } catch {
        this.setState({ state: 'needs-review', error: 'Reconnect was detected; review the local draft before publishing.' })
        return false
      }
    })
  }

  /** Lock local projections at an auth/session boundary without touching durable receipts. */
  lock(): void {
    if (this.destroyed) return
    if (this.captureTimer !== null) clearTimeout(this.captureTimer)
    this.captureTimer = null
    this.unavailableLatched = false
    this.clearTransientReferences()
    this.draftState = {
      state: 'locked',
      candidate: null,
      candidates: [],
      submissionCandidates: [],
      committed: false,
      inFlight: false,
      error: null
    }
    try {
      this.detachEditor()
      this.options.detachedClear?.()
    } catch {
      // The editor boundary is best-effort after plaintext references are gone.
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.captureTimer !== null) clearTimeout(this.captureTimer)
    this.captureTimer = null
    this.clearTransientReferences()
    this.unavailableLatched = false
    this.draftState = {
      state: null,
      candidate: null,
      candidates: [],
      submissionCandidates: [],
      committed: false,
      inFlight: false,
      error: null
    }
    if (this.ownsStorage) this.storage?.close()
    this.storage = null
  }
}

export type { OfflineDraftState }
