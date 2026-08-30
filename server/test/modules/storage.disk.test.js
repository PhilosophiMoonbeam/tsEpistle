import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

describe('disk storage target', () => {
  let plugin
  let rootPath
  let context

  beforeEach(async () => {
    vi.resetModules()
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-disk-'))
    global.WIKI = {
      ROOTPATH: rootPath,
      config: {
        lang: {
          code: 'en',
          namespacing: false
        }
      },
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn()
      },
      models: {}
    }
    plugin = (await vi.importFresh('../../modules/storage/disk/storage.ts', import.meta.url)).default
    context = {
      config: {
        path: 'content',
        createDailyBackups: false
      }
    }
    await plugin.init.call(context)
  })

  afterEach(async () => {
    await fs.rm(rootPath, { recursive: true, force: true })
  })

  it('atomically replaces assets inside the configured root', async () => {
    const asset = { path: 'images/logo.txt', data: Buffer.from('first') }

    await plugin.assetUploaded.call(context, asset)
    await plugin.assetUploaded.call(context, { ...asset, data: Buffer.from('second') })

    const filePath = path.join(rootPath, 'content', 'images', 'logo.txt')
    expect(await fs.readFile(filePath, 'utf8')).toBe('second')
    expect(await plugin.getLocalLocation.call(context, asset)).toBe(filePath)
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['logo.txt'])
  })

  it.each([
    '../escape.txt',
    'images/../../escape.txt',
    '/tmp/wiki-storage-escape.txt'
  ])('rejects asset paths outside the configured root: %s', async assetPath => {
    await expect(Promise.resolve(plugin.assetUploaded.call(context, {
      path: assetPath,
      data: Buffer.from('blocked')
    }))).rejects.toThrow(`Storage path escapes the configured root: ${assetPath}`)
  })

  it('rejects page paths outside the configured root', async () => {
    await expect(Promise.resolve(plugin.created.call(context, {
      localeCode: 'en',
      path: '../../escape',
      contentType: 'markdown',
      injectMetadata: () => 'blocked'
    }))).rejects.toThrow('Storage path escapes the configured root: ../../escape.md')
  })

  it('quarantines failed initialization while dispatching only to healthy targets', async () => {
    const failedPatch = vi.fn().mockResolvedValue(1)
    const healthyPatch = vi.fn().mockResolvedValue(1)
    const failedTarget = {
      key: 'git',
      config: {},
      mode: 'push',
      syncInterval: 'P0D',
      state: { status: 'pending', message: '', lastAttempt: null },
      $query: vi.fn(() => ({ patch: failedPatch }))
    }
    const healthyTarget = {
      key: 'disk',
      config: {
        path: 'content',
        createDailyBackups: false
      },
      mode: 'push',
      syncInterval: 'P0D',
      state: { status: 'pending', message: '', lastAttempt: null },
      $query: vi.fn(() => ({ patch: healthyPatch }))
    }
    const orderBy = vi.fn().mockResolvedValue([failedTarget, healthyTarget])
    const where = vi.fn(() => ({ orderBy }))
    global.WIKI.SERVERPATH = '/tmp/wiki-server'
    global.WIKI.config.dataPath = 'data'
    global.WIKI.data = {
      storage: [
        { key: 'git', props: {}, isAvailable: true, schedule: false },
        { key: 'disk', props: {}, isAvailable: true, schedule: false }
      ]
    }
    global.WIKI.models = {
      storage: class {},
      knex: vi.fn(),
      Objection: {
        transaction: {
          start: vi.fn()
        }
      }
    }
    global.WIKI.scheduler = {
      jobs: [],
      registerJob: vi.fn()
    }
    const Storage = (await vi.importFresh('../../models/storage.ts', import.meta.url)).default
    global.WIKI.models.storage = Storage
    vi.spyOn(Storage, 'query').mockReturnValue({ where })
    const failedImplementation = (await import('../../modules/storage/git/storage.ts')).default
    const failedCreated = vi.spyOn(failedImplementation, 'created')
    const failedAssetUploaded = vi.spyOn(failedImplementation, 'assetUploaded')
    const failedGetLocalLocation = vi.spyOn(failedImplementation, 'getLocalLocation')

    await Storage.initTargets()

    const page = {
      path: 'guide',
      localeCode: 'en',
      contentType: 'markdown',
      injectMetadata: () => 'healthy page'
    }
    const asset = { path: 'images/logo.txt', data: Buffer.from('healthy asset') }

    await Storage.pageEvent({ event: 'created', page })
    await Storage.assetEvent({ event: 'uploaded', asset })
    const locations = await Storage.getLocalLocations({ asset })

    expect(Storage.targets).toEqual([failedTarget, healthyTarget])
    expect(Storage.activeTargets).toEqual([healthyTarget])
    expect(failedTarget.state).toEqual({
      status: 'error',
      message: expect.any(String),
      lastAttempt: expect.any(String)
    })
    expect(failedPatch).toHaveBeenCalledTimes(1)
    expect(failedCreated).not.toHaveBeenCalled()
    expect(failedAssetUploaded).not.toHaveBeenCalled()
    expect(failedGetLocalLocation).not.toHaveBeenCalled()
    expect(await fs.readFile(path.join(rootPath, 'content', 'guide.md'), 'utf8')).toBe('healthy page')
    expect(await fs.readFile(path.join(rootPath, 'content', 'images', 'logo.txt'), 'utf8')).toBe('healthy asset')
    expect(locations).toEqual([{
      path: path.join(rootPath, 'content', 'images', 'logo.txt'),
      key: 'disk'
    }])
  })
})

