import {
  OfflineDraftEnvelopeV1Schema,
  OfflineDraftPayloadV1Schema,
  OfflinePrivateEnvelopeV1Schema,
  OfflinePrivateSearchDocumentV1Schema,
  OfflinePrivateSnapshotResponseV1Schema,
  OfflinePagePolicyRecordSchema,
  OfflinePolicyStateSchema,
  OFFLINE_DRAFT_NONCE_BYTES,
  OFFLINE_DRAFT_TAG_BYTES,
  OFFLINE_KEY_VERSION,
  OFFLINE_PRIVATE_RECORD_BYTES_LIMIT,
  OFFLINE_READING_NONCE_BYTES,
  OFFLINE_READING_PAIR_ID_BYTES,
  OFFLINE_READING_TAG_BYTES,
  OFFLINE_RECORD_BYTES_LIMIT,
  OFFLINE_SCHEMA_VERSION,
  type OfflineDraftEnvelopeV1,
  type OfflineDraftPayloadV1,
  type OfflinePagePolicyRecord,
  type OfflinePolicyState,
  type OfflinePrivateEnvelopeKind,
  type OfflinePrivateEnvelopeV1,
  type OfflineReadingContextV1,
  OfflinePageSnapshotV1Schema
} from '../../shared/offline.ts'
import {
  OfflineDraftOpaqueError,
  encodeOfflineReadingContext,
  isCurrentOfflineDraftKey,
  isCurrentOfflineReadingHandle,
  lockOfflineReading,
  requireCurrentOfflineDraftKey,
  requireCurrentOfflineReadingKey,
  type OfflineDraftKeyHandle,
  type OfflineReadingHandleV1
} from './offline-session.ts'

export type OfflineDraftSelectors = {
  readonly recordId: string
  readonly draftRevision: number
  readonly submissionId: string | null
}

export type OfflineDraftAadInput = OfflineDraftSelectors & {
  readonly nonce: Uint8Array
}

const opaque = (): OfflineDraftOpaqueError => new OfflineDraftOpaqueError()

const isSafeNonnegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isSafePositiveInteger = (value: unknown): value is number => isSafeNonnegativeInteger(value) && value > 0

const assertAadInput = (input: OfflineDraftAadInput): OfflineDraftAadInput => {
  if (
    !input ||
    typeof input.recordId !== 'string' ||
    input.recordId.length < 1 ||
    input.recordId.length > 256 ||
    input.recordId.trim() !== input.recordId ||
    !isSafePositiveInteger(input.draftRevision) ||
    (input.submissionId !== null &&
      (typeof input.submissionId !== 'string' ||
        input.submissionId.length < 1 ||
        input.submissionId.length > 256 ||
        input.submissionId.trim() !== input.submissionId)) ||
    !(input.nonce instanceof Uint8Array) ||
    input.nonce.byteLength !== OFFLINE_DRAFT_NONCE_BYTES
  )
    throw opaque()
  return input
}

const u32be = (value: number): Uint8Array => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw opaque()
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value, false)
  return result
}

const u64be = (value: number): Uint8Array => {
  if (!isSafeNonnegativeInteger(value) || value > Number.MAX_SAFE_INTEGER) throw opaque()
  const result = new Uint8Array(8)
  new DataView(result.buffer).setBigUint64(0, BigInt(value), false)
  return result
}

const lpUtf8 = (value: string): Uint8Array => {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength > 0xffffffff) throw opaque()
  const length = u32be(encoded.byteLength)
  const result = new Uint8Array(length.byteLength + encoded.byteLength)
  result.set(length, 0)
  result.set(encoded, length.byteLength)
  return result
}

const lpBytes = (value: Uint8Array): Uint8Array => {
  const length = u32be(value.byteLength)
  const result = new Uint8Array(length.byteLength + value.byteLength)
  result.set(length, 0)
  result.set(value, length.byteLength)
  return result
}

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const size = parts.reduce((total, part) => total + part.byteLength, 0)
  if (!Number.isSafeInteger(size)) throw opaque()
  const result = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

/** Encodes the authenticated selector sequence for the supplied generation. */
const encodeOfflineDraftAadForGeneration = (handle: OfflineDraftKeyHandle, rawInput: OfflineDraftAadInput, sessionGeneration: number): Uint8Array => {
  if (!isCurrentOfflineDraftKey(handle)) throw opaque()
  const input = assertAadInput(rawInput)
  const context = handle.context
  if (
    context.keyVersion !== OFFLINE_KEY_VERSION ||
    !isSafePositiveInteger(context.accountId) ||
    !isSafeNonnegativeInteger(context.authVersion) ||
    !isSafeNonnegativeInteger(sessionGeneration)
  )
    throw opaque()

  const submission = input.submissionId === null ? new Uint8Array([0]) : concat([new Uint8Array([1]), lpUtf8(input.submissionId)])
  return concat([
    u32be(OFFLINE_SCHEMA_VERSION),
    lpUtf8(input.recordId),
    u64be(context.accountId),
    u64be(context.authVersion),
    lpUtf8(OFFLINE_KEY_VERSION),
    u64be(sessionGeneration),
    u64be(input.draftRevision),
    submission,
    lpBytes(input.nonce)
  ])
}

