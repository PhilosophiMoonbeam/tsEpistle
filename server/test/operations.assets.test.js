import createKnex from 'knex'
import { createHash } from 'node:crypto'

const assetHash = path => createHash('sha1').update(path).digest('hex')
const namedError = name => class extends Error {
  constructor(message = name) {
    super(message)
    this.name = name
  }
}

const createAssetQuery = db => {
  const query = vi.fn((transaction = db) => {
    const builder = transaction('assets')
    builder.findById = id => transaction('assets').where({ id }).first()
    builder.patch = values => {
      const update = transaction('assets').update(values)
      update.findById = id => transaction('assets').where({ id }).update(values)
      return update
    }
    builder.deleteById = id => transaction('assets').where({ id }).delete()
    return builder
  })
  return query
}

const runRelocationWorker = async db => {
  const { createAssetRelocationHandler } = await vi.importFresh('../jobs/asset-relocation.ts', import.meta.url)
  const { runDurableJobBatch } = await vi.importFresh('../core/durable-jobs.ts', import.meta.url)
  return runDurableJobBatch(db, {
    workerId: 'asset-relocation-test',
    now: new Date(Date.now() + 1_000),
    retryDelay: () => 0,
    handlers: { 'asset-relocation@1': createAssetRelocationHandler() }
  })
}

const createRelocationDatabase = async () => {
  const db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await db.schema.createTable('assets', table => {
    table.integer('id').primary()
    table.string('filename').notNullable()
    table.string('hash').notNullable()
    table.string('ext').notNullable()
    table.integer('folderId').nullable()
  })
  await db.schema.createTable('assetData', table => {
    table.integer('id').primary()
    table.binary('data').notNullable()
  })
  await db.schema.createTable('assetFolders', table => {
    table.integer('id').primary()
    table.string('slug').notNullable()
    table.integer('parentId').nullable()
  })
  await db.schema.createTable('durableJobs', table => {
    table.uuid('id').primary()
    table.string('type', 128).notNullable()
    table.integer('version').notNullable().defaultTo(1)
    table.text('payload').notNullable()
    table.string('state', 16).notNullable().defaultTo('pending')
    table.integer('attempts').notNullable().defaultTo(0)
    table.integer('maxAttempts').notNullable().defaultTo(5)
    table.dateTime('nextRunAt').notNullable()
    table.string('leaseOwner', 128).nullable()
    table.string('leaseToken', 128).nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.text('lastError').nullable()
    table.string('deduplicationKey', 255).nullable().unique()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('completedAt').nullable()
  })
  await db.schema.createTable('assetRelocationOperations', table => {
    table.uuid('id').primary()
    table.integer('assetId').nullable()
    table.integer('actorId').nullable()
    table.string('sourcePath', 512).notNullable()
    table.string('destinationPath', 512).notNullable()
    table.string('sourceHash', 64).notNullable()
    table.string('destinationHash', 64).notNullable()
    table.string('contentSha256', 64).notNullable()
    table.string('status', 16).notNullable()
    table.text('lastError').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('completedAt').nullable()
  })
  await db.schema.createTable('assetRelocationEffects', table => {
    table.uuid('id').primary()
    table.uuid('operationId').notNullable()
    table.uuid('jobId').notNullable()
    table.integer('assetId').notNullable()
    table.string('targetKey', 128).notNullable()
    table.string('targetConfigurationRevision', 128).notNullable()
    table.string('sourcePath', 512).notNullable()
    table.string('destinationPath', 512).notNullable()
    table.string('contentSha256', 64).notNullable()
    table.string('status', 16).notNullable()
    table.text('lastError').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('completedAt').nullable()
  })
  return db
}