describe('cloud storage export ownership', () => {
  const pageRows = [
    {
      path: 'first',
      localeCode: 'en',
      title: 'First',
      description: '',
      contentType: 'markdown',
      content: 'first',
      isPublished: true,
      updatedAt: '2026-08-30T00:00:00.000Z',
      createdAt: '2026-08-30T00:00:00.000Z',
      editorKey: 'markdown'
    },
    {
      path: 'second',
      localeCode: 'en',
      title: 'Second',
      description: '',
      contentType: 'markdown',
      content: 'second',
      isPublished: true,
      updatedAt: '2026-08-30T00:00:00.000Z',
      createdAt: '2026-08-30T00:00:00.000Z',
      editorKey: 'markdown'
    },
    {
      path: 'third',
      localeCode: 'en',
      title: 'Third',
      description: '',
      contentType: 'markdown',
      content: 'third',
      isPublished: true,
      updatedAt: '2026-08-30T00:00:00.000Z',
      createdAt: '2026-08-30T00:00:00.000Z',
      editorKey: 'markdown'
    }
  ]

  const assetRows = [
    { filename: 'first.png', folderId: null, data: Buffer.from('first') },
    { filename: 'second.png', folderId: null, data: Buffer.from('second') },
    { filename: 'third.png', folderId: null, data: Buffer.from('third') }
  ]

  const providers = [
    ['S3', async upload => {
      const S3Storage = (await vi.importFresh('../../modules/storage/s3/common.ts', import.meta.url)).default
      const storage = new S3Storage('S3')
      storage.config = { pathPrefix: '' }
      storage.bucketName = 'wiki'
      storage.s3 = { send: upload }
      return () => storage.exportAll()
    }],
    ['Azure Blob', async upload => {
      const storage = (await vi.importFresh('../../modules/storage/azure/storage.ts', import.meta.url)).default
      const context = {
        config: { pathPrefix: '', storageTier: 'Hot' },
        container: {
          getBlockBlobClient: vi.fn(() => ({ upload }))
        }
      }
      return () => storage.exportAll.call(context)
    }],
    ['SFTP', async upload => {
      const storage = (await vi.importFresh('../../modules/storage/sftp/storage.ts', import.meta.url)).default
      const context = {
        config: { basePath: '/wiki' },
        ensureDirectory: vi.fn().mockResolvedValue(undefined),
        sftp: { writeFile: upload }
      }
      return () => storage.exportAll.call(context)
    }]
  ]

  it.each(providers)('%s stops the export and destroys its source after the second write rejects', async (_name, loadProvider) => {
    vi.resetModules()
    const source = Readable.from(pageRows)
    const query = {
      column: vi.fn(function () { return this }),
      select: vi.fn(function () { return this }),
      from: vi.fn(function () { return this }),
      where: vi.fn(function () { return this }),
      stream: vi.fn(() => source)
    }
    global.WIKI = {
      ROOTPATH: '/tmp/wiki',
      config: {
        dataPath: 'data',
        lang: {
          code: 'en',
          namespacing: false
        }
      },
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn()
      },
      models: {
        knex: query,
        assetFolders: {
          getAllPaths: vi.fn()
        }
      }
    }
    const failure = new Error('second write failed')
    const upload = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined)
    const exportAll = await loadProvider(upload)

    await expect(exportAll()).rejects.toBe(failure)

    expect(upload).toHaveBeenCalledTimes(2)
    expect(source.destroyed).toBe(true)
    expect(global.WIKI.models.assetFolders.getAllPaths).not.toHaveBeenCalled()
  })

  it.each(providers)('%s stops the asset export and destroys its source after the second write rejects', async (_name, loadProvider) => {
    vi.resetModules()
    const pageSource = Readable.from([])
    const assetSource = Readable.from(assetRows)
    const query = {
      column: vi.fn(function () { return this }),
      select: vi.fn(function () { return this }),
      from: vi.fn(function () { return this }),
      where: vi.fn(function () { return this }),
      join: vi.fn(function () { return this }),
      stream: vi.fn()
        .mockReturnValueOnce(pageSource)
        .mockReturnValueOnce(assetSource)
    }
    global.WIKI = {
      ROOTPATH: '/tmp/wiki',
      config: {
        dataPath: 'data',
        lang: {
          code: 'en',
          namespacing: false
        }
      },
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn()
      },
      models: {
        knex: query,
        assetFolders: {
          getAllPaths: vi.fn().mockResolvedValue({})
        }
      }
    }
    const failure = new Error('second asset write failed')
    const upload = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined)
    const exportAll = await loadProvider(upload)

    await expect(exportAll()).rejects.toBe(failure)

    expect(upload).toHaveBeenCalledTimes(2)
    expect(assetSource.destroyed).toBe(true)
  })
})

