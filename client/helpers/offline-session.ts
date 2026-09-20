import {
  DraftKeyContextSchema,
  OFFLINE_DRAFT_KEY_BYTES,
  OFFLINE_DRAFT_KEY_MAGIC,
  OFFLINE_KEY_VERSION,
  OFFLINE_READING_KEY_BYTES,
  OFFLINE_READING_KEY_MAGIC,
  OFFLINE_READING_KEY_VERSION,
  OFFLINE_READING_NONCE_BYTES,
  OFFLINE_READING_SALT_BYTES,
  OFFLINE_READING_TAG_BYTES,
  OfflineReadingContextV1Schema,
  OfflineReadingVaultV1Schema,
  type DraftKeyContext,
  type OfflineReadingContextV1,
  type OfflineReadingVaultV1
} from '../../shared/offline.ts'

const MAX_FRAME_BYTES = 16 * 1024
const MAX_CANONICAL_ORIGIN_BYTES = 8 * 1024
const MAX_SITE_ID_BYTES = 1024
const MAX_KEY_ID_BYTES = 128
const MAGIC_BYTES = new TextEncoder().encode(OFFLINE_DRAFT_KEY_MAGIC)
const READING_MAGIC_BYTES = new TextEncoder().encode(OFFLINE_READING_KEY_MAGIC)

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
      keyBytes: bytes.subarray(offset, offset + OFFLINE_DRAFT_KEY_BYTES)
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

type PendingKeyRequest = {
  readonly accountId: number
  readonly sessionGeneration: number
  readonly epoch: number
  readonly controller: AbortController
  readonly promise: Promise<OfflineDraftKeyHandle>
  consumers: number
  settled: boolean
}

const identity = (accountId: number, sessionGeneration: number): string => `${accountId}:${sessionGeneration}`
const registry = new Map<string, RegistryEntry>()
const pendingRequests = new Set<AbortController>()
const pendingKeyRequests = new Map<string, PendingKeyRequest>()
let registryEpoch = 0
let activeAccountId: number | undefined
let activeSessionGeneration: number | undefined
let sessionInvalidationInProgress = false
export type OfflineIdentityBoundaryReason = 'draft-key-denied' | 'unauthorized'

export type OfflineIdentityBoundaryRequest = {
  readonly accountId: number
  readonly reason: OfflineIdentityBoundaryReason
}

type OfflineIdentityBoundaryOwner = (request: OfflineIdentityBoundaryRequest) => Promise<boolean> | boolean
let identityBoundaryOwner: OfflineIdentityBoundaryOwner | undefined

type OfflineSessionInvalidationOwner = () => void
let offlineSessionInvalidationOwner: OfflineSessionInvalidationOwner | undefined

/** Registers the single global owner for persisted identity boundaries. */
export const registerOfflineIdentityBoundaryOwner = (owner: OfflineIdentityBoundaryOwner): (() => void) => {
  identityBoundaryOwner = owner
  return () => {
    if (identityBoundaryOwner === owner) identityBoundaryOwner = undefined
  }
}

/**
 * Requests an authoritative identity boundary. The registered owner performs
 * the synchronous local lock before awaiting its persisted generation CAS.
 */
export const requestOfflineIdentityBoundary = (request: OfflineIdentityBoundaryRequest): Promise<boolean> => {
  if (!isSafePositiveInteger(request.accountId)) {
    publishSessionInvalidation(true, true)
    return Promise.resolve(false)
  }
  const owner = identityBoundaryOwner
  if (!owner) {
    publishSessionInvalidation(true, true)
    return Promise.resolve(false)
  }
  try {
    return Promise.resolve(owner(request))
  } catch {
    publishSessionInvalidation(true, true)
    return Promise.resolve(false)
  }
}

const currentEntry = (accountId: number, sessionGeneration: number): RegistryEntry | undefined => registry.get(identity(accountId, sessionGeneration))

const clearRegistry = (preserveOwner = false): void => {
  registryEpoch += 1
  registry.clear()
  for (const request of pendingKeyRequests.values()) request.controller.abort()
  pendingKeyRequests.clear()
  if (!preserveOwner) {
    activeAccountId = undefined
    activeSessionGeneration = undefined
  }
  for (const controller of pendingRequests) controller.abort()
}
const SESSION_CHANNEL_NAME = 'tsepistle-offline-session'
const SESSION_INVALIDATION_MESSAGE = 'invalidate'
const SESSION_STORAGE_KEY = 'tsepistle-offline-session-invalidation'
export const OFFLINE_SESSION_INVALIDATED_EVENT = 'tsepistle:offline-session-invalidated'
let sessionChannel: BroadcastChannel | null | undefined
let sessionStorageListenerBound = false
let sessionNoticeCounter = 0
const seenSessionNoticeTokens = new Set<string>()

const rememberSessionNoticeToken = (token: string): boolean => {
  if (seenSessionNoticeTokens.has(token)) return false
  seenSessionNoticeTokens.add(token)
  if (seenSessionNoticeTokens.size > 32) {
    const oldest = seenSessionNoticeTokens.values().next().value
    if (typeof oldest === 'string') seenSessionNoticeTokens.delete(oldest)
  }
  return true
}

const nextSessionNoticeToken = (): string => {
  sessionNoticeCounter = sessionNoticeCounter >= Number.MAX_SAFE_INTEGER ? 1 : sessionNoticeCounter + 1
  let instanceToken = ''
  try {
    instanceToken = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : Math.random().toString(36).slice(2)
  } catch {
    instanceToken = Math.random().toString(36).slice(2)
  }
  return `${Date.now().toString(36)}:${sessionNoticeCounter.toString(36)}:${instanceToken}`
}

