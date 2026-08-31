import { Readable } from 'node:stream'
import { describe, expect, it } from '../bun-test.mts'

const bulkPage = {
  id: 9,
  path: 'reference/index',
  localeCode: 'es',
  title: 'Reference index',
  description: '',
  contentType: 'markdown',
  content: 'Bulk body',
  sourceRevision: '3',
  authorId: 4,
  extra: {},
  isPublished: true,
  updatedAt: '2026-08-30T00:00:00.000Z',
  createdAt: '2026-08-29T00:00:00.000Z',
  editorKey: 'markdown'
}

const knex = {
  column(...columns: string[]) {
    const rows = columns[0] === 'id' ? [bulkPage] : []
    const chain = {
      select: () => chain,
      from: () => chain,
      where: () => chain,
      join: () => chain,
      stream: () => Readable.from(rows)
    }
    return chain
  }
}

Reflect.set(globalThis, 'WIKI', {
  config: { lang: { code: 'en', namespacing: false } },
  data: { reservedPaths: [] },
  logger: { info() {}, warn() {}, error() {} },
  models: {
    knex,
    pages: {
      query: () => ({
        findOne: async () => ({ $relatedQuery: async () => [] })
      })
    },
    assetFolders: { getAllPaths: async () => ({}) }
  }
})

// Dynamic import is intentional: storage modules capture the WIKI global during initialization.
const { default: plugin } = await import('../../modules/storage/azure/storage.ts')

const markdownPage = {
  ...bulkPage,
  id: 1,
  path: 'guides/index',
  localeCode: 'fr',
  title: 'Guide index',
  content: 'See [this guide](/fr/guides/index).',
  destinationPath: 'index',
  destinationLocaleCode: 'de'
}

const legacyPage = {
  ...markdownPage,
  contentType: 'html',
  content: '<p>Legacy</p>',
  editorKey: 'code'
}

const storageContext = () => {
  const keys: string[] = []
  const uploads: Array<{ key: string; content: string | Uint8Array }> = []
  const copies: Array<{ key: string; source: string }> = []
  const deletions: string[] = []
  const container = {
    getBlockBlobClient(key: string) {
      keys.push(key)
      return {
        url: `https://storage.invalid/container/${key}`,
        upload: async (content: string | Uint8Array) => { uploads.push({ key, content }) },
        syncCopyFromURL: async (source: string) => { copies.push({ key, source }) },
        delete: async () => { deletions.push(key) }
      }
    }
  }
  return {
    context: {
      config: { pathPrefix: ' /tenant/../wiki ', storageTier: 'Hot' },
      container,
      storageName: 'AZURE'
    },
    keys,
    uploads,
    copies,
    deletions
  }
}

describe('Azure storage canonical OKF object paths', () => {
  it('uses locale-qualified reserved Markdown paths for create, update, delete, and rename', async () => {
    const recorded = storageContext()
    const context = recorded.context as never
    const page = markdownPage as never

    await plugin.created.call(context, page)
    await plugin.updated.call(context, page)
    await plugin.deleted.call(context, page)
    await plugin.renamed.call(context, page)

    expect(recorded.keys).toEqual([
      'tenant/wiki/fr/guides/index.concept.md',
      'tenant/wiki/fr/guides/index.concept.md',
      'tenant/wiki/fr/guides/index.concept.md',
      'tenant/wiki/fr/guides/index.concept.md',
      'tenant/wiki/de/index.concept.md'
    ])
    expect(recorded.uploads).toHaveLength(2)
    expect(String(recorded.uploads[0]?.content)).toContain('[this guide](/fr/guides/index.concept.md)')
    expect(recorded.copies).toEqual([{
      key: 'tenant/wiki/de/index.concept.md',
      source: 'https://storage.invalid/container/tenant/wiki/fr/guides/index.concept.md'
    }])
    expect(recorded.deletions).toEqual([
      'tenant/wiki/fr/guides/index.concept.md',
      'tenant/wiki/fr/guides/index.concept.md'
    ])
  })

  it('uses canonical Markdown paths during bulk export', async () => {
    const recorded = storageContext()

    await plugin.exportAll.call(recorded.context as never)

    expect(recorded.keys).toEqual(['tenant/wiki/es/reference/index.concept.md'])
    expect(recorded.uploads).toHaveLength(1)
  })

  it('retains legacy non-Markdown and asset object paths', async () => {
    const recorded = storageContext()
    const context = recorded.context as never

    await plugin.created.call(context, legacyPage as never)
    await plugin.assetUploaded.call(context, {
      path: '/images/logo.png',
      data: Buffer.from('image')
    } as never)

    expect(recorded.keys).toEqual([
      'tenant/wiki/guides/index.html',
      'tenant/wiki/images/logo.png'
    ])
  })
})
