import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from '../../server/test/bun-test.mts'
import {
  decodeOfflineReadingSecret,
  decryptOfflineDraft,
  decryptOfflineDraftForReconciliation,
  decryptOfflinePrivateRecord,
  encodeOfflineReadingSecret,
  encodeOfflineDraftAad,
  encryptOfflineDraft,
  encryptOfflinePrivateRecord,
  enrollOfflineReading,
  generateOfflineReadingPairId,
  generateOfflineReadingSecret,
  lockOfflineReading,
  parseOfflineReadingKeyFrame,
  readPrivateCorpus,
  requestDraftKey,
  unlockOfflineReading,
  unwrapOfflineReadingKey,
  wrapOfflineReadingKey,
  type OfflineDraftKeyHandle,
  type OfflineReadingHandleV1
} from '../helpers/offline-crypto.ts'
import {
  confirmOfflineReadingSecret,
  currentOfflineReadingEpoch,
  currentOfflineReadingHandle,
  invalidateOfflineSession,
  isCurrentOfflineDraftKey,
  isCurrentOfflineReadingHandle,
  OFFLINE_READING_STATE_EVENT,
  OfflineDraftOpaqueError
} from '../helpers/offline-session.ts'
import {
  OFFLINE_DRAFT_KEY_MAGIC,
  OFFLINE_DRAFT_TAG_BYTES,
  OFFLINE_KEY_VERSION,
  OFFLINE_READING_KEY_MAGIC,
  OFFLINE_READING_KEY_VERSION,
  OFFLINE_READING_NONCE_BYTES,
  OFFLINE_READING_SALT_BYTES,
  type DraftKeyContext,
  type OfflineDraftEnvelopeV1,
  type OfflineDraftPayloadV1,
  type OfflinePagePolicyRecord,
  type OfflinePolicyState,
  type OfflinePrivateEnvelopeV1,
  type OfflineReadingContextV1,
  type OfflineReadingVaultV1
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

const payloadWithSubmission: OfflineDraftPayloadV1 = {
  editorKey: 'markdown',
  pageId: 34,
  createIdentity: 'writer-α',
  locale: 'fr',
  path: '/café/雪',
  baseSourceRevision: '42',
  baseUpdatedAt: '2026-09-01T12:00:00.000Z',
  updatedAt: '2026-09-01T12:30:00.000Z',
  state: 'needs-review',
  title: 'Révision hors ligne',
  description: 'Brouillon sécurisé.',
  content: '# Révision\n\n秘密.'
}
const READING_AUTH_VERSION = 3
const READING_GENERATION = SESSION_GENERATION
const READING_KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index)
const READING_KEY_ID = 'AAAAAAAAAAAAAAAAAAAAAA'
const readingContext: OfflineReadingContextV1 = {
  schemaVersion: 1,
  canonicalOrigin: ORIGIN,
  siteId: SITE_ID,
  accountId: ACCOUNT_ID,
  authVersion: READING_AUTH_VERSION,
  keyVersion: OFFLINE_READING_KEY_VERSION,
  keyId: READING_KEY_ID
}
const readingSnapshot = {
  schemaVersion: 1 as const,
  pageId: 12,
  locale: 'en',
  path: '/guide',
  canonicalPath: '/guide',
  title: 'A private page',
  description: 'A private offline page.',
  sourceRevision: '7',
  capturedAt: '2026-09-01T12:00:00.000Z',
  expiresAt: null,
  content: {
    representation: 'sanitized-html-fragment' as const,
    sanitizerVersion: 'offline-html-allowlist-v1' as const,
    html: '<p>Confidential page.</p>'
  },
  searchText: 'Confidential page.',
  contentType: 'sanitized-html-fragment' as const,
  integrity: 'sha256:fixture'
}
const readingSearchDocument = {
  schemaVersion: 1 as const,
  siteId: SITE_ID,
  pageId: 12,
  locale: 'en',
  path: '/guide',
  canonicalPath: '/guide',
  title: 'A private page',
  description: 'A private offline page.',
  searchText: 'Confidential page.',
  capturedAt: '2026-09-01T12:00:00.000Z',
  byteSize: 20
}
const readingPolicyState: OfflinePolicyState = {
  key: 'state',
  recordType: 'state',
  schemaVersion: 1,
  automaticSavingEnabled: true,
  automaticSavingDefaultApplied: true,
  selectedTags: [],
  policyRevision: 1,
  syncDiagnostics: {
    status: 'idle',
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    pendingCount: 0,
    retainedCount: 0,
    removedCount: 0
  },
  byteSize: 0
}
const readingPolicyPage: OfflinePagePolicyRecord = {
  key: `${SITE_ID}\u0000${readingSnapshot.pageId}\u0000${readingSnapshot.locale}`,
  recordType: 'page',
  schemaVersion: 1,
  siteId: SITE_ID,
  pageId: readingSnapshot.pageId,
  locale: readingSnapshot.locale,
  manual: true,
  automatic: false,
  tag: false,
  tagNames: [],
  visitCount: 0,
  lastVisitedAt: null,
  lastEditedAt: null,
  automaticSelectedAt: null,
  excluded: false,
  availability: 'available',
  byteSize: 0
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type FetchApi = typeof window.fetch
type FetchMock = Mock<FetchImplementation>
type GlobalDescriptor = PropertyDescriptor | undefined
const globalsToRestore = ['window', 'document', 'location', 'BroadcastChannel', 'fetch'] as const
const savedGlobals = new Map<string, GlobalDescriptor>()
const dispatchedReadingEvents: string[] = []

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
  setGlobal('window', {
    fetch: fetchImpl,
    location: { origin: ORIGIN },
    dispatchEvent: (event: Event) => {
      dispatchedReadingEvents.push(event.type)
      return true
    }
  })
  setGlobal('document', {})
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
/** Builds the public TSORK1 frame with a length-prefixed context and raw reading key. */
const tsork1Frame = (frameContext: OfflineReadingContextV1, keyBytes = READING_KEY_BYTES): Uint8Array =>
  concatBytes([
    textEncoder.encode(OFFLINE_READING_KEY_MAGIC),
    lpUtf8(frameContext.canonicalOrigin),
    lpUtf8(frameContext.siteId),
    u64be(frameContext.accountId),
    u64be(frameContext.authVersion),
    lpUtf8(frameContext.keyVersion),
    lpUtf8(frameContext.keyId),
    keyBytes
  ])

const cloneVault = (vault: OfflineReadingVaultV1): OfflineReadingVaultV1 => ({
  ...vault,
  context: { ...vault.context },
  salt: new Uint8Array(vault.salt),
  nonce: new Uint8Array(vault.nonce),
  wrappedKey: new Uint8Array(vault.wrappedKey)
})
type ReadingStorageFixture = {
  readonly storage: {
    readonly currentSessionGeneration: () => Promise<number>
    readonly getReadingVault: () => Promise<OfflineReadingVaultV1 | null>
    readonly putReadingVault: (vault: OfflineReadingVaultV1) => Promise<void>
  }
  readonly getVault: () => OfflineReadingVaultV1 | null
}

const createReadingStorage = (initial: OfflineReadingVaultV1 | null = null, generation = READING_GENERATION): ReadingStorageFixture => {
  let vault = initial ? cloneVault(initial) : null
  return {
    storage: {
      currentSessionGeneration: async () => generation,
      getReadingVault: async () => (vault ? cloneVault(vault) : null),
      putReadingVault: async (next: OfflineReadingVaultV1) => {
        vault = cloneVault(next)
      }
    },
    getVault: () => (vault ? cloneVault(vault) : null)
  }
}

const mutateByte = (bytes: Uint8Array): Uint8Array => {
  const result = new Uint8Array(bytes)
  result[0] = (result[0] ?? 0) ^ 1
  return result
}
const clonePrivateEnvelope = (envelope: OfflinePrivateEnvelopeV1): OfflinePrivateEnvelopeV1 => ({
  ...envelope,
  context: { ...envelope.context },
  nonce: new Uint8Array(envelope.nonce),
  ciphertext: new Uint8Array(envelope.ciphertext)
})

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

const bytesFromHex = (hex: string): Uint8Array => {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(hex)) throw new Error('Invalid hex fixture')
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16))
}

