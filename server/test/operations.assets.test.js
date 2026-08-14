describe('asset operations', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('uses the initialized authorization service when it becomes available after import', async () => {
    const asset = {
      id: 1,
      filename: 'probe.svg',
      kind: 'image',
      ext: '.svg',
      folderId: null,
      deleteAssetCache: vi.fn().mockResolvedValue(undefined),
      getAssetPath: vi.fn().mockResolvedValue('probe.svg')
    }
    const query = {
      findById: vi.fn().mockResolvedValue(asset),
      deleteById: vi.fn().mockResolvedValue(1)
    }
    const del = vi.fn().mockResolvedValue(1)
    const where = vi.fn().mockReturnValue({ del })
    const knex = vi.fn().mockReturnValue({ where })
    global.WIKI = {
      Error: {
        AssetDeleteForbidden: Error,
        AssetFolderExists: Error,
        AssetInvalid: Error,
        AssetRenameCollision: Error,
        AssetRenameForbidden: Error,
        AssetRenameInvalid: Error,
        AssetRenameInvalidExt: Error,
        AssetRenameTargetForbidden: Error
      },
      models: {
        assets: { query: vi.fn().mockReturnValue(query), flushTempUploads: vi.fn() },
        assetFolders: { query: vi.fn(), getHierarchy: vi.fn() },
        knex,
        storage: { assetEvent: vi.fn().mockResolvedValue(undefined) }
      }
    }
    const { default: operations } = await import('../operations/assets.ts')
    const checkAccess = vi.fn().mockReturnValue(true)
    global.WIKI.auth = { checkAccess }
    const requester = { id: 1, name: 'Administrator', email: 'admin@example.com' }

    await operations.remove({ requester, id: 1 })

    expect(checkAccess).toHaveBeenCalledWith(requester, ['manage:assets'], { path: 'probe.svg' })
    expect(del).toHaveBeenCalledOnce()
    expect(query.deleteById).toHaveBeenCalledWith(1)
  })
})
