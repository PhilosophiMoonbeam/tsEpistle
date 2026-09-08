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
    const readQuery = {
      findById: vi.fn().mockResolvedValue(asset)
    }
    const deleteQuery = {
      deleteById: vi.fn().mockResolvedValue(1)
    }
    const transaction = {}
    const assetsQuery = vi.fn(transactionArg => (transactionArg === transaction ? deleteQuery : readQuery))
    const knex = vi.fn()
    knex.transaction = vi.fn(async callback => callback(transaction))
    const assetEvent = vi.fn().mockResolvedValue(undefined)
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
        assets: { query: assetsQuery, flushTempUploads: vi.fn() },
        assetFolders: { query: vi.fn(), getHierarchy: vi.fn() },
        knex,
        storage: { assetEvent }
      }
    }
    const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
    const checkAccess = vi.fn().mockReturnValue(true)
    global.WIKI.auth = { checkAccess }
    const requester = { id: 1, name: 'Administrator', email: 'admin@example.com' }

    await operations.remove({ requester, id: 1 })

    expect(checkAccess).toHaveBeenCalledWith(requester, ['manage:system', 'manage:assets'], { path: 'probe.svg' })
    expect(knex.transaction).toHaveBeenCalledOnce()
    expect(assetsQuery).toHaveBeenNthCalledWith(1)
    expect(assetsQuery).toHaveBeenNthCalledWith(2, transaction)
    expect(deleteQuery.deleteById).toHaveBeenCalledWith(1)
    expect(asset.deleteAssetCache).toHaveBeenCalledOnce()
    expect(assetEvent).toHaveBeenCalledOnce()
    expect(deleteQuery.deleteById.mock.invocationCallOrder[0]).toBeLessThan(asset.deleteAssetCache.mock.invocationCallOrder[0])
    expect(asset.deleteAssetCache.mock.invocationCallOrder[0]).toBeLessThan(assetEvent.mock.invocationCallOrder[0])
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
    const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
    const requester = { id: 1, name: 'Administrator', email: 'admin@example.com' }

    const result = await operations.list({ requester, folderId: 0, kind: 'ALL' })

    expect(query.whereNull).toHaveBeenCalledWith('folderId')
    expect(query.where).not.toHaveBeenCalled()
    expect(checkAccess).toHaveBeenCalledWith(requester, ['manage:system', 'read:assets'], { path: 'browser-upload.txt' })
    expect(getHierarchy).toHaveBeenCalledWith(0)
    expect(result).toEqual([{ ...asset, kind: 'BINARY' }])
  })

  it('admits branding derivation only after capacity and keeps ready readers metadata-only', async () => {
    const assetPath = 'ready.svg'
    const sourceSha256 = 'b'.repeat(64)
    const asset = {
      id: 101,
      filename: 'ready.svg',
      folderId: null,
      metadata: {
        branding: {
          version: 2,
          sourceSha256,
          state: 'ready',
          width: 1,
          height: 1,
          accent: '#112233'
        }
      },
      getAssetPath: vi.fn().mockResolvedValue(assetPath)
    }
    const assetQuery = { findById: vi.fn().mockResolvedValue(asset) }
    const assetDataFirst = vi.fn().mockResolvedValue(undefined)
    const checkAccess = vi.fn().mockReturnValue(true)
    const knex = vi.fn(table => {
      const query = {
        where: vi.fn(),
        select: vi.fn().mockResolvedValue([]),
        first: table === 'assetData' ? assetDataFirst : vi.fn().mockResolvedValue(undefined)
      }
      query.where.mockReturnValue(query)
      return query
    })
    global.WIKI = {
      auth: { checkAccess },
      models: {
        assets: { query: vi.fn().mockReturnValue(assetQuery) },
        knex
      }
    }
    const branding = await vi.importFresh('../helpers/asset-branding.ts', import.meta.url)
    const reservations = Array.from({ length: 8 }, (_, index) => branding.reserveAssetBrandingAnalysis(index + 1))
    try {
      await expect(branding.refreshAssetBranding(asset.id)).rejects.toMatchObject({ status: 503, name: 'BRANDING_BUSY' })
      expect(assetQuery.findById).not.toHaveBeenCalled()
      expect(assetDataFirst).not.toHaveBeenCalled()

      branding.releaseAssetBrandingAnalysis(reservations.shift())
      await expect(branding.refreshAssetBranding(asset.id)).resolves.toBeNull()
      expect(assetQuery.findById).toHaveBeenCalledOnce()
      expect(assetDataFirst).toHaveBeenCalledOnce()

      const materializationsBeforeReadyRead = assetDataFirst.mock.calls.length
      await expect(
        branding.resolveAssetBrandingView({
          assetId: asset.id,
          requester: { id: 7, permissions: ['read:assets'] },
          sessionId: 'reader-session'
        })
      ).resolves.toMatchObject({ assetId: asset.id, sourceSha256, imageUrl: `/ready.svg?v=${sourceSha256}` })
      expect(assetDataFirst).toHaveBeenCalledTimes(materializationsBeforeReadyRead)
    } finally {
      reservations.forEach(branding.releaseAssetBrandingAnalysis)
    }
  })
})
