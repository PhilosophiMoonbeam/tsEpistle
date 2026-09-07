import { configureTransportRuntime } from '../../controllers/_types.ts'

const systemOperations = {
  checkForUpdate: vi.fn(),
  getHost: vi.fn(),
  getInfo: vi.fn(),
  getSummary: vi.fn(),
  performUpgrade: vi.fn(),
  renderPage: vi.fn()
}
const extensionsStore = { inspect: vi.fn() }
const observations = { inspect: vi.fn() }

vi.mockModule('../../operations/system.ts', import.meta.url, () => ({ default: systemOperations }))
vi.mockModule('../../operations/extensions-workspace.ts', import.meta.url, () => ({ getExtensionsWorkspaceStore: () => extensionsStore }))
vi.mockModule('../../operations/system-workspace-runtime.ts', import.meta.url, () => ({ getSystemWorkspaceStore: () => observations }))
vi.mockModule('express', import.meta.url, () => {
  const router = { get: vi.fn(), post: vi.fn(), patch: vi.fn() }
  const express = { Router: () => router, __router: router }
  return { default: express, ...express }
})

const { default: express } = await import('express')
const handler = (method, path) => express.__router[method].mock.calls.find(([registered]) => registered === path)[1]
const response = () => ({ set: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn(), sendStatus: vi.fn() })
const systemUser = { id: 1, authVersion: 0, permissions: ['manage:system'] }

describe('system API clean cutover', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    configureTransportRuntime({ auth: { checkAccess: vi.fn(() => true), getEffectivePermissions: vi.fn() } })
    systemOperations.getHost.mockReturnValue({ host: 'https://wiki.example.test' })
    systemOperations.getInfo.mockResolvedValue({ hostname: 'wiki' })
    systemOperations.getSummary.mockResolvedValue({ pagesTotal: 42 })
    systemOperations.renderPage.mockResolvedValue(undefined)
    extensionsStore.inspect.mockResolvedValue({})
    observations.inspect.mockResolvedValue({ observedAt: '2026-09-10T00:00:00.000Z' })
    await vi.importFresh('../../controllers/api/system.ts', import.meta.url)
  })


  it.each([
    ['get', '/flags'],
    ['post', '/flags']
  ])('retires direct %s %s developer-flag requests behind its reviewed workspace', async (method, path) => {
    const res = response()
    await handler(method, path)({ user: systemUser }, res)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.status).toHaveBeenCalledWith(410)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('/_api/developer-flags/workspace') }))
  })

  it('revalidates extension authority before retiring its unsafe legacy endpoint', async () => {
    const res = response()
    await handler('get', '/extensions')({ user: systemUser }, res)
    expect(extensionsStore.inspect).toHaveBeenCalledWith({ user: systemUser })
    expect(res.status).toHaveBeenCalledWith(410)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('/_api/extensions/workspace') }))
  })

  it.each([
    ['get', '/telemetry'],
    ['patch', '/telemetry'],
    ['post', '/telemetry/reset-client-id'],
    ['post', '/cache/flush'],
    ['post', '/cache/temp-uploads/flush'],
    ['post', '/content/rebuild-tree'],
    ['post', '/content/migrate-locale'],
    ['post', '/content/purge-history'],
    ['post', '/export'],
    ['get', '/export-status'],
    ['post', '/import-v1/users']
  ])('returns an authorized no-store 410 for retired %s %s utility writes', async (method, path) => {
    const res = response()
    await handler(method, path)({ user: systemUser }, res)
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(res.status).toHaveBeenCalledWith(410)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('/_api/utilities/workspace') }))
  })

  it('rejects unauthorised callers before exposing a retired utility route', async () => {
    configureTransportRuntime({ auth: { checkAccess: vi.fn(() => false), getEffectivePermissions: vi.fn() } })
    const res = response()
    await handler('post', '/cache/flush')({ user: { id: 4 } }, res)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'System administration is required.' })
  })
})
