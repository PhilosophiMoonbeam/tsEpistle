import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction } from 'idb'
import {
  OfflineDraftEnvelopeV1Schema,
  OfflineMetaRecordSchema,
  OfflinePageSnapshotV1Schema,
  OfflineSearchDocumentV1Schema,
  OfflineSnapshotRecordSchema,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_MANAGED_BYTES_LIMIT,
  OFFLINE_RECORD_BYTES_LIMIT,
  OFFLINE_SCHEMA_VERSION,
  OFFLINE_SNAPSHOT_LIMIT,
  type OfflineDraftEnvelopeV1,
  type OfflineMetaRecord,
  type OfflinePageSnapshotV1,
  type OfflineSearchDocumentV1,
  type OfflineSnapshotRecord,
  type OfflineStorageEstimate
} from '../../shared/offline.ts'

const META_KEY = 'state' as const
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
  /** The current revision, or null when this is an insert-only CAS. */
  expectedDraftRevision?: number | null
  /** The current opaque submission selector, or null when none is expected. */
  expectedSubmissionId?: string | null
}

export type OfflineDraftDeleteOptions = OfflineStorageGenerationOptions & {
  expectedDraftRevision?: number
  expectedSubmissionId?: string | null
}

export type OfflineSnapshotWriteOptions = OfflineStorageGenerationOptions & {
  onEvictionWarning?: (candidateCount: number) => void
}

export type OfflinePurgeResult = {
  deletedRecordIds: string[]
  preservedRecordIds: string[]
}

export class OfflineStorageError extends Error {
  readonly code: string
  readonly cause: unknown

  constructor(code: string, message: string, cause?: unknown) {
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
  lastCleanupAt: null,
  storage: {
    usageBytes: null,
    quotaBytes: null,
    persisted: null,
    persistenceRequested: false
  }
})

const isUint8Array = (value: unknown): value is Uint8Array => value instanceof Uint8Array

const jsonReplacer = (_key: string, value: unknown): unknown => (isUint8Array(value) ? Array.from(value) : value)

const serializedBytes = (value: unknown): number => {
  try {
    const serialized = JSON.stringify(value, jsonReplacer)
    if (serialized === undefined) throw new Error('Value cannot be serialized.')
    return new TextEncoder().encode(serialized).byteLength
  } catch (error) {
    throw new OfflineStorageError('serialization', 'The offline record could not be serialized.', error)
  }
}

const cloneEnvelope = (envelope: OfflineDraftEnvelopeV1): OfflineDraftEnvelopeV1 => ({
  ...envelope,
  nonce: new Uint8Array(envelope.nonce),
  ciphertext: new Uint8Array(envelope.ciphertext)
})

const normalizeSearchText = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/gu, ' ')

const snapshotKey = (record: OfflineSnapshotRecord): SnapshotKey => [record.siteId, record.pageId, record.locale]
const searchDocumentKey = (record: OfflineSearchDocumentV1): SearchDocumentKey => [record.siteId, record.pageId, record.locale]

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

const toFailure = (error: unknown, fallbackCode: string, fallbackMessage: string): OfflineStorageError => {
  if (error instanceof OfflineStorageError) return error
  const name = error instanceof DOMException ? error.name : ''
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
  return OfflineSearchDocumentV1Schema.parse({ ...withoutSize, byteSize: serializedBytes(withoutSize) })
}

const makeSnapshotRecord = (siteId: string, snapshot: OfflinePageSnapshotV1, openedAt: string): OfflineSnapshotRecord => {
  const parsedSnapshot = OfflinePageSnapshotV1Schema.parse(snapshot)
  const withoutSize = { siteId, pageId: parsedSnapshot.pageId, locale: parsedSnapshot.locale, snapshot: parsedSnapshot, lastOpenedAt: openedAt }
  return OfflineSnapshotRecordSchema.parse({ ...withoutSize, byteSize: serializedBytes(withoutSize) })
}

const isSameSubmission = (left: OfflineDraftEnvelopeV1, right: OfflineDraftEnvelopeV1): boolean =>
  left.recordId === right.recordId &&
  left.sessionGeneration === right.sessionGeneration &&
  left.draftRevision === right.draftRevision &&
  left.submissionId === right.submissionId

