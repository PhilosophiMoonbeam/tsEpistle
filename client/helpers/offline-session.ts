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

const broadcastSessionInvalidation = (): void => {
  const channel = ensureSessionChannel()
  try {
    channel?.postMessage(SESSION_INVALIDATION_MESSAGE)
  } catch {
    // Cross-tab coordination is best effort; generation fencing is authoritative.
  }
}

const publishSessionInvalidation = (broadcast: boolean, preserveOwner = false): void => {
  if (sessionInvalidationInProgress) return
  sessionInvalidationInProgress = true
  try {
    clearRegistry(preserveOwner)
    dispatchSessionInvalidation()
    if (broadcast) broadcastSessionInvalidation()
  } finally {
    sessionInvalidationInProgress = false
  }
}

const onSessionChannelMessage = (event: MessageEvent<unknown>): void => {
  if (event.data !== SESSION_INVALIDATION_MESSAGE) return
  publishSessionInvalidation(false)
  try {
    offlineSessionInvalidationOwner?.()
  } catch {
    // A remote observer cannot undo the in-memory session fence.
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

/** Registers the single owner for remote session invalidations and opens the channel eagerly. */
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
  if (
    signal?.aborted ||
    registryEpoch !== epoch ||
    activeAccountId !== accountId ||
    activeSessionGeneration !== sessionGeneration
  )
    throw opaque()
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
const readBoundedFrame = async (
  response: Response,
  signal: AbortSignal,
  assertCurrent: () => void
): Promise<Uint8Array> => {
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
    if (
      !controller.signal.aborted &&
      registryEpoch === epoch &&
      activeAccountId === accountId &&
      activeSessionGeneration === sessionGeneration
    ) {
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

const createPendingKeyRequest = (
  fetchImpl: typeof window.fetch,
  options: DraftKeyRequestOptions,
  origin: string
): PendingKeyRequest => {
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

const waitForPendingKey = async (
  acquisition: PendingKeyRequest,
  signal: AbortSignal | undefined
): Promise<OfflineDraftKeyHandle> => {
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
  const acquisition =
    pendingKeyRequests.get(key) ??
    createPendingKeyRequest(fetchImpl, options, origin)
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
    (!isSafeNonnegativeInteger(expectedSessionGeneration) ||
      activeSessionGeneration === undefined ||
      activeSessionGeneration !== expectedSessionGeneration)
  )
    return
  publishSessionInvalidation(true)
}

/** Explicit alias for callers that need to drop only the in-memory key boundary. */
export const dropOfflineDraftKey = (): void => invalidateOfflineSession()
