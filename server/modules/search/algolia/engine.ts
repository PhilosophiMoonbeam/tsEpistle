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

interface AlgoliaObject extends UnknownRecord {
  content: string
  description: string
  locale: string
  objectID: string
  path: string
  pathScopes: string[]
  title: string
}

const isAlgoliaIndexRow = (value: unknown): value is AlgoliaIndexRow =>
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

const pathScopes = (path: string): string[] => path.split('/').map((_segment, index, segments) => segments.slice(0, index + 1).join('/'))

const algoliaFilters = (options: SearchOptions): string | undefined => {
  const filters = []
  if (options.locale) filters.push(`locale:${JSON.stringify(options.locale)}`)
  if (options.path) filters.push(`pathScopes:${JSON.stringify(options.path)}`)
  return filters.length > 0 ? filters.join(' AND ') : undefined
}

const toAlgoliaObject = (row: AlgoliaIndexRow): AlgoliaObject => ({
  objectID: row.id,
  locale: row.locale,
  path: row.path,
  pathScopes: pathScopes(row.path),
  title: row.title,
  description: row.description,
  content: wiki.models.pages.cleanHTML(row.render)
})

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
        searchableAttributes: ['title', 'description', 'content'],
        attributesToRetrieve: ['locale', 'path', 'title', 'description'],
        attributesForFaceting: ['filterOnly(locale)', 'filterOnly(pathScopes)'],
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
  async query(q: string, opts: SearchOptions): Promise<SearchResult> {
    try {
      const results = await this.client.searchSingleIndex<AlgoliaHit>({
        indexName: this.config.indexName,
        searchParams: {
          query: q,
          filters: algoliaFilters(opts),
          hitsPerPage: wiki.config.search.maxHits
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
      throw err
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
        pathScopes: pathScopes(page.path),
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
        pathScopes: pathScopes(page.destinationPath),
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
    const MAX_DOCUMENT_BYTES = 10 * 2 ** 10
    const objects: AlgoliaObject[] = []
    const rows = wiki.models.knex
      .column({ id: 'hash' }, 'path', { locale: 'localeCode' }, 'title', 'description', 'render')
      .select()
      .from('pages')
      .where({
        isPublished: true,
        visibility: 'public'
      })
      .stream()

    for await (const row of rows) {
      if (!isAlgoliaIndexRow(row)) throw new Error('Algolia Search index row is invalid')
      const object = toAlgoliaObject(row)
      if (Buffer.byteLength(JSON.stringify(object)) >= MAX_DOCUMENT_BYTES) {
        throw new Error('Document exceeds maximum size allowed by Algolia.')
      }
      objects.push(object)
    }

    await this.client.replaceAllObjects({
      indexName: this.config.indexName,
      objects,
      batchSize: 1000
    })
    wiki.logger.info(`(SEARCH/ALGOLIA) Index rebuilt successfully.`)
  }
}

export default plugin
