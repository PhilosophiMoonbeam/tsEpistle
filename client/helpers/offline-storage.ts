import { openDB, unwrap, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb'
import {
  OfflineCorpusNoticeSchema,
  OfflineDraftEnvelopeV1Schema,
  OfflineMetaRecordSchema,
  OfflinePagePolicyRecordSchema,
  OfflinePageSnapshotV1Schema,
  OfflinePolicyRecordSchema,
  OfflinePolicySnapshotSchema,
  OfflinePolicyStateSchema,
  OfflinePrivateEnvelopeV1Schema,
  OfflineReadingVaultV1Schema,
  OfflineSearchDocumentV1Schema,
  OfflineSnapshotProvenanceSchema,
  OfflineSnapshotRecordSchema,
  OfflineSnapshotSelectorSchema,
  OfflineStorageEstimateSchema,
  OfflineSyncDiagnosticsSchema,
  OFFLINE_AUTOMATIC_INACTIVITY_MS,
  OFFLINE_AUTOMATIC_PAGE_LIMIT,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_MANAGED_BYTES_LIMIT,
  OFFLINE_POLICY_PAGE_LIMIT,
  OFFLINE_POLICY_SCHEMA_VERSION,
  OFFLINE_POLICY_STATE_KEY,
  OFFLINE_PRIVATE_RECORD_BYTES_LIMIT,
  OFFLINE_RECORD_BYTES_LIMIT,
  OFFLINE_SCHEMA_VERSION,
  OFFLINE_SNAPSHOT_LIMIT,
  type OfflineCorpusNotice,
  type OfflineDraftEnvelopeV1,
  type OfflineMetaRecord,
  type OfflinePagePolicyRecord,
  type OfflinePageSnapshotV1,
  type OfflinePolicyRecord,
  type OfflinePolicyState,
  type OfflinePolicySnapshot,
  type OfflinePrivateEnvelopeV1,
  type OfflineReadingContextV1,
  type OfflineReadingVaultV1,
  type OfflineSearchDocumentV1,
  type OfflineSnapshotCorpus,
  type OfflineSnapshotProvenance,
  type OfflineSnapshotRecord,
  type OfflineSnapshotSelector,
  type OfflineStorageEstimate,
  type OfflineStorageFailureCode,
  type OfflineSyncDiagnostics
} from '../../shared/offline.ts'
import { decryptOfflinePrivateRecord, encryptOfflinePrivateRecord, readPrivateCorpus } from './offline-crypto.ts'
import { isCurrentOfflineReadingHandle, lockOfflineReading, publishOfflineSessionInvalidationNotice, type OfflineReadingHandleV1 } from './offline-session.ts'

const META_KEY = 'state' as const
const CORPUS_CHANNEL = `${OFFLINE_DB_NAME}:changes`
const now = (): string => new Date().toISOString()

type SnapshotKey = [siteId: string, pageId: number, locale: string]
type SearchDocumentKey = SnapshotKey
type PrivateRecordKey = [keyId: string, kind: string, pageId: number, locale: string]
const READING_VAULT_KEY = 'active' as const

type OfflineStorageDbSchema = DBSchema & {
  meta: {
    key: typeof META_KEY
    value: OfflineMetaRecord
  }
  snapshots: {
    key: SnapshotKey
    value: OfflineSnapshotRecord
    indexes: {
      'by-site': string
    }
  }
  drafts: {
    key: string
    value: OfflineDraftEnvelopeV1
    indexes: {
      'by-account': number
    }
  }
  searchDocuments: {
    key: SearchDocumentKey
    value: OfflineSearchDocumentV1
    indexes: {
      'by-site': string
    }
  }
  policy: {
    key: string
    value: OfflinePolicyRecord
    indexes: {
      'by-type': string
      'by-page': number
    }
  }
  readingVault: {
    key: typeof READING_VAULT_KEY
    value: OfflineReadingVaultV1
  }
  privateRecords: {
    key: PrivateRecordKey
    value: OfflinePrivateEnvelopeV1
    indexes: {
      'by-vault': string
      'by-kind': string
      'by-page': number
    }
  }
}

export type OfflineStorageGenerationOptions = {
  expectedSessionGeneration?: number
  expectedPolicyRevision?: number
  expectedCorpusRevision?: number
  readingHandle?: OfflineReadingHandleV1
}

export type OfflineDraftWriteOptions = OfflineStorageGenerationOptions & {
  /** The complete stored selector, or null for an insert. */
  expectedDraftRevision?: number | null
  /** The complete stored submission selector, or null when the stored draft is mutable. */
  expectedSubmissionId?: string | null
}

export type OfflineDraftDeleteOptions = OfflineStorageGenerationOptions & {
  expectedDraftRevision?: number
  expectedSubmissionId?: string | null
}

export type OfflineSnapshotWriteOptions = OfflineStorageGenerationOptions & {
  onEvictionWarning?: (candidateCount: number) => void
  provenance?: OfflineSnapshotProvenance
  signal?: AbortSignal
}

export type OfflineSnapshotOpenOptions = OfflineStorageGenerationOptions

export type OfflinePolicyMutationOptions = OfflineStorageGenerationOptions

export type OfflineSuccessfulPageEditOptions = OfflinePolicyMutationOptions & {
  editedAt?: string
}

export type OfflinePurgeResult = {
  deletedRecordIds: string[]
  preservedRecordIds: string[]
}

export type OfflineAccountInvalidationResult = {
  sessionGeneration: number
  deletedCount: number
  preservedOpaqueCount: number
  preservedReceiptCount: number
}
export type OfflineSubmissionFinalizationOptions = OfflineStorageGenerationOptions & {
  expectedReceipt: OfflineDraftEnvelopeV1
  expectedSource: OfflineDraftEnvelopeV1 | null
  expectedSurvivingFork: OfflineDraftEnvelopeV1 | null
  survivingFork: OfflineDraftEnvelopeV1 | null
}

export type OfflineSubmissionFinalizationResult = {
  receiptDeleted: boolean
  sourceDeleted: boolean
  survivingFork: OfflineDraftEnvelopeV1 | null
}

export type OfflineStorageNoticeListener = (notice: OfflineCorpusNotice) => void

const listeners = new Set<OfflineStorageNoticeListener>()
let corpusChannel: BroadcastChannel | null = null

const notifyListeners = (notice: OfflineCorpusNotice): void => {
  for (const listener of listeners) {
    try {
      listener(notice)
    } catch {
      // Observers are notification-only; one listener cannot invalidate a committed mutation.
    }
  }
}

const ensureCorpusChannel = (): BroadcastChannel | null => {
  if (corpusChannel || typeof BroadcastChannel === 'undefined') return corpusChannel
  try {
    corpusChannel = new BroadcastChannel(CORPUS_CHANNEL)
    corpusChannel.onmessage = event => {
      const parsed = OfflineCorpusNoticeSchema.safeParse(event.data)
      if (!parsed.success) return
      notifyListeners(parsed.data)
    }
  } catch {
    corpusChannel = null
  }
  return corpusChannel
}

export const subscribeOfflineStorageChanges = (listener: OfflineStorageNoticeListener): (() => void) => {
  listeners.add(listener)
  ensureCorpusChannel()
  return () => listeners.delete(listener)
}

const notifyPostCommit = (notice: OfflineCorpusNotice): void => {
  notifyListeners(notice)
  if (notice.kind === 'generation') publishOfflineSessionInvalidationNotice()
  try {
    ensureCorpusChannel()?.postMessage(notice)
  } catch {
    // BroadcastChannel is notification only; an unavailable channel cannot undo a commit.
  }
}

export class OfflineStorageError extends Error {
  readonly code: OfflineStorageFailureCode
  readonly cause: unknown

  constructor(code: OfflineStorageFailureCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'OfflineStorageError'
    this.code = code
    this.cause = cause
  }
}

export class OfflineGenerationFencedError extends OfflineStorageError {
  readonly expectedGeneration: number
  readonly actualGeneration: number

  constructor(expectedGeneration: number, actualGeneration: number) {
    super('generation-fenced', 'The offline operation belongs to an obsolete session generation.')
    this.name = 'OfflineGenerationFencedError'
    this.expectedGeneration = expectedGeneration
    this.actualGeneration = actualGeneration
  }
}
export class OfflinePolicyRevisionFencedError extends OfflineStorageError {
  readonly expectedPolicyRevision: number
  readonly actualPolicyRevision: number

  constructor(expectedPolicyRevision: number, actualPolicyRevision: number) {
    super('policy-revision-fenced', 'The offline operation belongs to an obsolete policy revision.')
    this.name = 'OfflinePolicyRevisionFencedError'
    this.expectedPolicyRevision = expectedPolicyRevision
    this.actualPolicyRevision = actualPolicyRevision
  }
}

export class OfflineDraftConflictError extends OfflineStorageError {
  readonly recordId: string

  constructor(recordId: string, message = 'The offline draft changed before this compare-and-swap commit.') {
    super('draft-conflict', message)
    this.name = 'OfflineDraftConflictError'
    this.recordId = recordId
  }
}

const defaultMeta = (): OfflineMetaRecord => ({
  key: META_KEY,
  schemaVersion: OFFLINE_SCHEMA_VERSION,
  sessionGeneration: 0,
  managedBytes: 0,
  snapshotCount: 0,
  corpusRevision: 0,
  accountingComplete: true,
  lastCleanupAt: null,
  storage: {
    usageBytes: null,
    quotaBytes: null,
    persisted: null,
    persistenceRequested: false
  }
})
const defaultSyncDiagnostics = (): OfflinePolicyState['syncDiagnostics'] => ({
  status: 'idle',
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  pendingCount: 0,
  retainedCount: 0,
  removedCount: 0
})

const policyRecordLogicalBytes = (record: OfflinePolicyRecord): number => {
  const { byteSize: _byteSize, ...withoutSize } = record
  return encodedBytes(withoutSize)
}

const makePolicyState = (overrides: Partial<Omit<OfflinePolicyState, 'byteSize'>> = {}): OfflinePolicyState => {
  const { byteSize: _byteSize, ...safeOverrides } = overrides as Partial<OfflinePolicyState>
  const withoutSize = {
    key: OFFLINE_POLICY_STATE_KEY,
    recordType: 'state' as const,
    schemaVersion: OFFLINE_POLICY_SCHEMA_VERSION,
    automaticSavingEnabled: true,
    automaticSavingDefaultApplied: true as const,
    selectedTags: [] as string[],
    policyRevision: 0,
    syncDiagnostics: defaultSyncDiagnostics(),
    ...safeOverrides
  }
  return OfflinePolicyStateSchema.parse({ ...withoutSize, byteSize: encodedBytes(withoutSize) })
}

const makePolicyPage = (
  selector: OfflineSnapshotSelector,
  overrides: Partial<Omit<OfflinePagePolicyRecord, 'key' | 'recordType' | 'schemaVersion' | 'byteSize'>> = {}
): OfflinePagePolicyRecord => {
  const withoutSize = {
    key: offlinePolicyPageKey(selector),
    recordType: 'page' as const,
    schemaVersion: OFFLINE_POLICY_SCHEMA_VERSION,
    siteId: selector.siteId,
    pageId: selector.pageId,
    locale: selector.locale,
    manual: false,
    automatic: false,
    tag: false,
    tagNames: [] as string[],
    visitCount: 0,
    lastVisitedAt: null,
    lastEditedAt: null,
    automaticSelectedAt: null,
    excluded: false,
    availability: 'unknown' as const,
    ...overrides
  }
  return OfflinePagePolicyRecordSchema.parse({ ...withoutSize, byteSize: encodedBytes(withoutSize) })
}

const storePolicyPage = (value: OfflinePagePolicyRecord): OfflinePagePolicyRecord => {
  const { byteSize: _byteSize, ...withoutSize } = value
  return OfflinePagePolicyRecordSchema.parse({ ...withoutSize, byteSize: encodedBytes(withoutSize) })
}

const clonePolicyState = (state: OfflinePolicyState): OfflinePolicyState => ({
  ...state,
  selectedTags: [...state.selectedTags],
  syncDiagnostics: { ...state.syncDiagnostics }
})

const clonePolicyPage = (page: OfflinePagePolicyRecord): OfflinePagePolicyRecord => ({
  ...page,
  tagNames: [...page.tagNames]
})
const policyPageFieldsChanged = (left: OfflinePagePolicyRecord, right: OfflinePagePolicyRecord): boolean =>
  left.manual !== right.manual ||
  left.automatic !== right.automatic ||
  left.tag !== right.tag ||
  left.tagNames.length !== right.tagNames.length ||
  left.tagNames.some((tag: string, index: number) => tag !== right.tagNames[index]) ||
  left.visitCount !== right.visitCount ||
  left.lastVisitedAt !== right.lastVisitedAt ||
  left.lastEditedAt !== right.lastEditedAt ||
  left.automaticSelectedAt !== right.automaticSelectedAt ||
  left.excluded !== right.excluded ||
  left.availability !== right.availability

const isPolicyPage = (value: OfflinePolicyRecord): value is OfflinePagePolicyRecord => value.recordType === 'page'

const normalizeTag = (tag: string): string => {
  if (typeof tag !== 'string') throw new OfflineStorageError('invalid-record', 'Offline tag identity is invalid.')
  const normalized = tag.normalize('NFKC').trim().toLowerCase()
  if (normalized.length < 1 || normalized.length > 256) throw new OfflineStorageError('invalid-record', 'Offline tag identity is invalid.')
  return normalized
}

const normalizeTags = (tags: readonly string[]): string[] => {
  if (!Array.isArray(tags) || tags.length > 32) throw new OfflineStorageError('invalid-record', 'Too many offline tag subscriptions.')
  return [...new Set(tags.map(normalizeTag))].sort((left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0))
}

const validatePolicyRevision = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new OfflineStorageError('policy-revision-fenced', 'Offline policy revision must be a non-negative safe integer.')
  return value
}
const validateEditedAt = (value: string): string => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new OfflineStorageError('invalid-record', 'Offline edit time is invalid.')
  return value
}

const pageIdentityKey = (selector: OfflineSnapshotSelector): string => `${selector.siteId}\u0000${selector.pageId}`

const selectorForPage = (page: OfflinePagePolicyRecord): OfflineSnapshotSelector => ({
  siteId: page.siteId,
  pageId: page.pageId,
  locale: page.locale
})

const compareSelectors = (left: OfflineSnapshotSelector, right: OfflineSnapshotSelector): number => {
  if (left.siteId !== right.siteId) return left.siteId < right.siteId ? -1 : 1
  if (left.pageId !== right.pageId) return left.pageId - right.pageId
  return left.locale < right.locale ? -1 : left.locale > right.locale ? 1 : 0
}

const parsePolicyPage = (value: unknown): OfflinePagePolicyRecord | null => {
  const parsed = OfflinePagePolicyRecordSchema.safeParse(value)
  if (parsed.success) return parsed.data
  if (!isObject(value) || Object.hasOwn(value, 'lastEditedAt')) return null
  const migrated = OfflinePagePolicyRecordSchema.safeParse({ ...value, lastEditedAt: null })
  return migrated.success ? migrated.data : null
}

export const offlinePolicyPageKey = (selector: OfflineSnapshotSelector): string => {
  const parsed = OfflineSnapshotSelectorSchema.parse(selector)
  return `${parsed.siteId}\u0000${parsed.pageId}\u0000${parsed.locale}`
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const cloneEnvelope = (envelope: OfflineDraftEnvelopeV1): OfflineDraftEnvelopeV1 => ({
  ...envelope,
  nonce: new Uint8Array(envelope.nonce),
  ciphertext: new Uint8Array(envelope.ciphertext)
})
const cloneSnapshot = (record: OfflineSnapshotRecord): OfflineSnapshotRecord => ({
  ...record,
  snapshot: { ...record.snapshot, content: { ...record.snapshot.content } }
})

const encodedBytes = (value: unknown): number => {
  try {
    const encoded = new TextEncoder().encode(JSON.stringify(value))
    if (!Number.isSafeInteger(encoded.byteLength)) throw new Error('Encoded value is too large.')
    return encoded.byteLength
  } catch (error) {
    throw new OfflineStorageError('serialization', 'The offline record could not be serialized.', error)
  }
}

const logicalEnvelopeBytes = (envelope: OfflineDraftEnvelopeV1): number =>
  encodedBytes({
    schemaVersion: envelope.schemaVersion,
    recordId: envelope.recordId,
    accountId: envelope.accountId,
    authVersion: envelope.authVersion,
    keyVersion: envelope.keyVersion,
    sessionGeneration: envelope.sessionGeneration,
    draftRevision: envelope.draftRevision,
    submissionId: envelope.submissionId,
    nonceBytes: envelope.nonce.byteLength,
    ciphertextBytes: envelope.ciphertext.byteLength
  }) +
  envelope.nonce.byteLength +
  envelope.ciphertext.byteLength

const normalizeSearchText = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/gu, ' ')
const cloneReadingVault = (vault: OfflineReadingVaultV1): OfflineReadingVaultV1 => ({
  ...vault,
  context: { ...vault.context },
  salt: new Uint8Array(vault.salt),
  nonce: new Uint8Array(vault.nonce),
  wrappedKey: new Uint8Array(vault.wrappedKey)
})

const clonePrivateEnvelope = (envelope: OfflinePrivateEnvelopeV1): OfflinePrivateEnvelopeV1 => ({
  ...envelope,
  context: { ...envelope.context },
  nonce: new Uint8Array(envelope.nonce),
  ciphertext: new Uint8Array(envelope.ciphertext)
})
const isSameReadingContext = (left: OfflineReadingContextV1, right: OfflineReadingContextV1): boolean =>
  left.canonicalOrigin === right.canonicalOrigin &&
  left.siteId === right.siteId &&
  left.accountId === right.accountId &&
  left.authVersion === right.authVersion &&
  left.keyVersion === right.keyVersion &&
  left.keyId === right.keyId

const privateEnvelopeLogicalBytes = (envelope: OfflinePrivateEnvelopeV1): number =>
  encodedBytes({
    schemaVersion: envelope.schemaVersion,
    context: envelope.context,
    sessionGeneration: envelope.sessionGeneration,
    kind: envelope.kind,
    pageId: envelope.pageId,
    locale: envelope.locale,
    recordRevision: envelope.recordRevision,
    pairId: envelope.pairId,
    nonceBytes: envelope.nonce.byteLength,
    ciphertextBytes: envelope.ciphertext.byteLength
  }) +
  envelope.nonce.byteLength +
  envelope.ciphertext.byteLength

const readingVaultLogicalBytes = (vault: OfflineReadingVaultV1): number =>
  encodedBytes({
    schemaVersion: vault.schemaVersion,
    context: vault.context,
    sessionGeneration: vault.sessionGeneration,
    saltBytes: vault.salt.byteLength,
    nonceBytes: vault.nonce.byteLength,
    wrappedKeyBytes: vault.wrappedKey.byteLength
  }) +
  vault.salt.byteLength +
  vault.nonce.byteLength +
  vault.wrappedKey.byteLength

const validateGeneration = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new OfflineStorageError('generation-fenced', 'Session generation must be a non-negative safe integer.')
  return value
}
const validateSiteId = (siteId: string): string => {
  if (typeof siteId !== 'string') throw new OfflineStorageError('invalid-record', 'Site identity is invalid.')
  const normalized = siteId.trim()
  if (normalized.length < 1 || normalized.length > 256) throw new OfflineStorageError('invalid-record', 'Site identity is invalid.')
  return normalized
}
const validateAccountId = (accountId: number): number => {
  if (!Number.isSafeInteger(accountId) || accountId < 1) throw new OfflineStorageError('invalid-record', 'Account identity is invalid.')
  return accountId
}
const validatePageId = (pageId: number): number => {
  if (!Number.isSafeInteger(pageId) || pageId < 1) throw new OfflineStorageError('invalid-record', 'Page identity is invalid.')
  return pageId
}
const validateRecordId = (recordId: string): string => {
  if (typeof recordId !== 'string' || recordId.trim().length < 1 || recordId.length > 256)
    throw new OfflineStorageError('invalid-record', 'Draft record identity is invalid.')
  return recordId
}

const toFailure = (error: unknown, fallbackCode: OfflineStorageFailureCode, fallbackMessage: string): OfflineStorageError => {
  if (error instanceof OfflineStorageError) return error
  const name = typeof DOMException !== 'undefined' && error instanceof DOMException ? error.name : ''
  if (name === 'QuotaExceededError') return new OfflineStorageError('quota', 'Offline storage quota was exceeded.', error)
  if (name === 'VersionError') return new OfflineStorageError('unsupported-schema', 'A newer offline database schema is already present.', error)
  if (name === 'AbortError') return new OfflineStorageError('transaction', 'The offline transaction was aborted.', error)
  if (name === 'DataCloneError') return new OfflineStorageError('serialization', 'The offline record could not be cloned.', error)
  return new OfflineStorageError(fallbackCode, fallbackMessage, error)
}

const getStorageManager = (): StorageManager | null => {
  if (typeof navigator === 'undefined' || !('storage' in navigator)) return null
  return navigator.storage
}

const getStorageEstimate = async (): Promise<{ usageBytes: number | null; quotaBytes: number | null }> => {
  const storage = getStorageManager()
  if (!storage?.estimate) return { usageBytes: null, quotaBytes: null }
  try {
    const estimate = await storage.estimate()
    return {
      usageBytes: typeof estimate.usage === 'number' && Number.isSafeInteger(estimate.usage) && estimate.usage >= 0 ? estimate.usage : null,
      quotaBytes: typeof estimate.quota === 'number' && Number.isSafeInteger(estimate.quota) && estimate.quota >= 0 ? estimate.quota : null
    }
  } catch {
    return { usageBytes: null, quotaBytes: null }
  }
}