type OfflineCryptoVector = Readonly<{
  readonly name: string
  readonly keyHex: string
  readonly nonceHex: string
  readonly recordId: string
  readonly draftRevision: number
  readonly submissionId: string | null
  readonly plaintext: string
  readonly payload: OfflineDraftPayloadV1
  readonly aadHex: string
  readonly ciphertextHex: string
}>

/*
 * These are independently computed AES-256-GCM vectors (128-bit tags).
 * Keep the encoded AAD, plaintext, and ciphertext as literals so a
 * same-implementation round trip cannot hide wire-format drift.
 */
const OFFLINE_CRYPTO_VECTORS: readonly OfflineCryptoVector[] = [
  {
    name: 'null submissionId',
    keyHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    nonceHex: '101112131415161718191a1b',
    recordId: 'draft-α',
    draftRevision: 3,
    submissionId: null,
    plaintext:
      '{"editorKey":"markdown","pageId":12,"createIdentity":null,"locale":"en","path":"/guide","baseSourceRevision":"7","baseUpdatedAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:01:00.000Z","state":"publishing","title":"A local draft","description":"A draft retained on this device.","content":"# Draft\\n\\nConfidential content."}',
    payload,
    aadHex:
      '000000010000000864726166742dceb1000000000000002a00000000000000000000001173657373696f6e2d73656372' +
      '65742d763100000000000000090000000000000003000000000c101112131415161718191a1b',
    ciphertextHex: [
      '06dcfd7220bd55c18110713f355b0432a53b2a616cac759dc58983003b1d30f96ad8652fd7c51c8a1f42f718eefd7d6f',
      '7ac83e51d9e52c9ed032185d9cf4c50760da05012cd029184ff0548ab0e3d29c12dee7c402f87016a292416c8bd78c60',
      '0e642be4d7dc12e20766bf51565fe5b079e88a479bdaac8fd29faf861bf38c39a7e1f61644d4ecd3469ab6e2e8f97445',
      '9f13526d66f7fbd09e8e68a1ae809d4fa5a3ea29cf8cb39bd9402189a7155173c45b87f7db108e54cf99862adda5db7b',
      '64fe716d8883fe86d7208304226769f7e1d7673119c96c88487cb1801ea0dbec8bae7050230dd003064592c328efd918',
      '5c8ad0986e3529b09c7498b1332fe39715175b88d94003382d862a936944c0c69636a3037be450b380ed1a4f2f8eb4b6',
      '3e73b6af119a9b9dcab067940aa113644ed97a2d80e227d31ea8b7a73c1d53bd7adb3cbe6844140530fdf064a1ae7f8b',
      'a19b8d29928b90d2029b55c9c242'
    ].join('')
  },
  {
    name: 'non-null submissionId',
    keyHex: '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
    nonceHex: 'a0a1a2a3a4a5a6a7a8a9aaab',
    recordId: 'récord-雪',
    draftRevision: 7,
    submissionId: '提交-🔐',
    plaintext:
      '{"editorKey":"markdown","pageId":34,"createIdentity":"writer-α","locale":"fr","path":"/café/雪","baseSourceRevision":"42","baseUpdatedAt":"2026-09-01T12:00:00.000Z","updatedAt":"2026-09-01T12:30:00.000Z","state":"needs-review","title":"Révision hors ligne","description":"Brouillon sécurisé.","content":"# Révision\\n\\n秘密."}',
    payload: payloadWithSubmission,
    aadHex:
      '000000010000000b72c3a9636f72642de99baa000000000000002a00000000000000000000001173657373696f6e2d73' +
      '65637265742d763100000000000000090000000000000007010000000be68f90e4baa42df09f94900000000ca0a1a2a3' +
      'a4a5a6a7a8a9aaab',
    ciphertextHex: [
      '051ec150ada3efd8ea4dd4981c7f1bc7e314a5684bda040e2de2aa9eb62fcbda2566099824cab11fab96b6a42a13f38a',
      '1f27020ecda7c71d181afd1ea2084ce07445bee3c2bd04b42679913efd77a5481dcb4a150014cad099f55977a769c2ca',
      '9e6cf2128f542d29500e77acb5339487dbc50169e88c43ff7f210cc8894f7b29345833843597009e0111a34e57712cae',
      'b8f6d260a21421f7024cbf3abec001c374b6e26fe82837004efe1872182b3283bf61d2de215ccbc25a435f4dcee8f7f5',
      'b4b4d8866adc97707aacaaf9fce50901d33ac0c084a842fce9f36e31e0fc663d8465411797b769bc1ea8d0656d1fac64',
      '49c130f3b5616b48a8adf5390dbb6c9728aae9eb6ba736a0e2fbffc91180e05ae273f2f92c92a8fcc4b28a998a663989',
      '3e94b65e49a765667b14ace5da48f0e5cc5716ad2ec4081ce374e65c752c17877af244904f504ae8d67bbd2234abe2b8',
      'b043ac5c114689687eedf109fbc4'
    ].join('')
  }
]