/** Encodes the exact authenticated clear selector sequence for this handle's generation. */
export const encodeOfflineDraftAad = (handle: OfflineDraftKeyHandle, rawInput: OfflineDraftAadInput): Uint8Array =>
  encodeOfflineDraftAadForGeneration(handle, rawInput, handle.sessionGeneration)

export const encodeDraftAad = encodeOfflineDraftAad

const canonicalPayload = (payload: OfflineDraftPayloadV1): OfflineDraftPayloadV1 => ({
  editorKey: payload.editorKey,
  pageId: payload.pageId,
  createIdentity: payload.createIdentity,
  locale: payload.locale,
  path: payload.path,
  baseSourceRevision: payload.baseSourceRevision,
  baseUpdatedAt: payload.baseUpdatedAt,
  updatedAt: payload.updatedAt,
  state: payload.state,
  title: payload.title,
  description: payload.description,
  content: payload.content
})

const parsePayload = (payload: OfflineDraftPayloadV1): OfflineDraftPayloadV1 => {
  const parsed = OfflineDraftPayloadV1Schema.safeParse(payload)
  if (!parsed.success) throw opaque()
  return canonicalPayload(parsed.data)
}

const parseSelectors = (selectors: OfflineDraftSelectors): OfflineDraftSelectors => {
  const candidate = {
    schemaVersion: OFFLINE_SCHEMA_VERSION,
    recordId: selectors?.recordId,
    accountId: 1,
    authVersion: 0,
    keyVersion: OFFLINE_KEY_VERSION,
    sessionGeneration: 0,
    draftRevision: selectors?.draftRevision,
    submissionId: selectors?.submissionId,
    nonce: new Uint8Array(OFFLINE_DRAFT_NONCE_BYTES),
    ciphertext: new Uint8Array(OFFLINE_DRAFT_TAG_BYTES)
  }
  const parsed = OfflineDraftEnvelopeV1Schema.safeParse(candidate)
  if (!parsed.success) throw opaque()
  return {
    recordId: parsed.data.recordId,
    draftRevision: parsed.data.draftRevision,
    submissionId: parsed.data.submissionId
  }
}

const subtleCrypto = (): SubtleCrypto => {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw opaque()
  return subtle
}

const randomNonce = (): Uint8Array => {
  const nonce = new Uint8Array(OFFLINE_DRAFT_NONCE_BYTES)
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.getRandomValues) throw opaque()
  cryptoApi.getRandomValues(nonce)
  return nonce
}

/** Encrypts a schema-validated payload into the opaque clear-selector envelope. */
export const encryptOfflineDraft = async (
  handle: OfflineDraftKeyHandle,
  payload: OfflineDraftPayloadV1,
  rawSelectors: OfflineDraftSelectors
): Promise<OfflineDraftEnvelopeV1> => {
  const key = requireCurrentOfflineDraftKey(handle)
  const parsedPayload = parsePayload(payload)
  const selectors = parseSelectors(rawSelectors)
  const nonce = randomNonce()
  let aad: Uint8Array | undefined
  let plaintextBytes: Uint8Array | undefined
  let ciphertextBytes: Uint8Array | undefined
  let returned = false
  try {
    aad = encodeOfflineDraftAad(handle, { ...selectors, nonce })
    const serialized = JSON.stringify(parsedPayload)
    if (serialized === undefined) throw opaque()
    plaintextBytes = new TextEncoder().encode(serialized)
    if (plaintextBytes.byteLength > OFFLINE_RECORD_BYTES_LIMIT) throw opaque()
    const encrypted = await subtleCrypto().encrypt(
      { name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: OFFLINE_DRAFT_TAG_BYTES * 8 },
      key,
      plaintextBytes as unknown as BufferSource
    )
    ciphertextBytes = new Uint8Array(encrypted)
    if (ciphertextBytes.byteLength < OFFLINE_DRAFT_TAG_BYTES || ciphertextBytes.byteLength > OFFLINE_RECORD_BYTES_LIMIT) throw opaque()
    if (!isCurrentOfflineDraftKey(handle)) throw opaque()
    const envelope = {
      schemaVersion: OFFLINE_SCHEMA_VERSION,
      recordId: selectors.recordId,
      accountId: handle.context.accountId,
      authVersion: handle.context.authVersion,
      keyVersion: OFFLINE_KEY_VERSION,
      sessionGeneration: handle.sessionGeneration,
      draftRevision: selectors.draftRevision,
      submissionId: selectors.submissionId,
      nonce,
      ciphertext: ciphertextBytes
    }
    const parsedEnvelope = OfflineDraftEnvelopeV1Schema.safeParse(envelope)
    if (!parsedEnvelope.success) throw opaque()
    returned = true
    return parsedEnvelope.data
  } catch (error) {
    if (error instanceof OfflineDraftOpaqueError) throw error
    throw opaque()
  } finally {
    aad?.fill(0)
    plaintextBytes?.fill(0)
    if (!returned) {
      ciphertextBytes?.fill(0)
      nonce.fill(0)
    }
  }
}