const getPersisted = async (): Promise<boolean | null> => {
  const storage = getStorageManager()
  if (!storage?.persisted) return null
  try {
    return await storage.persisted()
  } catch {
    return null
  }
}

const makeSearchDocument = (siteId: string, snapshot: OfflinePageSnapshotV1): OfflineSearchDocumentV1 => {
  const withoutSize = {
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    siteId,
    pageId: snapshot.pageId,
    locale: snapshot.locale,
    path: snapshot.path,
    canonicalPath: snapshot.canonicalPath,
    title: snapshot.title,
    description: snapshot.description,
    searchText: normalizeSearchText(snapshot.searchText),
    capturedAt: snapshot.capturedAt
  }
  return OfflineSearchDocumentV1Schema.parse({ ...withoutSize, byteSize: encodedBytes(withoutSize) })
}

const makeSnapshotRecord = (siteId: string, snapshot: OfflinePageSnapshotV1, openedAt: string): OfflineSnapshotRecord => {
  const parsedSnapshot = OfflinePageSnapshotV1Schema.parse(snapshot)
  const withoutSize = { siteId, pageId: parsedSnapshot.pageId, locale: parsedSnapshot.locale, snapshot: parsedSnapshot, lastOpenedAt: openedAt }
  return OfflineSnapshotRecordSchema.parse({ ...withoutSize, byteSize: encodedBytes(withoutSize) })
}
const snapshotLogicalBytes = (record: OfflineSnapshotRecord): number => {
  const { byteSize: _byteSize, ...withoutSize } = record
  return encodedBytes(withoutSize)
}

const searchLogicalBytes = (record: OfflineSearchDocumentV1): number => {
  const { byteSize: _byteSize, ...withoutSize } = record
  return encodedBytes(withoutSize)
}

const isSameSubmission = (left: OfflineDraftEnvelopeV1, right: OfflineDraftEnvelopeV1): boolean =>
  left.recordId === right.recordId &&
  left.sessionGeneration === right.sessionGeneration &&
  left.draftRevision === right.draftRevision &&
  left.submissionId === right.submissionId

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false
  return true
}

const isSameEnvelope = (left: OfflineDraftEnvelopeV1, right: OfflineDraftEnvelopeV1): boolean =>
  isSameSubmission(left, right) &&
  left.accountId === right.accountId &&
  left.authVersion === right.authVersion &&
  left.keyVersion === right.keyVersion &&
  sameBytes(left.nonce, right.nonce) &&
  sameBytes(left.ciphertext, right.ciphertext)

const isSameKeyOwner = (left: OfflineDraftEnvelopeV1, right: OfflineDraftEnvelopeV1): boolean =>
  left.accountId === right.accountId && left.authVersion === right.authVersion && left.keyVersion === right.keyVersion
const isSameOwner = (left: OfflineDraftEnvelopeV1, right: OfflineDraftEnvelopeV1): boolean =>
  left.recordId === right.recordId && left.accountId === right.accountId && left.authVersion === right.authVersion && left.keyVersion === right.keyVersion

type OfflineTransaction = Omit<IDBPTransaction<OfflineStorageDbSchema, StoreNames<OfflineStorageDbSchema>[], IDBTransactionMode>, 'store'>
type OfflineWriteTransaction = Omit<IDBPTransaction<OfflineStorageDbSchema, StoreNames<OfflineStorageDbSchema>[], 'readwrite'>, 'store'>

type Accounting = {
  managedBytes: number
  snapshotCount: number
  policyPageCount: number
  complete: boolean
}
const privateRecordKey = (envelope: OfflinePrivateEnvelopeV1): PrivateRecordKey => [
  envelope.context.keyId,
  envelope.kind,
  envelope.pageId ?? 0,
  envelope.locale ?? ''
]

const isCanonicalPrivateRecordKey = (key: unknown, envelope: OfflinePrivateEnvelopeV1): boolean =>
  Array.isArray(key) &&
  key.length === 4 &&
  key[0] === envelope.context.keyId &&
  key[1] === envelope.kind &&
  key[2] === (envelope.pageId ?? 0) &&
  key[3] === (envelope.locale ?? '')

const readPrivateEntriesInTransaction = async (
  tx: OfflineTransaction | OfflineWriteTransaction,
  keyId?: string
): Promise<readonly { readonly key: IDBValidKey; readonly value: unknown }[]> => {
  const store = tx.objectStore('privateRecords')
  if (keyId === undefined) {
    const [values, keys] = await Promise.all([store.getAll(), store.getAllKeys()])
    if (values.length !== keys.length) throw new OfflineStorageError('transaction', 'Private record keys and values could not be read consistently.')
    return values.map((value, index) => ({ key: keys[index]!, value }))
  }
  const index = store.index('by-vault')
  const [values, keys] = await Promise.all([index.getAll(keyId), index.getAllKeys(keyId)])
  if (values.length !== keys.length) throw new OfflineStorageError('transaction', 'Private record keys and values could not be read consistently.')
  return values.map((value, index) => ({ key: keys[index]!, value }))
}

const recountAccountingInTransaction = async (tx: OfflineTransaction): Promise<Accounting> => {
  const snapshots = await tx.objectStore('snapshots').getAll()
  const searches = await tx.objectStore('searchDocuments').getAll()
  const drafts = await tx.objectStore('drafts').getAll()
  const policies = await tx.objectStore('policy').getAll()
  const readingVault = await tx.objectStore('readingVault').get(READING_VAULT_KEY)
  const privateEntries = await readPrivateEntriesInTransaction(tx)
  let managedBytes = 0
  let snapshotCount = 0
  let policyPageCount = 0
  let complete = true
  const addBytes = (value: number): void => {
    if (!Number.isSafeInteger(value) || value < 0) {
      complete = false
      managedBytes = Number.MAX_SAFE_INTEGER
      return
    }
    const next = managedBytes + value
    if (!Number.isSafeInteger(next) || next < 0) {
      complete = false
      managedBytes = Number.MAX_SAFE_INTEGER
      return
    }
    managedBytes = next
  }
  for (const value of snapshots) {
    const parsed = OfflineSnapshotRecordSchema.safeParse(value)
    if (!parsed.success) {
      complete = false
      continue
    }
    if (snapshotCount === Number.MAX_SAFE_INTEGER) {
      complete = false
    } else {
      snapshotCount += 1
    }
    addBytes(snapshotLogicalBytes(parsed.data))
  }
  for (const value of searches) {
    const parsed = OfflineSearchDocumentV1Schema.safeParse(value)
    if (!parsed.success) {
      complete = false
      continue
    }
    addBytes(searchLogicalBytes(parsed.data))
  }
  for (const value of drafts) {
    const parsed = OfflineDraftEnvelopeV1Schema.safeParse(value)
    if (!parsed.success) {
      complete = false
      continue
    }
    try {
      addBytes(logicalEnvelopeBytes(parsed.data))
    } catch {
      complete = false
    }
  }
  for (const value of policies) {
    const parsed = OfflinePolicyRecordSchema.safeParse(value)
    if (!parsed.success) {
      complete = false
      continue
    }
    if (isPolicyPage(parsed.data)) {
      if (policyPageCount === Number.MAX_SAFE_INTEGER) complete = false
      else policyPageCount += 1
    }
    try {
      addBytes(policyRecordLogicalBytes(parsed.data))
    } catch {
      complete = false
    }
  }
  if (readingVault !== undefined) {
    const parsed = OfflineReadingVaultV1Schema.safeParse(readingVault)
    if (!parsed.success) complete = false
    else {
      try {
        addBytes(readingVaultLogicalBytes(parsed.data))
      } catch {
        complete = false
      }
    }
  }
  for (const entry of privateEntries) {
    const parsed = OfflinePrivateEnvelopeV1Schema.safeParse(entry.value)
    if (!parsed.success || !isCanonicalPrivateRecordKey(entry.key, parsed.data)) {
      complete = false
      continue
    }
    if (parsed.data.kind === 'snapshot') {
      if (snapshotCount === Number.MAX_SAFE_INTEGER) complete = false
      else snapshotCount += 1
    }
    try {
      addBytes(privateEnvelopeLogicalBytes(parsed.data))
    } catch {
      complete = false
    }
  }
  return { managedBytes, snapshotCount, policyPageCount, complete }
}

const checkedAccountingValue = (value: number, delta: number, label: string): number => {
  if (!Number.isSafeInteger(delta)) throw new OfflineStorageError('transaction', `${label} delta is not a safe integer.`)
  const next = value + delta
  if (!Number.isSafeInteger(next) || next < 0) throw new OfflineStorageError('transaction', `${label} overflowed.`)
  return next
}

const snapshotPageRange = (siteId: string, pageId: number): IDBKeyRange => IDBKeyRange.bound([siteId, pageId, ''], [siteId, pageId, '\uffff'])

const snapshotSelectionRange = (siteId: string, pageId: number, locale?: string): IDBKeyRange =>
  locale === undefined ? snapshotPageRange(siteId, pageId) : IDBKeyRange.only([siteId, pageId, locale])

const safeLegacyMeta = (
  value: unknown
): {
  sessionGeneration: number
  lastCleanupAt: string | null
  storage: OfflineMetaRecord['storage']
} | null => {
  if (!isObject(value)) return null
  const schemaVersion = value.schemaVersion
  const sessionGeneration = value.sessionGeneration
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > OFFLINE_SCHEMA_VERSION) return null
  if (typeof sessionGeneration !== 'number' || !Number.isSafeInteger(sessionGeneration) || sessionGeneration < 0) return null
  const rawStorage = isObject(value.storage) ? value.storage : {}
  const safeNullable = (candidate: unknown): number | null =>
    typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null
  const lastCleanupAt = typeof value.lastCleanupAt === 'string' && Number.isFinite(Date.parse(value.lastCleanupAt)) ? value.lastCleanupAt : null
  const persisted = rawStorage.persisted === true || rawStorage.persisted === false ? rawStorage.persisted : null
  const persistenceRequested = rawStorage.persistenceRequested === true
  return {
    sessionGeneration,
    lastCleanupAt,
    storage: {
      usageBytes: safeNullable(rawStorage.usageBytes),
      quotaBytes: safeNullable(rawStorage.quotaBytes),
      persisted,
      persistenceRequested
    }
  }
}

export class OfflineStorage {
  private readonly db: IDBPDatabase<OfflineStorageDbSchema>
  private closed = false
  private unsupportedSchema = false
  private metadataRecovery: 'missing' | 'invalid' | 'incomplete' | null = null

  constructor(db: IDBPDatabase<OfflineStorageDbSchema>) {
    this.db = db
  }

  get isClosed(): boolean {
    return this.closed
  }

  get hasUnsupportedSchema(): boolean {
    return this.unsupportedSchema
  }

  get requiresMetadataRecovery(): boolean {
    return this.metadataRecovery !== null
  }

  close(): void {
    this.closed = true
    this.db.close()
  }

  markTerminated(): void {
    this.close()
  }

  markUnsupportedSchema(): void {
    this.unsupportedSchema = true
  }

  markMetadataRecovery(reason: 'missing' | 'invalid' | 'incomplete'): void {
    this.metadataRecovery = reason
  }

  private assertOpen(write: boolean): void {
    if (this.closed) throw new OfflineStorageError('closed', 'Offline storage is closed.')
    if (this.unsupportedSchema)
      throw new OfflineStorageError(
        'unsupported-schema',
        write ? 'A newer offline database schema is present; writes are disabled.' : 'The offline database schema is not understood.'
      )
    if (write && this.metadataRecovery) throw new OfflineStorageError('metadata-recovery', 'Offline metadata requires recovery before it can be changed.')
  }

  private async readMeta(): Promise<OfflineMetaRecord> {
    this.assertOpen(false)
    try {
      const value = await this.db.get('meta', META_KEY)
      const parsed = OfflineMetaRecordSchema.safeParse(value)
      if (!parsed.success || parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION) {
        if (parsed.success && parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION) this.unsupportedSchema = true
        throw new OfflineStorageError(parsed.success ? 'unsupported-schema' : 'metadata-recovery', 'Offline metadata is not understood.')
      }
      return parsed.data
    } catch (error) {
      throw toFailure(error, 'transaction', 'Offline metadata could not be read.')
    }
  }

  private async readMetaInTransaction(tx: OfflineTransaction): Promise<OfflineMetaRecord> {
    const value = await tx.objectStore('meta').get(META_KEY)
    const parsed = OfflineMetaRecordSchema.safeParse(value)
    if (!parsed.success || parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION) {
      if (parsed.success && parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION) this.unsupportedSchema = true
      throw new OfflineStorageError(parsed.success ? 'unsupported-schema' : 'metadata-recovery', 'Offline metadata is not understood.')
    }
    return parsed.data
  }
  private async readPolicyState(): Promise<OfflinePolicyState> {
    this.assertOpen(false)
    try {
      const value = await this.db.get('policy', OFFLINE_POLICY_STATE_KEY)
      const parsed = OfflinePolicyStateSchema.safeParse(value)
      if (!parsed.success || parsed.data.schemaVersion > OFFLINE_POLICY_SCHEMA_VERSION) {
        if (parsed.success && parsed.data.schemaVersion > OFFLINE_POLICY_SCHEMA_VERSION) this.unsupportedSchema = true
        throw new OfflineStorageError(parsed.success ? 'unsupported-schema' : 'metadata-recovery', 'Offline policy metadata is not understood.')
      }
      return parsed.data
    } catch (error) {
      throw toFailure(error, 'transaction', 'Offline policy metadata could not be read.')
    }
  }

  private async readPolicyStateInTransaction(tx: OfflineTransaction): Promise<OfflinePolicyState> {
    const value = await tx.objectStore('policy').get(OFFLINE_POLICY_STATE_KEY)
    const parsed = OfflinePolicyStateSchema.safeParse(value)
    if (!parsed.success || parsed.data.schemaVersion > OFFLINE_POLICY_SCHEMA_VERSION) {
      if (parsed.success && parsed.data.schemaVersion > OFFLINE_POLICY_SCHEMA_VERSION) this.unsupportedSchema = true
      throw new OfflineStorageError(parsed.success ? 'unsupported-schema' : 'metadata-recovery', 'Offline policy metadata is not understood.')
    }
    return parsed.data
  }

  private async assertGenerationAndPolicyInTransaction(
    tx: OfflineTransaction,
    expectedGeneration: number,
    expectedPolicyRevision: number
  ): Promise<{ meta: OfflineMetaRecord; policy: OfflinePolicyState }> {
    const meta = await this.assertGenerationInTransaction(tx, expectedGeneration)
    const policy = await this.readPolicyStateInTransaction(tx)
    if (policy.policyRevision !== expectedPolicyRevision) throw new OfflinePolicyRevisionFencedError(expectedPolicyRevision, policy.policyRevision)
    return { meta, policy }
  }

  private async expectedPolicyRevision(value: number | undefined): Promise<number> {
    return value === undefined ? (await this.readPolicyState()).policyRevision : validatePolicyRevision(value)
  }

  private async assertGenerationInTransaction(tx: OfflineTransaction, expectedGeneration: number): Promise<OfflineMetaRecord> {
    const meta = await this.readMetaInTransaction(tx)
    if (meta.sessionGeneration !== expectedGeneration) throw new OfflineGenerationFencedError(expectedGeneration, meta.sessionGeneration)
    return meta
  }

  private async expectedGeneration(value: number | undefined): Promise<number> {
    return value === undefined ? (await this.readMeta()).sessionGeneration : validateGeneration(value)
  }

  private async finish<T>(tx: OfflineWriteTransaction, result: T): Promise<T> {
    try {
      await tx.done
      return result
    } catch (error) {
      throw toFailure(error, 'transaction', 'The offline transaction did not commit.')
    }
  }

  private async finishRead<T>(tx: OfflineTransaction, result: T): Promise<T> {
    try {
      await tx.done
      return result
    } catch (error) {
      throw toFailure(error, 'transaction', 'The offline transaction could not be read.')
    }
  }

  private async abort(tx: OfflineWriteTransaction | undefined): Promise<void> {
    if (!tx) return
    try {
      tx.abort()
    } catch {
      // A completed transaction cannot be aborted.
    }
    try {
      await tx.done
    } catch {
      // The original operation error is more useful to callers.
    }
  }

  private async putAccountingDelta(
    tx: OfflineWriteTransaction,
    meta: OfflineMetaRecord,
    managedBytesDelta: number,
    snapshotCountDelta: number,
    corpusChanged: boolean,
    accountingComplete = meta.accountingComplete,
    lastCleanupAt = meta.lastCleanupAt
  ): Promise<OfflineMetaRecord> {
    const managedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
    const snapshotCount = checkedAccountingValue(meta.snapshotCount, snapshotCountDelta, 'Offline snapshot count')
    const corpusRevision = corpusChanged ? checkedAccountingValue(meta.corpusRevision, 1, 'Offline corpus revision') : meta.corpusRevision
    const next = { ...meta, managedBytes, snapshotCount, corpusRevision, accountingComplete, lastCleanupAt }
    await tx.objectStore('meta').put(next)
    return next
  }
  private async removeBodyInTransaction(
    tx: OfflineWriteTransaction,
    siteId: string,
    pageId: number,
    locale?: string
  ): Promise<{ bytes: number; snapshotCount: number; changed: boolean; accountingComplete: boolean }> {
    const snapshotsStore = tx.objectStore('snapshots')
    const searchStore = tx.objectStore('searchDocuments')
    const range = snapshotSelectionRange(siteId, pageId, locale)
    const snapshotValues = await snapshotsStore.getAll(range)
    const snapshotKeys = await snapshotsStore.getAllKeys(range)
    const searchValues = await searchStore.getAll(range)
    const searchKeys = await searchStore.getAllKeys(range)
    if (snapshotValues.length !== snapshotKeys.length || searchValues.length !== searchKeys.length)
      throw new OfflineStorageError('transaction', 'Offline snapshot keys and values could not be read consistently.')
    let bytes = 0
    let snapshotCount = 0
    let accountingComplete = true
    for (const value of snapshotValues) {
      const parsed = OfflineSnapshotRecordSchema.safeParse(value)
      if (!parsed.success) {
        accountingComplete = false
        continue
      }
      bytes = checkedAccountingValue(bytes, snapshotLogicalBytes(parsed.data), 'Offline snapshot removal bytes')
      snapshotCount += 1
    }
    for (const value of searchValues) {
      const parsed = OfflineSearchDocumentV1Schema.safeParse(value)
      if (!parsed.success) {
        accountingComplete = false
        continue
      }
      bytes = checkedAccountingValue(bytes, searchLogicalBytes(parsed.data), 'Offline search removal bytes')
    }
    for (const key of snapshotKeys) await snapshotsStore.delete(key)
    for (const key of searchKeys) await searchStore.delete(key)
    return { bytes, snapshotCount, changed: snapshotKeys.length > 0 || searchKeys.length > 0, accountingComplete }
  }
  private async policyPagesForPageInTransaction(tx: OfflineWriteTransaction, selector: OfflineSnapshotSelector): Promise<OfflinePagePolicyRecord[]> {
    const values = await tx.objectStore('policy').index('by-page').getAll(selector.pageId)
    const pages: OfflinePagePolicyRecord[] = []
    for (const value of values) {
      if (!isObject(value) || value.recordType !== 'page') continue
      const parsed = parsePolicyPage(value)
      if (!parsed) throw new OfflineStorageError('invalid-record', 'The offline page policy is opaque.')
      if (parsed.siteId !== selector.siteId) continue
      pages.push(parsed)
    }
    return pages
  }

  async currentSessionGeneration(): Promise<number> {
    return (await this.readMeta()).sessionGeneration
  }
  async currentCorpusRevision(): Promise<number> {
    return (await this.readMeta()).corpusRevision
  }

