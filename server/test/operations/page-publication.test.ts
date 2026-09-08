import { beforeEach, describe, expect, it, vi } from '../bun-test.mts'
const unlock = vi.fn(async () => {})
const protectedAssetRequiresUnlock = vi.fn(async () => false)
vi.mockModule('../../operations/page-protection.ts', import.meta.url, () => ({ assertPageUnlocked: unlock, protectedAssetRequiresUnlock }))
let operations: typeof import('../../operations/pages.ts').default
const updatePage = vi.fn(async (input: unknown) => input)
const requester = { id: 8, permissions: ['write:pages'] }
beforeEach(async () => {
  vi.resetModules(); unlock.mockClear(); updatePage.mockReset(); updatePage.mockImplementation(async input => input)
  globalThis.WIKI = { auth: { checkAccess: (user: { permissions?: string[] }, permissions: string[]) => permissions.some(permission => user?.permissions?.includes(permission)) }, config: { db: { type: 'postgres' } }, models: { pages: { updatePage } } } as unknown as typeof WIKI
  operations = (await vi.importFresh('../../operations/pages.ts', import.meta.url)).default
})
describe('administration publication changes', () => {
  it('uses the protected editor update with reviewed revision and a narrow payload', async () => {
    await operations.setPublication({ requester, sessionId: 'signed-in-session', id: 5, expectedSourceRevision: '23', isPublished: true, title: 'must not overwrite', visibility: 'public', content: 'must not overwrite' })
    expect(unlock).toHaveBeenCalledWith({ requester, pageId: 5, sessionId: 'signed-in-session' })
    expect(updatePage).toHaveBeenCalledWith({ user: requester, id: 5, expectedSourceRevision: '23', isPublished: true })
  })
  it('normalizes schedule boundaries and permits explicit clearing', async () => {
    await operations.setPublication({ requester, id: 5, expectedSourceRevision: '23', isPublished: true, publishStartDate: '2026-09-07T10:00:00+02:00', publishEndDate: null })
    expect(updatePage).toHaveBeenCalledWith(expect.objectContaining({ publishStartDate: '2026-09-07T08:00:00.000Z', publishEndDate: '' }))
  })
  it('rejects invalid state, revision and schedule before any write', async () => {
    for (const patch of [{ publishStartDate: '2026-02-30T00:00:00Z', publishEndDate: '' }, { publishStartDate: '2026-09-07T12:00:00', publishEndDate: '' }, { isPublished: 'yes' }, { expectedSourceRevision: undefined }, { publishStartDate: 'tomorrow', publishEndDate: '' }, { publishStartDate: '2026-10-01T00:00:00Z' }, { publishStartDate: '2026-10-01T00:00:00Z', publishEndDate: '2026-09-01T00:00:00Z' }]) {
      await expect(operations.setPublication({ requester, id: 5, expectedSourceRevision: '23', isPublished: true, ...patch })).rejects.toThrow()
    }
    expect(updatePage).not.toHaveBeenCalled()
  })
  it('propagates protection denial and stale revision errors without retrying a newer page', async () => {
    unlock.mockRejectedValueOnce(new Error('Page is locked'))
    await expect(operations.setPublication({ requester, id: 5, expectedSourceRevision: '23', isPublished: false })).rejects.toThrow('Page is locked')
    expect(updatePage).not.toHaveBeenCalled()
    updatePage.mockRejectedValueOnce(new Error('Page changed'))
    await expect(operations.setPublication({ requester, id: 5, expectedSourceRevision: '23', isPublished: false })).rejects.toThrow('Page changed')
    expect(updatePage).toHaveBeenCalledTimes(1)
  })
  it('limits private ownership transfer to system administrators and retains protection and revision context', async () => {
    const transferOwnership = vi.fn(async () => ({}))
    Object.assign(WIKI.models.pages, { transferOwnership })
    await expect(operations.transferOwnership({ requester, id: 5, ownerId: 9, expectedSourceRevision: '23' })).rejects.toThrow('This page does not exist.')
    expect(transferOwnership).not.toHaveBeenCalled()
    const administrator = { id: 1, permissions: ['manage:system'] }
    await operations.transferOwnership({ requester: administrator, sessionId: 'session', id: 5, ownerId: 9, expectedSourceRevision: '23' })
    expect(unlock).toHaveBeenCalledWith({ requester: administrator, sessionId: 'session', pageId: 5 })
    expect(transferOwnership).toHaveBeenCalledWith({ user: administrator, id: 5, ownerId: 9, expectedSourceRevision: '23' })
  })
})
