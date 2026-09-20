import { z } from 'zod'
import type { PageEditorKey } from './page-editors.ts'
import { PAGE_EDITOR_KEYS } from './page-editors.ts'

export const OFFLINE_SCHEMA_VERSION = 1 as const
export const OFFLINE_DB_NAME = 'tsepistle-offline' as const
/** The physical IndexedDB version. The payload/schema version remains v1. */
export const OFFLINE_DB_VERSION = 6 as const
export const OFFLINE_KEY_VERSION = 'session-secret-v1' as const
export const OFFLINE_READING_KEY_VERSION = 'random-reading-v1' as const
export const OFFLINE_READING_KEY_MAGIC = 'TSORK1' as const
export const OFFLINE_DRAFT_KEY_MAGIC = 'TSODK1' as const
export const OFFLINE_HTML_SANITIZER_VERSION = 'offline-html-allowlist-v1' as const
export const OFFLINE_CONTENT_TYPE = 'sanitized-html-fragment' as const

export const OFFLINE_READING_CONTEXT_SCHEMA_VERSION = 1 as const
export const OFFLINE_READING_VAULT_SCHEMA_VERSION = 1 as const
export const OFFLINE_PRIVATE_ENVELOPE_SCHEMA_VERSION = 1 as const
export const OFFLINE_PRIVATE_SNAPSHOT_RESPONSE_SCHEMA_VERSION = 1 as const
export const OFFLINE_READING_WRAP_INFO = 'tsepistle/offline-reading-wrap/v1' as const
export const OFFLINE_READING_VAULT_AAD = 'tsepistle/offline-reading-vault/v1' as const
export const OFFLINE_READING_RECORD_AAD = 'tsepistle/offline-reading-record/v1' as const

export const OFFLINE_POLICY_SCHEMA_VERSION = 1 as const
export const OFFLINE_POLICY_STORE_NAME = 'policy' as const
export const OFFLINE_POLICY_STATE_KEY = 'state' as const
export const OFFLINE_POLICY_PAGE_LIMIT = 1000
export const OFFLINE_POLICY_TAG_LIMIT = 32
export const OFFLINE_POLICY_TAG_LENGTH_LIMIT = 256
export const OFFLINE_AUTOMATIC_PAGE_LIMIT = 10
export const OFFLINE_AUTOMATIC_INACTIVITY_DAYS = 60
export const OFFLINE_AUTOMATIC_INACTIVITY_MS = OFFLINE_AUTOMATIC_INACTIVITY_DAYS * 24 * 60 * 60 * 1000

export const OFFLINE_SNAPSHOT_LIMIT = 100
export const OFFLINE_MANAGED_BYTES_LIMIT = 20 * 1024 * 1024
export const OFFLINE_RECORD_BYTES_LIMIT = 1 * 1024 * 1024
export const OFFLINE_DRAFT_KEY_BYTES = 32
export const OFFLINE_DRAFT_NONCE_BYTES = 12
export const OFFLINE_DRAFT_TAG_BYTES = 16

export const OFFLINE_STORE_NAMES = ['meta', 'snapshots', 'drafts', 'searchDocuments', 'policy', 'readingVault', 'privateRecords'] as const
export type OfflineStoreName = (typeof OFFLINE_STORE_NAMES)[number]

export const OFFLINE_DRAFT_STATES = ['local', 'needs-review', 'publishing', 'conflict', 'locked', 'unavailable', 'outcome-unknown'] as const
export const OfflineDraftStateSchema = z.enum(OFFLINE_DRAFT_STATES)
export type OfflineDraftState = z.infer<typeof OfflineDraftStateSchema>

export const OFFLINE_CAPABILITY_STATUSES = [
  'available-offline',
  'saved-on-device',
  'waiting-for-connection',
  'needs-review',
  'publishing',
  'published',
  'update-ready',
  'server-unavailable'
] as const
export const OfflineCapabilityStatusSchema = z.enum(OFFLINE_CAPABILITY_STATUSES)
export type OfflineCapabilityStatus = z.infer<typeof OfflineCapabilityStatusSchema>