  async bumpSessionGeneration(nextGeneration?: number, options: OfflineStorageGenerationOptions = {}): Promise<number> {
    lockOfflineReading()
    this.assertOpen(true)
    const expected = options.expectedSessionGeneration === undefined ? undefined : validateGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'snapshots', 'drafts', 'searchDocuments', 'policy', 'readingVault', 'privateRecords'], 'readwrite', {
        durability: 'strict'
      }) as OfflineWriteTransaction
      const metaStore = tx.objectStore('meta')
      const current = await metaStore.get(META_KEY)
      const parsed = OfflineMetaRecordSchema.safeParse(current)
      if (!parsed.success || parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION) {
        this.unsupportedSchema = parsed.success && parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION
        throw new OfflineStorageError(this.unsupportedSchema ? 'unsupported-schema' : 'metadata-recovery', 'Offline metadata is not understood.')
      }
      if (expected !== undefined && parsed.data.sessionGeneration !== expected) throw new OfflineGenerationFencedError(expected, parsed.data.sessionGeneration)
      const candidate = nextGeneration === undefined ? parsed.data.sessionGeneration + 1 : validateGeneration(nextGeneration)
      if (candidate <= parsed.data.sessionGeneration) throw new OfflineStorageError('generation-fenced', 'Session generation must increase monotonically.')
      if (!Number.isSafeInteger(candidate)) throw new OfflineStorageError('generation-fenced', 'Session generation overflowed.')
      const privateStore = tx.objectStore('privateRecords')
      const privateCount = await privateStore.count()
      await tx.objectStore('readingVault').clear()
      await privateStore.clear()
      const accounting = await recountAccountingInTransaction(tx)
      const nextMeta = {
        ...parsed.data,
        sessionGeneration: candidate,
        managedBytes: accounting.managedBytes,
        snapshotCount: accounting.snapshotCount,
        accountingComplete: accounting.complete,
        corpusRevision: checkedAccountingValue(parsed.data.corpusRevision, privateCount > 0 ? 1 : 0, 'Offline corpus revision')
      }
      await metaStore.put(nextMeta)
      await this.finish(tx, candidate)
      notifyPostCommit({ kind: 'generation', sessionGeneration: candidate, corpusRevision: nextMeta.corpusRevision })
      return candidate
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Session generation could not be committed.')
    }
  }

  async putSnapshot(siteId: string, snapshot: OfflinePageSnapshotV1, options: OfflineSnapshotWriteOptions = {}): Promise<OfflineSnapshotRecord> {
    this.assertOpen(true)
    const validatedSiteId = validateSiteId(siteId)
    const parsedSnapshot = OfflinePageSnapshotV1Schema.parse(snapshot)
    const parsedProvenance = options.provenance === undefined ? undefined : OfflineSnapshotProvenanceSchema.parse(options.provenance)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    if (options.signal?.aborted) throw new OfflineStorageError('transaction', 'The offline snapshot write was cancelled.')
    const candidate = makeSnapshotRecord(validatedSiteId, parsedSnapshot, now())
    const search = makeSearchDocument(validatedSiteId, parsedSnapshot)
    const candidateBytes = snapshotLogicalBytes(candidate) + searchLogicalBytes(search)
    if (candidate.byteSize > OFFLINE_RECORD_BYTES_LIMIT || search.byteSize > OFFLINE_RECORD_BYTES_LIMIT)
      throw new OfflineStorageError('quota', 'The offline snapshot exceeds the per-record limit.')
    let tx: OfflineWriteTransaction | undefined
    let removeAbortListener: (() => void) | undefined
    try {
      const abortTransaction = (): void => {
        try {
          tx?.abort()
        } catch {
          // The transaction may have settled before the signal callback ran.
        }
      }
      tx = this.db.transaction(['meta', 'snapshots', 'searchDocuments', 'policy'], 'readwrite')
      if (options.signal) {
        options.signal.addEventListener('abort', abortTransaction, { once: true })
        removeAbortListener = () => options.signal?.removeEventListener('abort', abortTransaction)
        if (options.signal.aborted) abortTransaction()
      }
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expected, expectedPolicy)
      const snapshotsStore = tx.objectStore('snapshots')
      const searchStore = tx.objectStore('searchDocuments')
      const policyStore = tx.objectStore('policy')
      const range = snapshotPageRange(validatedSiteId, candidate.pageId)
      const oldSnapshotValues = await snapshotsStore.getAll(range)
      const oldSnapshotKeys = await snapshotsStore.getAllKeys(range)
      const oldSearchValues = await searchStore.getAll(range)
      const oldSearchKeys = await searchStore.getAllKeys(range)
      if (oldSnapshotValues.length !== oldSnapshotKeys.length || oldSearchValues.length !== oldSearchKeys.length)
        throw new OfflineStorageError('transaction', 'Offline snapshot keys and values could not be read consistently.')
      let oldBytes = 0
      let oldSnapshotCount = 0
      let accountingComplete = meta.accountingComplete
      for (const value of oldSnapshotValues) {
        const parsed = OfflineSnapshotRecordSchema.safeParse(value)
        if (!parsed.success) {
          accountingComplete = false
          continue
        }
        oldBytes = checkedAccountingValue(oldBytes, snapshotLogicalBytes(parsed.data), 'Offline snapshot replacement bytes')
        oldSnapshotCount += 1
      }
      for (const value of oldSearchValues) {
        const parsed = OfflineSearchDocumentV1Schema.safeParse(value)
        if (!parsed.success) {
          accountingComplete = false
          continue
        }
        oldBytes = checkedAccountingValue(oldBytes, searchLogicalBytes(parsed.data), 'Offline search replacement bytes')
      }
      const policyValues = await policyStore.index('by-page').getAll(candidate.pageId)
      const policyPages = new Map<string, OfflinePagePolicyRecord>()
      for (const value of policyValues) {
        if (!isObject(value) || value.recordType !== 'page') continue
        const parsed = parsePolicyPage(value)
        if (!parsed) throw new OfflineStorageError('invalid-record', 'The offline page policy is opaque.')
        if (parsed.siteId !== validatedSiteId) continue
        policyPages.set(parsed.key, parsed)
      }
      const existingPolicyValue = await policyStore.get(
        offlinePolicyPageKey({
          siteId: validatedSiteId,
          pageId: candidate.pageId,
          locale: candidate.locale
        })
      )
      const existingPolicy = existingPolicyValue === undefined ? null : parsePolicyPage(existingPolicyValue)
      if (existingPolicyValue !== undefined && !existingPolicy) throw new OfflineStorageError('invalid-record', 'The offline page policy is opaque.')
      if (policyPages.size > 0 && [...policyPages.values()].some(page => page.availability === 'ineligible'))
        throw new OfflinePolicyRevisionFencedError(policy.policyRevision, policy.policyRevision)
      if ([...policyPages.values()].some(page => page.excluded) && parsedProvenance?.manual !== true)
        throw new OfflinePolicyRevisionFencedError(policy.policyRevision, policy.policyRevision)
      const previous =
        existingPolicy ??
        makePolicyPage({
          siteId: validatedSiteId,
          pageId: candidate.pageId,
          locale: candidate.locale
        })
      const suppliedTags = parsedProvenance?.tagNames === undefined ? [] : normalizeTags(parsedProvenance.tagNames)
      const mergedTagNames = normalizeTags([...previous.tagNames, ...suppliedTags])
      const withoutSize = {
        ...previous,
        manual: parsedProvenance?.manual ?? (existingPolicy === null ? true : previous.manual),
        automatic: parsedProvenance?.automatic ?? previous.automatic,
        tag: mergedTagNames.length > 0,
        tagNames: mergedTagNames,
        availability: 'available' as const,
        excluded: parsedProvenance?.manual === true ? false : previous.excluded,
        automaticSelectedAt:
          (parsedProvenance?.automatic === true || previous.automatic) && previous.automaticSelectedAt === null ? now() : previous.automaticSelectedAt
      }
      const nextPolicy = storePolicyPage(withoutSize)
      const oldPolicyBytes = existingPolicy ? policyRecordLogicalBytes(existingPolicy) : 0
      const nextPolicyBytes = policyRecordLogicalBytes(nextPolicy)
      const policyPageCountDelta = existingPolicy ? 0 : 1
      if (!existingPolicy && policyPageCountDelta > 0) {
        const policyValues = await policyStore.index('by-type').getAll('page')
        if (policyValues.length >= OFFLINE_POLICY_PAGE_LIMIT) throw new OfflineStorageError('quota', 'Offline policy metadata limits would be exceeded.')
      }
      const managedBytesDelta = candidateBytes - oldBytes + nextPolicyBytes - oldPolicyBytes
      const snapshotCountDelta = 1 - oldSnapshotCount
      if (!accountingComplete && (managedBytesDelta > 0 || snapshotCountDelta > 0))
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before adding data.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      const projectedCount = checkedAccountingValue(meta.snapshotCount, snapshotCountDelta, 'Offline snapshot count')
      if ((snapshotCountDelta > 0 && projectedCount > OFFLINE_SNAPSHOT_LIMIT) || (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)) {
        options.onEvictionWarning?.(meta.snapshotCount)
        throw new OfflineStorageError('quota', 'Offline snapshot limits would be exceeded; no records were evicted.')
      }
      for (const key of oldSnapshotKeys) await snapshotsStore.delete(key)
      for (const key of oldSearchKeys) await searchStore.delete(key)
      await snapshotsStore.put(candidate)
      await searchStore.put(search)
      await policyStore.put(nextPolicy)
      const nextMeta = await this.putAccountingDelta(tx, meta, managedBytesDelta, snapshotCountDelta, true, accountingComplete)
      await this.finish(tx, candidate)
      notifyPostCommit({ kind: 'corpus', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      return cloneSnapshot(candidate)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The offline snapshot could not be committed.')
    } finally {
      removeAbortListener?.()
    }
  }
  async removeSnapshot(siteId: string, pageId: number, locale?: string, options: OfflineStorageGenerationOptions = {}): Promise<void> {
    this.assertOpen(true)
    const validatedSiteId = validateSiteId(siteId)
    const validatedPageId = validatePageId(pageId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'snapshots', 'searchDocuments', 'policy'], 'readwrite')
      const { meta } = await this.assertGenerationAndPolicyInTransaction(tx, expected, expectedPolicy)
      const snapshotsStore = tx.objectStore('snapshots')
      const searchStore = tx.objectStore('searchDocuments')
      const range = snapshotSelectionRange(validatedSiteId, validatedPageId, locale)
      const snapshotValues = await snapshotsStore.getAll(range)
      const snapshotKeys = await snapshotsStore.getAllKeys(range)
      const searchValues = await searchStore.getAll(range)
      const searchKeys = await searchStore.getAllKeys(range)
      if (snapshotValues.length !== snapshotKeys.length || searchValues.length !== searchKeys.length)
        throw new OfflineStorageError('transaction', 'Offline snapshot keys and values could not be read consistently.')
      let removedBytes = 0
      let removedSnapshotCount = 0
      let accountingComplete = meta.accountingComplete
      for (const value of snapshotValues) {
        const parsed = OfflineSnapshotRecordSchema.safeParse(value)
        if (!parsed.success) {
          accountingComplete = false
          continue
        }
        removedBytes = checkedAccountingValue(removedBytes, snapshotLogicalBytes(parsed.data), 'Offline snapshot removal bytes')
        removedSnapshotCount += 1
      }
      for (const value of searchValues) {
        const parsed = OfflineSearchDocumentV1Schema.safeParse(value)
        if (!parsed.success) {
          accountingComplete = false
          continue
        }
        removedBytes = checkedAccountingValue(removedBytes, searchLogicalBytes(parsed.data), 'Offline search removal bytes')
      }
      for (const key of snapshotKeys) await snapshotsStore.delete(key)
      for (const key of searchKeys) await searchStore.delete(key)
      const changed = snapshotKeys.length > 0 || searchKeys.length > 0
      const nextMeta = changed ? await this.putAccountingDelta(tx, meta, -removedBytes, -removedSnapshotCount, true, accountingComplete) : meta
      await this.finish(tx, undefined)
      if (changed) notifyPostCommit({ kind: 'corpus', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The offline snapshot could not be removed.')
    }
  }
  async readSnapshotCorpus(options: OfflineStorageGenerationOptions & { selector?: OfflineSnapshotSelector } = {}): Promise<OfflineSnapshotCorpus> {
    this.assertOpen(false)
    if (options.readingHandle) {
      if (options.expectedPolicyRevision !== undefined) await this.readPrivatePolicy(options.readingHandle, options)
      const corpus = await readPrivateCorpus(options.readingHandle, this, options.expectedCorpusRevision)
      const selector = options.selector === undefined ? undefined : this.assertPrivateSelector(options.readingHandle, options.selector)
      const snapshots: OfflineSnapshotRecord[] = []
      for (const value of corpus.snapshots) {
        const parsed = OfflinePageSnapshotV1Schema.safeParse(value)
        if (!parsed.success || (selector && (parsed.data.pageId !== selector.pageId || parsed.data.locale !== selector.locale))) continue
        const withoutSize = {
          siteId: options.readingHandle.context.siteId,
          pageId: parsed.data.pageId,
          locale: parsed.data.locale,
          snapshot: parsed.data,
          lastOpenedAt: parsed.data.capturedAt
        }
        snapshots.push(OfflineSnapshotRecordSchema.parse({ ...withoutSize, byteSize: encodedBytes(withoutSize) }))
      }
      return Object.freeze({
        snapshots: Object.freeze(snapshots),
        sessionGeneration: options.readingHandle.sessionGeneration,
        corpusRevision: corpus.corpusRevision ?? (await this.currentCorpusRevision())
      }) as unknown as OfflineSnapshotCorpus
    }
    const selector = options.selector === undefined ? undefined : OfflineSnapshotSelectorSchema.parse(options.selector)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = options.expectedPolicyRevision === undefined ? undefined : validatePolicyRevision(options.expectedPolicyRevision)
    try {
      const tx = this.db.transaction(['meta', 'snapshots', 'policy'], 'readonly')
      const meta = await this.assertGenerationInTransaction(tx, expected)
      const policy = await this.readPolicyStateInTransaction(tx)
      if (expectedPolicy !== undefined && policy.policyRevision !== expectedPolicy)
        throw new OfflinePolicyRevisionFencedError(expectedPolicy, policy.policyRevision)
      const store = tx.objectStore('snapshots')
      // A reader's status check needs only its own body, even for a large library.
      const values = selector ? [await store.get([selector.siteId, selector.pageId, selector.locale])] : await store.getAll()
      const snapshots: OfflineSnapshotRecord[] = []
      for (const value of values) {
        const parsed = OfflineSnapshotRecordSchema.safeParse(value)
        if (parsed.success) snapshots.push(cloneSnapshot(parsed.data))
      }
      const view = Object.freeze({ snapshots: Object.freeze(snapshots), sessionGeneration: meta.sessionGeneration, corpusRevision: meta.corpusRevision })
      return await this.finishRead(tx, view as unknown as OfflineSnapshotCorpus)
    } catch (error) {
      throw toFailure(error, 'transaction', 'Offline snapshots could not be read.')
    }
  }

  async listSnapshots(siteId?: string, options: OfflineStorageGenerationOptions = {}): Promise<OfflineSnapshotRecord[]> {
    const corpus = await this.readSnapshotCorpus(options)
    const validatedSiteId = siteId === undefined ? undefined : validateSiteId(siteId)
    return corpus.snapshots.filter((record: OfflineSnapshotRecord) => validatedSiteId === undefined || record.siteId === validatedSiteId).map(cloneSnapshot)
  }

  async markSnapshotOpened(selector: OfflineSnapshotSelector, options: OfflineSnapshotOpenOptions = {}): Promise<boolean> {
    this.assertOpen(true)
    const parsedSelector = OfflineSnapshotSelectorSchema.parse(selector)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'snapshots'], 'readwrite')
      const meta = await this.assertGenerationInTransaction(tx, expected)
      const store = tx.objectStore('snapshots')
      const value = await store.get([parsedSelector.siteId, parsedSelector.pageId, parsedSelector.locale])
      if (value === undefined) {
        await this.finish(tx, undefined)
        return false
      }
      const parsed = OfflineSnapshotRecordSchema.safeParse(value)
      if (!parsed.success) throw new OfflineStorageError('invalid-record', 'The selected snapshot is opaque.')
      const openedWithoutSize = { ...parsed.data, lastOpenedAt: now() }
      const opened = { ...openedWithoutSize, byteSize: snapshotLogicalBytes(openedWithoutSize) }
      const managedBytesDelta = snapshotLogicalBytes(opened) - snapshotLogicalBytes(parsed.data)
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before growing data.')
      await store.put(opened)
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)

      return true
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The snapshot open time could not be recorded.')
    }
  }
  private async readPrivatePolicy(handle: OfflineReadingHandleV1, options: OfflineStorageGenerationOptions = {}): Promise<OfflinePolicySnapshot> {
    if (!isCurrentOfflineReadingHandle(handle)) throw new OfflineStorageError('generation-fenced', 'The private reading handle is no longer current.')
    if (options.expectedSessionGeneration !== undefined && options.expectedSessionGeneration !== handle.sessionGeneration)
      throw new OfflineGenerationFencedError(options.expectedSessionGeneration, handle.sessionGeneration)
    try {
      const corpus = await readPrivateCorpus(handle, this, options.expectedCorpusRevision)
      let state: OfflinePolicyState | null = null
      const pages: OfflinePagePolicyRecord[] = []
      for (const value of corpus.policies) {
        if (state === null && OfflinePolicyStateSchema.safeParse(value).success) {
          state = OfflinePolicyStateSchema.parse(value)
          continue
        }
        const page = OfflinePagePolicyRecordSchema.safeParse(value)
        if (!page.success) throw new OfflineStorageError('metadata-recovery', 'The encrypted private policy is unavailable.')
        if (page.data.siteId === handle.context.siteId) pages.push(clonePolicyPage(page.data))
      }
      const resolvedState = state ?? makePolicyState()
      if (options.expectedPolicyRevision !== undefined && resolvedState.policyRevision !== options.expectedPolicyRevision)
        throw new OfflinePolicyRevisionFencedError(options.expectedPolicyRevision, resolvedState.policyRevision)
      pages.sort((left, right) => compareSelectors(selectorForPage(left), selectorForPage(right)))
      return OfflinePolicySnapshotSchema.parse({
        state: clonePolicyState(resolvedState),
        pages,
        sessionGeneration: handle.sessionGeneration
      }) as OfflinePolicySnapshot
    } catch (error) {
      if (error instanceof OfflineStorageError) throw error
      throw new OfflineStorageError('metadata-recovery', 'The encrypted private policy is unavailable.', error)
    }
  }

  private async mutatePrivatePolicy(
    handle: OfflineReadingHandleV1,
    options: OfflineStorageGenerationOptions,
    mutate: (policy: OfflinePolicySnapshot) => {
      policy: OfflinePolicySnapshot | { readonly state: OfflinePolicyState; readonly pages: readonly OfflinePagePolicyRecord[] }
      removePageIds?: readonly number[]
    }
  ): Promise<OfflinePolicySnapshot> {
    const current = await this.readPrivatePolicy(handle, options)
    const result = mutate(current)
    const next = OfflinePolicySnapshotSchema.parse({
      ...result.policy,
      sessionGeneration: handle.sessionGeneration
    }) as OfflinePolicySnapshot
    if (
      next.state.policyRevision === current.state.policyRevision &&
      JSON.stringify(next.pages) === JSON.stringify(current.pages) &&
      (!result.removePageIds || result.removePageIds.length === 0)
    )
      return next
    const recordRevision = Math.max(1, next.state.policyRevision + 1)
    const records: OfflinePrivateEnvelopeV1[] = []
    records.push(
      await encryptOfflinePrivateRecord(handle, 'policy-state', next.state, {
        pageId: null,
        locale: null,
        recordRevision,
        pairId: null
      })
    )
    for (const page of next.pages) {
      records.push(
        await encryptOfflinePrivateRecord(handle, 'policy-page', page, {
          pageId: page.pageId,
          locale: page.locale,
          recordRevision,
          pairId: null
        })
      )
    }
    await this.putPrivatePolicyRecords(records, {
      expectedSessionGeneration: handle.sessionGeneration,
      expectedPolicyRevision: current.state.policyRevision,
      readingHandle: handle,
      removePrivatePageIds: result.removePageIds
    })
    return next
  }

  private assertPrivateSelector(handle: OfflineReadingHandleV1, selector: OfflineSnapshotSelector): OfflineSnapshotSelector {
    const parsed = OfflineSnapshotSelectorSchema.parse(selector)
    if (!isCurrentOfflineReadingHandle(handle) || parsed.siteId !== handle.context.siteId)
      throw new OfflineStorageError('generation-fenced', 'The private reading handle is not authorized for this site.')
    return parsed
  }

  private privatePageResult(policy: OfflinePolicySnapshot, selector: OfflineSnapshotSelector): OfflinePagePolicyRecord {
    return clonePolicyPage(policy.pages.find(page => page.key === offlinePolicyPageKey(selector)) ?? makePolicyPage(selector))
  }
  async readOfflinePolicy(options: OfflineStorageGenerationOptions = {}): Promise<OfflinePolicySnapshot> {
    this.assertOpen(false)
    if (options.readingHandle) return await this.readPrivatePolicy(options.readingHandle, options)
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    try {
      const tx = this.db.transaction(['meta', 'policy'], 'readonly')
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      const values = await tx.objectStore('policy').getAll()
      const pages: OfflinePagePolicyRecord[] = []
      for (const value of values) {
        const parsed = OfflinePagePolicyRecordSchema.safeParse(value)
        if (parsed.success) pages.push(clonePolicyPage(parsed.data))
      }
      pages.sort((left: OfflinePagePolicyRecord, right: OfflinePagePolicyRecord) => compareSelectors(selectorForPage(left), selectorForPage(right)))
      const result = OfflinePolicySnapshotSchema.parse({
        state: clonePolicyState(policy),
        pages,
        sessionGeneration: meta.sessionGeneration
      })
      return await this.finishRead(tx, result as unknown as OfflinePolicySnapshot)
    } catch (error) {
      throw toFailure(error, 'transaction', 'Offline policy metadata could not be read.')
    }
  }

  async listPagePolicies(siteId?: string, options: OfflineStorageGenerationOptions = {}): Promise<OfflinePagePolicyRecord[]> {
    const policy = await this.readOfflinePolicy(options)
    const validatedSiteId = siteId === undefined ? undefined : validateSiteId(siteId)
    return policy.pages.filter((page: OfflinePagePolicyRecord) => validatedSiteId === undefined || page.siteId === validatedSiteId).map(clonePolicyPage)
  }

  async pagePolicy(selector: OfflineSnapshotSelector, options: OfflineStorageGenerationOptions = {}): Promise<OfflinePagePolicyRecord | null> {
    const parsedSelector = OfflineSnapshotSelectorSchema.parse(selector)
    const pages = await this.listPagePolicies(parsedSelector.siteId, options)
    const key = offlinePolicyPageKey(parsedSelector)
    const page = pages.find((candidate: OfflinePagePolicyRecord) => candidate.key === key)
    return page ? clonePolicyPage(page) : null
  }
  async setAutomaticSavingEnabled(enabled: boolean, options: OfflinePolicyMutationOptions = {}): Promise<OfflinePolicyState> {
    this.assertOpen(true)
    if (typeof enabled !== 'boolean') throw new OfflineStorageError('invalid-record', 'Automatic offline saving setting is invalid.')
    if (options.readingHandle) {
      const next = await this.mutatePrivatePolicy(options.readingHandle, options, current => ({
        policy: {
          state: {
            ...current.state,
            automaticSavingEnabled: enabled,
            policyRevision: current.state.automaticSavingEnabled === enabled ? current.state.policyRevision : current.state.policyRevision + 1
          },
          pages: current.pages
        }
      }))
      return clonePolicyState(next.state)
    }
    if (typeof enabled !== 'boolean') throw new OfflineStorageError('invalid-record', 'Automatic offline saving setting is invalid.')
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'policy'], 'readwrite')
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      if (policy.automaticSavingEnabled === enabled) {
        await this.finish(tx, undefined)
        return clonePolicyState(policy)
      }
      const nextRevision = checkedAccountingValue(policy.policyRevision, 1, 'Offline policy revision')
      const nextPolicy = makePolicyState({
        ...policy,
        automaticSavingEnabled: enabled,
        policyRevision: nextRevision
      })
      const managedBytesDelta = policyRecordLogicalBytes(nextPolicy) - policyRecordLogicalBytes(policy)
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before changing policy.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      await tx.objectStore('policy').put(nextPolicy)
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      notifyPostCommit({ kind: 'policy', sessionGeneration: meta.sessionGeneration, corpusRevision: meta.corpusRevision })
      return clonePolicyState(nextPolicy)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Automatic offline saving setting could not be committed.')
    }
  }

  async setOfflineTagSubscriptions(tags: readonly string[], options: OfflinePolicyMutationOptions = {}): Promise<OfflinePolicyState> {
    this.assertOpen(true)
    const normalizedTags = normalizeTags(tags)
    if (options.readingHandle) {
      const next = await this.mutatePrivatePolicy(options.readingHandle, options, current => {
        const removedTags = new Set(current.state.selectedTags.filter(tag => !normalizedTags.includes(tag)))
        const tagsChanged =
          current.state.selectedTags.length !== normalizedTags.length || current.state.selectedTags.some((tag, index) => tag !== normalizedTags[index])
        const pages = current.pages.map(page => {
          if (removedTags.size === 0) return page
          const tagNames = page.tagNames.filter(tag => !removedTags.has(tag))
          return tagNames.length === page.tagNames.length ? page : storePolicyPage({ ...page, tag: tagNames.length > 0, tagNames })
        })
        const changedPages = pages.some((page, index) => JSON.stringify(page) !== JSON.stringify(current.pages[index]))
        const changed = tagsChanged || changedPages
        return {
          policy: {
            state: changed
              ? makePolicyState({ ...current.state, selectedTags: normalizedTags, policyRevision: current.state.policyRevision + 1 })
              : current.state,
            pages
          }
        }
      })
      return clonePolicyState(next.state)
    }
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'policy'], 'readwrite')
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      const oldPages = await tx.objectStore('policy').getAll()
      const pageValues = new Map<string, OfflinePagePolicyRecord>()
      for (const value of oldPages) {
        const parsed = parsePolicyPage(value)
        if (parsed) pageValues.set(parsed.key, parsed)
      }
      const removedTags = new Set(policy.selectedTags.filter((tag: string) => !normalizedTags.includes(tag)))
      const changedPages: OfflinePagePolicyRecord[] = []
      let managedBytesDelta = 0
      for (const page of pageValues.values()) {
        if (removedTags.size === 0) continue
        const nextTagNames = page.tagNames.filter((tag: string) => !removedTags.has(tag))
        if (nextTagNames.length === page.tagNames.length) continue
        const withoutSize = { ...page, tag: nextTagNames.length > 0, tagNames: nextTagNames }
        const nextPage = storePolicyPage(withoutSize)
        managedBytesDelta += policyRecordLogicalBytes(nextPage) - policyRecordLogicalBytes(page)
        changedPages.push(nextPage)
      }
      const tagsChanged =
        policy.selectedTags.length !== normalizedTags.length || policy.selectedTags.some((tag: string, index: number) => tag !== normalizedTags[index])
      const nextRevision = tagsChanged ? checkedAccountingValue(policy.policyRevision, 1, 'Offline policy revision') : policy.policyRevision
      const nextPolicy = tagsChanged ? makePolicyState({ ...policy, selectedTags: normalizedTags, policyRevision: nextRevision }) : policy
      if (tagsChanged) managedBytesDelta += policyRecordLogicalBytes(nextPolicy) - policyRecordLogicalBytes(policy)
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before changing policy.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      for (const page of changedPages) await tx.objectStore('policy').put(page)
      if (tagsChanged) await tx.objectStore('policy').put(nextPolicy)
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      if (changedPages.length > 0 || tagsChanged)
        notifyPostCommit({ kind: 'policy', sessionGeneration: meta.sessionGeneration, corpusRevision: meta.corpusRevision })
      return clonePolicyState(nextPolicy)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Offline tag subscriptions could not be committed.')
    }
  }

  async setManualOfflineIntent(
    selector: OfflineSnapshotSelector,
    selected: boolean,
    options: OfflinePolicyMutationOptions = {}
  ): Promise<OfflinePagePolicyRecord> {
    this.assertOpen(true)
    if (typeof selected !== 'boolean') throw new OfflineStorageError('invalid-record', 'Manual offline intent is invalid.')
    const parsedSelector = OfflineSnapshotSelectorSchema.parse(selector)
    if (options.readingHandle) {
      const privateSelector = this.assertPrivateSelector(options.readingHandle, parsedSelector)
      const next = await this.mutatePrivatePolicy(options.readingHandle, options, current => {
        const previous = current.pages.find(page => page.key === offlinePolicyPageKey(privateSelector)) ?? makePolicyPage(privateSelector)
        const nextPage = storePolicyPage({ ...previous, manual: selected, excluded: selected ? false : previous.excluded })
        const changed = JSON.stringify(previous) !== JSON.stringify(nextPage)
        return {
          policy: {
            state: changed ? makePolicyState({ ...current.state, policyRevision: current.state.policyRevision + 1 }) : current.state,
            pages: current.pages.some(page => page.key === nextPage.key)
              ? current.pages.map(page => (page.key === nextPage.key ? nextPage : page))
              : [...current.pages, nextPage]
          }
        }
      })
      return this.privatePageResult(next, privateSelector)
    }
    if (typeof selected !== 'boolean') throw new OfflineStorageError('invalid-record', 'Manual offline intent is invalid.')
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'policy'], 'readwrite')
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      const store = tx.objectStore('policy')
      const key = offlinePolicyPageKey(parsedSelector)
      const raw = await store.get(key)
      const existing = raw === undefined ? null : parsePolicyPage(raw)
      if (raw !== undefined && !existing) throw new OfflineStorageError('invalid-record', 'The offline page policy is opaque.')
      const previous = existing ?? makePolicyPage(parsedSelector)
      if (!existing && !selected) {
        await this.finish(tx, undefined)
        return clonePolicyPage(previous)
      }
      const withoutSize = {
        ...previous,
        manual: selected,
        excluded: selected ? false : previous.excluded
      }
      const nextPage = storePolicyPage(withoutSize)
      const changed = policyPageFieldsChanged(previous, nextPage)
      const nextRevision = changed ? checkedAccountingValue(policy.policyRevision, 1, 'Offline policy revision') : policy.policyRevision
      const nextState = changed ? makePolicyState({ ...policy, policyRevision: nextRevision }) : policy
      const managedBytesDelta =
        policyRecordLogicalBytes(nextPage) -
        (existing ? policyRecordLogicalBytes(existing) : 0) +
        (changed ? policyRecordLogicalBytes(nextState) - policyRecordLogicalBytes(policy) : 0)
      if (!existing) {
        const pages = await store.index('by-type').getAll('page')
        if (pages.length >= OFFLINE_POLICY_PAGE_LIMIT) throw new OfflineStorageError('quota', 'Offline policy metadata limits would be exceeded.')
      }
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before changing policy.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      await store.put(nextPage)
      if (changed) await store.put(nextState)
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      if (changed) notifyPostCommit({ kind: 'policy', sessionGeneration: meta.sessionGeneration, corpusRevision: meta.corpusRevision })
      return clonePolicyPage(nextPage)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Manual offline intent could not be committed.')
    }
  }

  async recordEligibleReaderVisit(selector: OfflineSnapshotSelector, options: OfflinePolicyMutationOptions = {}): Promise<OfflinePagePolicyRecord> {
    this.assertOpen(true)
    const parsedSelector = OfflineSnapshotSelectorSchema.parse(selector)
    if (options.readingHandle) {
      const privateSelector = this.assertPrivateSelector(options.readingHandle, parsedSelector)
      const next = await this.mutatePrivatePolicy(options.readingHandle, options, current => {
        const previous = current.pages.find(page => page.key === offlinePolicyPageKey(privateSelector)) ?? makePolicyPage(privateSelector)
        const nextPage = storePolicyPage({
          ...previous,
          visitCount: previous.visitCount + 1,
          lastVisitedAt: now()
        })
        return {
          policy: {
            state: makePolicyState({ ...current.state, policyRevision: current.state.policyRevision + 1 }),
            pages: current.pages.some(page => page.key === nextPage.key)
              ? current.pages.map(page => (page.key === nextPage.key ? nextPage : page))
              : [...current.pages, nextPage]
          }
        }
      })
      return this.privatePageResult(next, privateSelector)
    }
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'policy'], 'readwrite')
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      const store = tx.objectStore('policy')
      const key = offlinePolicyPageKey(parsedSelector)
      const raw = await store.get(key)
      const existing = raw === undefined ? null : parsePolicyPage(raw)
      if (raw !== undefined && !existing) throw new OfflineStorageError('invalid-record', 'The offline page policy is opaque.')
      const previous = existing ?? makePolicyPage(parsedSelector)
      const visitCount = checkedAccountingValue(previous.visitCount, 1, 'Offline visit count')
      const withoutSize = { ...previous, visitCount, lastVisitedAt: now() }
      const nextPage = storePolicyPage(withoutSize)
      const nextRevision = checkedAccountingValue(policy.policyRevision, 1, 'Offline policy revision')
      const nextState = makePolicyState({ ...policy, policyRevision: nextRevision })
      const managedBytesDelta =
        policyRecordLogicalBytes(nextPage) -
        (existing ? policyRecordLogicalBytes(existing) : 0) +
        policyRecordLogicalBytes(nextState) -
        policyRecordLogicalBytes(policy)
      if (!existing && (await store.index('by-type').getAll('page')).length >= OFFLINE_POLICY_PAGE_LIMIT)
        throw new OfflineStorageError('quota', 'Offline policy metadata limits would be exceeded.')
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before recording a visit.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      await store.put(nextPage)
      await store.put(nextState)
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      notifyPostCommit({ kind: 'policy', sessionGeneration: meta.sessionGeneration, corpusRevision: meta.corpusRevision })
      return clonePolicyPage(nextPage)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The eligible reader visit could not be recorded.')
    }
  }

  async recordSuccessfulPageEdit(selector: OfflineSnapshotSelector, options: OfflineSuccessfulPageEditOptions = {}): Promise<OfflinePagePolicyRecord> {
    this.assertOpen(true)
    const parsedSelector = OfflineSnapshotSelectorSchema.parse(selector)
    const editedAt = validateEditedAt(options.editedAt ?? now())
    if (options.readingHandle) {
      const privateSelector = this.assertPrivateSelector(options.readingHandle, parsedSelector)
      const next = await this.mutatePrivatePolicy(options.readingHandle, options, current => {
        const previous =
          current.pages.find(page => page.key === offlinePolicyPageKey(privateSelector)) ?? makePolicyPage(privateSelector, { availability: 'available' })
        const previousMs = previous.lastEditedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.lastEditedAt)
        const nextEditedAt = previousMs >= Date.parse(editedAt) ? previous.lastEditedAt : editedAt
        if (nextEditedAt === previous.lastEditedAt) return { policy: current }
        const nextPage = storePolicyPage({ ...previous, lastEditedAt: nextEditedAt })
        return {
          policy: {
            state: makePolicyState({ ...current.state, policyRevision: current.state.policyRevision + 1 }),
            pages: current.pages.some(page => page.key === nextPage.key)
              ? current.pages.map(page => (page.key === nextPage.key ? nextPage : page))
              : [...current.pages, nextPage]
          }
        }
      })
      return this.privatePageResult(next, privateSelector)
    }
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'policy'], 'readwrite')
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      const store = tx.objectStore('policy')
      const key = offlinePolicyPageKey(parsedSelector)
      const raw = await store.get(key)
      const existing = raw === undefined ? null : parsePolicyPage(raw)
      if (raw !== undefined && !existing) throw new OfflineStorageError('invalid-record', 'The offline page policy is opaque.')
      const variants = await this.policyPagesForPageInTransaction(tx, parsedSelector)
      if (variants.some(page => page.excluded || page.availability === 'ineligible'))
        throw new OfflinePolicyRevisionFencedError(expectedPolicy, policy.policyRevision)
      if (existing?.excluded || existing?.availability === 'ineligible') throw new OfflinePolicyRevisionFencedError(expectedPolicy, policy.policyRevision)
      const previous = existing ?? makePolicyPage(parsedSelector, { availability: 'available' })
      const previousMs = previous.lastEditedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.lastEditedAt)
      const nextEditedAt = previousMs >= Date.parse(editedAt) ? previous.lastEditedAt : editedAt
      if (nextEditedAt === previous.lastEditedAt) {
        await this.finish(tx, undefined)
        return clonePolicyPage(previous)
      }
      const nextPage = storePolicyPage({ ...previous, lastEditedAt: nextEditedAt })
      const nextRevision = checkedAccountingValue(policy.policyRevision, 1, 'Offline policy revision')
      const nextState = makePolicyState({ ...policy, policyRevision: nextRevision })
      const managedBytesDelta =
        policyRecordLogicalBytes(nextPage) -
        (existing ? policyRecordLogicalBytes(existing) : 0) +
        policyRecordLogicalBytes(nextState) -
        policyRecordLogicalBytes(policy)
      if (!existing && (await store.index('by-type').getAll('page')).length >= OFFLINE_POLICY_PAGE_LIMIT)
        throw new OfflineStorageError('quota', 'Offline policy metadata limits would be exceeded.')
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before recording an edit.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      await store.put(nextPage)
      await store.put(nextState)
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      notifyPostCommit({ kind: 'policy', sessionGeneration: meta.sessionGeneration, corpusRevision: meta.corpusRevision })
      return clonePolicyPage(nextPage)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The successful offline page edit could not be recorded.')
    }
  }

  async selectTopAutomaticPages(
    options: OfflineStorageGenerationOptions & { limit?: number; asOf?: string; siteId?: string } = {}
  ): Promise<OfflinePagePolicyRecord[]> {
    const asOf = options.asOf ?? now()
    const asOfMs = Date.parse(asOf)
    if (!Number.isFinite(asOfMs)) throw new OfflineStorageError('invalid-record', 'Automatic selection time is invalid.')
    const validatedSiteId = options.siteId === undefined ? undefined : validateSiteId(options.siteId)
    const policy = await this.readOfflinePolicy(options)
    const limit = options.limit === undefined ? OFFLINE_AUTOMATIC_PAGE_LIMIT : options.limit
    if (!Number.isSafeInteger(limit) || limit < 0) throw new OfflineStorageError('invalid-record', 'Automatic page limit is invalid.')
    const eligible = (page: OfflinePagePolicyRecord): boolean =>
      (validatedSiteId === undefined || page.siteId === validatedSiteId) && !page.excluded && page.availability !== 'ineligible'
    const visitCandidates = policy.pages
      .filter(
        (page: OfflinePagePolicyRecord) =>
          eligible(page) && page.visitCount > 0 && page.lastVisitedAt !== null && asOfMs - Date.parse(page.lastVisitedAt) < OFFLINE_AUTOMATIC_INACTIVITY_MS
      )
      .sort((left: OfflinePagePolicyRecord, right: OfflinePagePolicyRecord) => {
        if (left.visitCount !== right.visitCount) return right.visitCount - left.visitCount
        if (left.lastVisitedAt !== right.lastVisitedAt)
          return left.lastVisitedAt === null ? 1 : right.lastVisitedAt === null ? -1 : right.lastVisitedAt.localeCompare(left.lastVisitedAt)
        return compareSelectors(selectorForPage(left), selectorForPage(right))
      })
    const editedCandidates = policy.pages
      .filter((page: OfflinePagePolicyRecord) => eligible(page) && page.lastEditedAt !== null)
      .sort((left: OfflinePagePolicyRecord, right: OfflinePagePolicyRecord) => {
        const leftEditedAt = left.lastEditedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(left.lastEditedAt)
        const rightEditedAt = right.lastEditedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(right.lastEditedAt)
        if (leftEditedAt !== rightEditedAt) return rightEditedAt - leftEditedAt
        return compareSelectors(selectorForPage(left), selectorForPage(right))
      })
    const latestEdited = editedCandidates[0]
    const candidates = latestEdited === undefined ? visitCandidates : [latestEdited, ...visitCandidates]
    const cap = Math.min(limit, OFFLINE_AUTOMATIC_PAGE_LIMIT)
    if (cap === 0) return []
    const selected: OfflinePagePolicyRecord[] = []
    const seenPages = new Set<string>()
    for (const candidate of candidates) {
      const key = pageIdentityKey(selectorForPage(candidate))
      if (seenPages.has(key)) continue
      seenPages.add(key)
      selected.push(candidate)
      if (selected.length >= cap) break
    }
    return selected.map(clonePolicyPage)
  }
  async updateAutomaticSelections(
    selectors: readonly OfflineSnapshotSelector[],
    options: OfflineStorageGenerationOptions & { asOf?: string; siteId?: string } = {}
  ): Promise<OfflinePagePolicyRecord[]> {
    this.assertOpen(true)
    if (!Array.isArray(selectors) || selectors.length > OFFLINE_AUTOMATIC_PAGE_LIMIT)
      throw new OfflineStorageError('invalid-record', 'Too many automatic offline page selections.')
    const parsedSelectors = selectors.map((selector: OfflineSnapshotSelector) => OfflineSnapshotSelectorSchema.parse(selector))
    const validatedSiteId = options.siteId === undefined ? undefined : validateSiteId(options.siteId)
    const asOf = options.asOf ?? now()
    if (!Number.isFinite(Date.parse(asOf))) throw new OfflineStorageError('invalid-record', 'Automatic selection time is invalid.')
    const uniqueSelectors = [
      ...new Map(parsedSelectors.map((selector: OfflineSnapshotSelector) => [offlinePolicyPageKey(selector), selector])).values()
    ].filter((selector: OfflineSnapshotSelector) => validatedSiteId === undefined || selector.siteId === validatedSiteId)
    if (options.readingHandle) {
      const privateSiteId = options.siteId ?? options.readingHandle.context.siteId
      const uniquePrivateSelectors = [...new Map(parsedSelectors.map(selector => [offlinePolicyPageKey(selector), selector])).values()].filter(
        selector => selector.siteId === privateSiteId
      )
      const requested = new Set(uniquePrivateSelectors.map(selector => offlinePolicyPageKey(selector)))
      const next = await this.mutatePrivatePolicy(options.readingHandle, options, current => {
        const pages = current.pages.map(page => ({ ...page, tagNames: [...page.tagNames] }))
        const byKey = new Map(pages.map(page => [page.key, page]))
        for (const selector of uniquePrivateSelectors) {
          const previous = byKey.get(offlinePolicyPageKey(selector)) ?? makePolicyPage(selector)
          const eligible = !previous.excluded && previous.availability !== 'ineligible'
          const updated = storePolicyPage(
            eligible
              ? { ...previous, automatic: true, automaticSelectedAt: previous.automaticSelectedAt ?? options.asOf ?? now() }
              : { ...previous, automatic: false, automaticSelectedAt: null }
          )
          byKey.set(updated.key, updated)
        }
        const removePageIds: number[] = []
        for (const previous of pages) {
          if (
            previous.siteId !== privateSiteId ||
            requested.has(previous.key) ||
            previous.excluded ||
            (!previous.automatic && previous.automaticSelectedAt === null)
          )
            continue
          const updated = storePolicyPage({ ...previous, automatic: false, automaticSelectedAt: null })
          byKey.set(updated.key, updated)
          if (previous.automatic && !previous.manual && !previous.tag) removePageIds.push(previous.pageId)
        }
        const nextPages = [...byKey.values()]
        const changed = JSON.stringify(nextPages) !== JSON.stringify(current.pages)
        return {
          policy: {
            state: changed ? makePolicyState({ ...current.state, policyRevision: current.state.policyRevision + 1 }) : current.state,
            pages: nextPages
          },
          removePageIds
        }
      })
      return next.pages.map(clonePolicyPage)
    }
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'policy', 'snapshots', 'searchDocuments'], 'readwrite')
      const { meta } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      const policyStore = tx.objectStore('policy')
      const values = await policyStore.getAll()
      const pages = new Map<string, OfflinePagePolicyRecord>()
      for (const value of values) {
        const parsed = parsePolicyPage(value)
        if (parsed) pages.set(parsed.key, parsed)
      }
      const existingPages = [...pages.values()]
      const requested = new Set(uniqueSelectors.map((selector: OfflineSnapshotSelector) => offlinePolicyPageKey(selector)))
      const changedPages = new Map<string, OfflinePagePolicyRecord>()
      let managedBytesDelta = 0
      for (const selector of uniqueSelectors) {
        const key = offlinePolicyPageKey(selector)
        const previous = pages.get(key)
        if (!previous) {
          const page = makePolicyPage(selector, { automatic: true, automaticSelectedAt: asOf })
          pages.set(key, page)
          changedPages.set(key, page)
          managedBytesDelta += policyRecordLogicalBytes(page)
          continue
        }
        const eligible = !previous.excluded && previous.availability !== 'ineligible'
        const withoutSize = eligible
          ? { ...previous, automatic: true, automaticSelectedAt: previous.automaticSelectedAt ?? asOf }
          : { ...previous, automatic: false, automaticSelectedAt: null }
        const next = storePolicyPage(withoutSize)
        if (policyPageFieldsChanged(previous, next)) {
          changedPages.set(key, next)
          managedBytesDelta += policyRecordLogicalBytes(next) - policyRecordLogicalBytes(previous)
        }
        pages.set(key, next)
      }
      const displaced: OfflinePagePolicyRecord[] = []
      for (const previous of existingPages) {
        if (validatedSiteId !== undefined && previous.siteId !== validatedSiteId) continue
        if (requested.has(previous.key) && pages.get(previous.key)?.automatic === true) continue
        if (previous.excluded) continue
        if (!previous.automatic && previous.automaticSelectedAt === null) continue
        const next = storePolicyPage({ ...previous, automatic: false, automaticSelectedAt: null })
        if (policyPageFieldsChanged(previous, next)) {
          changedPages.set(previous.key, next)
          managedBytesDelta += policyRecordLogicalBytes(next) - policyRecordLogicalBytes(previous)
        }
        pages.set(previous.key, next)
        if (previous.automatic && !previous.manual && !previous.tag) displaced.push(previous)
      }
      if (pages.size > OFFLINE_POLICY_PAGE_LIMIT) throw new OfflineStorageError('quota', 'Offline policy metadata limits would be exceeded.')
      let bodyBytesDelta = 0
      let bodySnapshotCountDelta = 0
      let corpusChanged = false
      let accountingComplete = meta.accountingComplete
      for (const page of displaced) {
        const removed = await this.removeBodyInTransaction(tx, page.siteId, page.pageId, page.locale)
        bodyBytesDelta -= removed.bytes
        bodySnapshotCountDelta -= removed.snapshotCount
        corpusChanged ||= removed.changed
        accountingComplete = accountingComplete && removed.accountingComplete
        if (!removed.accountingComplete && !meta.accountingComplete)
          throw new OfflineStorageError('quota', 'Offline accounting is incomplete; automatic cleanup cannot inspect opaque records.')
      }
      managedBytesDelta += bodyBytesDelta
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before adding policy metadata.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      const projectedCount = checkedAccountingValue(meta.snapshotCount, bodySnapshotCountDelta, 'Offline snapshot count')
      if ((bodySnapshotCountDelta > 0 && projectedCount > OFFLINE_SNAPSHOT_LIMIT) || (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT))
        throw new OfflineStorageError('quota', 'Offline snapshot limits would be exceeded; no manual records were evicted.')
      for (const page of changedPages.values()) await policyStore.put(page)
      const nextMeta = await this.putAccountingDelta(tx, meta, managedBytesDelta, bodySnapshotCountDelta, corpusChanged, accountingComplete)
      await this.finish(tx, undefined)
      if (corpusChanged) notifyPostCommit({ kind: 'corpus', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      else if (changedPages.size > 0)
        notifyPostCommit({ kind: 'policy', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      return [...pages.values()]
        .sort((left: OfflinePagePolicyRecord, right: OfflinePagePolicyRecord) => compareSelectors(selectorForPage(left), selectorForPage(right)))
        .map(clonePolicyPage)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Automatic offline page selections could not be committed.')
    }
  }

  async synchronizeTagProvenance(
    tag: string,
    selectors: readonly OfflineSnapshotSelector[],
    options: OfflineStorageGenerationOptions = {}
  ): Promise<OfflinePagePolicyRecord[]> {
    this.assertOpen(true)
    const normalizedTag = normalizeTag(tag)
    if (!Array.isArray(selectors) || selectors.length > OFFLINE_POLICY_PAGE_LIMIT)
      throw new OfflineStorageError('invalid-record', 'Too many offline tag page records.')
    const parsedSelectors = selectors.map((selector: OfflineSnapshotSelector) => OfflineSnapshotSelectorSchema.parse(selector))
    if (options.readingHandle) {
      const privateSelectors = new Map(parsedSelectors.map(selector => [offlinePolicyPageKey(selector), selector]))
      const next = await this.mutatePrivatePolicy(options.readingHandle, options, current => {
        if (!current.state.selectedTags.includes(normalizedTag))
          throw new OfflinePolicyRevisionFencedError(options.expectedPolicyRevision ?? current.state.policyRevision, current.state.policyRevision)
        const pagesByKey = new Map(current.pages.map(page => [page.key, page]))
        for (const selector of privateSelectors.values()) {
          const previous = pagesByKey.get(offlinePolicyPageKey(selector)) ?? makePolicyPage(selector)
          if (previous.excluded || previous.tagNames.includes(normalizedTag)) continue
          pagesByKey.set(previous.key, storePolicyPage({ ...previous, tag: true, tagNames: normalizeTags([...previous.tagNames, normalizedTag]) }))
        }
        for (const previous of current.pages) {
          if (!previous.tagNames.includes(normalizedTag) || privateSelectors.has(previous.key)) continue
          const tagNames = previous.tagNames.filter(value => value !== normalizedTag)
          pagesByKey.set(previous.key, storePolicyPage({ ...previous, tag: tagNames.length > 0, tagNames }))
        }
        const pages = [...pagesByKey.values()]
        const changed = JSON.stringify(pages) !== JSON.stringify(current.pages)
        return {
          policy: {
            state: changed ? makePolicyState({ ...current.state, policyRevision: current.state.policyRevision + 1 }) : current.state,
            pages
          }
        }
      })
      return next.pages.map(clonePolicyPage)
    }
    const desired = new Map(parsedSelectors.map(selector => [offlinePolicyPageKey(selector), selector]))
    let tx: OfflineWriteTransaction | undefined
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    try {
      tx = this.db.transaction(['meta', 'policy'], 'readwrite')
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      if (!policy.selectedTags.includes(normalizedTag)) throw new OfflinePolicyRevisionFencedError(expectedPolicy, policy.policyRevision)
      const store = tx.objectStore('policy')
      const values = await store.getAll()
      const pages = new Map<string, OfflinePagePolicyRecord>()
      for (const value of values) {
        const parsed = parsePolicyPage(value)
        if (parsed) pages.set(parsed.key, parsed)
      }
      const changed = new Map<string, OfflinePagePolicyRecord>()
      let managedBytesDelta = 0
      for (const [key, selector] of desired) {
        const previousExists = pages.has(key)
        const previous = pages.get(key) ?? makePolicyPage(selector)
        if (previous.excluded) continue
        if (previous.tagNames.includes(normalizedTag)) continue
        const tagNames = normalizeTags([...previous.tagNames, normalizedTag])
        const withoutSize = { ...previous, tag: true, tagNames }
        const next = storePolicyPage(withoutSize)
        pages.set(key, next)
        changed.set(key, next)
        managedBytesDelta += policyRecordLogicalBytes(next) - (previousExists ? policyRecordLogicalBytes(previous) : 0)
      }
      for (const previous of pages.values()) {
        if (!previous.tagNames.includes(normalizedTag) || desired.has(previous.key)) continue
        const tagNames = previous.tagNames.filter((candidate: string) => candidate !== normalizedTag)
        const withoutSize = { ...previous, tag: tagNames.length > 0, tagNames }
        const next = storePolicyPage(withoutSize)
        pages.set(previous.key, next)
        changed.set(previous.key, next)
        managedBytesDelta += policyRecordLogicalBytes(next) - policyRecordLogicalBytes(previous)
      }
      if (pages.size > OFFLINE_POLICY_PAGE_LIMIT) throw new OfflineStorageError('quota', 'Offline policy metadata limits would be exceeded.')
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before adding tag metadata.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      for (const page of changed.values()) await store.put(page)
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      if (changed.size > 0) notifyPostCommit({ kind: 'policy', sessionGeneration: meta.sessionGeneration, corpusRevision: meta.corpusRevision })
      return [...pages.values()]
        .sort((left: OfflinePagePolicyRecord, right: OfflinePagePolicyRecord) => compareSelectors(selectorForPage(left), selectorForPage(right)))
        .map(clonePolicyPage)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Offline tag page provenance could not be committed.')
    }
  }

  async setPageAvailability(
    selector: OfflineSnapshotSelector,
    availability: OfflinePagePolicyRecord['availability'],
    options: OfflineStorageGenerationOptions = {}
  ): Promise<OfflinePagePolicyRecord> {
    this.assertOpen(true)
    const parsedSelector = OfflineSnapshotSelectorSchema.parse(selector)
    if (options.readingHandle) {
      if (availability === 'ineligible') return await this.markPrivatePageIneligible(options.readingHandle, parsedSelector, options)
      const privateSelector = this.assertPrivateSelector(options.readingHandle, parsedSelector)
      const next = await this.mutatePrivatePolicy(options.readingHandle, options, current => {
        const previous = current.pages.find(page => page.key === offlinePolicyPageKey(privateSelector)) ?? makePolicyPage(privateSelector)
        const nextPage = storePolicyPage({ ...previous, availability })
        const changed = JSON.stringify(previous) !== JSON.stringify(nextPage)
        return {
          policy: {
            state: changed ? makePolicyState({ ...current.state, policyRevision: current.state.policyRevision + 1 }) : current.state,
            pages: current.pages.some(page => page.key === nextPage.key)
              ? current.pages.map(page => (page.key === nextPage.key ? nextPage : page))
              : [...current.pages, nextPage]
          }
        }
      })
      return this.privatePageResult(next, privateSelector)
    }
    if (availability === 'ineligible') return await this.markPageIneligible(parsedSelector, options)
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'policy'], 'readwrite')
      const { meta } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      const store = tx.objectStore('policy')
      const key = offlinePolicyPageKey(parsedSelector)
      const raw = await store.get(key)
      const previous = raw === undefined ? makePolicyPage(parsedSelector) : parsePolicyPage(raw)
      if (!previous) throw new OfflineStorageError('invalid-record', 'The offline page policy is opaque.')
      const withoutSize = { ...previous, availability }
      const next = storePolicyPage(withoutSize)
      const changed = policyPageFieldsChanged(previous, next)
      const managedBytesDelta = policyRecordLogicalBytes(next) - (raw === undefined ? 0 : policyRecordLogicalBytes(previous))
      if (raw === undefined && (await store.index('by-type').getAll('page')).length >= OFFLINE_POLICY_PAGE_LIMIT)
        throw new OfflineStorageError('quota', 'Offline policy metadata limits would be exceeded.')
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before adding policy metadata.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      await store.put(next)
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      if (changed) notifyPostCommit({ kind: 'policy', sessionGeneration: meta.sessionGeneration, corpusRevision: meta.corpusRevision })
      return clonePolicyPage(next)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Offline page availability could not be recorded.')
    }
  }

  async markPageIneligible(selector: OfflineSnapshotSelector, options: OfflinePolicyMutationOptions = {}): Promise<OfflinePagePolicyRecord> {
    this.assertOpen(true)
    const parsedSelector = OfflineSnapshotSelectorSchema.parse(selector)
    if (options.readingHandle) return await this.markPrivatePageIneligible(options.readingHandle, parsedSelector, options)
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'policy', 'snapshots', 'searchDocuments'], 'readwrite')
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      const store = tx.objectStore('policy')
      const variants = await this.policyPagesForPageInTransaction(tx, parsedSelector)
      const previousByKey = new Map(variants.map(page => [page.key, page]))
      const storedKeys = new Set(variants.map(page => page.key))
      const requestedKey = offlinePolicyPageKey(parsedSelector)
      if (!previousByKey.has(requestedKey)) previousByKey.set(requestedKey, makePolicyPage(parsedSelector))
      const changedPages: OfflinePagePolicyRecord[] = []
      let managedBytesDelta = 0
      for (const previous of previousByKey.values()) {
        const next = storePolicyPage({
          ...previous,
          automatic: false,
          automaticSelectedAt: null,
          lastEditedAt: null,
          availability: 'ineligible' as const
        })
        if (!storedKeys.has(previous.key) || policyPageFieldsChanged(previous, next)) {
          changedPages.push(next)
          managedBytesDelta += policyRecordLogicalBytes(next) - (storedKeys.has(previous.key) ? policyRecordLogicalBytes(previous) : 0)
        }
      }
      const removed = await this.removeBodyInTransaction(tx, parsedSelector.siteId, parsedSelector.pageId)
      const accountingComplete = meta.accountingComplete && removed.accountingComplete
      const pageCountDelta = variants.some(page => page.key === requestedKey) ? 0 : 1
      if (pageCountDelta > 0 && (await store.index('by-type').getAll('page')).length >= OFFLINE_POLICY_PAGE_LIMIT)
        throw new OfflineStorageError('quota', 'Offline policy metadata limits would be exceeded.')
      const policyChanged = changedPages.length > 0
      const nextPolicy = policyChanged
        ? makePolicyState({ ...policy, policyRevision: checkedAccountingValue(policy.policyRevision, 1, 'Offline policy revision') })
        : policy
      managedBytesDelta += policyRecordLogicalBytes(nextPolicy) - policyRecordLogicalBytes(policy)
      managedBytesDelta -= removed.bytes
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before adding policy metadata.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      for (const page of changedPages) await store.put(page)
      if (pageCountDelta > 0) {
        const requested = previousByKey.get(requestedKey)
        if (requested && !changedPages.some(page => page.key === requestedKey)) await store.put(requested)
      }
      if (policyChanged) await store.put(nextPolicy)
      const nextMeta = await this.putAccountingDelta(tx, meta, managedBytesDelta, -removed.snapshotCount, removed.changed, accountingComplete)
      await this.finish(tx, undefined)
      if (removed.changed) notifyPostCommit({ kind: 'corpus', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      else if (policyChanged) notifyPostCommit({ kind: 'policy', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      const result = changedPages.find(page => page.key === requestedKey)
      if (result) return clonePolicyPage(result)
      const retained = previousByKey.get(requestedKey)
      if (!retained) throw new OfflineStorageError('transaction', 'The ineligible offline page policy was not retained.')
      return clonePolicyPage(retained)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The ineligible offline page could not be removed.')
    }
  }

  async removeOfflinePage(selector: OfflineSnapshotSelector, options: OfflinePolicyMutationOptions = {}): Promise<OfflinePagePolicyRecord> {
    this.assertOpen(true)
    const parsedSelector = OfflineSnapshotSelectorSchema.parse(selector)
    if (options.readingHandle) {
      const privateSelector = this.assertPrivateSelector(options.readingHandle, parsedSelector)
      const next = await this.mutatePrivatePolicy(options.readingHandle, options, current => {
        const currentPage = current.pages.find(page => page.key === offlinePolicyPageKey(privateSelector)) ?? makePolicyPage(privateSelector)
        const nextPage = storePolicyPage({
          ...currentPage,
          manual: false,
          automatic: false,
          tag: false,
          tagNames: [],
          automaticSelectedAt: null,
          lastEditedAt: null,
          excluded: true,
          availability: 'unknown' as const
        })
        const pages = current.pages.some(page => page.key === nextPage.key)
          ? current.pages.map(page => (page.key === nextPage.key ? nextPage : page))
          : [...current.pages, nextPage]
        return {
          policy: { state: makePolicyState({ ...current.state, policyRevision: current.state.policyRevision + 1 }), pages },
          removePageIds: [privateSelector.pageId]
        }
      })
      return this.privatePageResult(next, privateSelector)
    }
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'policy', 'snapshots', 'searchDocuments'], 'readwrite')
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      const store = tx.objectStore('policy')
      const variants = await this.policyPagesForPageInTransaction(tx, parsedSelector)
      const storedKeys = new Set(variants.map(page => page.key))
      const requestedKey = offlinePolicyPageKey(parsedSelector)
      const pages = new Map(variants.map(page => [page.key, page]))
      if (!pages.has(requestedKey)) pages.set(requestedKey, makePolicyPage(parsedSelector))
      const nextPages: OfflinePagePolicyRecord[] = []
      let policyChanged = false
      let managedBytesDelta = 0
      for (const previous of pages.values()) {
        const next = storePolicyPage({
          ...previous,
          manual: false,
          automatic: false,
          tag: false,
          tagNames: [],
          automaticSelectedAt: null,
          lastEditedAt: null,
          excluded: true,
          availability: 'unknown' as const
        })
        nextPages.push(next)
        if (!storedKeys.has(previous.key) || policyPageFieldsChanged(previous, next)) {
          policyChanged = true
          managedBytesDelta += policyRecordLogicalBytes(next) - (storedKeys.has(previous.key) ? policyRecordLogicalBytes(previous) : 0)
        }
      }
      const removed = await this.removeBodyInTransaction(tx, parsedSelector.siteId, parsedSelector.pageId)
      const accountingComplete = meta.accountingComplete && removed.accountingComplete
      const nextRevision = policyChanged ? checkedAccountingValue(policy.policyRevision, 1, 'Offline policy revision') : policy.policyRevision
      const nextState = policyChanged ? makePolicyState({ ...policy, policyRevision: nextRevision }) : policy
      managedBytesDelta += policyRecordLogicalBytes(nextState) - policyRecordLogicalBytes(policy) - removed.bytes
      if (!storedKeys.has(requestedKey) && (await store.index('by-type').getAll('page')).length >= OFFLINE_POLICY_PAGE_LIMIT)
        throw new OfflineStorageError('quota', 'Offline policy metadata limits would be exceeded.')
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before adding policy metadata.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      if (policyChanged) {
        for (const next of nextPages) await store.put(next)
        await store.put(nextState)
      }
      const nextMeta = await this.putAccountingDelta(tx, meta, managedBytesDelta, -removed.snapshotCount, removed.changed, accountingComplete)
      await this.finish(tx, undefined)
      if (removed.changed) notifyPostCommit({ kind: 'corpus', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      else if (policyChanged) notifyPostCommit({ kind: 'policy', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      const result = nextPages.find(page => page.key === requestedKey)
      if (!result) throw new OfflineStorageError('transaction', 'The excluded offline page policy was not retained.')
      return clonePolicyPage(result)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The offline page could not be removed.')
    }
  }
  async pruneUnselectedPageBodies(options: OfflineStorageGenerationOptions = {}): Promise<number> {
    this.assertOpen(true)
    if (options.readingHandle) {
      const candidates = (await this.readPrivatePolicy(options.readingHandle, options)).pages.filter(
        page => !page.manual && !page.automatic && !page.tag && !page.excluded
      )
      await this.mutatePrivatePolicy(options.readingHandle, options, current => ({
        policy: current,
        removePageIds: candidates.map(page => page.pageId)
      }))
      return candidates.length
    }
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'policy', 'snapshots', 'searchDocuments'], 'readwrite')
      const { meta } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      const values = await tx.objectStore('policy').getAll()
      let removedCount = 0
      let removedBytes = 0
      let removedSnapshotCount = 0
      let accountingComplete = meta.accountingComplete
      let corpusChanged = false
      for (const value of values) {
        const page = parsePolicyPage(value)
        if (!page || page.manual || page.automatic || page.tag || page.excluded) continue
        const removed = await this.removeBodyInTransaction(tx, page.siteId, page.pageId, page.locale)
        if (!removed.changed) continue
        removedCount += 1
        removedBytes += removed.bytes
        removedSnapshotCount += removed.snapshotCount
        corpusChanged = true
        accountingComplete &&= removed.accountingComplete
      }
      const nextMeta = await this.putAccountingDelta(tx, meta, -removedBytes, -removedSnapshotCount, corpusChanged, accountingComplete)
      await this.finish(tx, undefined)
      if (corpusChanged) notifyPostCommit({ kind: 'corpus', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      return removedCount
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Unselected offline page bodies could not be removed.')
    }
  }

  async updateSyncDiagnostics(diagnostics: OfflineSyncDiagnostics, options: OfflineStorageGenerationOptions = {}): Promise<OfflinePolicyState> {
    this.assertOpen(true)
    const parsedDiagnostics = OfflineSyncDiagnosticsSchema.parse(diagnostics)
    if (options.readingHandle) {
      const next = await this.mutatePrivatePolicy(options.readingHandle, options, current => ({
        policy: {
          state: makePolicyState({ ...current.state, syncDiagnostics: parsedDiagnostics, policyRevision: current.state.policyRevision + 1 }),
          pages: current.pages
        }
      }))
      return clonePolicyState(next.state)
    }
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'policy'], 'readwrite')
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expectedGeneration, expectedPolicy)
      const nextPolicy = makePolicyState({ ...policy, syncDiagnostics: parsedDiagnostics })
      const managedBytesDelta = policyRecordLogicalBytes(nextPolicy) - policyRecordLogicalBytes(policy)
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; diagnostics cannot grow managed storage.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      await tx.objectStore('policy').put(nextPolicy)
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      return clonePolicyState(nextPolicy)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Offline sync diagnostics could not be committed.')
    }
  }

  async searchDocuments(siteId: string, query = '', options: OfflineStorageGenerationOptions = {}): Promise<OfflineSearchDocumentV1[]> {
    this.assertOpen(false)
    const validatedSiteId = validateSiteId(siteId)
    if (options.readingHandle) {
      if (validatedSiteId !== options.readingHandle.context.siteId || !isCurrentOfflineReadingHandle(options.readingHandle))
        throw new OfflineStorageError('generation-fenced', 'The private reading handle is no longer current.')
      const normalizedQuery = normalizeSearchText(query)
      const records = await this.listPrivateRecords(options.readingHandle.context.keyId, { expectedSessionGeneration: options.readingHandle.sessionGeneration })
      const result: OfflineSearchDocumentV1[] = []
      for (const envelope of records) {
        if (envelope.kind !== 'search') continue
        const value = await decryptOfflinePrivateRecord(options.readingHandle, envelope)
        const parsed = OfflineSearchDocumentV1Schema.safeParse(value)
        if (!parsed.success) continue
        if (
          !normalizedQuery ||
          normalizeSearchText(
            `${parsed.data.title} ${parsed.data.description} ${parsed.data.searchText} ${parsed.data.path} ${parsed.data.canonicalPath}`
          ).includes(normalizedQuery)
        )
          result.push(parsed.data)
      }
      return result
    }
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    const normalizedQuery = normalizeSearchText(query)
    try {
      const tx = this.db.transaction(['meta', 'searchDocuments'], 'readonly')
      await this.assertGenerationInTransaction(tx, expected)
      const values = await tx.objectStore('searchDocuments').index('by-site').getAll(validatedSiteId)
      const records: OfflineSearchDocumentV1[] = []
      for (const value of values) {
        const parsed = OfflineSearchDocumentV1Schema.safeParse(value)
        if (parsed.success) records.push({ ...parsed.data })
      }
      await this.finishRead(tx, undefined)
      if (!normalizedQuery) return records
      return records.filter((record: OfflineSearchDocumentV1) =>
        normalizeSearchText(`${record.title} ${record.description} ${record.searchText} ${record.path} ${record.canonicalPath}`).includes(normalizedQuery)
      )
    } catch (error) {
      throw toFailure(error, 'transaction', 'Offline search documents could not be read.')
    }
  }

  async putDraft(envelope: OfflineDraftEnvelopeV1, options: OfflineDraftWriteOptions = {}): Promise<OfflineDraftEnvelopeV1> {
    this.assertOpen(true)
    const parsed = OfflineDraftEnvelopeV1Schema.parse(envelope)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    if (parsed.sessionGeneration !== expected) throw new OfflineGenerationFencedError(expected, parsed.sessionGeneration)
    const serialized = logicalEnvelopeBytes(parsed)
    if (serialized > OFFLINE_RECORD_BYTES_LIMIT) throw new OfflineStorageError('quota', 'The encrypted draft envelope exceeds the per-record limit.')
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'drafts'], 'readwrite', { durability: 'strict' }) as OfflineWriteTransaction
      const meta = await this.assertGenerationInTransaction(tx, expected)
      const store = tx.objectStore('drafts')
      const existingValue = await store.get(parsed.recordId)
      const existing = existingValue === undefined ? undefined : OfflineDraftEnvelopeV1Schema.safeParse(existingValue)
      if (existingValue !== undefined && !existing?.success)
        throw new OfflineDraftConflictError(parsed.recordId, 'The existing draft is opaque and can only be removed by raw key.')
      if (existing?.success && existing.data.sessionGeneration !== expected) throw new OfflineGenerationFencedError(expected, existing.data.sessionGeneration)
      if (existing?.success && existing.data.submissionId !== null) {
        if (isSameEnvelope(existing.data, parsed)) {
          await this.finish(tx, undefined)
          return cloneEnvelope(existing.data)
        }
        throw new OfflineStorageError('immutable-submission', 'Immutable publishing records cannot be overwritten.')
      }
      if (existing?.success) {
        if (options.expectedDraftRevision === undefined || options.expectedSubmissionId === undefined)
          throw new OfflineDraftConflictError(parsed.recordId, 'Mutable draft replacement requires an explicit stored selector.')
        if (existing.data.draftRevision !== options.expectedDraftRevision || existing.data.submissionId !== options.expectedSubmissionId)
          throw new OfflineDraftConflictError(parsed.recordId)
        if (!isSameOwner(existing.data, parsed) || parsed.submissionId !== null)
          throw new OfflineStorageError('invalid-record', 'Mutable draft ownership and key identity cannot change.')
        if (parsed.draftRevision <= existing.data.draftRevision)
          throw new OfflineDraftConflictError(parsed.recordId, 'Draft revisions must increase monotonically.')
      } else if (options.expectedDraftRevision !== undefined && options.expectedDraftRevision !== null) {
        throw new OfflineDraftConflictError(parsed.recordId)
      } else if (options.expectedSubmissionId !== undefined && options.expectedSubmissionId !== null) {
        throw new OfflineDraftConflictError(parsed.recordId)
      }
      const oldBytes = existing?.success ? logicalEnvelopeBytes(existing.data) : 0
      const managedBytesDelta = serialized - oldBytes
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before adding data.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded; no draft was evicted.')
      await store.put(cloneEnvelope(parsed))
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      return cloneEnvelope(parsed)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The encrypted draft envelope could not be committed.')
    }
  }

  async rewrapSubmission(
    expectedEnvelope: OfflineDraftEnvelopeV1,
    replacementEnvelope: OfflineDraftEnvelopeV1,
    options: OfflineStorageGenerationOptions = {}
  ): Promise<OfflineDraftEnvelopeV1> {
    this.assertOpen(true)
    const expectedParsed = OfflineDraftEnvelopeV1Schema.parse(expectedEnvelope)
    const replacementParsed = OfflineDraftEnvelopeV1Schema.parse(replacementEnvelope)
    if (
      expectedParsed.submissionId === null ||
      replacementParsed.submissionId === null ||
      !isSameOwner(expectedParsed, replacementParsed) ||
      expectedParsed.draftRevision !== replacementParsed.draftRevision ||
      expectedParsed.submissionId !== replacementParsed.submissionId ||
      replacementParsed.sessionGeneration <= expectedParsed.sessionGeneration
    )
      throw new OfflineStorageError('invalid-record', 'Only an immutable submission can be rewrapped.')
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    if (replacementParsed.sessionGeneration !== expectedGeneration)
      throw new OfflineGenerationFencedError(expectedGeneration, replacementParsed.sessionGeneration)
    return await this.replaceExactEnvelope(expectedParsed, replacementParsed, expectedGeneration, 'The immutable submission could not be rewrapped.')
  }

  async recoverOrdinaryDraft(
    expectedEnvelope: OfflineDraftEnvelopeV1,
    replacementEnvelope: OfflineDraftEnvelopeV1,
    options: OfflineStorageGenerationOptions = {}
  ): Promise<OfflineDraftEnvelopeV1> {
    this.assertOpen(true)
    const expectedParsed = OfflineDraftEnvelopeV1Schema.parse(expectedEnvelope)
    const replacementParsed = OfflineDraftEnvelopeV1Schema.parse(replacementEnvelope)
    if (
      expectedParsed.submissionId !== null ||
      replacementParsed.submissionId !== null ||
      !isSameOwner(expectedParsed, replacementParsed) ||
      expectedParsed.draftRevision !== replacementParsed.draftRevision ||
      replacementParsed.sessionGeneration <= expectedParsed.sessionGeneration
    )
      throw new OfflineStorageError('invalid-record', 'Only an ordinary older-generation draft can be recovered.')
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    if (replacementParsed.sessionGeneration !== expectedGeneration)
      throw new OfflineGenerationFencedError(expectedGeneration, replacementParsed.sessionGeneration)
    return await this.replaceExactEnvelope(expectedParsed, replacementParsed, expectedGeneration, 'The ordinary draft could not be recovered.')
  }

  private async replaceExactEnvelope(
    expectedEnvelope: OfflineDraftEnvelopeV1,
    replacementEnvelope: OfflineDraftEnvelopeV1,
    expectedGeneration: number,
    failureMessage: string
  ): Promise<OfflineDraftEnvelopeV1> {
    const replacementBytes = logicalEnvelopeBytes(replacementEnvelope)
    if (replacementBytes > OFFLINE_RECORD_BYTES_LIMIT) throw new OfflineStorageError('quota', 'The encrypted draft envelope exceeds the per-record limit.')
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'drafts'], 'readwrite', { durability: 'strict' })
      const meta = await this.assertGenerationInTransaction(tx, expectedGeneration)
      const store = tx.objectStore('drafts')
      const currentValue = await store.get(expectedEnvelope.recordId)
      if (currentValue === undefined) throw new OfflineDraftConflictError(expectedEnvelope.recordId)
      const current = OfflineDraftEnvelopeV1Schema.safeParse(currentValue)
      if (!current.success || !isSameEnvelope(current.data, expectedEnvelope)) throw new OfflineDraftConflictError(expectedEnvelope.recordId)
      const currentBytes = logicalEnvelopeBytes(current.data)
      const managedBytesDelta = replacementBytes - currentBytes
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; recovery cannot increase managed storage.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      await store.put(cloneEnvelope(replacementEnvelope))
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      return cloneEnvelope(replacementEnvelope)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', failureMessage)
    }
  }

  async listDraftEnvelopes(accountId: number, options: OfflineStorageGenerationOptions = {}): Promise<OfflineDraftEnvelopeV1[]> {
    this.assertOpen(false)
    const validatedAccountId = validateAccountId(accountId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    try {
      const tx = this.db.transaction(['meta', 'drafts'], 'readonly')
      await this.assertGenerationInTransaction(tx, expected)
      const values = await tx.objectStore('drafts').getAll()
      const result: OfflineDraftEnvelopeV1[] = []
      for (const value of values) {
        const parsed = OfflineDraftEnvelopeV1Schema.safeParse(value)
        if (parsed.success && parsed.data.accountId === validatedAccountId) result.push(cloneEnvelope(parsed.data))
      }
      return await this.finishRead(tx, result)
    } catch (error) {
      throw toFailure(error, 'transaction', 'Encrypted draft envelopes could not be read.')
    }
  }

  async deleteDraft(recordId: string, options: OfflineDraftDeleteOptions = {}): Promise<boolean> {
    this.assertOpen(true)
    const validatedRecordId = validateRecordId(recordId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'drafts'], 'readwrite', { durability: 'strict' })
      const meta = await this.assertGenerationInTransaction(tx, expected)
      const store = tx.objectStore('drafts')
      const existingValue = await store.get(validatedRecordId)
      if (existingValue === undefined) {
        await this.finish(tx, undefined)
        return false
      }
      const existing = OfflineDraftEnvelopeV1Schema.safeParse(existingValue)
      if (!existing.success) throw new OfflineDraftConflictError(validatedRecordId, 'Conditional deletion requires a valid stored envelope.')
      if (options.expectedDraftRevision !== undefined && existing.data.draftRevision !== options.expectedDraftRevision)
        throw new OfflineDraftConflictError(validatedRecordId)
      if (options.expectedSubmissionId !== undefined && existing.data.submissionId !== options.expectedSubmissionId)
        throw new OfflineDraftConflictError(validatedRecordId)
      if (existing.data.submissionId !== null && (options.expectedDraftRevision === undefined || options.expectedSubmissionId === undefined))
        throw new OfflineStorageError('immutable-submission', 'Immutable publishing records require their complete stored selector for deletion.')
      const managedBytesDelta = -logicalEnvelopeBytes(existing.data)
      await store.delete(validatedRecordId)
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      return true
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The encrypted draft envelope could not be deleted.')
    }
  }

  async deleteDraftRaw(recordId: string, options: OfflineStorageGenerationOptions = {}): Promise<boolean> {
    this.assertOpen(true)
    const validatedRecordId = validateRecordId(recordId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'drafts'], 'readwrite', { durability: 'strict' })
      const meta = await this.assertGenerationInTransaction(tx, expected)
      const store = tx.objectStore('drafts')
      const existing = await store.get(validatedRecordId)
      if (existing === undefined) {
        await this.finish(tx, undefined)
        return false
      }
      const parsed = OfflineDraftEnvelopeV1Schema.safeParse(existing)
      await store.delete(validatedRecordId)
      await this.putAccountingDelta(
        tx,
        meta,
        parsed.success ? -logicalEnvelopeBytes(parsed.data) : 0,
        0,
        false,
        parsed.success ? meta.accountingComplete : false
      )
      await this.finish(tx, undefined)
      return true
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The raw encrypted draft envelope could not be deleted.')
    }
  }

  async purgeAccount(accountId: number, options: OfflineStorageGenerationOptions = {}): Promise<OfflinePurgeResult> {
    this.assertOpen(true)
    const validatedAccountId = validateAccountId(accountId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'drafts'], 'readwrite', { durability: 'strict' })
      const meta = await this.assertGenerationInTransaction(tx, expected)
      const store = tx.objectStore('drafts')
      const values = await store.getAll()
      const deletedRecordIds: string[] = []
      const preservedRecordIds: string[] = []
      let removedBytes = 0
      let accountingComplete = meta.accountingComplete
      for (const value of values) {
        const parsed = OfflineDraftEnvelopeV1Schema.safeParse(value)
        if (!parsed.success) {
          accountingComplete = false
          continue
        }
        if (parsed.data.accountId !== validatedAccountId || parsed.data.submissionId !== null) {
          if (parsed.data.accountId === validatedAccountId) preservedRecordIds.push(parsed.data.recordId)
          continue
        }
        removedBytes = checkedAccountingValue(removedBytes, logicalEnvelopeBytes(parsed.data), 'Offline draft purge bytes')
        await store.delete(parsed.data.recordId)
        deletedRecordIds.push(parsed.data.recordId)
      }
      await this.putAccountingDelta(tx, meta, -removedBytes, 0, false, accountingComplete, now())
      await this.finish(tx, undefined)
      return { deletedRecordIds, preservedRecordIds }
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Account-owned offline drafts could not be purged.')
    }
  }

  async invalidateAccountSession(accountId: number, options: OfflineStorageGenerationOptions = {}): Promise<OfflineAccountInvalidationResult> {
    lockOfflineReading()
    this.assertOpen(true)
    const validatedAccountId = validateAccountId(accountId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'snapshots', 'drafts', 'searchDocuments', 'policy', 'readingVault', 'privateRecords'], 'readwrite', {
        durability: 'strict'
      })
      const meta = await this.assertGenerationInTransaction(tx, expected)
      const store = tx.objectStore('drafts')
      const values = await store.getAll()
      let deletedCount = 0
      let preservedOpaqueCount = 0
      let preservedReceiptCount = 0
      for (const value of values) {
        const parsed = OfflineDraftEnvelopeV1Schema.safeParse(value)
        if (!parsed.success) {
          preservedOpaqueCount += 1
          continue
        }
        if (parsed.data.accountId !== validatedAccountId) continue
        if (parsed.data.submissionId === null) {
          await store.delete(parsed.data.recordId)
          deletedCount += 1
        } else preservedReceiptCount += 1
      }
      await tx.objectStore('readingVault').delete(READING_VAULT_KEY)
      const privateStore = tx.objectStore('privateRecords')
      for (const key of await privateStore.getAllKeys()) await privateStore.delete(key)
      const nextGeneration = checkedAccountingValue(meta.sessionGeneration, 1, 'Session generation')
      const accounting = await recountAccountingInTransaction(tx)
      const nextMeta = {
        ...meta,
        sessionGeneration: nextGeneration,
        managedBytes: accounting.managedBytes,
        snapshotCount: accounting.snapshotCount,
        accountingComplete: accounting.complete,
        corpusRevision: checkedAccountingValue(meta.corpusRevision, 1, 'Offline corpus revision'),
        lastCleanupAt: now()
      }
      await tx.objectStore('meta').put(nextMeta)
      await this.finish(tx, undefined)
      notifyPostCommit({ kind: 'generation', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      return { sessionGeneration: nextGeneration, deletedCount, preservedOpaqueCount, preservedReceiptCount }
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Account session invalidation could not be committed.')
    }
  }

  async clearDeviceData(options: OfflineStorageGenerationOptions = {}): Promise<number> {
    lockOfflineReading()
    this.assertOpen(true)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    const expectedPolicy = await this.expectedPolicyRevision(options.expectedPolicyRevision)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'snapshots', 'drafts', 'searchDocuments', 'policy', 'readingVault', 'privateRecords'], 'readwrite', {
        durability: 'strict'
      })
      const { meta, policy } = await this.assertGenerationAndPolicyInTransaction(tx, expected, expectedPolicy)
      await tx.objectStore('snapshots').clear()
      await tx.objectStore('searchDocuments').clear()
      await tx.objectStore('drafts').clear()
      await tx.objectStore('policy').clear()
      await tx.objectStore('readingVault').clear()
      await tx.objectStore('privateRecords').clear()
      const nextGeneration = meta.sessionGeneration + 1
      const nextCorpusRevision = meta.corpusRevision + 1
      const nextPolicyRevision = policy.policyRevision + 1
      if (!Number.isSafeInteger(nextGeneration) || !Number.isSafeInteger(nextCorpusRevision) || !Number.isSafeInteger(nextPolicyRevision))
        throw new OfflineStorageError('generation-fenced', 'Offline generation or corpus revision overflowed.')
      const nextPolicy = makePolicyState({ policyRevision: nextPolicyRevision })
      const nextMeta: OfflineMetaRecord = {
        ...meta,
        sessionGeneration: nextGeneration,
        managedBytes: policyRecordLogicalBytes(nextPolicy),
        snapshotCount: 0,
        corpusRevision: nextCorpusRevision,
        accountingComplete: true,
        lastCleanupAt: now()
      }
      await tx.objectStore('policy').put(nextPolicy)
      await tx.objectStore('meta').put(nextMeta)
      await this.finish(tx, undefined)
      notifyPostCommit({ kind: 'generation', sessionGeneration: nextGeneration, corpusRevision: nextCorpusRevision })
      return nextGeneration
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Offline device data could not be cleared.')
    }
  }

  async finalizeSubmission(options: OfflineSubmissionFinalizationOptions): Promise<OfflineSubmissionFinalizationResult> {
    this.assertOpen(true)
    const expectedReceipt = OfflineDraftEnvelopeV1Schema.parse(options.expectedReceipt)
    const expectedSource = options.expectedSource === null ? null : OfflineDraftEnvelopeV1Schema.parse(options.expectedSource)
    const expectedSurvivingFork = options.expectedSurvivingFork === null ? null : OfflineDraftEnvelopeV1Schema.parse(options.expectedSurvivingFork)
    const survivingFork = options.survivingFork === null ? null : OfflineDraftEnvelopeV1Schema.parse(options.survivingFork)
    if (expectedSource && !isSameKeyOwner(expectedReceipt, expectedSource)) {
      throw new OfflineStorageError('invalid-record', 'Finalization records must retain one account and key identity.')
    }
    if (expectedSurvivingFork && !isSameKeyOwner(expectedReceipt, expectedSurvivingFork)) {
      throw new OfflineStorageError('invalid-record', 'Finalization records must retain one account and key identity.')
    }
    if (survivingFork && !isSameKeyOwner(expectedReceipt, survivingFork)) {
      throw new OfflineStorageError('invalid-record', 'Finalization records must retain one account and key identity.')
    }
    if (expectedReceipt.submissionId === null) throw new OfflineStorageError('invalid-record', 'Finalization receipt must be immutable.')
    if (expectedSource && expectedSource.submissionId !== null) {
      throw new OfflineStorageError('invalid-record', 'Finalization source must be a mutable ordinary draft.')
    }
    if (expectedSurvivingFork && expectedSurvivingFork.submissionId !== null) {
      throw new OfflineStorageError('invalid-record', 'The expected surviving fork must be a mutable ordinary draft.')
    }
    if (survivingFork && survivingFork.submissionId !== null) {
      throw new OfflineStorageError('invalid-record', 'The surviving fork must be a mutable ordinary draft.')
    }
    if (expectedSource && expectedSource.recordId === expectedReceipt.recordId) {
      throw new OfflineStorageError('invalid-record', 'Receipt and source records must be distinct.')
    }
    if (expectedSurvivingFork && (expectedSurvivingFork.recordId === expectedReceipt.recordId || expectedSurvivingFork.recordId === expectedSource?.recordId)) {
      throw new OfflineStorageError('invalid-record', 'The surviving fork must be distinct from the receipt and source records.')
    }
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    if (expectedReceipt.sessionGeneration !== expectedGeneration) {
      throw new OfflineGenerationFencedError(expectedGeneration, expectedReceipt.sessionGeneration)
    }
    if (expectedSource && expectedSource.sessionGeneration !== expectedGeneration) {
      throw new OfflineGenerationFencedError(expectedGeneration, expectedSource.sessionGeneration)
    }
    if (expectedSurvivingFork && expectedSurvivingFork.sessionGeneration !== expectedGeneration) {
      throw new OfflineGenerationFencedError(expectedGeneration, expectedSurvivingFork.sessionGeneration)
    }
    if (survivingFork && survivingFork.sessionGeneration !== expectedGeneration) {
      throw new OfflineGenerationFencedError(expectedGeneration, survivingFork.sessionGeneration)
    }
    if (expectedSource && expectedSurvivingFork && expectedSurvivingFork.draftRevision <= expectedSource.draftRevision) {
      throw new OfflineDraftConflictError(expectedSurvivingFork.recordId, 'The expected surviving fork is not newer than the frozen source.')
    }
    if (expectedSurvivingFork && !survivingFork) {
      throw new OfflineDraftConflictError(expectedSurvivingFork.recordId, 'The surviving fork changed before finalization.')
    }
    if (survivingFork && !expectedSource) {
      throw new OfflineStorageError('invalid-record', 'A surviving fork requires a mutable source record.')
    }
    if (survivingFork && expectedSource && survivingFork.draftRevision <= expectedSource.draftRevision) {
      throw new OfflineDraftConflictError(survivingFork.recordId, 'The surviving fork is not a newer exact source replacement.')
    }
    if (expectedSurvivingFork && survivingFork && survivingFork.recordId !== expectedSurvivingFork.recordId) {
      throw new OfflineDraftConflictError(survivingFork.recordId, 'The surviving fork replacement changed its record identity.')
    }
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'drafts'], 'readwrite', { durability: 'strict' })
      const meta = await this.assertGenerationInTransaction(tx, expectedGeneration)
      const store = tx.objectStore('drafts')
      const receiptValue = await store.get(expectedReceipt.recordId)
      const receipt = receiptValue === undefined ? null : OfflineDraftEnvelopeV1Schema.safeParse(receiptValue)
      if (!receipt?.success || !isSameEnvelope(receipt.data, expectedReceipt)) {
        throw new OfflineDraftConflictError(expectedReceipt.recordId, 'The immutable receipt changed before finalization.')
      }
      let source: OfflineDraftEnvelopeV1 | null = null
      if (expectedSource) {
        const sourceValue = await store.get(expectedSource.recordId)
        const sourceParsed = sourceValue === undefined ? null : OfflineDraftEnvelopeV1Schema.safeParse(sourceValue)
        if (!sourceParsed?.success || !isSameEnvelope(sourceParsed.data, expectedSource)) {
          throw new OfflineDraftConflictError(expectedSource.recordId, 'The source draft changed before finalization.')
        }
        source = sourceParsed.data
      }
      let oldFork: OfflineDraftEnvelopeV1 | null = null
      if (expectedSurvivingFork) {
        const forkValue = await store.get(expectedSurvivingFork.recordId)
        const forkParsed = forkValue === undefined ? null : OfflineDraftEnvelopeV1Schema.safeParse(forkValue)
        if (!forkParsed?.success || !isSameEnvelope(forkParsed.data, expectedSurvivingFork)) {
          throw new OfflineDraftConflictError(expectedSurvivingFork.recordId, 'The surviving fork changed before finalization.')
        }
        oldFork = forkParsed.data
      }
      if (survivingFork) {
        const replacementIsFork = survivingFork.recordId === oldFork?.recordId
        if (!replacementIsFork) {
          const existingFork = await store.get(survivingFork.recordId)
          if (existingFork !== undefined) throw new OfflineDraftConflictError(survivingFork.recordId)
        }
      }
      const oldBytes = logicalEnvelopeBytes(receipt.data) + (source ? logicalEnvelopeBytes(source) : 0) + (oldFork ? logicalEnvelopeBytes(oldFork) : 0)
      const newBytes = survivingFork ? logicalEnvelopeBytes(survivingFork) : 0
      const managedBytesDelta = newBytes - oldBytes
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; finalization cannot add a fork.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (managedBytesDelta > 0 && projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      await store.delete(expectedReceipt.recordId)
      if (source) await store.delete(source.recordId)
      if (oldFork) await store.delete(oldFork.recordId)
      if (survivingFork) await store.put(cloneEnvelope(survivingFork))
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      return { receiptDeleted: true, sourceDeleted: source !== null, survivingFork: survivingFork ? cloneEnvelope(survivingFork) : null }
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The submission finalization could not be committed.')
    }
  }

  async lockedDraftCount(): Promise<number> {
    this.assertOpen(false)
    try {
      const tx = this.db.transaction('drafts', 'readonly') as OfflineTransaction
      const count = await tx.objectStore('drafts').count()
      return await this.finishRead(tx, count)
    } catch (error) {
      throw toFailure(error, 'transaction', 'Locked draft count could not be read.')
    }
  }

  async requestPersistence(): Promise<boolean> {
    this.assertOpen(false)
    const storage = getStorageManager()
    let granted = false
    if (storage?.persist) {
      try {
        granted = await storage.persist()
      } catch {
        granted = false
      }
    }
    const persisted = await getPersisted()
    const estimate = await getStorageEstimate()
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction('meta', 'readwrite') as OfflineWriteTransaction
      const meta = await tx.objectStore('meta').get(META_KEY)
      const parsed = OfflineMetaRecordSchema.parse(meta)
      await tx.objectStore('meta').put({
        ...parsed,
        storage: { ...parsed.storage, usageBytes: estimate.usageBytes, quotaBytes: estimate.quotaBytes, persisted, persistenceRequested: true }
      })
      await this.finish(tx, undefined)
    } catch {
      await this.abort(tx)
      // Persistence is an optional capability. The result remains separate from metadata refresh.
    }
    return persisted ?? granted
  }

  async storageEstimate(): Promise<OfflineStorageEstimate> {
    this.assertOpen(false)
    const meta = await this.readMeta()
    const estimate = await getStorageEstimate()
    const persisted = await getPersisted()
    try {
      const tx = this.db.transaction(['meta', 'drafts', 'policy'], 'readonly')
      const committedMeta = await this.assertGenerationInTransaction(tx, meta.sessionGeneration)
      const policy = await this.readPolicyStateInTransaction(tx)
      const lockedDraftCount = await tx.objectStore('drafts').count()
      const policyValues = await tx.objectStore('policy').index('by-type').getAll('page')
      let policyPageCount = 0
      for (const value of policyValues) if (OfflinePagePolicyRecordSchema.safeParse(value).success) policyPageCount += 1
      await this.finishRead(tx, undefined)
      const result = {
        usageBytes: estimate.usageBytes ?? committedMeta.storage.usageBytes,
        quotaBytes: estimate.quotaBytes ?? committedMeta.storage.quotaBytes,
        persisted: persisted ?? committedMeta.storage.persisted,
        managedBytes: committedMeta.managedBytes,
        snapshotCount: committedMeta.snapshotCount,
        policyPageCount,
        lockedDraftCount,
        schemaVersion: committedMeta.schemaVersion,
        sessionGeneration: committedMeta.sessionGeneration,
        policyRevision: policy.policyRevision
      }
      return OfflineStorageEstimateSchema.parse(result)
    } catch (error) {
      throw toFailure(error, 'transaction', 'Offline storage estimate could not be read.')
    }
  }
  async getReadingVault(): Promise<OfflineReadingVaultV1 | null> {
    this.assertOpen(false)
    try {
      const value = await this.db.get('readingVault', READING_VAULT_KEY)
      if (value === undefined) return null
      const parsed = OfflineReadingVaultV1Schema.safeParse(value)
      if (!parsed.success) throw new OfflineStorageError('metadata-recovery', 'The private offline vault is unavailable.')
      return cloneReadingVault(parsed.data)
    } catch (error) {
      throw toFailure(error, 'transaction', 'The private offline vault could not be read.')
    }
  }

  async putReadingVault(vault: OfflineReadingVaultV1, options: OfflineStorageGenerationOptions = {}): Promise<OfflineReadingVaultV1> {
    this.assertOpen(true)
    const parsedVault = OfflineReadingVaultV1Schema.parse(vault)
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    if (parsedVault.sessionGeneration !== expectedGeneration) throw new OfflineGenerationFencedError(expectedGeneration, parsedVault.sessionGeneration)
    if (readingVaultLogicalBytes(parsedVault) > OFFLINE_PRIVATE_RECORD_BYTES_LIMIT)
      throw new OfflineStorageError('quota', 'The private offline vault exceeds the per-record limit.')
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'readingVault', 'privateRecords'], 'readwrite', { durability: 'strict' }) as OfflineWriteTransaction
      const meta = await this.assertGenerationInTransaction(tx, expectedGeneration)
      const store = tx.objectStore('readingVault')
      const existingValue = await store.get(READING_VAULT_KEY)
      const existing = existingValue === undefined ? null : OfflineReadingVaultV1Schema.safeParse(existingValue)
      if (existingValue !== undefined && !existing?.success) throw new OfflineStorageError('metadata-recovery', 'The private offline vault is opaque.')
      if (existing?.success) {
        if (JSON.stringify(existing.data.context) !== JSON.stringify(parsedVault.context) || existing.data.sessionGeneration !== parsedVault.sessionGeneration)
          throw new OfflineStorageError('transaction', 'A private offline vault is already enrolled.')
        await this.finish(tx, undefined)
        return cloneReadingVault(existing.data)
      }
      const bytes = readingVaultLogicalBytes(parsedVault)
      if (!meta.accountingComplete) throw new OfflineStorageError('quota', 'Offline accounting is incomplete; private enrollment is blocked.')
      const projected = checkedAccountingValue(meta.managedBytes, bytes, 'Offline managed bytes')
      if (projected > OFFLINE_MANAGED_BYTES_LIMIT) throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
      await store.put(cloneReadingVault(parsedVault), READING_VAULT_KEY)
      await this.putAccountingDelta(tx, meta, bytes, 0, false)
      await this.finish(tx, undefined)
      return cloneReadingVault(parsedVault)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The private offline vault could not be committed.')
    }
  }

  async retireReadingVault(options: OfflineStorageGenerationOptions = {}): Promise<number> {
    lockOfflineReading()
    this.assertOpen(true)
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'snapshots', 'drafts', 'searchDocuments', 'policy', 'readingVault', 'privateRecords'], 'readwrite', {
        durability: 'strict'
      }) as OfflineWriteTransaction
      const meta = await this.assertGenerationInTransaction(tx, expectedGeneration)
      const vaultStore = tx.objectStore('readingVault')
      const privateStore = tx.objectStore('privateRecords')
      const vaultValue = await vaultStore.get(READING_VAULT_KEY)
      const privateCount = await privateStore.count()
      const hadPrivateState = vaultValue !== undefined || privateCount > 0
      await vaultStore.delete(READING_VAULT_KEY)
      await privateStore.clear()
      const accounting = await recountAccountingInTransaction(tx)
      const nextGeneration = hadPrivateState ? checkedAccountingValue(meta.sessionGeneration, 1, 'Session generation') : meta.sessionGeneration
      const nextMeta = {
        ...meta,
        sessionGeneration: nextGeneration,
        managedBytes: accounting.managedBytes,
        snapshotCount: accounting.snapshotCount,
        accountingComplete: accounting.complete,
        corpusRevision: checkedAccountingValue(meta.corpusRevision, hadPrivateState ? 1 : 0, 'Offline corpus revision'),
        lastCleanupAt: now()
      }
      await tx.objectStore('meta').put(nextMeta)
      await this.finish(tx, undefined)
      if (hadPrivateState) notifyPostCommit({ kind: 'generation', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      return privateCount
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The private offline vault could not be retired.')
    }
  }

  async listPrivateRecords(keyId: string, options: OfflineStorageGenerationOptions = {}): Promise<OfflinePrivateEnvelopeV1[]> {
    this.assertOpen(false)
    if (typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(keyId)) throw new OfflineStorageError('invalid-record', 'Private vault identity is invalid.')
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    try {
      const tx = this.db.transaction(['meta', 'readingVault', 'privateRecords'], 'readonly') as OfflineTransaction
      await this.assertGenerationInTransaction(tx, expectedGeneration)
      if (options.expectedCorpusRevision !== undefined && (!Number.isSafeInteger(options.expectedCorpusRevision) || options.expectedCorpusRevision < 0))
        throw new OfflineStorageError('generation-fenced', 'Offline corpus revision is invalid.')
      const metadata = await tx.objectStore('meta').get(META_KEY)
      const parsedMetadata = OfflineMetaRecordSchema.safeParse(metadata)
      if (!parsedMetadata.success || (options.expectedCorpusRevision !== undefined && parsedMetadata.data.corpusRevision !== options.expectedCorpusRevision))
        throw new OfflineGenerationFencedError(options.expectedCorpusRevision ?? -1, parsedMetadata.success ? parsedMetadata.data.corpusRevision : -1)
      const vault = await tx.objectStore('readingVault').get(READING_VAULT_KEY)
      const parsedVault = vault === undefined ? null : OfflineReadingVaultV1Schema.safeParse(vault)
      if (!parsedVault?.success || parsedVault.data.context.keyId !== keyId || parsedVault.data.sessionGeneration !== expectedGeneration)
        throw new OfflineStorageError('generation-fenced', 'The active private vault is unavailable.')
      const entries = await readPrivateEntriesInTransaction(tx, keyId)
      const result: OfflinePrivateEnvelopeV1[] = []
      for (const entry of entries) {
        const parsed = OfflinePrivateEnvelopeV1Schema.safeParse(entry.value)
        if (!parsed.success || !isCanonicalPrivateRecordKey(entry.key, parsed.data))
          throw new OfflineStorageError('metadata-recovery', 'A private offline record is opaque.')
        if (!isSameReadingContext(parsed.data.context, parsedVault.data.context))
          throw new OfflineStorageError('generation-fenced', 'The private offline record belongs to another vault.')
        result.push(clonePrivateEnvelope(parsed.data))
      }
      return await this.finishRead(tx, result)
    } catch (error) {
      throw toFailure(error, 'transaction', 'Private offline records could not be read.')
    }
  }
  async putPrivateRecords(
    envelopes: readonly OfflinePrivateEnvelopeV1[],
    options: OfflineStorageGenerationOptions & {
      readonly expectedRecordRevision?: number | null
      readonly removePrivatePageIds?: readonly number[]
    } = {}
  ): Promise<OfflinePrivateEnvelopeV1[]> {
    this.assertOpen(true)
    if (!Array.isArray(envelopes) || envelopes.length < 1 || envelopes.length > OFFLINE_POLICY_PAGE_LIMIT + 3)
      throw new OfflineStorageError('invalid-record', 'Private offline records are invalid.')
    const parsed = envelopes.map(value => OfflinePrivateEnvelopeV1Schema.parse(value))
    const first = parsed[0]
    if (parsed.some(value => !isSameReadingContext(value.context, first.context) || value.sessionGeneration !== first.sessionGeneration))
      throw new OfflineStorageError('invalid-record', 'Private records do not share one vault.')
    const paired = parsed.some(value => value.kind === 'snapshot' || value.kind === 'search')
    const expectedRecordRevision = options.expectedRecordRevision
    if (paired) {
      if (expectedRecordRevision === undefined)
        throw new OfflineStorageError('invalid-record', 'Private body/search writes require an explicit compare-and-swap revision.')
      if (expectedRecordRevision !== null && (!Number.isSafeInteger(expectedRecordRevision) || expectedRecordRevision < 1))
        throw new OfflineStorageError('invalid-record', 'Private compare-and-swap revision is invalid.')
      const policyRecordCount = parsed.filter(value => value.kind === 'policy-page' || value.kind === 'policy-state').length
      if (parsed.length !== policyRecordCount + 2 || !parsed.some(value => value.kind === 'snapshot') || !parsed.some(value => value.kind === 'search'))
        throw new OfflineStorageError('invalid-record', 'Private body/search records must be committed as a pair.')
      const body = parsed.find(value => value.kind === 'snapshot')
      const search = parsed.find(value => value.kind === 'search')
      if (
        !body ||
        !search ||
        body.pageId !== search.pageId ||
        body.locale !== search.locale ||
        body.pairId !== search.pairId ||
        body.recordRevision !== search.recordRevision
      )
        throw new OfflineStorageError('invalid-record', 'Private body/search records do not match.')
    }
    const policyRecords = parsed.filter(value => value.kind === 'policy-page' || value.kind === 'policy-state')
    if (policyRecords.length > 0) {
      const policyStateRecords = policyRecords.filter(value => value.kind === 'policy-state')
      if (policyStateRecords.length !== 1) throw new OfflineStorageError('invalid-record', 'Private policy state must be unique.')
      const policyPageKeys = new Set<string>()
      for (const value of policyRecords) {
        if (value.recordRevision !== policyRecords[0]!.recordRevision)
          throw new OfflineStorageError('invalid-record', 'Private policy records must share one revision.')
        if (value.kind === 'policy-page') {
          const key = `${value.pageId}\u0000${value.locale}`
          if (policyPageKeys.has(key)) throw new OfflineStorageError('invalid-record', 'Private policy pages must be unique.')
          policyPageKeys.add(key)
        }
      }
    }
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    for (const value of parsed) {
      if (privateEnvelopeLogicalBytes(value) > OFFLINE_PRIVATE_RECORD_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'The encrypted private record exceeds the per-record limit.')
    }
    if (options.readingHandle && (!isCurrentOfflineReadingHandle(options.readingHandle) || !isSameReadingContext(options.readingHandle.context, first.context)))
      throw new OfflineStorageError('generation-fenced', 'The private reading handle is no longer current.')
    if (first.sessionGeneration !== expectedGeneration) throw new OfflineGenerationFencedError(expectedGeneration, first.sessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'readingVault', 'privateRecords'], 'readwrite', { durability: 'strict' }) as OfflineWriteTransaction
      const meta = await this.assertGenerationInTransaction(tx, expectedGeneration)
      if (
        options.expectedCorpusRevision !== undefined &&
        (!Number.isSafeInteger(options.expectedCorpusRevision) || options.expectedCorpusRevision < 0 || meta.corpusRevision !== options.expectedCorpusRevision)
      )
        throw new OfflineGenerationFencedError(options.expectedCorpusRevision ?? -1, meta.corpusRevision)
      const vault = await tx.objectStore('readingVault').get(READING_VAULT_KEY)
      const parsedVault = vault === undefined ? null : OfflineReadingVaultV1Schema.safeParse(vault)
      if (!parsedVault?.success || !isSameReadingContext(parsedVault.data.context, first.context) || parsedVault.data.sessionGeneration !== expectedGeneration)
        throw new OfflineStorageError('generation-fenced', 'The active private vault is unavailable.')
      const existingEntries = await readPrivateEntriesInTransaction(tx)
      const existingPrivateRecords: OfflinePrivateEnvelopeV1[] = []
      for (const entry of existingEntries) {
        const existing = OfflinePrivateEnvelopeV1Schema.safeParse(entry.value)
        if (
          !existing.success ||
          !isCanonicalPrivateRecordKey(entry.key, existing.data) ||
          !isSameReadingContext(existing.data.context, parsedVault.data.context) ||
          existing.data.sessionGeneration !== expectedGeneration
        )
          throw new OfflineStorageError('metadata-recovery', 'A private offline record is opaque.')
        existingPrivateRecords.push(existing.data)
      }
      const store = tx.objectStore('privateRecords')
      let oldBytes = 0
      let oldSnapshots = 0
      if (options.removePrivatePageIds && options.removePrivatePageIds.length > 0) {
        const removePageIds = new Set(options.removePrivatePageIds)
        for (const parsedValue of existingPrivateRecords) {
          if ((parsedValue.kind !== 'snapshot' && parsedValue.kind !== 'search') || parsedValue.pageId === null || !removePageIds.has(parsedValue.pageId))
            continue
          oldBytes = checkedAccountingValue(oldBytes, privateEnvelopeLogicalBytes(parsedValue), 'Private removal bytes')
          if (parsedValue.kind === 'snapshot') oldSnapshots += 1
          await store.delete(privateRecordKey(parsedValue))
        }
      }
      const currentRecords: Array<OfflinePrivateEnvelopeV1 | null> = []
      for (const value of parsed) {
        const currentValue = await store.get(privateRecordKey(value))
        if (currentValue === undefined) {
          currentRecords.push(null)
          continue
        }
        const current = OfflinePrivateEnvelopeV1Schema.safeParse(currentValue)
        if (!current.success) throw new OfflineStorageError('metadata-recovery', 'A private offline record is opaque.')
        currentRecords.push(current.data)
        oldBytes = checkedAccountingValue(oldBytes, privateEnvelopeLogicalBytes(current.data), 'Private record bytes')
        if (current.data.kind === 'snapshot') oldSnapshots += 1
        if (!paired && expectedRecordRevision !== undefined && current.data.recordRevision !== expectedRecordRevision)
          throw new OfflineStorageError('transaction', 'A private record changed before compare-and-swap commit.')
      }
      const nextPolicyState = parsed.find(value => value.kind === 'policy-state')
      if (options.expectedPolicyRevision !== undefined) {
        const currentPolicyValue = await store.get([first.context.keyId, 'policy-state', 0, ''])
        const currentPolicy = currentPolicyValue === undefined ? null : OfflinePrivateEnvelopeV1Schema.safeParse(currentPolicyValue)
        if (options.expectedPolicyRevision === 0) {
          if (currentPolicyValue !== undefined)
            throw new OfflinePolicyRevisionFencedError(0, currentPolicy?.success ? currentPolicy.data.recordRevision - 1 : -1)
        } else if (!currentPolicy?.success || currentPolicy.data.recordRevision !== options.expectedPolicyRevision + 1) {
          throw new OfflinePolicyRevisionFencedError(options.expectedPolicyRevision, currentPolicy?.success ? currentPolicy.data.recordRevision - 1 : -1)
        }
        if (!nextPolicyState || nextPolicyState.recordRevision <= options.expectedPolicyRevision + 1) {
          throw new OfflineStorageError('transaction', 'The encrypted private policy revision did not advance.')
        }
      }
      if (paired) {
        const body = parsed.find(value => value.kind === 'snapshot')!
        const search = parsed.find(value => value.kind === 'search')!
        const bodyIndex = parsed.indexOf(body)
        const searchIndex = parsed.indexOf(search)
        const oldBody = currentRecords[bodyIndex]
        const oldSearch = currentRecords[searchIndex]
        if (expectedRecordRevision === null) {
          if (oldBody !== null || oldSearch !== null) throw new OfflineStorageError('transaction', 'The private body/search pair already exists.')
        } else {
          if (!oldBody || !oldSearch) throw new OfflineStorageError('transaction', 'The existing private body/search pair is incomplete.')
          if (
            oldBody.kind !== 'snapshot' ||
            oldSearch.kind !== 'search' ||
            oldBody.pageId !== body.pageId ||
            oldBody.locale !== body.locale ||
            oldSearch.pageId !== search.pageId ||
            oldSearch.locale !== search.locale ||
            !isSameReadingContext(oldBody.context, first.context) ||
            !isSameReadingContext(oldSearch.context, first.context) ||
            oldBody.sessionGeneration !== expectedGeneration ||
            oldSearch.sessionGeneration !== expectedGeneration ||
            oldBody.pairId !== oldSearch.pairId ||
            oldBody.recordRevision !== oldSearch.recordRevision ||
            oldBody.recordRevision !== expectedRecordRevision
          )
            throw new OfflineStorageError('transaction', 'The existing private body/search pair is inconsistent.')
          if (body.pairId === oldBody.pairId || body.recordRevision <= oldBody.recordRevision)
            throw new OfflineStorageError('transaction', 'The replacement private pair must advance its revision and pair identity.')
        }
      }
      const newBytes = parsed.reduce((total, value) => checkedAccountingValue(total, privateEnvelopeLogicalBytes(value), 'Private record bytes'), 0)
      const newSnapshots = parsed.filter(value => value.kind === 'snapshot').length
      const managedBytesDelta = newBytes - oldBytes
      const snapshotCountDelta = newSnapshots - oldSnapshots
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      const projectedCount = checkedAccountingValue(meta.snapshotCount, snapshotCountDelta, 'Offline snapshot count')
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; private growth is blocked.')
      if (projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT || projectedCount > OFFLINE_SNAPSHOT_LIMIT)
        throw new OfflineStorageError('quota', 'Offline private limits would be exceeded.')
      for (const value of parsed) await store.put(clonePrivateEnvelope(value), privateRecordKey(value))
      const nextMeta = await this.putAccountingDelta(tx, meta, managedBytesDelta, snapshotCountDelta, snapshotCountDelta !== 0)
      await this.finish(tx, undefined)
      notifyPostCommit({ kind: 'corpus', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      return parsed.map(clonePrivateEnvelope)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Private offline records could not be committed.')
    }
  }

  async putPrivatePolicyRecords(
    records: readonly OfflinePrivateEnvelopeV1[],
    options: OfflineStorageGenerationOptions & { readonly removePrivatePageIds?: readonly number[] } = {}
  ): Promise<OfflinePrivateEnvelopeV1[]> {
    return await this.putPrivateRecords(records, options)
  }
  async markPrivatePageIneligible(
    handle: OfflineReadingHandleV1,
    selector: OfflineSnapshotSelector,
    options?: OfflineStorageGenerationOptions
  ): Promise<OfflinePagePolicyRecord>
  async markPrivatePageIneligible(keyId: string, pageId: number, options?: OfflineStorageGenerationOptions): Promise<number>
  async markPrivatePageIneligible(
    keyIdOrHandle: string | OfflineReadingHandleV1,
    pageIdOrSelector: number | OfflineSnapshotSelector,
    options: OfflineStorageGenerationOptions = {}
  ): Promise<number | OfflinePagePolicyRecord> {
    if (typeof keyIdOrHandle !== 'string') {
      const handle = keyIdOrHandle
      const selector = this.assertPrivateSelector(handle, pageIdOrSelector as OfflineSnapshotSelector)
      const next = await this.mutatePrivatePolicy(handle, options, current => {
        const pages = current.pages.map(page =>
          page.pageId === selector.pageId
            ? storePolicyPage({ ...page, automatic: false, automaticSelectedAt: null, lastEditedAt: null, availability: 'ineligible' as const })
            : page
        )
        const currentPage =
          pages.find(page => page.key === offlinePolicyPageKey(selector)) ??
          storePolicyPage({
            ...makePolicyPage(selector),
            availability: 'ineligible' as const
          })
        if (!pages.some(page => page.key === currentPage.key)) pages.push(currentPage)
        return {
          policy: { state: makePolicyState({ ...current.state, policyRevision: current.state.policyRevision + 1 }), pages },
          removePageIds: [selector.pageId]
        }
      })
      return this.privatePageResult(next, selector)
    }
    const keyId = keyIdOrHandle
    const pageId = pageIdOrSelector as number
    this.assertOpen(true)
    if (typeof keyId !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(keyId)) throw new OfflineStorageError('invalid-record', 'Private vault identity is invalid.')
    if (!Number.isSafeInteger(pageId) || pageId < 1) throw new OfflineStorageError('invalid-record', 'Private page identity is invalid.')
    const expectedGeneration = await this.expectedGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'readingVault', 'privateRecords'], 'readwrite', { durability: 'strict' }) as OfflineWriteTransaction
      const meta = await this.assertGenerationInTransaction(tx, expectedGeneration)
      const vault = await tx.objectStore('readingVault').get(READING_VAULT_KEY)
      const parsedVault = vault === undefined ? null : OfflineReadingVaultV1Schema.safeParse(vault)
      if (!parsedVault?.success || parsedVault.data.context.keyId !== keyId || parsedVault.data.sessionGeneration !== expectedGeneration)
        throw new OfflineStorageError('generation-fenced', 'The active private vault is unavailable.')
      const store = tx.objectStore('privateRecords')
      const entries = await readPrivateEntriesInTransaction(tx, keyId)
      let removedBytes = 0
      let removedSnapshots = 0
      let removed = 0
      for (const entry of entries) {
        const parsed = OfflinePrivateEnvelopeV1Schema.safeParse(entry.value)
        if (!parsed.success || !isCanonicalPrivateRecordKey(entry.key, parsed.data))
          throw new OfflineStorageError('metadata-recovery', 'A private offline record is opaque.')
        if (!isSameReadingContext(parsed.data.context, parsedVault.data.context))
          throw new OfflineStorageError('generation-fenced', 'The private offline record belongs to another vault.')
        if (parsed.data.pageId !== pageId) continue
        removedBytes = checkedAccountingValue(removedBytes, privateEnvelopeLogicalBytes(parsed.data), 'Private removal bytes')
        if (parsed.data.kind === 'snapshot') removedSnapshots += 1
        await store.delete(privateRecordKey(parsed.data))
        removed += 1
      }
      const nextMeta = await this.putAccountingDelta(tx, meta, -removedBytes, -removedSnapshots, removed > 0)
      await this.finish(tx, undefined)
      if (removed > 0) notifyPostCommit({ kind: 'corpus', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      return removed
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Private page denial could not be committed.')
    }
  }

  async getPrivateRecords(keyId: string, options: OfflineStorageGenerationOptions = {}): Promise<OfflinePrivateEnvelopeV1[]> {
    return this.listPrivateRecords(keyId, options)
  }

  async clearPrivateRecords(options: OfflineStorageGenerationOptions = {}): Promise<number> {
    lockOfflineReading()
    return this.retireReadingVault(options)
  }

  async privateSnapshotRevision(
    handle: OfflineReadingHandleV1,
    selector: OfflineSnapshotSelector,
    options: OfflineStorageGenerationOptions = {}
  ): Promise<number | null> {
    const parsedSelector = this.assertPrivateSelector(handle, selector)
    const records = await this.listPrivateRecords(handle.context.keyId, {
      expectedSessionGeneration: handle.sessionGeneration,
      expectedCorpusRevision: options.expectedCorpusRevision
    })
    const body = records.find(value => value.kind === 'snapshot' && value.pageId === parsedSelector.pageId && value.locale === parsedSelector.locale)
    return body?.recordRevision ?? null
  }
  async putPrivateSnapshotRecords(
    body: OfflinePrivateEnvelopeV1,
    search: OfflinePrivateEnvelopeV1,
    options: OfflineStorageGenerationOptions & {
      readonly expectedRecordRevision?: number | null
      readonly policyPage?: OfflinePagePolicyRecord
      readonly policyState?: OfflinePolicyState
      readonly removePrivatePageIds?: readonly number[]
    } = {}
  ): Promise<OfflinePrivateEnvelopeV1[]> {
    if (options.readingHandle && options.policyPage && options.policyState) {
      const current = await this.readPrivatePolicy(options.readingHandle, options)
      const pages = current.pages.some(page => page.key === options.policyPage!.key)
        ? current.pages.map(page => (page.key === options.policyPage!.key ? storePolicyPage(options.policyPage!) : page))
        : [...current.pages, storePolicyPage(options.policyPage!)]
      const recordRevision = options.policyState.policyRevision + 1
      const stateEnvelope = await encryptOfflinePrivateRecord(options.readingHandle, 'policy-state', options.policyState, {
        pageId: null,
        locale: null,
        recordRevision,
        pairId: null
      })
      const policyEnvelopes: OfflinePrivateEnvelopeV1[] = [stateEnvelope]
      for (const page of pages) {
        policyEnvelopes.push(
          await encryptOfflinePrivateRecord(options.readingHandle, 'policy-page', page, {
            pageId: page.pageId,
            locale: page.locale,
            recordRevision,
            pairId: null
          })
        )
      }
      return this.putPrivateRecords([body, search, ...policyEnvelopes], options)
    }
    return this.putPrivateRecords([body, search], options)
  }

  async storageStatus(): Promise<OfflineStorageEstimate> {
    return this.storageEstimate()
  }
}

