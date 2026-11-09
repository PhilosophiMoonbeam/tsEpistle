import createKnex from 'knex'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { configureTransportRuntime } from '../controllers/_types.ts'
import { up as createDurableJobs } from '../db/migrations/2.5.130.ts'
import { up as addLeaseToken } from '../db/migrations/2.5.158.ts'
import { storageConfigurationKey } from '../helpers/storage-configuration-key.ts'

const createStorageTargets = async (db, enabled = false) => {
  await db.schema.createTable('storage', table => {
    table.string('key').primary()
    table.boolean('isEnabled').notNullable()
    table.string('mode').notNullable()
    table.string('syncInterval').notNullable()
    table.json('config').notNullable()
  })
  await db.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.string('path').notNullable()
    table.string('localeCode').notNullable()
    table.string('contentType').notNullable()
    table.string('visibility').notNullable()
  })
  if (enabled) await db('storage').insert({ key: 'disk', isEnabled: true, mode: 'push', syncInterval: 'P0D', config: '{}' })
}

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
    table.string('name')
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
  await createStorageTargets(db)
  return db
}
const createImageResizeDatabase = async () => {
  const db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await db.schema.createTable('assets', table => {
    table.increments('id').primary()
    table.string('filename').notNullable()
    table.string('hash').notNullable().unique()
    table.string('ext').notNullable()
    table.string('kind').notNullable()
    table.string('mime').notNullable()
    table.integer('fileSize').notNullable()
    table.text('metadata').notNullable()
    table.integer('authorId').notNullable()
    table.integer('folderId').nullable()
    table.string('createdAt').notNullable()
    table.string('updatedAt').notNullable()
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
  await createStorageTargets(db, true)
  await createDurableJobs(db)
  await addLeaseToken(db)
  return db
}

const installImageResizeWiki = ({
  db,
  checkPageAccess = checkPageAccessFor,
  loadPageRuleAuthority = async requester => authorityFor(requester)
}) => {
  const assetQuery = createAssetQuery(db)
  const pageAccess = vi.fn(checkPageAccess)
  const loadAuthority = vi.fn(loadPageRuleAuthority)
  const storage = {}
  global.WIKI = {
    config: { db: { type: 'sqlite' }, lang: { code: 'en', namespacing: false } },
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
      loadPageRuleAuthority: loadAuthority
    },
    models: {
      assets: {
        query: assetQuery,
        flushTempUploads: vi.fn(),
        deleteAssetCaches: vi.fn().mockResolvedValue(undefined)
      },
      assetFolders: { query: vi.fn((transaction = db) => transaction('assetFolders')), getHierarchy: vi.fn(async () => []) },
      knex: db,
      storage
    }
  }
  return { assetQuery, pageAccess, loadAuthority }
}

const insertResizeSource = async (db, bytes, { id = 1, filename = 'source.png', folderId = null } = {}) => {
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString()
  const asset = {
    id,
    filename,
    hash: assetHash(filename),
    ext: filename.slice(filename.lastIndexOf('.')),
    kind: 'image',
    mime: 'image/png',
    fileSize: bytes.length,
    metadata: JSON.stringify({}),
    authorId: 7,
    folderId,
    createdAt: now,
    updatedAt: now
  }
  await db('assets').insert(asset)
  await db('assetData').insert({ id, data: bytes })
  return asset
}

const installRelocationWiki = async ({
  db,
  assetQuery,
  getHierarchy = async () => [],
  targets = [],
  checkPageAccess = () => true,
  storage = {},
  logger = { warn: vi.fn() }
}) => {
  for (const target of targets) {
    const configured = { key: target.key, isEnabled: true, mode: 'push', syncInterval: 'P0D', config: {} }
    await db('storage').insert({ ...configured, config: JSON.stringify(configured.config) }).onConflict('key').ignore()
    target.configurationKey = storageConfigurationKey(configured)
  }
  const folderQuery = vi.fn((transaction = db) => transaction('assetFolders'))
  const pageAccess = vi.fn(checkPageAccess)
  const storageRuntime = {
    deleteAssetCaches: vi.fn().mockResolvedValue(undefined),
    relocationTargets: vi.fn(() => targets),
    ...storage
  }
  global.WIKI = {
    config: { db: { type: 'sqlite' }, lang: { code: 'en', namespacing: false } },
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
const assetRouter = Object.fromEntries(['get', 'head', 'post', 'put', 'patch', 'delete', 'options', 'all', 'use'].map(method => [method, vi.fn()]))
vi.mockModule('express', import.meta.url, () => ({ default: { Router: () => assetRouter } }))

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
    const transaction = Object.assign(vi.fn(() => ({
      where: () => ({ orderBy: () => ({ forShare: () => ({ select: async () => [] }) }) })
    })), { schema: { hasTable: async () => false } })
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
        storage: {}
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
  })

  it('lists root assets', async () => {
    const db = await createImageResizeDatabase()
    try {
      const now = '2026-01-01T00:00:00.000Z'
      const asset = {
        id: 1,
        filename: 'browser-upload.txt',
        hash: assetHash('browser-upload.txt'),
        kind: 'binary',
        ext: '.txt',
        mime: 'text/plain',
        fileSize: 12,
        metadata: '{}',
        authorId: 7,
        folderId: null,
        createdAt: now,
        updatedAt: now
      }
      await db('assets').insert([
        asset,
        { ...asset, id: 2, filename: 'nested.txt', hash: assetHash('nested.txt'), folderId: 42 }
      ])
      installImageResizeWiki({ db })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
      const requester = { id: 1, name: 'Reader', email: 'reader@example.com', permissions: ['read:assets'] }

      const result = await operations.list({ requester, folderId: 0, kind: 'ALL' })

      expect(result).toEqual([{ ...asset, kind: 'BINARY' }])
    } finally {
      await db.destroy()
    }
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
      const { pageAccess, storage } = await installRelocationWiki({
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

  it.each([
    { slugs: ['.git'], filename: 'new.tmp', ext: '.tmp' },
    { slugs: ['media', '.GiT'], filename: 'new.tmp', ext: '.tmp' },
    { slugs: ['_manual'], filename: 'new.tmp', ext: '.tmp' },
    { slugs: ['_daily'], filename: 'new.tmp', ext: '.tmp' },
    { slugs: [], filename: '.asset.42.12345678-1234-4234-8234-123456789abc.tmp', ext: '.tmp' },
    { slugs: [], filename: '.git', ext: '' }
  ])('rejects internal rename and move destinations without canonical or durable effects: %j', async ({ slugs, filename, ext }) => {
    const db = await createRelocationDatabase()
    try {
      const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['manage:assets', 'write:assets'] }
      const hierarchy = slugs.map((slug, index) => ({ id: index + 42, slug, parentId: index === 0 ? null : index + 41 }))
      if (hierarchy.length > 0) await db('assetFolders').insert(hierarchy)
      const asset = { id: 7, filename: `old${ext}`, hash: assetHash(`old${ext}`), ext, folderId: null }
      const bytes = Buffer.from('retained canonical bytes')
      await db('assets').insert(asset)
      await db('assetData').insert({ id: asset.id, data: bytes })
      const assetQuery = createAssetQuery(db)
      const target = { key: 'disk', active: true, supportsAssetRelocation: true }
      const { storage } = await installRelocationWiki({ db, assetQuery, targets: [target], getHierarchy: async () => hierarchy })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      await expect(operations.relocate({
        requester,
        id: asset.id,
        filename,
        folderId: hierarchy.at(-1)?.id ?? null
      })).rejects.toMatchObject({ status: 400, name: 'ASSET_PATH_INVALID' })

      expect(await db('assets')).toEqual([asset])
      expect(Buffer.from((await db('assetData').first()).data)).toEqual(bytes)
      expect(await db('assetRelocationOperations')).toEqual([])
      expect(await db('assetRelocationEffects')).toEqual([])
      expect(await db('durableJobs')).toEqual([])
      expect(storage.deleteAssetCaches).not.toHaveBeenCalled()
    } finally {
      await db.destroy()
    }
  })

  it.each([
    { sourceSlugs: ['.GiT'], targetSlugs: [] },
    { sourceSlugs: ['_manual'], targetSlugs: ['media', '_manual'] },
    { sourceSlugs: [], targetSlugs: ['media', '_daily'] }
  ])('allows legacy source recovery and valid nested backup names: %j', async ({ sourceSlugs, targetSlugs }) => {
    const db = await createRelocationDatabase()
    try {
      const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['manage:assets', 'write:assets'] }
      const sourceHierarchy = sourceSlugs.map((slug, index) => ({ id: index + 42, slug, parentId: index === 0 ? null : index + 41 }))
      const targetHierarchy = targetSlugs.map((slug, index) => ({ id: index + 52, slug, parentId: index === 0 ? null : index + 51 }))
      if (sourceHierarchy.length + targetHierarchy.length > 0) await db('assetFolders').insert([...sourceHierarchy, ...targetHierarchy])
      const sourcePath = [...sourceSlugs, 'old.tmp'].join('/')
      const destinationPath = [...targetSlugs, 'new.tmp'].join('/')
      const asset = { id: 7, filename: 'old.tmp', hash: assetHash(sourcePath), ext: '.tmp', folderId: sourceHierarchy.at(-1)?.id ?? null }
      await db('assets').insert(asset)
      await db('assetData').insert({ id: asset.id, data: Buffer.from('recoverable bytes') })
      const assetQuery = createAssetQuery(db)
      const target = { key: 'disk', active: true, supportsAssetRelocation: true }
      await installRelocationWiki({
        db,
        assetQuery,
        targets: [target],
        getHierarchy: async id => id === sourceHierarchy.at(-1)?.id ? sourceHierarchy : targetHierarchy
      })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      const receipt = await operations.relocate({
        requester,
        id: asset.id,
        filename: 'new.tmp',
        folderId: targetHierarchy.at(-1)?.id ?? null
      })

      expect(receipt).toMatchObject({ sourcePath, destinationPath, status: 'pending' })
      expect(await db('assets').first()).toMatchObject({ filename: 'new.tmp', hash: assetHash(destinationPath), folderId: targetHierarchy.at(-1)?.id ?? null })
      expect(Buffer.from((await db('assetData').first()).data).toString()).toBe('recoverable bytes')
      expect(await db('assetRelocationEffects')).toHaveLength(1)
      expect(await db('durableJobs')).toHaveLength(1)
    } finally {
      await db.destroy()
    }
  })

  for (const activity of ['initializing', 'offline-paused', 'failed-initialization']) {
    it(`durably admits relocation for a database-enabled target during ${activity}`, async () => {
      const db = await createRelocationDatabase()
      try {
        const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['manage:assets', 'write:assets'] }
        const asset = { id: 7, filename: 'old.png', hash: assetHash('old.png'), ext: '.png', folderId: null }
        await db('assets').insert(asset)
        await db('assetData').insert({ id: asset.id, data: Buffer.from('retained canonical bytes') })
        const target = { key: 'disk', isEnabled: true, mode: 'push', syncInterval: 'P0D', config: {} }
        await db('storage').insert({ ...target, config: JSON.stringify(target.config) })
        const reconcileAssetRelocation = vi.fn().mockRejectedValue(new Error(activity))
        await installRelocationWiki({
          db,
          assetQuery: createAssetQuery(db),
          targets: activity === 'initializing' ? [] : [{
            key: target.key, configurationKey: storageConfigurationKey(target), active: false,
            paused: activity === 'offline-paused', supportsAssetRelocation: true
          }],
          storage: { reconcileAssetRelocation }
        })
        const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
        const receipt = await operations.relocate({ requester, id: asset.id, filename: 'new.png' })
        expect(receipt).toMatchObject({
          status: 'pending', sourcePath: 'old.png', destinationPath: 'new.png',
          effects: [{ targetKey: 'disk', status: 'pending' }]
        })
        expect(await db('assetRelocationEffects').where({ operationId: receipt.id })).toHaveLength(1)
        expect(await db('durableJobs').where({ type: 'asset-relocation', version: 1 })).toHaveLength(1)
        await runRelocationWorker(db)
        expect(await operations.relocationStatus({ requester, id: receipt.id })).toMatchObject({
          status: 'pending', effects: [{ targetKey: 'disk', status: 'pending' }]
        })
        reconcileAssetRelocation.mockResolvedValue(undefined)
        await db('durableJobs').where({ state: 'pending' }).update({ nextRunAt: new Date(0) })
        await runRelocationWorker(db)
        expect(await operations.relocationStatus({ requester, id: receipt.id })).toMatchObject({
          status: 'succeeded', effects: [{ targetKey: 'disk', status: 'succeeded' }]
        })
        expect(await db('assets').where({ id: asset.id }).first()).toMatchObject({ filename: 'new.png', hash: assetHash('new.png') })
      } finally {
        await db.destroy()
      }
    })
  }

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
      const { pageAccess, storage } = await installRelocationWiki({
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
        const { pageAccess } = await installRelocationWiki({
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
      const { storage } = await installRelocationWiki({ db, assetQuery, targets: [target] })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      await expect(operations.relocate({ requester, id: asset.id, filename: 'new.png', folderId: 0 })).rejects.toMatchObject({
        status: 503,
        name: 'ASSET_RELOCATION_UNSUPPORTED',
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
      await installRelocationWiki({
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
      expect(logger.warn).toHaveBeenCalled()
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(cacheError.message)
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
      await installRelocationWiki({
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
        effects: [{ targetKey: 'disk', status: 'failed', lastError: expect.any(String) }]
      })
      expect(JSON.stringify(failed)).not.toContain('provider credentials')
      expect(await db('durableJobs').where({ id: effect.jobId }).first()).toMatchObject({ state: 'failed' })
      expect(await db('assets').where({ id: asset.id }).first()).toMatchObject({ filename: 'new.png', folderId: null })
      expect(reconcileAssetRelocation).toHaveBeenCalledOnce()
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
      await installRelocationWiki({ db, assetQuery, targets: [target] })
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
      await installRelocationWiki({ db, assetQuery, targets: [target], storage: { reconcileAssetRelocation } })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      const accepted = await operations.relocate({ requester, id: 23, filename: 'new.png', folderId: 0 })
      const effect = await db('assetRelocationEffects').where({ operationId: accepted.id }).first()
      await db('assets').where({ id: 23 }).update({ hash: assetHash('tampered.png') })
      await db('durableJobs').where({ id: effect.jobId }).update({ maxAttempts: 1 })
      await runRelocationWorker(db)

      const failed = await operations.relocationStatus({ requester, id: accepted.id })
      expect(failed).toMatchObject({
        status: 'failed',
        effects: [{ status: 'failed', lastError: expect.any(String) }]
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
      await installRelocationWiki({
        db,
        assetQuery,
        targets: [target],
        checkPageAccess: () => pathsAllowed
      })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      const accepted = await operations.relocate({ requester: owner, id: 25, filename: 'new.png', folderId: 0 })
      const foreignError = await operations.relocationStatus({ requester: foreign, id: accepted.id }).catch(error => error)
      const malformedError = await operations.relocationStatus({ requester: owner, id: 'not-a-receipt' }).catch(error => error)
      expect(foreignError).toMatchObject({ status: 404, name: 'ASSET_RELOCATION_NOT_FOUND' })
      expect(malformedError).toMatchObject({ status: 404, name: 'ASSET_RELOCATION_NOT_FOUND' })

      pathsAllowed = false
      const revokedError = await operations.relocationStatus({ requester: owner, id: accepted.id }).catch(error => error)
      expect(revokedError).toMatchObject({ status: 404, name: 'ASSET_RELOCATION_NOT_FOUND' })
      const envelope = error => ({ status: error.status, name: error.name, message: error.message })
      expect(envelope(malformedError)).toEqual(envelope(foreignError))
      expect(envelope(revokedError)).toEqual(envelope(foreignError))
      await expect(operations.relocationStatus({ requester: system, id: accepted.id })).resolves.toMatchObject({
        id: accepted.id,
        assetId: 25
      })
    } finally {
      await db.destroy()
    }
  })


  it.each([
    { parentSlugs: [], slug: '.GiT', allowed: false },
    { parentSlugs: ['media'], slug: '.GiT', allowed: false },
    { parentSlugs: [], slug: '_manual', allowed: false },
    { parentSlugs: [], slug: '_daily', allowed: false },
    { parentSlugs: ['.GiT'], slug: 'child', allowed: false },
    { parentSlugs: [], slug: '.asset.42.12345678-1234-4234-8234-123456789abc.tmp', allowed: false },
    { parentSlugs: ['media'], slug: '_manual', allowed: true },
    { parentSlugs: ['media'], slug: '_daily', allowed: true },
    { parentSlugs: [], slug: '.gitignore', allowed: true },
    { parentSlugs: [], slug: '.asset.42.not-a-uuid.tmp', allowed: true }
  ])('applies the storage namespace policy to the complete folder destination: %j', async ({ parentSlugs, slug, allowed }) => {
    const db = await createRelocationDatabase()
    try {
      const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['write:assets'] }
      const hierarchy = parentSlugs.map((parentSlug, index) => ({ id: index + 42, slug: parentSlug, parentId: index === 0 ? null : index + 41 }))
      if (hierarchy.length > 0) await db('assetFolders').insert(hierarchy)
      const before = await db('assetFolders').orderBy('id')
      await installRelocationWiki({ db, assetQuery: createAssetQuery(db), getHierarchy: async () => hierarchy })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
      const admission = operations.createFolder({ requester, slug, parentFolderId: hierarchy.at(-1)?.id ?? 0 })

      if (allowed) {
        await admission
        expect(await db('assetFolders').where({ slug: slug.toLowerCase() }).first()).toMatchObject({
          slug: slug.toLowerCase(),
          parentId: hierarchy.at(-1)?.id ?? null
        })
        expect(await db('assetFolders')).toHaveLength(before.length + 1)
      } else {
        await expect(admission).rejects.toMatchObject({ status: 400, name: 'ASSET_PATH_INVALID' })
        expect(await db('assetFolders').orderBy('id')).toEqual(before)
      }
      expect(await db('assets')).toEqual([])
      expect(await db('assetRelocationOperations')).toEqual([])
      expect(await db('durableJobs')).toEqual([])
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
        storage: {}
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
        storage: {}
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
        storage: {}
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
          storage: {}
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
      })
      expect(events[0]).toBe('authority')
      expect(folderQuery.insert).not.toHaveBeenCalled()
      if (scenario.mode === 'hierarchy') expect(folderQuery.first).not.toHaveBeenCalled()
      if (scenario.mode === 'auth') expect(folderQuery.first).toHaveBeenCalledOnce()
    }

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
        storage: {}
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
    // Only unrelated route mounts are stubbed; the API error serializer is real.
    for (const name of [
      'analytics', 'auth', 'offline', 'comments', 'content-extensions', 'developer-flags',
      'extensions', 'editors', 'groups', 'locales', 'logging', 'mail', 'tls', 'navigation',
      'rendering', 'page-links', 'pages', 'page-ratings', 'search', 'site', 'site-logo',
      'storage', 'system', 'theming', 'users', 'utilities', 'taxonomy', 'webhooks'
    ]) {
      vi.mockModule(`../controllers/api/${name}.ts`, import.meta.url, () => ({ default: {} }))
    }

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
        logger: { error: vi.fn() },
        models: {
          assets: { query: vi.fn(), flushTempUploads: vi.fn() },
          assetFolders: { query: vi.fn(() => folderQuery), getHierarchy },
          knex,
          storage: {}
        }
      }

      const { default: resolver } = await vi.importFresh('../graph/resolvers/asset.ts', import.meta.url)
      const graphResult = await resolver.AssetMutation.createFolder(
        null,
        { parentFolderId: parent.id, slug: 'child' },
        { req: { user: requester } }
      )
      publicGraphDenials.push(graphResult.responseResult)
      configureTransportRuntime(global.WIKI)
      await vi.importFresh('../controllers/api/assets.ts', import.meta.url)
      const createHandler = assetRouter.post.mock.calls.find(([path]) => path === '/folders')?.[1]
      const next = vi.fn()
      await createHandler(
        { user: requester, body: { parentFolderId: parent.id, slug: 'child' } },
        { status: vi.fn().mockReturnThis(), json: vi.fn() },
        next
      )
      const restError = next.mock.calls[0]?.[0]
      expect(restError).toBeInstanceOf(Error)
      assetRouter.use.mockReset()
      await vi.importFresh('../controllers/api/index.ts', import.meta.url)
      const errorHandler = assetRouter.use.mock.calls.find(
        ([handler]) => typeof handler === 'function' && handler.length === 4
      )?.[0]
      const response = { status: vi.fn().mockReturnThis(), json: vi.fn() }
      errorHandler(restError, {}, response, vi.fn())
      expect(response.status).toHaveBeenCalledWith(403)
      publicRestDenials.push({
        status: response.status.mock.calls[0]?.[0],
        body: response.json.mock.calls[0]?.[0]
      })
      expect(folderQuery.insert).not.toHaveBeenCalled()
    }

    expect(publicGraphDenials[0]).toEqual(publicGraphDenials[1])
    expect(publicRestDenials[0]).toEqual(publicRestDenials[1])
    expect(publicGraphDenials[0]).toMatchObject({
      succeeded: false,
      slug: 'ASSET_FOLDER_FORBIDDEN',
    })
    expect(publicRestDenials[0]).toEqual({
      status: 403,
      body: { error: expect.any(String) }
    })
  })

  it('normalizes EXIF orientation and keeps proportions unless distortion is explicitly unlocked', async () => {
    const { transformAssetImage } = await vi.importFresh('../helpers/asset-image-transform.ts', import.meta.url)
    const oriented = await sharp({ create: { width: 8, height: 4, channels: 3, background: 'red' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    const normalized = await transformAssetImage(oriented, {
      width: 8,
      height: 8,
      aspectPolicy: 'preserve',
      format: 'png',
      quality: 85,
      animationPolicy: 'preserve'
    })
    expect(normalized).toMatchObject({ width: 4, height: 8, format: 'png', frames: 1 })
    expect(await sharp(normalized.data).metadata()).toMatchObject({ width: 4, height: 8, format: 'png' })
    expect((await sharp(normalized.data).metadata()).orientation).toBeUndefined()

    const source = await sharp({ create: { width: 8, height: 4, channels: 3, background: 'blue' } }).png().toBuffer()
    const preserved = await transformAssetImage(source, {
      width: 4,
      height: 4,
      aspectPolicy: 'preserve',
      format: 'webp',
      quality: 80,
      animationPolicy: 'preserve'
    })
    const stretched = await transformAssetImage(source, {
      width: 4,
      height: 4,
      aspectPolicy: 'stretch',
      format: 'jpeg',
      quality: 80,
      animationPolicy: 'preserve'
    })
    expect(preserved).toMatchObject({ width: 4, height: 2, format: 'webp' })
    expect(stretched).toMatchObject({ width: 4, height: 4, format: 'jpeg' })
    await expect(transformAssetImage(source, {
      width: 8_193,
      height: 1,
      aspectPolicy: 'preserve',
      format: 'png',
      quality: 80,
      animationPolicy: 'preserve'
    })).rejects.toMatchObject({ name: 'ASSET_IMAGE_TOO_LARGE' })
    await expect(transformAssetImage(Buffer.from('not an image'), {
      width: 4,
      height: 4,
      aspectPolicy: 'preserve',
      format: 'png',
      quality: 80,
      animationPolicy: 'preserve'
    })).rejects.toMatchObject({ name: 'ASSET_IMAGE_INVALID' })
  })

  it('applies ordered geometry in post-prior-op pixels and overwrites opaque RGBA without source metadata', async () => {
    const { transformAssetImage } = await vi.importFresh('../helpers/asset-image-transform.ts', import.meta.url)
    const pixels = Buffer.from([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      255, 255, 255, 255, 255, 0, 255, 0, 255, 255, 0, 255
    ])
    const source = await sharp(pixels, { raw: { width: 3, height: 2, channels: 4 } }).png().withMetadata().toBuffer()
    const program = [
      { type: 'crop', left: 1, top: 0, width: 2, height: 2 },
      { type: 'rotate', turns: 1 },
      { type: 'mirror', axis: 'horizontal' },
      { type: 'fill', left: 0, top: 1, width: 1, height: 1, color: '#102030' },
      { type: 'fill', left: 1, top: 0, width: 1, height: 1, color: '#405060' }
    ]
    for (const format of ['png', 'webp']) {
      const result = await transformAssetImage(source, {
        width: 2, height: 2, aspectPolicy: 'stretch', format, quality: 80, animationPolicy: 'preserve', operations: program
      })
      expect(result).toMatchObject({ width: 2, height: 2, editWidth: 2, editHeight: 2, frames: 1 })
      const decoded = await sharp(result.data).ensureAlpha().raw().toBuffer()
      expect([...decoded.subarray(0, 4)]).toEqual([0, 255, 0, 255])
      expect([...decoded.subarray(4, 8)]).toEqual([64, 80, 96, 255])
      expect([...decoded.subarray(8, 12)]).toEqual([16, 32, 48, 255])
      expect([...decoded.subarray(12, 16)]).toEqual([255, 255, 0, 255])
      const metadata = await sharp(result.data).metadata()
      for (const field of ['exif', 'xmp', 'iptc', 'icc', 'orientation']) expect(metadata[field]).toBeUndefined()
    }
  })

  it('uses EXIF-oriented crop coordinates and validates every operation boundary before editing', async () => {
    const { transformAssetImage } = await vi.importFresh('../helpers/asset-image-transform.ts', import.meta.url)
    const source = await sharp({ create: { width: 4, height: 2, channels: 4, background: 'red' } }).png().withMetadata({ orientation: 6 }).toBuffer()
    const options = { width: 2, height: 2, aspectPolicy: 'stretch', format: 'png', quality: 80, animationPolicy: 'preserve' }
    const valid = await transformAssetImage(source, { ...options, operations: [{ type: 'crop', left: 0, top: 2, width: 2, height: 2 }] })
    expect(valid).toMatchObject({ editWidth: 2, editHeight: 2, width: 2, height: 2 })
    for (const operations of [
      null, {}, Array.from({ length: 17 }, () => ({ type: 'rotate', turns: 1 })),
      [{ type: 'crop', left: 0, top: 0, width: 0, height: 1 }],
      [{ type: 'crop', left: -1, top: 0, width: 1, height: 1 }],
      [{ type: 'crop', left: 0, top: 0, width: 3, height: 1 }],
      [{ type: 'crop', left: NaN, top: 0, width: 1, height: 1 }],
      [{ type: 'crop', left: 0, top: Infinity, width: 1, height: 1 }],
      [{ type: 'rotate', turns: 4 }], [{ type: 'mirror', axis: 'diagonal' }],
      [{ type: 'fill', left: 0, top: 0, width: 1, height: 1, color: '#00000000' }],
      [{ type: 'fill', left: 0, top: 0, width: 1, height: 1, color: '#000000', opacity: 0.5 }],
      [{ type: 'crop', left: 0, top: 0, width: 1, height: 1 }, { type: 'fill', left: 1, top: 0, width: 1, height: 1, color: '#000000' }]
    ]) {
      await expect(transformAssetImage(source, { ...options, operations })).rejects.toMatchObject({ name: 'ASSET_IMAGE_INVALID' })
    }
    for (const format of ['jpeg', 'gif']) {
      await expect(transformAssetImage(source, { ...options, format, operations: [{ type: 'fill', left: 0, top: 0, width: 1, height: 1, color: '#000000' }] })).rejects.toMatchObject({ name: 'ASSET_IMAGE_UNSUPPORTED' })
    }
    for (const bytes of [Buffer.alloc(0), source.subarray(0, 24), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')]) {
      await expect(transformAssetImage(bytes, options)).rejects.toMatchObject({ name: expect.stringMatching(/^ASSET_IMAGE_(INVALID|UNSUPPORTED)$/) })
    }
    const tooWide = await sharp({ create: { width: 10001, height: 1, channels: 3, background: 'red' } }).png().toBuffer()
    await expect(transformAssetImage(tooWide, options)).rejects.toMatchObject({ name: 'ASSET_IMAGE_TOO_LARGE' })
  })

  it('preserves every animated resize frame but demands explicit first-frame conversion for geometry', async () => {
    const { transformAssetImage } = await vi.importFresh('../helpers/asset-image-transform.ts', import.meta.url)
    const source = await sharp(Buffer.from([
      255, 0, 0, 255, 0, 0,
      0, 0, 255, 0, 0, 255
    ]), { raw: { width: 2, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer()
    expect((await sharp(source, { animated: true }).metadata()).pages).toBe(2)
    const options = { width: 2, height: 1, aspectPolicy: 'preserve', format: 'gif', quality: 80, animationPolicy: 'preserve' }
    const preserved = await transformAssetImage(source, options)
    expect(preserved.frames).toBe(2)
    await expect(transformAssetImage(source, { ...options, operations: [{ type: 'mirror', axis: 'horizontal' }] })).rejects.toMatchObject({ name: 'ASSET_IMAGE_UNSUPPORTED' })
    const converted = await transformAssetImage(source, { ...options, animationPolicy: 'first-frame', operations: [{ type: 'mirror', axis: 'horizontal' }] })
    expect(converted.frames).toBe(1)
    expect((await sharp(converted.data, { animated: true }).metadata()).pages ?? 1).toBe(1)
  })

  it('rejects byte and animation-frame bombs and unavailable output codecs without accepting a result', async () => {
    const { transformAssetImage, ASSET_IMAGE_TRANSFORM_LIMITS } = await vi.importFresh('../helpers/asset-image-transform.ts', import.meta.url)
    const options = { width: 1, height: 1, aspectPolicy: 'preserve', format: 'gif', quality: 80, animationPolicy: 'preserve' }
    await expect(transformAssetImage(Buffer.alloc(ASSET_IMAGE_TRANSFORM_LIMITS.inputBytes + 1), options)).rejects.toMatchObject({ name: 'ASSET_IMAGE_TOO_LARGE' })
    // Alternate exact black/white pixels so palette quantization cannot merge adjacent frames.
    const pixels = Buffer.from(Array.from({ length: 101 }, (_, index) => Array(3).fill(index % 2 ? 255 : 0)).flat())
    const frames = await sharp(pixels, { raw: { width: 1, height: 101, channels: 3, pageHeight: 1 } }).gif({
      delay: Array(101).fill(100), loop: 0, keepDuplicateFrames: true, interPaletteMaxError: 0
    }).toBuffer()
    expect((await sharp(frames, { animated: true }).metadata()).pages).toBe(101)
    await expect(transformAssetImage(frames, options)).rejects.toMatchObject({ name: 'ASSET_IMAGE_TOO_LARGE' })
    const previous = sharp.format.webp.output.buffer
    try {
      sharp.format.webp.output.buffer = false
      await expect(transformAssetImage(Buffer.from('not decoded when codec is absent'), { ...options, format: 'webp' })).rejects.toMatchObject({ name: 'ASSET_IMAGE_UNSUPPORTED' })
    } finally { sharp.format.webp.output.buffer = previous }
  })

  it('stops admitted opaque-fill work at its deadline without publishing a partial save-as asset', async () => {
    const db = await createImageResizeDatabase()
    try {
      const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['read:assets', 'write:assets'] }
      const width = 64
      const height = 512
      const bytes = await sharp({ create: { width, height, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 0.5 } } }).png().toBuffer()
      const source = await insertResizeSource(db, bytes)
      installImageResizeWiki({ db })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
      const { ASSET_IMAGE_TRANSFORM_LIMITS } = await vi.importFresh('../helpers/asset-image-transform.ts', import.meta.url)
      const input = {
        requester, id: source.id, destination: { filename: 'redacted.png', folderId: 0 },
        width, height, aspectPolicy: 'stretch', format: 'png', quality: 80, animationPolicy: 'first-frame',
        operations: [{ type: 'fill', left: 1, top: 1, width: width - 2, height: height - 2, color: '#102030' }]
      }
      const preview = await operations.previewImage(input)
      const rgba = Buffer.from([16, 32, 48, 255])
      const nativeFill = Buffer.prototype.fill
      let now = 0
      let workingPixels
      let pixelsAtDeadline
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
      const fill = vi.spyOn(Buffer.prototype, 'fill').mockImplementation(function (value, ...args) {
        const result = nativeFill.call(this, value, ...args)
        if (workingPixels === undefined && this.length === width * height * 4 && Buffer.isBuffer(value) && value.equals(rgba)) {
          // Expire during actual native pixel work, independently of machine
          // speed, while leaving the decoder and save-as operation real.
          workingPixels = this
          pixelsAtDeadline = Buffer.from(this)
          now = ASSET_IMAGE_TRANSFORM_LIMITS.processingSeconds * 1000
        }
        return result
      })
      try {
        await expect(operations.resizeImage({
          ...input, expectedSourceSha256: preview.sourceSha256, expectedSourceRevision: preview.sourceRevision
        })).rejects.toMatchObject({ status: 422, name: 'ASSET_IMAGE_PROCESSING_LIMIT' })
      } finally {
        fill.mockRestore()
        clock.mockRestore()
      }
      expect(workingPixels).toBeDefined()
      expect(workingPixels).toEqual(pixelsAtDeadline)
      const lastRegionPixel = ((height - 2) * width + width - 2) * 4
      expect(workingPixels.subarray(lastRegionPixel, lastRegionPixel + 4)).not.toEqual(rgba)
      expect(await db('assets')).toEqual([source])
      expect(await db('assetData')).toHaveLength(1)
      expect(Buffer.from((await db('assetData').where({ id: source.id }).first()).data)).toEqual(bytes)
      expect(await db('durableJobs')).toEqual([])
    } finally { await db.destroy() }
  })

  it('retires source-derived previews when authority or source bytes change during rendering', async () => {
    for (const change of ['authority', 'bytes']) {
      const db = await createImageResizeDatabase()
      try {
        const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['read:assets', 'write:assets'] }
        const bytes = await sharp({ create: { width: 4, height: 2, channels: 4, background: 'red' } }).png().toBuffer()
        const source = await insertResizeSource(db, bytes)
        let loads = 0
        installImageResizeWiki({ db, loadPageRuleAuthority: async (user, transaction) => {
          if (++loads === 2) {
            if (change === 'authority') user.permissions = []
            else await transaction('assetData').where({ id: source.id }).update({ data: Buffer.from('changed during preview') })
          }
          return authorityFor(user)
        } })
        const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
        await expect(operations.previewImage({
          requester, id: source.id, destination: { filename: 'preview.png', folderId: 0 },
          width: 4, height: 2, aspectPolicy: 'stretch', format: 'png', quality: 80, animationPolicy: 'first-frame',
          operations: [{ type: 'mirror', axis: 'horizontal' }]
        })).rejects.toMatchObject({ name: change === 'authority' ? 'ASSET_IMAGE_SOURCE_UNAVAILABLE' : 'ASSET_IMAGE_SOURCE_STALE' })
        expect(await db('assets')).toEqual([source])
        expect(Buffer.from((await db('assetData').where({ id: source.id }).first()).data)).toEqual(bytes)
        expect(await db('durableJobs')).toEqual([])
      } finally { await db.destroy() }
    }
  })

  it('previews without writes and saves identical re-decoded edited pixels through the existing atomic outbox', async () => {
    const db = await createImageResizeDatabase()
    try {
      const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['read:assets', 'write:assets'] }
      const bytes = await sharp({ create: { width: 4, height: 2, channels: 4, background: 'red' } }).png().toBuffer()
      const source = await insertResizeSource(db, bytes)
      installImageResizeWiki({ db })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
      const input = { requester, id: source.id, destination: { filename: 'edited.png', folderId: 0 }, width: 2, height: 4, aspectPolicy: 'stretch', format: 'png', quality: 80, animationPolicy: 'first-frame',
        operations: [{ type: 'rotate', turns: 1 }, { type: 'fill', left: 0, top: 0, width: 1, height: 4, color: '#000000' }] }
      const preview = await operations.previewImage(input)
      expect(preview).toMatchObject({ status: 'previewed', width: 2, height: 4, editWidth: 2, editHeight: 4 })
      expect(preview.sourceSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(preview.sourceRevision).toMatch(/^[0-9a-f]{64}$/)
      expect(await db('assets')).toEqual([source])
      expect(await db('assetData')).toHaveLength(1)
      expect(await db('durableJobs')).toEqual([])
      await expect(operations.resizeImage(input)).rejects.toMatchObject({ status: 400, name: 'ASSET_IMAGE_INPUT_INVALID' })
      const reviewed = { ...input, expectedSourceSha256: preview.sourceSha256, expectedSourceRevision: preview.sourceRevision }
      const saves = await Promise.allSettled([operations.resizeImage(reviewed), operations.resizeImage(reviewed)])
      expect(saves.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      const winner = saves.find(result => result.status === 'fulfilled')
      const refused = saves.find(result => result.status === 'rejected')
      expect(refused.reason).toMatchObject({ status: 409, name: 'ASSET_IMAGE_DESTINATION_CONFLICT' })
      const saved = winner.value
      const output = Buffer.from((await db('assetData').where({ id: saved.assetId }).first()).data)
      const previewBytes = Buffer.from(preview.dataUrl.split(',')[1], 'base64')
      expect(await sharp(output).raw().toBuffer()).toEqual(await sharp(previewBytes).raw().toBuffer())
      expect(Buffer.from((await db('assetData').where({ id: source.id }).first()).data)).toEqual(bytes)
      expect((await db('assets').where({ id: source.id }).first())).toEqual(source)
      expect(await db('durableJobs')).toHaveLength(1)
      await expect(operations.resizeImage(reviewed)).rejects.toMatchObject({ status: 409, name: 'ASSET_IMAGE_DESTINATION_CONFLICT' })
      expect(await db('assets')).toHaveLength(2)
    } finally { await db.destroy() }
  })

  it('rejects changed preview identity and revoked authority and rolls back edited outputs on outbox failure', async () => {
    const db = await createImageResizeDatabase()
    try {
      const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['read:assets', 'write:assets'] }
      const bytes = await sharp({ create: { width: 4, height: 2, channels: 4, background: 'red' } }).png().toBuffer()
      const source = await insertResizeSource(db, bytes)
      let writable = true
      installImageResizeWiki({ db, checkPageAccess: (user, permissions, context, authority) => (!permissions.includes('write:assets') || writable) && checkPageAccessFor(user, permissions, context, authority) })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
      const input = { requester, id: source.id, destination: { filename: 'edited.png', folderId: 0 }, width: 4, height: 2, aspectPolicy: 'stretch', format: 'png', quality: 80, animationPolicy: 'first-frame', operations: [{ type: 'mirror', axis: 'horizontal' }] }
      const preview = await operations.previewImage(input)
      const reviewed = { ...input, expectedSourceSha256: preview.sourceSha256, expectedSourceRevision: preview.sourceRevision }
      await db('assets').where({ id: source.id }).update({ updatedAt: '2026-11-08T00:00:00.000Z' })
      await expect(operations.resizeImage(reviewed)).rejects.toMatchObject({ status: 409, name: 'ASSET_IMAGE_SOURCE_STALE' })
      await db('assets').where({ id: source.id }).update({ updatedAt: source.updatedAt })
      await db('assets').where({ id: source.id }).update({ filename: 'renamed.png', hash: assetHash('renamed.png') })
      await expect(operations.resizeImage(reviewed)).rejects.toMatchObject({ status: 409, name: 'ASSET_IMAGE_SOURCE_STALE' })
      await db('assets').where({ id: source.id }).update({ filename: source.filename, hash: source.hash })
      await db('assetData').where({ id: source.id }).update({ data: Buffer.from('replaced source bytes') })
      await expect(operations.resizeImage(reviewed)).rejects.toMatchObject({ status: 409, name: 'ASSET_IMAGE_SOURCE_STALE' })
      await db('assetData').where({ id: source.id }).update({ data: bytes })
      await db('assets').where({ id: source.id }).delete()
      await expect(operations.resizeImage(reviewed)).rejects.toMatchObject({ status: 404, name: 'ASSET_IMAGE_SOURCE_UNAVAILABLE' })
      await db('assets').insert(source)
      writable = false
      await expect(operations.resizeImage(reviewed)).rejects.toMatchObject({ status: 403, name: 'ASSET_IMAGE_DESTINATION_FORBIDDEN' })
      writable = true
      await db.raw("CREATE TRIGGER reject_edited_storage BEFORE INSERT ON durableJobs BEGIN SELECT RAISE(FAIL, 'edited storage rejected'); END")
      await expect(operations.resizeImage(reviewed)).rejects.toThrow('edited storage rejected')
      expect(await db('assets')).toEqual([source])
      expect(await db('assetData')).toHaveLength(1)
      expect(Buffer.from((await db('assetData').where({ id: source.id }).first()).data)).toEqual(bytes)
      expect(await db('durableJobs')).toEqual([])
    } finally { await db.destroy() }
  })

  it('preflights a visible folder with native path authority and no relocation or publication writes', async () => {
    const db = await createImageResizeDatabase()
    try {
      const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['manage:assets', 'write:assets'] }
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer()
      const source = await insertResizeSource(db, bytes)
      const folder = { id: 42, slug: 'allowed', parentId: null }
      await db('assetFolders').insert(folder)
      let writable = true
      const { pageAccess } = installImageResizeWiki({ db, checkPageAccess: (user, permissions, context, authority) => (!permissions.includes('write:assets') || writable) && checkPageAccessFor(user, permissions, context, authority) })
      global.WIKI.models.assetFolders.getHierarchy.mockImplementation(async id => id === folder.id ? [folder] : [])
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
      expect(await operations.previewMove({ requester, id: source.id, folderId: folder.id })).toEqual({ sourcePath: 'source.png', destinationPath: 'allowed/source.png' })
      expect(pageAccess).toHaveBeenCalledWith(requester, ['manage:system', 'write:assets'], { path: 'allowed/source.png' }, expect.any(Object))
      writable = false
      await expect(operations.previewMove({ requester, id: source.id, folderId: folder.id })).rejects.toMatchObject({ name: 'AssetRenameTargetForbidden' })
      await expect(operations.previewMove({ requester, id: source.id, folderId: 0 })).rejects.toMatchObject({ name: 'AssetInvalid' })
      await expect(operations.previewMove({ requester, id: source.id, folderId: 99 })).rejects.toMatchObject({ name: 'AssetRenameTargetForbidden' })
      writable = true
      requester.permissions = ['write:assets']
      await expect(operations.previewMove({ requester, id: source.id, folderId: folder.id })).rejects.toMatchObject({ name: 'AssetInvalid' })
      expect(await db('assets')).toEqual([source])
      expect(Buffer.from((await db('assetData').where({ id: source.id }).first()).data)).toEqual(bytes)
      expect(await db('durableJobs')).toEqual([])
    } finally { await db.destroy() }
  })

  it('creates a new resized asset and leaves source identity and bytes unchanged', async () => {
    const db = await createImageResizeDatabase()
    try {
      const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['read:assets', 'write:assets'] }
      const sourceBytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: 'red' } }).png().toBuffer()
      const source = await insertResizeSource(db, sourceBytes)
      const { pageAccess } = installImageResizeWiki({ db })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      const receipt = await operations.resizeImage({
        requester,
        id: source.id,
        destination: { filename: 'copy.webp', folderId: 0 },
        width: 4,
        height: 4,
        aspectPolicy: 'preserve',
        format: 'webp',
        quality: 80,
        animationPolicy: 'preserve'
      })

      expect(receipt).toMatchObject({
        status: 'succeeded',
        assetId: 2,
        destinationPath: 'copy.webp',
        width: 4,
        height: 2,
        format: 'webp',
        frames: 1
      })
      const rows = await db('assets').orderBy('id')
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ id: source.id, filename: source.filename, hash: source.hash, fileSize: source.fileSize })
      expect(rows[1]).toMatchObject({
        id: receipt.assetId,
        filename: 'copy.webp',
        hash: assetHash('copy.webp'),
        ext: '.webp',
        kind: 'image',
        mime: 'image/webp',
        folderId: null
      })
      expect(Buffer.from((await db('assetData').where({ id: source.id }).first()).data)).toEqual(sourceBytes)
      const output = Buffer.from((await db('assetData').where({ id: receipt.assetId }).first()).data)
      expect(await sharp(output).metadata()).toMatchObject({ width: 4, height: 2, format: 'webp' })
      expect(pageAccess.mock.calls.map(([, permissions, context]) => [permissions[0], context.path])).toEqual(
        expect.arrayContaining([
          ['read:assets', 'source.png'],
          ['write:assets', 'copy.webp']
        ])
      )
      const effects = await db('durableJobs')
      expect(effects).toHaveLength(1)
      expect(JSON.parse(effects[0].payload)).toMatchObject({ entityType: 'asset', entityId: receipt.assetId, paths: ['copy.webp'] })
    } finally {
      await db.destroy()
    }
  })

  it('rejects an internal resize destination before publishing a derived asset or mutation', async () => {
    const db = await createImageResizeDatabase()
    try {
      const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['read:assets', 'write:assets'] }
      const sourceBytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: 'red' } }).png().toBuffer()
      const source = await insertResizeSource(db, sourceBytes)
      const folder = { id: 42, slug: '.GiT', parentId: null }
      await db('assetFolders').insert(folder)
      installImageResizeWiki({ db })
      global.WIKI.models.assetFolders.getHierarchy.mockImplementation(async () => [folder])
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)

      await expect(operations.resizeImage({
        requester,
        id: source.id,
        destination: { filename: 'copy.png', folderId: folder.id },
        width: 4,
        height: 4,
        aspectPolicy: 'preserve',
        format: 'png',
        quality: 80,
        animationPolicy: 'preserve'
      })).rejects.toMatchObject({ status: 400, name: 'ASSET_PATH_INVALID' })

      expect(await db('assets')).toEqual([source])
      expect(Buffer.from((await db('assetData').first()).data)).toEqual(sourceBytes)
      expect(await db('durableJobs')).toEqual([])
      expect(global.WIKI.models.assets.deleteAssetCaches).not.toHaveBeenCalled()
    } finally {
      await db.destroy()
    }
  })

  it('rolls back a resized output and its blob when storage admission fails', async () => {
    const db = await createImageResizeDatabase()
    try {
      const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['read:assets', 'write:assets'] }
      const sourceBytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: 'red' } }).png().toBuffer()
      const source = await insertResizeSource(db, sourceBytes)
      installImageResizeWiki({ db })
      const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
      await db.raw("CREATE TRIGGER reject_storage_admission BEFORE INSERT ON durableJobs BEGIN SELECT RAISE(FAIL, 'storage admission failed'); END")
      await expect(operations.resizeImage({
        requester, id: source.id, destination: { filename: 'copy.webp', folderId: null },
        width: 4, height: 4, aspectPolicy: 'preserve', format: 'webp', quality: 80, animationPolicy: 'preserve'
      })).rejects.toThrow('storage admission failed')
      expect(await db('assets')).toHaveLength(1)
      expect(await db('assetData')).toHaveLength(1)
      expect(Buffer.from((await db('assetData').where({ id: source.id }).first()).data)).toEqual(sourceBytes)
      expect(await db('durableJobs')).toHaveLength(0)
    } finally {
      await db.destroy()
    }
  })

  it('rejects unauthorized, colliding, and stale save-as requests without creating an output asset', async () => {
    const requester = { id: 7, name: 'Writer', email: 'writer@example.com', permissions: ['read:assets', 'write:assets'] }
    const sourceBytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: 'red' } }).png().toBuffer()

    {
      const db = await createImageResizeDatabase()
      try {
        const source = await insertResizeSource(db, sourceBytes)
        installImageResizeWiki({
          db,
          checkPageAccess: (_user, permissions) => permissions[0] !== 'write:assets'
        })
        const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
        await expect(operations.resizeImage({
          requester,
          id: source.id,
          destination: { filename: 'denied.png', folderId: null },
          width: 4,
          height: 4,
          aspectPolicy: 'preserve',
          format: 'png',
          quality: 80,
          animationPolicy: 'preserve'
        })).rejects.toMatchObject({ status: 403, name: 'ASSET_IMAGE_DESTINATION_FORBIDDEN' })
        expect(await db('assets')).toHaveLength(1)
      } finally {
        await db.destroy()
      }
    }
    {
      const db = await createImageResizeDatabase()
      try {
        const source = await insertResizeSource(db, sourceBytes)
        const { pageAccess } = installImageResizeWiki({ db, checkPageAccess: () => false })
        const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
        await expect(operations.resizeImage({
          requester,
          id: source.id,
          destination: { filename: 'unreadable.png', folderId: null },
          width: 4,
          height: 4,
          aspectPolicy: 'preserve',
          format: 'png',
          quality: 80,
          animationPolicy: 'preserve'
        })).rejects.toMatchObject({ status: 404, name: 'ASSET_IMAGE_SOURCE_UNAVAILABLE' })
        expect(pageAccess).toHaveBeenCalledWith(
          requester,
          ['read:assets'],
          { path: 'source.png' },
          expect.any(Object)
        )
        expect(await db('assets')).toHaveLength(1)
      } finally {
        await db.destroy()
      }
    }


    {
      const db = await createImageResizeDatabase()
      try {
        const source = await insertResizeSource(db, sourceBytes)
        await db('assets').insert({
          ...source,
          id: 2,
          filename: 'copy.png',
          hash: assetHash('copy.png'),
          authorId: requester.id
        })
        installImageResizeWiki({ db })
        const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
        await expect(operations.resizeImage({
          requester,
          id: source.id,
          destination: { filename: 'copy.png', folderId: null },
          width: 4,
          height: 4,
          aspectPolicy: 'preserve',
          format: 'png',
          quality: 80,
          animationPolicy: 'preserve'
        })).rejects.toMatchObject({ status: 409, name: 'ASSET_IMAGE_DESTINATION_CONFLICT' })
        expect(await db('assets')).toHaveLength(2)
        expect(Buffer.from((await db('assetData').where({ id: source.id }).first()).data)).toEqual(sourceBytes)
      } finally {
        await db.destroy()
      }
    }

    {
      const db = await createImageResizeDatabase()
      try {
        const source = await insertResizeSource(db, sourceBytes)
        let authorityLoads = 0
        const { loadAuthority } = installImageResizeWiki({
          db,
          loadPageRuleAuthority: async (suppliedRequester, transaction) => {
            authorityLoads += 1
            if (authorityLoads === 2) {
              await transaction('assetData').where({ id: source.id }).update({ data: Buffer.from('changed during transform') })
            }
            return authorityFor(suppliedRequester)
          }
        })
        const { default: operations } = await vi.importFresh('../operations/assets.ts', import.meta.url)
        await expect(operations.resizeImage({
          requester,
          id: source.id,
          destination: { filename: 'stale.png', folderId: null },
          width: 4,
          height: 4,
          aspectPolicy: 'preserve',
          format: 'png',
          quality: 80,
          animationPolicy: 'preserve'
        })).rejects.toMatchObject({ status: 409, name: 'ASSET_IMAGE_SOURCE_STALE' })
        expect(loadAuthority).toHaveBeenCalledTimes(2)
        expect(await db('assets')).toHaveLength(1)
        expect(Buffer.from((await db('assetData').where({ id: source.id }).first()).data)).toEqual(sourceBytes)
      } finally {
        await db.destroy()
      }
    }
  })

  it('rejects replace-mode fields in the resize API before invoking the operation', async () => {
    assetRouter.post.mockReset()
    const requester = { id: 7, name: 'Writer', email: 'writer@example.com' }
    global.WIKI = { auth: { checkAccess: vi.fn(() => true) } }
    configureTransportRuntime(global.WIKI)
    await vi.importFresh('../controllers/api/assets.ts', import.meta.url)
    const handler = assetRouter.post.mock.calls.find(([path]) => path === '/:id/resize')?.[1]
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), set: vi.fn().mockReturnThis() }
    const next = vi.fn()
    await handler(
      {
        user: requester,
        params: { id: '1' },
        body: {
          destination: { filename: 'copy.png', folderId: 0 },
          width: 10,
          height: 10,
          aspectPolicy: 'preserve',
          format: 'png',
          quality: 80,
          animationPolicy: 'preserve',
          replace: true
        }
      },
      response,
      next
    )
    expect(response.status).toHaveBeenCalledWith(400)
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }))
    expect(next).not.toHaveBeenCalled()
  })
})

