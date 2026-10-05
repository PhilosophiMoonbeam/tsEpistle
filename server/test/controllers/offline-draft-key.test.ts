import { createCipheriv, createDecipheriv } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { createOriginMiddleware } from '../../middlewares/origin.ts'
import type * as OfflineDraftKeys from '../../helpers/offline-draft-keys.ts'
import {
  OFFLINE_KEY_VERSION,
  OFFLINE_READING_CONTEXT_SCHEMA_VERSION,
  OFFLINE_READING_KEY_BYTES,
  OFFLINE_READING_KEY_VERSION,
  type DraftKeyContext,
  type OfflineReadingContextV1
} from '../../../shared/offline.ts'

const actualOfflineDraftKeys = { ...(await vi.importFresh<OfflineDraftKeys>('../../helpers/offline-draft-keys.ts', import.meta.url)) }

const router = { post: vi.fn() }
const resolveOfflineDraftKeyContext = vi.fn()
const createOfflineDraftKeyFrame = vi.fn()
const resolveOfflineReadingContext = vi.fn()
const createOfflineReadingKeyFrame = vi.fn()
const runtime = {
  INSTANCE_ID: 'process-fixture',
  config: {
    host: 'https://wiki.example.test',
    offlineDraftSiteId: 'site-fixture',
    offlineDraftSecret: 'configured-session-secret',
    sessionSecret: 'session-protection-secret'
  },
  models: {
    users: {
      query: () => ({
        findById: async (id: number) => (id === 7 ? { id: 7, isActive: true, authVersion: 3 } : undefined)
      })
    }
  }
}

vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
vi.mockModule('../../controllers/_types.ts', import.meta.url, () => ({
  errorStatus: (error: unknown) => (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number' ? error.status : 0),
  getTransportRuntime: () => runtime
}))
vi.mockModule('../../helpers/offline-draft-keys.ts', import.meta.url, () => ({
  createOfflineDraftKeyFrame,
  createOfflineReadingKeyFrame,
  resolveOfflineDraftKeyContext,
  resolveOfflineReadingContext
}))
await vi.importFresh('../../controllers/api/offline.ts', import.meta.url)

const draftKeyRoute = router.post.mock.calls.find(([path]) => path === '/draft-key')!
const readingKeyRoute = router.post.mock.calls.find(([path]) => path === '/reading-key')!
const privacyHeaders = draftKeyRoute[1]!
const sameOriginFetchSite = draftKeyRoute[2]!
const issueDraftKey = draftKeyRoute[3]!
const issueReadingKey = readingKeyRoute[3]!

const response = () => {
  const res = {
    json: vi.fn(),
    send: vi.fn(),
    set: vi.fn(),
    append: vi.fn(),
    get: vi.fn(() => undefined),
    status: vi.fn()
  }
  res.status.mockReturnValue(res)
  return res
}

beforeEach(() => {
  resolveOfflineDraftKeyContext.mockReset()
  createOfflineDraftKeyFrame.mockReset()
  resolveOfflineReadingContext.mockReset()
  createOfflineReadingKeyFrame.mockReset()
})

const vectorContext: DraftKeyContext = {
  canonicalOrigin: 'https://wiki.example.test',
  siteId: 'site-fixture',
  accountId: 7,
  authVersion: 3,
  keyVersion: OFFLINE_KEY_VERSION
}
const readingContext: OfflineReadingContextV1 = {
  schemaVersion: OFFLINE_READING_CONTEXT_SCHEMA_VERSION,
  canonicalOrigin: 'https://wiki.example.test',
  siteId: 'site-fixture',
  accountId: 7,
  authVersion: 3,
  keyVersion: OFFLINE_READING_KEY_VERSION,
  keyId: 'AQEBAQEBAQEBAQEBAQEBAQ'
}
const vectorKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1)

