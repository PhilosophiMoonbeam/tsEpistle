import { DraftKeyContextSchema, OFFLINE_DRAFT_KEY_BYTES, OFFLINE_DRAFT_KEY_MAGIC, OFFLINE_KEY_VERSION, type DraftKeyContext } from '../../shared/offline.ts'

const MAX_FRAME_BYTES = 16 * 1024
const MAX_CANONICAL_ORIGIN_BYTES = 8 * 1024
const MAX_SITE_ID_BYTES = 1024
const MAGIC_BYTES = new TextEncoder().encode(OFFLINE_DRAFT_KEY_MAGIC)

export type DraftKeyFrameExpectation = {
  readonly canonicalOrigin: string
  readonly expectedAccountId: number
  readonly expectedSessionGeneration: number
}

export type ParsedDraftKeyFrame = {
  readonly context: DraftKeyContext
  readonly sessionGeneration: number
  /** Raw key material exists only until requestDraftKey imports it. */
  readonly keyBytes: Uint8Array
}

export type OfflineDraftKeyHandle = {
  readonly context: DraftKeyContext
  readonly sessionGeneration: number
  readonly key: CryptoKey
}

export type DraftKeyRequestOptions = {
  readonly expectedAccountId: number
  readonly expectedSessionGeneration: number
  readonly signal?: AbortSignal
}

export class OfflineDraftOpaqueError extends Error {
  readonly code = 'opaque' as const
  readonly deleteOnly = true as const

  constructor() {
    super('The offline draft is unavailable.')
    this.name = 'OfflineDraftOpaqueError'
  }
}

export class OfflineDraftSessionError extends Error {
  readonly code = 'session' as const

  constructor(message = 'The offline draft session is unavailable.') {
    super(message)
    this.name = 'OfflineDraftSessionError'
  }
}

const opaque = (): OfflineDraftOpaqueError => new OfflineDraftOpaqueError()

const isSafeNonnegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const isSafePositiveInteger = (value: unknown): value is number => isSafeNonnegativeInteger(value) && value > 0

const assertExpected = (expected: DraftKeyFrameExpectation): DraftKeyFrameExpectation => {
  if (
    !expected ||
    typeof expected.canonicalOrigin !== 'string' ||
    expected.canonicalOrigin.length < 1 ||
    expected.canonicalOrigin.length > 2048 ||
    !isSafePositiveInteger(expected.expectedAccountId) ||
    !isSafeNonnegativeInteger(expected.expectedSessionGeneration)
  )
    throw opaque()
  return expected
}

const canonicalOrigin = (value: string): string => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw opaque()
  }
  const localHttp = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (
    parsed.origin !== value ||
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHttp)) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  )
    throw opaque()
  return parsed.origin
}

const frameBytes = (bytes: ArrayBuffer | Uint8Array): Uint8Array => {
  const result = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (result.byteLength < MAGIC_BYTES.byteLength || result.byteLength > MAX_FRAME_BYTES) throw opaque()
  return result
}

const readMagic = (bytes: Uint8Array, offset: number): number => {
  if (offset + MAGIC_BYTES.byteLength > bytes.byteLength) throw opaque()
  for (let index = 0; index < MAGIC_BYTES.byteLength; index += 1) {
    if (bytes[offset + index] !== MAGIC_BYTES[index]) throw opaque()
  }
  return offset + MAGIC_BYTES.byteLength
}

const readLength = (view: DataView, offset: number): number => {
  if (offset + 4 > view.byteLength) throw opaque()
  return view.getUint32(offset, false)
}

const readLpUtf8 = (bytes: Uint8Array, view: DataView, offset: number, maximumBytes: number): { readonly value: string; readonly offset: number } => {
  const length = readLength(view, offset)
  const valueOffset = offset + 4
  if (length > maximumBytes || length > bytes.byteLength - valueOffset) throw opaque()
  const valueBytes = bytes.subarray(valueOffset, valueOffset + length)
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(valueBytes)
  } catch {
    throw opaque()
  }
  return { value, offset: valueOffset + length }
}

const readU64 = (view: DataView, offset: number): { readonly value: number; readonly offset: number } => {
  if (offset + 8 > view.byteLength) throw opaque()
  const value = view.getBigUint64(offset, false)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw opaque()
  return { value: Number(value), offset: offset + 8 }
}

/**
 * Parses and validates the exact TSODK1 response frame. The returned keyBytes
 * must be consumed immediately and cleared by the caller.
 */