type OfflineTransaction = IDBPTransaction<OfflineStorageDbSchema, ['meta', 'snapshots', 'drafts', 'searchDocuments'], IDBTransactionMode>
type OfflineWriteTransaction = IDBPTransaction<OfflineStorageDbSchema, ['meta', 'snapshots', 'drafts', 'searchDocuments'], 'readwrite'>

export class OfflineStorage {
  private readonly db: IDBPDatabase<OfflineStorageDbSchema>
  private closed = false
  private unsupportedSchema = false

  constructor(db: IDBPDatabase<OfflineStorageDbSchema>) {
    this.db = db
  }

  get isClosed(): boolean {
    return this.closed
  }

  get hasUnsupportedSchema(): boolean {
    return this.unsupportedSchema
  }

  close(): void {
    this.closed = true
    this.db.close()
  }

  private assertOpen(write: boolean): void {
    if (this.closed) throw new OfflineStorageError('closed', 'Offline storage is closed.')
    if (this.unsupportedSchema) {
      throw new OfflineStorageError(
        'unsupported-schema',
        write ? 'A newer offline database schema is present; writes are disabled.' : 'The offline database schema is not understood.'
      )
    }
  }

  private async readMeta(): Promise<OfflineMetaRecord> {
    this.assertOpen(false)
    try {
      const value = await this.db.get('meta', META_KEY)
      const parsed = OfflineMetaRecordSchema.safeParse(value)
      if (!parsed.success || parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION) {
        this.unsupportedSchema = true
        throw new OfflineStorageError('unsupported-schema', 'A newer offline database schema is present; writes are disabled.')
      }
      if (!parsed.success) throw new OfflineStorageError('invalid-record', 'Offline metadata is invalid.')
      return parsed.data
    } catch (error) {
      throw toFailure(error, 'transaction', 'Offline metadata could not be read.')
    }
  }

  private async readMetaInTransaction(tx: OfflineTransaction): Promise<OfflineMetaRecord> {
    const value = await tx.objectStore('meta').get(META_KEY)
    const parsed = OfflineMetaRecordSchema.safeParse(value)
    if (!parsed.success || parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION) {
      this.unsupportedSchema = true
      throw new OfflineStorageError('unsupported-schema', 'A newer offline database schema is present; writes are disabled.')
    }
    return parsed.data
  }

  private async assertGenerationInTransaction(tx: OfflineTransaction, expectedGeneration: number): Promise<OfflineMetaRecord> {
    const meta = await this.readMetaInTransaction(tx)
    if (meta.sessionGeneration !== expectedGeneration) throw new OfflineGenerationFencedError(expectedGeneration, meta.sessionGeneration)
    return meta
  }

  private async expectedGeneration(value: number | undefined): Promise<number> {
    return value === undefined ? this.currentSessionGeneration() : validateGeneration(value)
  }

  private async finish<T>(tx: OfflineWriteTransaction, result: T): Promise<T> {
    try {
      await tx.done
      return result
    } catch (error) {
      throw toFailure(error, 'transaction', 'The offline transaction did not commit.')
    }
  }

  private abort(tx: OfflineWriteTransaction | undefined): void {
    if (!tx) return
    try {
      tx.abort()
    } catch {
      // A completed transaction cannot be aborted; its completion already decided the result.
    }
  }

  private async managedBytes(tx: OfflineTransaction): Promise<number> {
    const snapshots = await tx.objectStore('snapshots').getAll()
    const drafts = await tx.objectStore('drafts').getAll()
    let total = 0
    for (const snapshot of snapshots) {
      const parsed = OfflineSnapshotRecordSchema.safeParse(snapshot)
      if (!parsed.success) throw new OfflineStorageError('invalid-record', 'An offline snapshot record is invalid.')
      total += parsed.data.byteSize
    }
    for (const draft of drafts) {
      const parsed = OfflineDraftEnvelopeV1Schema.safeParse(draft)
      if (!parsed.success) throw new OfflineStorageError('invalid-record', 'An offline draft envelope is invalid.')
      total += serializedBytes(parsed.data)
    }
    return total
  }

  async currentSessionGeneration(): Promise<number> {
    const meta = await this.readMeta()
    return meta.sessionGeneration
  }