const dispatchSessionInvalidation = (): void => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof Event === 'undefined') return
  try {
    // Deliberately carry no account, generation, or other identity-bearing data.
    window.dispatchEvent(new Event(OFFLINE_SESSION_INVALIDATED_EVENT))
  } catch {
    // Generation fencing remains authoritative if an optional observer fails.
  }
}

const broadcastSessionInvalidation = (token: string): void => {
  const channel = ensureSessionChannel()
  try {
    channel?.postMessage({ type: SESSION_INVALIDATION_MESSAGE, token })
  } catch {
    // Cross-tab coordination is best effort; generation fencing is authoritative.
  }
}

const writeSessionInvalidationNotice = (token: string): void => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(SESSION_STORAGE_KEY, token)
  } catch {
    // localStorage is an optional transport; lifecycle revalidation remains authoritative.
  }
}

const emitSessionInvalidationNotice = (): void => {
  const token = nextSessionNoticeToken()
  rememberSessionNoticeToken(token)
  broadcastSessionInvalidation(token)
  writeSessionInvalidationNotice(token)
}

const publishSessionInvalidation = (broadcast: boolean, preserveOwner = false): void => {
  if (sessionInvalidationInProgress) return
  sessionInvalidationInProgress = true
  try {
    clearRegistry(preserveOwner)
    if (typeof lockOfflineReading === 'function') lockOfflineReading()
    dispatchSessionInvalidation()
    if (broadcast) emitSessionInvalidationNotice()
  } finally {
    sessionInvalidationInProgress = false
  }
}

/**
 * Publishes the committed generation/vault boundary after the storage
 * transaction has completed. Generation/vault callers already lock reading
 * state before beginning their transaction, so this avoids a second reading
 * mutation while still fencing draft keys and notifying local observers.
 */
export const publishOfflineSessionInvalidationNotice = (): void => {
  if (sessionInvalidationInProgress) return
  sessionInvalidationInProgress = true
  try {
    clearRegistry()
    dispatchSessionInvalidation()
    emitSessionInvalidationNotice()
  } finally {
    sessionInvalidationInProgress = false
  }
}

const onRemoteSessionInvalidation = (): void => {
  publishSessionInvalidation(false)
  try {
    offlineSessionInvalidationOwner?.()
  } catch {
    // A remote observer cannot undo the in-memory session fence.
  }
}

const onSessionChannelMessage = (event: MessageEvent<unknown>): void => {
  const value = event.data
  const message = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  const token =
    message?.type === SESSION_INVALIDATION_MESSAGE && typeof message.token === 'string'
      ? message.token
      : value === SESSION_INVALIDATION_MESSAGE
        ? null
        : undefined
  if (token === undefined || (token !== null && !rememberSessionNoticeToken(token))) return
  onRemoteSessionInvalidation()
}

const onSessionStorageEvent = (event: StorageEvent): void => {
  if (event.key !== SESSION_STORAGE_KEY || typeof event.newValue !== 'string' || !rememberSessionNoticeToken(event.newValue)) return
  onRemoteSessionInvalidation()
}

const ensureSessionStorageListener = (): void => {
  if (sessionStorageListenerBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
  try {
    window.addEventListener('storage', onSessionStorageEvent)
    sessionStorageListenerBound = true
  } catch {
    // Event listeners are optional in non-browser test/runtime environments.
  }
}

const ensureSessionChannel = (): BroadcastChannel | null => {
  ensureSessionStorageListener()
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

/** Registers the single owner for remote session invalidations and opens the transports eagerly. */
export const registerOfflineSessionInvalidationOwner = (owner: OfflineSessionInvalidationOwner): (() => void) => {
  offlineSessionInvalidationOwner = owner
  ensureSessionChannel()
  return () => {
    if (offlineSessionInvalidationOwner === owner) offlineSessionInvalidationOwner = undefined
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

const assertRequestCurrent = (accountId: number, sessionGeneration: number, epoch: number, signal?: AbortSignal): void => {
  if (signal?.aborted || registryEpoch !== epoch || activeAccountId !== accountId || activeSessionGeneration !== sessionGeneration) throw opaque()
}

const contentTypeIsOctetStream = (response: Response): boolean => {
  const contentType = response.headers.get('content-type')
  if (contentType === null) return false
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/octet-stream'
}

const callerAbortError = (): Error => {
  try {
    return new DOMException('The offline draft key request was aborted.', 'AbortError')
  } catch {
    return new OfflineDraftSessionError('The offline draft key request was aborted.')
  }
}

const cancelResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel()
  } catch {
    // The response is already unusable; the bounded reader remains authoritative.
  }
}
const readBoundedFrame = async (response: Response, signal: AbortSignal, assertCurrent: () => void): Promise<Uint8Array> => {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const parsedLength = Number(contentLength)
    if (Number.isFinite(parsedLength) && parsedLength > MAX_FRAME_BYTES) {
      await cancelResponseBody(response)
      assertCurrent()
      throw opaque()
    }
  }
  const body = response.body
  if (!body) throw opaque()
  const reader = body.getReader()
  const cancelReader = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', cancelReader, { once: true })
  const frame = new Uint8Array(MAX_FRAME_BYTES)
  let offset = 0
  let complete = false
  try {
    while (true) {
      const result = await reader.read()
      assertCurrent()
      if (result.done) break
      const chunk = result.value
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_FRAME_BYTES - offset) {
        try {
          await reader.cancel()
        } catch {
          // The stream is rejected below even when cancellation itself fails.
        }
        assertCurrent()
        throw opaque()
      }
      frame.set(chunk, offset)
      offset += chunk.byteLength
    }
    if (offset < MAGIC_BYTES.byteLength) throw opaque()
    complete = true
    return frame.subarray(0, offset)
  } finally {
    signal.removeEventListener('abort', cancelReader)
    reader.releaseLock()
    if (!complete) frame.fill(0)
  }
}
const acquireDraftKey = async (
  fetchImpl: typeof window.fetch,
  options: DraftKeyRequestOptions,
  origin: string,
  controller: AbortController,
  epoch: number
): Promise<OfflineDraftKeyHandle> => {
  const { expectedAccountId: accountId, expectedSessionGeneration: sessionGeneration } = options
  const endpoint = new URL('/_api/offline/draft-key', origin)
  if (endpoint.origin !== origin) throw new OfflineDraftSessionError()
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
    assertRequestCurrent(accountId, sessionGeneration, epoch, controller.signal)
    if (!response.ok || !contentTypeIsOctetStream(response)) {
      await cancelResponseBody(response)
      assertRequestCurrent(accountId, sessionGeneration, epoch, controller.signal)
      throw opaque()
    }
    frame = await readBoundedFrame(response, controller.signal, () => assertRequestCurrent(accountId, sessionGeneration, epoch, controller.signal))
    assertRequestCurrent(accountId, sessionGeneration, epoch, controller.signal)
    parsed = parseDraftKeyFrame(frame, {
      canonicalOrigin: origin,
      expectedAccountId: accountId,
      expectedSessionGeneration: sessionGeneration
    })
    assertRequestCurrent(accountId, sessionGeneration, epoch, controller.signal)
    const subtle = globalThis.crypto?.subtle
    if (!subtle) throw new OfflineDraftSessionError('Web Crypto is unavailable.')
    imported = await subtle.importKey('raw', parsed.keyBytes as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    assertRequestCurrent(accountId, sessionGeneration, epoch, controller.signal)
    if (!imported) throw new OfflineDraftSessionError('The offline draft key could not be imported.')
    parsed.keyBytes.fill(0)
    const handle = Object.freeze({
      context: parsed.context,
      sessionGeneration: parsed.sessionGeneration,
      key: imported
    }) as OfflineDraftKeyHandle
    assertRequestCurrent(accountId, sessionGeneration, epoch, controller.signal)
    if (currentEntry(accountId, sessionGeneration) !== undefined) throw opaque()
    registry.clear()
    registry.set(identity(accountId, sessionGeneration), { handle, epoch })
    imported = undefined
    return handle
  } catch (error) {
    if (!controller.signal.aborted && registryEpoch === epoch && activeAccountId === accountId && activeSessionGeneration === sessionGeneration) {
      await requestOfflineIdentityBoundary({ accountId, reason: 'draft-key-denied' })
    }
    if (error instanceof OfflineDraftOpaqueError || error instanceof OfflineDraftSessionError) throw error
    throw new OfflineDraftSessionError()
  } finally {
    parsed?.keyBytes.fill(0)
    frame?.fill(0)
    imported = undefined
  }
}