export const parseDraftKeyFrame = (input: ArrayBuffer | Uint8Array, rawExpected: DraftKeyFrameExpectation): ParsedDraftKeyFrame => {
  const expected = assertExpected(rawExpected)
  try {
    const bytes = frameBytes(input)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = readMagic(bytes, 0)
    const originField = readLpUtf8(bytes, view, offset, MAX_CANONICAL_ORIGIN_BYTES)
    offset = originField.offset
    const siteField = readLpUtf8(bytes, view, offset, MAX_SITE_ID_BYTES)
    offset = siteField.offset
    const accountField = readU64(view, offset)
    offset = accountField.offset
    const authField = readU64(view, offset)
    offset = authField.offset
    const versionField = readLpUtf8(bytes, view, offset, OFFLINE_KEY_VERSION.length)
    offset = versionField.offset
    if (offset + OFFLINE_DRAFT_KEY_BYTES !== bytes.byteLength) throw opaque()

    const origin = canonicalOrigin(originField.value)
    if (origin !== canonicalOrigin(expected.canonicalOrigin)) throw opaque()
    if (siteField.value.length < 1 || siteField.value.length > 256 || siteField.value.trim() !== siteField.value) throw opaque()
    if (accountField.value !== expected.expectedAccountId || !isSafePositiveInteger(accountField.value)) throw opaque()
    if (!isSafeNonnegativeInteger(authField.value) || versionField.value !== OFFLINE_KEY_VERSION) throw opaque()

    const parsedContext = DraftKeyContextSchema.safeParse({
      canonicalOrigin: origin,
      siteId: siteField.value,
      accountId: accountField.value,
      authVersion: authField.value,
      keyVersion: versionField.value
    })
    if (!parsedContext.success) throw opaque()

    const context = Object.freeze(parsedContext.data) as DraftKeyContext
    return {
      context,
      sessionGeneration: expected.expectedSessionGeneration,
      keyBytes: new Uint8Array(bytes.slice(offset, offset + OFFLINE_DRAFT_KEY_BYTES))
    }
  } catch (error) {
    if (error instanceof OfflineDraftOpaqueError) throw error
    throw opaque()
  }
}

type RegistryEntry = {
  readonly handle: OfflineDraftKeyHandle
  readonly epoch: number
}

const identity = (accountId: number, sessionGeneration: number): string => `${accountId}:${sessionGeneration}`
const registry = new Map<string, RegistryEntry>()
const pendingRequests = new Set<AbortController>()
let registryEpoch = 0
let activeAccountId: number | undefined
let activeSessionGeneration: number | undefined

const currentEntry = (accountId: number, sessionGeneration: number): RegistryEntry | undefined => registry.get(identity(accountId, sessionGeneration))

const clearRegistry = (): void => {
  registryEpoch += 1
  registry.clear()
  activeAccountId = undefined
  activeSessionGeneration = undefined
  for (const controller of pendingRequests) controller.abort()
}
const SESSION_CHANNEL_NAME = 'tsepistle-offline-session'
const SESSION_INVALIDATION_MESSAGE = 'invalidate'
export const OFFLINE_SESSION_INVALIDATED_EVENT = 'tsepistle:offline-session-invalidated'
let sessionChannel: BroadcastChannel | null | undefined

const dispatchSessionInvalidation = (): void => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof Event === 'undefined') return
  try {
    // Deliberately carry no account, generation, or other identity-bearing data.
    window.dispatchEvent(new Event(OFFLINE_SESSION_INVALIDATED_EVENT))
  } catch {
    // Generation fencing remains authoritative if an optional observer fails.
  }
}

const onSessionChannelMessage = (event: MessageEvent<unknown>): void => {
  if (event.data === SESSION_INVALIDATION_MESSAGE) {
    clearRegistry()
    dispatchSessionInvalidation()
  }
}
const ensureSessionChannel = (): BroadcastChannel | null => {
  if (sessionChannel !== undefined) return sessionChannel
  if (typeof BroadcastChannel === 'undefined') {
    sessionChannel = null
    return sessionChannel
  }
  try {
    const channel = new BroadcastChannel(SESSION_CHANNEL_NAME)
    channel.addEventListener('message', onSessionChannelMessage)
    sessionChannel = channel
  } catch {
    sessionChannel = null
  }
  return sessionChannel
}


const broadcastSessionInvalidation = (): void => {
  const channel = ensureSessionChannel()
  try {
    channel?.postMessage(SESSION_INVALIDATION_MESSAGE)
  } catch {
    // Cross-tab coordination is best effort; generation fencing is authoritative.
  }
}

const validRequestOptions = (options: DraftKeyRequestOptions): DraftKeyRequestOptions => {
  if (!options || !isSafePositiveInteger(options.expectedAccountId) || !isSafeNonnegativeInteger(options.expectedSessionGeneration)) throw opaque()
  return options
}

const currentOrigin = (): string => {
  if (typeof window === 'undefined' || !window.location) throw new OfflineDraftSessionError()
  return canonicalOrigin(window.location.origin)
}

const assertRequestCurrent = (accountId: number, sessionGeneration: number, epoch: number): void => {
  if (registryEpoch !== epoch || activeAccountId !== accountId || activeSessionGeneration !== sessionGeneration) throw opaque()
}

