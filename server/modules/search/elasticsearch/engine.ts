import {
  wiki,
  type SearchConfig,
  type SearchContext,
  type SearchPlugin,
  type SearchResult,
  type UnknownRecord
} from '../../types.ts'
import fs from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'
import { Client as ElasticsearchClient } from '@elastic/elasticsearch'

interface ElasticsearchConfig extends SearchConfig {
  analyzer: string
  hosts: string
  indexName: string
  sniffInterval: number
  sniffOnStart: boolean
  tlsCertPath?: string
  verifyTLSCertificate: boolean
}

type ElasticsearchClientInstance = ElasticsearchClient

interface ElasticsearchSearchContext extends SearchContext<ElasticsearchConfig, ElasticsearchClientInstance> {
  buildSuggest(page: ElasticsearchSuggestPage): ElasticsearchSuggestion[]
  buildTags(id: number): Promise<string[]>
  createIndex(): Promise<void>
}

interface ElasticsearchPlugin extends SearchPlugin<ElasticsearchConfig, ElasticsearchSearchContext> {
  buildSuggest(this: ElasticsearchSearchContext, page: ElasticsearchSuggestPage): ElasticsearchSuggestion[]
  buildTags(this: ElasticsearchSearchContext, id: number): Promise<string[]>
  createIndex(this: ElasticsearchSearchContext): Promise<void>
}

interface ElasticsearchHit {
  _id: string
  _source: {
    description: string
    locale: string
    path: string
    title: string
  }
}

interface ElasticsearchSuggestion {
  input: string
  weight: number
}



interface ElasticsearchSuggestPage {
  description: string
  safeContent: string
  title: string
}
interface ElasticsearchIndexDocument {
  description: string
  id: string
  locale: string
  path: string
  realId: number
  render: string
  safeContent?: string
  tags?: string[]
  title: string
}

interface ElasticsearchBulkAction {
  index: {
    _id: string
    _index: string
  }
}

interface ElasticsearchBulkDocument {
  content: string
  description: string
  locale: string
  path: string
  suggest: ElasticsearchSuggestion[]
  tags: string[]
  title: string
}

type ElasticsearchBulkItem = ElasticsearchBulkAction | ElasticsearchBulkDocument


const getNestedValue = (value: unknown, path: readonly string[]): unknown => {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined
    }
    const record = current as UnknownRecord
    if (!(key in record)) {
      return undefined
    }
    current = record[key]
  }
  return current
}

const isElasticsearchHit = (value: unknown): value is ElasticsearchHit => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('_id' in value) ||
    typeof value._id !== 'string' ||
    !('_source' in value) ||
    typeof value._source !== 'object' ||
    value._source === null
  ) {
    return false
  }
  const source = value._source
  return 'description' in source &&
    typeof source.description === 'string' &&
    'locale' in source &&
    typeof source.locale === 'string' &&
    'path' in source &&
    typeof source.path === 'string' &&
    'title' in source &&
    typeof source.title === 'string'
}

const isElasticsearchIndexDocument = (value: unknown): value is ElasticsearchIndexDocument => (
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
  'realId' in value &&
  typeof value.realId === 'number' &&
  'render' in value &&
  typeof value.render === 'string' &&
  'title' in value &&
  typeof value.title === 'string'
)

const getSuggestionText = (value: unknown): string | false => {
  const text = getNestedValue(value, ['options', '0', 'text'])
  return typeof text === 'string' ? text : false
}

const getTotalHits = (value: unknown): number => {
  const total = getNestedValue(value, ['hits', 'total', 'value'])
  if (typeof total === 'number') return total
  const fallback = getNestedValue(value, ['hits', 'total'])
  return typeof fallback === 'number' ? fallback : 0
}

const elasticsearchIndexExists = async (client: ElasticsearchClientInstance, index: string): Promise<boolean> => {
  return client.indices.exists({ index })
}

const createElasticsearchIndex = async (
  client: ElasticsearchClientInstance,
  index: string,
  analyzer: string
): Promise<void> => {
  await client.indices.create({
    index,
    mappings: {
      properties: {
        suggest: { type: 'completion' },
        title: { type: 'text' },
        description: { type: 'text' },
        content: { type: 'text' },
        locale: { type: 'keyword' },
        path: { type: 'text' },
        tags: { type: 'text' }
      }
    },
    settings: {
      'analysis.analyzer.default.type': analyzer
    }
  })
}

const searchElasticsearch = async (
  client: ElasticsearchClientInstance,
  index: string,
  query: string
): Promise<unknown> => {
  return client.search<ElasticsearchHit['_source']>({
      index,
      query: {
        simple_query_string: {
          query: `*${query}*`,
          fields: ['title^20', 'description^3', 'tags^8', 'content^1'],
          default_operator: 'and',
          analyze_wildcard: true
        }
      },
      from: 0,
      size: 50,
      _source: ['title', 'description', 'path', 'locale'],
      suggest: {
        suggestions: {
          text: query,
          completion: {
            field: 'suggest',
            size: 5,
            skip_duplicates: true,
            fuzzy: {}
          }
        }
      }
    })
}

