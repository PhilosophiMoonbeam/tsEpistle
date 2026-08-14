import {
  wiki,
  type SearchConfig,
  type SearchContext,
  type SearchPlugin,
  type SearchResult,
  type UnknownRecord
} from '../../types.ts'
import tsqueryFactory from 'pg-tsquery'
import { pipeline } from 'node:stream/promises'
import { Transform, type TransformCallback } from 'node:stream'
import type { Knex } from 'knex'

const tsquery = tsqueryFactory()

interface PostgresSearchConfig extends SearchConfig {
  dictLanguage: string
}

type PostgresSearchContext = SearchContext<PostgresSearchConfig>

interface PostgresSearchRow extends UnknownRecord {
  description: string
  id: number
  locale: string
  path: string
  title: string
}

interface PostgresSuggestionRow {
  word: string
}

interface PostgresRawResult<Row> {
  rows: Row[]
}

interface PostgresIndexPage {
  description: string
  localeCode: string
  path: string
  render: string
  title: string
}

const isPostgresIndexPage = (value: unknown): value is PostgresIndexPage => (
  typeof value === 'object' &&
  value !== null &&
  'description' in value &&
  typeof value.description === 'string' &&
  'localeCode' in value &&
  typeof value.localeCode === 'string' &&
  'path' in value &&
  typeof value.path === 'string' &&
  'render' in value &&
  typeof value.render === 'string' &&
  'title' in value &&
  typeof value.title === 'string'
)

const isKnexClient = (value: typeof wiki.models.knex): value is typeof value & Knex => (
  typeof value === 'function' &&
  'transaction' in value &&
  typeof value.transaction === 'function'
)

const getKnexClient = (): Knex => {
  const client = wiki.models.knex
  if (!isKnexClient(client)) {
    throw new Error('PostgreSQL search requires a Knex database client')
  }
  return client
}


