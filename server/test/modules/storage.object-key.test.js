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

  it('applies the prefix and each locale exactly once when an S3 page is renamed', async () => {
    const S3CompatibleStorage = (await vi.importFresh('../../modules/storage/s3/common.ts', import.meta.url)).default
    const storage = new S3CompatibleStorage('S3')
    storage.config = { accessKeyId: '', bucket: 'wiki-bucket', pathPrefix: '/archive/', secretAccessKey: '' }
    storage.bucketName = 'wiki-bucket'
    storage.s3 = { send: vi.fn().mockResolvedValue({}) }

    await storage.renamed({
      contentType: 'markdown',
      destinationLocaleCode: 'fr',
      destinationPath: 'guide/a #+b',
      localeCode: 'de',
      path: 'guide/start'
    })

    const [copy, remove] = storage.s3.send.mock.calls.map(([command]) => command.input)
    expect(copy).toEqual({
      Bucket: 'wiki-bucket',
      CopySource: 'wiki-bucket/archive/de/guide/start.md',
      Key: 'archive/fr/guide/a #+b.md'
    })
    expect(remove).toEqual({ Bucket: 'wiki-bucket', Key: 'archive/de/guide/start.md' })
  })
})
