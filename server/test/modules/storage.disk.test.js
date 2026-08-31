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
    }))).rejects.toThrow('Storage path escapes the configured root: en/../../escape.md')
  })

  it('uses canonical OKF paths for every Markdown event when locale namespacing is disabled', async () => {
    const page = {
      path: 'index',
      localeCode: 'en',
      title: 'Index',
      description: '',
      contentType: 'markdown',
      content: 'See [self](/en/index).',
      sourceRevision: 1,
      authorId: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: {},
      isPublished: true,
      editorKey: 'markdown',
      tags: []
    }
    const indexFile = path.join(rootPath, 'content', 'en', 'index.concept.md')
    const logFile = path.join(rootPath, 'content', 'en', 'log.concept.md')

    await plugin.created.call(context, page)
    expect(await fs.readFile(indexFile, 'utf8')).toContain('[self](/en/index.concept.md)')

    await plugin.updated.call(context, { ...page, content: 'Updated', sourceRevision: 2 })
    expect(await fs.readFile(indexFile, 'utf8')).toContain('Updated')

    await plugin.renamed.call(context, {
      ...page,
      destinationPath: 'log',
      destinationLocaleCode: 'en'
    })
    await expect(fs.readFile(indexFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(logFile, 'utf8')).toContain('Updated')

    await plugin.deleted.call(context, { ...page, path: 'log' })
    await expect(fs.readFile(logFile)).rejects.toMatchObject({ code: 'ENOENT' })
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
      id: 7,
      path: 'guide',
      localeCode: 'en',
      title: 'Healthy',
      description: '',
      contentType: 'markdown',
      content: 'healthy page',
      sourceRevision: '1',
      authorId: 7,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: { okf: { type: 'Reference', status: 'stable' } },
      isPublished: true,
      editorKey: 'markdown',
      tags: []
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
    expect(await fs.readFile(path.join(rootPath, 'content', 'en', 'guide.md'), 'utf8')).toContain('source_revision: \'1\'')
    expect(await fs.readFile(path.join(rootPath, 'content', 'images', 'logo.txt'), 'utf8')).toBe('healthy asset')
    expect(locations).toEqual([{
      path: path.join(rootPath, 'content', 'images', 'logo.txt'),
      key: 'disk'
    }])
  })

  it('serializes event and bulk Markdown exports byte-identically with authoritative OKF metadata', async () => {
    const page = {
      id: 8,
      path: 'round-trip',
      localeCode: 'en',
      title: 'Round trip',
      description: 'Stored description',
      contentType: 'markdown',
      content: 'See [next](/en/next).',
      sourceRevision: 42,
      authorId: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: {
        okf: {
          type: 'Procedure',
          status: 'stable',
          verified: { by: 'human:9', at: '2026-08-30T00:00:00Z' },
          vendor_extension: { retained: true }
        }
      },
      isPublished: true,
      editorKey: 'markdown',
      tags: [{ tag: 'one' }]
    }

    await plugin.created.call(context, page)
    const eventBytes = await fs.readFile(path.join(rootPath, 'content', 'en', 'round-trip.md'))

    const pageSource = Readable.from([{
      id: page.id,
      path: page.path,
      localeCode: page.localeCode,
      title: page.title,
      description: page.description,
      contentType: page.contentType,
      content: page.content,
      sourceRevision: page.sourceRevision,
      authorId: page.authorId,
      extra: page.extra,
      isPublished: page.isPublished,
      updatedAt: page.updatedAt,
      createdAt: page.createdAt,
      editorKey: page.editorKey
    }])
    const query = {
      column: vi.fn(function () { return this }),
      select: vi.fn(function () { return this }),
      from: vi.fn(function () { return this }),
      where: vi.fn(function () { return this }),
      join: vi.fn(function () { return this }),
      stream: vi.fn()
        .mockReturnValueOnce(pageSource)
        .mockReturnValueOnce(Readable.from([]))
    }
    global.WIKI.models.knex = query
    global.WIKI.models.pages = {
      query: vi.fn(() => ({
        findOne: vi.fn().mockResolvedValue({
          $relatedQuery: vi.fn().mockResolvedValue([{ tag: 'one' }])
        })
      }))
    }
    global.WIKI.models.assetFolders = { getAllPaths: vi.fn().mockResolvedValue({}) }

    await plugin.dump.call(context)
    const bulkBytes = await fs.readFile(path.join(rootPath, 'content', 'en', 'round-trip.md'))
    expect(bulkBytes).toEqual(eventBytes)

    const codec = (await vi.importFresh('../../modules/storage/page-document.ts', import.meta.url)).default
    const parsed = codec({
      rawDocument: eventBytes,
      contentType: 'markdown',
      locale: 'en',
      pagePath: 'round-trip',
      importer: 'import:disk'
    })
    expect(parsed.okfMetadata).toMatchObject({
      type: 'Procedure',
      verified: { by: 'human:9', at: '2026-08-30T00:00:00Z' },
      vendor_extension: { retained: true },
      'x-wiki': {
        published: true,
        editor: 'markdown',
        source_revision: '42',
        created_at: '2026-08-29T00:00:00.000Z',
        updated_at: '2026-08-30T00:00:00.000Z'
      }
    })
  })

  it('serializes Markdown with compatibility metadata when extra.okf is absent', async () => {
    await plugin.created.call(context, {
      path: 'compatibility',
      localeCode: 'en',
      title: 'Compatibility',
      description: '',
      contentType: 'markdown',
      content: 'Compatibility body',
      sourceRevision: 9007199254740993n,
      authorId: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: {},
      isPublished: true,
      editorKey: 'markdown',
      tags: []
    })

    const source = await fs.readFile(path.join(rootPath, 'content', 'en', 'compatibility.md'))
    const codec = (await vi.importFresh('../../modules/storage/page-document.ts', import.meta.url)).default
    const parsed = codec({
      rawDocument: source,
      contentType: 'markdown',
      locale: 'en',
      pagePath: 'compatibility',
      importer: 'import:disk'
    })
    expect(parsed.okfMetadata).toMatchObject({
      type: 'Reference',
      status: 'stable',
      'x-wiki': {
        source_revision: '9007199254740993'
      }
    })
    expect(parsed.okfMetadata).not.toHaveProperty('generated')
  })

  it('rejects an existing invalid extra.okf claim instead of exporting compatibility metadata', async () => {
    const filePath = path.join(rootPath, 'content', 'en', 'invalid-okf.md')
    await expect(plugin.created.call(context, {
      path: 'invalid-okf',
      localeCode: 'en',
      title: 'Invalid OKF',
      description: '',
      contentType: 'markdown',
      content: 'Must not be exported',
      sourceRevision: 1,
      authorId: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: { okf: null },
      isPublished: true,
      editorKey: 'markdown',
      tags: []
    })).rejects.toThrow('Storage page extra.okf must contain valid OKF metadata')
    await expect(fs.readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects non-string Markdown content before export', async () => {
    await expect(plugin.created.call(context, {
      path: 'invalid-content',
      localeCode: 'en',
      title: 'Invalid content',
      description: '',
      contentType: 'markdown',
      content: { blocks: [] },
      sourceRevision: 1,
      authorId: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: {},
      isPublished: true,
      editorKey: 'markdown',
      tags: []
    })).rejects.toThrow('Markdown storage content must be a string')
  })

  it('keeps non-Markdown event serialization unchanged', async () => {
    await plugin.created.call(context, {
      path: 'legacy',
      localeCode: 'en',
      title: 'Legacy',
      description: 'Description',
      contentType: 'html',
      content: '<p>Body</p>',
      sourceRevision: 1,
      authorId: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: {},
      isPublished: true,
      editorKey: 'html',
      tags: [{ tag: 'one' }]
    })
    expect(await fs.readFile(path.join(rootPath, 'content', 'legacy.html'), 'utf8')).toBe([
      '<!--',
      'title: Legacy',
      'description: Description',
      'published: true',
      'date: 2026-08-30T00:00:00.000Z',
      'tags: one',
      'editor: html',
      'dateCreated: 2026-08-29T00:00:00.000Z',
      '-->',
      '',
      '<p>Body</p>'
    ].join('\n'))
  })
  it('imports regular files but does not follow file or directory symlinks outside the storage root', async () => {
    const scanRoot = path.join(rootPath, 'content')
    const outsideRoot = path.join(rootPath, 'outside')
    await fs.mkdir(path.join(outsideRoot, 'nested'), { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(scanRoot, 'inside-page.md'), 'Inside page'),
      fs.writeFile(path.join(scanRoot, 'inside-asset.bin'), 'Inside asset'),
      fs.writeFile(path.join(outsideRoot, 'secret-page.md'), 'Outside page'),
      fs.writeFile(path.join(outsideRoot, 'nested', 'secret-asset.bin'), 'Outside asset')
    ])
    await fs.symlink(path.join(outsideRoot, 'secret-page.md'), path.join(scanRoot, 'linked-page.md'), 'file')
    await fs.symlink(path.join(outsideRoot, 'nested'), path.join(scanRoot, 'linked-directory'), 'dir')

    global.WIKI.models.users = {
      getRootUser: vi.fn().mockResolvedValue({ id: 1 })
    }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default
    const processPage = vi.spyOn(commonDisk, 'processPage').mockResolvedValue({
      relPath: 'inside-page.md',
      format: 'plain_markdown',
      sha256: 'inside',
      ok: true,
      document: {}
    })
    const processAsset = vi.spyOn(commonDisk, 'processAsset').mockResolvedValue()

    const results = await commonDisk.importFromDisk({
      fullPath: scanRoot,
      moduleName: 'DISK'
    })

    expect(processPage).toHaveBeenCalledTimes(1)
    expect(processPage).toHaveBeenCalledWith(expect.objectContaining({
      relPath: 'inside-page.md',
      fullPath: scanRoot,
      moduleName: 'DISK'
    }))
    expect(processAsset).toHaveBeenCalledTimes(1)
    expect(processAsset).toHaveBeenCalledWith(expect.objectContaining({
      relPath: 'inside-asset.bin',
      moduleName: 'DISK'
    }))
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'page', relPath: 'inside-page.md', ok: true }),
      { kind: 'asset', relPath: 'inside-asset.bin', ok: true }
    ]))
  })

})

