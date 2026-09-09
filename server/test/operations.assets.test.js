const assetRouter = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => assetRouter } }))
vi.mockModule('../controllers/_types.ts', import.meta.url, () => ({
  objectValue: (value, key) => value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined,
  getWikiAuth: () => globalThis.WIKI.auth
}))

const authorityFor = requester => ({
  requester,
  permissions: Array.isArray(requester?.permissions) ? [...requester.permissions] : [],
  groups: [],
  tagAliases: {}
})

const checkAccessFor = (user, permissions) => {
  const granted = Array.isArray(user?.permissions) ? user.permissions : []
  return granted.includes('manage:system') || permissions.some(permission => granted.includes(permission))
}

const checkPageAccessFor = (user, permissions, _context, authority) =>
  authority?.requester === user && checkAccessFor(user, permissions)

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
    const transaction = {}
    const transactionQuery = {
      where: vi.fn(),
      whereNull: vi.fn(),
      forUpdate: vi.fn(),
      first: vi.fn().mockResolvedValue(asset),
      deleteById: vi.fn().mockResolvedValue(1)
    }
    transactionQuery.where.mockReturnValue(transactionQuery)
    transactionQuery.whereNull.mockReturnValue(transactionQuery)
    transactionQuery.forUpdate.mockReturnValue(transactionQuery)
    const assetsQuery = vi.fn(transactionArg => (transactionArg === transaction ? transactionQuery : readQuery))
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
    const checkAccess = vi.fn(checkAccessFor)
    const checkPageAccess = vi.fn(checkPageAccessFor)
    const loadPageRuleAuthority = vi.fn(async suppliedRequester => authorityFor(suppliedRequester))
    global.WIKI.auth = { checkAccess, checkPageAccess, loadPageRuleAuthority }
    const requester = { id: 1, name: 'Administrator', email: 'admin@example.com', permissions: ['manage:system', 'manage:assets'] }

    await operations.remove({ requester, id: 1 })

    expect(asset.deleteAssetCache).toHaveBeenCalledOnce()
    expect(assetEvent).toHaveBeenCalledOnce()
  })

  it('lists root assets', async () => {
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
    const checkAccess = vi.fn(checkAccessFor)
    const checkPageAccess = vi.fn(checkPageAccessFor)
    const loadPageRuleAuthority = vi.fn(async suppliedRequester => authorityFor(suppliedRequester))
    global.WIKI = {
      Error: {},
      auth: { checkAccess, checkPageAccess, loadPageRuleAuthority },
      models: {
        assets: { query: vi.fn().mockReturnValue(query), flushTempUploads: vi.fn() },
        assetFolders: { query: vi.fn(), getHierarchy },
        knex: vi.fn(),
        storage: { assetEvent: vi.fn() }
      }
    }
    const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
    const requester = { id: 1, name: 'Reader', email: 'reader@example.com', permissions: ['read:assets'] }

    const result = await operations.list({ requester, folderId: 0, kind: 'ALL' })

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
    const checkAccess = vi.fn(checkAccessFor)
    const checkPageAccess = vi.fn(checkPageAccessFor)
    const loadPageRuleAuthority = vi.fn(async suppliedRequester => authorityFor(suppliedRequester))
    const reader = { id: 7, permissions: ['read:assets'] }
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
      auth: { checkAccess, checkPageAccess, loadPageRuleAuthority },
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

      const materializationsBeforeReadyRead = assetDataFirst.mock.calls.length
      await expect(
        branding.resolveAssetBrandingView({
          assetId: asset.id,
          requester: reader,
          sessionId: 'reader-session'
        })
      ).resolves.toMatchObject({ assetId: asset.id, sourceSha256, imageUrl: `/ready.svg?v=${sourceSha256}` })
      expect(assetDataFirst).toHaveBeenCalledTimes(materializationsBeforeReadyRead)
    } finally {
      reservations.forEach(branding.releaseAssetBrandingAnalysis)
    }
  })

  it('authorizes the canonical nested destination before collision lookup or insertion', async () => {
    const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['write:assets'] }
    const parent = { id: 20, name: 'Team A', slug: 'Team-A', parentId: null }
    const transaction = { raw: vi.fn() }
    let firstCall = 0
    const folderQuery = {
      where: vi.fn(),
      whereNull: vi.fn(),
      forUpdate: vi.fn(),
      first: vi.fn(async () => firstCall++ === 0 ? parent : undefined),
      insert: vi.fn().mockResolvedValue(undefined)
    }
    folderQuery.where.mockReturnValue(folderQuery)
    folderQuery.whereNull.mockReturnValue(folderQuery)
    folderQuery.forUpdate.mockReturnValue(folderQuery)
    const getHierarchy = vi.fn(async (id, suppliedTransaction) => {
      expect(id).toBe(parent.id)
      expect(suppliedTransaction).toBe(transaction)
      return [parent]
    })
    const authority = authorityFor(requester)
    const loadPageRuleAuthority = vi.fn(async (suppliedRequester, suppliedTransaction) => {
      expect(suppliedRequester).toBe(requester)
      expect(suppliedTransaction).toBe(transaction)
      return authority
    })
    const checkPageAccess = vi.fn(() => true)
    const knex = {
      transaction: vi.fn(async callback => callback(transaction))
    }
    global.WIKI = {
      config: { db: { type: 'postgres' } },
      Error: { AssetFolderExists: class extends Error {} },
      auth: { checkAccess: checkAccessFor, checkPageAccess, loadPageRuleAuthority },
      models: {
        assets: { query: vi.fn(), flushTempUploads: vi.fn() },
        assetFolders: { query: vi.fn(() => folderQuery), getHierarchy },
        knex,
        storage: { assetEvent: vi.fn() }
      }
    }

    const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
    await operations.createFolder({ requester, slug: 'New Folder', parentFolderId: parent.id })

    expect(checkPageAccess).toHaveBeenCalledWith(
      requester,
      ['manage:system', 'write:assets'],
      { path: 'Team-A/new folder' },
      authority
    )
    expect(transaction.raw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(?, hashtext(?))',
      [0x4153464c, 'Team-A/new folder']
    )
    expect(folderQuery.insert).toHaveBeenCalledWith({ slug: 'new folder', name: 'new folder', parentId: parent.id })
  })

  it('denies a destination before checking an existing collision', async () => {
    const requester = { id: 8, name: 'Reader', email: 'reader@example.com', permissions: ['write:assets'] }
    const transaction = { raw: vi.fn() }
    const parent = { id: 30, name: 'Denied', slug: 'denied', parentId: null }
    const first = vi.fn().mockResolvedValue(parent)
    const folderQuery = {
      where: vi.fn(),
      whereNull: vi.fn(),
      forUpdate: vi.fn(),
      first,
      insert: vi.fn()
    }
    folderQuery.where.mockReturnValue(folderQuery)
    folderQuery.whereNull.mockReturnValue(folderQuery)
    folderQuery.forUpdate.mockReturnValue(folderQuery)
    const getHierarchy = vi.fn().mockResolvedValue([parent])
    const checkPageAccess = vi.fn(() => false)
    const knex = { transaction: vi.fn(async callback => callback(transaction)) }
    global.WIKI = {
      config: { db: { type: 'postgres' } },
      Error: { AssetFolderExists: class extends Error {} },
      auth: {
        checkAccess: checkAccessFor,
        checkPageAccess,
        loadPageRuleAuthority: vi.fn(async suppliedRequester => authorityFor(suppliedRequester))
      },
      models: {
        assets: { query: vi.fn(), flushTempUploads: vi.fn() },
        assetFolders: { query: vi.fn(() => folderQuery), getHierarchy },
        knex,
        storage: { assetEvent: vi.fn() }
      }
    }

    const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
    await expect(operations.createFolder({ requester, slug: 'existing', parentFolderId: parent.id })).rejects.toMatchObject({
      status: 403,
      name: 'ASSET_FOLDER_FORBIDDEN'
    })

    expect(checkPageAccess).toHaveBeenCalledWith(
      requester,
      ['manage:system', 'write:assets'],
      { path: 'denied/existing' },
      expect.any(Object)
    )
    expect(first).toHaveBeenCalledOnce()
    expect(folderQuery.insert).not.toHaveBeenCalled()
    expect(transaction.raw).not.toHaveBeenCalled()
  })

  it('serializes root destinations and inserts through the transaction', async () => {
    const requester = { id: 9, name: 'Root Writer', email: 'root@example.com', permissions: ['write:assets'] }
    const transaction = { raw: vi.fn() }
    const folderQuery = {
      where: vi.fn(),
      whereNull: vi.fn(),
      forUpdate: vi.fn(),
      first: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue(undefined)
    }
    folderQuery.where.mockReturnValue(folderQuery)
    folderQuery.whereNull.mockReturnValue(folderQuery)
    folderQuery.forUpdate.mockReturnValue(folderQuery)
    const getHierarchy = vi.fn()
    const checkPageAccess = vi.fn(() => true)
    const knex = { transaction: vi.fn(async callback => callback(transaction)) }
    global.WIKI = {
      config: { db: { type: 'postgres' } },
      Error: { AssetFolderExists: class extends Error {} },
      auth: {
        checkAccess: checkAccessFor,
        checkPageAccess,
        loadPageRuleAuthority: vi.fn(async suppliedRequester => authorityFor(suppliedRequester))
      },
      models: {
        assets: { query: vi.fn(), flushTempUploads: vi.fn() },
        assetFolders: { query: vi.fn(() => folderQuery), getHierarchy },
        knex,
        storage: { assetEvent: vi.fn() }
      }
    }

    const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
    await operations.createFolder({ requester, slug: 'Root Folder', parentFolderId: 0 })

    expect(getHierarchy).not.toHaveBeenCalled()
    expect(checkPageAccess).toHaveBeenCalledWith(
      requester,
      ['manage:system', 'write:assets'],
      { path: 'root folder' },
      expect.any(Object)
    )
    expect(transaction.raw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(?, hashtext(?))',
      [0x4153464c, 'root folder']
    )
    expect(folderQuery.insert).toHaveBeenCalledWith({ slug: 'root folder', name: 'root folder', parentId: null })
  })

  it('normalizes every structural parent denial before collision lookup', async () => {
    const requester = { id: 11, name: 'Writer', email: 'writer@example.com', permissions: ['write:assets'] }
    const parent = { id: 42, name: 'Parent', slug: 'parent', parentId: null }
    const cases = [
      { kind: 'missing', mode: 'hierarchy' },
      { kind: 'cycle', mode: 'hierarchy' },
      { kind: 'incomplete', mode: 'hierarchy' },
      { kind: 'disappeared', mode: 'lock' },
      { kind: 'forbidden', mode: 'auth' }
    ]
    const publicDenials = []

    for (const scenario of cases) {
      const events = []
      const transaction = { raw: vi.fn() }
      const first = vi.fn(async () => {
        events.push('lock')
        return scenario.mode === 'lock' ? undefined : parent
      })
      const folderQuery = {
        where: vi.fn(),
        whereNull: vi.fn(),
        forUpdate: vi.fn(),
        first,
        insert: vi.fn()
      }
      folderQuery.where.mockReturnValue(folderQuery)
      folderQuery.whereNull.mockReturnValue(folderQuery)
      folderQuery.forUpdate.mockReturnValue(folderQuery)
      const checkPageAccess = vi.fn(() => scenario.mode !== 'auth')
      const loadPageRuleAuthority = vi.fn(async (_requester, suppliedTransaction) => {
        expect(suppliedTransaction).toBe(transaction)
        events.push('authority')
        return authorityFor(requester)
      })
      const getHierarchy = vi.fn(async (_id, suppliedTransaction) => {
        expect(suppliedTransaction).toBe(transaction)
        events.push('hierarchy')
        if (scenario.mode === 'hierarchy') {
          const { AssetFolderHierarchyError } = await import('../models/assetFolders.ts')
          throw new AssetFolderHierarchyError(scenario.kind, parent.id)
        }
        return [parent]
      })
      const knex = { transaction: vi.fn(async callback => callback(transaction)) }
      global.WIKI = {
        config: { db: { type: 'postgres' } },
        Error: { AssetFolderExists: class extends Error {} },
        auth: { checkAccess: checkAccessFor, checkPageAccess, loadPageRuleAuthority },
        models: {
          assets: { query: vi.fn(), flushTempUploads: vi.fn() },
          assetFolders: { query: vi.fn(() => folderQuery), getHierarchy },
          knex,
          storage: { assetEvent: vi.fn() }
        }
      }

      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
      let error
      try {
        await operations.createFolder({ requester, slug: 'child', parentFolderId: parent.id })
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(Error)
      publicDenials.push({ status: error.status, name: error.name, message: error.message })
      expect(error).toMatchObject({
        status: 403,
        name: 'ASSET_FOLDER_FORBIDDEN',
        message: 'You are not authorized to create this asset folder.'
      })
      expect(events[0]).toBe('authority')
      expect(folderQuery.insert).not.toHaveBeenCalled()
      if (scenario.mode === 'hierarchy') expect(folderQuery.first).not.toHaveBeenCalled()
      if (scenario.mode === 'auth') expect(folderQuery.first).toHaveBeenCalledOnce()
    }

    expect(publicDenials).toHaveLength(cases.length)
    expect(new Set(publicDenials.map(denial => JSON.stringify(denial))).size).toBe(1)
  })

  it('preserves infrastructure errors while normalizing only typed hierarchy state', async () => {
    const requester = { id: 12, name: 'Writer', email: 'writer@example.com', permissions: ['write:assets'] }
    const transaction = {}
    const databaseFailure = new Error('database unavailable')
    const getHierarchy = vi.fn(async () => { throw databaseFailure })
    const loadPageRuleAuthority = vi.fn(async () => authorityFor(requester))
    const knex = { transaction: vi.fn(async callback => callback(transaction)) }
    global.WIKI = {
      Error: { AssetFolderExists: class extends Error {} },
      auth: { checkAccess: checkAccessFor, checkPageAccess: vi.fn(() => true), loadPageRuleAuthority },
      models: {
        assets: { query: vi.fn(), flushTempUploads: vi.fn() },
        assetFolders: { query: vi.fn(), getHierarchy },
        knex,
        storage: { assetEvent: vi.fn() }
      }
    }

    const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
    await expect(operations.createFolder({ requester, slug: 'child', parentFolderId: 42 })).rejects.toBe(databaseFailure)
  })
  it('keeps REST and GraphQL structural denials identical without exposing collisions', async () => {
    const requester = { id: 13, name: 'Writer', email: 'writer@example.com', permissions: ['write:assets'] }
    const parent = { id: 42, name: 'Parent', slug: 'parent', parentId: null }
    const publicRestDenials = []
    const publicGraphDenials = []

    for (const mode of ['missing', 'forbidden']) {
      assetRouter.post.mockReset()
      const transaction = { raw: vi.fn() }
      const first = vi.fn().mockResolvedValue(parent)
      const folderQuery = {
        where: vi.fn(),
        whereNull: vi.fn(),
        forUpdate: vi.fn(),
        first,
        insert: vi.fn()
      }
      folderQuery.where.mockReturnValue(folderQuery)
      folderQuery.whereNull.mockReturnValue(folderQuery)
      folderQuery.forUpdate.mockReturnValue(folderQuery)
      const checkPageAccess = vi.fn(() => mode === 'forbidden' ? false : true)
      const getHierarchy = vi.fn(async (_id, suppliedTransaction) => {
        expect(suppliedTransaction).toBe(transaction)
        if (mode === 'missing') {
          const { AssetFolderHierarchyError } = await import('../models/assetFolders.ts')
          throw new AssetFolderHierarchyError('missing', parent.id)
        }
        return [parent]
      })
      const auth = {
        checkAccess: vi.fn(() => true),
        checkPageAccess,
        loadPageRuleAuthority: vi.fn(async () => authorityFor(requester))
      }
      const knex = { transaction: vi.fn(async callback => callback(transaction)) }
      global.WIKI = {
        config: { db: { type: 'postgres' } },
        Error: { AssetFolderExists: class extends Error {} },
        auth,
        models: {
          assets: { query: vi.fn(), flushTempUploads: vi.fn() },
          assetFolders: { query: vi.fn(() => folderQuery), getHierarchy },
          knex,
          storage: { assetEvent: vi.fn() }
        }
      }

      const { default: resolver } = await vi.importFresh('../graph/resolvers/asset.ts', import.meta.url)
      const graphResult = await resolver.AssetMutation.createFolder(
        null,
        { parentFolderId: parent.id, slug: 'child' },
        { req: { user: requester } }
      )
      publicGraphDenials.push(graphResult.responseResult)
      const { default: controller } = await vi.importFresh('../controllers/api/assets.ts', import.meta.url)
      expect(controller).toBeDefined()
      const createHandler = assetRouter.post.mock.calls.find(([path]) => path === '/folders')?.[1]
      expect(createHandler).toBeInstanceOf(Function)
      const next = vi.fn()
      await createHandler(
        { user: requester, body: { parentFolderId: parent.id, slug: 'child' } },
        { status: vi.fn().mockReturnThis(), json: vi.fn() },
        next
      )
      const restError = next.mock.calls[0]?.[0]
      expect(restError).toBeInstanceOf(Error)
      publicRestDenials.push({
        status: restError.status,
        body: {
          code: restError.code ?? 'INTERNAL_REST_ERROR',
          error: restError.message
        }
      })
      expect(folderQuery.insert).not.toHaveBeenCalled()
    }

    expect(publicGraphDenials[0]).toEqual(publicGraphDenials[1])
    expect(publicRestDenials[0]).toEqual(publicRestDenials[1])
    expect(publicGraphDenials[0]).toMatchObject({
      succeeded: false,
      slug: 'ASSET_FOLDER_FORBIDDEN',
      message: 'You are not authorized to create this asset folder.'
    })
    expect(publicRestDenials[0]).toEqual({
      status: 403,
      body: {
        code: 'INTERNAL_REST_ERROR',
        error: 'You are not authorized to create this asset folder.'
      }
    })
  })

})

