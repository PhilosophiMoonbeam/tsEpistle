import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import tar from 'tar-fs'
import moment from 'moment'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import { openStorageRoot } from '../../modules/storage/local-filesystem.ts'
describe('disk storage target', () => {
  let plugin
  let rootPath
  let context
  let hadPreviousWiki
  let previousWiki

  beforeEach(async () => {
    hadPreviousWiki = Object.hasOwn(global, 'WIKI')
    previousWiki = global.WIKI
    vi.resetModules()
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-disk-'))
    global.WIKI = {
      ROOTPATH: rootPath,
      config: {
        uploads: {
          maxFileSize: 128 * 1024 * 1024
        },
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
      ...plugin,
      config: {
        path: 'content',
        createDailyBackups: false
      },
      root: null
    }
    await plugin.init.call(context)
  })
  afterEach(async () => {
    try {
      if (context?.root) await plugin.deactivated.call(context)
      await fs.rm(rootPath, { recursive: true, force: true })
    } finally {
      if (hadPreviousWiki) {
        global.WIKI = previousWiki
      } else {
        delete global.WIKI
      }
    }
  })

  it('closes descriptor roots during reinitialization and deactivation', async () => {
    const firstRoot = context.root
    expect(firstRoot).toBeTruthy()

    await plugin.init.call(context)
    expect(firstRoot.closed).toBe(true)

    const secondRoot = context.root
    await plugin.deactivated.call(context)
    expect(secondRoot.closed).toBe(true)
    await expect(plugin.assetUploaded.call(context, {
      path: 'after-close.txt',
      data: Buffer.from('must reject')
    })).rejects.toThrow()
  })

  it('archives content beneath paths containing backup markers and excludes only root backup folders', async () => {
    const previousRoot = context.root
    await plugin.init.call(context)
    expect(previousRoot.closed).toBe(true)
    for (const name of ['read_manual.txt', 'docs/_daily/note.txt', 'docs/.git/config', '.git/config', '_daily/previous.tar.gz', '_manual/previous.tar.gz']) {
      const file = path.join(rootPath, context.config.path, name)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, name)
    }
    await plugin.sync.call(context, { manual: true })
    await plugin.sync.call(context, { manual: true })
    const folder = path.join(rootPath, context.config.path, '_manual')
    const archives = (await fs.readdir(folder)).filter(name => name.startsWith('wiki-'))
    expect(archives).toHaveLength(2)
    for (const archive of archives) {
      expect(archive.endsWith('.tar.gz')).toBe(true)
      expect((await fs.stat(path.join(folder, archive))).mode & 0o777).toBe(0o600)
      const destination = path.join(rootPath, archive)
      await pipeline(Readable.from([await fs.readFile(path.join(folder, archive))]), zlib.createGunzip(), tar.extract(destination))
      expect(await fs.readFile(path.join(destination, 'read_manual.txt'), 'utf8')).toBe('read_manual.txt')
      expect(await fs.readFile(path.join(destination, 'docs/_daily/note.txt'), 'utf8')).toBe('docs/_daily/note.txt')
      expect((await fs.readdir(destination)).sort()).toEqual(['docs', 'read_manual.txt'])
    }
  })

  it('preserves the previous daily archive and removes temporary output when the source tree is unsafe', async () => {
    context.config.createDailyBackups = true
    await plugin.assetUploaded.call(context, { path: 'page.txt', data: Buffer.from('content') })
    await plugin.sync.call(context)
    const directory = path.join(rootPath, 'content', '_daily')
    const name = `wiki-${moment().format('DD')}.tar.gz`
    const previous = await fs.readFile(path.join(directory, name))
    const outsideSentinel = path.join(rootPath, 'outside-sentinel.txt')
    await fs.writeFile(outsideSentinel, 'outside remains')
    await fs.symlink(outsideSentinel, path.join(rootPath, 'content', 'unsafe-link'))

    await expect(plugin.sync.call(context)).rejects.toThrow()

    expect(await fs.readdir(directory)).toEqual([name])
    expect(await fs.readFile(path.join(directory, name))).toEqual(previous)
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
  })

  it('streams and extracts a materially multi-chunk archive without changing file bytes', async () => {
    const contents = randomBytes(256 * 1024 + 123)
    const sourcePath = path.join(rootPath, 'content', 'multi-chunk.bin')
    await fs.writeFile(sourcePath, contents)

    await plugin.sync.call(context, { manual: true })

    const folder = path.join(rootPath, 'content', '_manual')
    const archive = (await fs.readdir(folder)).find(name => name.startsWith('wiki-'))
    expect(archive).toBeTruthy()
    const destination = path.join(rootPath, 'multi-chunk-extracted')
    await pipeline(
      Readable.from([await fs.readFile(path.join(folder, archive))]),
      zlib.createGunzip(),
      tar.extract(destination)
    )
    expect(await fs.readFile(path.join(destination, 'multi-chunk.bin'))).toEqual(contents)
  })

  it.each([
    ['entry', { maxEntries: 0 }],
    ['raw bytes', { maxRawBytes: 1 }],
    ['compressed output', { maxOutputBytes: 1 }]
  ])('preserves the previous daily archive when the %s limit is exceeded', async (_name, override) => {
    context.config.createDailyBackups = true
    await plugin.assetUploaded.call(context, { path: 'page.txt', data: Buffer.from('content') })
    await plugin.sync.call(context)
    const directory = path.join(rootPath, 'content', '_daily')
    const name = `wiki-${moment().format('DD')}.tar.gz`
    const previous = await fs.readFile(path.join(directory, name))

    context.backupLimits = { ...context.backupLimits, ...override }
    await expect(plugin.sync.call(context)).rejects.toThrow()

    expect(await fs.readdir(directory)).toEqual([name])
    expect(await fs.readFile(path.join(directory, name))).toEqual(previous)
  })

  it.each(['growth', 'substitution'])('rejects %s after a file is admitted and preserves the prior archive', async mode => {
    context.config.createDailyBackups = true
    const sourcePath = path.join(rootPath, 'content', 'mutable.bin')
    await fs.writeFile(sourcePath, randomBytes(128 * 1024 + 17))
    await plugin.sync.call(context)

    const directory = path.join(rootPath, 'content', '_daily')
    const name = `wiki-${moment().format('DD')}.tar.gz`
    const previous = await fs.readFile(path.join(directory, name))
    const originalOpenFile = context.root.openFile.bind(context.root)
    let hooked = false
    vi.spyOn(context.root, 'openFile').mockImplementation(async (relativePath, expected) => {
      const source = await originalOpenFile(relativePath, expected)
      if (relativePath !== 'mutable.bin' || hooked) return source
      hooked = true
      const originalRead = source.handle.read.bind(source.handle)
      let reads = 0
      Object.defineProperty(source.handle, 'read', {
        configurable: true,
        value: async (...args) => {
          const result = await originalRead(...args)
          if (++reads === 1) {
            if (mode === 'growth') {
              await fs.appendFile(sourcePath, Buffer.from('growth'))
            } else {
              await fs.rename(sourcePath, `${sourcePath}.original`)
              await fs.writeFile(sourcePath, Buffer.from('replacement'))
            }
          }
          return result
        }
      })
      return source
    })

    await expect(plugin.sync.call(context)).rejects.toThrow()
    expect(await fs.readdir(directory)).toEqual([name])
    expect(await fs.readFile(path.join(directory, name))).toEqual(previous)
  })

  it('atomically replaces assets inside the configured root', async () => {
    const asset = {
      id: 1,
      hash: 'asset-hash',
      path: 'images/logo.txt',
      filename: 'logo.txt',
      folderId: null,
      data: Buffer.from('first')
    }
    await plugin.assetUploaded.call(context, asset)
    await plugin.assetUploaded.call(context, { ...asset, data: Buffer.from('second') })

    const filePath = path.join(rootPath, 'content', 'images', 'logo.txt')
    expect(await fs.readFile(filePath, 'utf8')).toBe('second')
    const location = await plugin.getLocalLocation.call(context, asset)
    expect(location).toEqual({ open: expect.any(Function) })
    const source = await location.open()
    try {
      expect(source.relativePath).toBe('images/logo.txt')
      expect(Object.hasOwn(source, 'path')).toBe(false)
      expect(await source.readBounded(64)).toEqual(Buffer.from('second'))

    } finally {
      await source.close()
    }
    expect(source.closed).toBe(true)
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['logo.txt'])
  })
  it('does not expose internal Git or root backup paths through persisted identities', async () => {
    const identity = {
      id: 7,
      hash: 'persisted-hash',
      filename: 'config',
      folderId: null
    }
    for (const pathName of ['.git/config', 'docs/.git/config', '_daily/archive.tar.gz', '_manual/archive.tar.gz']) {
      await expect(plugin.getLocalLocation.call(context, { ...identity, path: pathName })).resolves.toBeUndefined()
    }
  })

  it.each([
    '../escape.txt',
    'images/../../escape.txt',
    '/tmp/wiki-storage-escape.txt'
  ])('rejects asset paths outside the configured root: %s', async assetPath => {
    const outsideSentinel = path.join(rootPath, 'outside-sentinel.txt')
    await fs.writeFile(outsideSentinel, 'outside remains')
    await expect(plugin.assetUploaded.call(context, {
      path: assetPath,
      data: Buffer.from('blocked')
    })).rejects.toMatchObject({ code: 'STORAGE_PATH_REJECTED' })
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
  })

  it('rejects page paths outside the configured root', async () => {
    const outsideSentinel = path.join(rootPath, 'outside-sentinel.txt')
    await fs.writeFile(outsideSentinel, 'outside remains')
    await expect(plugin.created.call(context, {
      path: '../../escape',
      localeCode: 'en',
      title: 'Traversal',
      description: '',
      contentType: 'markdown',
      content: 'blocked',
      sourceRevision: 1,
      authorId: 7,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      extra: {},
      isPublished: true,
      editorKey: 'markdown',
      tags: []
    })).rejects.toMatchObject({ code: 'STORAGE_PATH_REJECTED' })
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
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
    const asset = {
      id: 9,
      hash: 'healthy-asset-hash',
      path: 'images/logo.txt',
      filename: 'logo.txt',
      folderId: null,
      data: Buffer.from('healthy asset')
    }

    await Storage.pageEvent({ event: 'created', page })
    await Storage.assetEvent({ event: 'uploaded', asset })
    const locations = await Storage.getLocalLocations({ asset })

    expect(failedTarget.state).toEqual({
      status: 'error',
      message: expect.any(String),
      lastAttempt: expect.any(String)
    })
    expect(await fs.readFile(path.join(rootPath, 'content', 'en', 'guide.md'), 'utf8')).toContain('source_revision: \'1\'')
    expect(await fs.readFile(path.join(rootPath, 'content', 'images', 'logo.txt'), 'utf8')).toBe('healthy asset')
    expect(locations).toHaveLength(1)
    expect(locations[0].key).toBe('disk')
    expect(locations[0].location).toEqual({ open: expect.any(Function) })
    const source = await locations[0].location.open()
    try {
      expect(source.relativePath).toBe('images/logo.txt')
      expect(await source.readBounded(128)).toEqual(Buffer.from('healthy asset'))
    } finally {
      await source.close()
    }
    expect(source.closed).toBe(true)
    for (const target of Storage.targets ?? []) {
      if (typeof target.fn?.deactivated === 'function') await target.fn.deactivated.call(target.fn)
    }
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
    })).rejects.toThrow()
    await expect(fs.readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects non-string Markdown content before export', async () => {
    const filePath = path.join(rootPath, 'content', 'en', 'invalid-content.md')
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
    })).rejects.toThrow()
    await expect(fs.readFile(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
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
  it('imports regular files through descriptor sources and leaves outside content unchanged', async () => {
    const scanRoot = path.join(rootPath, 'content')
    const outsideRoot = path.join(rootPath, 'outside')
    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt')
    await fs.mkdir(outsideRoot, { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(scanRoot, 'inside-page.md'), 'Inside page'),
      fs.writeFile(path.join(scanRoot, 'inside-asset.bin'), 'Inside asset'),
      fs.writeFile(outsideSentinel, 'Outside content')
    ])

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
      root: context.root,
      moduleName: 'DISK'
    })

    expect(processPage).toHaveBeenCalledTimes(1)
    const pageOptions = processPage.mock.calls[0][0]
    expect(pageOptions).toMatchObject({
      relPath: 'inside-page.md',
      moduleName: 'DISK',
      root: context.root
    })
    expect(pageOptions).not.toHaveProperty('fullPath')
    expect(pageOptions.source).toMatchObject({ relativePath: 'inside-page.md', closed: true })

    expect(processAsset).toHaveBeenCalledTimes(1)
    const assetOptions = processAsset.mock.calls[0][0]
    expect(assetOptions).toMatchObject({
      relPath: 'inside-asset.bin',
      moduleName: 'DISK',
      root: context.root
    })
    expect(assetOptions).not.toHaveProperty('fullPath')
    expect(assetOptions.source).toMatchObject({ relativePath: 'inside-asset.bin', closed: true })

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'page', relPath: 'inside-page.md', ok: true }),
      { kind: 'asset', relPath: 'inside-asset.bin', ok: true }
    ]))
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('Outside content')
  })

  it('rejects an unsafe import tree as a whole before database mutation', async () => {
    const scanRoot = path.join(rootPath, 'content')
    const outsideRoot = path.join(rootPath, 'outside')
    const outsidePage = path.join(outsideRoot, 'secret-page.md')
    const outsideAsset = path.join(outsideRoot, 'secret-asset.bin')
    await fs.mkdir(outsideRoot, { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(scanRoot, 'inside-page.md'), 'Inside page'),
      fs.writeFile(path.join(scanRoot, 'inside-asset.bin'), 'Inside asset'),
      fs.writeFile(outsidePage, 'Outside page'),
      fs.writeFile(outsideAsset, 'Outside asset')
    ])
    await fs.symlink(outsidePage, path.join(scanRoot, 'linked-page.md'), 'file')
    await fs.symlink(outsideRoot, path.join(scanRoot, 'linked-directory'), 'dir')

    const getPageFromDb = vi.fn()
    const createPage = vi.fn()
    const updatePage = vi.fn()
    const upload = vi.fn()
    global.WIKI.models.users = {
      getRootUser: vi.fn().mockResolvedValue({ id: 1 })
    }
    global.WIKI.models.pages = { getPageFromDb, createPage, updatePage }
    global.WIKI.models.assets = { upload }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default

    await expect(commonDisk.importFromDisk({
      root: context.root,
      moduleName: 'DISK'
    })).rejects.toThrow()

    expect(getPageFromDb).not.toHaveBeenCalled()
    expect(createPage).not.toHaveBeenCalled()
    expect(updatePage).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
    expect(await fs.readFile(outsidePage, 'utf8')).toBe('Outside page')
    expect(await fs.readFile(outsideAsset, 'utf8')).toBe('Outside asset')
  })
  it('rejects symlink parents and nonregular import sources', async () => {
    const scanRoot = path.join(rootPath, 'content')
    const outsideRoot = path.join(rootPath, 'outside')
    const parentLink = path.join(scanRoot, 'linked')
    const fifoPath = path.join(scanRoot, 'fifo.md')
    const directoryPath = path.join(scanRoot, 'directory.md')
    const outsideSentinel = path.join(outsideRoot, 'nested', 'outside.md')
    await fs.mkdir(path.dirname(outsideSentinel), { recursive: true })
    await fs.writeFile(outsideSentinel, '# Outside')
    await fs.symlink(path.join(outsideRoot, 'nested'), parentLink, 'dir')
    execFileSync('mkfifo', [fifoPath])
    await fs.mkdir(directoryPath)

    global.WIKI.models.pages = {
      getPageFromDb: vi.fn(),
      createPage: vi.fn(),
      updatePage: vi.fn()
    }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default
    const source = {
      user: { id: 1 },
      root: context.root,
      contentType: 'markdown',
      moduleName: 'DISK'
    }

    await expect(commonDisk.processPage.call({}, { ...source, relPath: 'linked/outside.md' })).rejects.toThrow()
    await expect(commonDisk.processPage.call({}, { ...source, relPath: 'fifo.md' })).rejects.toThrow()
    await expect(commonDisk.processPage.call({}, { ...source, relPath: 'directory.md' })).rejects.toThrow()
    expect(global.WIKI.models.pages.getPageFromDb).not.toHaveBeenCalled()
    expect(global.WIKI.models.pages.createPage).not.toHaveBeenCalled()
    expect(global.WIKI.models.pages.updatePage).not.toHaveBeenCalled()
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('# Outside')
  })
  it('stages regular assets through a private descriptor copy before upload', async () => {
    const scanRoot = path.join(rootPath, 'content')
    const sourcePath = path.join(scanRoot, 'asset.bin')
    const outsideSentinel = path.join(rootPath, 'outside-sentinel.txt')
    await fs.writeFile(sourcePath, 'asset bytes')
    await fs.writeFile(outsideSentinel, 'outside remains')
    const upload = vi.fn(async options => {
      expect(options.path).not.toBe(sourcePath)
      expect((await fs.stat(options.path)).mode & 0o777).toBe(0o600)
      expect(await fs.readFile(options.path, 'utf8')).toBe('asset bytes')
    })
    global.WIKI.models.assetFolders = {
      getAllPaths: vi.fn().mockResolvedValue({})
    }
    global.WIKI.models.assets = { upload }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default
    const source = await context.root.openFile('asset.bin', { size: 11 })

    try {
      await commonDisk.processAsset.call({ assetFolders: null, resolveAssetFolder: commonDisk.resolveAssetFolder }, {
        user: { id: 1 },
        root: context.root,
        relPath: 'asset.bin',
        file: { relPath: 'asset.bin', stats: { size: 11 } },
        moduleName: 'DISK',
        source
      })
    } finally {
      await source.close()
    }

    const stagedPath = upload.mock.calls[0][0].path
    await expect(fs.access(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(source.closed).toBe(true)
    expect(await fs.readFile(sourcePath, 'utf8')).toBe('asset bytes')
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
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
  })
})

