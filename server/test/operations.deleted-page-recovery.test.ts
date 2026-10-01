import { afterAll, beforeEach, describe, expect, it, vi } from './bun-test.mts'

const originalWiki = globalThis.WIKI
const admin = { id: 7, permissions: ['manage:system'] } as Express.User & { permissions: string[] }
const nonAdmin = { id: 8, permissions: ['read:pages'] } as Express.User & { permissions: string[] }
type RecoveryTestSnapshot = {
  history: {
    id: number
    pageId: number
    sourceRevision: string
    path: string
    localeCode: string
    title: string
    description: string
    visibility: 'public' | 'private'
    ownerId: number | null
    contentType: string
    editorKey: string
    content: string
  }
  tags: string[]
  recoveryRecord?: { pageId: number; deletionVersionId: number; deletionRevision: string; securityContext: unknown; createdAt: string }
}


const makeSnapshot = (options: { id?: number; pageId?: number; sourceRevision?: string; recovery?: boolean; visibility?: 'public' | 'private'; ownerId?: number | null } = {}): RecoveryTestSnapshot => {
  const id = options.id ?? 42
  const pageId = options.pageId ?? 17
  const sourceRevision = options.sourceRevision ?? '6'
  const visibility = options.visibility ?? 'private'
  const ownerId = options.ownerId === undefined ? (visibility === 'private' ? 100 : null) : options.ownerId
  return {
    history: {
      id,
      pageId,
      sourceRevision,
      path: 'retired/reference',
      localeCode: 'en',
      title: 'Retired reference',
      description: 'Historical notes',
      visibility,
      ownerId,
      contentType: 'markdown',
      editorKey: 'markdown',
      content: '# Confidential source\n\nText from the deleted page.',
    },
    tags: ['operations', 'recovery'],
    ...(options.recovery === false ? {} : {
      recoveryRecord: {
        pageId,
        deletionVersionId: id,
        deletionRevision: String(BigInt(sourceRevision) + 1n),
        createdAt: '2026-09-01T12:01:00.000Z',
        securityContext: {
          version: 1,
          former: { path: 'retired/reference', localeCode: 'en', visibility, ownerId, tags: ['operations', 'recovery'] },
          protection: visibility === 'private'
            ? { passwordHash: 'server-only-password-verifier', version: 3, updatedBy: 7, updatedAt: '2026-08-30T10:00:00.000Z' }
            : null
        }
      }
    })
  }
}