const createPendingKeyRequest = (fetchImpl: typeof window.fetch, options: DraftKeyRequestOptions, origin: string): PendingKeyRequest => {
  const key = identity(options.expectedAccountId, options.expectedSessionGeneration)
  const controller = new AbortController()
  const epoch = registryEpoch
  let acquisition: PendingKeyRequest
  const promise = acquireDraftKey(fetchImpl, options, origin, controller, epoch).finally(() => {
    acquisition.settled = true
    if (pendingKeyRequests.get(key) === acquisition) pendingKeyRequests.delete(key)
    pendingRequests.delete(controller)
  })
  acquisition = {
    accountId: options.expectedAccountId,
    sessionGeneration: options.expectedSessionGeneration,
    epoch,
    controller,
    promise,
    consumers: 0,
    settled: false
  }
  pendingKeyRequests.set(key, acquisition)
  pendingRequests.add(controller)
  void promise.catch(() => undefined)
  return acquisition
}

const releasePendingConsumer = (acquisition: PendingKeyRequest): void => {
  acquisition.consumers = Math.max(0, acquisition.consumers - 1)
  if (acquisition.consumers !== 0 || acquisition.settled) return
  const key = identity(acquisition.accountId, acquisition.sessionGeneration)
  if (pendingKeyRequests.get(key) === acquisition) pendingKeyRequests.delete(key)
  acquisition.controller.abort()
}

const waitForPendingKey = async (acquisition: PendingKeyRequest, signal: AbortSignal | undefined): Promise<OfflineDraftKeyHandle> => {
  acquisition.consumers += 1
  let onAbort: (() => void) | undefined
  try {
    if (signal?.aborted) throw callerAbortError()
    let result: OfflineDraftKeyHandle
    if (!signal) {
      result = await acquisition.promise
    } else {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(callerAbortError())
        signal.addEventListener('abort', onAbort, { once: true })
      })
      result = await Promise.race([acquisition.promise, aborted])
    }
    if (signal?.aborted) throw callerAbortError()
    assertRequestCurrent(acquisition.accountId, acquisition.sessionGeneration, acquisition.epoch, undefined)
    if (currentEntry(acquisition.accountId, acquisition.sessionGeneration)?.handle !== result) throw opaque()
    return result
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
    releasePendingConsumer(acquisition)
  }
}