describe('cloud storage export ownership', () => {
  const pageRows = [
    {
      id: 1,
      path: 'first',
      localeCode: 'en',
      title: 'First',
      description: '',
      contentType: 'markdown',
      content: 'first',
      sourceRevision: 101,
      authorId: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: { okf: { type: 'Reference', status: 'stable' } },
      isPublished: true,
      editorKey: 'markdown'
    },
    {
      id: 2,
      path: 'second',
      localeCode: 'en',
      title: 'Second',
      description: '',
      contentType: 'markdown',
      content: 'second',
      sourceRevision: 102,
      authorId: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: { okf: { type: 'Reference', status: 'stable' } },
      isPublished: true,
      editorKey: 'markdown'
    },
    {
      id: 3,
      path: 'third',
      localeCode: 'en',
      title: 'Third',
      description: '',
      contentType: 'markdown',
      content: 'third',
      sourceRevision: 103,
      authorId: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: { okf: { type: 'Reference', status: 'stable' } },
      isPublished: true,
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
        },
        pages: {
          query: vi.fn(() => ({
            findOne: vi.fn(({ id }) => ({
              $relatedQuery: vi.fn().mockResolvedValue([{ tag: `page-${id}` }])
            }))
          }))
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
    ['en', 'en', '/wiki/en/guide.md', '/wiki/en/moved.md'],
    ['fr', 'fr', '/wiki/fr/guide.md', '/wiki/fr/moved.md'],
    ['en', 'fr', '/wiki/en/guide.md', '/wiki/fr/moved.md'],
    ['fr', 'en', '/wiki/fr/guide.md', '/wiki/en/moved.md']
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
      id: 7,
      path: 'guide',
      destinationPath: 'moved',
      localeCode,
      destinationLocaleCode,
      title: 'Guide',
      description: '',
      contentType: 'markdown',
      content: 'content',
      sourceRevision: 42,
      authorId: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: { okf: { type: 'Reference', status: 'stable' } },
      isPublished: true,
      editorKey: 'markdown',
      tags: [{ tag: 'guide' }],
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
      okfProducer: 'import:git',
      skipStorage: true
    }))
    expect([...identities]).toEqual(['fr/guide'])
  })

  it('imports canonical reserved changed files under their page identities and Git provenance', async () => {
    const document = '---\ntype: Reference\nverified:\n  by: human:99\n  at: 2026-08-30T00:00:00Z\n---\n\nChanged'
    const indexFilePath = path.join(rootPath, 'en', 'index.concept.md')
    const logFilePath = path.join(rootPath, 'en', 'log.concept.md')
    await fs.mkdir(path.dirname(indexFilePath), { recursive: true })
    await fs.writeFile(indexFilePath, document)
    await fs.writeFile(logFilePath, document)
    const createPage = vi.fn().mockResolvedValue({ id: 1 })
    const updatePage = vi.fn().mockResolvedValue({ id: 2 })
    const getPageFromDb = vi.fn(({ path: pagePath }) => Promise.resolve(pagePath === 'log'
      ? { id: 2, title: 'Log', description: '', isPublished: true, tags: [] }
      : null))
    global.WIKI.models.pages = { createPage, getPageFromDb, updatePage }
    global.WIKI.models.editors = {
      getDefaultEditor: vi.fn().mockResolvedValue('markdown')
    }
    const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default

    const results = await storage.processFiles.call({ repoPath: rootPath }, [
      {
        file: { path: indexFilePath, stats: { size: document.length } },
        oldPath: 'en/index.concept.md',
        relPath: 'en/index.concept.md',
        binary: false,
        insertions: 1,
        deletions: 0,
        before: 0,
        after: 0,
        importAll: false
      },
      {
        file: { path: logFilePath, stats: { size: document.length } },
        oldPath: 'en/log.concept.md',
        relPath: 'en/log.concept.md',
        binary: false,
        insertions: 1,
        deletions: 1,
        before: 0,
        after: 0,
        importAll: false
      }
    ], { id: 7 })
    expect(results).toEqual([
      expect.objectContaining({ kind: 'page', relPath: 'en/index.concept.md', ok: true }),
      expect.objectContaining({ kind: 'page', relPath: 'en/log.concept.md', ok: true })
    ])

    expect(getPageFromDb).toHaveBeenCalledWith({ path: 'index', locale: 'en' })
    expect(getPageFromDb).toHaveBeenCalledWith({ path: 'log', locale: 'en' })
    expect(createPage).toHaveBeenCalledWith(expect.objectContaining({
      path: 'index',
      locale: 'en',
      okfProducer: 'import:git',
      skipStorage: true
    }))
    expect(updatePage).toHaveBeenCalledWith(expect.objectContaining({
      id: 2,
      okfProducer: 'import:git',
      skipStorage: true
    }))
  })

  it('maps both sides of canonical reserved renames and canonical deletes to page identities', async () => {
    const filePath = path.join(rootPath, 'en', 'log.concept.md')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, 'content')
    const movePage = vi.fn().mockResolvedValue(undefined)
    const deletePage = vi.fn().mockResolvedValue(undefined)
    global.WIKI.models.pages = { movePage, deletePage }
    const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default
    const user = { id: 1 }

    await storage.processFiles.call({}, [{
      file: { path: filePath, stats: { size: 7 } },
      oldPath: 'en/index.concept.md',
      relPath: 'en/log.concept.md',
      binary: false,
      insertions: 0,
      deletions: 0,
      before: 0,
      after: 0,
      importAll: false
    }], user)
    await fs.rm(filePath)
    await storage.processFiles.call({}, [{
      file: { path: filePath, stats: { size: 0 } },
      oldPath: 'en/log.concept.md',
      relPath: 'en/log.concept.md',
      binary: false,
      insertions: 0,
      deletions: 1,
      before: 0,
      after: 0,
      importAll: false
    }], user)

    expect(movePage).toHaveBeenCalledWith({
      user,
      path: 'index',
      destinationPath: 'log',
      locale: 'en',
      destinationLocale: 'en',
      okfProducer: 'import:git',
      skipStorage: true
    })
    expect(deletePage).toHaveBeenCalledWith({
      user,
      path: 'log',
      locale: 'en',
      skipStorage: true
    })
  })

  it('does not import a symlink from the Git repository walker', async () => {
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-git-external-'))
    try {
      const externalFile = path.join(externalRoot, 'outside.md')
      const linkPath = path.join(rootPath, 'en', 'outside.md')
      await fs.writeFile(externalFile, '# Outside')
      await fs.mkdir(path.dirname(linkPath), { recursive: true })
      await fs.symlink(externalFile, linkPath)
      global.WIKI.models.users = {
        getRootUser: vi.fn().mockResolvedValue({ id: 1 })
      }
      const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default
      const processFiles = vi.fn().mockResolvedValue([])

      const results = await storage.importAll.call({ repoPath: rootPath, processFiles })

      expect(results).toEqual([])
      expect(processFiles).not.toHaveBeenCalled()
    } finally {
      await fs.rm(externalRoot, { recursive: true, force: true })
    }
  })

  it('commits canonical Markdown paths for the full page lifecycle while preserving legacy non-Markdown paths', async () => {
    global.WIKI.config.lang.namespacing = false
    const { simpleGit } = await import('simple-git')
    const git = simpleGit(rootPath)
    await git.init()
    await git.addConfig('user.name', 'Wiki Test')
    await git.addConfig('user.email', 'wiki@example.test')
    const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default
    const context = {
      config: { alwaysNamespace: false },
      git,
      repoPath: rootPath
    }
    const page = {
      id: 1,
      path: 'log',
      localeCode: 'en',
      title: 'Log',
      description: '',
      contentType: 'markdown',
      content: 'Log content',
      sourceRevision: 1,
      authorId: 1,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: {},
      isPublished: true,
      editorKey: 'markdown',
      tags: [],
      authorName: 'Wiki Test',
      authorEmail: 'wiki@example.test',
      moveAuthorName: 'Wiki Test',
      moveAuthorEmail: 'wiki@example.test'
    }

    await storage.created.call(context, page)
    await storage.created.call(context, {
      ...page,
      id: 2,
      path: 'index',
      title: 'Index',
      content: '[Log](/en/log)',
      sourceRevision: 2
    })

    const indexPath = path.join(rootPath, 'en', 'index.concept.md')
    const indexDocument = await fs.readFile(indexPath, 'utf8')
    expect(indexDocument).toContain('](/en/log.concept.md)')
    await fs.access(path.join(rootPath, 'en', 'log.concept.md'))
    expect(await git.raw(['ls-tree', '-r', '--name-only', 'HEAD'])).toContain('en/index.concept.md')
    expect(await git.raw(['ls-tree', '-r', '--name-only', 'HEAD'])).toContain('en/log.concept.md')

    await storage.updated.call(context, {
      ...page,
      id: 2,
      path: 'index',
      title: 'Index',
      content: 'Updated [Log](/en/log)',
      sourceRevision: 3
    })
    expect((await git.log({ maxCount: 1 })).latest?.message).toBe('docs: update en/index.concept.md')

    const renamedPage = {
      ...page,
      destinationPath: 'log',
      destinationLocaleCode: 'fr'
    }
    await storage.renamed.call(context, renamedPage)
    await expect(fs.access(path.join(rootPath, 'en', 'log.concept.md'))).rejects.toThrow()
    await fs.access(path.join(rootPath, 'fr', 'log.concept.md'))
    expect((await git.log({ maxCount: 1 })).latest?.message).toBe('docs: rename en/log.concept.md to fr/log.concept.md')

    await storage.deleted.call(context, {
      ...page,
      localeCode: 'fr'
    })
    await expect(fs.access(path.join(rootPath, 'fr', 'log.concept.md'))).rejects.toThrow()
    expect((await git.log({ maxCount: 1 })).latest?.message).toBe('docs: delete fr/log.concept.md')

    await storage.created.call(context, {
      ...page,
      id: 3,
      path: 'legacy',
      title: 'Legacy',
      contentType: 'html',
      content: '<p>Legacy</p>',
      editorKey: 'html'
    })
    await fs.access(path.join(rootPath, 'legacy.html'))
    await expect(fs.access(path.join(rootPath, 'en', 'legacy.html'))).rejects.toThrow()
    expect((await git.log({ maxCount: 1 })).latest?.message).toBe('docs: create legacy')
    expect(global.WIKI.logger.info).toHaveBeenCalledWith('(STORAGE/GIT) Committing new file en/index.concept.md...')
    expect(global.WIKI.logger.info).toHaveBeenCalledWith('(STORAGE/GIT) Committing file move from en/log.concept.md to fr/log.concept.md...')
  })

  it('uses canonical Markdown paths and legacy non-Markdown paths during bulk export', async () => {
    global.WIKI.config.lang.namespacing = false
    const pages = [
      {
        id: 1,
        path: 'index',
        localeCode: 'en',
        title: 'Index',
        description: '',
        contentType: 'markdown',
        content: 'Index content',
        sourceRevision: 1,
        authorId: 1,
        createdAt: '2026-08-29T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
        extra: {},
        isPublished: true,
        editorKey: 'markdown'
      },
      {
        id: 2,
        path: 'legacy',
        localeCode: 'en',
        title: 'Legacy',
        description: '',
        contentType: 'html',
        content: '<p>Legacy</p>',
        sourceRevision: 1,
        authorId: 1,
        createdAt: '2026-08-29T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
        extra: {},
        isPublished: true,
        editorKey: 'html'
      }
    ]
    let streamIndex = 0
    global.WIKI.models.knex = {
      column: vi.fn(() => {
        const rows = streamIndex++ === 0 ? pages : []
        const builder = {
          select: vi.fn(() => builder),
          from: vi.fn(() => builder),
          where: vi.fn(() => builder),
          join: vi.fn(() => builder),
          stream: vi.fn(() => Readable.from(rows))
        }
        return builder
      })
    }
    global.WIKI.models.pages = {
      query: vi.fn(() => ({
        findOne: vi.fn(({ id }) => Promise.resolve({
          id,
          $relatedQuery: vi.fn(() => Promise.resolve([]))
        }))
      }))
    }
    global.WIKI.models.assetFolders = {
      getAllPaths: vi.fn(() => Promise.resolve({}))
    }
    const git = {
      add: vi.fn(() => Promise.resolve()),
      commit: vi.fn(() => Promise.resolve())
    }
    const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default

    await storage.syncUntracked.call({
      config: { alwaysNamespace: false },
      git,
      repoPath: rootPath
    })

    await fs.access(path.join(rootPath, 'en', 'index.concept.md'))
    await fs.access(path.join(rootPath, 'legacy.html'))
    expect(git.add).toHaveBeenCalledWith('./en/index.concept.md')
    expect(git.add).toHaveBeenCalledWith('./legacy.html')
    expect(global.WIKI.logger.info).toHaveBeenCalledWith('(STORAGE/GIT) Adding page en/index.concept.md...')
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

describe('storage page-document ingress', () => {
  let rootPath
  let previousWiki
  let hadPreviousWiki

  beforeEach(async () => {
    rootPath = undefined
    hadPreviousWiki = Object.hasOwn(global, 'WIKI')
    previousWiki = global.WIKI
    vi.resetModules()
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-document-'))
    global.WIKI = {
      ROOTPATH: rootPath,
      config: { lang: { code: 'en', namespacing: false } },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      models: {}
    }
  })

  afterEach(async () => {
    try {
      if (rootPath !== undefined) {
        await fs.rm(rootPath, { recursive: true, force: true })
      }
    } finally {
      if (hadPreviousWiki) {
        global.WIKI = previousWiki
      } else {
        delete global.WIKI
      }
      rootPath = undefined
    }
  })

  const input = {
    contentType: 'markdown',
    locale: 'en',
    pagePath: 'guides/start',
    importer: 'import:disk',
    now: new Date('2026-08-31T00:00:00.000Z')
  }

  it('classifies valid OKF, imports links, and preserves extensions and source hash', async () => {
    vi.resetModules()
    const codec = (await vi.importFresh('../../modules/storage/page-document.ts', import.meta.url)).default
    const raw = [
      '---',
      'type: Procedure',
      'tags: [one, two]',
      'verified:',
      '  by: human:7',
      '  at: 2026-08-30T00:00:00Z',
      'vendor_extension:',
      '  retained: true',
      '---',
      '',
      'See [Next](/en/next.md).'
    ].join('\n')
    const parsed = codec({ ...input, rawDocument: raw })

    expect(parsed).toMatchObject({
      format: 'okf_valid',
      body: 'See [Next](/en/next).',
      tags: ['one', 'two'],
      okfMetadata: {
        type: 'Procedure',
        verified: { by: 'human:7', at: '2026-08-30T00:00:00Z' },
        vendor_extension: { retained: true }
      },
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      diagnostics: []
    })
  })

  it.each([
    ['legacy wiki', '---\ntitle: Legacy\ntags: old, page\n---\nBody', 'legacy_wiki'],
    ['legacy v1', '<!-- TITLE: Legacy -->\n<!-- SUBTITLE: Old -->\nBody', 'legacy_v1'],
    ['plain Markdown', '# Plain\n\nBody', 'plain_markdown']
  ])('classifies %s distinctly and stamps import provenance', async (_name, raw, format) => {
    vi.resetModules()
    const codec = (await vi.importFresh('../../modules/storage/page-document.ts', import.meta.url)).default
    const parsed = codec({ ...input, rawDocument: raw })

    expect(parsed.format).toBe(format)
    expect(parsed.okfMetadata).toMatchObject({
      type: 'Reference',
      status: 'stable',
      generated: { by: 'import:disk', at: '2026-08-31T00:00:00.000Z' }
    })
  })

  it('quarantines claimed invalid OKF without returning a legacy classification', async () => {
    vi.resetModules()
    const codec = (await vi.importFresh('../../modules/storage/page-document.ts', import.meta.url)).default
    const parsed = codec({ ...input, rawDocument: '---\ntype: [broken\n---\nBody' })

    expect(parsed.format).toBe('okf_invalid')
    expect(parsed.okfMetadata).toBeNull()
    expect(parsed.diagnostics.length).toBeGreaterThan(0)
  })

  it('imports a canonical reserved index path under its original page identity without changing source bytes', async () => {
    const raw = Buffer.from('---\ntype: Reference\ntags: [source]\nverified:\n  by: human:99\n  at: 2026-08-30T00:00:00Z\nvendor: retained\n---\n\nBody')
    const filePath = path.join(rootPath, 'en', 'index.concept.md')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, raw)
    const createPage = vi.fn().mockResolvedValue({ id: 1 })
    const getPageFromDb = vi.fn().mockResolvedValue(null)
    global.WIKI.models.pages = {
      getPageFromDb,
      createPage
    }
    global.WIKI.models.editors = {
      getDefaultEditor: vi.fn().mockResolvedValue('markdown')
    }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default

    const result = await commonDisk.processPage.call({}, {
      user: { id: 7 },
      relPath: 'en/index.concept.md',
      fullPath: rootPath,
      contentType: 'markdown',
      moduleName: 'DISK'
    })

    expect(result).toMatchObject({ ok: true, format: 'okf_valid' })
    expect(getPageFromDb).toHaveBeenCalledWith({ path: 'index', locale: 'en' })
    expect(createPage).toHaveBeenCalledWith(expect.objectContaining({
      path: 'index',
      locale: 'en',
      content: 'Body',
      tags: ['source'],
      okfMetadata: {
        type: 'Reference',
        tags: ['source'],
        verified: { by: 'human:99', at: '2026-08-30T00:00:00Z' },
        vendor: 'retained'
      },
      okfProducer: 'import:disk',
      skipStorage: true
    }))
    expect(await fs.readFile(filePath)).toEqual(raw)
  })

  it('updates a canonical reserved log path under its original page identity', async () => {
    const filePath = path.join(rootPath, 'fr', 'log.concept.md')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, '---\ntype: Reference\nverified:\n  by: human:99\n  at: 2026-08-30T00:00:00Z\n---\n\nUpdated')
    const updatePage = vi.fn().mockResolvedValue({ id: 2 })
    const getPageFromDb = vi.fn().mockResolvedValue({
      id: 2,
      title: 'Existing',
      description: '',
      isPublished: true,
      tags: []
    })
    global.WIKI.models.pages = {
      getPageFromDb,
      updatePage
    }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default

    const result = await commonDisk.processPage.call({}, {
      user: { id: 7 },
      relPath: 'fr/log.concept.md',
      fullPath: rootPath,
      contentType: 'markdown',
      moduleName: 'GIT'
    })

    expect(result).toMatchObject({ ok: true, format: 'okf_valid' })
    expect(getPageFromDb).toHaveBeenCalledWith({ path: 'log', locale: 'fr' })
    expect(updatePage).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Updated',
      okfMetadata: expect.objectContaining({
        verified: { by: 'human:99', at: '2026-08-30T00:00:00Z' }
      }),
      okfProducer: 'import:git',
      skipStorage: true
    }))
  })

  it.each([
    'en/index.md',
    'index.concept.md'
  ])('rejects valid OKF from a non-canonical object path without database mutation: %s', async relPath => {
    const filePath = path.join(rootPath, relPath)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, '---\ntype: Reference\n---\n\nBody')
    const createPage = vi.fn()
    const updatePage = vi.fn()
    const getPageFromDb = vi.fn()
    global.WIKI.models.pages = { getPageFromDb, createPage, updatePage }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default

    const result = await commonDisk.processPage.call({}, {
      user: { id: 7 },
      relPath,
      fullPath: rootPath,
      contentType: 'markdown',
      moduleName: 'DISK'
    })

    expect(result).toMatchObject({
      relPath,
      format: 'okf_valid',
      ok: false,
      error: `OKF page path is not canonical: ${relPath}`
    })
    expect(getPageFromDb).not.toHaveBeenCalled()
    expect(createPage).not.toHaveBeenCalled()
    expect(updatePage).not.toHaveBeenCalled()
  })

  it.each(['DISK', 'GIT'])('rejects an oversized %s page before reading the file contents', async moduleName => {
    const filePath = path.join(rootPath, 'oversized.md')
    await fs.writeFile(filePath, '')
    await fs.truncate(filePath, 1_048_577)
    const fsExtra = (await import('fs-extra')).default
    const readFile = vi.spyOn(fsExtra, 'readFile')
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default

    await expect(commonDisk.processPage.call({}, {
      user: { id: 7 },
      relPath: 'oversized.md',
      fullPath: rootPath,
      contentType: 'markdown',
      moduleName
    })).rejects.toThrow('Page document exceeds 1048576 bytes')
    expect(readFile).not.toHaveBeenCalled()
    readFile.mockRestore()
  })

  it('does not mutate the database for a claimed invalid OKF document', async () => {
    const filePath = path.join(rootPath, 'invalid.md')
    await fs.writeFile(filePath, '---\ntype: [broken\n---\nBody')
    const createPage = vi.fn()
    const updatePage = vi.fn()
    global.WIKI.models.pages = {
      getPageFromDb: vi.fn().mockResolvedValue(null),
      createPage,
      updatePage
    }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default

    const result = await commonDisk.processPage.call({}, {
      user: { id: 7 },
      relPath: 'invalid.md',
      fullPath: rootPath,
      contentType: 'markdown',
      moduleName: 'DISK'
    })

    expect(result).toMatchObject({ ok: false, format: 'okf_invalid' })
    expect(createPage).not.toHaveBeenCalled()
    expect(updatePage).not.toHaveBeenCalled()
  })
})