const contentTypeIsOctetStream = (response: Response): boolean => {
  const contentType = response.headers.get('content-type')
  if (contentType === null) return false
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/octet-stream'
}

/** Requests and imports one server-authoritative draft key for the captured owner/generation. */
export const requestDraftKey = async (fetchImpl: typeof window.fetch, rawOptions: DraftKeyRequestOptions): Promise<OfflineDraftKeyHandle> => {
  const options = validRequestOptions(rawOptions)
  const origin = currentOrigin()
  const endpoint = new URL('/_api/offline/draft-key', origin)
  if (endpoint.origin !== origin) throw new OfflineDraftSessionError()
  ensureSessionChannel()

  if (
    (activeAccountId !== undefined && activeAccountId !== options.expectedAccountId) ||
    (activeSessionGeneration !== undefined && activeSessionGeneration !== options.expectedSessionGeneration)
  )
    throw opaque()
  activeAccountId = options.expectedAccountId
  activeSessionGeneration = options.expectedSessionGeneration
  const entryBefore = currentEntry(options.expectedAccountId, options.expectedSessionGeneration)

  const epoch = registryEpoch
  const controller = new AbortController()
  const externalSignal = options.signal
  const abortExternal = (): void => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', abortExternal, { once: true })
  pendingRequests.add(controller)

  let frame: Uint8Array | undefined
  let parsed: ParsedDraftKeyFrame | undefined
  let imported: CryptoKey | undefined
  try {
    const response = await fetchImpl(endpoint.href, {
      method: 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { accept: 'application/octet-stream' },
      signal: controller.signal
    })
    assertRequestCurrent(options.expectedAccountId, options.expectedSessionGeneration, epoch)
    if (!response.ok || !contentTypeIsOctetStream(response)) throw opaque()
    const buffer = await response.arrayBuffer()
    frame = new Uint8Array(buffer)
    assertRequestCurrent(options.expectedAccountId, options.expectedSessionGeneration, epoch)
    parsed = parseDraftKeyFrame(frame, {
      canonicalOrigin: origin,
      expectedAccountId: options.expectedAccountId,
      expectedSessionGeneration: options.expectedSessionGeneration
    })
    assertRequestCurrent(options.expectedAccountId, options.expectedSessionGeneration, epoch)
    const subtle = globalThis.crypto?.subtle
    if (!subtle) throw new OfflineDraftSessionError('Web Crypto is unavailable.')
    imported = await subtle.importKey('raw', parsed.keyBytes as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    parsed.keyBytes.fill(0)
    assertRequestCurrent(options.expectedAccountId, options.expectedSessionGeneration, epoch)
    const handle = Object.freeze({
      context: parsed.context,
      sessionGeneration: parsed.sessionGeneration,
      key: imported
    }) as OfflineDraftKeyHandle
    imported = undefined
    registry.clear()
    registry.set(identity(handle.context.accountId, handle.sessionGeneration), { handle, epoch })
    return handle
  } catch (error) {
    const current = currentEntry(options.expectedAccountId, options.expectedSessionGeneration)
    if (registryEpoch === epoch && (current === undefined || current === entryBefore)) clearRegistry()
    parsed?.keyBytes.fill(0)
    imported = undefined
    if (error instanceof OfflineDraftOpaqueError || error instanceof OfflineDraftSessionError) throw error
    throw new OfflineDraftSessionError()
  } finally {
    frame?.fill(0)
    if (externalSignal) externalSignal.removeEventListener('abort', abortExternal)
    pendingRequests.delete(controller)
  }
}

/** Returns whether this handle is still the current owner/generation key. */
export const isCurrentOfflineDraftKey = (handle: OfflineDraftKeyHandle): boolean => {
  try {
    const accountId = handle.context.accountId
    const generation = handle.sessionGeneration
    const entry = registry.get(identity(accountId, generation))
    return entry?.handle === handle && entry.epoch === registryEpoch
  } catch {
    return false
  }
}

export const requireCurrentOfflineDraftKey = (handle: OfflineDraftKeyHandle): CryptoKey => {
  if (!isCurrentOfflineDraftKey(handle)) throw opaque()
  return handle.key
}

/** Drops all in-memory key references and fences every pending async result. */
export const invalidateOfflineSession = (expectedSessionGeneration?: number): void => {
  if (
    expectedSessionGeneration !== undefined &&
    (!isSafeNonnegativeInteger(expectedSessionGeneration) || (activeSessionGeneration !== undefined && activeSessionGeneration !== expectedSessionGeneration))
  )
    return
  clearRegistry()
  dispatchSessionInvalidation()
  broadcastSessionInvalidation()
}

/** Explicit alias for callers that need to drop only the in-memory key boundary. */
export const dropOfflineDraftKey = (): void => invalidateOfflineSession()