/** Requests and imports one server-authoritative draft key for the captured owner/generation. */
export const requestDraftKey = async (fetchImpl: typeof window.fetch, rawOptions: DraftKeyRequestOptions): Promise<OfflineDraftKeyHandle> => {
  const options = validRequestOptions(rawOptions)
  if (options.signal?.aborted) throw callerAbortError()
  const origin = currentOrigin()
  ensureSessionChannel()

  if (
    (activeAccountId !== undefined && activeAccountId !== options.expectedAccountId) ||
    (activeSessionGeneration !== undefined && activeSessionGeneration !== options.expectedSessionGeneration)
  )
    throw opaque()
  activeAccountId = options.expectedAccountId
  activeSessionGeneration = options.expectedSessionGeneration

  const existing = currentEntry(options.expectedAccountId, options.expectedSessionGeneration)
  if (existing) {
    if (options.signal?.aborted) throw callerAbortError()
    assertRequestCurrent(options.expectedAccountId, options.expectedSessionGeneration, existing.epoch, undefined)
    return existing.handle
  }

  const key = identity(options.expectedAccountId, options.expectedSessionGeneration)
  const acquisition = pendingKeyRequests.get(key) ?? createPendingKeyRequest(fetchImpl, options, origin)
  return await waitForPendingKey(acquisition, options.signal)
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
    (!isSafeNonnegativeInteger(expectedSessionGeneration) || activeSessionGeneration === undefined || activeSessionGeneration !== expectedSessionGeneration)
  )
    return
  publishSessionInvalidation(true)
}

/** Explicit alias for callers that need to drop only the in-memory key boundary. */
export const dropOfflineDraftKey = (): void => invalidateOfflineSession()
export type OfflineReadingKeyFrameExpectation = {
  readonly canonicalOrigin: string
  readonly expectedAccountId: number
  readonly expectedSessionGeneration: number
  readonly expectedAuthVersion?: number
  readonly expectedSiteId?: string
}

export type ParsedOfflineReadingKeyFrame = {
  readonly context: OfflineReadingContextV1
  /** Raw key material exists only until the caller imports and clears it. */
  readonly keyBytes: Uint8Array
}

const offlineReadingHandleBrand = Symbol('offline-reading-handle')
export type OfflineReadingHandleV1 = {
  readonly [offlineReadingHandleBrand]: true
  readonly context: OfflineReadingContextV1
  readonly sessionGeneration: number
  readonly key: CryptoKey
}

export type OfflineReadingVaultStorage = {
  readonly currentSessionGeneration: () => Promise<number>
  readonly getReadingVault: () => Promise<OfflineReadingVaultV1 | null>
  readonly putReadingVault: (vault: OfflineReadingVaultV1, options?: { readonly expectedSessionGeneration?: number }) => Promise<unknown>
}

export type OfflineReadingEnrollmentOptions = {
  readonly expectedAccountId: number
  readonly expectedSessionGeneration: number
  readonly expectedAuthVersion?: number
  readonly signal?: AbortSignal
  readonly confirmSecret?: Uint8Array | string | ((displaySecret: string) => Promise<boolean> | boolean)
}

const readingRegistry = new Map<string, { readonly handle: OfflineReadingHandleV1; readonly epoch: number }>()
let readingRegistryEpoch = 0
let activeReadingHandle: OfflineReadingHandleV1 | undefined
let activeReadingStorage: Pick<OfflineReadingVaultStorage, 'currentSessionGeneration' | 'getReadingVault'> | undefined
let readingWindowLifecycleBound = false
let readingDocumentLifecycleBound = false
let readingRevalidationInFlight: Promise<void> | null = null

export const OFFLINE_READING_STATE_EVENT = 'tsepistle:offline-reading-state'

const dispatchReadingState = (): void => {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof Event === 'undefined') return
  try {
    window.dispatchEvent(new Event(OFFLINE_READING_STATE_EVENT))
  } catch {
    // Generation fencing remains authoritative if an optional observer fails.
  }
}
const sameReadingContext = (left: OfflineReadingContextV1, right: OfflineReadingContextV1): boolean =>
  left.canonicalOrigin === right.canonicalOrigin &&
  left.siteId === right.siteId &&
  left.accountId === right.accountId &&
  left.authVersion === right.authVersion &&
  left.keyVersion === right.keyVersion &&
  left.keyId === right.keyId
const revalidateReadingIdentity = async (
  handle: OfflineReadingHandleV1,
  storage: Pick<OfflineReadingVaultStorage, 'currentSessionGeneration' | 'getReadingVault'>
): Promise<void> => {
  try {
    const [generation, vaultValue] = await Promise.all([storage.currentSessionGeneration(), storage.getReadingVault()])
    if (generation !== handle.sessionGeneration || !vaultValue) throw readingOpaque()
    const vault = OfflineReadingVaultV1Schema.safeParse(vaultValue)
    if (!vault.success || vault.data.sessionGeneration !== handle.sessionGeneration || !sameReadingContext(vault.data.context, handle.context))
      throw readingOpaque()
  } catch {
    // The synchronous lifecycle fence already hid private state. Re-unlock is
    // deliberately never attempted from this best-effort revalidation.
  }
}

const scheduleReadingRevalidation = (): void => {
  const handle = activeReadingHandle
  const storage = activeReadingStorage
  if (readingRevalidationInFlight || !handle || !storage) return
  // A lifecycle boundary is a synchronous privacy fence. The persisted
  // identity is checked only after the handle has been discarded.
  publishSessionInvalidation(false)
  const pending = revalidateReadingIdentity(handle, storage).finally(() => {
    if (readingRevalidationInFlight === pending) readingRevalidationInFlight = null
  })
  readingRevalidationInFlight = pending
}

const ensureReadingLifecycle = (): void => {
  ensureSessionChannel()
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !readingWindowLifecycleBound) {
    try {
      window.addEventListener('focus', scheduleReadingRevalidation)
      window.addEventListener('pageshow', scheduleReadingRevalidation)
      readingWindowLifecycleBound = true
    } catch {
      // Lifecycle events are optional in non-browser test/runtime environments.
    }
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' && !readingDocumentLifecycleBound) {
    try {
      document.addEventListener('visibilitychange', scheduleReadingRevalidation)
      readingDocumentLifecycleBound = true
    } catch {
      // Lifecycle events are optional in non-browser test/runtime environments.
    }
  }
}

const readingOpaque = (): OfflineDraftOpaqueError => new OfflineDraftOpaqueError()
const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

