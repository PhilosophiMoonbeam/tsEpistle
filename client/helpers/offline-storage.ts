import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb'
import {
  OfflineDraftEnvelopeV1Schema,
  OfflineMetaRecordSchema,
  OfflinePageSnapshotV1Schema,
  OfflineSearchDocumentV1Schema,
  OfflineSnapshotRecordSchema,
  OfflineSnapshotSelectorSchema,
  OfflineStorageEstimateSchema,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_MANAGED_BYTES_LIMIT,
  OFFLINE_RECORD_BYTES_LIMIT,
  OFFLINE_SCHEMA_VERSION,
  OFFLINE_SNAPSHOT_LIMIT,
  OfflineCorpusNoticeSchema,
  type OfflineDraftEnvelopeV1,
  type OfflineCorpusNotice,
  type OfflineMetaRecord,
  type OfflineStorageFailureCode,
  type OfflinePageSnapshotV1,
  type OfflineSearchDocumentV1,
  type OfflineSnapshotCorpus,
  type OfflineSnapshotRecord,
  type OfflineSnapshotSelector,
  type OfflineStorageEstimate
} from '../../shared/offline.ts'

const META_KEY = 'state' as const
const CORPUS_CHANNEL = `${OFFLINE_DB_NAME}:changes`
const now = (): string => new Date().toISOString()

type SnapshotKey = [siteId: string, pageId: number, locale: string]
type SearchDocumentKey = SnapshotKey

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
}

export type OfflineStorageGenerationOptions = {
  expectedSessionGeneration?: number
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
}

export type OfflineSnapshotOpenOptions = OfflineStorageGenerationOptions

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

const ensureCorpusChannel = (): BroadcastChannel | null => {
  if (corpusChannel || typeof BroadcastChannel === 'undefined') return corpusChannel
  corpusChannel = new BroadcastChannel(CORPUS_CHANNEL)
  corpusChannel.onmessage = event => {
    const parsed = OfflineCorpusNoticeSchema.safeParse(event.data)
    if (!parsed.success) return
    for (const listener of listeners) listener(parsed.data)
  }
  return corpusChannel
}

export const subscribeOfflineStorageChanges = (listener: OfflineStorageNoticeListener): (() => void) => {
  listeners.add(listener)
  ensureCorpusChannel()
  return () => listeners.delete(listener)
}

const notifyPostCommit = (notice: OfflineCorpusNotice): void => {
  for (const listener of listeners) listener(notice)
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
  complete: boolean
}

const recountAccountingInTransaction = async (tx: OfflineTransaction): Promise<Accounting> => {
  const snapshots = await tx.objectStore('snapshots').getAll()
  const searches = await tx.objectStore('searchDocuments').getAll()
  const drafts = await tx.objectStore('drafts').getAll()
  let managedBytes = 0
  let snapshotCount = 0
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
  return { managedBytes, snapshotCount, complete }
}

const checkedAccountingValue = (value: number, delta: number, label: string): number => {
  if (!Number.isSafeInteger(delta)) throw new OfflineStorageError('transaction', `${label} delta is not a safe integer.`)
  const next = value + delta
  if (!Number.isSafeInteger(next) || next < 0) throw new OfflineStorageError('transaction', `${label} overflowed.`)
  return next
}


const snapshotPageRange = (siteId: string, pageId: number): IDBKeyRange =>
  IDBKeyRange.bound([siteId, pageId, ''], [siteId, pageId, '\uffff'])

const snapshotSelectionRange = (siteId: string, pageId: number, locale?: string): IDBKeyRange =>
  locale === undefined ? snapshotPageRange(siteId, pageId) : IDBKeyRange.only([siteId, pageId, locale])

