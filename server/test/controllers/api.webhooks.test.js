const operations = { sendTest: vi.fn() }
vi.mockModule('../../operations/webhooks.ts', import.meta.url, () => ({ default: operations }))
const routes = []
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => ({
  get: vi.fn(), put: vi.fn(), delete: vi.fn(), post: (path, handler) => routes.push({ path, handler })
}) } }))
global.WIKI = { auth: { checkAccess: vi.fn() } }
await import('../../controllers/api/webhooks.ts')
const handler = routes.find(route => route.path === '/:id/test').handler
const response = () => ({ set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn() })
beforeEach(() => { vi.clearAllMocks() })
describe('webhook test API', () => {
  it('requires system administration access and never caches the response', async () => {
    WIKI.auth.checkAccess.mockReturnValue(false)
    const res = response()
    await handler({ user: { id: 7 }, params: { id: 'one' } }, res)
    expect(WIKI.auth.checkAccess).toHaveBeenCalledWith({ id: 7 }, ['manage:system'])
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(operations.sendTest).not.toHaveBeenCalled()
  })
  it('returns the durable delivery identity with accepted status', async () => {
    WIKI.auth.checkAccess.mockReturnValue(true)
    operations.sendTest.mockResolvedValue('delivery-one')
    const res = response()
    await handler({ user: {}, params: { id: 'one' } }, res)
    expect(operations.sendTest).toHaveBeenCalledWith('one')
    expect(res.status).toHaveBeenCalledWith(202)
    expect(res.json).toHaveBeenCalledWith({ deliveryId: 'delivery-one' })
  })
  it('preserves actionable conflicts and redacts unexpected internal failures', async () => {
    WIKI.auth.checkAccess.mockReturnValue(true)
    operations.sendTest.mockRejectedValueOnce(Object.assign(new Error('A test is already active'), { status: 409 }))
    const res = response()
    await handler({ user: {}, params: { id: 'one' } }, res)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'A test is already active' })
    operations.sendTest.mockRejectedValueOnce(new Error('private database detail'))
    const failure = response()
    await handler({ user: {}, params: { id: 'one' } }, failure)
    expect(failure.status).toHaveBeenLastCalledWith(500)
    expect(failure.json).toHaveBeenCalledTimes(1)
    expect(failure.json).toHaveBeenCalledWith({ error: expect.any(String) })
    expect(JSON.stringify(failure.json.mock.calls)).not.toContain('private database detail')
  })
})