const base64UrlDecode = (value: string, expectedBytes: number): Uint8Array => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length !== Math.ceil((expectedBytes * 8) / 6)) throw readingOpaque()
  const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '==='.slice((value.length + 3) % 4)
  let decoded: string
  try {
    decoded = atob(padded)
  } catch {
    throw readingOpaque()
  }
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0))
  if (bytes.byteLength !== expectedBytes || base64UrlEncode(bytes) !== value) throw readingOpaque()
  return bytes
}

export const encodeOfflineReadingSecret = (secretBytes: Uint8Array): string => {
  if (!(secretBytes instanceof Uint8Array) || secretBytes.byteLength !== OFFLINE_READING_KEY_BYTES) throw readingOpaque()
  return base64UrlEncode(secretBytes)
}

export const decodeOfflineReadingSecret = (displaySecret: string): Uint8Array => base64UrlDecode(displaySecret, OFFLINE_READING_KEY_BYTES)

export const generateOfflineReadingSecret = (): Uint8Array => {
  const secret = new Uint8Array(OFFLINE_READING_KEY_BYTES)
  if (!globalThis.crypto?.getRandomValues) throw new OfflineDraftSessionError('Web Crypto is unavailable.')
  globalThis.crypto.getRandomValues(secret)
  return secret
}

const readingIdentity = (context: OfflineReadingContextV1, generation: number): string =>
  `${context.keyId}:${context.accountId}:${context.authVersion}:${generation}`

const readingSubtle = (): SubtleCrypto => {
  if (!globalThis.crypto?.subtle) throw new OfflineDraftSessionError('Web Crypto is unavailable.')
  return globalThis.crypto.subtle
}

const lpUtf8Reading = (value: string): Uint8Array => {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength > 0xffffffff) throw readingOpaque()
  const result = new Uint8Array(4 + bytes.byteLength)
  new DataView(result.buffer).setUint32(0, bytes.byteLength, false)
  result.set(bytes, 4)
  return result
}

const u32Reading = (value: number): Uint8Array => {
  if (!isSafeNonnegativeInteger(value) || value > 0xffffffff) throw readingOpaque()
  const result = new Uint8Array(4)
  new DataView(result.buffer).setUint32(0, value, false)
  return result
}

const u64Reading = (value: number): Uint8Array => {
  if (!isSafeNonnegativeInteger(value)) throw readingOpaque()
  const result = new Uint8Array(8)
  new DataView(result.buffer).setBigUint64(0, BigInt(value), false)
  return result
}

const lpBytesReading = (value: Uint8Array): Uint8Array => {
  const result = new Uint8Array(4 + value.byteLength)
  result.set(u32Reading(value.byteLength), 0)
  result.set(value, 4)
  return result
}

const concatReading = (parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

export const encodeOfflineReadingContext = (context: OfflineReadingContextV1): Uint8Array => {
  const parsed = OfflineReadingContextV1Schema.parse(context)
  return concatReading([
    lpUtf8Reading(parsed.canonicalOrigin),
    lpUtf8Reading(parsed.siteId),
    u64Reading(parsed.accountId),
    u64Reading(parsed.authVersion),
    lpUtf8Reading(parsed.keyVersion),
    lpUtf8Reading(parsed.keyId)
  ])
}

export const encodeOfflineReadingWrapAad = (context: OfflineReadingContextV1, generation: number, salt: Uint8Array, nonce: Uint8Array): Uint8Array => {
  const parsed = OfflineReadingContextV1Schema.parse(context)
  if (!isSafeNonnegativeInteger(generation) || salt.byteLength !== OFFLINE_READING_SALT_BYTES || nonce.byteLength !== OFFLINE_READING_NONCE_BYTES)
    throw readingOpaque()
  return concatReading([
    lpUtf8Reading('tsepistle/offline-reading-vault/v1'),
    u32Reading(1),
    encodeOfflineReadingContext(parsed),
    u64Reading(generation),
    lpBytesReading(salt),
    lpBytesReading(nonce)
  ])
}

export const deriveOfflineReadingWrappingKey = async (
  secretBytes: Uint8Array,
  context: OfflineReadingContextV1,
  generation: number,
  salt: Uint8Array
): Promise<CryptoKey> => {
  if (secretBytes.byteLength !== OFFLINE_READING_KEY_BYTES || salt.byteLength !== OFFLINE_READING_SALT_BYTES) throw readingOpaque()
  const subtle = readingSubtle()
  let input: CryptoKey | undefined
  try {
    input = await subtle.importKey('raw', secretBytes as unknown as BufferSource, 'HKDF', false, ['deriveKey'])
    return await subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: salt as unknown as BufferSource,
        info: concatReading([
          lpUtf8Reading('tsepistle/offline-reading-wrap/v1'),
          encodeOfflineReadingContext(context),
          u64Reading(generation)
        ]) as unknown as BufferSource
      },
      input,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    )
  } catch {
    throw readingOpaque()
  } finally {
    input = undefined
  }
}

export const wrapOfflineReadingKey = async (
  secretBytes: Uint8Array,
  context: OfflineReadingContextV1,
  generation: number,
  salt: Uint8Array,
  nonce: Uint8Array,
  readingKeyBytes: Uint8Array
): Promise<Uint8Array> => {
  if (readingKeyBytes.byteLength !== OFFLINE_READING_KEY_BYTES) throw readingOpaque()
  let aad: Uint8Array | undefined
  let encrypted: Uint8Array | undefined
  let returned = false
  try {
    const wrappingKey = await deriveOfflineReadingWrappingKey(secretBytes, context, generation, salt)
    aad = encodeOfflineReadingWrapAad(context, generation, salt, nonce)
    encrypted = new Uint8Array(
      await readingSubtle().encrypt(
        { name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: OFFLINE_READING_TAG_BYTES * 8 },
        wrappingKey,
        readingKeyBytes as unknown as BufferSource
      )
    )
    if (encrypted.byteLength !== OFFLINE_READING_KEY_BYTES + OFFLINE_READING_TAG_BYTES) throw readingOpaque()
    returned = true
    return encrypted
  } catch (error) {
    if (error instanceof OfflineDraftOpaqueError) throw error
    throw readingOpaque()
  } finally {
    aad?.fill(0)
    if (!returned) encrypted?.fill(0)
  }
}