export type OfflineStorageOpenOptions = {
  databaseName?: string
  blockedTimeoutMs?: number
}

const allStoreNames = ['meta', 'snapshots', 'drafts', 'searchDocuments', 'policy', 'readingVault', 'privateRecords'] as const
const createStores = (
  database: IDBPDatabase<OfflineStorageDbSchema>,
  transaction: IDBPTransaction<OfflineStorageDbSchema, StoreNames<OfflineStorageDbSchema>[], 'versionchange'>
): void => {
  if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' })
  if (!database.objectStoreNames.contains('snapshots')) {
    const store = database.createObjectStore('snapshots', { keyPath: ['siteId', 'pageId', 'locale'] })
    store.createIndex('by-site', 'siteId')
  } else {
    const store = transaction.objectStore('snapshots') as unknown as {
      indexNames: { contains(name: string): boolean }
      createIndex(name: string, keyPath: string): unknown
    }
    if (!store.indexNames.contains('by-site')) store.createIndex('by-site', 'siteId')
  }
  if (!database.objectStoreNames.contains('drafts')) {
    const store = database.createObjectStore('drafts', { keyPath: 'recordId' })
    store.createIndex('by-account', 'accountId')
  } else {
    const store = transaction.objectStore('drafts') as unknown as {
      indexNames: { contains(name: string): boolean }
      createIndex(name: string, keyPath: string): unknown
    }
    if (!store.indexNames.contains('by-account')) store.createIndex('by-account', 'accountId')
  }
  if (!database.objectStoreNames.contains('searchDocuments')) {
    const store = database.createObjectStore('searchDocuments', { keyPath: ['siteId', 'pageId', 'locale'] })
    store.createIndex('by-site', 'siteId')
  } else {
    const store = transaction.objectStore('searchDocuments') as unknown as {
      indexNames: { contains(name: string): boolean }
      createIndex(name: string, keyPath: string): unknown
    }
    if (!store.indexNames.contains('by-site')) store.createIndex('by-site', 'siteId')
  }
  if (!database.objectStoreNames.contains('policy')) {
    const store = database.createObjectStore('policy', { keyPath: 'key' })
    store.createIndex('by-type', 'recordType')
    store.createIndex('by-page', 'pageId')
  } else {
    const store = transaction.objectStore('policy') as unknown as {
      indexNames: { contains(name: string): boolean }
      createIndex(name: string, keyPath: string): unknown
    }
    if (!store.indexNames.contains('by-type')) store.createIndex('by-type', 'recordType')
    if (!store.indexNames.contains('by-page')) store.createIndex('by-page', 'pageId')
  }
  if (!database.objectStoreNames.contains('readingVault')) database.createObjectStore('readingVault')
  if (!database.objectStoreNames.contains('privateRecords')) {
    const store = database.createObjectStore('privateRecords')
    store.createIndex('by-vault', 'context.keyId')
    store.createIndex('by-kind', 'kind')
    store.createIndex('by-page', 'pageId')
  } else {
    const store = transaction.objectStore('privateRecords') as unknown as {
      indexNames: { contains(name: string): boolean }
      createIndex(name: string, keyPath: string): unknown
    }
    if (!store.indexNames.contains('by-vault')) store.createIndex('by-vault', 'context.keyId')
    if (!store.indexNames.contains('by-kind')) store.createIndex('by-kind', 'kind')
    if (!store.indexNames.contains('by-page')) store.createIndex('by-page', 'pageId')
  }
}