const safeLegacyMeta = (value: unknown): {
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
  const safeNullable = (candidate: unknown): number | null => (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null)
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
      throw new OfflineStorageError('unsupported-schema', write ? 'A newer offline database schema is present; writes are disabled.' : 'The offline database schema is not understood.')
    if (write && this.metadataRecovery)
      throw new OfflineStorageError('metadata-recovery', 'Offline metadata requires recovery before it can be changed.')
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

  async currentSessionGeneration(): Promise<number> {
    return (await this.readMeta()).sessionGeneration
  }

  async bumpSessionGeneration(nextGeneration?: number, options: OfflineStorageGenerationOptions = {}): Promise<number> {
    this.assertOpen(true)
    const expected = options.expectedSessionGeneration === undefined ? undefined : validateGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction('meta', 'readwrite', { durability: 'strict' }) as OfflineWriteTransaction
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
      await metaStore.put({ ...parsed.data, sessionGeneration: candidate })
      await this.finish(tx, candidate)
      notifyPostCommit({ kind: 'generation', sessionGeneration: candidate, corpusRevision: parsed.data.corpusRevision })
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
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    const candidate = makeSnapshotRecord(validatedSiteId, parsedSnapshot, now())
    const search = makeSearchDocument(validatedSiteId, parsedSnapshot)
    const candidateBytes = snapshotLogicalBytes(candidate) + searchLogicalBytes(search)
    if (candidate.byteSize > OFFLINE_RECORD_BYTES_LIMIT || search.byteSize > OFFLINE_RECORD_BYTES_LIMIT)
      throw new OfflineStorageError('quota', 'The offline snapshot exceeds the per-record limit.')
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'snapshots', 'searchDocuments'], 'readwrite')
      const meta = await this.assertGenerationInTransaction(tx, expected)
      const snapshotsStore = tx.objectStore('snapshots')
      const searchStore = tx.objectStore('searchDocuments')
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
      const managedBytesDelta = candidateBytes - oldBytes
      const snapshotCountDelta = 1 - oldSnapshotCount
      if (!accountingComplete && (managedBytesDelta > 0 || snapshotCountDelta > 0))
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; clean up opaque records before adding data.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      const projectedCount = checkedAccountingValue(meta.snapshotCount, snapshotCountDelta, 'Offline snapshot count')
      if (projectedCount > OFFLINE_SNAPSHOT_LIMIT || projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT) {
        options.onEvictionWarning?.(meta.snapshotCount)
        throw new OfflineStorageError('quota', 'Offline snapshot limits would be exceeded; no records were evicted.')
      }
      for (const key of oldSnapshotKeys) await snapshotsStore.delete(key)
      for (const key of oldSearchKeys) await searchStore.delete(key)
      await snapshotsStore.put(candidate)
      await searchStore.put(search)
      const nextMeta = await this.putAccountingDelta(tx, meta, managedBytesDelta, snapshotCountDelta, true, accountingComplete)
      await this.finish(tx, candidate)
      notifyPostCommit({ kind: 'corpus', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      return cloneSnapshot(candidate)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The offline snapshot could not be committed.')
    }
  }

  async removeSnapshot(siteId: string, pageId: number, locale?: string, options: OfflineStorageGenerationOptions = {}): Promise<void> {
    this.assertOpen(true)
    const validatedSiteId = validateSiteId(siteId)
    const validatedPageId = validatePageId(pageId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'snapshots', 'searchDocuments'], 'readwrite')
      const meta = await this.assertGenerationInTransaction(tx, expected)
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
      const nextMeta = changed
        ? await this.putAccountingDelta(tx, meta, -removedBytes, -removedSnapshotCount, true, accountingComplete)
        : meta
      await this.finish(tx, undefined)
      if (changed) notifyPostCommit({ kind: 'corpus', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The offline snapshot could not be removed.')
    }
  }

  async readSnapshotCorpus(options: OfflineStorageGenerationOptions = {}): Promise<OfflineSnapshotCorpus> {
    this.assertOpen(false)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    try {
      const tx = this.db.transaction(['meta', 'snapshots'], 'readonly')
      const meta = await this.assertGenerationInTransaction(tx, expected)
      const values = await tx.objectStore('snapshots').getAll()
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
    return corpus.snapshots.filter(record => validatedSiteId === undefined || record.siteId === validatedSiteId).map(cloneSnapshot)
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

  async searchDocuments(siteId: string, query = '', options: OfflineStorageGenerationOptions = {}): Promise<OfflineSearchDocumentV1[]> {
    this.assertOpen(false)
    const validatedSiteId = validateSiteId(siteId)
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
      return records.filter(record => normalizeSearchText(`${record.title} ${record.description} ${record.searchText} ${record.path} ${record.canonicalPath}`).includes(normalizedQuery))
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
      if (existingValue !== undefined && !existing?.success) throw new OfflineDraftConflictError(parsed.recordId, 'The existing draft is opaque and can only be removed by raw key.')
      if (existing?.success && existing.data.sessionGeneration !== expected)
        throw new OfflineGenerationFencedError(expected, existing.data.sessionGeneration)
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
      if (projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT) throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded; no draft was evicted.')
      await store.put(cloneEnvelope(parsed))
      await this.putAccountingDelta(tx, meta, managedBytesDelta, 0, false)
      await this.finish(tx, undefined)
      return cloneEnvelope(parsed)
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'The encrypted draft envelope could not be committed.')
    }
  }

  async rewrapSubmission(expectedEnvelope: OfflineDraftEnvelopeV1, replacementEnvelope: OfflineDraftEnvelopeV1, options: OfflineStorageGenerationOptions = {}): Promise<OfflineDraftEnvelopeV1> {
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
    if (replacementParsed.sessionGeneration !== expectedGeneration) throw new OfflineGenerationFencedError(expectedGeneration, replacementParsed.sessionGeneration)
    return await this.replaceExactEnvelope(expectedParsed, replacementParsed, expectedGeneration, 'The immutable submission could not be rewrapped.')
  }

  async recoverOrdinaryDraft(expectedEnvelope: OfflineDraftEnvelopeV1, replacementEnvelope: OfflineDraftEnvelopeV1, options: OfflineStorageGenerationOptions = {}): Promise<OfflineDraftEnvelopeV1> {
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
    if (replacementParsed.sessionGeneration !== expectedGeneration) throw new OfflineGenerationFencedError(expectedGeneration, replacementParsed.sessionGeneration)
    return await this.replaceExactEnvelope(expectedParsed, replacementParsed, expectedGeneration, 'The ordinary draft could not be recovered.')
  }

  private async replaceExactEnvelope(expectedEnvelope: OfflineDraftEnvelopeV1, replacementEnvelope: OfflineDraftEnvelopeV1, expectedGeneration: number, failureMessage: string): Promise<OfflineDraftEnvelopeV1> {
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
      if (projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT) throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
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
      if (options.expectedDraftRevision !== undefined && existing.data.draftRevision !== options.expectedDraftRevision) throw new OfflineDraftConflictError(validatedRecordId)
      if (options.expectedSubmissionId !== undefined && existing.data.submissionId !== options.expectedSubmissionId) throw new OfflineDraftConflictError(validatedRecordId)
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
    this.assertOpen(true)
    const validatedAccountId = validateAccountId(accountId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'drafts'], 'readwrite', { durability: 'strict' })
      const meta = await this.assertGenerationInTransaction(tx, expected)
      const store = tx.objectStore('drafts')
      const values = await store.getAll()
      let deletedCount = 0
      let preservedOpaqueCount = 0
      let preservedReceiptCount = 0
      let removedBytes = 0
      let accountingComplete = meta.accountingComplete
      for (const value of values) {
        const parsed = OfflineDraftEnvelopeV1Schema.safeParse(value)
        if (!parsed.success) {
          preservedOpaqueCount += 1
          accountingComplete = false
          continue
        }
        if (parsed.data.accountId !== validatedAccountId) continue
        if (parsed.data.submissionId === null) {
          removedBytes = checkedAccountingValue(removedBytes, logicalEnvelopeBytes(parsed.data), 'Offline invalidation bytes')
          await store.delete(parsed.data.recordId)
          deletedCount += 1
        } else preservedReceiptCount += 1
      }
      const nextGeneration = checkedAccountingValue(meta.sessionGeneration, 1, 'Session generation')
      const nextMeta = await this.putAccountingDelta(
        tx,
        { ...meta, sessionGeneration: nextGeneration },
        -removedBytes,
        0,
        false,
        accountingComplete,
        now()
      )
      await this.finish(tx, undefined)
      notifyPostCommit({ kind: 'generation', sessionGeneration: nextMeta.sessionGeneration, corpusRevision: nextMeta.corpusRevision })
      return { sessionGeneration: nextGeneration, deletedCount, preservedOpaqueCount, preservedReceiptCount }
    } catch (error) {
      await this.abort(tx)
      throw toFailure(error, 'transaction', 'Account session invalidation could not be committed.')
    }
  }

  async clearDeviceData(options: OfflineStorageGenerationOptions = {}): Promise<number> {
    this.assertOpen(true)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'snapshots', 'drafts', 'searchDocuments'], 'readwrite', { durability: 'strict' })
      const meta = await this.assertGenerationInTransaction(tx, expected)
      await tx.objectStore('snapshots').clear()
      await tx.objectStore('searchDocuments').clear()
      await tx.objectStore('drafts').clear()
      const nextGeneration = meta.sessionGeneration + 1
      const nextCorpusRevision = meta.corpusRevision + 1
      if (!Number.isSafeInteger(nextGeneration) || !Number.isSafeInteger(nextCorpusRevision)) throw new OfflineStorageError('generation-fenced', 'Offline generation or corpus revision overflowed.')
      const nextMeta: OfflineMetaRecord = {
        ...meta,
        sessionGeneration: nextGeneration,
        managedBytes: 0,
        snapshotCount: 0,
        corpusRevision: nextCorpusRevision,
        accountingComplete: true,
        lastCleanupAt: now()
      }
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
    if (expectedSurvivingFork && (
      expectedSurvivingFork.recordId === expectedReceipt.recordId ||
      expectedSurvivingFork.recordId === expectedSource?.recordId
    )) {
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
      const oldBytes =
        logicalEnvelopeBytes(receipt.data) +
        (source ? logicalEnvelopeBytes(source) : 0) +
        (oldFork ? logicalEnvelopeBytes(oldFork) : 0)
      const newBytes = survivingFork ? logicalEnvelopeBytes(survivingFork) : 0
      const managedBytesDelta = newBytes - oldBytes
      if (!meta.accountingComplete && managedBytesDelta > 0)
        throw new OfflineStorageError('quota', 'Offline accounting is incomplete; finalization cannot add a fork.')
      const projectedBytes = checkedAccountingValue(meta.managedBytes, managedBytesDelta, 'Offline managed bytes')
      if (projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT) throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded.')
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
      await tx.objectStore('meta').put({ ...parsed, storage: { ...parsed.storage, usageBytes: estimate.usageBytes, quotaBytes: estimate.quotaBytes, persisted, persistenceRequested: true } })
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
      const tx = this.db.transaction(['meta', 'drafts'], 'readonly')
      const committedMeta = await this.assertGenerationInTransaction(tx, meta.sessionGeneration)
      const lockedDraftCount = await tx.objectStore('drafts').count()
      await this.finishRead(tx, undefined)
      const result = {
        usageBytes: estimate.usageBytes ?? committedMeta.storage.usageBytes,
        quotaBytes: estimate.quotaBytes ?? committedMeta.storage.quotaBytes,
        persisted: persisted ?? committedMeta.storage.persisted,
        managedBytes: committedMeta.managedBytes,
        snapshotCount: committedMeta.snapshotCount,
        lockedDraftCount,
        schemaVersion: committedMeta.schemaVersion,
        sessionGeneration: committedMeta.sessionGeneration
      }
      return OfflineStorageEstimateSchema.parse(result)
    } catch (error) {
      throw toFailure(error, 'transaction', 'Offline storage estimate could not be read.')
    }
  }

  async storageStatus(): Promise<OfflineStorageEstimate> {
    return this.storageEstimate()
  }
}