export const unwrapOfflineReadingKey = async (
  secretBytes: Uint8Array,
  context: OfflineReadingContextV1,
  generation: number,
  salt: Uint8Array,
  nonce: Uint8Array,
  wrappedKey: Uint8Array
): Promise<Uint8Array> => {
  if (wrappedKey.byteLength !== OFFLINE_READING_KEY_BYTES + OFFLINE_READING_TAG_BYTES) throw readingOpaque()
  let aad: Uint8Array | undefined
  let raw: Uint8Array | undefined
  try {
    const wrappingKey = await deriveOfflineReadingWrappingKey(secretBytes, context, generation, salt)
    aad = encodeOfflineReadingWrapAad(context, generation, salt, nonce)
    raw = new Uint8Array(
      await readingSubtle().decrypt(
        { name: 'AES-GCM', iv: nonce as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: OFFLINE_READING_TAG_BYTES * 8 },
        wrappingKey,
        wrappedKey as unknown as BufferSource
      )
    )
    if (raw.byteLength !== OFFLINE_READING_KEY_BYTES) throw readingOpaque()
    return raw
  } catch {
    raw?.fill(0)
    throw readingOpaque()
  } finally {
    aad?.fill(0)
  }
}

const importReadingKey = async (keyBytes: Uint8Array): Promise<CryptoKey> => {
  if (keyBytes.byteLength !== OFFLINE_READING_KEY_BYTES) throw readingOpaque()
  try {
    return await readingSubtle().importKey('raw', keyBytes as unknown as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  } catch {
    throw readingOpaque()
  }
}

const readingHandle = (context: OfflineReadingContextV1, generation: number, key: CryptoKey): OfflineReadingHandleV1 =>
  Object.freeze({ context: Object.freeze(context), sessionGeneration: generation, key, [offlineReadingHandleBrand]: true }) as OfflineReadingHandleV1

const installReadingKey = (
  context: OfflineReadingContextV1,
  generation: number,
  key: CryptoKey,
  expectedEpoch: number,
  storage: Pick<OfflineReadingVaultStorage, 'currentSessionGeneration' | 'getReadingVault'>
): OfflineReadingHandleV1 => {
  if (expectedEpoch !== readingRegistryEpoch) throw readingOpaque()
  const handle = readingHandle(context, generation, key)
  readingRegistry.clear()
  readingRegistry.set(readingIdentity(context, generation), { handle, epoch: readingRegistryEpoch })
  activeReadingHandle = handle
  activeReadingStorage = storage
  ensureReadingLifecycle()
  dispatchReadingState()
  return handle
}

const assertReadingOperationCurrent = (epoch: number, signal?: AbortSignal): void => {
  if (signal?.aborted || epoch !== readingRegistryEpoch) throw readingOpaque()
}

export const isCurrentOfflineReadingHandle = (handle: OfflineReadingHandleV1): boolean => {
  try {
    const entry = readingRegistry.get(readingIdentity(handle.context, handle.sessionGeneration))
    return activeReadingHandle === handle && entry?.handle === handle && entry.epoch === readingRegistryEpoch
  } catch {
    return false
  }
}
export function lockOfflineReading(): void {
  readingRegistryEpoch += 1
  readingRegistry.clear()
  activeReadingHandle = undefined
  activeReadingStorage = undefined
  readingRevalidationInFlight = null
  dispatchReadingState()
}
export const currentOfflineReadingHandle = (): OfflineReadingHandleV1 | null => activeReadingHandle ?? null
export const requireCurrentOfflineReadingKey = (handle: OfflineReadingHandleV1): CryptoKey => {
  if (!isCurrentOfflineReadingHandle(handle)) throw readingOpaque()
  return handle.key
}

const validateReadingExpectation = (expected: OfflineReadingKeyFrameExpectation): OfflineReadingKeyFrameExpectation => {
  if (!expected || !isSafePositiveInteger(expected.expectedAccountId) || !isSafeNonnegativeInteger(expected.expectedSessionGeneration)) throw readingOpaque()
  const origin = canonicalOrigin(expected.canonicalOrigin)
  if (expected.expectedAuthVersion !== undefined && !isSafeNonnegativeInteger(expected.expectedAuthVersion)) throw readingOpaque()
  if (
    expected.expectedSiteId !== undefined &&
    (expected.expectedSiteId.trim() !== expected.expectedSiteId || expected.expectedSiteId.length < 1 || expected.expectedSiteId.length > 256)
  )
    throw readingOpaque()
  return { ...expected, canonicalOrigin: origin }
}

const readReadingLength = (bytes: Uint8Array, view: DataView, offset: number, maximum: number): { readonly value: string; readonly offset: number } => {
  if (offset + 4 > bytes.byteLength) throw readingOpaque()
  const length = view.getUint32(offset, false)
  const valueOffset = offset + 4
  if (length > maximum || valueOffset + length > bytes.byteLength) throw readingOpaque()
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(valueOffset, valueOffset + length))
  } catch {
    throw readingOpaque()
  }
  return { value, offset: valueOffset + length }
}

