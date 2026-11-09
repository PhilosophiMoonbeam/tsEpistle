import fs from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import tar from 'tar-fs'
import { EventEmitter } from 'node:events'
import moment from 'moment'
import { JSON_SCHEMA, load } from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import { openStorageRoot } from '../../modules/storage/local-filesystem.ts'
import { okfFilePath } from '../../okf/format.ts'
import { nativeStorageMutationConfigurationKey } from '../../helpers/storage-configuration-key.ts'
import { storageImportLocationKey, storageImportSourceKey } from '../../modules/storage/import-identity.ts'

let ownerRecords = []
const inventoryRows = (rows = []) => ({
  where(filter) {
    if (filter === null || typeof filter !== 'object') return this
    rows = rows.filter(row => Object.entries(filter).every(([key, value]) => row[key] === value))
    return this
  },
  whereIn(key, values) { rows = rows.filter(row => values.includes(row[key])); return this },
  select() { return this },
  orderBy() { return this },
  limit(count) { rows = rows.slice(0, count); return this },
  then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject) }
})
const ownedImportPage = (root, sourcePath, bytes, identity, config = {}, moduleName = 'GIT') => {
  const page = {
    id: 2, sourceRevision: '1', title: 'Existing', description: '', isPublished: true, tags: [],
    visibility: 'public', ownerId: null,
    localeCode: identity.locale, path: identity.path, extra: { okf: { type: 'Reference' } }
  }
  ownerRecords = ownerRecords.filter(record => record.pageId !== page.id)
  ownerRecords.push({
    pageId: page.id, nativeRevision: page.sourceRevision, nativePath: page.path, nativeLocaleCode: page.localeCode,
    sourceKey: storageImportSourceKey(root.sourceIdentity, moduleName, config),
    locationKey: storageImportLocationKey(moduleName, config),
    sourcePath, sourceSha256: createHash('sha256').update(bytes).digest('hex'), mapped: false,
    status: 'active', operationId: '00000000-0000-4000-8000-000000000001', moveBinding: null,
    updatedAt: new Date(), deletedAt: null
  })
  return page
}
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
    ownerRecords = []
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
      models: {
        knex: table => inventoryRows(table === 'storagePageImportOwners' ? ownerRecords : [{ code: 'en' }, { code: 'fr' }]),
        pages: { query: () => inventoryRows() }
      }
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
    const contents = _name === 'compressed output' ? randomBytes(256 * 1024 + 123) : Buffer.from('content')
    await plugin.assetUploaded.call(context, { path: 'page.txt', data: contents })
    await plugin.sync.call(context)
    const directory = path.join(rootPath, 'content', '_daily')
    const name = `wiki-${moment().format('DD')}.tar.gz`
    const previous = await fs.readFile(path.join(directory, name))
    const originalOpenFile = context.root.openFile.bind(context.root)
    const openSources = new Set()
    const openFileSpy = vi.spyOn(context.root, 'openFile').mockImplementation(async (relativePath, expected) => {
      const source = await originalOpenFile(relativePath, expected)
      openSources.add(source)
      const originalClose = source.close.bind(source)
      vi.spyOn(source, 'close').mockImplementation(async () => {
        // Closing a source can itself require asynchronous descriptor cleanup.
        await new Promise(resolve => setImmediate(resolve))
        await originalClose()
        openSources.delete(source)
      })
      return source
    })

    context.backupLimits = { ...context.backupLimits, ...override }
    await expect(plugin.sync.call(context)).rejects.toThrow()
    if (_name === 'compressed output') expect(openFileSpy).toHaveBeenCalled()
    expect(openSources.size).toBe(0)

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
    const originalWriteAtomicStream = context.root.writeAtomicStream.bind(context.root)
    vi.spyOn(context.root, 'writeAtomicStream').mockImplementation((relativePath, chunks, maxBytes) => {
      return originalWriteAtomicStream(relativePath, {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of chunks) {
            // Source failure must remain owned while the consumer is between writes.
            await new Promise(resolve => setImmediate(resolve))
            yield chunk
          }
        }
      }, maxBytes)
    })
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

    await expect(plugin.sync.call(context)).rejects.toThrow(mode === 'growth'
      ? 'Backup source grew during archive: mutable.bin'
      : 'Local storage file changed during validation: mutable.bin')
    expect(hooked).toBe(true)
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

    await Storage.performMutation(
      { targetKey: 'disk', targetConfigurationRevision: nativeStorageMutationConfigurationKey(Storage.activeTargets.find(target => target.key === 'disk')) },
      async dispatch => {
        await dispatch.writePage(page)
        await dispatch.writeAsset(asset)
      },
      new AbortController().signal
    )
    const locations = await Storage.getLocalLocations({ asset })

    expect(failedTarget.state).toEqual({
      status: 'error',
      message: expect.any(String),
      lastAttempt: expect.any(String)
    })
    expect(await fs.readFile(path.join(rootPath, 'content', okfFilePath('en', 'guide')), 'utf8')).toContain('source_revision: \'1\'')
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

  it.each([
    [[{ kind: 'page', relPath: 'README.md', ok: false, error: 'Import remains pending' }], 'error', 'failed'],
    [[{ kind: 'page', relPath: 'guide.md', ok: true }, { kind: 'page', relPath: 'README.md', ok: false, error: 'Import remains pending' }], 'warning', 'partial']
  ])('retains truthful scheduled Git import failure state (%s)', async (results, status, outcome) => {
    global.WIKI.SERVERPATH = '/tmp/wiki-server'
    global.WIKI.data = {
      storage: [{ key: 'git', isAvailable: true, schedule: 'PT30M', actions: [{ handler: 'sync' }] }]
    }
    global.WIKI.models = {
      storage: class {},
      knex: vi.fn(),
      Objection: { transaction: { start: vi.fn() } }
    }
    const Storage = (await vi.importFresh('../../models/storage.ts', import.meta.url)).default
    global.WIKI.models.storage = Storage
    const target = {
      key: 'git',
      isEnabled: true,
      mode: 'sync',
      syncInterval: 'PT30M',
      config: { localRepoPath: path.join(rootPath, 'git-repo'), branch: 'main' },
      runtimeGeneration: 'active-generation',
      state: { status: 'operational', message: '', lastAttempt: null },
      fn: { sync: vi.fn().mockResolvedValue(results) },
      $query: vi.fn(() => ({ patch: vi.fn().mockResolvedValue(undefined) }))
    }
    Storage.targets = [target]
    Storage.activeTargets = [target]
    expect(await Storage.syncTarget('git', 'active-generation')).toBe(false)
    expect(target.fn.sync).toHaveBeenCalledTimes(1)
    expect(target.state).toMatchObject({
      status,
      lastOperation: { outcome, handler: 'sync', total: results.length, failed: 1 }
    })
    expect(target.state.lastOperation.items).toContainEqual(expect.objectContaining({
      path: 'README.md',
      outcome: 'failed'
    }))

    target.fn.sync.mockResolvedValueOnce([{ kind: 'page', relPath: 'README.md', ok: true }])
    expect(await Storage.syncTarget('git', target.runtimeGeneration)).toBe(true)
    expect(target.fn.sync).toHaveBeenCalledTimes(2)
    expect(target.state).toMatchObject({
      status: 'operational',
      lastOperation: { handler: 'sync', outcome: 'succeeded', failed: 0 }
    })
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

  it('serializes non-Markdown HTML with core metadata and normalized page features', async () => {
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
      extra: {
        pageFeatures: {
          schemaVersion: 1,
          linksVisible: true,
          ratingsAllowed: false,
          lastEditorVisible: 'invalid'
        }
      },
      isPublished: true,
      editorKey: 'html',
      tags: [{ tag: 'one' }]
    })

    const serialized = await fs.readFile(path.join(rootPath, 'content', 'legacy.html'), 'utf8')
    const htmlDocument = /^<!--\s*([\s\S]*?)\s*-->\s*([\s\S]*)$/u.exec(serialized)
    expect(htmlDocument).not.toBeNull()
    const metadata = load(htmlDocument?.[1] ?? '', { schema: JSON_SCHEMA })
    expect(metadata).toMatchObject({
      title: 'Legacy',
      description: 'Description',
      published: true,
      date: '2026-08-30T00:00:00.000Z',
      tags: 'one',
      editor: 'html',
      dateCreated: '2026-08-29T00:00:00.000Z',
      pageFeatures: {
        schemaVersion: 1,
        linksVisible: false,
        ratingsAllowed: false,
        lastEditorVisible: false
      }
    })
    expect(htmlDocument?.[2]).toBe('<p>Body</p>')

    const pageDocument = (await vi.importFresh('../../modules/storage/page-document.ts', import.meta.url)).default
    const parsed = pageDocument({
      rawDocument: serialized,
      contentType: 'html',
      locale: 'en',
      pagePath: 'legacy',
      importer: 'import:disk'
    })
    expect(parsed.format).toBe('legacy_wiki')
    expect(parsed.pageFeatures).toEqual({
      schemaVersion: 1,
      linksVisible: false,
      ratingsAllowed: false,
      lastEditorVisible: false
    })
  })
  it.each([false, true])('applies configured external ingestion choices without changing canonical OKF (enabled=%s)', async enabled => {
    context.config.stripLeadingH1 = enabled
    context.config.mapReadmeToHome = enabled
    const canonical = '---\ntype: Reference\n---\n\n# Canonical\n\nKeep this heading'
    const documents = {
      'README.md': '# Welcome\n\nExternal body',
      'fr/README.adoc': '= Bonjour\n\nCorps',
      'docs/README.md': '# Nested\n\nNested body',
      'author.adoc': '= Document\nJane Doe <jane@example.test>\nv1.0, 2026-10-01\n\nBody',
      'heading-only.md': '# Only heading\n',
      'en/index.concept.md': canonical
    }
    for (const [name, bytes] of Object.entries(documents)) {
      const destination = path.join(rootPath, 'content', name)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, bytes)
    }
    const imported = []
    global.WIKI.models.users = { getRootUser: vi.fn().mockResolvedValue({ id: 1 }) }
    global.WIKI.models.pages = {
      query: () => inventoryRows(),
      getPageFromDb: vi.fn().mockResolvedValue(null),
      createPage: vi.fn(async page => { imported.push(page); return { id: imported.length } })
    }
    global.WIKI.models.editors = { getDefaultEditor: vi.fn().mockResolvedValue('markdown') }

    const results = await plugin.importAll.call(context)

    expect(results.every(item => item.ok)).toBe(true)
    expect(imported).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: enabled ? 'home' : 'README', locale: 'en', content: enabled ? 'External body' : documents['README.md'] }),
      expect.objectContaining({ path: enabled ? 'home' : 'README', locale: 'fr', content: enabled ? 'Corps' : documents['fr/README.adoc'] }),
      expect.objectContaining({ path: 'docs/README', content: enabled ? 'Nested body' : documents['docs/README.md'] }),
      expect.objectContaining({ path: 'author', content: documents['author.adoc'] }),
      expect.objectContaining({ path: 'heading-only', content: documents['heading-only.md'] }),
      expect.objectContaining({ path: 'index', content: '# Canonical\n\nKeep this heading' })
    ]))
    expect(await fs.readFile(path.join(rootPath, 'content', 'README.md'), 'utf8')).toBe(documents['README.md'])
  })

  it.each([
    ['README.md', 'home.md'],
    ['README.md', 'en/home.md'],
    ['fr/README.adoc', 'fr/home.md'],
    ['README.md', 'en/README.adoc']
  ])('refuses ambiguous mapped home sources %s and %s before any database write', async (first, second) => {
    context.config.mapReadmeToHome = true
    for (const name of [first, second]) {
      const destination = path.join(rootPath, 'content', name)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, 'Distinct input: ' + name)
    }
    const createPage = vi.fn()
    const updatePage = vi.fn()
    global.WIKI.models.users = { getRootUser: vi.fn().mockResolvedValue({ id: 1 }) }
    global.WIKI.models.pages = { query: () => inventoryRows(), getPageFromDb: vi.fn().mockResolvedValue(null), createPage, updatePage }
    await expect(plugin.importAll.call(context)).rejects.toThrow('Ambiguous page import')
    expect(createPage).not.toHaveBeenCalled()
    expect(updatePage).not.toHaveBeenCalled()
    for (const name of [first, second]) expect(await fs.readFile(path.join(rootPath, 'content', name), 'utf8')).toBe('Distinct input: ' + name)
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
    let pageBytes
    let assetBytes
    const processPage = vi.spyOn(commonDisk, 'processPage').mockImplementation(async ({ source }) => {
      pageBytes = await source.readBounded(1024)
      return {
        relPath: 'inside-page.md',
        format: 'plain_markdown',
        sha256: 'inside',
        ok: true,
        document: {}
      }
    })
    const processAsset = vi.spyOn(commonDisk, 'processAsset').mockImplementation(async ({ source }) => {
      assetBytes = await source.readBounded(1024)
    })

    await commonDisk.importFromDisk({
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

    expect(pageBytes).toEqual(Buffer.from('Inside page'))
    expect(assetBytes).toEqual(Buffer.from('Inside asset'))
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

describe('Git storage rename identities', () => {
  let rootPath
  let root
  let currentPages
  let hadPreviousWiki
  let previousWiki

  beforeEach(async () => {
    ownerRecords = []
    currentPages = []
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
      models: { pages: { query: () => inventoryRows(currentPages) }, assetFolders: { getAllPaths: async () => ({}) } }
    }
    // This suite tests Git bytes/identities; PostgreSQL contention is exercised
    // against independent real connections in storage.git-lock.postgres.test.ts.
    const connection = new EventEmitter()
    global.WIKI.models.knex = Object.assign(table => table === 'storagePageImportOwners' ? inventoryRows(ownerRecords) : table === 'locales' ? inventoryRows([{ code: 'en' }, { code: 'fr' }]) : table === 'pages' ? inventoryRows(currentPages) : ({
      where() { return this },
      whereNot() { return this },
      whereRaw() { return this },
      select() { return this },
      limit: async () => [],
      first: async () => undefined
    }), {
      client: {
        config: { client: 'pg' },
        acquireConnection: async () => connection,
        releaseConnection: async () => undefined,
        destroyRawConnection: async () => undefined
      },
      raw: () => ({
        connection() { return this },
        timeout: async () => ({ rows: [{ locked: true, held: true, unlocked: true }] })
      })
    })
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


  it('refuses an unclassified cross-locale rename before moving a canonical page', async () => {
    const filePath = path.join(rootPath, 'fr', 'guide.md')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, 'content')
    const movePage = vi.fn().mockResolvedValue(undefined)
    global.WIKI.models.pages = { movePage }
    const commonDiskModule = await vi.importFresh('../../modules/storage/disk/common.ts', import.meta.url)
    const commonDisk = commonDiskModule.default
    vi.spyOn(commonDisk, 'processPage').mockResolvedValue(undefined)
    const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default
    const admission = await commonDiskModule.collectStorageEntries(root)

    await expect(storage.processFiles.call({ repoPath: rootPath, root }, {
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
    }, { id: 1 })).rejects.toThrow('Previous Git page source is unavailable')
    expect(movePage).not.toHaveBeenCalled()
  })


  it('preserves native canonical pages when a pinned Git rename presents only forged JSON ownership', async () => {
    const remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-git-remote-'))
    const seedPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-git-seed-'))
    try {
      const { simpleGit } = await import('simple-git')
      const git = simpleGit(rootPath)
      await git.init()
      await git.addConfig('user.name', 'Wiki Test')
      await git.addConfig('user.email', 'wiki@example.test')
      const document = '---\ntype: Reference\nverified:\n  by: human:99\n  at: 2026-08-30T00:00:00Z\nvendor: retained\n---\n\n# Canonical heading\n\nProtected body'
      const oldPath = 'en/index.concept.md'
      const newPath = 'en/log.concept.md'
      await fs.mkdir(path.join(rootPath, 'en'), { recursive: true })
      await fs.writeFile(path.join(rootPath, oldPath), document)
      await git.add(oldPath)
      await git.commit('canonical index')
      const originalCommit = (await git.raw(['rev-parse', 'HEAD'])).trim()
      const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      await simpleGit(remotePath).init(true)
      await git.addRemote('origin', remotePath)
      await git.push('origin', branch)
      await simpleGit().clone(remotePath, seedPath)
      const seed = simpleGit(seedPath)
      await seed.addConfig('user.name', 'External Writer')
      await seed.addConfig('user.email', 'external@example.test')
      await seed.raw(['mv', '--', oldPath, newPath])
      await seed.commit('rename canonical index to log')
      await seed.push('origin', branch)
      const renamedCommit = (await seed.raw(['rev-parse', 'HEAD'])).trim()
      const user = { id: 1 }
      const config = { branch, stripLeadingH1: true, mapReadmeToHome: true }
      const current = ownedImportPage(root, oldPath, document, { locale: 'en', path: 'index' }, config)
      current.extra.okf['x-wiki'] = { storage_import: { ...ownerRecords[0] } }
      ownerRecords = []
      current.content = 'Protected body'
      currentPages = [current]
      const before = structuredClone(current)
      const createPage = vi.fn()
      const movePage = vi.fn()
      const deletePage = vi.fn()
      global.WIKI.models.users = { getRootUser: vi.fn().mockResolvedValue(user) }
      global.WIKI.models.pages = {
        query: () => inventoryRows([current]),
        getPageFromDb: vi.fn(async identity => current.path === identity.path && current.localeCode === identity.locale ? current : null),
        createPage,
        updatePage: vi.fn(),
        movePage, deletePage
      }
      const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default
      const runtime = { ...storage, root, git, repoPath: rootPath, mode: 'pull', config }

      await expect(storage.sync.call(runtime)).rejects.toThrow()
      expect(movePage).not.toHaveBeenCalled()
      expect(createPage).not.toHaveBeenCalled()
      expect(global.WIKI.models.pages.updatePage).not.toHaveBeenCalled()
      expect(current).toEqual(before)
      expect(ownerRecords).toEqual([])
      expect((await git.raw(['rev-parse', `refs/wiki/pending-import/${branch}`])).trim()).toBe(originalCommit)
      expect((await git.raw(['rev-parse', 'HEAD'])).trim()).toBe(renamedCommit)
      expect(await fs.readFile(path.join(rootPath, newPath), 'utf8')).toBe(document)
      await expect(fs.access(path.join(rootPath, oldPath))).rejects.toThrow()
      expect(await git.raw(['ls-tree', '-r', '--name-only', 'HEAD'])).toBe(`${newPath}\n`)
      expect(await git.raw(['show', `${originalCommit}:${oldPath}`])).toBe(document)
      expect(deletePage).not.toHaveBeenCalled()

    } finally {
      await fs.rm(remotePath, { recursive: true, force: true })
      await fs.rm(seedPath, { recursive: true, force: true })
    }
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
      const { simpleGit } = await import('simple-git')
      const git = simpleGit(rootPath)
      await git.init()
      await git.addConfig('user.name', 'Wiki Test')
      await git.addConfig('user.email', 'wiki@example.test')
      await fs.writeFile(brokenPageLink, '# Previous missing page\n')
      await fs.writeFile(brokenAssetLink, 'previous missing asset')
      await git.add(['pages/missing.md', 'assets/missing.bin'])
      await git.commit('previous incremental sources')
      const previousCommit = (await git.raw(['rev-parse', 'HEAD'])).trim()
      const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      await git.raw(['rm', '--', 'pages/missing.md', 'assets/missing.bin'])
      await git.commit('delete incremental sources')
      const remotePath = path.join(externalRoot, 'remote.git')
      await fs.mkdir(remotePath)
      await simpleGit(remotePath).init(true)
      await git.addRemote('origin', remotePath)
      await git.push('origin', branch)
      await git.raw(['update-ref', `refs/wiki/pending-import/${branch}`, previousCommit])

      const getPageFromDb = vi.fn()
      const createPage = vi.fn()
      const updatePage = vi.fn()
      const deletePage = vi.fn()
      const movePage = vi.fn()
      const assetQuery = vi.fn()
      const upload = vi.fn()
      currentPages = [ownedImportPage(root, 'pages/missing.md', '# Previous missing page\n',
        { locale: 'en', path: 'pages/missing' }, { branch })]
      global.WIKI.models.pages = { query: () => inventoryRows(currentPages), getPageFromDb, createPage, updatePage, deletePage, movePage }
      global.WIKI.models.assets = { query: assetQuery, upload }
      global.WIKI.models.users = { getRootUser: vi.fn().mockResolvedValue({ id: 1 }) }
      const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default
      const capturePlan = vi.fn(async () => [])
      await storage.sync.call({
        ...storage, repoPath: rootPath, root, git, mode: 'pull', config: { branch }, processFiles: capturePlan
      })
      expect(capturePlan).toHaveBeenCalledTimes(1)
      const deletionPlan = capturePlan.mock.calls[0][0]
      expect(deletionPlan.files).toHaveLength(2)
      expect(deletionPlan.files).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'D', relPath: 'pages/missing.md' }),
        expect.objectContaining({ status: 'D', relPath: 'assets/missing.bin' })
      ]))
      // Keep the native plan's pinned old blobs; only the worktree changes after admission.
      const admission = deletionPlan.admission
      await fs.mkdir(path.dirname(pageLink), { recursive: true })
      await fs.mkdir(path.dirname(assetLink), { recursive: true })
      await fs.symlink(externalPage, pageLink)
      await fs.symlink(externalAsset, assetLink)
      await fs.symlink(path.join(externalRoot, 'missing.md'), brokenPageLink)
      await fs.symlink(path.join(externalRoot, 'missing.bin'), brokenAssetLink)

      const modifiedFiles = [
        {
          status: 'M',
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
          status: 'M',
          file: { stats: { size: 12 } },
          oldPath: 'assets/outside.bin',
          relPath: 'assets/outside.bin',
          binary: true,
          insertions: 1,
          deletions: 0,
          before: 0,
          after: 0,
          importAll: false
        }
      ]
      const openFile = vi.spyOn(root, 'openFile')
      const beforePages = structuredClone(currentPages)
      const beforeOwners = structuredClone(ownerRecords)
      // Match the planner's post-reset module instance and AsyncLocalStorage fence.
      const { withGitMutationLock } = await import('../../modules/storage/git/mutation-lock.ts')
      for (const changes of [...modifiedFiles.map(file => [file]), deletionPlan.files]) {
        openFile.mockClear()
        const processing = withGitMutationLock(global.WIKI.models.knex, 'git', () =>
          storage.processFiles.call({ repoPath: rootPath, root, config: { branch } }, {
            admission,
            files: changes
          }, { id: 1 }))
        await expect(processing).rejects.toMatchObject(
          changes[0].status === 'M' ? { kind: 'parser' } : { kind: 'monitor', quarantine: true }
        )
        expect(openFile).not.toHaveBeenCalled()
        expect(getPageFromDb).not.toHaveBeenCalled()
        expect(createPage).not.toHaveBeenCalled()
        expect(updatePage).not.toHaveBeenCalled()
        expect(deletePage).not.toHaveBeenCalled()
        expect(movePage).not.toHaveBeenCalled()
        expect(assetQuery).not.toHaveBeenCalled()
        expect(upload).not.toHaveBeenCalled()
        expect(currentPages).toEqual(beforePages)
        expect(ownerRecords).toEqual(beforeOwners)
        expect(await fs.readFile(externalPage, 'utf8')).toBe('# Outside')
        expect(await fs.readFile(externalAsset, 'utf8')).toBe('outside asset')
      }
    } finally {
      await fs.rm(externalRoot, { recursive: true, force: true })
    }
  })

  it('refuses pinned README deletion without native ledger proof and retains its replay base', async () => {
    const remotePath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-git-remote-'))
    const seedPath = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-git-seed-'))
    try {
      const { simpleGit } = await import('simple-git')
      const git = simpleGit(rootPath)
      await git.init()
      await git.addConfig('user.name', 'Wiki Test')
      await git.addConfig('user.email', 'wiki@example.test')
      const document = '# Old\n\nOld body'
      await fs.writeFile(path.join(rootPath, 'README.md'), document)
      await git.add('README.md')
      await git.commit('initial')
      const originalCommit = (await git.raw(['rev-parse', 'HEAD'])).trim()
      const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
      await simpleGit(remotePath).init(true)
      await git.addRemote('origin', remotePath)
      await git.push('origin', branch)
      await simpleGit().clone(remotePath, seedPath)
      const seed = simpleGit(seedPath)
      await seed.addConfig('user.name', 'External Writer')
      await seed.addConfig('user.email', 'external@example.test')
      await seed.raw(['rm', '--', 'README.md'])
      await seed.commit('remove external README')
      await seed.push('origin', branch)
      const deletedCommit = (await seed.raw(['rev-parse', 'HEAD'])).trim()
      const config = { branch, stripLeadingH1: true, mapReadmeToHome: true }
      const current = ownedImportPage(root, 'README.md', document, { locale: 'en', path: 'home' }, config)
      current.content = 'Protected native body'
      current.extra.okf['x-wiki'] = { storage_import: { ...ownerRecords[0] } }
      ownerRecords = []
      currentPages = [current]
      const before = structuredClone(current)
      const createPage = vi.fn()
      const updatePage = vi.fn()
      const movePage = vi.fn()
      const deletePage = vi.fn()
      global.WIKI.models.users = { getRootUser: vi.fn().mockResolvedValue({ id: 1 }) }
      global.WIKI.models.pages = {
        query: () => inventoryRows(currentPages),
        getPageFromDb: vi.fn().mockResolvedValue(current),
        createPage, updatePage, movePage, deletePage
      }
      const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default
      const runtime = { ...storage, root, git, repoPath: rootPath, mode: 'pull', config }
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(storage.sync.call(runtime)).rejects.toThrow()
        expect(createPage).not.toHaveBeenCalled()
        expect(updatePage).not.toHaveBeenCalled()
        expect(movePage).not.toHaveBeenCalled()
        expect(deletePage).not.toHaveBeenCalled()
        expect(current).toEqual(before)
        expect(ownerRecords).toEqual([])
        expect((await git.raw(['rev-parse', `refs/wiki/pending-import/${branch}`])).trim()).toBe(originalCommit)
        expect((await git.raw(['rev-parse', 'HEAD'])).trim()).toBe(deletedCommit)
        await expect(fs.access(path.join(rootPath, 'README.md'))).rejects.toThrow()
        expect(await git.raw(['show', `${originalCommit}:README.md`])).toBe(document)
      }
    } finally {
      await fs.rm(remotePath, { recursive: true, force: true })
      await fs.rm(seedPath, { recursive: true, force: true })
    }
  })

  it('refuses synchronization and purge while an uncommitted mutation is pending without deleting it', async () => {
    const { simpleGit } = await import('simple-git')
    const git = simpleGit(rootPath)
    await git.init()
    await git.addConfig('user.name', 'Wiki Test')
    await git.addConfig('user.email', 'wiki@example.test')
    await fs.writeFile(path.join(rootPath, 'committed.md'), 'Committed')
    await git.add('committed.md')
    await git.commit('initial')
    await fs.writeFile(path.join(rootPath, 'pending.md'), 'Uncommitted durable effect bytes')
    const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    const storage = (await vi.importFresh('../../modules/storage/git/storage.ts', import.meta.url)).default
    const runtime = { ...storage, root, git, repoPath: rootPath, mode: 'pull', config: { branch } }
    await expect(storage.sync.call(runtime)).rejects.toThrow('pending mutations')
    await expect(storage.purge.call(runtime)).rejects.toThrow('pending mutations')
    expect(await fs.readFile(path.join(rootPath, 'pending.md'), 'utf8')).toBe('Uncommitted durable effect bytes')
    expect((await git.raw(['status', '--porcelain'])).trim()).toBe('?? pending.md')
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
    const renamedCommit = (await git.raw(['rev-parse', 'HEAD'])).trim()
    await storage.renamed.call(context, renamedPage)
    expect((await git.raw(['rev-parse', 'HEAD'])).trim()).toBe(renamedCommit)

    await storage.deleted.call(context, {
      ...page,
      localeCode: 'fr'
    })
    await expect(fs.access(path.join(rootPath, 'fr', 'log.concept.md'))).rejects.toThrow()
    const deletedTree = await git.raw(['ls-tree', '-r', '--name-only', 'HEAD'])
    expect(deletedTree).not.toContain('fr/log.concept.md')
    const deletedCommit = (await git.raw(['rev-parse', 'HEAD'])).trim()
    await storage.deleted.call(context, { ...page, localeCode: 'fr' })
    expect((await git.raw(['rev-parse', 'HEAD'])).trim()).toBe(deletedCommit)

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

    const data = Buffer.from('Canonical relocation bytes')
    await storage.assetUploaded.call(context, { path: 'assets/old.bin', data, authorName: page.authorName, authorEmail: page.authorEmail })
    const relocation = {
      sourcePath: 'assets/old.bin',
      destinationPath: 'assets/new.bin',
      data,
      contentSha256: createHash('sha256').update(data).digest('hex'),
      authorName: page.authorName,
      authorEmail: page.authorEmail
    }
    await storage.assetRelocated.call(context, relocation)
    const relocatedCommit = (await git.raw(['rev-parse', 'HEAD'])).trim()
    await storage.assetRelocated.call(context, relocation)
    expect((await git.raw(['rev-parse', 'HEAD'])).trim()).toBe(relocatedCommit)
    expect(await fs.readFile(path.join(rootPath, 'assets/new.bin'))).toEqual(data)
    await expect(fs.access(path.join(rootPath, 'assets/old.bin'))).rejects.toThrow()
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
    global.WIKI.models.knex = {
      ...global.WIKI.models.knex,
      column: vi.fn(() => {
        let rows = []
        const builder = {
          select: vi.fn(() => builder),
          from: vi.fn(table => {
            rows = table === 'pages' ? pages : []
            return builder
          }),
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
    const { simpleGit } = await import('simple-git')
    const git = simpleGit(rootPath)
    await git.init()
    await git.addConfig('user.name', 'Wiki Test')
    await git.addConfig('user.email', 'wiki@example.test')
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
    expect(await git.raw(['show', 'HEAD:en/index.concept.md'])).toContain('Index content')
    expect(await git.raw(['show', 'HEAD:legacy.html'])).toContain('<p>Legacy</p>')
  })

})

describe('storage page-document ingress', () => {
  let rootPath
  let root
  let outsideRoot
  let previousWiki
  let hadPreviousWiki
  beforeEach(async () => {
    ownerRecords = []
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
      models: { knex: table => inventoryRows(table === 'storagePageImportOwners' ? ownerRecords : table === 'locales' ? [{ code: 'en' }, { code: 'fr' }] : []), pages: { query: () => inventoryRows() } }
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
      sha256: createHash('sha256').update(raw).digest('hex'),
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
      query: () => inventoryRows(),
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
      okfMetadata: expect.objectContaining({
        type: 'Reference',
        tags: ['source'],
        verified: { by: 'human:99', at: '2026-08-30T00:00:00Z' },
        vendor: 'retained'
      }),
      okfProducer: 'import:disk',
      skipStorage: true
    }))
    expect(await fs.readFile(filePath)).toEqual(raw)
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

  it('rejects an oversized page before parsing or database mutation', async () => {
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
        moduleName: 'DISK',
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
