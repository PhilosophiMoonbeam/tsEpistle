import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { createOriginMiddleware } from '../../middlewares/origin.ts'

const router = { post: vi.fn() }
const resolveOfflineDraftKeyContext = vi.fn()
const createOfflineDraftKeyFrame = vi.fn()
const runtime = {
  INSTANCE_ID: 'site-fixture',
  config: {
    host: 'https://wiki.example.test',
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
const sameOriginFetchSite = route[1]!
const issueDraftKey = route[2]!

const response = () => {
  const res = {
    json: vi.fn(),
    send: vi.fn(),
    set: vi.fn(),
    status: vi.fn()
  }
  res.status.mockReturnValue(res)
  return res
}

beforeEach(() => {
  resolveOfflineDraftKeyContext.mockReset()
  createOfflineDraftKeyFrame.mockReset()
})

describe('offline draft-key transport boundary', () => {
  it.each(['cross-site', 'same-site', 'none', 'null'])('rejects %s Fetch Metadata before attempting authentication or key issuance', value => {
    const next = vi.fn()
    const res = response()
    const req = { get: vi.fn(() => value) }

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

      origin(req as never, res as never, next)

      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith({ error: 'A same-origin request is required.' })
      expect(next).not.toHaveBeenCalled()
    }

    const exact = response()
    const next = vi.fn()
    origin(
      {
        method: 'POST',
        path: '/_api/offline/draft-key',
        get: vi.fn((name: string) => (name === 'origin' ? runtime.config.host : undefined))
      } as never,
      exact as never,
      next
    )
    expect(next).toHaveBeenCalledOnce()
    expect(exact.status).not.toHaveBeenCalled()
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

    await issueDraftKey(req, res, next)

    expect(resolveOfflineDraftKeyContext).toHaveBeenCalledWith(req, runtime)
    expect(createOfflineDraftKeyFrame).toHaveBeenCalledWith(context, 'configured-session-secret')
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'application/octet-stream')
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.set).toHaveBeenCalledWith('Vary', 'Cookie')
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

    await issueDraftKey({ authContext: { kind: 'guest' } }, res, next)

    expect(next).toHaveBeenCalledWith(failure)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.send).not.toHaveBeenCalled()
    expect(createOfflineDraftKeyFrame).not.toHaveBeenCalled()
  })
})
