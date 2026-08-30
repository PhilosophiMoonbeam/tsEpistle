import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