const safeInteger = z.number().int().safe()
const positiveSafeInteger = safeInteger.positive()
const nonnegativeSafeInteger = safeInteger.nonnegative()
const boundedIdentifier = z.string().trim().min(1).max(256)
const boundedLocale = z.string().trim().min(2).max(35)
const boundedPath = z.string().min(1).max(2048)
const boundedRevision = z.string().min(1).max(512)
const isoDateTime = z.iso.datetime({ offset: true })
const byteArray = z.instanceof(Uint8Array)

export const PageEditorKeySchema = z.enum(PAGE_EDITOR_KEYS)
export type CanonicalPageEditorKey = PageEditorKey

export const OfflineHtmlFragmentV1Schema = z
  .object({
    representation: z.literal(OFFLINE_CONTENT_TYPE),
    sanitizerVersion: z.literal(OFFLINE_HTML_SANITIZER_VERSION),
    html: z.string().max(OFFLINE_RECORD_BYTES_LIMIT)
  })
  .strict()
export type OfflineHtmlFragmentV1 = z.infer<typeof OfflineHtmlFragmentV1Schema>

export const OfflinePageSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal(OFFLINE_SCHEMA_VERSION),
    pageId: positiveSafeInteger,
    locale: boundedLocale,
    path: boundedPath,
    canonicalPath: boundedPath,
    title: z.string().max(4096),
    description: z.string().max(16_384),
    sourceRevision: boundedRevision,
    capturedAt: isoDateTime,
    expiresAt: isoDateTime.nullable(),
    content: OfflineHtmlFragmentV1Schema,
    searchText: z.string().max(OFFLINE_RECORD_BYTES_LIMIT),
    contentType: z.literal(OFFLINE_CONTENT_TYPE),
    integrity: z.string().trim().min(1).max(512)
  })
  .strict()
export type OfflinePageSnapshotV1 = z.infer<typeof OfflinePageSnapshotV1Schema>

export const OfflineDraftEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal(OFFLINE_SCHEMA_VERSION),
    recordId: boundedIdentifier,
    accountId: positiveSafeInteger,
    authVersion: nonnegativeSafeInteger,
    keyVersion: z.literal(OFFLINE_KEY_VERSION),
    sessionGeneration: nonnegativeSafeInteger,
    draftRevision: positiveSafeInteger,
    submissionId: boundedIdentifier.nullable(),
    nonce: byteArray.refine(value => value.byteLength === OFFLINE_DRAFT_NONCE_BYTES, `Nonce must be ${OFFLINE_DRAFT_NONCE_BYTES} bytes.`),
    ciphertext: byteArray.refine(value => value.byteLength >= OFFLINE_DRAFT_TAG_BYTES, 'Ciphertext must contain an authentication tag.')
  })
  .strict()
export type OfflineDraftEnvelopeV1 = z.infer<typeof OfflineDraftEnvelopeV1Schema>
export const OfflineDraftEnvelopeClearSelectorsSchema = z
  .object({
    accountId: positiveSafeInteger,
    authVersion: nonnegativeSafeInteger,
    keyVersion: z.literal(OFFLINE_KEY_VERSION),
    sessionGeneration: nonnegativeSafeInteger,
    draftRevision: positiveSafeInteger,
    submissionId: boundedIdentifier.nullable()
  })
  .strict()
export type OfflineDraftEnvelopeClearSelectors = z.infer<typeof OfflineDraftEnvelopeClearSelectorsSchema>

export const OfflineDraftPayloadV1Schema = z
  .object({
    editorKey: PageEditorKeySchema,
    pageId: positiveSafeInteger.nullable(),
    createIdentity: boundedIdentifier.nullable(),
    locale: boundedLocale,
    path: boundedPath,
    baseSourceRevision: boundedRevision.nullable(),
    baseUpdatedAt: isoDateTime.nullable(),
    updatedAt: isoDateTime,
    state: OfflineDraftStateSchema,
    title: z.string().max(4096),
    description: z.string().max(16_384),
    content: z.string().max(OFFLINE_RECORD_BYTES_LIMIT)
  })
  .strict()