describe('SFTP page rename namespacing', () => {
  it.each([
    ['en', 'en', '/wiki/guide.md', '/wiki/moved.md'],
    ['fr', 'fr', '/wiki/fr/guide.md', '/wiki/fr/moved.md'],
    ['en', 'fr', '/wiki/guide.md', '/wiki/fr/moved.md'],
    ['fr', 'en', '/wiki/fr/guide.md', '/wiki/moved.md']
  ])('%s to %s uses the same paths as page writes', async (localeCode, destinationLocaleCode, sourceKey, destinationKey) => {
    vi.resetModules()
    global.WIKI = {
      config: {
        lang: {
          code: 'en',
          namespacing: true
        }
      },
      logger: {
        info: vi.fn()
      }
    }
    const storage = (await vi.importFresh('../../modules/storage/sftp/storage.ts', import.meta.url)).default
    const writeFile = vi.fn().mockResolvedValue(undefined)
    const rename = vi.fn().mockResolvedValue(undefined)
    const context = {
      config: { basePath: '/wiki' },
      ensureDirectory: vi.fn().mockResolvedValue(undefined),
      sftp: { rename, writeFile }
    }
    const page = {
      path: 'guide',
      destinationPath: 'moved',
      localeCode,
      destinationLocaleCode,
      contentType: 'markdown',
      injectMetadata: () => 'content'
    }

    await storage.created.call(context, page)
    await storage.created.call(context, {
      ...page,
      path: page.destinationPath,
      localeCode: page.destinationLocaleCode
    })
    const sourceWritePath = writeFile.mock.calls[0][0]
    const destinationWritePath = writeFile.mock.calls[1][0]
    await storage.renamed.call(context, page)

    expect([sourceWritePath, destinationWritePath]).toEqual([sourceKey, destinationKey])
    expect(rename).toHaveBeenCalledWith(sourceWritePath, destinationWritePath)
  })
})

