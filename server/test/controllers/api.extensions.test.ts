import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const router = { get: vi.fn() }
const inspect = vi.fn()
const systemRequester = vi.fn(() => ({ user: { id: 7 } }))
const checkAccess = vi.fn()

vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => router } }))
vi.mockModule('../../operations/extensions-workspace.ts', import.meta.url, () => ({ getExtensionsWorkspaceStore: () => ({ inspect }) }))
vi.mockModule('../../helpers/system-authority.ts', import.meta.url, () => ({ systemRequester }))
vi.mockModule('../../controllers/_types.ts', import.meta.url, () => ({
  errorStatus: (error: { status?: number }) => error.status,
  getWikiAuth: () => ({ checkAccess })
}))

await import('../../controllers/api/extensions.ts')

const workspace = router.get.mock.calls.find(([path]) => path === '/workspace')![1]
const response = () => ({ set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), json: vi.fn() })

describe('Extensions deployment observations API', () => {
  beforeEach(() => {
    inspect.mockReset()
    systemRequester.mockClear()
    checkAccess.mockReset().mockReturnValue(true)
    inspect.mockResolvedValue({ observedAt: '2026-09-07T00:00:00.000Z', extensions: [] })
  })

  it('uses no-store and a request-bound current authority projection for read-only observation', async () => {
    const res = response()

    await workspace({ user: { id: 7 } }, res)

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(inspect).toHaveBeenCalledWith({ user: { id: 7 } })
    expect(res.json).toHaveBeenCalledWith({ observedAt: '2026-09-07T00:00:00.000Z', extensions: [] })
  })

  it('rejects unauthorized reads before process inspection and redacts unexpected failures', async () => {
    checkAccess.mockReturnValue(false)
    let res = response()

    await workspace({ user: { id: 7 } }, res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(inspect).not.toHaveBeenCalled()

    checkAccess.mockReturnValue(true)
    inspect.mockRejectedValueOnce(Error('private process path /srv/secret'))
    res = response()
    await workspace({ user: { id: 7 } }, res)
    expect(res.status).toHaveBeenCalledWith(503)
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('/srv/secret')
  })
})
