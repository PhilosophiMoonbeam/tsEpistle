import {
  wiki,
  type SearchConfig,
  type SearchContext,
  type SearchPlugin,
  type UnknownRecord
} from '../../types.ts'
import _ from 'lodash'
import { SearchService } from 'azure-search-client'
import { FieldType, IndexAction, QueryType, SuggestSearchMode } from 'azure-search-types'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'

interface AzureSuggestion {
  queryPlusText: string
}

interface AzureSuggestResponse {
  value: AzureSuggestion[]
}
interface AzureIndexRow extends UnknownRecord {
  description: string
  id: string
  locale: string
  path: string
  render: string
  title: string
}

type AzureSearchContext = SearchContext<SearchConfig, SearchService>

const isAzureIndexRow = (value: unknown): value is AzureIndexRow => (
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


const isSuggestResponse = (value: unknown): value is AzureSuggestResponse => {
  if (typeof value !== 'object' || value === null || !('value' in value) || !Array.isArray(value.value)) {
    return false
  }
  return value.value.every(suggestion => (
    typeof suggestion === 'object' &&
    suggestion !== null &&
    'queryPlusText' in suggestion &&
    typeof suggestion.queryPlusText === 'string'
  ))
}


const plugin: SearchPlugin<SearchConfig, AzureSearchContext> = {
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
    wiki.logger.info(`(SEARCH/AZURE) Initializing...`)
    this.client = new SearchService(this.config.serviceName, this.config.adminKey)

    // -> Create Search Index
    const indexes = await this.client.indexes.list()
    if (!_.find(_.get(indexes, 'result.value', []), ['name', this.config.indexName])) {
      wiki.logger.info(`(SEARCH/AZURE) Creating index...`)
      await this.client.indexes.create({
        name: this.config.indexName,
        fields: [
          {
            name: 'id',
            type: FieldType.string,
            key: true,
            searchable: false
          },
          {
            name: 'locale',
            type: FieldType.string,
            searchable: false
          },
          {
            name: 'path',
            type: FieldType.string,
            searchable: false
          },
          {
            name: 'title',
            type: FieldType.string,
            searchable: true
          },
          {
            name: 'description',
            type: FieldType.string,
            searchable: true
          },
          {
            name: 'content',
            type: FieldType.string,
            searchable: true
          }
        ],
        scoringProfiles: [
          {
            name: 'fieldWeights',
            text: {
              weights: {
                title: 4,
                description: 3,
                content: 1
              }
            }
          }
        ],
        suggesters: [
          {
            name: 'suggestions',
            searchMode: SuggestSearchMode.analyzingInfixMatching,
            sourceFields: ['title', 'description', 'content']
          }
        ]
      })
    }
    wiki.logger.info(`(SEARCH/AZURE) Initialization completed.`)
  },
  /**
   * QUERY
   *
   * @param {String} q Query
   * @param {Object} opts Additional options
   */
  async query(q, _opts) {
    void _opts
    try {
      let suggestions: string[] = []
      const results = await this.client.indexes.use(this.config.indexName).search({
        count: true,
        scoringProfile: 'fieldWeights',
        search: q,
        select: 'id, locale, path, title, description',
        queryType: QueryType.simple,
        top: 50
      })
      if (results.result.value.length < 5) {
        // Using plain request, not yet available in library...
        try {
          const endpoint = new URL(`https://${this.config.serviceName}.search.windows.net/indexes/${this.config.indexName}/docs/autocomplete`)
          endpoint.searchParams.set('api-version', '2017-11-11-Preview')
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'api-key': this.config.adminKey,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              autocompleteMode: 'oneTermWithContext',
              search: q,
              suggesterName: 'suggestions'
            })
          })
          if (!response.ok) {
            throw new Error(`Azure Search autocomplete failed with HTTP ${response.status}`)
          }
          const suggestResults: unknown = await response.json()
          if (!isSuggestResponse(suggestResults)) {
            throw new Error('Azure Search autocomplete returned an invalid response')
          }
          suggestions = suggestResults.value.map(suggestion => suggestion.queryPlusText)
        } catch (err: unknown) {
          wiki.logger.warn('Search Engine suggestion failure: ', err instanceof Error ? err.message : String(err))
        }
      }
      return {
        results: results.result.value,
        suggestions,
        totalHits: results.result['@odata.count'] ?? 0
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
  async created(page) {
    await this.client.indexes.use(this.config.indexName).index([
      {
        id: page.hash,
        locale: page.localeCode,
        path: page.path,
        title: page.title,
        description: page.description,
        content: page.safeContent
      }
    ])
  },
  /**
   * UPDATE
   *
   * @param {Object} page Page to update
   */
  async updated(page) {
    await this.client.indexes.use(this.config.indexName).index([
      {
        id: page.hash,
        locale: page.localeCode,
        path: page.path,
        title: page.title,
        description: page.description,
        content: page.safeContent
      }
    ])
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted(page) {
    await this.client.indexes.use(this.config.indexName).index([
      {
        '@search.action': IndexAction.delete,
        id: page.hash
      }
    ])
  },
  /**
   * RENAME
   *
   * @param {Object} page Page to rename
   */
  async renamed(page) {
    await this.client.indexes.use(this.config.indexName).index([
      {
        '@search.action': IndexAction.delete,
        id: page.hash
      }
    ])
    await this.client.indexes.use(this.config.indexName).index([
      {
        id: page.destinationHash,
        locale: page.destinationLocaleCode,
        path: page.destinationPath,
        title: page.title,
        description: page.description,
        content: page.safeContent
      }
    ])
  },
  /**
   * REBUILD INDEX
   */
  async rebuild() {
    wiki.logger.info(`(SEARCH/AZURE) Rebuilding Index...`)
    await pipeline(
      wiki.models.knex.column({ id: 'hash' }, 'path', { locale: 'localeCode' }, 'title', 'description', 'render').select().from('pages').where({
        isPublished: true,
        isPrivate: false
      }).stream(),
      new Transform({
        objectMode: true,
        transform: (chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          if (!isAzureIndexRow(chunk)) {
            callback(new Error('Azure Search index row is invalid'))
            return
          }
          callback(null, {
            id: chunk.id,
            path: chunk.path,
            locale: chunk.locale,
            title: chunk.title,
            description: chunk.description,
            content: wiki.models.pages.cleanHTML(chunk.render)
          })
        }
      }),
      this.client.indexes.use(this.config.indexName).createIndexingStream()
    )
    wiki.logger.info(`(SEARCH/AZURE) Index rebuilt successfully.`)
  }
}

export default plugin