const readReadingU64 = (bytes: Uint8Array, view: DataView, offset: number): { readonly value: number; readonly offset: number } => {
  if (offset + 8 > bytes.byteLength) throw readingOpaque()
  const value = view.getBigUint64(offset, false)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw readingOpaque()
  return { value: Number(value), offset: offset + 8 }
}

export const parseOfflineReadingKeyFrame = (input: ArrayBuffer | Uint8Array, rawExpected: OfflineReadingKeyFrameExpectation): ParsedOfflineReadingKeyFrame => {
  const expected = validateReadingExpectation(rawExpected)
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.byteLength < READING_MAGIC_BYTES.byteLength || bytes.byteLength > MAX_FRAME_BYTES) throw readingOpaque()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = READING_MAGIC_BYTES.byteLength
  for (let index = 0; index < READING_MAGIC_BYTES.byteLength; index += 1) if (bytes[index] !== READING_MAGIC_BYTES[index]) throw readingOpaque()
  const originField = readReadingLength(bytes, view, offset, MAX_CANONICAL_ORIGIN_BYTES)
  offset = originField.offset
  const siteField = readReadingLength(bytes, view, offset, MAX_SITE_ID_BYTES)
  offset = siteField.offset
  const accountField = readReadingU64(bytes, view, offset)
  offset = accountField.offset
  const authField = readReadingU64(bytes, view, offset)
  offset = authField.offset
  const versionField = readReadingLength(bytes, view, offset, OFFLINE_READING_KEY_VERSION.length)
  offset = versionField.offset
  const keyIdField = readReadingLength(bytes, view, offset, MAX_KEY_ID_BYTES)
  offset = keyIdField.offset
  if (offset + OFFLINE_READING_KEY_BYTES !== bytes.byteLength) throw readingOpaque()
  const origin = canonicalOrigin(originField.value)
  if (origin !== expected.canonicalOrigin || siteField.value.trim() !== siteField.value || siteField.value.length < 1 || siteField.value.length > 256)
    throw readingOpaque()
  if (expected.expectedSiteId !== undefined && expected.expectedSiteId !== siteField.value) throw readingOpaque()
  if (
    accountField.value !== expected.expectedAccountId ||
    !isSafePositiveInteger(accountField.value) ||
    !isSafeNonnegativeInteger(authField.value) ||
    (expected.expectedAuthVersion !== undefined && authField.value !== expected.expectedAuthVersion)
  )
    throw readingOpaque()
  if (versionField.value !== OFFLINE_READING_KEY_VERSION) throw readingOpaque()
  const keyIdBytes = base64UrlDecode(keyIdField.value, 16)
  keyIdBytes.fill(0)
  const parsed = OfflineReadingContextV1Schema.safeParse({
    schemaVersion: 1,
    canonicalOrigin: origin,
    siteId: siteField.value,
    accountId: accountField.value,
    authVersion: authField.value,
    keyVersion: versionField.value,
    keyId: keyIdField.value
  })
  if (!parsed.success) throw readingOpaque()
  return { context: Object.freeze(parsed.data) as OfflineReadingContextV1, keyBytes: bytes.subarray(offset, offset + OFFLINE_READING_KEY_BYTES) }
}

const confirmReadingSecret = async (secret: Uint8Array, confirmation: OfflineReadingEnrollmentOptions['confirmSecret']): Promise<void> => {
  if (confirmation === undefined) throw readingOpaque()
  if (typeof confirmation === 'function') {
    if (!(await confirmation(encodeOfflineReadingSecret(secret)))) throw readingOpaque()
    return
  }
  const confirmed = typeof confirmation === 'string' ? decodeOfflineReadingSecret(confirmation) : confirmation
  if (!(confirmed instanceof Uint8Array) || confirmed.byteLength !== secret.byteLength || confirmed.some((byte, index) => byte !== secret[index]))
    throw readingOpaque()
}

const normalizeReadingEnrollmentOptions = (
  raw: OfflineReadingEnrollmentOptions | number,
  generation: number | undefined,
  signal: AbortSignal | undefined
): OfflineReadingEnrollmentOptions => {
  if (typeof raw === 'number') {
    if (generation === undefined) throw readingOpaque()
    return { expectedAccountId: raw, expectedSessionGeneration: generation, signal }
  }
  return raw
}

