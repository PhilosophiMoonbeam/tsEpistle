import {
  AzureKeyCredential,
  SearchClient,
  SearchIndexClient,
  type SearchIndex
} from '@azure/search-documents'
import {
  wiki,
  type SearchConfig,
  type SearchContext,
  type SearchPlugin,
  type UnknownRecord
} from '../../types.ts'

interface AzureDocument {
  content: string
  description: string
  id: string
  locale: string
  path: string
  title: string
}

interface AzureIndexRow extends UnknownRecord {
  description: string
  id: string
  locale: string
  path: string
  render: string
  title: string
}

interface AzureSearchContext extends SearchContext<SearchConfig, SearchClient<AzureDocument>> {
  indexClient: SearchIndexClient
}

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

const toSearchDocument = (page: {
  hash: string
  localeCode: string
  path: string
  title: string
  description: string
  safeContent: string
}): AzureDocument => ({
  id: page.hash,
  locale: page.localeCode,
  path: page.path,
  title: page.title,
  description: page.description,
  content: page.safeContent
})

const indexDefinition = (name: string): SearchIndex => ({
  name,
  fields: [
    { name: 'id', type: 'Edm.String', key: true, searchable: false },
    { name: 'locale', type: 'Edm.String', searchable: false },
    { name: 'path', type: 'Edm.String', searchable: false },
    { name: 'title', type: 'Edm.String', searchable: true },
    { name: 'description', type: 'Edm.String', searchable: true },
    { name: 'content', type: 'Edm.String', searchable: true }
  ],
  scoringProfiles: [{
    name: 'fieldWeights',
    textWeights: {
      weights: {
        title: 4,
        description: 3,
        content: 1
      }
    }
  }],
  suggesters: [{
    name: 'suggestions',
    searchMode: 'analyzingInfixMatching',
    sourceFields: ['title', 'description', 'content']
  }]
})

const plugin: SearchPlugin<SearchConfig, AzureSearchContext> = {
  async activate() {},
  async deactivate() {},

  async init() {
    wiki.logger.info('(SEARCH/AZURE) Initializing...')
    const endpoint = `https://${this.config.serviceName}.search.windows.net`
    const credential = new AzureKeyCredential(this.config.adminKey)
    this.indexClient = new SearchIndexClient(endpoint, credential)
    this.client = new SearchClient<AzureDocument>(endpoint, this.config.indexName, credential)

    let indexExists = false
    for await (const index of this.indexClient.listIndexes()) {
      if (index.name === this.config.indexName) {
        indexExists = true
        break
      }
    }
    if (!indexExists) {
      wiki.logger.info('(SEARCH/AZURE) Creating index...')
      await this.indexClient.createIndex(indexDefinition(this.config.indexName))
    }
    wiki.logger.info('(SEARCH/AZURE) Initialization completed.')
  },

  async query(q) {
    try {
      const response = await this.client.search(q, {
        includeTotalCount: true,
        scoringProfile: 'fieldWeights',
        select: ['id', 'locale', 'path', 'title', 'description'],
        queryType: 'simple',
        top: 50
      })
      const results = []
      for await (const result of response.results) results.push(result.document)

      let suggestions: string[] = []
      if (results.length < 5) {
        try {
          const autocomplete = await this.client.autocomplete(q, 'suggestions', {
            autocompleteMode: 'oneTermWithContext'
          })
          suggestions = autocomplete.results.map(result => result.text)
        } catch (err: unknown) {
          wiki.logger.warn('Search Engine suggestion failure: ', err instanceof Error ? err.message : String(err))
        }
      }
      return {
        results,
        suggestions,
        totalHits: response.count ?? 0
      }
    } catch (err: unknown) {
      wiki.logger.warn('Search Engine Error:')
      wiki.logger.warn(err instanceof Error ? err.message : String(err))
    }
  },

  async created(page) {
    await this.client.uploadDocuments([toSearchDocument(page)])
  },

  async updated(page) {
    await this.client.uploadDocuments([toSearchDocument(page)])
  },

  async deleted(page) {
    await this.client.deleteDocuments('id', [page.hash])
  },

  async renamed(page) {
    await this.client.deleteDocuments('id', [page.hash])
    await this.client.uploadDocuments([{
      id: page.destinationHash,
      locale: page.destinationLocaleCode,
      path: page.destinationPath,
      title: page.title,
      description: page.description,
      content: page.safeContent
    }])
  },

  async rebuild() {
    wiki.logger.info('(SEARCH/AZURE) Rebuilding Index...')
    const documents: AzureDocument[] = []
    const rows = wiki.models.knex.column({ id: 'hash' }, 'path', { locale: 'localeCode' }, 'title', 'description', 'render').select().from('pages').where({
      isPublished: true,
      isPrivate: false
    }).stream()

    for await (const row of rows) {
      if (!isAzureIndexRow(row)) throw new Error('Azure Search index row is invalid')
      documents.push({
        id: row.id,
        path: row.path,
        locale: row.locale,
        title: row.title,
        description: row.description,
        content: wiki.models.pages.cleanHTML(row.render)
      })
      if (documents.length === 1000) {
        await this.client.uploadDocuments(documents)
        documents.length = 0
      }
    }
    if (documents.length > 0) await this.client.uploadDocuments(documents)
    wiki.logger.info('(SEARCH/AZURE) Index rebuilt successfully.')
  }
}

export default plugin
