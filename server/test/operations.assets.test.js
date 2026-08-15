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

    expect(checkAccess).toHaveBeenCalledWith(requester, ['manage:system', 'manage:assets'], { path: 'probe.svg' })
    expect(del).toHaveBeenCalledOnce()
    expect(query.deleteById).toHaveBeenCalledWith(1)
  })

  it('lists root assets with a null folder predicate', async () => {
    const asset = {
      id: 1,
      filename: 'browser-upload.txt',
      kind: 'binary',
      ext: '.txt',
      folderId: null
    }
    const rows = Promise.resolve([asset])
    const query = {
      where: vi.fn(),
      whereNull: vi.fn(),
      then: rows.then.bind(rows)
    }
    query.where.mockReturnValue(query)
    query.whereNull.mockReturnValue(query)
    const getHierarchy = vi.fn().mockResolvedValue([])
    const checkAccess = vi.fn().mockReturnValue(true)
    global.WIKI = {
      Error: {},
      auth: { checkAccess },
      models: {
        assets: { query: vi.fn().mockReturnValue(query), flushTempUploads: vi.fn() },
        assetFolders: { query: vi.fn(), getHierarchy },
        knex: vi.fn(),
        storage: { assetEvent: vi.fn() }
      }
    }
    const { default: operations } = await import('../operations/assets.ts')
    const requester = { id: 1, name: 'Administrator', email: 'admin@example.com' }

    const result = await operations.list({ requester, folderId: 0, kind: 'ALL' })

    expect(query.whereNull).toHaveBeenCalledWith('folderId')
    expect(query.where).not.toHaveBeenCalled()
    expect(checkAccess).toHaveBeenCalledWith(requester, ['manage:system', 'read:assets'], { path: 'browser-upload.txt' })
    expect(getHierarchy).toHaveBeenCalledWith(0)
    expect(result).toEqual([{ ...asset, kind: 'BINARY' }])
  })
})