beforeEach(() => {
  const unusedFetch = createFetchMock(async () => {
    throw new Error('unexpected fetch')
  })
  installBrowserGlobals(fetchType(unusedFetch))
  invalidateOfflineSession()
  lockOfflineReading()
  dispatchedReadingEvents.length = 0
})

afterEach(() => {
  invalidateOfflineSession()
  lockOfflineReading()
  restoreBrowserGlobals()
})
const enrollReadingFixture = async (
  confirmSecret: (displaySecret: string) => boolean | Promise<boolean> = () => true
): Promise<{
  readonly fetchMock: FetchMock
  readonly storage: ReadingStorageFixture
  readonly secret: Uint8Array
  readonly vault: OfflineReadingVaultV1
  readonly handle: OfflineReadingHandleV1
}> => {
  const fetchMock = installFetch(octetStreamResponse(tsork1Frame(readingContext)))
  const storage = createReadingStorage()
  const result = await enrollOfflineReading(fetchType(fetchMock), storage.storage, {
    expectedAccountId: ACCOUNT_ID,
    expectedAuthVersion: READING_AUTH_VERSION,
    expectedSessionGeneration: READING_GENERATION,
    confirmSecret
  })
  return { fetchMock, storage, ...result }
}

describe('offline draft crypto', () => {
  it('imports the authVersion 0 server frame as a non-extractable key and requests an absolute same-origin endpoint', async () => {
    const fetchMock = installFetch(octetStreamResponse(tsodk1Frame(context)))
    const handle = await requestKey(fetchMock)
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

  it('reconciles a same-owner ordinary draft from an older generation only', async () => {
    const oldFetch = installFetch(octetStreamResponse(tsodk1Frame(context)))
    const oldHandle = await requestDraftKey(fetchType(oldFetch), {
      expectedAccountId: ACCOUNT_ID,
      expectedSessionGeneration: SESSION_GENERATION - 1
    })
    const oldEnvelope = await encryptOfflineDraft(oldHandle, payload, {
      recordId: 'old-generation-draft',
      draftRevision: 3,
      submissionId: null
    })

    invalidateOfflineSession()
    const currentFetch = installFetch(octetStreamResponse(tsodk1Frame(context)))
    const currentHandle = await requestKey(currentFetch)
    await expect(decryptOfflineDraftForReconciliation(currentHandle, oldEnvelope)).resolves.toEqual(payload)
    await expect(decryptOfflineDraftForReconciliation(currentHandle, { ...cloneEnvelope(oldEnvelope), accountId: ACCOUNT_ID + 1 })).rejects.toMatchObject({
      code: 'opaque',
      deleteOnly: true
    })
    await expect(decryptOfflineDraftForReconciliation(currentHandle, { ...cloneEnvelope(oldEnvelope), authVersion: 1 })).rejects.toMatchObject({
      code: 'opaque',
      deleteOnly: true
    })
    await expect(decryptOfflineDraftForReconciliation(currentHandle, { ...cloneEnvelope(oldEnvelope), submissionId: 'receipt' })).rejects.toMatchObject({
      code: 'opaque',
      deleteOnly: true
    })
  })

  for (const vector of OFFLINE_CRYPTO_VECTORS) {
    it(`matches the fixed AES-GCM vector for ${vector.name}`, async () => {
      const nonce = bytesFromHex(vector.nonceHex)
      const expectedAad = bytesFromHex(vector.aadHex)
      const expectedCiphertext = bytesFromHex(vector.ciphertextHex)
      const fetchMock = installFetch(octetStreamResponse(tsodk1Frame(context, bytesFromHex(vector.keyHex))))
      const handle = await requestKey(fetchMock)
      const selectors = {
        recordId: vector.recordId,
        draftRevision: vector.draftRevision,
        submissionId: vector.submissionId
      }

      expect(Array.from(encodeOfflineDraftAad(handle, { ...selectors, nonce }))).toEqual(Array.from(expectedAad))

      const directCiphertext = new Uint8Array(
        await globalThis.crypto.subtle.encrypt(
          {
            name: 'AES-GCM',
            iv: nonce as unknown as BufferSource,
            additionalData: expectedAad as unknown as BufferSource,
            tagLength: OFFLINE_DRAFT_TAG_BYTES * 8
          },
          handle.key,
          textEncoder.encode(vector.plaintext) as unknown as BufferSource
        )
      )
      expect(Array.from(directCiphertext)).toEqual(Array.from(expectedCiphertext))

      const randomValuesSpy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(array => {
        const target = new Uint8Array(array.buffer as ArrayBuffer, array.byteOffset, array.byteLength)
        if (target.byteLength !== nonce.byteLength) throw new Error('Unexpected random-value fixture length')
        target.set(nonce)
        return array
      })
      try {
        const encrypted = await encryptOfflineDraft(handle, vector.payload, selectors)
        expect(Array.from(encrypted.nonce)).toEqual(Array.from(nonce))
        expect(Array.from(encrypted.ciphertext)).toEqual(Array.from(expectedCiphertext))
      } finally {
        randomValuesSpy.mockRestore()
      }

      await expect(
        decryptOfflineDraft(handle, {
          schemaVersion: 1,
          recordId: vector.recordId,
          accountId: ACCOUNT_ID,
          authVersion: 0,
          keyVersion: OFFLINE_KEY_VERSION,
          sessionGeneration: SESSION_GENERATION,
          draftRevision: vector.draftRevision,
          submissionId: vector.submissionId,
          nonce,
          ciphertext: expectedCiphertext
        })
      ).resolves.toEqual(vector.payload)
    })
  }

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
      [
        'nonce',
        (value: OfflineDraftEnvelopeV1) => {
          const result = cloneEnvelope(value)
          result.nonce[0] = (result.nonce[0] ?? 0) ^ 1
          return result
        }
      ],
      [
        'ciphertext',
        (value: OfflineDraftEnvelopeV1) => {
          const result = cloneEnvelope(value)
          result.ciphertext[0] = (result.ciphertext[0] ?? 0) ^ 1
          return result
        }
      ]
    ] as const

    for (const [field, mutate] of tampered) {
      const attempt = decryptOfflineDraft(handle, mutate(envelope))
      await expect(attempt, `tampered ${field} selector must stay opaque`).rejects.toMatchObject({ code: 'opaque', deleteOnly: true })
    }
  })

  it.each([
    [
      'wrong magic',
      (() => {
        const frame = tsodk1Frame(context)
        frame[0] = (frame[0] ?? 0) ^ 1
        return frame
      })()
    ],
    ['truncated', tsodk1Frame(context).slice(0, -1)],
    ['trailing bytes', concatBytes([tsodk1Frame(context), new Uint8Array([0])])],
    ['oversized', new Uint8Array(16 * 1024 + 1)]
  ] as const)('rejects a %s TSODK1 response frame', async (_label, frame) => {
    const fetchMock = installFetch(octetStreamResponse(frame))

    await expect(requestKey(fetchMock)).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
  })

  it('shares one current-owner acquisition and keeps concurrent consumers usable', async () => {
    let releaseResponse: (response: Response) => void = () => {}
    const fetchMock = createFetchMock(
      (_input, _init) =>
        new Promise<Response>(resolve => {
          releaseResponse = resolve
        })
    )
    installBrowserGlobals(fetchType(fetchMock))

    const first = requestKey(fetchMock)
    await Promise.resolve()
    const second = requestKey(fetchMock)
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    releaseResponse(octetStreamResponse(tsodk1Frame(context)))
    const [firstHandle, secondHandle] = await Promise.all([first, second])
    expect(secondHandle).toBe(firstHandle)
    expect(isCurrentOfflineDraftKey(firstHandle)).toBe(true)

    const envelope = await encryptOfflineDraft(firstHandle, payload, { recordId: 'record-1', draftRevision: 3, submissionId: null })
    await expect(decryptOfflineDraft(secondHandle, envelope)).resolves.toEqual(payload)
  })

  it('cancels one caller wait without aborting another same-owner consumer', async () => {
    let releaseResponse: (response: Response) => void = () => {}
    const fetchMock = createFetchMock(
      (_input, _init) =>
        new Promise<Response>(resolve => {
          releaseResponse = resolve
        })
    )
    installBrowserGlobals(fetchType(fetchMock))
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = requestKey(fetchMock, { signal: firstController.signal })
    await Promise.resolve()
    const second = requestKey(fetchMock, { signal: secondController.signal })
    await Promise.resolve()
    firstController.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    releaseResponse(octetStreamResponse(tsodk1Frame(context)))
    const handle = await second
    expect(isCurrentOfflineDraftKey(handle)).toBe(true)
    secondController.abort()
  })

  it('does not publish a key when invalidation races import', async () => {
    const fetchMock = installFetch(octetStreamResponse(tsodk1Frame(context)))
    const originalImportKey = globalThis.crypto.subtle.importKey.bind(globalThis.crypto.subtle)
    let releaseImport: (key: CryptoKey) => void = () => {}
    let importStartedResolve: () => void = () => {}
    const importStarted = new Promise<void>(resolve => {
      importStartedResolve = resolve
    })
    const importSpy = vi.spyOn(globalThis.crypto.subtle, 'importKey').mockImplementation(
      async (...args) =>
        await new Promise<CryptoKey>(resolve => {
          importStartedResolve()
          releaseImport = asyncKey => resolve(asyncKey)
          void args
        })
    )
    try {
      const request = requestKey(fetchMock)
      await importStarted
      expect(importSpy).toHaveBeenCalledTimes(1)
      invalidateOfflineSession()
      const imported = await originalImportKey('raw', new Uint8Array(KEY_BYTES), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
      releaseImport(imported)
      await expect(request).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    } finally {
      importSpy.mockRestore()
    }
  })

  it('cancels an oversized streamed response before buffering beyond the frame bound', async () => {
    let canceled = false
    let emitted = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!emitted) {
          emitted = true
          controller.enqueue(new Uint8Array(16 * 1024))
          return
        }
        controller.enqueue(new Uint8Array([1]))
      },
      cancel() {
        canceled = true
      }
    })
    const fetchMock = installFetch(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' }
      })
    )

    await expect(requestKey(fetchMock)).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    expect(canceled).toBe(true)
  })
  it('keeps a failed key release fenced until the local session boundary is explicit', async () => {
    const malformed = tsodk1Frame(context)
    malformed[0] = (malformed[0] ?? 0) ^ 1
    const failedFetch = installFetch(octetStreamResponse(malformed))
    await expect(requestKey(failedFetch)).rejects.toBeInstanceOf(OfflineDraftOpaqueError)

    const foreignContext = { ...context, accountId: ACCOUNT_ID + 1 }
    invalidateOfflineSession()
    const recoveredFetch = installFetch(octetStreamResponse(tsodk1Frame(foreignContext)))
    const recovered = await requestDraftKey(fetchType(recoveredFetch), {
      expectedAccountId: foreignContext.accountId,
      expectedSessionGeneration: SESSION_GENERATION
    })
    expect(isCurrentOfflineDraftKey(recovered)).toBe(true)
  })

  it('invalidates stale handles and fences a late response after the session boundary', async () => {
    const initialFetch = installFetch(octetStreamResponse(tsodk1Frame(context)))
    const initialHandle = await requestKey(initialFetch)
    invalidateOfflineSession()

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
    await expect(encryptOfflineDraft(initialHandle, payload, { recordId: 'record-1', draftRevision: 3, submissionId: null })).rejects.toBeInstanceOf(
      OfflineDraftOpaqueError
    )

    const request = (lateFetch.mock.calls[0] as [RequestInfo | URL, RequestInit])[1]
    expect(request.signal?.aborted).toBe(true)
    releaseResponse(octetStreamResponse(tsodk1Frame(context)))
    await expect(lateRequest).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
  })
  it('strictly parses bounded TSORK1 frames and rejects malformed context fields', () => {
    const expected = {
      canonicalOrigin: ORIGIN,
      expectedAccountId: ACCOUNT_ID,
      expectedSessionGeneration: READING_GENERATION,
      expectedAuthVersion: READING_AUTH_VERSION,
      expectedSiteId: SITE_ID
    }
    const parsed = parseOfflineReadingKeyFrame(tsork1Frame(readingContext), expected)
    expect(parsed.context).toEqual(readingContext)
    expect(Array.from(parsed.keyBytes)).toEqual(Array.from(READING_KEY_BYTES))

    const malformedFrames: readonly [string, Uint8Array][] = [
      [
        'wrong magic',
        (() => {
          const frame = tsork1Frame(readingContext)
          frame[0] = (frame[0] ?? 0) ^ 1
          return frame
        })()
      ],
      ['truncated', tsork1Frame(readingContext).slice(0, -1)],
      ['trailing bytes', concatBytes([tsork1Frame(readingContext), new Uint8Array([0])])],
      ['oversized frame', new Uint8Array(16 * 1024 + 1)],
      ['oversized origin field', concatBytes([textEncoder.encode(OFFLINE_READING_KEY_MAGIC), lpUtf8('x'.repeat(8193))])],
      ['oversized site field', concatBytes([textEncoder.encode(OFFLINE_READING_KEY_MAGIC), lpUtf8(ORIGIN), lpUtf8('x'.repeat(1025))])],
      ['oversized key id field', tsork1Frame({ ...readingContext, keyId: 'x'.repeat(129) })],
      ['invalid origin', tsork1Frame({ ...readingContext, canonicalOrigin: `${ORIGIN}/path` })],
      ['invalid key id', tsork1Frame({ ...readingContext, keyId: 'A'.repeat(21) })],
      ['wrong key version', tsork1Frame({ ...readingContext, keyVersion: 'random-reading-v2' as typeof OFFLINE_READING_KEY_VERSION })],
      ['wrong site expectation', tsork1Frame({ ...readingContext, siteId: 'another-site' })],
      ['wrong auth expectation', tsork1Frame({ ...readingContext, authVersion: READING_AUTH_VERSION + 1 })]
    ]
    for (const [label, frame] of malformedFrames) {
      expect(() => parseOfflineReadingKeyFrame(frame, expected), `malformed ${label} frame must stay opaque`).toThrow(OfflineDraftOpaqueError)
    }
  })

  it('generates and canonically encodes independent reading secrets', () => {
    const secret = generateOfflineReadingSecret()
    const displaySecret = encodeOfflineReadingSecret(secret)

    expect(secret).toHaveLength(32)
    expect(displaySecret).toHaveLength(43)
    expect(displaySecret).not.toContain('=')
    expect(Array.from(decodeOfflineReadingSecret(displaySecret))).toEqual(Array.from(secret))
    expect(confirmOfflineReadingSecret(secret, new Uint8Array(32))).toBe(false)
    expect(() => decodeOfflineReadingSecret(`${displaySecret}=`)).toThrow(OfflineDraftOpaqueError)
  })

  it('binds wrapped reading keys to the secret, context, salt, nonce, and ciphertext', async () => {
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index + 10)
    const salt = Uint8Array.from({ length: OFFLINE_READING_SALT_BYTES }, (_, index) => index + 1)
    const nonce = Uint8Array.from({ length: OFFLINE_READING_NONCE_BYTES }, (_, index) => index + 33)
    const wrapped = await wrapOfflineReadingKey(secret, readingContext, READING_GENERATION, salt, nonce, READING_KEY_BYTES)

    await expect(unwrapOfflineReadingKey(secret, readingContext, READING_GENERATION, salt, nonce, wrapped)).resolves.toEqual(READING_KEY_BYTES)
    const wrongSecret = new Uint8Array(secret)
    wrongSecret[0] = (wrongSecret[0] ?? 0) ^ 1
    await expect(unwrapOfflineReadingKey(wrongSecret, readingContext, READING_GENERATION, salt, nonce, wrapped)).rejects.toBeInstanceOf(OfflineDraftOpaqueError)

    const alteredContexts: readonly OfflineReadingContextV1[] = [
      { ...readingContext, canonicalOrigin: 'https://other.example.test' },
      { ...readingContext, siteId: 'other-site' },
      { ...readingContext, accountId: ACCOUNT_ID + 1 },
      { ...readingContext, authVersion: READING_AUTH_VERSION + 1 },
      { ...readingContext, keyId: 'AQEBAQEBAQEBAQEBAQEBAQ' }
    ]
    for (const alteredContext of alteredContexts) {
      await expect(unwrapOfflineReadingKey(secret, alteredContext, READING_GENERATION, salt, nonce, wrapped)).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    }
    await expect(unwrapOfflineReadingKey(secret, readingContext, READING_GENERATION + 1, salt, nonce, wrapped)).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    await expect(unwrapOfflineReadingKey(secret, readingContext, READING_GENERATION, mutateByte(salt), nonce, wrapped)).rejects.toBeInstanceOf(
      OfflineDraftOpaqueError
    )
    await expect(unwrapOfflineReadingKey(secret, readingContext, READING_GENERATION, salt, mutateByte(nonce), wrapped)).rejects.toBeInstanceOf(
      OfflineDraftOpaqueError
    )
    await expect(unwrapOfflineReadingKey(secret, readingContext, READING_GENERATION, salt, nonce, mutateByte(wrapped))).rejects.toBeInstanceOf(
      OfflineDraftOpaqueError
    )
  })

  it('fences reading state synchronously on pageshow and document visibility changes', async () => {
    const windowListeners = new Map<string, Array<() => void>>()
    const documentListeners = new Map<string, Array<() => void>>()
    const windowObject = globalThis.window as unknown as {
      addEventListener: (type: string, listener: () => void) => void
    }
    const documentObject = globalThis.document as unknown as {
      addEventListener: (type: string, listener: () => void) => void
    }
    windowObject.addEventListener = (type, listener) => {
      const listeners = windowListeners.get(type) ?? []
      listeners.push(listener)
      windowListeners.set(type, listeners)
    }
    documentObject.addEventListener = (type, listener) => {
      const listeners = documentListeners.get(type) ?? []
      listeners.push(listener)
      documentListeners.set(type, listeners)
    }

    const fetchMock = createFetchMock(async () => octetStreamResponse(tsork1Frame(readingContext)))
    const storage = createReadingStorage()
    const enrolled = await enrollOfflineReading(fetchType(fetchMock), storage.storage, {
      expectedAccountId: ACCOUNT_ID,
      expectedAuthVersion: READING_AUTH_VERSION,
      expectedSessionGeneration: READING_GENERATION,
      confirmSecret: () => true
    })
    expect(windowListeners.has('focus')).toBe(true)
    expect(windowListeners.has('pageshow')).toBe(true)
    expect(documentListeners.has('visibilitychange')).toBe(true)
    expect(currentOfflineReadingHandle()).toBe(enrolled.handle)

    for (const listener of windowListeners.get('pageshow') ?? []) listener()
    expect(currentOfflineReadingHandle()).toBeNull()
    lockOfflineReading()

    const secondFetchMock = createFetchMock(async () => octetStreamResponse(tsork1Frame(readingContext)))
    const secondStorage = createReadingStorage()
    const enrolledAgain = await enrollOfflineReading(fetchType(secondFetchMock), secondStorage.storage, {
      expectedAccountId: ACCOUNT_ID,
      expectedAuthVersion: READING_AUTH_VERSION,
      expectedSessionGeneration: READING_GENERATION,
      confirmSecret: () => true
    })
    for (const listener of documentListeners.get('visibilitychange') ?? []) listener()
    expect(currentOfflineReadingHandle()).toBeNull()
    expect(enrolledAgain.handle.sessionGeneration).toBe(READING_GENERATION)
  })

  it('confirms a generated secret and unlocks a wrapped vault after a simulated browser reload', async () => {
    let displayedSecret = ''
    const enrolled = await enrollReadingFixture(displaySecret => {
      displayedSecret = displaySecret
      return true
    })
    const persisted = enrolled.storage.getVault()
    expect(persisted).not.toBeNull()
    expect(Object.keys(persisted ?? {}).sort()).toEqual(['context', 'nonce', 'salt', 'schemaVersion', 'sessionGeneration', 'wrappedKey'])
    expect(persisted).not.toHaveProperty('secret')
    expect(persisted).not.toHaveProperty('keyBytes')
    expect(persisted?.wrappedKey.byteLength).toBe(48)
    expect(Array.from(persisted?.wrappedKey.slice(0, READING_KEY_BYTES.byteLength) ?? [])).not.toEqual(Array.from(READING_KEY_BYTES))
    expect(displayedSecret).toBe(encodeOfflineReadingSecret(enrolled.secret))
    expect(decodeOfflineReadingSecret(displayedSecret)).toEqual(enrolled.secret)
    expect(enrolled.handle.key.extractable).toBe(false)
    lockOfflineReading()
    expect(isCurrentOfflineReadingHandle(enrolled.handle)).toBe(false)
    expect(currentOfflineReadingHandle()).toBeNull()
    const wrongSecret = new Uint8Array(enrolled.secret)
    wrongSecret[0] = (wrongSecret[0] ?? 0) ^ 1
    await expect(unlockOfflineReading(enrolled.storage.storage, wrongSecret)).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    const reloaded = await unlockOfflineReading(enrolled.storage.storage, new Uint8Array(enrolled.secret))
    expect(reloaded).not.toBe(enrolled.handle)
    expect(reloaded.key.extractable).toBe(false)
    expect(isCurrentOfflineReadingHandle(reloaded)).toBe(true)
  })

  it('publishes reading state changes and advances the epoch on lock fences', async () => {
    const enrolled = await enrollReadingFixture()
    expect(dispatchedReadingEvents).toEqual([OFFLINE_READING_STATE_EVENT])
    const unlockedEpoch = currentOfflineReadingEpoch()
    expect(currentOfflineReadingHandle()).toBe(enrolled.handle)

    lockOfflineReading()

    expect(currentOfflineReadingEpoch()).toBe(unlockedEpoch + 1)
    expect(dispatchedReadingEvents).toEqual([OFFLINE_READING_STATE_EVENT, OFFLINE_READING_STATE_EVENT])
    expect(currentOfflineReadingHandle()).toBeNull()
  })
  it('rejects an enrollment whose generated secret is not confirmed and does not persist a vault', async () => {
    const fetchMock = installFetch(octetStreamResponse(tsork1Frame(readingContext)))
    const storage = createReadingStorage()
    await expect(
      enrollOfflineReading(fetchType(fetchMock), storage.storage, {
        expectedAccountId: ACCOUNT_ID,
        expectedSessionGeneration: READING_GENERATION,
        confirmSecret: () => false
      })
    ).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    expect(storage.getVault()).toBeNull()
    expect(currentOfflineReadingHandle()).toBeNull()
  })

  it('fences enrollment and unlock results that lose the reading lifecycle epoch', async () => {
    let releaseResponse: (response: Response) => void = () => {}
    const fetchMock = createFetchMock(
      () =>
        new Promise<Response>(resolve => {
          releaseResponse = resolve
        })
    )
    installBrowserGlobals(fetchType(fetchMock))
    const storage = createReadingStorage()
    const enrollment = enrollOfflineReading(fetchType(fetchMock), storage.storage, {
      expectedAccountId: ACCOUNT_ID,
      expectedSessionGeneration: READING_GENERATION,
      confirmSecret: () => true
    })
    await Promise.resolve()
    lockOfflineReading()
    releaseResponse(octetStreamResponse(tsork1Frame(readingContext)))
    await expect(enrollment).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    expect(storage.getVault()).toBeNull()

    const enrolled = await enrollReadingFixture()
    lockOfflineReading()
    let releaseVault: (vault: OfflineReadingVaultV1) => void = () => {}
    const delayedStorage = {
      currentSessionGeneration: async () => READING_GENERATION,
      getReadingVault: async () =>
        await new Promise<OfflineReadingVaultV1>(resolve => {
          releaseVault = resolve
        }),
      putReadingVault: async (_vault: OfflineReadingVaultV1) => {}
    }
    const unlock = unlockOfflineReading(delayedStorage, new Uint8Array(enrolled.secret))
    await Promise.resolve()
    lockOfflineReading()
    releaseVault(enrolled.vault)
    await expect(unlock).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    expect(currentOfflineReadingHandle()).toBeNull()
  })

  it('requires an authoritative private snapshot response and binds account, site, authVersion, page, and locale selectors', async () => {
    const enrolled = await enrollReadingFixture()
    const pairId = generateOfflineReadingPairId()
    const selectors = { pageId: readingSnapshot.pageId, locale: readingSnapshot.locale, recordRevision: 1, pairId }
    const responsePayload = {
      schemaVersion: 1 as const,
      audience: 'private' as const,
      context: {
        canonicalOrigin: ORIGIN,
        siteId: SITE_ID,
        accountId: ACCOUNT_ID,
        authVersion: READING_AUTH_VERSION
      },
      snapshot: readingSnapshot
    }
    const envelope = await encryptOfflinePrivateRecord(enrolled.handle, 'snapshot', responsePayload, selectors)
    await expect(
      encryptOfflinePrivateRecord(
        enrolled.handle,
        'snapshot',
        { ...responsePayload, context: { ...responsePayload.context, authVersion: READING_AUTH_VERSION + 1 } },
        selectors
      )
    ).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    await expect(decryptOfflinePrivateRecord(enrolled.handle, envelope)).resolves.toEqual(readingSnapshot)
    await expect(encryptOfflinePrivateRecord(enrolled.handle, 'snapshot', readingSnapshot, selectors)).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    await expect(
      encryptOfflinePrivateRecord(enrolled.handle, 'search', { ...readingSearchDocument, sourceRevision: '7', siteId: 'other-site' }, selectors)
    ).rejects.toBeInstanceOf(OfflineDraftOpaqueError)

    const contextTampered: readonly [string, OfflinePrivateEnvelopeV1][] = [
      ['accountId', { ...clonePrivateEnvelope(envelope), context: { ...envelope.context, accountId: ACCOUNT_ID + 1 } }],
      ['siteId', { ...clonePrivateEnvelope(envelope), context: { ...envelope.context, siteId: 'other-site' } }],
      ['authVersion', { ...clonePrivateEnvelope(envelope), context: { ...envelope.context, authVersion: READING_AUTH_VERSION + 1 } }],
      ['pageId', { ...clonePrivateEnvelope(envelope), pageId: readingSnapshot.pageId + 1 }],
      ['locale', { ...clonePrivateEnvelope(envelope), locale: 'fr' }]
    ]
    for (const [field, tampered] of contextTampered) {
      await expect(decryptOfflinePrivateRecord(enrolled.handle, tampered), `tampered ${field} selector must stay opaque`).rejects.toBeInstanceOf(
        OfflineDraftOpaqueError
      )
    }
  })

  it('fails closed for torn body/search pairs and sourceRevision mismatches', async () => {
    const enrolled = await enrollReadingFixture()
    const pairId = generateOfflineReadingPairId()
    const selectors = { pageId: readingSnapshot.pageId, locale: readingSnapshot.locale, recordRevision: 1, pairId }
    const responsePayload = {
      schemaVersion: 1 as const,
      audience: 'private' as const,
      context: {
        canonicalOrigin: ORIGIN,
        siteId: SITE_ID,
        accountId: ACCOUNT_ID,
        authVersion: READING_AUTH_VERSION
      },
      snapshot: readingSnapshot
    }
    const body = await encryptOfflinePrivateRecord(enrolled.handle, 'snapshot', responsePayload, selectors)
    const search = await encryptOfflinePrivateRecord(
      enrolled.handle,
      'search',
      { ...readingSearchDocument, sourceRevision: readingSnapshot.sourceRevision },
      selectors
    )
    const policyStateEnvelope = await encryptOfflinePrivateRecord(enrolled.handle, 'policy-state', readingPolicyState, {
      pageId: null,
      locale: null,
      recordRevision: 2,
      pairId: null
    })
    const policyPageEnvelope = await encryptOfflinePrivateRecord(enrolled.handle, 'policy-page', readingPolicyPage, {
      pageId: readingPolicyPage.pageId,
      locale: readingPolicyPage.locale,
      recordRevision: 2,
      pairId: null
    })
    const coherentRecords = [body, search, policyStateEnvelope, policyPageEnvelope] as const
    const storageFor = (records: readonly OfflinePrivateEnvelopeV1[]) => ({
      currentCorpusRevision: async () => 4,
      listPrivateRecords: async (_keyId: string, _options?: { readonly expectedSessionGeneration?: number; readonly expectedCorpusRevision?: number }) =>
        records
    })

    const ciphertextTampered = clonePrivateEnvelope(body)
    ciphertextTampered.ciphertext[0] = (ciphertextTampered.ciphertext[0] ?? 0) ^ 1
    await expect(readPrivateCorpus(enrolled.handle, storageFor([ciphertextTampered, search, policyStateEnvelope, policyPageEnvelope]))).rejects.toBeInstanceOf(
      OfflineDraftOpaqueError
    )

    const corpus = await readPrivateCorpus(enrolled.handle, storageFor(coherentRecords))
    expect(corpus.snapshots).toEqual([readingSnapshot])
    expect(corpus.searchDocuments).toEqual([{ ...readingSearchDocument, sourceRevision: readingSnapshot.sourceRevision }])
    expect(corpus.corpusRevision).toBe(4)

    const pairTampered = clonePrivateEnvelope(body)
    pairTampered.pairId = generateOfflineReadingPairId()
    await expect(readPrivateCorpus(enrolled.handle, storageFor([pairTampered, search, policyStateEnvelope, policyPageEnvelope]))).rejects.toBeInstanceOf(
      OfflineDraftOpaqueError
    )
    const revisionTampered = clonePrivateEnvelope(body)
    revisionTampered.recordRevision = 2
    await expect(readPrivateCorpus(enrolled.handle, storageFor([revisionTampered, search, policyStateEnvelope, policyPageEnvelope]))).rejects.toBeInstanceOf(
      OfflineDraftOpaqueError
    )
    await expect(readPrivateCorpus(enrolled.handle, storageFor(coherentRecords), 3)).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    await expect(readPrivateCorpus(enrolled.handle, storageFor([body]))).rejects.toBeInstanceOf(OfflineDraftOpaqueError)

    const mismatchedSearch = await encryptOfflinePrivateRecord(enrolled.handle, 'search', { ...readingSearchDocument, sourceRevision: '8' }, selectors)
    await expect(readPrivateCorpus(enrolled.handle, storageFor([body, mismatchedSearch, policyStateEnvelope, policyPageEnvelope]))).rejects.toBeInstanceOf(
      OfflineDraftOpaqueError
    )
    await expect(readPrivateCorpus(enrolled.handle, storageFor([body, body, search, policyStateEnvelope, policyPageEnvelope]))).rejects.toBeInstanceOf(
      OfflineDraftOpaqueError
    )
    await expect(readPrivateCorpus(enrolled.handle, storageFor([body, search, policyPageEnvelope]))).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    await expect(readPrivateCorpus(enrolled.handle, storageFor([body, search, policyStateEnvelope]))).rejects.toBeInstanceOf(OfflineDraftOpaqueError)
    const mixedPolicyRevision = await encryptOfflinePrivateRecord(enrolled.handle, 'policy-page', readingPolicyPage, {
      pageId: readingPolicyPage.pageId,
      locale: readingPolicyPage.locale,
      recordRevision: 3,
      pairId: null
    })
    await expect(readPrivateCorpus(enrolled.handle, storageFor([body, search, policyStateEnvelope, mixedPolicyRevision]))).rejects.toBeInstanceOf(
      OfflineDraftOpaqueError
    )
    for (const page of [
      { ...readingPolicyPage, availability: 'ineligible' as const },
      { ...readingPolicyPage, excluded: true },
      { ...readingPolicyPage, manual: false, automatic: false, tag: false }
    ]) {
      const ineligiblePolicy = await encryptOfflinePrivateRecord(enrolled.handle, 'policy-page', page, {
        pageId: page.pageId,
        locale: page.locale,
        recordRevision: 2,
        pairId: null
      })
      await expect(readPrivateCorpus(enrolled.handle, storageFor([body, search, policyStateEnvelope, ineligiblePolicy]))).rejects.toBeInstanceOf(
        OfflineDraftOpaqueError
      )
    }

    const wrongPolicyState = await encryptOfflinePrivateRecord(
      enrolled.handle,
      'policy-state',
      { ...readingPolicyState, policyRevision: 2 },
      { pageId: null, locale: null, recordRevision: 2, pairId: null }
    )
    await expect(readPrivateCorpus(enrolled.handle, storageFor([body, search, wrongPolicyState, policyPageEnvelope]))).rejects.toBeInstanceOf(
      OfflineDraftOpaqueError
    )
  })
})
