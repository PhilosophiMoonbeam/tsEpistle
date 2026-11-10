import { afterAll, beforeEach, describe, expect, it, vi } from './bun-test.mts'
const originalWiki = globalThis.WIKI,
  requester = { id: 7, authVersion: 2 } as Express.User
const store = {
  creationOptions: vi.fn(),
  create: vi.fn(),
  inspect: vi.fn(),
  inspectForMembership: vi.fn(),
  savePolicy: vi.fn(),
  changeMembers: vi.fn(),
  remove: vi.fn()
}
vi.mockModule('../operations/group-administration.ts', import.meta.url, () => ({ getGroupAdministrationStore: () => store }))
const { default: operations } = await vi.importFresh('../operations/groups.ts', import.meta.url)
const findById = vi.fn()
beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset()
  store.creationOptions.mockResolvedValue({ fingerprint: 'creation-review' })
  store.create.mockResolvedValue({ id: 9 })
  store.inspect.mockResolvedValue({ fingerprint: 'saved-review', description: 'Retained purpose', formMfaRequired: true })
  store.inspectForMembership.mockResolvedValue({ fingerprint: 'membership-review' })
  findById.mockResolvedValue({ id: 9, name: 'Research' })
  globalThis.WIKI = {
    data: { groups: { defaultPermissions: ['read:pages'], defaultPageRules: [] } },
    models: { groups: { query: () => ({ findById }) } }
  } as never
})
afterAll(() => {
  globalThis.WIKI = originalWiki
})
describe('legacy group operation adapters', () => {
  it('creates through current authority and returns the persisted identity', async () => {
    const result = await operations.create(' Research ', requester)
    expect(store.creationOptions).toHaveBeenCalledWith(requester)
    expect(store.create).toHaveBeenCalledWith(
      requester,
      expect.objectContaining({
        fingerprint: 'creation-review',
        policy: { name: 'Research', description: '', redirectOnLogin: '/', formMfaRequired: false, permissions: ['read:pages'], pageRules: [] }
      })
    )
    expect(result.id).toBe(9)
  })
  it('preserves purpose and forwards exact policy to reviewed persistence', async () => {
    const pageRules = [{ id: 'r', path: 'docs', match: 'START', roles: ['read:pages'], locales: [], deny: false }]
    await operations.update({ requester, id: 9, name: 'Research', permissions: ['read:pages'], pageRules, redirectOnLogin: '/docs' })
    expect(store.inspect).toHaveBeenCalledWith(requester, 9)
    expect(store.savePolicy).toHaveBeenCalledWith(
      requester,
      9,
      expect.objectContaining({
        fingerprint: 'saved-review',
        policy: { name: 'Research', description: 'Retained purpose', redirectOnLogin: '/docs', formMfaRequired: true, permissions: ['read:pages'], pageRules }
      })
    )
  })
  it('uses the membership authority boundary for account managers', async () => {
    await operations.assignUser({ requester, groupId: 9, userId: 12 })
    await operations.unassignUser({ requester, groupId: 9, userId: 12 })
    expect(store.inspectForMembership).toHaveBeenCalledWith(requester, 9)
    for (const action of ['add', 'remove'])
      expect(store.changeMembers).toHaveBeenCalledWith(requester, 9, expect.objectContaining({ fingerprint: 'membership-review', action, userIds: [12] }))
  })
  it('routes deletion through dependency and lifecycle guards', async () => {
    await operations.remove({ requester, id: 9 })
    expect(store.remove).toHaveBeenCalledWith(requester, 9, expect.objectContaining({ fingerprint: 'saved-review' }))
  })
  it('does not write when authority inspection fails and preserves conflicts', async () => {
    store.inspect.mockRejectedValue(Object.assign(new Error('Access changed'), { status: 403 }))
    await expect(operations.remove({ requester, id: 9 })).rejects.toMatchObject({ status: 403 })
    expect(store.remove).not.toHaveBeenCalled()
    store.inspectForMembership.mockResolvedValue({ fingerprint: 'stale' })
    store.changeMembers.mockRejectedValue(Object.assign(new Error('Membership changed'), { status: 409 }))
    await expect(operations.assignUser({ requester, groupId: 9, userId: 12 })).rejects.toMatchObject({ status: 409 })
  })
  it('rejects invalid identifiers and missing names before persistence', async () => {
    await expect(operations.remove({ requester, id: -1 })).rejects.toMatchObject({ status: 400 })
    await expect(operations.create('', requester)).rejects.toMatchObject({ status: 400 })
    expect(store.create).not.toHaveBeenCalled()
    expect(store.remove).not.toHaveBeenCalled()
  })
  it('keeps authority classification aligned with account assignment', () => {
    expect(operations.hasAdministrativePermissions(['manage:users'])).toBe(true)
    expect(operations.hasAdministrativePermissions(['write:scripts'])).toBe(true)
    expect(operations.hasAdministrativePermissions(['read:pages'])).toBe(false)
    expect(operations.hasSystemPermissions(['write:scripts'])).toBe(true)
    expect(operations.hasSystemPermissions(['manage:groups'])).toBe(false)
  })
})