export type OfflineDraftPayloadV1 = z.infer<typeof OfflineDraftPayloadV1Schema>

export const DraftKeyContextSchema = z
  .object({
    canonicalOrigin: z.string().url().max(2048),
    siteId: boundedIdentifier,
    accountId: positiveSafeInteger,
    authVersion: nonnegativeSafeInteger,
    keyVersion: z.literal(OFFLINE_KEY_VERSION)
  })
  .strict()
export type DraftKeyContext = z.infer<typeof DraftKeyContextSchema>
export type TSODK1Context = DraftKeyContext
export const OfflineDraftKeyContextSchema = DraftKeyContextSchema
export type OfflineDraftKeyContext = DraftKeyContext
export const TSODK1ContextSchema = DraftKeyContextSchema

export const OfflineSearchDocumentV1Schema = z
  .object({
    schemaVersion: z.literal(OFFLINE_SCHEMA_VERSION),
    siteId: boundedIdentifier,
    pageId: positiveSafeInteger,
    locale: boundedLocale,
    path: boundedPath,
    canonicalPath: boundedPath,
    title: z.string().max(4096),
    description: z.string().max(16_384),
    searchText: z.string().max(OFFLINE_RECORD_BYTES_LIMIT),
    capturedAt: isoDateTime,
    byteSize: nonnegativeSafeInteger
  })
  .strict()
export type OfflineSearchDocumentV1 = z.infer<typeof OfflineSearchDocumentV1Schema>
export const OFFLINE_POLICY_AVAILABILITY = ['unknown', 'available', 'ineligible', 'transient-failure'] as const
export const OfflinePolicyAvailabilitySchema = z.enum(OFFLINE_POLICY_AVAILABILITY)
export type OfflinePolicyAvailability = z.infer<typeof OfflinePolicyAvailabilitySchema>

export const OFFLINE_SYNC_DIAGNOSTIC_STATUSES = ['idle', 'running', 'complete', 'partial', 'offline', 'error'] as const
export const OfflineSyncDiagnosticStatusSchema = z.enum(OFFLINE_SYNC_DIAGNOSTIC_STATUSES)
export type OfflineSyncDiagnosticStatus = z.infer<typeof OfflineSyncDiagnosticStatusSchema>

const boundedTag = z.string().trim().min(1).max(OFFLINE_POLICY_TAG_LENGTH_LIMIT)
const policyRecordKey = z.string().min(1).max(1024)

export const OfflineSyncDiagnosticsSchema = z
  .object({
    status: OfflineSyncDiagnosticStatusSchema,
    lastAttemptAt: isoDateTime.nullable(),
    lastSuccessAt: isoDateTime.nullable(),
    lastError: z.string().max(4096).nullable(),
    pendingCount: nonnegativeSafeInteger,
    retainedCount: nonnegativeSafeInteger,
    removedCount: nonnegativeSafeInteger
  })
  .strict()
export type OfflineSyncDiagnostics = z.infer<typeof OfflineSyncDiagnosticsSchema>

export const OfflinePolicyStateSchema = z
  .object({
    key: z.literal(OFFLINE_POLICY_STATE_KEY),
    recordType: z.literal('state'),
    schemaVersion: z.literal(OFFLINE_POLICY_SCHEMA_VERSION),
    automaticSavingEnabled: z.boolean(),
    automaticSavingDefaultApplied: z.literal(true).optional(),
    selectedTags: z.array(boundedTag).max(OFFLINE_POLICY_TAG_LIMIT),
    policyRevision: nonnegativeSafeInteger,
    syncDiagnostics: OfflineSyncDiagnosticsSchema,
    byteSize: nonnegativeSafeInteger
  })
  .strict()
export type OfflinePolicyState = z.infer<typeof OfflinePolicyStateSchema>
export const OfflineSnapshotProvenanceSchema = z
  .object({
    manual: z.boolean().optional(),
    automatic: z.boolean().optional(),
    tagNames: z.array(boundedTag).max(OFFLINE_POLICY_TAG_LIMIT).optional()
  })
  .strict()