export const enrollOfflineReading = async (
  fetchImpl: typeof window.fetch,
  storage: OfflineReadingVaultStorage,
  rawOptions: OfflineReadingEnrollmentOptions | number,
  generation?: number,
  signal?: AbortSignal
): Promise<{ readonly secret: Uint8Array; readonly vault: OfflineReadingVaultV1; readonly handle: OfflineReadingHandleV1 }> => {
  const operationEpoch = readingRegistryEpoch
  const options = normalizeReadingEnrollmentOptions(rawOptions, generation, signal)
  if (
    !isSafePositiveInteger(options.expectedAccountId) ||
    !isSafeNonnegativeInteger(options.expectedSessionGeneration) ||
    (options.expectedAuthVersion !== undefined && !isSafeNonnegativeInteger(options.expectedAuthVersion))
  )
    throw readingOpaque()
  const secret = generateOfflineReadingSecret()
  let frame: Uint8Array | undefined
  let parsed: ParsedOfflineReadingKeyFrame | undefined
  let rawKey: Uint8Array | undefined
  let wrapped: Uint8Array | undefined
  try {
    assertReadingOperationCurrent(operationEpoch, options.signal)
    const origin = currentOrigin()
    assertReadingOperationCurrent(operationEpoch, options.signal)
    const response = await fetchImpl(new URL('/_api/offline/reading-key', origin).href, {
      method: 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { accept: 'application/octet-stream' },
      signal: options.signal
    })
    assertReadingOperationCurrent(operationEpoch, options.signal)
    if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/octet-stream') throw readingOpaque()
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null && Number.isFinite(Number(contentLength)) && Number(contentLength) > MAX_FRAME_BYTES) throw readingOpaque()
    assertReadingOperationCurrent(operationEpoch, options.signal)
    frame = new Uint8Array(await response.arrayBuffer())
    assertReadingOperationCurrent(operationEpoch, options.signal)
    if (frame.byteLength > MAX_FRAME_BYTES) throw readingOpaque()
    parsed = parseOfflineReadingKeyFrame(frame, {
      canonicalOrigin: origin,
      expectedAccountId: options.expectedAccountId,
      expectedSessionGeneration: options.expectedSessionGeneration,
      ...(options.expectedAuthVersion === undefined ? {} : { expectedAuthVersion: options.expectedAuthVersion })
    })
    rawKey = new Uint8Array(parsed.keyBytes)
    assertReadingOperationCurrent(operationEpoch, options.signal)
    await confirmReadingSecret(secret, options.confirmSecret)
    assertReadingOperationCurrent(operationEpoch, options.signal)
    const salt = new Uint8Array(OFFLINE_READING_SALT_BYTES)
    const nonce = new Uint8Array(OFFLINE_READING_NONCE_BYTES)
    globalThis.crypto.getRandomValues(salt)
    globalThis.crypto.getRandomValues(nonce)
    assertReadingOperationCurrent(operationEpoch, options.signal)
    wrapped = await wrapOfflineReadingKey(secret, parsed.context, options.expectedSessionGeneration, salt, nonce, rawKey)
    assertReadingOperationCurrent(operationEpoch, options.signal)
    const vault = OfflineReadingVaultV1Schema.parse({
      schemaVersion: 1,
      context: parsed.context,
      sessionGeneration: options.expectedSessionGeneration,
      salt,
      nonce,
      wrappedKey: new Uint8Array(wrapped)
    })
    assertReadingOperationCurrent(operationEpoch, options.signal)
    await storage.putReadingVault(vault, { expectedSessionGeneration: options.expectedSessionGeneration })
    assertReadingOperationCurrent(operationEpoch, options.signal)
    const key = await importReadingKey(rawKey)
    assertReadingOperationCurrent(operationEpoch, options.signal)
    return { secret, vault, handle: installReadingKey(parsed.context, options.expectedSessionGeneration, key, operationEpoch, storage) }
  } catch (error) {
    secret.fill(0)
    if (error instanceof OfflineDraftOpaqueError || error instanceof OfflineDraftSessionError) throw error
    throw readingOpaque()
  } finally {
    frame?.fill(0)
    parsed?.keyBytes.fill(0)
    rawKey?.fill(0)
    wrapped?.fill(0)
  }
}

export const unlockOfflineReading = async (
  storage: OfflineReadingVaultStorage,
  secretBytes: Uint8Array,
  signal?: AbortSignal
): Promise<OfflineReadingHandleV1> => {
  const operationEpoch = readingRegistryEpoch
  if (!(secretBytes instanceof Uint8Array) || secretBytes.byteLength !== OFFLINE_READING_KEY_BYTES) throw readingOpaque()
  let rawKey: Uint8Array | undefined
  try {
    assertReadingOperationCurrent(operationEpoch, signal)
    const vaultValue = await storage.getReadingVault()
    assertReadingOperationCurrent(operationEpoch, signal)
    if (!vaultValue) throw readingOpaque()
    const vault = OfflineReadingVaultV1Schema.parse(vaultValue)
    assertReadingOperationCurrent(operationEpoch, signal)
    const currentGeneration = await storage.currentSessionGeneration()
    assertReadingOperationCurrent(operationEpoch, signal)
    const origin = currentOrigin()
    if (vault.sessionGeneration !== currentGeneration || vault.context.canonicalOrigin !== origin) throw readingOpaque()
    assertReadingOperationCurrent(operationEpoch, signal)
    rawKey = await unwrapOfflineReadingKey(secretBytes, vault.context, vault.sessionGeneration, vault.salt, vault.nonce, vault.wrappedKey)
    assertReadingOperationCurrent(operationEpoch, signal)
    const key = await importReadingKey(rawKey)
    assertReadingOperationCurrent(operationEpoch, signal)
    return installReadingKey(vault.context, vault.sessionGeneration, key, operationEpoch, storage)
  } catch (error) {
    if (error instanceof OfflineDraftOpaqueError || error instanceof OfflineDraftSessionError) throw error
    throw readingOpaque()
  } finally {
    rawKey?.fill(0)
  }
}

export const isCurrentOfflineReadingEpoch = (handle: OfflineReadingHandleV1, epoch: number): boolean =>
  isCurrentOfflineReadingHandle(handle) && epoch === readingRegistryEpoch
export const parseReadingKeyFrame = parseOfflineReadingKeyFrame
export const parseTSORK1Frame = parseOfflineReadingKeyFrame
export type ParsedReadingKeyFrame = ParsedOfflineReadingKeyFrame
export type OfflineReadingHandle = OfflineReadingHandleV1

export const confirmOfflineReadingSecret = (secretBytes: Uint8Array, enteredSecret: Uint8Array | string): boolean => {
  if (!(secretBytes instanceof Uint8Array) || secretBytes.byteLength !== OFFLINE_READING_KEY_BYTES) return false
  let entered: Uint8Array | undefined
  try {
    entered = typeof enteredSecret === 'string' ? decodeOfflineReadingSecret(enteredSecret) : enteredSecret
    return entered instanceof Uint8Array && entered.byteLength === secretBytes.byteLength && entered.every((byte, index) => byte === secretBytes[index])
  } catch {
    return false
  } finally {
    if (typeof enteredSecret === 'string') entered?.fill(0)
  }
}
export const currentOfflineReadingEpoch = (): number => readingRegistryEpoch
export const offlineReadingEpoch = (): number => readingRegistryEpoch
