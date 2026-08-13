import {
  wiki,
  type SearchConfig,
  type SearchContext,
  type SearchOptions,
  type SearchPlugin,
  type SearchResult,
  type UnknownRecord,
  type WikiPage
} from '../../types.ts'
import _ from 'lodash'
import { algoliasearch, type SearchClient } from 'algoliasearch'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'

type AlgoliaSearchContext = SearchContext<SearchConfig, SearchClient>

interface AlgoliaHit {
  description: string
  locale: string
  objectID: string
  path: string
  title: string
}

interface AlgoliaIndexRow extends UnknownRecord {
  description: string
  id: string
  locale: string
  path: string
  render: string
  title: string
}

const isAlgoliaIndexRow = (value: unknown): value is AlgoliaIndexRow => (
  typeof value === 'object' &&
  value !== null &&
  'description' in value &&
  typeof value.description === 'string' &&
  'id' in value &&
  typeof value.id === 'string' &&
  'locale' in value &&
  typeof value.locale === 'string' &&
  'path' in value &&
  typeof value.path === 'string' &&
  'render' in value &&
  typeof value.render === 'string' &&
  'title' in value &&
  typeof value.title === 'string'
)


const plugin: SearchPlugin<SearchConfig, AlgoliaSearchContext> = {
  async activate() {
    // not used
  },
  async deactivate() {
    // not used
  },
  /**
   * INIT
   */
  async init() {
    wiki.logger.info(`(SEARCH/ALGOLIA) Initializing...`)
    this.client = algoliasearch(this.config.appId, this.config.apiKey)

    // -> Create Search Index
    wiki.logger.info(`(SEARCH/ALGOLIA) Setting index configuration...`)
    await this.client.setSettings({
      indexName: this.config.indexName,
      indexSettings: {
        searchableAttributes: [
          'title',
          'description',
          'content'
        ],
        attributesToRetrieve: [
          'locale',
          'path',
          'title',
          'description'
        ],
        advancedSyntax: true
      }
    })
    wiki.logger.info(`(SEARCH/ALGOLIA) Initialization completed.`)
  },
  /**
   * QUERY
   *
   * @param {String} q Query
   * @param {Object} opts Additional options
   */
  async query(q: string, _opts: SearchOptions): Promise<SearchResult | void> {
    void _opts
    try {
      const results = await this.client.searchSingleIndex<AlgoliaHit>({
        indexName: this.config.indexName,
        searchParams: {
          query: q,
          hitsPerPage: 50
        }
      })
      return {
        results: _.map(results.hits, r => ({
          id: r.objectID,
          locale: r.locale,
          path: r.path,
          title: r.title,
          description: r.description
        })),
        suggestions: [],
        totalHits: results.nbHits ?? 0
      }
    } catch (err: unknown) {
      wiki.logger.warn('Search Engine Error:')
      wiki.logger.warn(err instanceof Error ? err.message : String(err))
    }
  },
  /**
   * CREATE
   *
   * @param {Object} page Page to create
   */
  async created(page: WikiPage): Promise<void> {
    await this.client.saveObject({
      indexName: this.config.indexName,
      body: {
        objectID: page.hash,
        locale: page.localeCode,
        path: page.path,
        title: page.title,
        description: page.description,
        content: page.safeContent
      }
    })
  },
  /**
   * UPDATE
   *
   * @param {Object} page Page to update
   */
  async updated(page: WikiPage): Promise<void> {
    await this.client.partialUpdateObject({
      indexName: this.config.indexName,
      objectID: page.hash,
      attributesToUpdate: {
        title: page.title,
        description: page.description,
        content: page.safeContent
      },
      createIfNotExists: false
    })
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted(page: WikiPage): Promise<void> {
    await this.client.deleteObject({ indexName: this.config.indexName, objectID: page.hash })
  },
  /**
   * RENAME
   *
   * @param {Object} page Page to rename
   */
  async renamed(page: WikiPage): Promise<void> {
    await this.client.deleteObject({ indexName: this.config.indexName, objectID: page.hash })
    await this.client.saveObject({
      indexName: this.config.indexName,
      body: {
        objectID: page.destinationHash,
        locale: page.destinationLocaleCode,
        path: page.destinationPath,
        title: page.title,
        description: page.description,
        content: page.safeContent
      }
    })
  },
  /**
   * REBUILD INDEX
   */
  async rebuild() {
    wiki.logger.info(`(SEARCH/ALGOLIA) Rebuilding Index...`)
    await this.client.clearObjects({ indexName: this.config.indexName })

    const MAX_DOCUMENT_BYTES = 10 * Math.pow(2, 10) // 10 KB
    const MAX_INDEXING_BYTES = 10 * Math.pow(2, 20) - Buffer.from('[').byteLength - Buffer.from(']').byteLength // 10 MB
    const MAX_INDEXING_COUNT = 1000
    const COMMA_BYTES = Buffer.from(',').byteLength

    const chunks: AlgoliaIndexRow[] = []
    let bytes = 0

    const processDocument = async (cb: TransformCallback, doc?: unknown): Promise<void> => {
      try {
        if (doc) {
          if (!isAlgoliaIndexRow(doc)) {
            throw new Error('Algolia Search index row is invalid')
          }
          const docBytes = Buffer.from(JSON.stringify(doc)).byteLength
          // -> Document too large
          if (docBytes >= MAX_DOCUMENT_BYTES) {
            throw new Error('Document exceeds maximum size allowed by Algolia.')
          }

          // -> Current batch exceeds size hard limit, flush
          if (docBytes + COMMA_BYTES + bytes >= MAX_INDEXING_BYTES) {
            await flushBuffer()
          }

          if (chunks.length > 0) {
            bytes += COMMA_BYTES
          }
          bytes += docBytes
          chunks.push(doc)

          // -> Current batch exceeds count soft limit, flush
          if (chunks.length >= MAX_INDEXING_COUNT) {
            await flushBuffer()
          }
        } else {
          // -> End of stream, flush
          await flushBuffer()
        }
        cb()
      } catch (err: unknown) {
        cb(err instanceof Error ? err : new Error(String(err)))
      }
    }

    const flushBuffer = async (): Promise<void> => {
      wiki.logger.info(`(SEARCH/ALGOLIA) Sending batch of ${chunks.length}...`)
      try {
        await this.client.saveObjects({
          indexName: this.config.indexName,
          objects: _.map(chunks, doc => ({
            objectID: doc.id,
            locale: doc.locale,
            path: doc.path,
            title: doc.title,
            description: doc.description,
            content: wiki.models.pages.cleanHTML(doc.render)
          }))
        })
      } catch (err: unknown) {
        wiki.logger.warn('(SEARCH/ALGOLIA) Failed to send batch to Algolia: ', err)
      }
      chunks.length = 0
      bytes = 0
    }

    await pipeline(
      wiki.models.knex.column({ id: 'hash' }, 'path', { locale: 'localeCode' }, 'title', 'description', 'render').select().from('pages').where({
        isPublished: true,
        isPrivate: false
      }).stream(),
      new Transform({
        objectMode: true,
        transform: (chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          void processDocument(callback, chunk)
        },
        flush: (callback: TransformCallback) => {
          void processDocument(callback)
        }
      })
    )
    wiki.logger.info(`(SEARCH/ALGOLIA) Index rebuilt successfully.`)
  }
}

export default plugin