describe('Git storage rename identities', () => {
  let rootPath
  let root
  let hadPreviousWiki
  let previousWiki

  beforeEach(async () => {
    hadPreviousWiki = Object.hasOwn(global, 'WIKI')
    previousWiki = global.WIKI
    vi.resetModules()
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-git-'))
    global.WIKI = {
      ROOTPATH: rootPath,
      config: {
        dataPath: 'data',
        uploads: {
          maxFileSize: 128 * 1024 * 1024
        },
        lang: {
          code: 'en',
          namespacing: true
        }
      },
      logger: {
        error: vi.fn(),
        info: vi.fn(),
        warn: vi.fn()
      },
      models: {}
    }
    root = await openStorageRoot(rootPath)
  })

  afterEach(async () => {
    try {
      await root?.close()
      await fs.rm(rootPath, { recursive: true, force: true })
    } finally {
      if (hadPreviousWiki) {
        global.WIKI = previousWiki
      } else {
        delete global.WIKI
      }
      vi.restoreAllMocks()
    }
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
    const commonDiskModule = await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)
    const commonDisk = commonDiskModule.default
    vi.spyOn(commonDisk, 'processPage').mockResolvedValue(undefined)
    const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default
    const admission = await commonDiskModule.collectStorageEntries(root)

    await storage.processFiles.call({ repoPath: rootPath, root }, {
      admission,
      files: [{
        file: { stats: { size: 7 } },
        oldPath: 'en/guide.md',
        relPath: 'fr/guide.md',
        binary: false,
        insertions: 0,
        deletions: 0,
        before: 0,
        after: 0,
        importAll: false
      }]
    }, { id: 1 })

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
      ? { id: 2, sourceRevision: 'current-log-revision', title: 'Log', description: '', isPublished: true, tags: [] }
      : null))
    global.WIKI.models.pages = { createPage, getPageFromDb, updatePage }
    global.WIKI.models.editors = {
      getDefaultEditor: vi.fn().mockResolvedValue('markdown')
    }
    const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default
    const commonDiskModule = await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)
    const admission = await commonDiskModule.collectStorageEntries(root)

    const results = await storage.processFiles.call({ repoPath: rootPath, root }, {
      admission,
      files: [
      {
        file: { stats: { size: document.length } },
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
        file: { stats: { size: document.length } },
        oldPath: 'en/log.concept.md',
        relPath: 'en/log.concept.md',
        binary: false,
        insertions: 1,
        deletions: 1,
        before: 0,
        after: 0,
        importAll: false
      }
      ]
    }, { id: 7 })
    expect(results).toEqual([
      expect.objectContaining({ kind: 'page', relPath: 'en/index.concept.md', ok: true }),
      expect.objectContaining({ kind: 'page', relPath: 'en/log.concept.md', ok: true })
    ])

    expect(getPageFromDb).toHaveBeenCalledWith({ path: 'index', locale: 'en', visibility: 'public', ownerId: null })
    expect(getPageFromDb).toHaveBeenCalledWith({ path: 'log', locale: 'en', visibility: 'public', ownerId: null })
    expect(createPage).toHaveBeenCalledWith(expect.objectContaining({
      path: 'index',
      locale: 'en',
      okfProducer: 'import:git',
      skipStorage: true
    }))
    expect(updatePage).toHaveBeenCalledWith(expect.objectContaining({
      id: 2,
      expectedSourceRevision: 'current-log-revision',
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
    const commonDiskModule = await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)
    const firstAdmission = await commonDiskModule.collectStorageEntries(root)
    const user = { id: 1 }

    await storage.processFiles.call({ repoPath: rootPath, root }, {
      admission: firstAdmission,
      files: [{
        file: { stats: { size: 7 } },
        oldPath: 'en/index.concept.md',
        relPath: 'en/log.concept.md',
        binary: false,
        insertions: 0,
        deletions: 0,
        before: 0,
        after: 0,
        importAll: false
      }]
    }, user)
    await fs.rm(filePath)
    const secondAdmission = await commonDiskModule.collectStorageEntries(root)
    await storage.processFiles.call({ repoPath: rootPath, root }, {
      admission: secondAdmission,
      files: [{
        file: { stats: { size: 0 } },
        oldPath: 'en/log.concept.md',
        relPath: 'en/log.concept.md',
        binary: false,
        insertions: 0,
        deletions: 1,
        before: 0,
        after: 0,
        importAll: false
      }]
    }, user)

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

  it('rejects an unsafe Git tree before importing or mutating the database', async () => {
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
      const getPageFromDb = vi.fn()
      const createPage = vi.fn()
      const updatePage = vi.fn()
      const upload = vi.fn()
      global.WIKI.models.pages = { getPageFromDb, createPage, updatePage }
      global.WIKI.models.assets = { upload }
      const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default

      await expect(storage.importAll.call({ repoPath: rootPath, root })).rejects.toThrow()

      expect(getPageFromDb).not.toHaveBeenCalled()
      expect(createPage).not.toHaveBeenCalled()
      expect(updatePage).not.toHaveBeenCalled()
      expect(upload).not.toHaveBeenCalled()
      expect(await fs.readFile(externalFile, 'utf8')).toBe('# Outside')
    } finally {
      await fs.rm(externalRoot, { recursive: true, force: true })
    }
  })
  it('rejects unsafe incremental trees before mutating public pages or assets', async () => {
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-git-incremental-external-'))
    try {
      const externalPage = path.join(externalRoot, 'outside.md')
      const externalAsset = path.join(externalRoot, 'outside.bin')
      const pageLink = path.join(rootPath, 'pages', 'outside.md')
      const assetLink = path.join(rootPath, 'assets', 'outside.bin')
      const brokenPageLink = path.join(rootPath, 'pages', 'missing.md')
      const brokenAssetLink = path.join(rootPath, 'assets', 'missing.bin')
      await fs.writeFile(externalPage, '# Outside')
      await fs.writeFile(externalAsset, 'outside asset')
      await fs.mkdir(path.dirname(pageLink), { recursive: true })
      await fs.mkdir(path.dirname(assetLink), { recursive: true })
      const commonDiskModule = await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)
      const admission = await commonDiskModule.collectStorageEntries(root)
      await fs.symlink(externalPage, pageLink)
      await fs.symlink(externalAsset, assetLink)
      await fs.symlink(path.join(externalRoot, 'missing.md'), brokenPageLink)
      await fs.symlink(path.join(externalRoot, 'missing.bin'), brokenAssetLink)

      const getPageFromDb = vi.fn()
      const updatePage = vi.fn()
      const deletePage = vi.fn()
      const assetQuery = vi.fn()
      global.WIKI.models.pages = { getPageFromDb, updatePage, deletePage }
      global.WIKI.models.assets = { query: assetQuery }

      const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default
      await expect(storage.processFiles.call({ repoPath: rootPath, root }, {
        admission,
        files: [
          {
            file: { stats: { size: 8 } },
          oldPath: 'pages/outside.md',
          relPath: 'pages/outside.md',
          binary: false,
          insertions: 1,
          deletions: 0,
          before: 0,
          after: 0,
          importAll: false
        },
        {
          file: { stats: { size: 12 } },
          oldPath: 'assets/outside.bin',
          relPath: 'assets/outside.bin',
          binary: true,
          insertions: 1,
          deletions: 0,
          before: 0,
          after: 0,
          importAll: false
        },
        {
          file: { stats: { size: 0 } },
          oldPath: 'pages/missing.md',
          relPath: 'pages/missing.md',
          binary: false,
          insertions: 0,
          deletions: 1,
          before: 0,
          after: 0,
          importAll: false
        },
        {
          file: { stats: { size: 0 } },
          oldPath: 'assets/missing.bin',
          relPath: 'assets/missing.bin',
          binary: true,
          insertions: 0,
          deletions: 0,
          before: 1,
          after: 0,
          importAll: false
        }
        ]
      }, { id: 1 })).rejects.toThrow()

      expect(getPageFromDb).not.toHaveBeenCalled()
      expect(updatePage).not.toHaveBeenCalled()
      expect(deletePage).not.toHaveBeenCalled()
      expect(assetQuery).not.toHaveBeenCalled()
      expect(await fs.readFile(externalPage, 'utf8')).toBe('# Outside')
      expect(await fs.readFile(externalAsset, 'utf8')).toBe('outside asset')
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
      repoPath: rootPath,
      root
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
    expect(await fs.readFile(indexPath, 'utf8')).toContain('Updated [Log](/en/log.concept.md)')
    const updatedTree = await git.raw(['show', '--format=', 'HEAD:en/index.concept.md'])
    expect(updatedTree).toContain('Updated [Log](/en/log.concept.md)')
    const renamedPage = {
      ...page,
      destinationPath: 'log',
      destinationLocaleCode: 'fr'
    }
    await storage.renamed.call(context, renamedPage)
    await expect(fs.access(path.join(rootPath, 'en', 'log.concept.md'))).rejects.toThrow()
    await fs.access(path.join(rootPath, 'fr', 'log.concept.md'))
    const renamedTree = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD'])
    expect(renamedTree).toContain('fr/log.concept.md')
    expect(renamedTree).not.toContain('en/log.concept.md')

    await storage.deleted.call(context, {
      ...page,
      localeCode: 'fr'
    })
    await expect(fs.access(path.join(rootPath, 'fr', 'log.concept.md'))).rejects.toThrow()
    const deletedTree = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD'])
    expect(deletedTree).not.toContain('fr/log.concept.md')

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
    expect(await fs.readFile(path.join(rootPath, 'legacy.html'), 'utf8')).toContain('<p>Legacy</p>')
    const finalTree = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD'])
    expect(finalTree).toContain('legacy.html')
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
      repoPath: rootPath,
      root
    })

    const indexPath = path.join(rootPath, 'en', 'index.concept.md')
    const legacyPath = path.join(rootPath, 'legacy.html')
    expect(await fs.readFile(indexPath, 'utf8')).toContain('Index content')
    expect(await fs.readFile(legacyPath, 'utf8')).toContain('<p>Legacy</p>')
    expect(git.add).toHaveBeenCalledWith('./en/index.concept.md')
    expect(git.add).toHaveBeenCalledWith('./legacy.html')
  })

  it('finds an asset by its old path and repoints its readable identity and cache', async () => {
    const filePath = path.join(rootPath, 'archive', 'new-logo.png')
    const outsideSentinel = path.join(rootPath, 'outside-sentinel.txt')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, 'image')
    await fs.writeFile(outsideSentinel, 'outside remains')
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
    const commonDiskModule = await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)
    const admission = await commonDiskModule.collectStorageEntries(root)

    await storage.processFiles.call({ repoPath: rootPath, root }, {
      admission,
      files: [{
        file: { stats: { size: 5 } },
        oldPath: 'images/logo.png',
        relPath: 'archive/new-logo.png',
        binary: true,
        insertions: 0,
        deletions: 0,
        before: 1,
        after: 1,
        importAll: false
      }]
    }, { id: 1 })

    expect(findOne).toHaveBeenCalledWith({ hash: sourceHash })
    expect(persisted).toEqual({
      id: 7,
      filename: 'new-logo.png',
      folderId: 4,
      hash: destinationHash
    })
    expect(await findOne({ hash: sourceHash })).toBeUndefined()
    expect(await findOne({ hash: destinationHash })).toBe(asset)
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
  })
})