const migratePolicyRecords = async (tx: OfflineWriteTransaction, storage: OfflineStorage, snapshots: readonly unknown[]): Promise<void> => {
  const policyStore = tx.objectStore('policy')
  const rawState = await policyStore.get(OFFLINE_POLICY_STATE_KEY)
  if (rawState === undefined) {
    await policyStore.put(makePolicyState())
  } else {
    const parsedState = OfflinePolicyStateSchema.safeParse(rawState)
    if (!parsedState.success) {
      if (isObject(rawState) && typeof rawState.schemaVersion === 'number' && rawState.schemaVersion > OFFLINE_POLICY_SCHEMA_VERSION)
        storage.markUnsupportedSchema()
      else storage.markMetadataRecovery('invalid')
      return
    }
    if (parsedState.data.automaticSavingDefaultApplied !== true) {
      await policyStore.put(
        makePolicyState({
          ...parsedState.data,
          automaticSavingEnabled: true,
          automaticSavingDefaultApplied: true,
          policyRevision: checkedAccountingValue(parsedState.data.policyRevision, 1, 'Offline policy revision')
        })
      )
    }
  }
  const existingValues = await policyStore.index('by-type').getAll('page')
  const existingKeys = new Set<string>()
  for (const value of existingValues) {
    const parsed = parsePolicyPage(value)
    if (!parsed) {
      if (isObject(value) && typeof value.schemaVersion === 'number' && value.schemaVersion > OFFLINE_POLICY_SCHEMA_VERSION) storage.markUnsupportedSchema()
      else storage.markMetadataRecovery('invalid')
      continue
    }
    existingKeys.add(parsed.key)
    if (!isObject(value) || !Object.hasOwn(value, 'lastEditedAt')) await policyStore.put(storePolicyPage(parsed))
  }
  if (storage.hasUnsupportedSchema || storage.requiresMetadataRecovery) return
  for (const value of snapshots) {
    const parsedSnapshot = OfflineSnapshotRecordSchema.safeParse(value)
    if (!parsedSnapshot.success) continue
    const selector: OfflineSnapshotSelector = {
      siteId: parsedSnapshot.data.siteId,
      pageId: parsedSnapshot.data.pageId,
      locale: parsedSnapshot.data.locale
    }
    const key = offlinePolicyPageKey(selector)
    if (existingKeys.has(key)) continue
    const page = makePolicyPage(selector, { manual: true, availability: 'available' })
    await policyStore.put(page)
    existingKeys.add(key)
  }
}

