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
import {
  CloudSearchClient,
  DefineAnalysisSchemeCommand,
  DefineIndexFieldCommand,
  DefineSuggesterCommand,
  DescribeAnalysisSchemesCommand,
  DescribeIndexFieldsCommand,
  DescribeSuggestersCommand,
  IndexDocumentsCommand,
  type AnalysisSchemeLanguage
} from '@aws-sdk/client-cloudsearch'
import {
  CloudSearchDomainClient,
  SearchCommand,
  SuggestCommand,
  UploadDocumentsCommand,
  type Hit
} from '@aws-sdk/client-cloudsearch-domain'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'

interface AwsSearchConfig extends SearchConfig {
  AnalysisSchemeLang: AnalysisSchemeLanguage
}

interface AwsSearchContext extends SearchContext<AwsSearchConfig, CloudSearchClient> {
  clientDomain: CloudSearchDomainClient
}

interface AwsSearchHit {
  description: string
  id: string | undefined
  locale: string | undefined
  path: string | undefined
  title: string
}

interface AwsIndexRow extends UnknownRecord {
  description: string
  id: string
  locale: string
  path: string
  render: string
  title: string
}

const isAwsIndexRow = (value: unknown): value is AwsIndexRow => (
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

const formatSearchHit = (hit: Hit): AwsSearchHit => {
  if (!hit.fields) {
    throw new Error('AWS CloudSearch hit is missing its fields')
  }
  return {
    id: hit.id,
    path: _.head(hit.fields.path),
    locale: _.head(hit.fields.locale),
    title: _.head(hit.fields.title) || '',
    description: _.head(hit.fields.description) || ''
  }
}


const plugin: SearchPlugin<AwsSearchConfig, AwsSearchContext> = {
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
    wiki.logger.info(`(SEARCH/AWS) Initializing...`)
    const credentials = this.config.accessKeyId && this.config.secretAccessKey
      ? {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey
        }
      : undefined
    this.client = new CloudSearchClient({
      region: this.config.region,
      ...(credentials ? { credentials } : {})
    })
    this.clientDomain = new CloudSearchDomainClient({
      endpoint: this.config.endpoint,
      region: this.config.region,
      ...(credentials ? { credentials } : {})
    })

    let rebuildIndex = false

    // -> Define Analysis Schemes
    const schemes = await this.client.send(new DescribeAnalysisSchemesCommand({
      DomainName: this.config.domain,
      AnalysisSchemeNames: ['default_anlscheme']
    }))
    if (_.get(schemes, 'AnalysisSchemes', []).length < 1) {
      wiki.logger.info(`(SEARCH/AWS) Defining Analysis Scheme...`)
      await this.client.send(new DefineAnalysisSchemeCommand({
        DomainName: this.config.domain,
        AnalysisScheme: {
          AnalysisSchemeLanguage: this.config.AnalysisSchemeLang,
          AnalysisSchemeName: 'default_anlscheme'
        }
      }))
      rebuildIndex = true
    }

    // -> Define Index Fields
    const fields = await this.client.send(new DescribeIndexFieldsCommand({
      DomainName: this.config.domain
    }))
    if (_.get(fields, 'IndexFields', []).length < 1) {
      wiki.logger.info(`(SEARCH/AWS) Defining Index Fields...`)
      await this.client.send(new DefineIndexFieldCommand({
        DomainName: this.config.domain,
        IndexField: {
          IndexFieldName: 'id',
          IndexFieldType: 'literal'
        }
      }))
      await this.client.send(new DefineIndexFieldCommand({
        DomainName: this.config.domain,
        IndexField: {
          IndexFieldName: 'path',
          IndexFieldType: 'literal'
        }
      }))
      await this.client.send(new DefineIndexFieldCommand({
        DomainName: this.config.domain,
        IndexField: {
          IndexFieldName: 'locale',
          IndexFieldType: 'literal'
        }
      }))
      await this.client.send(new DefineIndexFieldCommand({
        DomainName: this.config.domain,
        IndexField: {
          IndexFieldName: 'title',
          IndexFieldType: 'text',
          TextOptions: {
            ReturnEnabled: true,
            AnalysisScheme: 'default_anlscheme'
          }
        }
      }))
      await this.client.send(new DefineIndexFieldCommand({
        DomainName: this.config.domain,
        IndexField: {
          IndexFieldName: 'description',
          IndexFieldType: 'text',
          TextOptions: {
            ReturnEnabled: true,
            AnalysisScheme: 'default_anlscheme'
          }
        }
      }))
      await this.client.send(new DefineIndexFieldCommand({
        DomainName: this.config.domain,
        IndexField: {
          IndexFieldName: 'content',
          IndexFieldType: 'text',
          TextOptions: {
            ReturnEnabled: false,
            AnalysisScheme: 'default_anlscheme'
          }
        }
      }))
      rebuildIndex = true
    }

    // -> Define suggester
    const suggesters = await this.client.send(new DescribeSuggestersCommand({
      DomainName: this.config.domain,
      SuggesterNames: ['default_suggester']
    }))
    if (_.get(suggesters, 'Suggesters', []).length < 1) {
      wiki.logger.info(`(SEARCH/AWS) Defining Suggester...`)
      await this.client.send(new DefineSuggesterCommand({
        DomainName: this.config.domain,
        Suggester: {
          SuggesterName: 'default_suggester',
          DocumentSuggesterOptions: {
            SourceField: 'title',
            FuzzyMatching: 'high'
          }
        }
      }))
      rebuildIndex = true
    }

    // -> Rebuild Index
    if (rebuildIndex) {
      wiki.logger.info(`(SEARCH/AWS) Requesting Index Rebuild...`)
      await this.client.send(new IndexDocumentsCommand({
        DomainName: this.config.domain
      }))
    }

    wiki.logger.info(`(SEARCH/AWS) Initialization completed.`)
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
      let suggestions: string[] = []
      const results = await this.clientDomain.send(new SearchCommand({
        query: q,
        partial: true,
        size: 50
      }))
      const hits = results.hits
      if (!hits || typeof hits.found !== 'number') {
        throw new Error('AWS CloudSearch returned an invalid search response')
      }
      if (hits.found < 5) {
        const suggestResults = await this.clientDomain.send(new SuggestCommand({
          query: q,
          suggester: 'default_suggester',
          size: 5
        }))
        const matches = suggestResults.suggest?.suggestions
        if (!matches) {
          throw new Error('AWS CloudSearch returned an invalid suggestion response')
        }
        suggestions = matches.map(match => {
          if (typeof match.suggestion !== 'string') {
            throw new Error('AWS CloudSearch returned an invalid suggestion')
          }
          return match.suggestion
        })
      }
      return {
        results: (hits.hit ?? []).map(formatSearchHit),
        suggestions,
        totalHits: hits.found
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
    await this.clientDomain.send(new UploadDocumentsCommand({
      contentType: 'application/json',
      documents: JSON.stringify([
        {
          type: 'add',
          id: page.hash,
          fields: {
            locale: page.localeCode,
            path: page.path,
            title: page.title,
            description: page.description,
            content: page.safeContent
          }
        }
      ])
    }))
  },
  /**
   * UPDATE
   *
   * @param {Object} page Page to update
   */
  async updated(page: WikiPage): Promise<void> {
    await this.clientDomain.send(new UploadDocumentsCommand({
      contentType: 'application/json',
      documents: JSON.stringify([
        {
          type: 'add',
          id: page.hash,
          fields: {
            locale: page.localeCode,
            path: page.path,
            title: page.title,
            description: page.description,
            content: page.safeContent
          }
        }
      ])
    }))
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted(page: WikiPage): Promise<void> {
    await this.clientDomain.send(new UploadDocumentsCommand({
      contentType: 'application/json',
      documents: JSON.stringify([
        {
          type: 'delete',
          id: page.hash
        }
      ])
    }))
  },
  /**
   * RENAME
   *
   * @param {Object} page Page to rename
   */
  async renamed(page: WikiPage): Promise<void> {
    await this.clientDomain.send(new UploadDocumentsCommand({
      contentType: 'application/json',
      documents: JSON.stringify([
        {
          type: 'delete',
          id: page.hash
        }
      ])
    }))
    await this.clientDomain.send(new UploadDocumentsCommand({
      contentType: 'application/json',
      documents: JSON.stringify([
        {
          type: 'add',
          id: page.destinationHash,
          fields: {
            locale: page.destinationLocaleCode,
            path: page.destinationPath,
            title: page.title,
            description: page.description,
            content: page.safeContent
          }
        }
      ])
    }))
  },
  /**
   * REBUILD INDEX
   */
  async rebuild() {
    wiki.logger.info(`(SEARCH/AWS) Rebuilding Index...`)

    const MAX_DOCUMENT_BYTES = Math.pow(2, 20)
    const MAX_INDEXING_BYTES = 5 * Math.pow(2, 20) - Buffer.from('[').byteLength - Buffer.from(']').byteLength
    const MAX_INDEXING_COUNT = 1000
    const COMMA_BYTES = Buffer.from(',').byteLength

    const chunks: AwsIndexRow[] = []
    let bytes = 0

    const processDocument = async (cb: TransformCallback, doc?: unknown): Promise<void> => {
      try {
        if (doc) {
          if (!isAwsIndexRow(doc)) {
            throw new Error('AWS CloudSearch index row is invalid')
          }
          const docBytes = Buffer.from(JSON.stringify(doc)).byteLength
          // -> Document too large
          if (docBytes >= MAX_DOCUMENT_BYTES) {
            throw new Error('Document exceeds maximum size allowed by AWS CloudSearch.')
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
      wiki.logger.info(`(SEARCH/AWS) Sending batch of ${chunks.length}...`)
      try {
        await this.clientDomain.send(new UploadDocumentsCommand({
          contentType: 'application/json',
          documents: JSON.stringify(_.map(chunks, doc => ({
            type: 'add',
            id: doc.id,
            fields: {
              locale: doc.locale,
              path: doc.path,
              title: doc.title,
              description: doc.description,
              content: wiki.models.pages.cleanHTML(doc.render)
            }
          })))
        }))
      } catch (err: unknown) {
        wiki.logger.warn('(SEARCH/AWS) Failed to send batch to AWS CloudSearch: ', err)
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

    wiki.logger.info(`(SEARCH/AWS) Requesting Index Rebuild...`)
    await this.client.send(new IndexDocumentsCommand({
      DomainName: this.config.domain
    }))

    wiki.logger.info(`(SEARCH/AWS) Index rebuilt successfully.`)
  }
}

export default plugin