  async bumpSessionGeneration(nextGeneration?: number, options: OfflineStorageGenerationOptions = {}): Promise<number> {
    this.assertOpen(true)
    const expected = options.expectedSessionGeneration === undefined ? undefined : validateGeneration(options.expectedSessionGeneration)
    try {
      const tx = this.db.transaction('meta', 'readwrite')
      const current = await tx.store.get(META_KEY)
      const parsed = OfflineMetaRecordSchema.safeParse(current)
      if (!parsed.success || parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION) {
        this.unsupportedSchema = true
        throw new OfflineStorageError('unsupported-schema', 'A newer offline database schema is present; writes are disabled.')
      }
      if (expected !== undefined && parsed.data.sessionGeneration !== expected) throw new OfflineGenerationFencedError(expected, parsed.data.sessionGeneration)
      const candidate = nextGeneration === undefined ? parsed.data.sessionGeneration + 1 : validateGeneration(nextGeneration)
      if (candidate <= parsed.data.sessionGeneration) throw new OfflineStorageError('generation-fenced', 'Session generation must increase monotonically.')
      await tx.store.put({ ...parsed.data, sessionGeneration: candidate })
      await tx.done
      return candidate
    } catch (error) {
      throw toFailure(error, 'transaction', 'Session generation could not be committed.')
    }
  }

