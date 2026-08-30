import type groupOperations from '../operations/groups.ts'

import { afterEach, beforeEach, describe, expect, it, vi } from './bun-test.mts'

const originalWiki = Reflect.get(globalThis, 'WIKI')
const requester = (permissions: string[]): Express.User => ({ permissions }) as unknown as Express.User

interface TestRelationMutation {
  where(column: string, value: number): Promise<number>
}

interface TestUserRelationQuery {
  unrelate(): TestRelationMutation
}

interface TestGroup {
  id: number
  name: string
  isSystem: boolean
  permissions: string[]
  $relatedQuery?: (relation: string) => TestUserRelationQuery
}

describe('group operations authority boundaries', () => {
  let operations: typeof groupOperations
  let group: TestGroup
  let affectedRows: number
  let lifecycle: string[]
  let findById: (id: number) => Promise<TestGroup | undefined>
  let patch: (update: Record<string, unknown>) => {
    where(column: string, id: number): Promise<number>
  }
  let deleteById: (id: number) => Promise<number>
  let revokeUserTokens: (input: { id: number; kind: 'g' | 'u' }) => void
  let reloadGroups: () => Promise<void>
  let relatedQuery: (relation: string) => TestUserRelationQuery
  let unrelate: () => TestRelationMutation
  let unrelateWhere: (column: string, value: number) => Promise<number>
  let findUserById: (id: number) => Promise<{ id: number; name: string; email: string }>

  beforeEach(async () => {
    unrelateWhere = vi.fn(async () => 1)
    unrelate = vi.fn(() => ({ where: unrelateWhere }))
    relatedQuery = vi.fn(() => ({ unrelate }))
    findUserById = vi.fn(async (id: number) => ({ id, name: 'Alice', email: 'alice@example.com' }))
    group = { id: 3, name: 'Editors', isSystem: false, permissions: ['read:pages'], $relatedQuery: relatedQuery }
    affectedRows = 1
    lifecycle = []
    findById = vi.fn(async (id: number) => {
      lifecycle.push('lookup')
      return id === group.id ? group : undefined
    })
    patch = vi.fn((_update: Record<string, unknown>) => ({
      where: vi.fn(async (_column: string, _id: number) => {
        lifecycle.push('patch')
        return affectedRows
      })
    }))
    deleteById = vi.fn(async () => {
      lifecycle.push('delete')
      return affectedRows
    })
    revokeUserTokens = vi.fn(() => {
      lifecycle.push('revoke')
    })
    reloadGroups = vi.fn(async () => {
      lifecycle.push('reload')
    })

    Reflect.set(globalThis, 'WIKI', {
      auth: {
        checkExclusiveAccess: (user: { permissions?: string[] } | undefined, included: readonly string[], excluded: readonly string[]) => {
          const permissions = user?.permissions ?? []
          return included.some(permission => permissions.includes(permission)) && !excluded.some(permission => permissions.includes(permission))
        },
        reloadGroups,
        revokeUserTokens
      },
      events: { outbound: { emit: vi.fn() } },
      models: {
        groups: { query: vi.fn(() => ({ deleteById, findById, patch })) },
        users: { query: vi.fn(() => ({ findById: findUserById })) }
      }
    })
    operations = (await vi.importFresh<{ default: typeof groupOperations }>('../operations/groups.ts', import.meta.url)).default
  })

  afterEach(() => {
    if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
    else Reflect.set(globalThis, 'WIKI', originalWiki)
  })

  it('protects system and Administrators group identity and authority', async () => {
    group = { id: 1, name: 'Administrators', isSystem: true, permissions: ['manage:system'] }

    await expect(
      operations.update({
        requester: requester(['write:groups']),
        id: 1,
        name: 'Operators',
        permissions: ['manage:system'],
        pageRules: []
      })
    ).rejects.toMatchObject({ name: 'GROUP_UPDATE_PROTECTED', status: 400 })

    group = { id: 2, name: 'Guests', isSystem: true, permissions: ['read:pages'] }
    await expect(
      operations.update({
        requester: requester(['write:groups']),
        id: 2,
        name: 'Guests',
        permissions: [],
        pageRules: []
      })
    ).rejects.toMatchObject({ name: 'GROUP_UPDATE_SYSTEM_FORBIDDEN', status: 403 })

    group = { id: 1, name: 'Administrators', isSystem: true, permissions: ['manage:system'] }
    await expect(
      operations.update({
        requester: requester(['manage:system']),
        id: 1,
        name: 'Administrators',
        permissions: [],
        pageRules: []
      })
    ).rejects.toMatchObject({ name: 'GROUP_UPDATE_PROTECTED', status: 400 })
    expect(findById).toHaveBeenCalledTimes(3)
    expect(patch).not.toHaveBeenCalled()
    expect(revokeUserTokens).not.toHaveBeenCalled()
  })

  it('checks existing authority before allowing a lower-privileged update', async () => {
    group = { id: 3, name: 'Operators', isSystem: false, permissions: ['manage:users'] }

    await expect(
      operations.update({
        requester: requester(['write:groups']),
        id: 3,
        name: 'Operators',
        permissions: [],
        pageRules: []
      })
    ).rejects.toMatchObject({ name: 'GROUP_UPDATE_FORBIDDEN', status: 403 })

    expect(findById).toHaveBeenCalledWith(3)
    expect(patch).not.toHaveBeenCalled()
    expect(revokeUserTokens).not.toHaveBeenCalled()
  })

  it('treats write:scripts as system-equivalent authority on grants and retained groups', async () => {
    await expect(
      operations.update({
        requester: requester(['write:groups']),
        id: 3,
        name: 'Editors',
        permissions: ['read:pages', 'write:scripts'],
        pageRules: []
      })
    ).rejects.toMatchObject({ name: 'GROUP_UPDATE_FORBIDDEN', status: 403 })

    group = { id: 3, name: 'Automation', isSystem: false, permissions: ['write:scripts'] }
    await expect(
      operations.update({
        requester: requester(['manage:groups']),
        id: 3,
        name: 'Automation',
        permissions: [],
        pageRules: []
      })
    ).rejects.toMatchObject({ name: 'GROUP_UPDATE_SYSTEM_FORBIDDEN', status: 403 })

    expect(patch).not.toHaveBeenCalled()
    expect(revokeUserTokens).not.toHaveBeenCalled()
  })

  it('commits ordinary updates before revoking group tokens', async () => {
    await operations.update({
      requester: requester(['write:groups']),
      id: 3,
      name: 'Authors',
      redirectOnLogin: '/drafts',
      permissions: ['read:pages', 'write:pages'],
      pageRules: []
    })

    expect(patch).toHaveBeenCalledWith({
      name: 'Authors',
      redirectOnLogin: '/drafts',
      permissions: ['read:pages', 'write:pages'],
      pageRules: []
    })
    expect(lifecycle).toEqual(['lookup', 'patch', 'revoke', 'reload'])
    expect(revokeUserTokens).toHaveBeenCalledWith({ id: 3, kind: 'g' })
  })

  it('does not revoke tokens when the target disappears before the patch commits', async () => {
    affectedRows = 0

    await expect(
      operations.update({
        requester: requester(['write:groups']),
        id: 3,
        name: 'Authors',
        permissions: ['read:pages'],
        pageRules: []
      })
    ).rejects.toMatchObject({ name: 'GROUP_NOT_FOUND', status: 404 })

    expect(lifecycle).toEqual(['lookup', 'patch'])
    expect(revokeUserTokens).not.toHaveBeenCalled()
    expect(reloadGroups).not.toHaveBeenCalled()
  })

  it('requires requester identity for membership removal and group deletion', async () => {
    await expect(operations.unassignUser({ requester: undefined, groupId: 3, userId: 10 })).rejects.toMatchObject({
      name: 'GROUP_REQUESTER_REQUIRED',
      status: 403
    })
    await expect(operations.remove({ requester: undefined, id: 3 })).rejects.toMatchObject({ name: 'GROUP_REQUESTER_REQUIRED', status: 403 })

    expect(findById).not.toHaveBeenCalled()
    expect(unrelate).not.toHaveBeenCalled()
    expect(deleteById).not.toHaveBeenCalled()
    expect(revokeUserTokens).not.toHaveBeenCalled()
  })

  it('prevents delegated user managers from removing higher-administrator memberships', async () => {
    group = {
      id: 3,
      name: 'Administrators',
      isSystem: false,
      permissions: ['manage:users'],
      $relatedQuery: relatedQuery
    }

    await expect(operations.unassignUser({ requester: requester(['manage:users']), groupId: 3, userId: 10 })).rejects.toMatchObject({
      name: 'GROUP_UNASSIGN_FORBIDDEN',
      status: 403
    })

    expect(findUserById).not.toHaveBeenCalled()
    expect(unrelate).not.toHaveBeenCalled()
    expect(revokeUserTokens).not.toHaveBeenCalled()
  })

  it('allows group managers to remove administrative-group memberships', async () => {
    group = {
      id: 3,
      name: 'Administrators',
      isSystem: false,
      permissions: ['manage:users'],
      $relatedQuery: relatedQuery
    }

    await operations.unassignUser({ requester: requester(['manage:groups']), groupId: 3, userId: 10 })

    expect(findUserById).toHaveBeenCalledWith(10)
    expect(relatedQuery).toHaveBeenCalledWith('users')
    expect(unrelateWhere).toHaveBeenCalledWith('userId', 10)
    expect(revokeUserTokens).toHaveBeenCalledWith({ id: 10, kind: 'u' })
  })

  it('prevents group writers from deleting more privileged custom groups', async () => {
    group = { id: 3, name: 'Operators', isSystem: false, permissions: ['manage:users'] }

    await expect(operations.remove({ requester: requester(['write:groups']), id: 3 })).rejects.toMatchObject({ name: 'GROUP_DELETE_FORBIDDEN', status: 403 })

    expect(deleteById).not.toHaveBeenCalled()
    expect(revokeUserTokens).not.toHaveBeenCalled()
    expect(reloadGroups).not.toHaveBeenCalled()
  })

  it('allows group managers to delete administrative custom groups', async () => {
    group = { id: 3, name: 'Operators', isSystem: false, permissions: ['manage:users'] }

    await operations.remove({ requester: requester(['manage:groups']), id: 3 })

    expect(deleteById).toHaveBeenCalledWith(3)
    expect(revokeUserTokens).toHaveBeenCalledWith({ id: 3, kind: 'g' })
    expect(reloadGroups).toHaveBeenCalled()
  })

  it('protects every persisted system group from deletion', async () => {
    group = { id: 9, name: 'System Automation', isSystem: true, permissions: ['read:pages'] }

    await expect(operations.remove({ requester: requester(['manage:system']), id: 9 })).rejects.toMatchObject({ name: 'GROUP_DELETE_PROTECTED', status: 400 })

    expect(lifecycle).toEqual(['lookup'])
    expect(deleteById).not.toHaveBeenCalled()
    expect(revokeUserTokens).not.toHaveBeenCalled()
    expect(reloadGroups).not.toHaveBeenCalled()
  })

  it('retains the built-in group ID deletion defense without loading the targets', async () => {
    await expect(operations.remove({ requester: requester(['manage:system']), id: 1 })).rejects.toMatchObject({ name: 'GROUP_DELETE_PROTECTED', status: 400 })
    await expect(operations.remove({ requester: requester(['manage:system']), id: 2 })).rejects.toMatchObject({ name: 'GROUP_DELETE_PROTECTED', status: 400 })

    expect(findById).not.toHaveBeenCalled()
    expect(deleteById).not.toHaveBeenCalled()
    expect(revokeUserTokens).not.toHaveBeenCalled()
    expect(reloadGroups).not.toHaveBeenCalled()
  })

  it('checks and deletes ordinary groups before revoking their tokens', async () => {
    await operations.remove({ requester: requester(['manage:groups']), id: 3 })

    expect(findById).toHaveBeenCalledWith(3)
    expect(deleteById).toHaveBeenCalledWith(3)
    expect(lifecycle).toEqual(['lookup', 'delete', 'revoke', 'reload'])
    expect(revokeUserTokens).toHaveBeenCalledWith({ id: 3, kind: 'g' })
  })

  it('propagates delete persistence failures before revoking tokens', async () => {
    const failure = new Error('delete db down')
    deleteById = vi.fn(async () => {
      lifecycle.push('delete')
      throw failure
    })

    await expect(operations.remove({ requester: requester(['manage:groups']), id: 3 })).rejects.toBe(failure)

    expect(findById).toHaveBeenCalledWith(3)
    expect(deleteById).toHaveBeenCalledWith(3)
    expect(lifecycle).toEqual(['lookup', 'delete'])
    expect(revokeUserTokens).not.toHaveBeenCalled()
    expect(reloadGroups).not.toHaveBeenCalled()
  })
})
