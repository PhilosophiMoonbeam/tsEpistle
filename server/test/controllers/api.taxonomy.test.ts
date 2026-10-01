import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
const router = { use: vi.fn(), get: vi.fn(), post: vi.fn() }
const service = { list: vi.fn(), inspect: vi.fn(), create: vi.fn(), preview: vi.fn(), apply: vi.fn() }
const access = vi.fn(), warn = vi.fn()
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
vi.mockModule('../../operations/taxonomy.ts', import.meta.url, () => ({ default: () => service }))
vi.mockModule('../../controllers/_types.ts', import.meta.url, () => ({ getWikiAuth: () => ({ checkAccess: access }), getTransportRuntime: () => ({ logger: { warn } }), errorStatus: (error: { status?: number }) => error.status }))
await import('../../controllers/api/taxonomy.ts')
const response = () => ({ set: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() })
const posts = new Map(router.post.mock.calls.map(call => [call[0], call[1]]))
const post = (path: string) => posts.get(path)!
describe('taxonomy administration transport', () => {
  beforeEach(() => { access.mockReset(); warn.mockReset(); for (const method of Object.values(service)) method.mockReset() })
  it('requires system access and disables caching before any taxonomy route', () => {
    const middleware = router.use.mock.calls[0]![0], next = vi.fn(), res = response()
    access.mockReturnValue(false); middleware({ user: undefined }, res, next)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled()
    access.mockReturnValue(true); middleware({ user: { id: 1 } }, res, next); expect(next).toHaveBeenCalledTimes(1)
  })
  it('passes the principal, session and explicit review evidence without trusting a body principal', async () => {
    service.apply.mockResolvedValue({ tagId: 2, pageCount: 3, refreshWarnings: [] })
    const requester = { id: 1 }, change = { action: 'merge', tagId: 1, targetId: 2 }, res = response()
    await post('/apply')({ user: requester, sessionID: 'session', body: { requester: { id: 9 }, change, fingerprint: 'review', acknowledgeAccess: true } }, res)
    expect(service.apply).toHaveBeenCalledWith({ requester, sessionId: 'session' }, { change, fingerprint: 'review', acknowledgeAccess: true })
    expect(res.json).toHaveBeenCalledWith({ tagId: 2, pageCount: 3, refreshWarnings: [] })
  })
  it('preserves actionable review conflicts and redacts internal failures', async () => {
    let res = response()
    service.preview.mockRejectedValue(Object.assign(new Error('Review expired'), { status: 409 }))
    await post('/preview')({ body: {} }, res)
    expect(res.status).toHaveBeenCalledWith(409); expect(res.json).toHaveBeenCalledWith({ error: 'Review expired' })
    res = response(); const failure = new Error('internal database details'); service.preview.mockRejectedValue(failure)
    await post('/preview')({ body: {} }, res)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: expect.any(String) })
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('internal database details')
    expect(warn).toHaveBeenCalledWith(failure)
  })
})