describe('deleted page recovery operations', () => {
  beforeEach(() => {
    globalThis.WIKI = {
      auth: { checkAccess: vi.fn((requester: Express.User, permissions: readonly string[]) => {
        const assignedPermissions = (requester as Express.User & { permissions?: string[] }).permissions
        return permissions.some(permission => assignedPermissions?.includes(permission))
      }) },
      models: { knex: {} }
    } as never
  })
  afterAll(() => {
    globalThis.WIKI = originalWiki
  })

  const createStore = async (snapshots: RecoveryTestSnapshot[], existingOwners: number[] = [7]) => {
    const { createDeletedPageRecoveryStore } = await vi.importFresh('../operations/deleted-page-recovery.ts', import.meta.url)
    const repository = {
      listCurrentDeletedSnapshots: vi.fn(async ({ beforeVersionId, limit }: { beforeVersionId?: number; limit: number }) =>
        snapshots.filter(snapshot => beforeVersionId === undefined || snapshot.history.id < beforeVersionId).sort((left, right) => right.history.id - left.history.id).slice(0, limit)),
      findCurrentDeletedSnapshot: vi.fn(async ({ pageId, versionId }: { pageId: number; versionId: number }) =>
        snapshots.find(snapshot => snapshot.history.pageId === pageId && snapshot.history.id === versionId)),
      ownerExists: vi.fn(async (id: number) => existingOwners.includes(id))
    }
    const restore = vi.fn(async ({ pageId, destination }: { pageId: number; destination: { path: string; localeCode: string } }) => ({
      pageId,
      sourceRevision: '9',
      path: destination.path,
      localeCode: destination.localeCode,
      quarantined: false as boolean
    }))
    return {
      repository,
      restore,
      store: createDeletedPageRecoveryStore({
        repository,
        hasSystemAccess: requester => (requester as Express.User & { permissions?: string[] }).permissions?.includes('manage:system') === true,
        restore
      })
    }
  }

  it('returns the same nondisclosing response to a non-admin and never reads deleted source', async () => {
    const { repository, restore, store } = await createStore([makeSnapshot()])

    await expect(store.inspect(nonAdmin, { pageId: 17, versionId: 42 })).rejects.toMatchObject({ name: 'PAGE_RECOVERY_NOT_FOUND', status: 404 })
    await expect(store.list(nonAdmin)).rejects.toMatchObject({ name: 'PAGE_RECOVERY_NOT_FOUND', status: 404 })
    await expect(store.restore(nonAdmin, { pageId: 17, versionId: 42, body: { destination: { path: 'new/path', localeCode: 'en' } } }))
      .rejects.toMatchObject({ name: 'PAGE_RECOVERY_NOT_FOUND', status: 404 })
    expect(repository.findCurrentDeletedSnapshot).not.toHaveBeenCalled()
    expect(repository.listCurrentDeletedSnapshots).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
  })

  it('lists bounded history metadata without returning source or the password verifier', async () => {
    const older = makeSnapshot({ id: 41, pageId: 16, sourceRevision: '2', recovery: false, visibility: 'public', ownerId: null })
    const newer = makeSnapshot()
    const { repository, store } = await createStore([older, newer])

    const response = await store.list(admin, { limit: 1 })

    expect(response.items).toHaveLength(1)
    expect(response.items[0]).toMatchObject({ deletionVersionId: 42, deletedAt: '2026-09-01T12:01:00.000Z', restoreMode: 'preserve', protection: { isProtected: true, version: 3 } })
    expect(response).toMatchObject({ hasMore: true, nextBeforeVersionId: 42 })
    expect(Object.hasOwn(response.items[0]!, 'content')).toBe(false)
    expect(JSON.stringify(response)).not.toContain('Confidential source')
    expect(JSON.stringify(response)).not.toContain('server-only-password-verifier')
    expect(repository.listCurrentDeletedSnapshots).toHaveBeenCalledWith({ limit: 2 })

    const next = await store.list(admin, { beforeVersionId: response.nextBeforeVersionId!, limit: 1 })
    expect(next.items.map(item => item.deletionVersionId)).toEqual([41])
    expect(next.items[0]).toMatchObject({ deletedAt: null, restoreMode: 'quarantine', protection: { isProtected: false, version: null } })
  })

  it('inspects source only for a system administrator and requires explicit ownership when the former owner is gone', async () => {
    const { repository, restore, store } = await createStore([makeSnapshot()], [7, 9])

    const inspected = await store.inspect(admin, { pageId: 17, versionId: 42 })
    expect(inspected).toMatchObject({
      pageId: 17,
      deletionVersionId: 42,
      content: '# Confidential source\n\nText from the deleted page.',
      restoreMode: 'preserve',
      ownerResolutionRequired: true
    })
    expect(JSON.stringify(inspected)).not.toContain('server-only-password-verifier')

    const base = { pageId: 17, versionId: 42, body: { destination: { path: 'recovered/reference', localeCode: 'en' } } }
    await expect(store.restore(admin, base)).rejects.toMatchObject({ name: 'PAGE_RECOVERY_OWNER_REQUIRED', status: 400 })
    expect(restore).not.toHaveBeenCalled()

    await store.restore(admin, { ...base, body: { ...base.body, ownerId: 9 } })
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ pageId: 17, deletionVersionId: 42, ownerId: 9 }))
  })

  it('assigns legacy snapshots to the recovering administrator without forwarding security context', async () => {
    const legacy = makeSnapshot({ recovery: false, visibility: 'public', ownerId: null })
    const { restore, store } = await createStore([legacy])

    await store.restore(admin, {
      pageId: 17,
      versionId: 42,
      body: { destination: { path: 'quarantine/reference', localeCode: 'en' } }
    })

    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ pageId: 17, deletionVersionId: 42, requester: admin, ownerId: admin.id }))
    expect(restore.mock.calls[0]![0]).not.toHaveProperty('securityContext')
  })

  it('rejects a stale deletion version before invoking the page writer', async () => {
    const { repository, restore, store } = await createStore([makeSnapshot({ id: 43 })])

    await expect(store.restore(admin, {
      pageId: 17,
      versionId: 42,
      body: { destination: { path: 'recovered/reference', localeCode: 'en' } }
    })).rejects.toMatchObject({ name: 'PAGE_RECOVERY_CONFLICT', status: 409 })

    expect(repository.findCurrentDeletedSnapshot).toHaveBeenCalledWith({ pageId: 17, versionId: 42, includeSource: false })
    expect(restore).not.toHaveBeenCalled()
  })
})