const decodeKeyFrame = (frame: Buffer, reading = false) => {
  let offset = 6
  const readString = (): string => {
    const length = frame.readUInt32BE(offset)
    offset += 4
    const value = frame.subarray(offset, offset + length).toString('utf8')
    offset += length
    return value
  }
  const readInteger = (): bigint => {
    const value = frame.readBigUInt64BE(offset)
    offset += 8
    return value
  }
  const context = {
    canonicalOrigin: readString(),
    siteId: readString(),
    accountId: readInteger(),
    authVersion: readInteger(),
    keyVersion: readString(),
    ...(reading ? { keyId: readString() } : {})
  }
  return { magic: frame.subarray(0, 6).toString('ascii'), context, keyBytes: frame.subarray(offset) }
}

describe('offline draft-key transport boundary', () => {
  it('applies privacy headers before downstream rejection', () => {
    const res = response()
    const next = vi.fn()

    privacyHeaders({} as never, res, next)

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.append).toHaveBeenCalledWith('Vary', 'Cookie')
    expect(next).toHaveBeenCalledOnce()
  })

  it.each(['cross-site', 'same-site', 'none', 'null'])('rejects %s Fetch Metadata before attempting authentication or key issuance', value => {
    const next = vi.fn()
    const res = response()
    const req = { get: vi.fn(() => value) }

    privacyHeaders(req, res, vi.fn())
    sameOriginFetchSite(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'A same-origin request is required.' })
    expect(next).not.toHaveBeenCalled()
    expect(resolveOfflineDraftKeyContext).not.toHaveBeenCalled()
    expect(createOfflineDraftKeyFrame).not.toHaveBeenCalled()
  })

  it('requires the exact configured Origin for the mounted draft-key POST', () => {
    const origin = createOriginMiddleware(() => runtime.config.host)

    for (const value of [undefined, 'https://evil.example.test', 'https://wiki.example.test/', 'null']) {
      const res = response()
      const next = vi.fn()
      const req = {
        method: 'POST',
        path: '/_api/offline/draft-key',
        get: vi.fn((name: string) => (name === 'origin' ? value : undefined))
      }

      privacyHeaders(req, res, vi.fn())
      origin(req as never, res as never, next)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith({ error: 'A same-origin request is required.' })
      expect(next).not.toHaveBeenCalled()
    }

    const exact = response()
    const next = vi.fn()
    const exactRequest = {
      method: 'POST',
      path: '/_api/offline/draft-key',
      get: vi.fn((name: string) => (name === 'origin' ? runtime.config.host : undefined))
    }
    privacyHeaders(exactRequest, exact, vi.fn())
    origin(exactRequest as never, exact as never, next)
    expect(next).toHaveBeenCalledOnce()
    expect(exact.status).not.toHaveBeenCalled()
  })

  it('matches the exact TSODK1 HKDF and frame known-answer vectors', () => {
    const expectedKey = '63098f7357e0fe53824c85ccfc51a58e97ee2c4db1cfc16efb07af2e38986829'
    const expectedFrame =
      '54534f444b310000001968747470733a2f2f77696b692e6578616d706c652e746573740000000c736974652d66697874757265000000000000000700000000000000030000001173657373696f6e2d7365637265742d76310102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'

    expect(actualOfflineDraftKeys.deriveOfflineDraftKey(vectorContext, 'configured-session-secret').toString('hex')).toBe(expectedKey)
    expect(actualOfflineDraftKeys.encodeOfflineDraftKeyFrame(vectorContext, vectorKey).toString('hex')).toBe(expectedFrame)
    expect(actualOfflineDraftKeys.createOfflineDraftKeyFrame(vectorContext, 'configured-session-secret').toString('hex')).toBe(
      '54534f444b310000001968747470733a2f2f77696b692e6578616d706c652e746573740000000c736974652d66697874757265000000000000000700000000000000030000001173657373696f6e2d7365637265742d763163098f7357e0fe53824c85ccfc51a58e97ee2c4db1cfc16efb07af2e38986829'
    )
  })

  it('uses configured installation identity and falls back to canonical origin, not process identity', async () => {
    const users = {
      query: () => ({
        findById: async () => ({ id: 7, isActive: true, authVersion: 3 })
      })
    }
    const request = {
      authContext: {
        kind: 'user',
        userId: 7,
        principal: { id: 7, authVersion: 3 }
      }
    }
    const baseRuntime = {
      config: { host: 'https://wiki.example.test', offlineDraftSecret: 'configured-session-secret' },
      models: { users }
    }
    const first = await actualOfflineDraftKeys.resolveOfflineDraftKeyContext(request as never, { ...baseRuntime, INSTANCE_ID: 'process-a' } as never)
    const second = await actualOfflineDraftKeys.resolveOfflineDraftKeyContext(request as never, { ...baseRuntime, INSTANCE_ID: 'process-b' } as never)

    expect(first.siteId).toBe('https://wiki.example.test')
    expect(second.siteId).toBe(first.siteId)
    const configured = await actualOfflineDraftKeys.resolveOfflineDraftKeyContext(
      request as never,
      {
        ...baseRuntime,
        INSTANCE_ID: 'process-c',
        config: { ...baseRuntime.config, offlineDraftSiteId: 'installed-site' }
      } as never
    )
    expect(configured.siteId).toBe('installed-site')
  })
  it('resolves a current human reading context with a fresh random key id', async () => {
    const users = {
      query: () => ({
        findById: async () => ({ id: 7, isActive: true, authVersion: 3 })
      })
    }
    const request = {
      authContext: {
        kind: 'user',
        userId: 7,
        principal: { id: 7, authVersion: 3 }
      }
    }
    const readingRuntime = {
      config: { host: 'https://wiki.example.test' },
      models: { users }
    }
    const context = await actualOfflineDraftKeys.resolveOfflineReadingContext(request as never, readingRuntime as never)
    const second = await actualOfflineDraftKeys.resolveOfflineReadingContext(request as never, readingRuntime as never)

    expect(context).toMatchObject({
      schemaVersion: OFFLINE_READING_CONTEXT_SCHEMA_VERSION,
      canonicalOrigin: 'https://wiki.example.test',
      siteId: 'https://wiki.example.test',
      accountId: 7,
      authVersion: 3,
      keyVersion: OFFLINE_READING_KEY_VERSION
    })
    expect(context.keyId).toMatch(/^[A-Za-z0-9_-]{22}$/u)
    expect(second.keyId).not.toBe(context.keyId)
  })

  it('admits same-origin fetches without trusting claimed account or origin fields and sends the exact binary frame', async () => {
    resolveOfflineDraftKeyContext.mockImplementation(actualOfflineDraftKeys.resolveOfflineDraftKeyContext)
    createOfflineDraftKeyFrame.mockImplementation(actualOfflineDraftKeys.createOfflineDraftKeyFrame)
    const req = {
      authContext: { kind: 'user', userId: 7, principal: { id: 7, authVersion: 3 } },
      get: vi.fn(() => 'same-origin'),
      body: { canonicalOrigin: 'https://evil.example.test', siteId: 'evil-site', accountId: 999, authVersion: 0 }
    }
    const res = response()
    const next = vi.fn()

    privacyHeaders(req, res, vi.fn())
    const admitted = vi.fn()
    sameOriginFetchSite(req, res, admitted)
    expect(admitted).toHaveBeenCalledOnce()
    await issueDraftKey(req, res, next)

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.append).toHaveBeenCalledWith('Vary', 'Cookie')
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/octet-stream')
    expect(res.status).toHaveBeenCalledWith(200)
    const frame = res.send.mock.calls[0]?.[0]
    expect(Buffer.isBuffer(frame)).toBe(true)
    expect(frame.toString('hex')).toBe(
      '54534f444b310000001968747470733a2f2f77696b692e6578616d706c652e746573740000000c736974652d66697874757265000000000000000700000000000000030000001173657373696f6e2d7365637265742d763163098f7357e0fe53824c85ccfc51a58e97ee2c4db1cfc16efb07af2e38986829'
    )
    const decoded = decodeKeyFrame(frame)
    expect(decoded.magic).toBe('TSODK1')
    expect(decoded.context).toEqual({
      canonicalOrigin: 'https://wiki.example.test',
      siteId: 'site-fixture',
      accountId: 7n,
      authVersion: 3n,
      keyVersion: 'session-secret-v1'
    })
    expect(decoded.keyBytes.byteLength).toBe(32)
    expect(next).not.toHaveBeenCalled()
  })

  it('decrypts a legacy offline draft with endpoint keys before and after session protection rotates', async () => {
    resolveOfflineDraftKeyContext.mockImplementation(actualOfflineDraftKeys.resolveOfflineDraftKeyContext)
    createOfflineDraftKeyFrame.mockImplementation(actualOfflineDraftKeys.createOfflineDraftKeyFrame)
    const legacyKey = Buffer.from('63098f7357e0fe53824c85ccfc51a58e97ee2c4db1cfc16efb07af2e38986829', 'hex')
    const nonce = Buffer.alloc(12, 1)
    const plaintext = Buffer.from('A draft saved before the session protection secret changed.', 'utf8')
    const cipher = createCipheriv('aes-256-gcm', legacyKey, nonce)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const authenticationTag = cipher.getAuthTag()
    legacyKey.fill(0)
    const request = {
      authContext: { kind: 'user', userId: 7, principal: { id: 7, authVersion: 3 } },
      get: vi.fn((name: string) => (name === 'origin' ? runtime.config.host : 'same-origin')),
      method: 'POST',
      path: '/_api/offline/draft-key'
    }
    const originalSessionSecret = runtime.config.sessionSecret
    const origin = createOriginMiddleware(() => runtime.config.host)

    try {
      for (const sessionSecret of [runtime.config.offlineDraftSecret, 'rotated-session-protection-secret']) {
        runtime.config.sessionSecret = sessionSecret
        const res = response()
        const admitted = vi.fn()
        const next = vi.fn()

        privacyHeaders(request, res, vi.fn())
        origin(request as never, res as never, admitted)
        sameOriginFetchSite(request, res, admitted)
        expect(admitted).toHaveBeenCalledTimes(2)
        await issueDraftKey(request, res, next)

        expect(res.status).toHaveBeenCalledWith(200)
        expect(next).not.toHaveBeenCalled()
        const frame = res.send.mock.calls[0]?.[0]
        expect(Buffer.isBuffer(frame)).toBe(true)
        const decoded = decodeKeyFrame(frame)
        expect(decoded.magic).toBe('TSODK1')
        expect(decoded.context).toEqual({
          canonicalOrigin: vectorContext.canonicalOrigin,
          siteId: vectorContext.siteId,
          accountId: BigInt(vectorContext.accountId),
          authVersion: BigInt(vectorContext.authVersion),
          keyVersion: vectorContext.keyVersion
        })
        const decipher = createDecipheriv('aes-256-gcm', decoded.keyBytes, nonce)
        decipher.setAuthTag(authenticationTag)
        expect(Buffer.concat([decipher.update(ciphertext), decipher.final()])).toEqual(plaintext)
      }
    } finally {
      runtime.config.sessionSecret = originalSessionSecret
    }
  })

  it('forwards authentication failures instead of manufacturing a key response', async () => {
    const failure = Object.assign(new Error('A current human user session is required'), {
      status: 401,
      code: 'AUTHENTICATION_REQUIRED'
    })
    resolveOfflineDraftKeyContext.mockRejectedValueOnce(failure)
    const res = response()
    const next = vi.fn()

    privacyHeaders({ authContext: { kind: 'guest' } }, res, vi.fn())
    await issueDraftKey({ authContext: { kind: 'guest' } }, res, next)

    expect(next).toHaveBeenCalledWith(failure)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.append).toHaveBeenCalledWith('Vary', 'Cookie')
    expect(res.status).not.toHaveBeenCalled()
    expect(res.send).not.toHaveBeenCalled()
    expect(createOfflineDraftKeyFrame).not.toHaveBeenCalled()
  })
  it('sends a current human reading-key context in an exact binary frame', async () => {
    resolveOfflineReadingContext.mockImplementation(actualOfflineDraftKeys.resolveOfflineReadingContext)
    createOfflineReadingKeyFrame.mockImplementation(actualOfflineDraftKeys.createOfflineReadingKeyFrame)
    const req = {
      authContext: { kind: 'user', userId: 7, principal: { id: 7, authVersion: 3 } },
      body: { canonicalOrigin: 'https://evil.example.test', siteId: 'evil-site', accountId: 999, authVersion: 0 }
    }
    const res = response()
    const next = vi.fn()

    privacyHeaders(req, res, vi.fn())
    await issueReadingKey(req, res, next)

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.append).toHaveBeenCalledWith('Vary', 'Cookie')
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/octet-stream')
    expect(res.status).toHaveBeenCalledWith(200)
    const frame = res.send.mock.calls[0]?.[0]
    expect(Buffer.isBuffer(frame)).toBe(true)
    const decoded = decodeKeyFrame(frame, true)
    expect(decoded.magic).toBe('TSORK1')
    expect(decoded.context).toEqual({
      canonicalOrigin: 'https://wiki.example.test',
      siteId: 'site-fixture',
      accountId: 7n,
      authVersion: 3n,
      keyVersion: 'random-reading-v1',
      keyId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/u)
    })
    const keyId = decoded.context.keyId!
    expect(Buffer.from(keyId, 'base64url').byteLength).toBe(16)
    expect(Buffer.from(keyId, 'base64url').toString('base64url')).toBe(keyId)
    expect(decoded.keyBytes.byteLength).toBe(32)
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    ['service', { authContext: { kind: 'apiKey', apiKeyId: 4, groupId: 8, ownershipUserId: null, userId: 7, principal: { api: 4, grp: 8, id: 7, authVersion: 3 } } }],
    ['anonymous', { authContext: { kind: 'guest', userId: 7, principal: { id: 7, authVersion: 3 } } }]
  ])('denies %s reading-key requests without exposing authentication details', async (_label: string, req: unknown) => {
    resolveOfflineReadingContext.mockImplementation(actualOfflineDraftKeys.resolveOfflineReadingContext)
    createOfflineReadingKeyFrame.mockImplementation(actualOfflineDraftKeys.createOfflineReadingKeyFrame)
    const res = response()

    privacyHeaders(req, res, vi.fn())
    await issueReadingKey(req, res)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required.' })
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('current human')
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('authenticated user session')
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.append).toHaveBeenCalledWith('Vary', 'Cookie')
    expect(res.send).not.toHaveBeenCalled()
  })

  it('issues bounded random TSORK1 frames and rejects wrong key lengths', () => {
    const first = actualOfflineDraftKeys.createOfflineReadingKeyFrame(readingContext)
    const second = actualOfflineDraftKeys.createOfflineReadingKeyFrame(readingContext)

    expect(first.subarray(0, 6).toString('ascii')).toBe('TSORK1')
    expect(first.byteLength).toBeLessThanOrEqual(actualOfflineDraftKeys.OFFLINE_READING_KEY_FRAME_MAX_BYTES)
    expect(second.byteLength).toBe(first.byteLength)
    expect(first).not.toEqual(second)
    expect(() => actualOfflineDraftKeys.encodeOfflineReadingKeyFrame(readingContext, new Uint8Array(OFFLINE_READING_KEY_BYTES - 1))).toThrow(RangeError)
  })
})