export type OfflineSnapshotProvenance = z.infer<typeof OfflineSnapshotProvenanceSchema>

export const OfflinePagePolicyRecordSchema = z
  .object({
    key: policyRecordKey,
    recordType: z.literal('page'),
    schemaVersion: z.literal(OFFLINE_POLICY_SCHEMA_VERSION),
    siteId: boundedIdentifier,
    pageId: positiveSafeInteger,
    locale: boundedLocale,
    manual: z.boolean(),
    automatic: z.boolean(),
    tag: z.boolean(),
    tagNames: z.array(boundedTag).max(OFFLINE_POLICY_TAG_LIMIT),
    visitCount: nonnegativeSafeInteger,
    lastVisitedAt: isoDateTime.nullable(),
    lastEditedAt: isoDateTime.nullable(),
    automaticSelectedAt: isoDateTime.nullable(),
    excluded: z.boolean(),
    availability: OfflinePolicyAvailabilitySchema,
    byteSize: nonnegativeSafeInteger
  })
  .strict()
export type OfflinePagePolicyRecord = z.infer<typeof OfflinePagePolicyRecordSchema>

export const OfflinePolicyRecordSchema = z.union([OfflinePolicyStateSchema, OfflinePagePolicyRecordSchema])
export type OfflinePolicyRecord = z.infer<typeof OfflinePolicyRecordSchema>

export const OfflinePolicySnapshotSchema = z
  .object({
    state: OfflinePolicyStateSchema,
    pages: z.array(OfflinePagePolicyRecordSchema),
    sessionGeneration: nonnegativeSafeInteger
  })
  .strict()
export type OfflinePolicySnapshot = {
  readonly state: OfflinePolicyState
  readonly pages: readonly OfflinePagePolicyRecord[]
  readonly sessionGeneration: number
}

export const OfflineSnapshotRecordSchema = z
  .object({
    siteId: boundedIdentifier,
    pageId: positiveSafeInteger,
    locale: boundedLocale,
    snapshot: OfflinePageSnapshotV1Schema,
    lastOpenedAt: isoDateTime,
    byteSize: nonnegativeSafeInteger
  })
  .strict()
export type OfflineSnapshotRecord = z.infer<typeof OfflineSnapshotRecordSchema>

export const OfflineMetaRecordSchema = z
  .object({
    key: z.literal('state'),
    schemaVersion: z.number().int().positive(),
    sessionGeneration: nonnegativeSafeInteger,
    managedBytes: nonnegativeSafeInteger,
    snapshotCount: nonnegativeSafeInteger,
    corpusRevision: nonnegativeSafeInteger,
    accountingComplete: z.boolean(),
    lastCleanupAt: isoDateTime.nullable(),
    storage: z
      .object({
        usageBytes: nonnegativeSafeInteger.nullable(),
        quotaBytes: nonnegativeSafeInteger.nullable(),
        persisted: z.boolean().nullable(),
        persistenceRequested: z.boolean()
      })
      .strict()
  })
  .strict()
export type OfflineMetaRecord = z.infer<typeof OfflineMetaRecordSchema>

export const OfflineSnapshotCorpusSchema = z
  .object({
    snapshots: z.array(OfflineSnapshotRecordSchema),
    sessionGeneration: nonnegativeSafeInteger,
    corpusRevision: nonnegativeSafeInteger
  })
  .strict()
export type OfflineSnapshotCorpus = {
  readonly snapshots: readonly OfflineSnapshotRecord[]
  readonly sessionGeneration: number
  readonly corpusRevision: number
}

export const OfflineSnapshotSelectorSchema = z
  .object({
    siteId: boundedIdentifier,
    pageId: positiveSafeInteger,
    locale: boundedLocale
  })
  .strict()
export type OfflineSnapshotSelector = z.infer<typeof OfflineSnapshotSelectorSchema>
export const OfflinePolicyPageSelectorSchema = OfflineSnapshotSelectorSchema
export type OfflinePolicyPageSelector = OfflineSnapshotSelector

export const OfflineCorpusNoticeSchema = z
  .object({
    kind: z.enum(['corpus', 'generation', 'policy']),
    sessionGeneration: nonnegativeSafeInteger,
    corpusRevision: nonnegativeSafeInteger
  })
  .strict()