const migrateMetadata = async (db: IDBPDatabase<OfflineStorageDbSchema>, storage: OfflineStorage): Promise<void> => {
  const tx = db.transaction(allStoreNames, 'readwrite', { durability: 'strict' }) as OfflineWriteTransaction
  try {
    const rawMeta = await tx.objectStore('meta').get(META_KEY)
    const parsed = OfflineMetaRecordSchema.safeParse(rawMeta)
    if (parsed.success) {
      if (parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION) {
        storage.markUnsupportedSchema()
      } else {
        const snapshots = await tx.objectStore('snapshots').getAll()
        await migratePolicyRecords(tx, storage, snapshots)
        if (!storage.hasUnsupportedSchema && !storage.requiresMetadataRecovery) {
          const accounting = await recountAccountingInTransaction(tx)
          await tx.objectStore('meta').put({
            ...parsed.data,
            managedBytes: accounting.managedBytes,
            snapshotCount: accounting.snapshotCount,
            accountingComplete: accounting.complete
          })
        }
      }
      await tx.done
      return
    }
    if (isObject(rawMeta) && typeof rawMeta.schemaVersion === 'number' && rawMeta.schemaVersion > OFFLINE_SCHEMA_VERSION) {
      storage.markUnsupportedSchema()
      await tx.done
      return
    }
    if (rawMeta === undefined) {
      const counts = await Promise.all(allStoreNames.map(name => tx.objectStore(name).count()))
      const populated = counts.some(count => count > 0)
      if (populated) {
        storage.markMetadataRecovery('missing')
        await tx.done
        return
      }
      const policy = makePolicyState()
      await tx.objectStore('meta').put(defaultMeta())
      await tx.objectStore('policy').put(policy)
      await tx.done
      return
    }
    const legacy = safeLegacyMeta(rawMeta)
    if (!legacy) {
      storage.markMetadataRecovery('invalid')
      await tx.done
      return
    }
    const snapshots = await tx.objectStore('snapshots').getAll()
    await migratePolicyRecords(tx, storage, snapshots)
    if (!storage.hasUnsupportedSchema && !storage.requiresMetadataRecovery) {
      const accounting = await recountAccountingInTransaction(tx)
      await tx.objectStore('meta').put({
        key: META_KEY,
        schemaVersion: OFFLINE_SCHEMA_VERSION,
        sessionGeneration: checkedAccountingValue(legacy.sessionGeneration, 1, 'Offline session generation'),
        managedBytes: accounting.managedBytes,
        snapshotCount: accounting.snapshotCount,
        corpusRevision: 1,
        accountingComplete: accounting.complete,
        lastCleanupAt: legacy.lastCleanupAt,
        storage: legacy.storage
      })
    }
    await tx.done
  } catch (error) {
    try {
      tx.abort()
    } catch {
      // Ignore an already completed upgrade transaction.
    }
    try {
      await tx.done
    } catch {
      // Preserve the original migration error.
    }
    throw toFailure(error, 'transaction', 'Offline metadata could not be initialized.')
  }
}