/** Decrypts only while the supplied owner/generation handle remains current. */
export const decryptOfflineDraft = async (handle: OfflineDraftKeyHandle, envelope: OfflineDraftEnvelopeV1): Promise<OfflineDraftPayloadV1> => {
  let aad: Uint8Array | undefined
  let plaintextBytes: Uint8Array | undefined
  try {
    const parsedEnvelope = OfflineDraftEnvelopeV1Schema.safeParse(envelope)
    if (!parsedEnvelope.success) throw opaque()
    const value = parsedEnvelope.data
    if (
      value.accountId !== handle.context.accountId ||
      value.authVersion !== handle.context.authVersion ||
      value.keyVersion !== handle.context.keyVersion ||
      value.sessionGeneration !== handle.sessionGeneration ||
      value.ciphertext.byteLength > OFFLINE_RECORD_BYTES_LIMIT
    )
      throw opaque()
    const key = requireCurrentOfflineDraftKey(handle)
    aad = encodeOfflineDraftAad(handle, {
      recordId: value.recordId,
      draftRevision: value.draftRevision,
      submissionId: value.submissionId,
      nonce: value.nonce
    })
    const decrypted = await subtleCrypto().decrypt(
      { name: 'AES-GCM', iv: value.nonce as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: OFFLINE_DRAFT_TAG_BYTES * 8 },
      key,
      value.ciphertext as unknown as BufferSource
    )
    plaintextBytes = new Uint8Array(decrypted)
    if (!isCurrentOfflineDraftKey(handle)) throw opaque()
    const serialized = new TextDecoder('utf-8', { fatal: true }).decode(plaintextBytes)
    let decoded: unknown
    try {
      decoded = JSON.parse(serialized) as unknown
    } catch {
      throw opaque()
    }
    const payload = OfflineDraftPayloadV1Schema.safeParse(decoded)
    if (!payload.success || !isCurrentOfflineDraftKey(handle)) throw opaque()
    return canonicalPayload(payload.data)
  } catch (error) {
    if (error instanceof OfflineDraftOpaqueError) throw error
    throw opaque()
  } finally {
    aad?.fill(0)
    plaintextBytes?.fill(0)
  }
}
/** Decrypts one ordinary draft from an older generation for same-owner recovery. */
export const decryptOfflineDraftForReconciliation = async (handle: OfflineDraftKeyHandle, envelope: OfflineDraftEnvelopeV1): Promise<OfflineDraftPayloadV1> => {
  let aad: Uint8Array | undefined
  let plaintextBytes: Uint8Array | undefined
  try {
    const parsedEnvelope = OfflineDraftEnvelopeV1Schema.safeParse(envelope)
    if (!parsedEnvelope.success) throw opaque()
    const value = parsedEnvelope.data
    if (
      value.submissionId !== null ||
      value.accountId !== handle.context.accountId ||
      value.authVersion !== handle.context.authVersion ||
      value.keyVersion !== handle.context.keyVersion ||
      value.sessionGeneration >= handle.sessionGeneration ||
      value.ciphertext.byteLength > OFFLINE_RECORD_BYTES_LIMIT
    )
      throw opaque()
    const key = requireCurrentOfflineDraftKey(handle)
    aad = encodeOfflineDraftAadForGeneration(
      handle,
      {
        recordId: value.recordId,
        draftRevision: value.draftRevision,
        submissionId: value.submissionId,
        nonce: value.nonce
      },
      value.sessionGeneration
    )
    const decrypted = await subtleCrypto().decrypt(
      { name: 'AES-GCM', iv: value.nonce as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: OFFLINE_DRAFT_TAG_BYTES * 8 },
      key,
      value.ciphertext as unknown as BufferSource
    )
    plaintextBytes = new Uint8Array(decrypted)
    if (!isCurrentOfflineDraftKey(handle)) throw opaque()
    const serialized = new TextDecoder('utf-8', { fatal: true }).decode(plaintextBytes)
    let decoded: unknown
    try {
      decoded = JSON.parse(serialized) as unknown
    } catch {
      throw opaque()
    }
    const payload = OfflineDraftPayloadV1Schema.safeParse(decoded)
    if (!payload.success || !isCurrentOfflineDraftKey(handle)) throw opaque()
    return canonicalPayload(payload.data)
  } catch (error) {
    if (error instanceof OfflineDraftOpaqueError) throw error
    throw opaque()
  } finally {
    aad?.fill(0)
    plaintextBytes?.fill(0)
  }
}