const installRelocationWiki = ({
  db,
  assetQuery,
  getHierarchy = async () => [],
  targets = [],
  checkPageAccess = () => true,
  storage = {},
  logger = { warn: vi.fn() }
}) => {
  const folderQuery = vi.fn((transaction = db) => transaction('assetFolders'))
  const pageAccess = vi.fn(checkPageAccess)
  const storageRuntime = {
    assetEvent: vi.fn(),
    deleteAssetCaches: vi.fn().mockResolvedValue(undefined),
    relocationTargets: vi.fn(() => targets),
    ...storage
  }
  global.WIKI = {
    config: { db: { type: 'sqlite' } },
    logger,
    Error: {
      AssetDeleteForbidden: namedError('AssetDeleteForbidden'),
      AssetFolderExists: namedError('AssetFolderExists'),
      AssetInvalid: namedError('AssetInvalid'),
      AssetRenameCollision: namedError('AssetRenameCollision'),
      AssetRenameForbidden: namedError('AssetRenameForbidden'),
      AssetRenameInvalid: namedError('AssetRenameInvalid'),
      AssetRenameInvalidExt: namedError('AssetRenameInvalidExt'),
      AssetRenameTargetForbidden: namedError('AssetRenameTargetForbidden')
    },
    auth: {
      checkAccess: vi.fn(checkAccessFor),
      checkPageAccess: pageAccess,
      loadPageRuleAuthority: vi.fn(async requester => authorityFor(requester))
    },
    models: {
      assets: { query: assetQuery, flushTempUploads: vi.fn(), deleteAssetCaches: storageRuntime.deleteAssetCaches },
      assetFolders: { query: folderQuery, getHierarchy: vi.fn(getHierarchy) },
      knex: db,
      storage: storageRuntime
    }
  }
  return { folderQuery, pageAccess, storage: storageRuntime }
}
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
  it('renames and moves an asset to the canonical root location', async () => {
    const db = await createRelocationDatabase()
    try {
      const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['manage:assets', 'write:assets'] }
      const sourceFolder = { id: 42, slug: 'source', parentId: null }
      const asset = {
        id: 7,
        filename: 'old.png',
        hash: assetHash('source/old.png'),
        ext: '.png',
        folderId: sourceFolder.id
      }
      await db('assetFolders').insert(sourceFolder)
      await db('assets').insert(asset)
      await db('assetData').insert({ id: asset.id, data: Buffer.from('asset bytes') })
      const target = {
        key: 'disk',
        configurationKey: 'disk-revision',
        active: true,
        paused: false,
        supportsAssetRelocation: true
      }
      const reconcileAssetRelocation = vi.fn().mockResolvedValue(undefined)
      const assetQuery = createAssetQuery(db)
      const { pageAccess, storage } = installRelocationWiki({
        db,
        assetQuery,
        targets: [target],
        storage: { reconcileAssetRelocation },
        getHierarchy: async id => id === sourceFolder.id ? [sourceFolder] : []
      })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      const receipt = await operations.relocate({ requester, id: asset.id, filename: 'Renamed.PNG', folderId: 0 })

      expect(receipt).toMatchObject({
        assetId: asset.id,
        sourcePath: 'source/old.png',
        destinationPath: 'renamed.png',
        status: 'pending',
        effects: [{ targetKey: 'disk', status: 'pending', lastError: null }]
      })
      await runRelocationWorker(db)
      const completed = await operations.relocationStatus({ requester, id: receipt.id })
      expect(completed).toMatchObject({
        assetId: asset.id,
        sourcePath: 'source/old.png',
        destinationPath: 'renamed.png',
        status: 'succeeded',
        effects: [{ targetKey: 'disk', status: 'succeeded', lastError: null }]
      })
      expect(storage.reconcileAssetRelocation).toHaveBeenCalledWith(expect.objectContaining({
        id: asset.id,
        sourcePath: 'source/old.png',
        destinationPath: 'renamed.png'
      }))
      expect(await db('assets').where({ id: asset.id }).first()).toMatchObject({
        filename: 'renamed.png',
        folderId: null,
        hash: assetHash('renamed.png')
      })
      expect(pageAccess.mock.calls.map(([, , context]) => context.path)).toEqual(expect.arrayContaining(['source/old.png', 'renamed.png']))
    } finally {
      await db.destroy()
    }
  })

  it('moves an asset when folderId is the only requested field', async () => {
    const db = await createRelocationDatabase()
    try {
      const requester = { id: 8, name: 'Writer', email: 'writer@example.com', permissions: ['manage:assets', 'write:assets'] }
      const sourceFolder = { id: 43, slug: 'source', parentId: null }
      const asset = {
        id: 8,
        filename: 'old.png',
        hash: assetHash('source/old.png'),
        ext: '.png',
        folderId: sourceFolder.id
      }
      await db('assetFolders').insert(sourceFolder)
      await db('assets').insert(asset)
      await db('assetData').insert({ id: asset.id, data: Buffer.from('asset bytes') })
      const target = {
        key: 'disk',
        configurationKey: 'disk-revision',
        active: true,
        paused: false,
        supportsAssetRelocation: true
      }
      const reconcileAssetRelocation = vi.fn().mockResolvedValue(undefined)
      const assetQuery = createAssetQuery(db)
      const { pageAccess, storage } = installRelocationWiki({
        db,
        assetQuery,
        targets: [target],
        storage: { reconcileAssetRelocation },
        getHierarchy: async id => id === sourceFolder.id ? [sourceFolder] : []
      })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      const receipt = await operations.relocate({ requester, id: asset.id, folderId: 0 })

      expect(receipt).toMatchObject({
        assetId: asset.id,
        sourcePath: 'source/old.png',
        destinationPath: 'old.png',
        status: 'pending',
        effects: [{ targetKey: 'disk', status: 'pending', lastError: null }]
      })
      await runRelocationWorker(db)
      const completed = await operations.relocationStatus({ requester, id: receipt.id })
      expect(completed).toMatchObject({
        assetId: asset.id,
        sourcePath: 'source/old.png',
        destinationPath: 'old.png',
        status: 'succeeded',
        effects: [{ targetKey: 'disk', status: 'succeeded', lastError: null }]
      })
      expect(storage.reconcileAssetRelocation).toHaveBeenCalledWith(expect.objectContaining({
        id: asset.id,
        sourcePath: 'source/old.png',
        destinationPath: 'old.png'
      }))
      expect(await db('assets').where({ id: asset.id }).first()).toMatchObject({
        filename: 'old.png',
        folderId: null,
        hash: assetHash('old.png')
      })
      expect(pageAccess.mock.calls.map(([, , context]) => context.path)).toEqual(expect.arrayContaining(['source/old.png', 'old.png']))
    } finally {
      await db.destroy()
    }
  })

  it('checks source and destination authority before disclosing a relocation collision', async () => {
    const scenarios = [
      { name: 'source denial', error: 'AssetInvalid', check: () => false },
      { name: 'destination denial', error: 'AssetRenameTargetForbidden', check: (_user, _permissions, context) => context.path !== 'target/new.png' }
    ]
    for (const scenario of scenarios) {
      const db = await createRelocationDatabase()
      try {
        const requester = { id: 9, name: 'Writer', email: 'writer@example.com', permissions: ['write:assets'] }
        const sourceFolder = { id: 44, slug: 'source', parentId: null }
        const targetFolder = { id: 45, slug: 'target', parentId: null }
        const asset = {
          id: 9,
          filename: 'old.png',
          hash: assetHash('source/old.png'),
          ext: '.png',
          folderId: sourceFolder.id
        }
        await db('assetFolders').insert([sourceFolder, targetFolder])
        await db('assets').insert([
          asset,
          { id: 10, filename: 'new.png', hash: assetHash('target/new.png'), ext: '.png', folderId: targetFolder.id }
        ])
        await db('assetData').insert({ id: asset.id, data: Buffer.from('asset bytes') })
        const assetQuery = createAssetQuery(db)
        const { pageAccess } = installRelocationWiki({
          db,
          assetQuery,
          checkPageAccess: scenario.check,
          getHierarchy: async id => id === sourceFolder.id ? [sourceFolder] : id === targetFolder.id ? [targetFolder] : []
        })
        const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

        await expect(
          operations.relocate({ requester, id: asset.id, filename: 'new.png', folderId: targetFolder.id })
        ).rejects.toMatchObject({ name: scenario.error })

        expect(assetQuery).toHaveBeenCalledTimes(1)
        expect(pageAccess.mock.calls.map(([, , context]) => context.path)).toEqual(
          scenario.name === 'source denial' ? ['source/old.png'] : ['source/old.png', 'target/new.png']
        )
        expect(await db('assets').where({ id: asset.id }).first()).toMatchObject(asset)
      } finally {
        await db.destroy()
      }
    }
  })

  it('rejects an unsupported active target before mutating the canonical asset row', async () => {
    const db = await createRelocationDatabase()
    try {
      const requester = { id: 10, name: 'Writer', email: 'writer@example.com', permissions: ['write:assets'] }
      const asset = {
        id: 10,
        filename: 'old.png',
        hash: assetHash('old.png'),
        ext: '.png',
        folderId: null
      }
      const target = {
        key: 'legacy',
        configurationKey: 'legacy-revision',
        active: true,
        paused: false,
        supportsAssetRelocation: false
      }
      await db('assets').insert(asset)
      await db('assetData').insert({ id: asset.id, data: Buffer.from('asset bytes') })
      const assetQuery = createAssetQuery(db)
      const { storage } = installRelocationWiki({ db, assetQuery, targets: [target] })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      await expect(operations.relocate({ requester, id: asset.id, filename: 'new.png', folderId: 0 })).rejects.toMatchObject({
        status: 503,
        name: 'ASSET_RELOCATION_UNSUPPORTED',
        message: 'Storage target legacy cannot reconcile asset relocations.'
      })

      expect(await db('assets').where({ id: asset.id }).first()).toMatchObject(asset)
      expect(await db('assetRelocationOperations')).toHaveLength(0)
      expect(storage.deleteAssetCaches).not.toHaveBeenCalled()
    } finally {
      await db.destroy()
    }
  })

  it('returns the accepted pending receipt when post-commit cache cleanup fails', async () => {
    const db = await createRelocationDatabase()
    try {
      const requester = { id: 12, name: 'Writer', email: 'writer@example.com', permissions: ['manage:assets', 'write:assets'] }
      const asset = {
        id: 12,
        filename: 'old.png',
        hash: assetHash('old.png'),
        ext: '.png',
        folderId: null
      }
      const target = {
        key: 'disk',
        configurationKey: 'disk-revision',
        active: true,
        paused: false,
        supportsAssetRelocation: true
      }
      const logger = { warn: vi.fn() }
      const cacheError = new Error('cache path secret')
      const deleteAssetCaches = vi.fn().mockRejectedValue(cacheError)
      await db('assets').insert(asset)
      await db('assetData').insert({ id: asset.id, data: Buffer.from('asset bytes') })
      const assetQuery = createAssetQuery(db)
      const { storage } = installRelocationWiki({
        db,
        assetQuery,
        targets: [target],
        logger,
        storage: { deleteAssetCaches }
      })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      const accepted = await operations.relocate({ requester, id: asset.id, filename: 'new.png', folderId: 0 })

      expect(accepted).toMatchObject({
        assetId: asset.id,
        sourcePath: 'old.png',
        destinationPath: 'new.png',
        status: 'pending',
        effects: [{ targetKey: 'disk', status: 'pending', lastError: null }]
      })
      await expect(operations.relocationStatus({ requester, id: accepted.id })).resolves.toEqual(accepted)
      expect(deleteAssetCaches).toHaveBeenCalledWith([assetHash('old.png'), assetHash('new.png')])
      expect(logger.warn).toHaveBeenCalledWith(
        'Asset relocation committed, but cache cleanup could not be completed. The relocation receipt remains valid.'
      )
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(cacheError.message)
      expect(storage.relocationTargets).toHaveBeenCalled()
    } finally {
      await db.destroy()
    }
  })

  it('keeps a durable relocation receipt pending and records a terminal target failure', async () => {
    const db = await createRelocationDatabase()
    try {
      const requester = { id: 11, name: 'Writer', email: 'writer@example.com', permissions: ['manage:assets', 'write:assets'] }
      const asset = {
        id: 11,
        filename: 'old.png',
        hash: assetHash('old.png'),
        ext: '.png',
        folderId: null
      }
      const target = {
        key: 'disk',
        configurationKey: 'disk-revision',
        active: true,
        paused: false,
        supportsAssetRelocation: true
      }
      const reconciliationError = new Error('provider credentials must not be disclosed')
      const reconcileAssetRelocation = vi.fn().mockRejectedValue(reconciliationError)
      await db('assets').insert(asset)
      await db('assetData').insert({ id: asset.id, data: Buffer.from('asset bytes') })
      const assetQuery = createAssetQuery(db)
      const { storage } = installRelocationWiki({
        db,
        assetQuery,
        targets: [target],
        storage: { reconcileAssetRelocation }
      })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      const accepted = await operations.relocate({ requester, id: asset.id, filename: 'new.png', folderId: 0 })
      expect(accepted).toMatchObject({
        assetId: asset.id,
        sourcePath: 'old.png',
        destinationPath: 'new.png',
        status: 'pending',
        statusUrl: `/_api/assets/relocations/${accepted.id}`,
        effects: [{ targetKey: 'disk', status: 'pending', lastError: null }]
      })
      await expect(operations.relocationStatus({ requester, id: accepted.id })).resolves.toEqual(accepted)

      const effect = await db('assetRelocationEffects').where({ operationId: accepted.id }).first()
      await db('durableJobs').where({ id: effect.jobId }).update({ maxAttempts: 1 })
      await runRelocationWorker(db)

      const failed = await operations.relocationStatus({ requester, id: accepted.id })
      expect(failed).toMatchObject({
        assetId: asset.id,
        status: 'failed',
        effects: [{ targetKey: 'disk', status: 'failed', lastError: 'Storage target reconciliation failed.' }]
      })
      expect(JSON.stringify(failed)).not.toContain('provider credentials')
      expect(await db('durableJobs').where({ id: effect.jobId }).first()).toMatchObject({ state: 'failed' })
      expect(await db('assets').where({ id: asset.id }).first()).toMatchObject({ filename: 'new.png', folderId: null })
      expect(reconcileAssetRelocation).toHaveBeenCalledOnce()
      expect(storage.relocationTargets).toHaveBeenCalled()
    } finally {
      await db.destroy()
    }
  })

  it('refuses unresolved same-asset changes and foreign path reuse without mutating the ledger', async () => {
    const db = await createRelocationDatabase()
    try {
      const requester = { id: 21, name: 'Writer', email: 'writer@example.com', permissions: ['manage:assets', 'write:assets'] }
      const target = { key: 'disk', configurationKey: 'disk-revision', active: true, paused: false, supportsAssetRelocation: true }
      await db('assets').insert([
        { id: 21, filename: 'old.png', hash: assetHash('old.png'), ext: '.png', folderId: null },
        { id: 22, filename: 'other.png', hash: assetHash('other.png'), ext: '.png', folderId: null }
      ])
      await db('assetData').insert([
        { id: 21, data: Buffer.from('asset bytes') },
        { id: 22, data: Buffer.from('other bytes') }
      ])
      const assetQuery = createAssetQuery(db)
      installRelocationWiki({ db, assetQuery, targets: [target] })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      const accepted = await operations.relocate({ requester, id: 21, filename: 'new.png', folderId: 0 })
      await expect(operations.relocate({ requester, id: 21, filename: 'next.png', folderId: 0 })).rejects.toMatchObject({
        status: 409,
        code: 'ASSET_LOCATION_BUSY'
      })
      await expect(operations.relocate({ requester, id: 22, filename: 'new.png', folderId: 0 })).rejects.toMatchObject({
        status: 409,
        code: 'ASSET_LOCATION_BUSY'
      })

      expect(await db('assets').where({ id: 21 }).first()).toMatchObject({
        filename: 'new.png',
        hash: assetHash('new.png')
      })
      expect(await db('assets').where({ id: 22 }).first()).toMatchObject({
        filename: 'other.png',
        hash: assetHash('other.png')
      })
      expect(await db('assetRelocationOperations')).toHaveLength(1)
      expect(await db('assetRelocationEffects').where({ operationId: accepted.id })).toHaveLength(1)
    } finally {
      await db.destroy()
    }
  })

  it('fails a mismatched worker effect without superseding it or releasing reservations', async () => {
    const db = await createRelocationDatabase()
    try {
      const requester = { id: 23, name: 'Writer', email: 'writer@example.com', permissions: ['manage:assets', 'write:assets'] }
      const target = { key: 'disk', configurationKey: 'disk-revision', active: true, paused: false, supportsAssetRelocation: true }
      const reconcileAssetRelocation = vi.fn().mockResolvedValue(undefined)
      await db('assets').insert([
        { id: 23, filename: 'old.png', hash: assetHash('old.png'), ext: '.png', folderId: null },
        { id: 24, filename: 'other.png', hash: assetHash('other.png'), ext: '.png', folderId: null }
      ])
      await db('assetData').insert([
        { id: 23, data: Buffer.from('asset bytes') },
        { id: 24, data: Buffer.from('other bytes') }
      ])
      const assetQuery = createAssetQuery(db)
      installRelocationWiki({ db, assetQuery, targets: [target], storage: { reconcileAssetRelocation } })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      const accepted = await operations.relocate({ requester, id: 23, filename: 'new.png', folderId: 0 })
      const effect = await db('assetRelocationEffects').where({ operationId: accepted.id }).first()
      await db('assets').where({ id: 23 }).update({ hash: assetHash('tampered.png') })
      await db('durableJobs').where({ id: effect.jobId }).update({ maxAttempts: 1 })
      await runRelocationWorker(db)

      const failed = await operations.relocationStatus({ requester, id: accepted.id })
      expect(failed).toMatchObject({
        status: 'failed',
        effects: [{ status: 'failed', lastError: 'Storage target reconciliation failed.' }]
      })
      expect(failed.status).not.toBe('superseded')
      expect(reconcileAssetRelocation).not.toHaveBeenCalled()
      await expect(operations.relocate({ requester, id: 24, filename: 'new.png', folderId: 0 })).rejects.toMatchObject({
        status: 409,
        code: 'ASSET_LOCATION_BUSY'
      })
    } finally {
      await db.destroy()
    }
  })

  it('treats receipt ids as non-capabilities and hides revoked or foreign receipts', async () => {
    const db = await createRelocationDatabase()
    try {
      const owner = { id: 25, name: 'Owner', email: 'owner@example.com', permissions: ['manage:assets', 'write:assets'] }
      const foreign = { id: 26, name: 'Foreign', email: 'foreign@example.com', permissions: ['manage:assets', 'write:assets'] }
      const system = { id: 27, name: 'System', email: 'system@example.com', permissions: ['manage:system'] }
      let pathsAllowed = true
      const target = { key: 'disk', configurationKey: 'disk-revision', active: true, paused: false, supportsAssetRelocation: true }
      await db('assets').insert({ id: 25, filename: 'old.png', hash: assetHash('old.png'), ext: '.png', folderId: null })
      await db('assetData').insert({ id: 25, data: Buffer.from('asset bytes') })
      const assetQuery = createAssetQuery(db)
      installRelocationWiki({
        db,
        assetQuery,
        targets: [target],
        checkPageAccess: () => pathsAllowed
      })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      const accepted = await operations.relocate({ requester: owner, id: 25, filename: 'new.png', folderId: 0 })
      await expect(operations.relocationStatus({ requester: foreign, id: accepted.id })).rejects.toMatchObject({
        status: 404,
        name: 'ASSET_RELOCATION_NOT_FOUND',
        message: 'Asset relocation was not found.'
      })
      await expect(operations.relocationStatus({ requester: owner, id: 'not-a-receipt' })).rejects.toMatchObject({
        status: 404,
        name: 'ASSET_RELOCATION_NOT_FOUND',
        message: 'Asset relocation was not found.'
      })

      pathsAllowed = false
      await expect(operations.relocationStatus({ requester: owner, id: accepted.id })).rejects.toMatchObject({
        status: 404,
        name: 'ASSET_RELOCATION_NOT_FOUND',
        message: 'Asset relocation was not found.'
      })
      await expect(operations.relocationStatus({ requester: system, id: accepted.id })).resolves.toMatchObject({
        id: accepted.id,
        assetId: 25
      })
    } finally {
      await db.destroy()
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

