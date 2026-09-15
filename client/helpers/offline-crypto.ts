import {
  OfflineDraftEnvelopeV1Schema,
  OfflineDraftPayloadV1Schema,
  OFFLINE_DRAFT_NONCE_BYTES,
  OFFLINE_DRAFT_TAG_BYTES,
  OFFLINE_KEY_VERSION,
  OFFLINE_RECORD_BYTES_LIMIT,
  OFFLINE_SCHEMA_VERSION,
  type OfflineDraftEnvelopeV1,
  type OfflineDraftPayloadV1
} from '../../shared/offline.ts'
import { isCurrentOfflineDraftKey, requireCurrentOfflineDraftKey, OfflineDraftOpaqueError, type OfflineDraftKeyHandle } from './offline-session.ts'

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
const encodeOfflineDraftAadForGeneration = (
  handle: OfflineDraftKeyHandle,
  rawInput: OfflineDraftAadInput,
  sessionGeneration: number
): Uint8Array => {
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
export const decryptOfflineDraftForReconciliation = async (
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
      value.submissionId !== null ||
      value.accountId !== handle.context.accountId ||
      value.authVersion !== handle.context.authVersion ||
      value.keyVersion !== handle.context.keyVersion ||
      value.sessionGeneration >= handle.sessionGeneration ||
      value.ciphertext.byteLength > OFFLINE_RECORD_BYTES_LIMIT
    )
      throw opaque()
    const key = requireCurrentOfflineDraftKey(handle)
    aad = encodeOfflineDraftAadForGeneration(handle, {
      recordId: value.recordId,
      draftRevision: value.draftRevision,
      submissionId: value.submissionId,
      nonce: value.nonce
    }, value.sessionGeneration)
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
    aad = encodeOfflineDraftAadForGeneration(handle, {
      recordId: value.recordId,
      draftRevision: value.draftRevision,
      submissionId: value.submissionId,
      nonce: value.nonce
    }, value.sessionGeneration)
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
export type { OfflineDraftKeyHandle, ParsedDraftKeyFrame, DraftKeyFrameExpectation, DraftKeyRequestOptions } from './offline-session.ts'
