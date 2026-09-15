import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from '../../server/test/bun-test.mts'
import {
  decryptOfflineDraft,
  encryptOfflineDraft,
  requestDraftKey,
  type OfflineDraftKeyHandle
} from '../helpers/offline-crypto.ts'
import { invalidateOfflineSession, isCurrentOfflineDraftKey, OfflineDraftOpaqueError } from '../helpers/offline-session.ts'
import {
  OFFLINE_DRAFT_KEY_MAGIC,
  OFFLINE_DRAFT_TAG_BYTES,
  OFFLINE_KEY_VERSION,
  type DraftKeyContext,
  type OfflineDraftEnvelopeV1,
  type OfflineDraftPayloadV1
} from '../../shared/offline.ts'

const ORIGIN = 'https://wiki.example.test'
const SITE_ID = 'site-fixture'
const ACCOUNT_ID = 42
const SESSION_GENERATION = 9
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index + 1)
const textEncoder = new TextEncoder()

const context: DraftKeyContext = {
  canonicalOrigin: ORIGIN,
  siteId: SITE_ID,
  accountId: ACCOUNT_ID,
  authVersion: 0,
  keyVersion: OFFLINE_KEY_VERSION
}

const payload: OfflineDraftPayloadV1 = {
  editorKey: 'markdown',
  pageId: 12,
  createIdentity: null,
  locale: 'en',
  path: '/guide',
  baseSourceRevision: '7',
  baseUpdatedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  state: 'publishing',
  title: 'A local draft',
  description: 'A draft retained on this device.',
  content: '# Draft\n\nConfidential content.'
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type FetchApi = typeof window.fetch
type FetchMock = Mock<FetchImplementation>
type GlobalDescriptor = PropertyDescriptor | undefined
const globalsToRestore = ['window', 'location', 'BroadcastChannel', 'fetch'] as const
const savedGlobals = new Map<string, GlobalDescriptor>()

class TestBroadcastChannel {
  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  addEventListener(): void {}

  removeEventListener(): void {}

  postMessage(): void {}

  close(): void {}
}

const setGlobal = (name: string, value: unknown): void => {
  if (!savedGlobals.has(name)) savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
const installBrowserGlobals = (fetchImpl: FetchApi): void => {
  setGlobal('window', { fetch: fetchImpl, location: { origin: ORIGIN } })
  setGlobal('location', { origin: ORIGIN })
  setGlobal('BroadcastChannel', TestBroadcastChannel as unknown as typeof BroadcastChannel)
  setGlobal('fetch', fetchImpl)
}

const restoreBrowserGlobals = (): void => {
  for (const name of [...globalsToRestore].reverse()) {
    if (!savedGlobals.has(name)) continue
    const descriptor = savedGlobals.get(name)
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  savedGlobals.clear()
}

const createFetchMock = (implementation: FetchImplementation): FetchMock => vi.fn(implementation) as unknown as FetchMock

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

const lpUtf8 = (value: string): Uint8Array => {
  const encoded = textEncoder.encode(value)
  const length = new Uint8Array(4)
  new DataView(length.buffer).setUint32(0, encoded.byteLength, false)
  return concatBytes([length, encoded])
}

const u64be = (value: number): Uint8Array => {
  const encoded = new Uint8Array(8)
  new DataView(encoded.buffer).setBigUint64(0, BigInt(value), false)
  return encoded
}

/** Builds the public TSODK1 frame: magic, length-prefixed context, integers, version, and raw key. */
const tsodk1Frame = (frameContext: DraftKeyContext, keyBytes = KEY_BYTES): Uint8Array =>
  concatBytes([
    textEncoder.encode(OFFLINE_DRAFT_KEY_MAGIC),
    lpUtf8(frameContext.canonicalOrigin),
    lpUtf8(frameContext.siteId),
    u64be(frameContext.accountId),
    u64be(frameContext.authVersion),
    lpUtf8(frameContext.keyVersion),
    keyBytes
  ])

const octetStreamResponse = (frame: Uint8Array): Response =>
  new Response(frame.slice(), {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' }
  })

const fetchType = (fetchMock: FetchMock): FetchApi => fetchMock as unknown as FetchApi

const installFetch = (response: Response | (() => Promise<Response>)): FetchMock => {
  const fetchMock = createFetchMock(async () => (typeof response === 'function' ? await response() : response))
  installBrowserGlobals(fetchType(fetchMock))
  return fetchMock
}

const requestKey = async (fetchMock: FetchMock, options = {}): Promise<OfflineDraftKeyHandle> =>
  await requestDraftKey(fetchType(fetchMock), {
    expectedAccountId: ACCOUNT_ID,
    expectedSessionGeneration: SESSION_GENERATION,
    ...options
  })

const cloneEnvelope = (envelope: OfflineDraftEnvelopeV1): OfflineDraftEnvelopeV1 => ({
  ...envelope,
  nonce: new Uint8Array(envelope.nonce),
  ciphertext: new Uint8Array(envelope.ciphertext)
})

beforeEach(() => {
  const unusedFetch = createFetchMock(async () => {
    throw new Error('unexpected fetch')
  })
  installBrowserGlobals(fetchType(unusedFetch))
  invalidateOfflineSession()
})

afterEach(() => {
  invalidateOfflineSession()
  restoreBrowserGlobals()
})

describe('offline draft crypto', () => {
  it('imports the authVersion 0 server frame as a non-extractable key and requests an absolute same-origin endpoint', async () => {
    const fetchMock = installFetch(octetStreamResponse(tsodk1Frame(context)))

    const handle = await requestKey(fetchMock)

    expect(handle.context).toEqual(context)
    expect(handle.sessionGeneration).toBe(SESSION_GENERATION)
    expect(handle.key.type).toBe('secret')
    expect(handle.key.extractable).toBe(false)
    expect(handle.key.usages).toEqual(['encrypt', 'decrypt'])
    await expect(globalThis.crypto.subtle.exportKey('raw', handle.key)).rejects.toThrow()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${ORIGIN}/_api/offline/draft-key`)
    expect(new URL(url).origin).toBe(ORIGIN)
    expect(request).toMatchObject({
      method: 'POST',
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { accept: 'application/octet-stream' }
    })
    expect(request.body).toBeUndefined()
    expect(request.signal).toBeInstanceOf(AbortSignal)
  })

  it('round-trips a publishing payload through AES-GCM with the immutable submission selector', async () => {
    const fetchMock = installFetch(octetStreamResponse(tsodk1Frame(context)))
    const handle = await requestKey(fetchMock)
    const selectors = { recordId: 'record-1', draftRevision: 3, submissionId: 'submission-1' as string | null }

    const envelope = await encryptOfflineDraft(handle, payload, selectors)
    const decrypted = await decryptOfflineDraft(handle, envelope)

    expect(decrypted).toEqual(payload)
    expect(envelope).toMatchObject({
      schemaVersion: 1,
      recordId: selectors.recordId,
      accountId: ACCOUNT_ID,
      authVersion: 0,
      keyVersion: OFFLINE_KEY_VERSION,
      sessionGeneration: SESSION_GENERATION,
      draftRevision: selectors.draftRevision,
      submissionId: selectors.submissionId
    })
    expect(envelope.nonce).toHaveLength(12)
    expect(envelope.ciphertext.byteLength).toBeGreaterThan(OFFLINE_DRAFT_TAG_BYTES)
  })

  it('rejects tampering with every clear selector, nonce, or ciphertext', async () => {
    const fetchMock = installFetch(octetStreamResponse(tsodk1Frame(context)))
    const handle = await requestKey(fetchMock)
    const envelope = await encryptOfflineDraft(handle, payload, {
      recordId: 'record-1',
      draftRevision: 3,
      submissionId: 'submission-1'
    })

    const tampered = [
      ['schemaVersion', (value: OfflineDraftEnvelopeV1) => ({ ...cloneEnvelope(value), schemaVersion: 2 as 1 })],
      ['recordId', (value: OfflineDraftEnvelopeV1) => ({ ...cloneEnvelope(value), recordId: 'record-2' })],
      ['accountId', (value: OfflineDraftEnvelopeV1) => ({ ...cloneEnvelope(value), accountId: ACCOUNT_ID + 1 })],
      ['authVersion', (value: OfflineDraftEnvelopeV1) => ({ ...cloneEnvelope(value), authVersion: 1 })],
      ['keyVersion', (value: OfflineDraftEnvelopeV1) => ({ ...cloneEnvelope(value), keyVersion: 'session-secret-v2' as typeof OFFLINE_KEY_VERSION })],
      ['sessionGeneration', (value: OfflineDraftEnvelopeV1) => ({ ...cloneEnvelope(value), sessionGeneration: SESSION_GENERATION + 1 })],
      ['draftRevision', (value: OfflineDraftEnvelopeV1) => ({ ...cloneEnvelope(value), draftRevision: 4 })],
      ['submissionId', (value: OfflineDraftEnvelopeV1) => ({ ...cloneEnvelope(value), submissionId: null })],
      ['nonce', (value: OfflineDraftEnvelopeV1) => {
        const result = cloneEnvelope(value)
        result.nonce[0] = (result.nonce[0] ?? 0) ^ 1
        return result
      }],
      ['ciphertext', (value: OfflineDraftEnvelopeV1) => {
        const result = cloneEnvelope(value)
        result.ciphertext[0] = (result.ciphertext[0] ?? 0) ^ 1
        return result
      }]
    ] as const

    for (const [field, mutate] of tampered) {
      const attempt = decryptOfflineDraft(handle, mutate(envelope))
      await expect(attempt, `tampered ${field} selector must stay opaque`).rejects.toMatchObject({ code: 'opaque', deleteOnly: true })
    }
  })

  it.each([
    ['wrong magic', (() => {
      const frame = tsodk1Frame(context)
      frame[0] = (frame[0] ?? 0) ^ 1
      return frame
    })()],
    ['truncated', tsodk1Frame(context).slice(0, -1)],
    ['trailing bytes', concatBytes([tsodk1Frame(context), new Uint8Array([0])])],
    ['oversized', new Uint8Array(16 * 1024 + 1)]
  ] as const)('rejects a %s TSODK1 response frame', async (_label, frame) => {
    const fetchMock = installFetch(octetStreamResponse(frame))

    await expect(requestKey(fetchMock)).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
  })

  it('invalidates stale handles and fences a late response after the session boundary', async () => {
    const initialFetch = installFetch(octetStreamResponse(tsodk1Frame(context)))
    const initialHandle = await requestKey(initialFetch)

    let releaseResponse: (response: Response) => void = () => {}
    const lateFetch = createFetchMock(
      (_input, _init) =>
        new Promise<Response>(resolve => {
          releaseResponse = resolve
        })
    )
    installBrowserGlobals(fetchType(lateFetch))
    const lateRequest = requestKey(lateFetch)
    await Promise.resolve()
    expect(lateFetch).toHaveBeenCalledTimes(1)

    invalidateOfflineSession()
    expect(isCurrentOfflineDraftKey(initialHandle)).toBe(false)
    await expect(encryptOfflineDraft(initialHandle, payload, { recordId: 'record-1', draftRevision: 3, submissionId: null })).rejects.toBeInstanceOf(OfflineDraftOpaqueError)

    const request = (lateFetch.mock.calls[0] as [RequestInfo | URL, RequestInit])[1]
    expect(request.signal?.aborted).toBe(true)
    releaseResponse(octetStreamResponse(tsodk1Frame(context)))
    await expect(lateRequest).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
  })
})