const indexElasticsearchDocument = async (
  client: ElasticsearchClientInstance,
  index: string,
  id: string,
  document: ElasticsearchBulkDocument
): Promise<void> => {
  await client.index({ index, id, document, refresh: true })
}

const deleteElasticsearchDocument = async (
  client: ElasticsearchClientInstance,
  index: string,
  id: string
): Promise<void> => {
  await client.delete({ index, id, refresh: true })
}

const deleteElasticsearchIndex = async (client: ElasticsearchClientInstance, index: string): Promise<void> => {
  await client.indices.delete({ index })
}

const bulkIndexElasticsearchDocuments = async (
  client: ElasticsearchClientInstance,
  index: string,
  body: ElasticsearchBulkItem[]
): Promise<void> => {
  await client.bulk({ index, operations: body, refresh: true })
}


const plugin: ElasticsearchPlugin = {
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
    wiki.logger.info(`(SEARCH/ELASTICSEARCH) Initializing...`)
    this.client = new ElasticsearchClient({
      nodes: this.config.hosts.split(',').map(host => host.trim()),
      sniffOnStart: this.config.sniffOnStart,
      sniffInterval: (this.config.sniffInterval > 0) ? this.config.sniffInterval : false,
      tls: getTlsOptions(this.config),
      name: 'wiki-js'
    })

    // -> Create Search Index
    await this.createIndex()

    wiki.logger.info(`(SEARCH/ELASTICSEARCH) Initialization completed.`)
  },
  /**
   * Create Index
   */
  async createIndex() {
    try {
      const indexExists = await elasticsearchIndexExists(this.client, this.config.indexName)
      if (!indexExists) {
        wiki.logger.info(`(SEARCH/ELASTICSEARCH) Creating index...`)
        try {
          await createElasticsearchIndex(this.client, this.config.indexName, this.config.analyzer)
        } catch (err: unknown) {
          wiki.logger.error(`(SEARCH/ELASTICSEARCH) Create Index Error: `, getNestedValue(err, ['meta', 'body', 'error']) ?? err)
        }
      }
    } catch (err: unknown) {
      wiki.logger.error(`(SEARCH/ELASTICSEARCH) Index Check Error: `, getNestedValue(err, ['meta', 'body', 'error']) ?? err)
    }
  },
  /**
   * QUERY
   *
   * @param {String} q Query
   * @param {Object} opts Additional options
   */
  async query(q, _opts): Promise<SearchResult> {
    void _opts
    try {
      const response = await searchElasticsearch(this.client, this.config.indexName, q)
      const hitsValue = getNestedValue(response, ['hits', 'hits'])
      if (!Array.isArray(hitsValue) || !hitsValue.every(isElasticsearchHit)) {
        throw new Error('Elasticsearch returned invalid search hits')
      }
      const suggestionValue = getNestedValue(response, ['suggest', 'suggestions'])
      const suggestionItems = Array.isArray(suggestionValue) ? suggestionValue : []
      return {
        results: hitsValue.map(hit => ({
          id: hit._id,
          locale: hit._source.locale,
          path: hit._source.path,
          title: hit._source.title,
          description: hit._source.description
        })),
        suggestions: suggestionItems.map(getSuggestionText).filter((suggestion): suggestion is string => Boolean(suggestion)),
        totalHits: getTotalHits(response)
      }
    } catch (err: unknown) {
      wiki.logger.warn('Search Engine Error: ', getNestedValue(err, ['meta', 'body', 'error']) ?? err)
      throw err
    }
  },

  /**
   * Build tags field
   * @param id
   * @returns {Promise<*|*[]>}
   */
  async buildTags(id: number): Promise<string[]> {
    const page = await wiki.models.pages.query().findById(id).first('*')
    if (!page) {
      return []
    }
    const tags = await page.$relatedQuery('tags')
    const titles: string[] = []
    for (const tag of tags) {
      if (typeof tag.title === 'string') {
        titles.push(tag.title)
      }
    }
    return titles
  },
  /**
   * Build suggest field
   */
  buildSuggest(page: ElasticsearchSuggestPage): ElasticsearchSuggestion[] {
    return [
      ...page.title.split(' ').map(input => ({
        input,
        weight: 10
      })),
      ...page.description.split(' ').map(input => ({
        input,
        weight: 3
      })),
      ...page.safeContent.split(' ').map(input => ({
        input,
        weight: 1
      }))
    ].filter(suggestion => suggestion.input !== '')
  },
  /**
   * CREATE
   *
   * @param {Object} page Page to create
   */
  async created(page) {
    await indexElasticsearchDocument(this.client, this.config.indexName, page.hash, {
      suggest: this.buildSuggest(page),
      locale: page.localeCode,
      path: page.path,
      title: page.title,
      description: page.description,
      content: page.safeContent,
      tags: await this.buildTags(page.id)
    })
  },
  /**
   * UPDATE
   *
   * @param {Object} page Page to update
   */
  async updated(page) {
    await indexElasticsearchDocument(this.client, this.config.indexName, page.hash, {
      suggest: this.buildSuggest(page),
      locale: page.localeCode,
      path: page.path,
      title: page.title,
      description: page.description,
      content: page.safeContent,
      tags: await this.buildTags(page.id)
    })
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted(page) {
    await deleteElasticsearchDocument(this.client, this.config.indexName, page.hash)
  },
  /**
   * RENAME
   *
   * @param {Object} page Page to rename
   */
  async renamed(page) {
    await deleteElasticsearchDocument(this.client, this.config.indexName, page.hash)
    await indexElasticsearchDocument(this.client, this.config.indexName, page.destinationHash, {
      suggest: this.buildSuggest(page),
      locale: page.destinationLocaleCode,
      path: page.destinationPath,
      title: page.title,
      description: page.description,
      content: page.safeContent,
      tags: await this.buildTags(page.id)
    })
  },
  /**
   * REBUILD INDEX
   */
  async rebuild() {
    wiki.logger.info(`(SEARCH/ELASTICSEARCH) Rebuilding Index...`)
    await deleteElasticsearchIndex(this.client, this.config.indexName)
    await this.createIndex()

    const MAX_INDEXING_BYTES = 10 * 2 ** 20 - Buffer.from('[').byteLength - Buffer.from(']').byteLength // 10 MB
    const MAX_INDEXING_COUNT = 1000
    const COMMA_BYTES = Buffer.from(',').byteLength

    const chunks: ElasticsearchIndexDocument[] = []
    let bytes = 0

    const processDocument = async (callback: TransformCallback, document?: unknown): Promise<void> => {
      try {
        if (document) {
          if (!isElasticsearchIndexDocument(document)) {
            throw new Error('Search index page query returned an invalid row')
          }
          const docBytes = Buffer.from(JSON.stringify(document)).byteLength

          document.tags = await this.buildTags(document.realId)
          // -> Current batch exceeds size limit, flush
          if (docBytes + COMMA_BYTES + bytes >= MAX_INDEXING_BYTES) {
            await flushBuffer()
          }

          if (chunks.length > 0) {
            bytes += COMMA_BYTES
          }
          bytes += docBytes
          chunks.push(document)

          // -> Current batch exceeds count limit, flush
          if (chunks.length >= MAX_INDEXING_COUNT) {
            await flushBuffer()
          }
        } else {
          // -> End of stream, flush
          await flushBuffer()
        }
        callback()
      } catch (err: unknown) {
        callback(err instanceof Error ? err : new Error(String(err)))
      }
    }

    const flushBuffer = async () => {
      wiki.logger.info(`(SEARCH/ELASTICSEARCH) Sending batch of ${chunks.length}...`)
      try {
        const body = chunks.reduce<ElasticsearchBulkItem[]>((result, document) => {
          result.push({
            index: {
              _index: this.config.indexName,
              _id: document.id
            }
          })
          const safeContent = wiki.models.pages.cleanHTML(document.render)
          document.safeContent = safeContent
          if (!document.tags) {
            throw new Error('Search index page is missing tags')
          }
          result.push({
            suggest: this.buildSuggest({ ...document, safeContent }),
            tags: document.tags,
            locale: document.locale,
            path: document.path,
            title: document.title,
            description: document.description,
            content: safeContent
          })
          return result
        }, [])
        await bulkIndexElasticsearchDocuments(this.client, this.config.indexName, body)
      } catch (err: unknown) {
        wiki.logger.warn('(SEARCH/ELASTICSEARCH) Failed to send batch to elasticsearch: ', err)
      }
      chunks.length = 0
      bytes = 0
    }

    // Added real id in order to fetch page tags from the query
    await pipeline(
      wiki.models.knex.column({ id: 'hash' }, 'path', { locale: 'localeCode' }, 'title', 'description', 'render', { realId: 'id' }).select().from('pages').where({
        isPublished: true,
        visibility: 'public'
      }).stream(),
      new Transform({
        objectMode: true,
        transform: async (chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback) => processDocument(callback, chunk),
        flush: async (callback: TransformCallback) => processDocument(callback)
      })
    )
    wiki.logger.info(`(SEARCH/ELASTICSEARCH) Index rebuilt successfully.`)
  }
}

function getTlsOptions(conf: ElasticsearchConfig): { rejectUnauthorized: boolean; ca?: Buffer[] } {
  if (!conf.tlsCertPath) {
    return {
      rejectUnauthorized: conf.verifyTLSCertificate
    }
  }

  const caList: Buffer[] = []
  if (conf.verifyTLSCertificate) {
    caList.push(fs.readFileSync(conf.tlsCertPath))
  }

  return {
    rejectUnauthorized: conf.verifyTLSCertificate,
    ca: caList
  }
}

export default plugin
