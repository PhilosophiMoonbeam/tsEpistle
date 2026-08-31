import { Readable } from 'node:stream'
import { encodeS3CopySource, storageObjectKey } from '../../modules/storage/object-key.ts'

describe('cloud storage object keys', () => {
  beforeEach(() => {
    vi.resetModules()
    global.WIKI = {
      config: { lang: { code: 'en', namespacing: true } },
      logger: { info: vi.fn() },
      models: {}
    }
  })

  it('normalizes optional prefixes without accepting traversal segments', () => {
    expect(storageObjectKey(' /wiki//./../archive/ ', '/images/logo.png')).toBe('wiki/archive/images/logo.png')
    expect(storageObjectKey('', 'guide/start.md')).toBe('guide/start.md')
  })

  it('encodes every S3 copy-source segment while preserving path separators', () => {
    expect(encodeS3CopySource('wiki-bucket', 'archive/a #+b.md')).toBe('wiki-bucket/archive/a%20%23%2Bb.md')
  })

  it('uses canonical OKF keys for Markdown page events and rewritten links', async () => {
    const S3CompatibleStorage = (await vi.importFresh('../../modules/storage/s3/common.ts', import.meta.url)).default
    const storage = new S3CompatibleStorage('S3')
    storage.config = { accessKeyId: '', bucket: 'wiki-bucket', pathPrefix: '/archive/', secretAccessKey: '' }
    storage.bucketName = 'wiki-bucket'
    storage.s3 = { send: vi.fn().mockResolvedValue({}) }
    const page = {
      id: 1,
      path: 'guides/start',
      localeCode: 'en',
      title: 'Guide',
      description: '',
      contentType: 'markdown',
      content: 'See [Index](/en/guides/index).',
      sourceRevision: 1,
      authorId: 7,
      extra: {},
      isPublished: true,
      updatedAt: '2026-08-31T00:00:00.000Z',
      createdAt: '2026-08-30T00:00:00.000Z',
      editorKey: 'markdown',
      tags: []
    }

    await storage.created(page)
    await storage.updated({ ...page, path: 'guides/index' })
    await storage.deleted({ ...page, path: 'guides/log' })

    const [created, updated, deleted] = storage.s3.send.mock.calls.map(([command]) => command.input)
    expect(created.Key).toBe('archive/en/guides/start.md')
    expect(created.Body.toString('utf8')).toContain('(/en/guides/index.concept.md)')
    expect(updated.Key).toBe('archive/en/guides/index.concept.md')
    expect(deleted).toEqual({ Bucket: 'wiki-bucket', Key: 'archive/en/guides/log.concept.md' })
  })

  it.each([
    ['S3', '../../modules/storage/s3/storage.ts'],
    ['S3Generic', '../../modules/storage/s3generic/storage.ts'],
    ['Digitalocean', '../../modules/storage/digitalocean/storage.ts']
  ])('uses canonical OKF rename keys and an encoded CopySource for %s', async (_name, modulePath) => {
    const storage = (await vi.importFresh(modulePath, import.meta.url)).default
    storage.config = { accessKeyId: '', bucket: 'wiki-bucket', pathPrefix: '/archive/', secretAccessKey: '' }
    storage.bucketName = 'wiki-bucket'
    storage.s3 = { send: vi.fn().mockResolvedValue({}) }

    await storage.renamed({
      contentType: 'markdown',
      destinationLocaleCode: 'fr',
      destinationPath: 'guide/index',
      localeCode: 'en',
      path: 'guide/a #+b'
    })

    const [copy, remove] = storage.s3.send.mock.calls.map(([command]) => command.input)
    expect(copy).toEqual({
      Bucket: 'wiki-bucket',
      CopySource: 'wiki-bucket/archive/en/guide/a%20%23%2Bb.md',
      Key: 'archive/fr/guide/index.concept.md'
    })
    expect(remove).toEqual({ Bucket: 'wiki-bucket', Key: 'archive/en/guide/a #+b.md' })
  })

  it('retains legacy non-Markdown paths and asset object keys', async () => {
    const S3CompatibleStorage = (await vi.importFresh('../../modules/storage/s3/common.ts', import.meta.url)).default
    const storage = new S3CompatibleStorage('S3')
    storage.config = { accessKeyId: '', bucket: 'wiki-bucket', pathPrefix: '/archive/', secretAccessKey: '' }
    storage.bucketName = 'wiki-bucket'
    storage.s3 = { send: vi.fn().mockResolvedValue({}) }

    await storage.renamed({
      contentType: 'html',
      destinationLocaleCode: 'fr',
      destinationPath: 'legacy/destination',
      localeCode: 'en',
      path: 'legacy/source'
    })
    await storage.assetUploaded({ path: 'images/logo #.png', data: Buffer.from('logo') })
    await storage.assetDeleted({ path: 'images/logo #.png' })
    await storage.assetRenamed({ path: 'images/old #.png', destinationPath: 'images/new +.png' })

    const [pageCopy, pageRemove, assetPut, assetRemove, assetCopy, oldAssetRemove] = storage.s3.send.mock.calls.map(([command]) => command.input)
    expect(pageCopy).toEqual({
      Bucket: 'wiki-bucket',
      CopySource: 'wiki-bucket/archive/legacy/source.html',
      Key: 'archive/fr/legacy/destination.html'
    })
    expect(pageRemove).toEqual({ Bucket: 'wiki-bucket', Key: 'archive/legacy/source.html' })
    expect(assetPut).toMatchObject({ Bucket: 'wiki-bucket', Key: 'archive/images/logo #.png' })
    expect(assetRemove).toEqual({ Bucket: 'wiki-bucket', Key: 'archive/images/logo #.png' })
    expect(assetCopy).toEqual({
      Bucket: 'wiki-bucket',
      CopySource: 'wiki-bucket/archive/images/old%20%23.png',
      Key: 'archive/images/new +.png'
    })
    expect(oldAssetRemove).toEqual({ Bucket: 'wiki-bucket', Key: 'archive/images/old #.png' })
  })

  it('uses canonical OKF keys for bulk Markdown while retaining other bulk paths', async () => {
    const S3CompatibleStorage = (await vi.importFresh('../../modules/storage/s3/common.ts', import.meta.url)).default
    const storage = new S3CompatibleStorage('S3')
    storage.config = { accessKeyId: '', bucket: 'wiki-bucket', pathPrefix: '/archive/', secretAccessKey: '' }
    storage.bucketName = 'wiki-bucket'
    storage.s3 = { send: vi.fn().mockResolvedValue({}) }
    const basePage = {
      localeCode: 'en',
      title: 'Page',
      description: '',
      sourceRevision: 1,
      authorId: 7,
      extra: {},
      isPublished: true,
      updatedAt: '2026-08-31T00:00:00.000Z',
      createdAt: '2026-08-30T00:00:00.000Z',
      editorKey: 'markdown'
    }
    const pageSource = Readable.from([
      { ...basePage, id: 1, path: 'guides/index', contentType: 'markdown', content: 'Index' },
      { ...basePage, id: 2, path: 'legacy', contentType: 'html', content: '<p>Legacy</p>' }
    ])
    const query = {
      column: vi.fn(function () { return this }),
      select: vi.fn(function () { return this }),
      from: vi.fn(function () { return this }),
      where: vi.fn(function () { return this }),
      join: vi.fn(function () { return this }),
      stream: vi.fn()
        .mockReturnValueOnce(pageSource)
        .mockReturnValueOnce(Readable.from([{ filename: 'logo.png', folderId: 2, data: Buffer.from('logo') }]))
    }
    global.WIKI.models.knex = query
    global.WIKI.models.pages = {
      query: vi.fn(() => ({
        findOne: vi.fn().mockResolvedValue({
          $relatedQuery: vi.fn().mockResolvedValue([])
        })
      }))
    }
    global.WIKI.models.assetFolders = { getAllPaths: vi.fn().mockResolvedValue({ 2: 'images' }) }

    await storage.exportAll()

    const [markdown, html, asset] = storage.s3.send.mock.calls.map(([command]) => command.input)
    expect(markdown.Key).toBe('archive/en/guides/index.concept.md')
    expect(html.Key).toBe('archive/legacy.html')
    expect(asset).toMatchObject({ Bucket: 'wiki-bucket', Key: 'archive/images/logo.png' })
  })
})