export const openOfflineStorage = async (options: OfflineStorageOpenOptions = {}): Promise<OfflineStorage> => {
  const databaseName = options.databaseName ?? OFFLINE_DB_NAME
  const timeoutMs = options.blockedTimeoutMs ?? 5000
  let rejectBlocked: ((error: OfflineStorageError) => void) | undefined
  let blockedTimer: ReturnType<typeof setTimeout> | undefined
  let failed = false
  let activeStorage: OfflineStorage | undefined
  const blocked = new Promise<never>((_resolve, reject) => {
    rejectBlocked = reject
    blockedTimer = setTimeout(() => {
      failed = true
      reject(new OfflineStorageError('blocked-upgrade', 'Another offline database connection blocked the schema upgrade.'))
    }, timeoutMs)
  })
  const opened = openDB<OfflineStorageDbSchema>(databaseName, OFFLINE_DB_VERSION, {
    upgrade(database, oldVersion, _newVersion, transaction) {
      if (oldVersion > OFFLINE_DB_VERSION) throw new OfflineStorageError('unsupported-schema', 'A newer offline database schema is present.')
      createStores(database, transaction)
      if (oldVersion === 0) {
        transaction.objectStore('meta').put(defaultMeta())
      } else if (oldVersion < OFFLINE_DB_VERSION) {
        const snapshots = transaction.objectStore('snapshots')
        const searches = transaction.objectStore('searchDocuments')
        const policy = transaction.objectStore('policy')
        const meta = transaction.objectStore('meta')
        const request = unwrap(meta).get(META_KEY)
        request.onsuccess = () => {
          const rawMeta = request.result
          const parsed = OfflineMetaRecordSchema.safeParse(rawMeta)
          const legacy = safeLegacyMeta(rawMeta)
          // Never purge or advance a database whose metadata belongs to a future
          // or otherwise unknown schema. migrateMetadata marks it unsupported
          // after the versionchange transaction completes.
          if ((parsed.success && parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION) || (!parsed.success && legacy === null)) return
          snapshots.clear()
          searches.clear()
          policy.clear()
          policy.put(makePolicyState())
          if (!parsed.success) return
          meta.put({
            ...parsed.data,
            sessionGeneration: checkedAccountingValue(parsed.data.sessionGeneration, 1, 'Offline session generation'),
            managedBytes: 0,
            snapshotCount: 0,
            corpusRevision: checkedAccountingValue(parsed.data.corpusRevision, 1, 'Offline corpus revision'),
            accountingComplete: true
          })
        }
      }
    },
    blocked() {
      failed = true
      rejectBlocked?.(new OfflineStorageError('blocked-upgrade', 'Another offline database connection blocked the schema upgrade.'))
    },
    blocking() {
      activeStorage?.close()
    },
    terminated() {
      activeStorage?.markTerminated()
    }
  })
  opened
    .then(db => {
      if (failed) db.close()
    })
    .catch(() => {
      // The raced promise below reports the open failure.
    })
  let db: IDBPDatabase<OfflineStorageDbSchema>
  try {
    db = await Promise.race([opened, blocked])
  } catch (error) {
    failed = true
    clearTimeout(blockedTimer)
    throw toFailure(error, 'transaction', 'Offline storage could not be opened.')
  }
  clearTimeout(blockedTimer)
  const storage = new OfflineStorage(db)
  activeStorage = storage
  db.onversionchange = () => storage.close()
  try {
    await migrateMetadata(db, storage)
  } catch (error) {
    storage.close()
    throw toFailure(error, 'transaction', 'Offline metadata could not be initialized.')
  }
  return storage
}

export type { OfflineStorageDbSchema }