describe('storage page-document ingress', () => {
  let rootPath
  let root
  let outsideRoot
  let previousWiki
  let hadPreviousWiki
  beforeEach(async () => {
    rootPath = undefined
    hadPreviousWiki = Object.hasOwn(global, 'WIKI')
    previousWiki = global.WIKI
    vi.resetModules()
    rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-document-'))
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-storage-document-outside-'))
    global.WIKI = {
      ROOTPATH: rootPath,
      config: {
        uploads: {
          maxFileSize: 128 * 1024 * 1024
        },
        lang: { code: 'en', namespacing: false }
      },
      logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      models: {}
    }
    root = await openStorageRoot(rootPath)
  })

  afterEach(async () => {
    try {
      await root?.close()
      if (rootPath !== undefined) {
        await fs.rm(rootPath, { recursive: true, force: true })
      }
      if (outsideRoot !== undefined) {
        await fs.rm(outsideRoot, { recursive: true, force: true })
      }
    } finally {
      if (hadPreviousWiki) {
        global.WIKI = previousWiki
      } else {
        delete global.WIKI
      }
      rootPath = undefined
      outsideRoot = undefined
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
    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, raw)
    await fs.writeFile(outsideSentinel, 'outside remains')
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
    const source = await root.openFile('en/index.concept.md')
    let result
    try {
      result = await commonDisk.processPage.call({}, {
        user: { id: 7 },
        relPath: 'en/index.concept.md',
        root,
        contentType: 'markdown',
        moduleName: 'DISK',
        source
      })
    } finally {
      await source.close()
    }

    expect(source.closed).toBe(true)
    expect(result).toMatchObject({ ok: true, format: 'okf_valid' })
    expect(getPageFromDb).toHaveBeenCalledWith({ path: 'index', locale: 'en', visibility: 'public', ownerId: null })
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
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
  })

  it('updates a canonical reserved log path under its original page identity', async () => {
    const filePath = path.join(rootPath, 'fr', 'log.concept.md')
    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, '---\ntype: Reference\nverified:\n  by: human:99\n  at: 2026-08-30T00:00:00Z\n---\n\nUpdated')
    await fs.writeFile(outsideSentinel, 'outside remains')
    const updatePage = vi.fn().mockResolvedValue({ id: 2 })
    const getPageFromDb = vi.fn().mockResolvedValue({
      id: 2,
      sourceRevision: 'current-log-revision',
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

    const source = await root.openFile('fr/log.concept.md')
    let result
    try {
      result = await commonDisk.processPage.call({}, {
        user: { id: 7 },
        relPath: 'fr/log.concept.md',
        root,
        contentType: 'markdown',
        moduleName: 'GIT',
        source
      })
    } finally {
      await source.close()
    }

    expect(result).toMatchObject({ ok: true, format: 'okf_valid' })
    expect(getPageFromDb).toHaveBeenCalledWith({ path: 'log', locale: 'fr', visibility: 'public', ownerId: null })
    expect(updatePage).toHaveBeenCalledWith(expect.objectContaining({
      expectedSourceRevision: 'current-log-revision',
      content: 'Updated',
      okfMetadata: expect.objectContaining({
        verified: { by: 'human:99', at: '2026-08-30T00:00:00Z' }
      }),
      okfProducer: 'import:git',
      skipStorage: true
    }))
    expect(source.closed).toBe(true)
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
  })

  it.each([
    'en/index.md',
    'index.concept.md'
  ])('rejects valid OKF from a non-canonical object path without database mutation: %s', async relPath => {
    const filePath = path.join(rootPath, relPath)
    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, '---\ntype: Reference\n---\n\nBody')
    await fs.writeFile(outsideSentinel, 'outside remains')
    const createPage = vi.fn()
    const updatePage = vi.fn()
    const getPageFromDb = vi.fn()
    global.WIKI.models.pages = { getPageFromDb, createPage, updatePage }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default

    const source = await root.openFile(relPath)
    let result
    try {
      result = await commonDisk.processPage.call({}, {
        user: { id: 7 },
        relPath,
        root,
        contentType: 'markdown',
        moduleName: 'DISK',
        source
      })
    } finally {
      await source.close()
    }

    expect(result).toMatchObject({
      relPath,
      format: 'okf_valid',
      ok: false
    })
    expect(getPageFromDb).not.toHaveBeenCalled()
    expect(createPage).not.toHaveBeenCalled()
    expect(updatePage).not.toHaveBeenCalled()
    expect(source.closed).toBe(true)
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
  })

  it.each(['DISK', 'GIT'])('rejects an oversized %s page before parsing or database mutation', async moduleName => {
    const filePath = path.join(rootPath, 'oversized.md')
    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt')
    await fs.writeFile(filePath, '')
    await fs.truncate(filePath, 1_048_577)
    await fs.writeFile(outsideSentinel, 'outside remains')
    const getPageFromDb = vi.fn()
    const createPage = vi.fn()
    const updatePage = vi.fn()
    global.WIKI.models.pages = { getPageFromDb, createPage, updatePage }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default

    const source = await root.openFile('oversized.md')
    try {
      await expect(commonDisk.processPage.call({}, {
        user: { id: 7 },
        relPath: 'oversized.md',
        root,
        contentType: 'markdown',
        moduleName,
        source
      })).rejects.toBeInstanceOf(RangeError)
    } finally {
      await source.close()
    }

    expect(getPageFromDb).not.toHaveBeenCalled()
    expect(createPage).not.toHaveBeenCalled()
    expect(updatePage).not.toHaveBeenCalled()
    expect(source.closed).toBe(true)
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
  })

  it('does not mutate the database for a claimed invalid OKF document', async () => {
    const filePath = path.join(rootPath, 'invalid.md')
    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt')
    await fs.writeFile(filePath, '---\ntype: [broken\n---\nBody')
    await fs.writeFile(outsideSentinel, 'outside remains')
    const createPage = vi.fn()
    const updatePage = vi.fn()
    global.WIKI.models.pages = {
      getPageFromDb: vi.fn().mockResolvedValue(null),
      createPage,
      updatePage
    }
    const commonDisk = (await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)).default

    const source = await root.openFile('invalid.md')
    let result
    try {
      result = await commonDisk.processPage.call({}, {
        user: { id: 7 },
        relPath: 'invalid.md',
        root,
        contentType: 'markdown',
        moduleName: 'DISK',
        source
      })
    } finally {
      await source.close()
    }

    expect(result).toMatchObject({ ok: false, format: 'okf_invalid' })
    expect(createPage).not.toHaveBeenCalled()
    expect(updatePage).not.toHaveBeenCalled()
    expect(source.closed).toBe(true)
    expect(await fs.readFile(outsideSentinel, 'utf8')).toBe('outside remains')
  })
})