  async putSnapshot(siteId: string, snapshot: OfflinePageSnapshotV1, options: OfflineSnapshotWriteOptions = {}): Promise<OfflineSnapshotRecord> {
    this.assertOpen(true)
    const validatedSiteId = validateSiteId(siteId)
    const parsedSnapshot = OfflinePageSnapshotV1Schema.parse(snapshot)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    const openedAt = now()
    const candidate = makeSnapshotRecord(validatedSiteId, parsedSnapshot, openedAt)
    const search = makeSearchDocument(validatedSiteId, parsedSnapshot)
    if (candidate.byteSize + search.byteSize > OFFLINE_RECORD_BYTES_LIMIT)
      throw new OfflineStorageError('quota', 'The offline snapshot exceeds the per-record limit.')
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'snapshots', 'searchDocuments', 'drafts'], 'readwrite')
      await this.assertGenerationInTransaction(tx, expected)
      const snapshotsStore = tx.objectStore('snapshots')
      const searchStore = tx.objectStore('searchDocuments')
      const allSnapshots = await snapshotsStore.getAll()
      const allSearch = (await searchStore.getAll()).map(value => OfflineSearchDocumentV1Schema.parse(value))
      const oldSnapshots = allSnapshots.filter(value => value.siteId === validatedSiteId && value.pageId === parsedSnapshot.pageId)
      const oldBytes = oldSnapshots.reduce((sum, value) => sum + value.byteSize, 0)
      const managedBefore = await this.managedBytes(tx)
      const projectedBytes = managedBefore - oldBytes + candidate.byteSize + search.byteSize
      const projectedSnapshots = allSnapshots.length - oldSnapshots.length + 1
      if (projectedSnapshots > OFFLINE_SNAPSHOT_LIMIT || projectedBytes > OFFLINE_MANAGED_BYTES_LIMIT) {
        options.onEvictionWarning?.(allSnapshots.length)
        throw new OfflineStorageError('quota', 'Offline snapshot limits would be exceeded; no records were evicted.')
      }
      for (const old of oldSnapshots) await snapshotsStore.delete(snapshotKey(old))
      for (const old of allSearch) {
        if (old.siteId === validatedSiteId && old.pageId === parsedSnapshot.pageId) await searchStore.delete(searchDocumentKey(old))
      }
      await snapshotsStore.put(candidate)
      await searchStore.put(search)
      return await this.finish(tx, candidate)
    } catch (error) {
      this.abort(tx)
      throw toFailure(error, 'transaction', 'The offline snapshot could not be committed.')
    }
  }

  async removeSnapshot(siteId: string, pageId: number, locale?: string, options: OfflineStorageGenerationOptions = {}): Promise<void> {
    this.assertOpen(true)
    const validatedSiteId = validateSiteId(siteId)
    const validatedPageId = validatePageId(pageId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    try {
      const tx = this.db.transaction(['meta', 'snapshots', 'searchDocuments'], 'readwrite')
      await this.assertGenerationInTransaction(tx, expected)
      const snapshotsStore = tx.objectStore('snapshots')
      const searchStore = tx.objectStore('searchDocuments')
      const snapshots = (await snapshotsStore.index('by-site').getAll(validatedSiteId)).filter(
        value => value.pageId === validatedPageId && (locale === undefined || value.locale === locale)
      )
      const search = (await searchStore.index('by-site').getAll(validatedSiteId)).filter(
        value => value.pageId === validatedPageId && (locale === undefined || value.locale === locale)
      )
      for (const record of snapshots) await snapshotsStore.delete(snapshotKey(record))
      for (const record of search) await searchStore.delete(searchDocumentKey(record))
      await this.finish(tx, undefined)
    } catch (error) {
      throw toFailure(error, 'transaction', 'The offline snapshot could not be removed.')
    }
  }

  async listSnapshots(siteId?: string, options: OfflineStorageGenerationOptions = {}): Promise<OfflineSnapshotRecord[]> {
    this.assertOpen(false)
    const validatedSiteId = siteId === undefined ? undefined : validateSiteId(siteId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    try {
      const tx = this.db.transaction(['meta', 'snapshots'], 'readwrite')
      await this.assertGenerationInTransaction(tx, expected)
      const store = tx.objectStore('snapshots')
      const records = (validatedSiteId === undefined ? await store.getAll() : await store.index('by-site').getAll(validatedSiteId)).map(value =>
        OfflineSnapshotRecordSchema.parse(value)
      )
      const openedAt = now()
      for (const record of records) await store.put({ ...record, lastOpenedAt: openedAt })
      await tx.done
      const after = await this.currentSessionGeneration()
      if (after !== expected) throw new OfflineGenerationFencedError(expected, after)
      return records.map(record => ({ ...record, lastOpenedAt: openedAt }))
    } catch (error) {
      throw toFailure(error, 'transaction', 'Offline snapshots could not be read.')
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
      const records = (await tx.objectStore('searchDocuments').index('by-site').getAll(validatedSiteId)).map(value =>
        OfflineSearchDocumentV1Schema.parse(value)
      )
      await tx.done
      const after = await this.currentSessionGeneration()
      if (after !== expected) throw new OfflineGenerationFencedError(expected, after)
      if (!normalizedQuery) return records
      return records.filter(record => {
        const haystack = normalizeSearchText(`${record.title} ${record.description} ${record.searchText} ${record.path} ${record.canonicalPath}`)
        return haystack.includes(normalizedQuery)
      })
    } catch (error) {
      throw toFailure(error, 'transaction', 'Offline search documents could not be read.')
    }
  }

  async putDraft(envelope: OfflineDraftEnvelopeV1, options: OfflineDraftWriteOptions = {}): Promise<OfflineDraftEnvelopeV1> {
    this.assertOpen(true)
    const parsed = OfflineDraftEnvelopeV1Schema.parse(envelope)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    if (parsed.sessionGeneration !== expected) throw new OfflineGenerationFencedError(expected, parsed.sessionGeneration)
    const serialized = serializedBytes(parsed)
    if (serialized > OFFLINE_RECORD_BYTES_LIMIT) throw new OfflineStorageError('quota', 'The encrypted draft envelope exceeds the per-record limit.')
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'drafts', 'snapshots'], 'readwrite')
      await this.assertGenerationInTransaction(tx, expected)
      const store = tx.objectStore('drafts')
      const existingValue = await store.get(parsed.recordId)
      const existing = existingValue === undefined ? undefined : OfflineDraftEnvelopeV1Schema.parse(existingValue)
      if (options.expectedDraftRevision !== undefined) {
        const expectedRevision = options.expectedDraftRevision
        if ((existing?.draftRevision ?? null) !== expectedRevision) throw new OfflineDraftConflictError(parsed.recordId)
      } else if (existing && parsed.draftRevision <= existing.draftRevision) {
        throw new OfflineDraftConflictError(parsed.recordId, 'Draft revisions must increase monotonically.')
      }
      if (options.expectedSubmissionId !== undefined && (existing?.submissionId ?? null) !== options.expectedSubmissionId)
        throw new OfflineDraftConflictError(parsed.recordId)
      if (existing && existing.submissionId !== null && !isSameSubmission(existing, parsed))
        throw new OfflineStorageError('immutable-submission', 'Immutable publishing records cannot be overwritten.')
      const managedBefore = await this.managedBytes(tx)
      const oldBytes = existing === undefined ? 0 : serializedBytes(existing)
      if (managedBefore - oldBytes + serialized > OFFLINE_MANAGED_BYTES_LIMIT)
        throw new OfflineStorageError('quota', 'Offline managed storage limit would be exceeded; no draft was evicted.')
      await store.put(cloneEnvelope(parsed))
      return await this.finish(tx, cloneEnvelope(parsed))
    } catch (error) {
      this.abort(tx)
      throw toFailure(error, 'transaction', 'The encrypted draft envelope could not be committed.')
    }
  }

  async listDraftEnvelopes(accountId: number, options: OfflineStorageGenerationOptions = {}): Promise<OfflineDraftEnvelopeV1[]> {
    this.assertOpen(false)
    const validatedAccountId = validateAccountId(accountId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    try {
      const tx = this.db.transaction(['meta', 'drafts'], 'readonly')
      await this.assertGenerationInTransaction(tx, expected)
      const values = await tx.objectStore('drafts').index('by-account').getAll(validatedAccountId)
      const result = values.map(value => cloneEnvelope(OfflineDraftEnvelopeV1Schema.parse(value)))
      await tx.done
      const after = await this.currentSessionGeneration()
      if (after !== expected) throw new OfflineGenerationFencedError(expected, after)
      return result
    } catch (error) {
      throw toFailure(error, 'transaction', 'Encrypted draft envelopes could not be read.')
    }
  }

  async deleteDraft(recordId: string, options: OfflineDraftDeleteOptions = {}): Promise<boolean> {
    this.assertOpen(true)
    if (typeof recordId !== 'string' || recordId.trim().length < 1 || recordId.length > 256)
      throw new OfflineStorageError('invalid-record', 'Draft record identity is invalid.')
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    try {
      const tx = this.db.transaction(['meta', 'drafts'], 'readwrite')
      await this.assertGenerationInTransaction(tx, expected)
      const store = tx.objectStore('drafts')
      const existingValue = await store.get(recordId)
      if (existingValue === undefined) {
        await this.finish(tx, undefined)
        return false
      }
      const existing = OfflineDraftEnvelopeV1Schema.parse(existingValue)
      if (options.expectedDraftRevision !== undefined && existing.draftRevision !== options.expectedDraftRevision) throw new OfflineDraftConflictError(recordId)
      if (options.expectedSubmissionId !== undefined && existing.submissionId !== options.expectedSubmissionId) throw new OfflineDraftConflictError(recordId)
      await store.delete(recordId)
      await this.finish(tx, undefined)
      return true
    } catch (error) {
      throw toFailure(error, 'transaction', 'The encrypted draft envelope could not be deleted.')
    }
  }

  async purgeAccount(accountId: number, options: OfflineStorageGenerationOptions = {}): Promise<OfflinePurgeResult> {
    this.assertOpen(true)
    const validatedAccountId = validateAccountId(accountId)
    const expected = await this.expectedGeneration(options.expectedSessionGeneration)
    let tx: OfflineWriteTransaction | undefined
    try {
      tx = this.db.transaction(['meta', 'drafts'], 'readwrite')
      const meta = await this.assertGenerationInTransaction(tx, expected)
      const store = tx.objectStore('drafts')
      const values = (await store.index('by-account').getAll(validatedAccountId)).map(value => OfflineDraftEnvelopeV1Schema.parse(value))
      const deletedRecordIds: string[] = []
      const preservedRecordIds: string[] = []
      for (const record of values) {
        // A non-null submission selector denotes an immutable publishing/outcome record.
        // Its payload is intentionally never inspected here, so purge cannot reveal or evict it.
        if (record.submissionId !== null) {
          preservedRecordIds.push(record.recordId)
          continue
        }
        await store.delete(record.recordId)
        deletedRecordIds.push(record.recordId)
      }
      await tx.objectStore('meta').put({ ...meta, lastCleanupAt: now() })
      await this.finish(tx, undefined)
      return { deletedRecordIds, preservedRecordIds }
    } catch (error) {
      this.abort(tx)
      throw toFailure(error, 'transaction', 'Account-owned offline drafts could not be purged.')
    }
  }

  async lockedDraftCount(): Promise<number> {
    this.assertOpen(false)
    try {
      const tx = this.db.transaction('drafts', 'readonly')
      const count = await tx.store.count()
      await tx.done
      return count
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
    try {
      const tx = this.db.transaction('meta', 'readwrite')
      const meta = await tx.store.get(META_KEY)
      const parsed = OfflineMetaRecordSchema.parse(meta)
      await tx.store.put({
        ...parsed,
        storage: { ...parsed.storage, usageBytes: estimate.usageBytes, quotaBytes: estimate.quotaBytes, persisted, persistenceRequested: true }
      })
      await tx.done
    } catch {
      // Persistence is an optional capability. A denial or metadata refresh failure is normal degradation.
    }
    return persisted ?? granted
  }

  async storageEstimate(): Promise<OfflineStorageEstimate> {
    this.assertOpen(false)
    const meta = await this.readMeta()
    const estimate = await getStorageEstimate()
    const persisted = await getPersisted()
    try {
      const tx = this.db.transaction(['meta', 'snapshots', 'drafts'], 'readonly')
      const snapshots = (await tx.objectStore('snapshots').getAll()).map(value => OfflineSnapshotRecordSchema.parse(value))
      const drafts = (await tx.objectStore('drafts').getAll()).map(value => OfflineDraftEnvelopeV1Schema.parse(value))
      const managedBytes = snapshots.reduce((sum, value) => sum + value.byteSize, 0) + drafts.reduce((sum, value) => sum + serializedBytes(value), 0)
      await tx.done
      return {
        usageBytes: estimate.usageBytes ?? meta.storage.usageBytes,
        quotaBytes: estimate.quotaBytes ?? meta.storage.quotaBytes,
        persisted: persisted ?? meta.storage.persisted,
        managedBytes,
        snapshotCount: snapshots.length,
        lockedDraftCount: drafts.length,
        schemaVersion: meta.schemaVersion,
        sessionGeneration: meta.sessionGeneration
      }
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
}

export const openOfflineStorage = async (options: OfflineStorageOpenOptions = {}): Promise<OfflineStorage> => {
  const databaseName = options.databaseName ?? OFFLINE_DB_NAME
  let db: IDBPDatabase<OfflineStorageDbSchema>
  let rejectBlocked: ((error: OfflineStorageError) => void) | undefined
  const blocked = new Promise<never>((_resolve, reject) => {
    rejectBlocked = reject
  })
  try {
    const opened = openDB<OfflineStorageDbSchema>(databaseName, OFFLINE_DB_VERSION, {
      blocked() {
        rejectBlocked?.(new OfflineStorageError('blocked-upgrade', 'Another offline database connection blocked the schema upgrade.'))
      },
      upgrade(database, oldVersion, _newVersion, transaction) {
        if (oldVersion > OFFLINE_DB_VERSION) throw new OfflineStorageError('unsupported-schema', 'A newer offline database schema is present.')
        if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' })
        if (!database.objectStoreNames.contains('snapshots')) {
          const store = database.createObjectStore('snapshots', { keyPath: ['siteId', 'pageId', 'locale'] })
          store.createIndex('by-site', 'siteId')
        } else if (!transaction.objectStore('snapshots').indexNames.contains('by-site')) {
          transaction.objectStore('snapshots').createIndex('by-site', 'siteId')
        }
        if (!database.objectStoreNames.contains('drafts')) {
          const store = database.createObjectStore('drafts', { keyPath: 'recordId' })
          store.createIndex('by-account', 'accountId')
        } else if (!transaction.objectStore('drafts').indexNames.contains('by-account')) {
          transaction.objectStore('drafts').createIndex('by-account', 'accountId')
        }
        if (!database.objectStoreNames.contains('searchDocuments')) {
          const store = database.createObjectStore('searchDocuments', { keyPath: ['siteId', 'pageId', 'locale'] })
          store.createIndex('by-site', 'siteId')
        } else if (!transaction.objectStore('searchDocuments').indexNames.contains('by-site')) {
          transaction.objectStore('searchDocuments').createIndex('by-site', 'siteId')
        }
      }
    })
    db = await Promise.race([opened, blocked])
  } catch (error) {
    throw toFailure(error, 'transaction', 'Offline storage could not be opened.')
  }
  const storage = new OfflineStorage(db)
  db.onversionchange = () => storage.close()
  try {
    const existing = await db.get('meta', META_KEY)
    if (existing === undefined) {
      const tx = db.transaction('meta', 'readwrite')
      await tx.store.put(defaultMeta())
      await tx.done
    } else {
      const parsed = OfflineMetaRecordSchema.safeParse(existing)
      if (!parsed.success || parsed.data.schemaVersion > OFFLINE_SCHEMA_VERSION) storage['unsupportedSchema'] = true
    }
  } catch (error) {
    storage.close()
    throw toFailure(error, 'transaction', 'Offline metadata could not be initialized.')
  }
  return storage
}

export type { OfflineStorageDbSchema }