describe('Git storage rename identities', () => {
  let rootPath

  beforeEach(async () => {
    vi.resetModules()
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-git-'))
    global.WIKI = {
      ROOTPATH: rootPath,
      config: {
        dataPath: 'data',
        lang: {
          code: 'en',
          namespacing: true
        }
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn()
      },
      models: {}
    }
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await fs.rm(rootPath, { recursive: true, force: true })
  })

  it('moves a cross-locale page to the destination locale without retaining the source identity', async () => {
    const filePath = path.join(rootPath, 'fr', 'guide.md')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, 'content')
    const identities = new Set(['en/guide'])
    const movePage = vi.fn(async move => {
      identities.delete(`${move.locale}/${move.path}`)
      identities.add(`${move.destinationLocale}/${move.destinationPath}`)
    })
    global.WIKI.models.pages = { movePage }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default
    vi.spyOn(commonDisk, 'processPage').mockResolvedValue(undefined)
    const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default

    await storage.processFiles.call({}, [{
      file: { path: filePath, stats: { size: 7 } },
      oldPath: 'en/guide.md',
      relPath: 'fr/guide.md',
      binary: false,
      insertions: 0,
      deletions: 0,
      before: 0,
      after: 0,
      importAll: false
    }], { id: 1 })

    expect(movePage).toHaveBeenCalledWith(expect.objectContaining({
      path: 'guide',
      destinationPath: 'guide',
      locale: 'en',
      destinationLocale: 'fr',
      skipStorage: true
    }))
    expect([...identities]).toEqual(['fr/guide'])
  })

  it('finds an asset by its old path and repoints its readable identity and cache', async () => {
    const filePath = path.join(rootPath, 'archive', 'new-logo.png')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, 'image')
    const assetHelper = (await vi.importFresh('../../helpers/asset.ts', import.meta.url)).default
    const sourceHash = assetHelper.generateHash('images/logo.png')
    const destinationHash = assetHelper.generateHash('archive/new-logo.png')
    const deleteAssetCache = vi.fn().mockResolvedValue(undefined)
    const asset = { id: 7, hash: sourceHash, deleteAssetCache }
    const persisted = { id: 7, filename: 'logo.png', folderId: 2, hash: sourceHash }
    const findOne = vi.fn(({ hash }) => Promise.resolve(hash === persisted.hash ? asset : undefined))
    const findById = vi.fn(async id => {
      expect(id).toBe(asset.id)
      return 1
    })
    const patch = vi.fn(values => {
      Object.assign(persisted, values)
      return { findById }
    })
    global.WIKI.models.assets = {
      query: vi.fn(() => ({ findOne, patch }))
    }
    global.WIKI.models.assetFolders = {
      getAllPaths: vi.fn().mockResolvedValue({ 4: 'archive' }),
      query: vi.fn()
    }
    const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default

    await storage.processFiles.call({}, [{
      file: { path: filePath, stats: { size: 5 } },
      oldPath: 'images/logo.png',
      relPath: 'archive/new-logo.png',
      binary: true,
      insertions: 0,
      deletions: 0,
      before: 1,
      after: 1,
      importAll: false
    }], { id: 1 })

    expect(findOne).toHaveBeenCalledWith({ hash: sourceHash })
    expect(persisted).toEqual({
      id: 7,
      filename: 'new-logo.png',
      folderId: 4,
      hash: destinationHash
    })
    expect(await findOne({ hash: sourceHash })).toBeUndefined()
    expect(await findOne({ hash: destinationHash })).toBe(asset)
    expect(deleteAssetCache).toHaveBeenCalledTimes(1)
  })
})