export type OfflineCorpusNotice = z.infer<typeof OfflineCorpusNoticeSchema>

export const OfflineFinalizationSelectorsSchema = z
  .object({
    receipt: OfflineDraftEnvelopeV1Schema,
    source: OfflineDraftEnvelopeV1Schema.nullable(),
    survivingFork: OfflineDraftEnvelopeV1Schema.nullable()
  })
  .strict()
export type OfflineFinalizationSelectors = z.infer<typeof OfflineFinalizationSelectorsSchema>

export const OfflineStorageEstimateSchema = z
  .object({
    usageBytes: nonnegativeSafeInteger.nullable(),
    quotaBytes: nonnegativeSafeInteger.nullable(),
    persisted: z.boolean().nullable(),
    managedBytes: nonnegativeSafeInteger,
    snapshotCount: nonnegativeSafeInteger,
    policyPageCount: nonnegativeSafeInteger,
    lockedDraftCount: nonnegativeSafeInteger,
    schemaVersion: z.number().int().positive(),
    sessionGeneration: nonnegativeSafeInteger,
    policyRevision: nonnegativeSafeInteger
  })
  .strict()
export type OfflineStorageEstimate = z.infer<typeof OfflineStorageEstimateSchema>

export const OfflineStorageFailureCodeSchema = z.enum([
  'unsupported-schema',
  'metadata-recovery',
  'blocked-upgrade',
  'version-change',
  'quota',
  'serialization',
  'transaction',
  'generation-fenced',
  'policy-revision-fenced',
  'draft-conflict',
  'immutable-submission',
  'invalid-record',
  'closed'
])
export type OfflineStorageFailureCode = z.infer<typeof OfflineStorageFailureCodeSchema>
export const OFFLINE_READING_VAULT_STORE_NAME = 'readingVault' as const
export const OFFLINE_PRIVATE_RECORDS_STORE_NAME = 'privateRecords' as const
export const OFFLINE_READING_KEY_BYTES = 32
export const OFFLINE_READING_SALT_BYTES = 32
export const OFFLINE_READING_NONCE_BYTES = 12
export const OFFLINE_READING_TAG_BYTES = 16
export const OFFLINE_READING_PAIR_ID_BYTES = 16
export const OFFLINE_READING_KEY_ID_BYTES = 16
export const OFFLINE_PRIVATE_RECORD_BYTES_LIMIT = OFFLINE_RECORD_BYTES_LIMIT

const canonicalBase64Url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine(value => !value.includes('=') && value.length > 0)

const canonicalOriginSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(value => {
    try {
      const parsed = new URL(value)
      const localHttp = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      return (
        parsed.origin === value &&
        (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && localHttp)) &&
        parsed.username === '' &&
        parsed.password === '' &&
        parsed.pathname === '/' &&
        parsed.search === '' &&
        parsed.hash === ''
      )
    } catch {
      return false
    }
  })

export const OfflineReadingContextV1Schema = z
  .object({
    schemaVersion: z.literal(OFFLINE_READING_CONTEXT_SCHEMA_VERSION),
    canonicalOrigin: canonicalOriginSchema,
    siteId: boundedIdentifier,
    accountId: positiveSafeInteger,
    authVersion: nonnegativeSafeInteger,
    keyVersion: z.literal(OFFLINE_READING_KEY_VERSION),
    keyId: canonicalBase64Url.refine(value => value.length === 22)
  })
  .strict()
export type OfflineReadingContextV1 = z.infer<typeof OfflineReadingContextV1Schema>
export const OfflineReadingContextSchema = OfflineReadingContextV1Schema

export const OfflineReadingVaultV1Schema = z
  .object({
    schemaVersion: z.literal(OFFLINE_READING_VAULT_SCHEMA_VERSION),
    context: OfflineReadingContextV1Schema,
    sessionGeneration: nonnegativeSafeInteger,
    salt: byteArray.refine(value => value.byteLength === OFFLINE_READING_SALT_BYTES),
    nonce: byteArray.refine(value => value.byteLength === OFFLINE_READING_NONCE_BYTES),
    wrappedKey: byteArray.refine(value => value.byteLength === OFFLINE_READING_KEY_BYTES + OFFLINE_READING_TAG_BYTES)
  })
  .strict()
