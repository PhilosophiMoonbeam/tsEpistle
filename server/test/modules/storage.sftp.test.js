import { Readable } from 'node:stream'

const markdownPage = (overrides = {}) => ({
  id: 8,
  path: 'guides/index',
  localeCode: 'fr',
  title: 'Canonical SFTP path',
  description: '',
  contentType: 'markdown',
  content: 'See [home](/fr/home).',
  sourceRevision: 42,
  authorId: 7,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
  extra: { okf: { type: 'Reference', status: 'stable' } },
  isPublished: true,
  editorKey: 'markdown',
  tags: [],
  ...overrides
})

describe('SFTP storage target paths', () => {
  let plugin
  let context
  let sftp

  beforeEach(async () => {
    vi.resetModules()
    global.WIKI = {
      config: {
        lang: {
          code: 'en',
          namespacing: false
        }
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn()
      },
      models: {}
    }
    plugin = (await vi.importFresh('../../modules/storage/sftp/storage.ts', import.meta.url)).default
    sftp = {
      readdir: vi.fn().mockRejectedValue(new Error('missing')),
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      rename: vi.fn().mockResolvedValue(undefined)
    }
    context = {
      config: { basePath: '/remote/wiki' },
      sftp,
      ensureDirectory: plugin.ensureDirectory
    }
  })

  it('uses locale-qualified canonical OKF paths for every Markdown event', async () => {
    const page = markdownPage()

    await plugin.created.call(context, page)
    await plugin.updated.call(context, { ...page, path: 'guides/start' })
    await plugin.deleted.call(context, page)
    await plugin.renamed.call(context, {
      ...page,
      destinationPath: 'reference/LOG',
      destinationLocaleCode: 'de'
    })

    expect(sftp.writeFile.mock.calls.map(([filePath]) => filePath)).toEqual([
      '/remote/wiki/fr/guides/index.concept.md',
      '/remote/wiki/fr/guides/start.md'
    ])
    expect(sftp.unlink).toHaveBeenCalledWith('/remote/wiki/fr/guides/index.concept.md')
    expect(sftp.rename).toHaveBeenCalledWith(
      '/remote/wiki/fr/guides/index.concept.md',
      '/remote/wiki/de/reference/LOG.concept.md'
    )
    expect(sftp.mkdir.mock.calls.map(([directory]) => directory)).toEqual(expect.arrayContaining([
      '/remote/wiki/fr',
      '/remote/wiki/fr/guides',
      '/remote/wiki/de',
      '/remote/wiki/de/reference'
    ]))
  })

  it('retains legacy paths for non-Markdown pages and assets', async () => {
    const page = { ...markdownPage(), path: 'guides/start', contentType: 'html' }
    const asset = { path: 'images/logo.png', destinationPath: 'brand/logo.png', data: Buffer.from('asset') }

    await plugin.created.call(context, page)
    await plugin.assetUploaded.call(context, asset)
    await plugin.assetDeleted.call(context, asset)
    await plugin.assetRenamed.call(context, asset)

    expect(sftp.writeFile.mock.calls.map(([filePath]) => filePath)).toEqual([
      '/remote/wiki/guides/start.html',
      '/remote/wiki/images/logo.png'
    ])
    expect(sftp.unlink).toHaveBeenCalledWith('/remote/wiki/images/logo.png')
    expect(sftp.rename).toHaveBeenCalledWith('/remote/wiki/images/logo.png', '/remote/wiki/brand/logo.png')
  })

  it('uses the canonical OKF path for bulk Markdown exports without changing asset paths', async () => {
    const page = markdownPage()
    const query = {
      column: vi.fn(function () { return this }),
      select: vi.fn(function () { return this }),
      from: vi.fn(function () { return this }),
      where: vi.fn(function () { return this }),
      join: vi.fn(function () { return this }),
      stream: vi.fn()
        .mockReturnValueOnce(Readable.from([{ ...page, tags: undefined }]))
        .mockReturnValueOnce(Readable.from([{ filename: 'logo.png', folderId: 2, data: Buffer.from('asset') }]))
    }
    global.WIKI.models.knex = query
    global.WIKI.models.pages = {
      query: vi.fn(() => ({
        findOne: vi.fn().mockResolvedValue({
          $relatedQuery: vi.fn().mockResolvedValue([{ tag: 'storage' }])
        })
      }))
    }
    global.WIKI.models.assetFolders = { getAllPaths: vi.fn().mockResolvedValue({ 2: 'images' }) }

    await plugin.exportAll.call(context)

    expect(sftp.writeFile.mock.calls.map(([filePath]) => filePath)).toEqual([
      '/remote/wiki/fr/guides/index.concept.md',
      '/remote/wiki/images/logo.png'
    ])
  })
})
