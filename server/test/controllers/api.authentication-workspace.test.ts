import { afterAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { configureTransportRuntime } from '../../controllers/_types.ts'
const router = { get: vi.fn(), put: vi.fn(), post: vi.fn(), use: vi.fn() },
  store = { inspect: vi.fn(), save: vi.fn(), initialize: vi.fn() },
  checkAccess = vi.fn()
vi.mockModule('../../operations/api.ts', import.meta.url, () => ({ default: {} }))
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
vi.mockModule('../../operations/authentication-administration.ts', import.meta.url, () => ({ getAuthenticationAdministrationStore: () => store }))
await vi.importFresh('../../controllers/api/auth.ts', import.meta.url)
const read = router.get.mock.calls.find(([path]) => path === '/admin/workspace')![1]!,
  save = router.put.mock.calls.find(([path]) => path === '/admin/workspace')![1]!,
  initialize = router.post.mock.calls.find(([path]) => path === '/admin/workspace/activate')![1]!
const response = () => {
  const res = { status: vi.fn(), set: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  res.set.mockReturnValue(res)
  return res
}
beforeEach(() => {
  checkAccess.mockReturnValue(true)
  store.inspect.mockReset().mockResolvedValue({ providers: [], fingerprint: 'review' })
  store.save.mockReset().mockResolvedValue({ sessionsEnded: 0, currentSessionEnded: false, activation: 'applied' })
  store.initialize.mockReset().mockResolvedValue({ sessionsEnded: 0, currentSessionEnded: false, activation: 'applied' })
  configureTransportRuntime({ auth: { checkAccess } })
})
afterAll(() => configureTransportRuntime({}))
describe('authentication workspace HTTP boundary', () => {
  it('requires system authority before reading or writing', async () => {
    checkAccess.mockReturnValue(false)
    for (const handler of [read, save, initialize]) {
      const res = response()
      await handler({}, res)
      expect(res.status).toHaveBeenCalledWith(403)
    }
    expect(store.inspect).not.toHaveBeenCalled()
    expect(store.save).not.toHaveBeenCalled()
    expect(store.initialize).not.toHaveBeenCalled()
  })
  it('forwards the authenticated actor, exact review and secret actions without caching responses', async () => {
    const user = { id: 1, authVersion: 3 },
      readResponse = response(),
      saveResponse = response(),
      body = { providers: [{ key: 'org', secrets: { clientSecret: { action: 'keep' } } }], reason: 'Reviewed policy', fingerprint: 'review' }
    await read({ user }, readResponse)
    expect(store.inspect).toHaveBeenCalledWith(user)
    expect(readResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    await save({ user, body: { ...body, ignored: 'not reviewed' } }, saveResponse)
    expect(store.save).toHaveBeenCalledWith(user, body)
    expect(saveResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
  it('retries initialization only for the authenticated actor and reviewed fingerprint', async () => {
    const user = { id: 1, authVersion: 3 },
      res = response()
    await initialize({ user, body: { fingerprint: 'review', providers: ['ignored'] } }, res)
    expect(store.initialize).toHaveBeenCalledWith(user, 'review')
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.json).toHaveBeenCalledWith({ sessionsEnded: 0, currentSessionEnded: false, activation: 'applied' })
    store.initialize.mockRejectedValue(Object.assign(new Error('Reload the current policy'), { status: 409 }))
    await initialize({ user, body: {} }, res)
    expect(res.status).toHaveBeenCalledWith(409)
  })
  it('preserves conflict and current-authority errors', async () => {
    for (const status of [400, 403, 409]) {
      store.save.mockRejectedValue(Object.assign(new Error('Review the current policy'), { status }))
      const res = response()
      await save({ user: { id: 1 }, body: {} }, res)
      expect(res.status).toHaveBeenCalledWith(status)
      expect(res.json).toHaveBeenCalledWith({ error: 'Review the current policy' })
    }
  })
  it('does not expose internal errors or secrets in unexpected failures', async () => {
    store.inspect.mockRejectedValue(new Error('database password=private-value'))
    const res = response()
    await read({ user: { id: 1 } }, res)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication administration is temporarily unavailable.' })
  })
})
