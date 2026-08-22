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
    plugin = (await import('../../modules/storage/disk/storage.ts')).default
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
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('second')
    await expect(plugin.getLocalLocation.call(context, asset)).resolves.toBe(filePath)
    await expect(fs.readdir(path.dirname(filePath))).resolves.toEqual(['logo.txt'])
  })

  it.each([
    '../escape.txt',
    'images/../../escape.txt',
    '/tmp/wiki-storage-escape.txt'
  ])('rejects asset paths outside the configured root: %s', async assetPath => {
    await expect(plugin.assetUploaded.call(context, {
      path: assetPath,
      data: Buffer.from('blocked')
    })).rejects.toThrow(`Storage path escapes the configured root: ${assetPath}`)
  })

  it('rejects page paths outside the configured root', async () => {
    await expect(plugin.created.call(context, {
      localeCode: 'en',
      path: '../../escape',
      contentType: 'markdown',
      injectMetadata: () => 'blocked'
    })).rejects.toThrow('Storage path escapes the configured root: ../../escape.md')
  })
})
