import { afterAll, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import { configureTransportRuntime } from '../../controllers/_types.ts'
const router = { get: vi.fn(), put: vi.fn(), post: vi.fn() },
  store = { inspect: vi.fn(), save: vi.fn(), initialize: vi.fn() },
  checkAccess = vi.fn()
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
vi.mockModule('../../operations/site.ts', import.meta.url, () => ({ default: {} }))
vi.mockModule('../../operations/security-administration.ts', import.meta.url, () => ({ getSecurityAdministrationStore: () => store }))
await vi.importFresh('../../controllers/api/site.ts', import.meta.url)
const read = router.get.mock.calls.find(([path]) => path === '/security')![1]!,
  save = router.put.mock.calls.find(([path]) => path === '/security')![1]!,
  initialize = router.post.mock.calls.find(([path]) => path === '/security/activate')![1]!
const response = () => {
  const res = { status: vi.fn(), set: vi.fn(), json: vi.fn() }
  res.status.mockReturnValue(res)
  return res
}
beforeEach(() => {
  checkAccess.mockReturnValue(true)
  for (const method of Object.values(store)) method.mockReset().mockResolvedValue({})
  configureTransportRuntime({ auth: { checkAccess } })
})
afterAll(() => configureTransportRuntime({}))
describe('Security workspace transport', () => {
  it('requires system access before reads, writes and runtime retries', async () => {
    checkAccess.mockReturnValue(false)
    for (const handler of [read, save, initialize]) {
      const res = response()
      await handler({}, res)
      expect(res.status).toHaveBeenCalledWith(403)
    }
    for (const method of Object.values(store)) expect(method).not.toHaveBeenCalled()
  })
  it('forwards the exact policy review, actor and session action without caching responses', async () => {
    const user = { id: 1, authVersion: 2 },
      body = { policy: { authEnforce2FA: true }, fingerprint: 'review', reason: 'Require a second factor', endSessions: true },
      readResponse = response(),
      saveResponse = response(),
      initializeResponse = response()
    await read({ user }, readResponse)
    expect(store.inspect).toHaveBeenCalledWith(user)
    expect(readResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    await save({ user, body }, saveResponse)
    expect(store.save).toHaveBeenCalledWith(user, body)
    expect(saveResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    await initialize({ user, body }, initializeResponse)
    expect(store.initialize).toHaveBeenCalledWith(user, 'review')
    expect(initializeResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
  })
  it('preserves expected authority, validation and conflict errors', async () => {
    for (const status of [400, 403, 409]) {
      store.save.mockRejectedValue(Object.assign(new Error('Reload policy'), { status }))
      const res = response()
      await save({ user: {}, body: {} }, res)
      expect(res.status).toHaveBeenCalledWith(status)
      expect(res.json).toHaveBeenCalledWith({ error: 'Reload policy' })
    }
  })
  it('does not expose internal database errors', async () => {
    store.inspect.mockRejectedValue(new Error('private database configuration'))
    const res = response()
    await read({ user: {} }, res)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Security administration is temporarily unavailable.' })
  })
})