export type OfflineStorageOpenOptions = {
  databaseName?: string
  blockedTimeoutMs?: number
}

const allStoreNames = ['meta', 'snapshots', 'drafts', 'searchDocuments'] as const
const createStores = (database: IDBPDatabase<OfflineStorageDbSchema>, transaction: IDBPTransaction<OfflineStorageDbSchema, StoreNames<OfflineStorageDbSchema>[], 'versionchange'>): void => {
  if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' })
  if (!database.objectStoreNames.contains('snapshots')) {
    const store = database.createObjectStore('snapshots', { keyPath: ['siteId', 'pageId', 'locale'] })
    store.createIndex('by-site', 'siteId')
  } else {
    const store = transaction.objectStore('snapshots') as unknown as { indexNames: { contains(name: string): boolean }; createIndex(name: string, keyPath: string): unknown }
    if (!store.indexNames.contains('by-site')) store.createIndex('by-site', 'siteId')
  }
  if (!database.objectStoreNames.contains('drafts')) {
    const store = database.createObjectStore('drafts', { keyPath: 'recordId' })
    store.createIndex('by-account', 'accountId')
  } else {
    const store = transaction.objectStore('drafts') as unknown as { indexNames: { contains(name: string): boolean }; createIndex(name: string, keyPath: string): unknown }
    if (!store.indexNames.contains('by-account')) store.createIndex('by-account', 'accountId')
  }
  if (!database.objectStoreNames.contains('searchDocuments')) {
    const store = database.createObjectStore('searchDocuments', { keyPath: ['siteId', 'pageId', 'locale'] })
    store.createIndex('by-site', 'siteId')
  } else {
    const store = transaction.objectStore('searchDocuments') as unknown as { indexNames: { contains(name: string): boolean }; createIndex(name: string, keyPath: string): unknown }
    if (!store.indexNames.contains('by-site')) store.createIndex('by-site', 'siteId')
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
      } else if (!parsed.data.accountingComplete) {
        const accounting = await recountAccountingInTransaction(tx)
        await tx.objectStore('meta').put({
          ...parsed.data,
          managedBytes: accounting.managedBytes,
          snapshotCount: accounting.snapshotCount,
          accountingComplete: accounting.complete
        })
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
      await tx.objectStore('meta').put(defaultMeta())
      await tx.done
      return
    }
    const legacy = safeLegacyMeta(rawMeta)
    if (!legacy) {
      storage.markMetadataRecovery('invalid')
      await tx.done
      return
    }
    const accounting = await recountAccountingInTransaction(tx)
    await tx.objectStore('meta').put({
      key: META_KEY,
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      sessionGeneration: legacy.sessionGeneration,
      managedBytes: accounting.managedBytes,
      snapshotCount: accounting.snapshotCount,
      corpusRevision: 0,
      accountingComplete: accounting.complete,
      lastCleanupAt: legacy.lastCleanupAt,
      storage: legacy.storage
    })
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
      if (oldVersion === 0) transaction.objectStore('meta').put(defaultMeta())
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
  opened.then(db => {
    if (failed) db.close()
  }).catch(() => {
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
