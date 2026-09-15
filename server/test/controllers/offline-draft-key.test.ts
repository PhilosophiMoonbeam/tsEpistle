import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { createOriginMiddleware } from '../../middlewares/origin.ts'
import type * as OfflineDraftKeys from '../../helpers/offline-draft-keys.ts'
import { OFFLINE_KEY_VERSION, type DraftKeyContext } from '../../../shared/offline.ts'

const actualOfflineDraftKeys = { ...await vi.importFresh<OfflineDraftKeys>('../../helpers/offline-draft-keys.ts', import.meta.url) }

const router = { post: vi.fn() }
const resolveOfflineDraftKeyContext = vi.fn()
const createOfflineDraftKeyFrame = vi.fn()
const runtime = {
  INSTANCE_ID: 'process-fixture',
  config: {
    host: 'https://wiki.example.test',
    offlineDraftSiteId: 'site-fixture',
    sessionSecret: 'configured-session-secret'
  }
}

vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
vi.mockModule('../../controllers/_types.ts', import.meta.url, () => ({ getTransportRuntime: () => runtime }))
vi.mockModule('../../helpers/offline-draft-keys.ts', import.meta.url, () => ({
  createOfflineDraftKeyFrame,
  resolveOfflineDraftKeyContext
}))

await vi.importFresh('../../controllers/api/offline.ts', import.meta.url)

const route = router.post.mock.calls.find(([path]) => path === '/draft-key')!
const privacyHeaders = route[1]!
const sameOriginFetchSite = route[2]!
const issueDraftKey = route[3]!

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
})

const vectorContext: DraftKeyContext = {
  canonicalOrigin: 'https://wiki.example.test',
  siteId: 'site-fixture',
  accountId: 7,
  authVersion: 3,
  keyVersion: OFFLINE_KEY_VERSION
}
const vectorKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1)

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
      config: { host: 'https://wiki.example.test', sessionSecret: 'configured-session-secret' },
      models: { users }
    }
    const first = await actualOfflineDraftKeys.resolveOfflineDraftKeyContext(request as never, { ...baseRuntime, INSTANCE_ID: 'process-a' } as never)
    const second = await actualOfflineDraftKeys.resolveOfflineDraftKeyContext(request as never, { ...baseRuntime, INSTANCE_ID: 'process-b' } as never)

    expect(first.siteId).toBe('https://wiki.example.test')
    expect(second.siteId).toBe(first.siteId)
    const configured = await actualOfflineDraftKeys.resolveOfflineDraftKeyContext(request as never, {
      ...baseRuntime,
      INSTANCE_ID: 'process-c',
      config: { ...baseRuntime.config, offlineDraftSiteId: 'installed-site' }
    } as never)
    expect(configured.siteId).toBe('installed-site')
  })

  it('admits same-origin fetches without trusting claimed account or origin fields and sends the exact binary frame', async () => {
    const context = {
      canonicalOrigin: 'https://wiki.example.test',
      siteId: 'site-fixture',
      accountId: 7,
      authVersion: 3,
      keyVersion: 'session-secret-v1'
    }
    const frame = Buffer.from('TSODK1\u0000fixture-key-frame', 'utf8')
    resolveOfflineDraftKeyContext.mockResolvedValue(context)
    createOfflineDraftKeyFrame.mockReturnValue(frame)
    const req = {
      authContext: { kind: 'user', userId: 7 },
      body: { canonicalOrigin: 'https://evil.example.test', accountId: 999, authVersion: 0 }
    }
    const res = response()
    const next = vi.fn()

    privacyHeaders(req, res, vi.fn())
    await issueDraftKey(req, res, next)

    expect(resolveOfflineDraftKeyContext).toHaveBeenCalledWith(req, runtime)
    expect(createOfflineDraftKeyFrame).toHaveBeenCalledWith(context, 'configured-session-secret')
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.append).toHaveBeenCalledWith('Vary', 'Cookie')
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/octet-stream')
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.send).toHaveBeenCalledWith(frame)
    expect(Buffer.isBuffer(res.send.mock.calls[0]?.[0])).toBe(true)
    expect(res.send.mock.calls[0]?.[0]).toEqual(frame)
    expect(next).not.toHaveBeenCalled()
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
})