const plugin: SearchPlugin<PostgresSearchConfig, PostgresSearchContext> = {
  async activate() {
    if (wiki.config.db.type !== 'postgres') {
      throw new wiki.Error.SearchActivationFailed('Must use PostgreSQL database to activate this engine!')
    }
  },
  async deactivate() {
    wiki.logger.info(`(SEARCH/POSTGRES) Dropping index tables...`)
    await wiki.models.knex.schema.dropTable('pagesWords')
    await wiki.models.knex.schema.dropTable('pagesVector')
    wiki.logger.info(`(SEARCH/POSTGRES) Index tables have been dropped.`)
  },
  /**
   * INIT
   */
  async init() {
    const knex = getKnexClient()
    wiki.logger.info(`(SEARCH/POSTGRES) Initializing...`)

    // -> Ensure pg_trgm extension is available (required for similarity search)
    await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm')

    // -> Create Search Index
    const indexExists = await knex.schema.hasTable('pagesVector')
    if (!indexExists) {
      wiki.logger.info(`(SEARCH/POSTGRES) Creating Pages Vector table...`)
      await knex.schema.createTable('pagesVector', table => {
        table.increments()
        table.string('path')
        table.string('locale')
        table.string('title')
        table.string('description')
        table.specificType('tokens', 'TSVECTOR')
        table.text('content')
      })
    }
    // -> Create Words Index
    const wordsExists = await knex.schema.hasTable('pagesWords')
    if (!wordsExists) {
      wiki.logger.info(`(SEARCH/POSTGRES) Creating Words Suggestion Index...`)
      await knex.raw(`
        CREATE TABLE "pagesWords" AS SELECT word FROM ts_stat(
          'SELECT to_tsvector(''simple'', "title") || to_tsvector(''simple'', "description") || to_tsvector(''simple'', "content") FROM "pagesVector"'
        )`)
      await knex.raw(`CREATE INDEX "pageWords_idx" ON "pagesWords" USING GIN (word gin_trgm_ops)`)
    }

    wiki.logger.info(`(SEARCH/POSTGRES) Initialization completed.`)
  },
  /**
   * QUERY
   *
   * @param {String} q Query
   * @param {Object} opts Additional options
   */
  async query(q, opts): Promise<SearchResult | void> {
    try {
      let suggestions: string[] = []
      let qry = `
        SELECT id, path, locale, title, description
        FROM "pagesVector", to_tsquery(?,?) query
        WHERE (query @@ "tokens" OR path ILIKE ?)
      `
      const qryEnd = `ORDER BY ts_rank(tokens, query) DESC`
      const qryParams: string[] = [this.config.dictLanguage, tsquery(q), `%${q.toLowerCase()}%`]

      if (opts.locale) {
        qry = `${qry} AND locale = ?`
        qryParams.push(opts.locale)
      }
      if (opts.path) {
        qry = `${qry} AND path ILIKE ?`
        qryParams.push(`%${opts.path}`)
      }
      const knex = getKnexClient()
      const results = await knex.raw<PostgresRawResult<PostgresSearchRow>>(`
        ${qry}
        ${qryEnd}
      `, qryParams)
      if (results.rows.length < 5) {
        try {
          const suggestResults = await knex.raw<PostgresRawResult<PostgresSuggestionRow>>(`SELECT word, word <-> ? AS rank FROM "pagesWords" WHERE similarity(word, ?) > 0.2 ORDER BY rank LIMIT 5;`, [q, q])
          suggestions = suggestResults.rows.map(result => result.word)
        } catch (err: unknown) {
          wiki.logger.warn(`Search Engine Suggestion Error (pg_trgm extension may be missing): ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      return {
        results: results.rows,
        suggestions,
        totalHits: results.rows.length
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
    const knex = getKnexClient()
    await knex.raw(`
      INSERT INTO "pagesVector" (path, locale, title, description, "tokens") VALUES (
        ?, ?, ?, ?, (setweight(to_tsvector('${this.config.dictLanguage}', ?), 'A') || setweight(to_tsvector('${this.config.dictLanguage}', ?), 'B') || setweight(to_tsvector('${this.config.dictLanguage}', ?), 'C'))
      )
    `, [page.path, page.localeCode, page.title, page.description, page.title, page.description, page.safeContent])
  },
  /**
   * UPDATE
   *
   * @param {Object} page Page to update
   */
  async updated(page) {
    const knex = getKnexClient()
    await knex.raw(`
      UPDATE "pagesVector" SET
        title = ?,
        description = ?,
        tokens = (setweight(to_tsvector('${this.config.dictLanguage}', ?), 'A') ||
        setweight(to_tsvector('${this.config.dictLanguage}', ?), 'B') ||
        setweight(to_tsvector('${this.config.dictLanguage}', ?), 'C'))
      WHERE path = ? AND locale = ?
    `, [page.title, page.description, page.title, page.description, page.safeContent, page.path, page.localeCode])
  },
  /**
   * DELETE
   *
   * @param {Object} page Page to delete
   */
  async deleted(page) {
    const knex = getKnexClient()
    await knex('pagesVector').where({
      locale: page.localeCode,
      path: page.path
    }).delete().limit(1)
  },
  /**
   * RENAME
   *
   * @param {Object} page Page to rename
   */
  async renamed(page) {
    const knex = getKnexClient()
    await knex('pagesVector').where({
      locale: page.localeCode,
      path: page.path
    }).update({
      locale: page.destinationLocaleCode,
      path: page.destinationPath
    })
  },
  /**
   * REBUILD INDEX
   */
  async rebuild() {
    const knex = getKnexClient()
    wiki.logger.info(`(SEARCH/POSTGRES) Rebuilding Index...`)
    await knex('pagesVector').truncate()
    await knex('pagesWords').truncate()

    await pipeline(
      knex.column('path', 'localeCode', 'title', 'description', 'render').select().from('pages').where({
        isPublished: true,
        visibility: 'public'
      }).stream(),
      new Transform({
        objectMode: true,
        transform: async (page: unknown, _encoding: BufferEncoding, callback: TransformCallback) => {
          if (!isPostgresIndexPage(page)) {
            callback(new Error('Search index page query returned an invalid row'))
            return
          }
          const content = wiki.models.pages.cleanHTML(page.render)
          await knex.raw(`
            INSERT INTO "pagesVector" (path, locale, title, description, "tokens", content) VALUES (
              ?, ?, ?, ?, (setweight(to_tsvector('${this.config.dictLanguage}', ?), 'A') || setweight(to_tsvector('${this.config.dictLanguage}', ?), 'B') || setweight(to_tsvector('${this.config.dictLanguage}', ?), 'C')), ?
            )
          `, [page.path, page.localeCode, page.title, page.description, page.title, page.description, content, content])
          callback()
        }
      })
    )

    await knex.raw(`
      INSERT INTO "pagesWords" (word)
        SELECT word FROM ts_stat(
          'SELECT to_tsvector(''simple'', "title") || to_tsvector(''simple'', "description") || to_tsvector(''simple'', "content") FROM "pagesVector"'
        )
      `)

    wiki.logger.info(`(SEARCH/POSTGRES) Index rebuilt successfully.`)
  }
}

export default plugin