/**
 * Decrypts an immutable submission from an older generation for same-account
 * reconciliation only. The current verified key remains the only key input;
 * the old generation is authenticated solely as part of the stored AAD.
 */
export const decryptOfflineSubmissionForReconciliation = async (
  handle: OfflineDraftKeyHandle,
  envelope: OfflineDraftEnvelopeV1
): Promise<OfflineDraftPayloadV1> => {
  let aad: Uint8Array | undefined
  let plaintextBytes: Uint8Array | undefined
  try {
    const parsedEnvelope = OfflineDraftEnvelopeV1Schema.safeParse(envelope)
    if (!parsedEnvelope.success) throw opaque()
    const value = parsedEnvelope.data
    if (
      value.submissionId === null ||
      value.accountId !== handle.context.accountId ||
      value.authVersion !== handle.context.authVersion ||
      value.keyVersion !== handle.context.keyVersion ||
      value.sessionGeneration === handle.sessionGeneration ||
      value.ciphertext.byteLength > OFFLINE_RECORD_BYTES_LIMIT
    )
      throw opaque()
    const key = requireCurrentOfflineDraftKey(handle)
    aad = encodeOfflineDraftAadForGeneration(
      handle,
      {
        recordId: value.recordId,
        draftRevision: value.draftRevision,
        submissionId: value.submissionId,
        nonce: value.nonce
      },
      value.sessionGeneration
    )
    const decrypted = await subtleCrypto().decrypt(
      { name: 'AES-GCM', iv: value.nonce as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: OFFLINE_DRAFT_TAG_BYTES * 8 },
      key,
      value.ciphertext as unknown as BufferSource
    )
    plaintextBytes = new Uint8Array(decrypted)
    if (!isCurrentOfflineDraftKey(handle)) throw opaque()
    const serialized = new TextDecoder('utf-8', { fatal: true }).decode(plaintextBytes)
    let decoded: unknown
    try {
      decoded = JSON.parse(serialized) as unknown
    } catch {
      throw opaque()
    }
    const payload = OfflineDraftPayloadV1Schema.safeParse(decoded)
    if (!payload.success || !isCurrentOfflineDraftKey(handle)) throw opaque()
    return canonicalPayload(payload.data)
  } catch (error) {
    if (error instanceof OfflineDraftOpaqueError) throw error
    throw opaque()
  } finally {
    aad?.fill(0)
    plaintextBytes?.fill(0)
  }
}

export {
  invalidateOfflineSession,
  requestDraftKey,
  parseDraftKeyFrame,
  dropOfflineDraftKey,
  isCurrentOfflineDraftKey,
  requireCurrentOfflineDraftKey
} from './offline-session.ts'
export type OfflinePrivateRecordSelectors = {
  readonly pageId: number | null
  readonly locale: string | null
  readonly recordRevision: number
  readonly pairId: string | null
}

export type OfflinePrivateRecordPayload = unknown

const readingCryptoOpaque = (): OfflineDraftOpaqueError => new OfflineDraftOpaqueError()

const isPrivateSafeNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isPrivateSafePositive = (value: unknown): value is number => isPrivateSafeNonnegative(value) && value > 0

const readingU32 = (value: number): Uint8Array => {
  if (!isPrivateSafeNonnegative(value) || value > 0xffffffff) throw readingCryptoOpaque()
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, false)
  return bytes
}

const readingU64 = (value: number): Uint8Array => {
  if (!isPrivateSafeNonnegative(value)) throw readingCryptoOpaque()
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false)
  return bytes
}

const readingLpUtf8 = (value: string): Uint8Array => {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength > 0xffffffff) throw readingCryptoOpaque()
  const result = new Uint8Array(4 + encoded.byteLength)
  result.set(readingU32(encoded.byteLength), 0)
  result.set(encoded, 4)
  return result
}