export type OfflineReadingVaultV1 = z.infer<typeof OfflineReadingVaultV1Schema>
export const OfflineReadingVaultSchema = OfflineReadingVaultV1Schema

export const OFFLINE_PRIVATE_ENVELOPE_KINDS = ['snapshot', 'search', 'policy-page', 'policy-state'] as const
export const OfflinePrivateEnvelopeKindSchema = z.enum(OFFLINE_PRIVATE_ENVELOPE_KINDS)
export type OfflinePrivateEnvelopeKind = z.infer<typeof OfflinePrivateEnvelopeKindSchema>

const nullablePrivatePageId = positiveSafeInteger.nullable()
const nullablePrivateLocale = boundedLocale.nullable()
const nullablePairId = canonicalBase64Url.refine(value => value.length === 22).nullable()

export const OfflinePrivateEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal(OFFLINE_PRIVATE_ENVELOPE_SCHEMA_VERSION),
    context: OfflineReadingContextV1Schema,
    sessionGeneration: nonnegativeSafeInteger,
    kind: OfflinePrivateEnvelopeKindSchema,
    pageId: nullablePrivatePageId,
    locale: nullablePrivateLocale,
    recordRevision: positiveSafeInteger,
    pairId: nullablePairId,
    nonce: byteArray.refine(value => value.byteLength === OFFLINE_READING_NONCE_BYTES),
    ciphertext: byteArray.refine(value => value.byteLength >= OFFLINE_READING_TAG_BYTES).refine(value => value.byteLength <= OFFLINE_PRIVATE_RECORD_BYTES_LIMIT)
  })
  .strict()
  .superRefine((value, context) => {
    const pageKind = value.kind === 'snapshot' || value.kind === 'search' || value.kind === 'policy-page'
    if (pageKind !== (value.pageId !== null && value.locale !== null)) context.addIssue({ code: 'custom', message: 'Page selectors must match envelope kind.' })
    const paired = value.kind === 'snapshot' || value.kind === 'search'
    if (paired !== (value.pairId !== null)) context.addIssue({ code: 'custom', message: 'Body/search pairing must match envelope kind.' })
  })
export type OfflinePrivateEnvelopeV1 = z.infer<typeof OfflinePrivateEnvelopeV1Schema>
export const OfflinePrivateEnvelopeSchema = OfflinePrivateEnvelopeV1Schema

export const OfflinePrivateSnapshotResponseV1Schema = z
  .object({
    schemaVersion: z.literal(OFFLINE_PRIVATE_SNAPSHOT_RESPONSE_SCHEMA_VERSION),
    audience: z.literal('private'),
    context: z
      .object({
        canonicalOrigin: canonicalOriginSchema,
        siteId: boundedIdentifier,
        accountId: positiveSafeInteger,
        authVersion: nonnegativeSafeInteger
      })
      .strict(),
    snapshot: OfflinePageSnapshotV1Schema
  })
  .strict()
export type OfflinePrivateSnapshotResponseV1 = z.infer<typeof OfflinePrivateSnapshotResponseV1Schema>
export const OfflinePrivateSnapshotResponseSchema = OfflinePrivateSnapshotResponseV1Schema

export const OfflinePrivateSearchDocumentV1Schema = OfflineSearchDocumentV1Schema.extend({ sourceRevision: boundedRevision }).strict()
export type OfflinePrivateSearchDocumentV1 = z.infer<typeof OfflinePrivateSearchDocumentV1Schema>
export const OfflinePrivatePolicyPageV1Schema = OfflinePagePolicyRecordSchema
export type OfflinePrivatePolicyPageV1 = OfflinePagePolicyRecord
export const OfflinePrivatePolicyStateV1Schema = OfflinePolicyStateSchema
export type OfflinePrivatePolicyStateV1 = OfflinePolicyState