const readingLpBytes = (value: Uint8Array): Uint8Array => {
  const result = new Uint8Array(4 + value.byteLength)
  result.set(readingU32(value.byteLength), 0)
  result.set(value, 4)
  return result
}

const readingConcat = (parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

const readingNonce = (): Uint8Array => {
  const nonce = new Uint8Array(OFFLINE_READING_NONCE_BYTES)
  if (!globalThis.crypto?.getRandomValues) throw readingCryptoOpaque()
  globalThis.crypto.getRandomValues(nonce)
  return nonce
}

const base64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

export const generateOfflineReadingPairId = (): string => {
  const bytes = new Uint8Array(OFFLINE_READING_PAIR_ID_BYTES)
  if (!globalThis.crypto?.getRandomValues) throw readingCryptoOpaque()
  globalThis.crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

const nullableU64 = (value: number | null): Uint8Array => (value === null ? new Uint8Array([0]) : readingConcat([new Uint8Array([1]), readingU64(value)]))
const nullableUtf8 = (value: string | null): Uint8Array => (value === null ? new Uint8Array([0]) : readingConcat([new Uint8Array([1]), readingLpUtf8(value)]))

export const encodeOfflinePrivateRecordAad = (
  handle: OfflineReadingHandleV1,
  kind: OfflinePrivateEnvelopeKind,
  selectors: OfflinePrivateRecordSelectors,
  nonce: Uint8Array
): Uint8Array => {
  if (!isCurrentOfflineReadingHandle(handle) || !isPrivateSafePositive(selectors.recordRevision) || nonce.byteLength !== OFFLINE_READING_NONCE_BYTES)
    throw readingCryptoOpaque()
  const pageKind = kind === 'snapshot' || kind === 'search' || kind === 'policy-page'
  const pairedKind = kind === 'snapshot' || kind === 'search'
  if (pageKind !== (selectors.pageId !== null && selectors.locale !== null) || pairedKind !== (selectors.pairId !== null)) throw readingCryptoOpaque()
  if (selectors.pageId !== null && !isPrivateSafePositive(selectors.pageId)) throw readingCryptoOpaque()
  if (selectors.locale !== null && (selectors.locale.trim() !== selectors.locale || selectors.locale.length < 2 || selectors.locale.length > 35))
    throw readingCryptoOpaque()
  if (selectors.pairId !== null && !/^[A-Za-z0-9_-]{22}$/u.test(selectors.pairId)) throw readingCryptoOpaque()
  return readingConcat([
    readingLpUtf8('tsepistle/offline-reading-record/v1'),
    readingU32(1),
    encodeOfflineReadingContext(handle.context),
    readingU64(handle.sessionGeneration),
    readingLpUtf8(kind),
    nullableU64(selectors.pageId),
    nullableUtf8(selectors.locale),
    readingU64(selectors.recordRevision),
    nullableUtf8(selectors.pairId),
    readingLpBytes(nonce)
  ])
}

const assertPrivatePayloadIdentity = (
  kind: OfflinePrivateEnvelopeKind,
  payload: unknown,
  context: OfflineReadingContextV1,
  selectors: OfflinePrivateRecordSelectors
): unknown => {
  const pageKind = kind === 'snapshot' || kind === 'search' || kind === 'policy-page'
  const pairedKind = kind === 'snapshot' || kind === 'search'
  if (pageKind !== (selectors.pageId !== null && selectors.locale !== null) || pairedKind !== (selectors.pairId !== null)) throw readingCryptoOpaque()
  if (kind === 'snapshot') {
    const parsed = OfflinePageSnapshotV1Schema.safeParse(payload)
    if (!parsed.success || parsed.data.pageId !== selectors.pageId || parsed.data.locale !== selectors.locale) throw readingCryptoOpaque()
    return parsed.data
  }
  if (kind === 'search') {
    const parsed = OfflinePrivateSearchDocumentV1Schema.safeParse(payload)
    if (!parsed.success || parsed.data.siteId !== context.siteId || parsed.data.pageId !== selectors.pageId || parsed.data.locale !== selectors.locale)
      throw readingCryptoOpaque()
    return parsed.data
  }
  if (kind === 'policy-page') {
    const parsed = OfflinePagePolicyRecordSchema.safeParse(payload)
    if (!parsed.success || parsed.data.siteId !== context.siteId || parsed.data.pageId !== selectors.pageId || parsed.data.locale !== selectors.locale)
      throw readingCryptoOpaque()
    return parsed.data
  }
  if (kind === 'policy-state') {
    const parsed = OfflinePolicyStateSchema.safeParse(payload)
    if (!parsed.success) throw readingCryptoOpaque()
    return parsed.data
  }
  throw readingCryptoOpaque()
}

const canonicalPrivatePayload = (
  kind: OfflinePrivateEnvelopeKind,
  payload: unknown,
  context: OfflineReadingContextV1,
  selectors: OfflinePrivateRecordSelectors
): unknown => {
  if (kind === 'snapshot') {
    const response = OfflinePrivateSnapshotResponseV1Schema.safeParse(payload)
    if (
      !response.success ||
      response.data.context.canonicalOrigin !== context.canonicalOrigin ||
      response.data.context.siteId !== context.siteId ||
      response.data.context.accountId !== context.accountId ||
      response.data.context.authVersion !== context.authVersion
    )
      throw readingCryptoOpaque()
    return assertPrivatePayloadIdentity(kind, response.data.snapshot, context, selectors)
  }
  return assertPrivatePayloadIdentity(kind, payload, context, selectors)
}

const parsePrivatePayload = (kind: OfflinePrivateEnvelopeKind, value: unknown): unknown => {
  if (kind === 'snapshot') {
    const snapshot = OfflinePageSnapshotV1Schema.safeParse(value)
    if (!snapshot.success) throw readingCryptoOpaque()
    return snapshot.data
  }
  if (kind === 'search') {
    const parsed = OfflinePrivateSearchDocumentV1Schema.safeParse(value)
    if (!parsed.success) throw readingCryptoOpaque()
    return parsed.data
  }
  if (kind === 'policy-page') {
    const parsed = OfflinePagePolicyRecordSchema.safeParse(value)
    if (!parsed.success) throw readingCryptoOpaque()
    return parsed.data
  }
  if (kind === 'policy-state') {
    const parsed = OfflinePolicyStateSchema.safeParse(value)
    if (!parsed.success) throw readingCryptoOpaque()
    return parsed.data
  }
  throw readingCryptoOpaque()
}

export type OfflinePrivateCorpus = {
  readonly snapshots: readonly unknown[]
  readonly searchDocuments: readonly unknown[]
  readonly policies: readonly unknown[]
  readonly corpusRevision?: number
}
export type OfflinePrivateCorpusStorage = {
  readonly listPrivateRecords: (
    keyId: string,
    options?: { readonly expectedSessionGeneration?: number; readonly expectedCorpusRevision?: number }
  ) => Promise<readonly OfflinePrivateEnvelopeV1[]>
  readonly currentCorpusRevision?: () => Promise<number>
}
export const readPrivateCorpus = async (
  handle: OfflineReadingHandleV1,
  storage: OfflinePrivateCorpusStorage,
  expectedCorpusRevision?: number
): Promise<OfflinePrivateCorpus> => {
  if (!isCurrentOfflineReadingHandle(handle) || (expectedCorpusRevision !== undefined && !isPrivateSafeNonnegative(expectedCorpusRevision)))
    throw readingCryptoOpaque()
  const capturedCorpusRevision = await storage.currentCorpusRevision?.()
  if (expectedCorpusRevision !== undefined && (capturedCorpusRevision === undefined || capturedCorpusRevision !== expectedCorpusRevision))
    throw readingCryptoOpaque()
  const records = await storage.listPrivateRecords(handle.context.keyId, {
    expectedSessionGeneration: handle.sessionGeneration,
    ...(capturedCorpusRevision === undefined ? {} : { expectedCorpusRevision: capturedCorpusRevision })
  })
  if (!isCurrentOfflineReadingHandle(handle)) throw readingCryptoOpaque()
  const snapshots: unknown[] = []
  const searches: unknown[] = []
  const policies: unknown[] = []
  const policyRecords: OfflinePrivateEnvelopeV1[] = []
  const pairs = new Map<string, { body?: OfflinePrivateEnvelopeV1; search?: OfflinePrivateEnvelopeV1 }>()
  const pairPages = new Map<string, string>()
  const policyPages = new Set<string>()
  const decryptedPolicyPages = new Map<string, OfflinePagePolicyRecord>()
  let policyState: OfflinePrivateEnvelopeV1 | undefined
  let decryptedPolicyState: OfflinePolicyState | undefined
  if (!Array.isArray(records)) throw readingCryptoOpaque()
  for (const record of records) {
    const parsedRecord = OfflinePrivateEnvelopeV1Schema.safeParse(record)
    if (!parsedRecord.success) throw readingCryptoOpaque()
    const value = parsedRecord.data
    if (value.kind === 'snapshot' || value.kind === 'search') {
      const pageKey = `${value.pageId}\u0000${value.locale}`
      const pairKey = JSON.stringify([value.pageId, value.locale, value.pairId, value.recordRevision])
      const existingPairKey = pairPages.get(pageKey)
      if (existingPairKey !== undefined && existingPairKey !== pairKey) throw readingCryptoOpaque()
      pairPages.set(pageKey, pairKey)
      const pair = pairs.get(pairKey) ?? {}
      if (value.kind === 'snapshot') {
        if (pair.body) throw readingCryptoOpaque()
        pair.body = value
      } else {
        if (pair.search) throw readingCryptoOpaque()
        pair.search = value
      }
      pairs.set(pairKey, pair)
      continue
    }
    if (value.kind === 'policy-state') {
      if (policyState) throw readingCryptoOpaque()
      policyState = value
    } else {
      const pageKey = `${value.pageId}\u0000${value.locale}`
      if (policyPages.has(pageKey)) throw readingCryptoOpaque()
      policyPages.add(pageKey)
    }
    policyRecords.push(value)
  }
  if (policyState && policyRecords.some(record => record.recordRevision !== policyState?.recordRevision)) throw readingCryptoOpaque()
  if (policyPages.size > 0 && !policyState) throw readingCryptoOpaque()
  for (const record of policyRecords) {
    const decoded = await decryptOfflinePrivateRecord(handle, record)
    if (record.kind === 'policy-state') {
      const parsedState = OfflinePolicyStateSchema.safeParse(decoded)
      if (!parsedState.success) throw readingCryptoOpaque()
      decryptedPolicyState = parsedState.data
    } else {
      const parsedPage = OfflinePagePolicyRecordSchema.safeParse(decoded)
      if (!parsedPage.success) throw readingCryptoOpaque()
      const pageKey = `${parsedPage.data.pageId}\u0000${parsedPage.data.locale}`
      if (!policyPages.has(pageKey) || parsedPage.data.key !== `${parsedPage.data.siteId}\u0000${parsedPage.data.pageId}\u0000${parsedPage.data.locale}`)
        throw readingCryptoOpaque()
      decryptedPolicyPages.set(pageKey, parsedPage.data)
    }
    policies.push(decoded)
  }
  if (
    policyRecords.length > 0 &&
    (!policyState ||
      !decryptedPolicyState ||
      !Number.isSafeInteger(decryptedPolicyState.policyRevision) ||
      policyState.recordRevision !== decryptedPolicyState.policyRevision + 1)
  )
    throw readingCryptoOpaque()
  if (pairs.size > 0) {
    if (!policyState || !decryptedPolicyState) throw readingCryptoOpaque()
    for (const pair of pairs.values()) {
      const page = pair.body ? decryptedPolicyPages.get(`${pair.body.pageId}\u0000${pair.body.locale}`) : undefined
      if (
        !pair.body ||
        !page ||
        page.availability !== 'available' ||
        page.excluded ||
        !(page.manual || page.tag || (decryptedPolicyState.automaticSavingEnabled && page.automatic))
      )
        throw readingCryptoOpaque()
    }
  }
  for (const pair of pairs.values()) {
    if (!pair.body || !pair.search) throw readingCryptoOpaque()
    if (
      pair.body.pageId !== pair.search.pageId ||
      pair.body.locale !== pair.search.locale ||
      pair.body.pairId !== pair.search.pairId ||
      pair.body.recordRevision !== pair.search.recordRevision
    )
      throw readingCryptoOpaque()
    const snapshot = await decryptOfflinePrivateRecord(handle, pair.body)
    const search = await decryptOfflinePrivateRecord(handle, pair.search)
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      !search ||
      typeof search !== 'object' ||
      !('sourceRevision' in snapshot) ||
      !('sourceRevision' in search) ||
      snapshot.sourceRevision !== search.sourceRevision
    )
      throw readingCryptoOpaque()
    snapshots.push(snapshot)
    searches.push(search)
  }
  if (!isCurrentOfflineReadingHandle(handle)) throw readingCryptoOpaque()
  return { snapshots, searchDocuments: searches, policies, corpusRevision: capturedCorpusRevision }
}

const privateSubtle = (): SubtleCrypto => {
  if (!globalThis.crypto?.subtle) throw readingCryptoOpaque()
  return globalThis.crypto.subtle
}

export const encryptOfflinePrivateRecord = async (
  handle: OfflineReadingHandleV1,
  kind: OfflinePrivateEnvelopeKind,
  payload: OfflinePrivateRecordPayload,
  rawSelectors: OfflinePrivateRecordSelectors
): Promise<OfflinePrivateEnvelopeV1> => {
  if (!isCurrentOfflineReadingHandle(handle)) throw readingCryptoOpaque()
  const selectors = { ...rawSelectors }
  const nonce = readingNonce()
  let aad: Uint8Array | undefined
  let plaintext: Uint8Array | undefined
  let ciphertext: Uint8Array | undefined
  let returned = false
  try {
    const parsedPayload = canonicalPrivatePayload(kind, payload, handle.context, selectors)
    const serialized = JSON.stringify(parsedPayload)
    if (serialized === undefined) throw readingCryptoOpaque()
    plaintext = new TextEncoder().encode(serialized)
    if (plaintext.byteLength > OFFLINE_PRIVATE_RECORD_BYTES_LIMIT) throw readingCryptoOpaque()
    aad = encodeOfflinePrivateRecordAad(handle, kind, selectors, nonce)
    ciphertext = new Uint8Array(
      await privateSubtle().encrypt(
        { name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: OFFLINE_READING_TAG_BYTES * 8 },
        requireCurrentOfflineReadingKey(handle),
        plaintext as unknown as BufferSource
      )
    )
    if (ciphertext.byteLength < OFFLINE_READING_TAG_BYTES || ciphertext.byteLength > OFFLINE_PRIVATE_RECORD_BYTES_LIMIT) throw readingCryptoOpaque()
    const envelope = OfflinePrivateEnvelopeV1Schema.parse({
      schemaVersion: 1,
      context: handle.context,
      sessionGeneration: handle.sessionGeneration,
      kind,
      pageId: selectors.pageId,
      locale: selectors.locale,
      recordRevision: selectors.recordRevision,
      pairId: selectors.pairId,
      nonce,
      ciphertext
    })
    if (!isCurrentOfflineReadingHandle(handle)) throw readingCryptoOpaque()
    returned = true
    return envelope
  } catch (error) {
    if (error instanceof OfflineDraftOpaqueError) throw error
    throw readingCryptoOpaque()
  } finally {
    aad?.fill(0)
    plaintext?.fill(0)
    if (!returned) {
      ciphertext?.fill(0)
      nonce.fill(0)
    }
  }
}

export const decryptOfflinePrivateRecord = async (handle: OfflineReadingHandleV1, envelope: OfflinePrivateEnvelopeV1): Promise<unknown> => {
  let aad: Uint8Array | undefined
  let plaintext: Uint8Array | undefined
  try {
    const parsed = OfflinePrivateEnvelopeV1Schema.safeParse(envelope)
    if (!parsed.success) throw readingCryptoOpaque()
    const value = parsed.data
    if (value.sessionGeneration !== handle.sessionGeneration || JSON.stringify(value.context) !== JSON.stringify(handle.context)) throw readingCryptoOpaque()
    if (!isCurrentOfflineReadingHandle(handle)) throw readingCryptoOpaque()
    aad = encodeOfflinePrivateRecordAad(
      handle,
      value.kind,
      { pageId: value.pageId, locale: value.locale, recordRevision: value.recordRevision, pairId: value.pairId },
      value.nonce
    )
    plaintext = new Uint8Array(
      await privateSubtle().decrypt(
        {
          name: 'AES-GCM',
          iv: value.nonce as unknown as BufferSource,
          additionalData: aad as unknown as BufferSource,
          tagLength: OFFLINE_READING_TAG_BYTES * 8
        },
        requireCurrentOfflineReadingKey(handle),
        value.ciphertext as unknown as BufferSource
      )
    )
    if (!isCurrentOfflineReadingHandle(handle)) throw readingCryptoOpaque()
    let decoded: unknown
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown
    } catch {
      throw readingCryptoOpaque()
    }
    const decodedPayload = parsePrivatePayload(value.kind, decoded)
    return assertPrivatePayloadIdentity(value.kind, decodedPayload, handle.context, {
      pageId: value.pageId,
      locale: value.locale,
      recordRevision: value.recordRevision,
      pairId: value.pairId
    })
  } catch (error) {
    if (error instanceof OfflineDraftOpaqueError) throw error
    throw readingCryptoOpaque()
  } finally {
    aad?.fill(0)
    plaintext?.fill(0)
  }
}

export const encryptOfflineReadingRecord = encryptOfflinePrivateRecord
export const decryptOfflineReadingRecord = decryptOfflinePrivateRecord
export { lockOfflineReading }
export type { OfflineReadingHandleV1 }
export {
  decodeOfflineReadingSecret,
  encodeOfflineReadingSecret,
  enrollOfflineReading,
  generateOfflineReadingSecret,
  parseOfflineReadingKeyFrame,
  unlockOfflineReading,
  wrapOfflineReadingKey,
  unwrapOfflineReadingKey
} from './offline-session.ts'
export type { OfflineDraftKeyHandle, ParsedDraftKeyFrame, DraftKeyFrameExpectation, DraftKeyRequestOptions } from './offline-session.ts'
