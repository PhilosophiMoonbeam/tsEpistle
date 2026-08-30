import { wiki, type SearchConfig, type SearchContext, type SearchPlugin, type SearchResult, type UnknownRecord, type WikiPage } from '../../types.ts'
import type { Knex } from 'knex'

const VECTOR_TABLE = 'pagesVector'
const WORDS_TABLE = 'pagesWords'
const VECTOR_COLUMNS = ['pageId', 'path', 'locale', 'title', 'description', 'tags', 'facets', 'tokens'] as const
const WORD_COLUMNS = ['pageId', 'word'] as const
const GRAPH_DEPTH = 2
const REBUILD_CURSOR_SIZE = 100

interface PostgresSearchConfig extends SearchConfig {
  dictLanguage: string
}

type PostgresSearchContext = SearchContext<PostgresSearchConfig>

interface PostgresSearchRow extends UnknownRecord {
  description: string
  id: number
  locale: string
  matchedFields: string[]
  path: string
  score: number
  tags: string[]
  title: string
}

interface PostgresSuggestionRow {
  word: string
}

interface PostgresRawResult<Row> {
  rows: Row[]
}

interface PageTag {
  tag?: unknown
  title?: unknown
}

interface PageIdRow {
  id: number
}

interface CanonicalPageModel {
  getPageFromDb(pageId: number): Promise<WikiPage | undefined>
  prepareSearchDocument(page: WikiPage): Promise<WikiPage>
}

const isPublishedPublicPage = (page: WikiPage): boolean => {
  const visibility = Reflect.get(page, 'visibility')
  const isPublished = Reflect.get(page, 'isPublished')
  return visibility === 'public' && (isPublished === true || isPublished === 1)
}

const isKnexClient = (value: typeof wiki.models.knex): value is typeof value & Knex =>
  typeof value === 'function' && 'transaction' in value && typeof value.transaction === 'function'

const getKnexClient = (): Knex => {
  const client = wiki.models.knex
  if (!isKnexClient(client)) throw new Error('PostgreSQL search requires a Knex database client')
  return client
}

const hasColumns = async (knex: Knex, table: string, columns: readonly string[]): Promise<boolean> => {
  if (!(await knex.schema.hasTable(table))) return false
  const present = await Promise.all(columns.map(column => knex.schema.hasColumn(table, column)))
  return present.every(Boolean)
}

const createSearchSchema = async (knex: Knex): Promise<boolean> => {
  const vectorReady = await hasColumns(knex, VECTOR_TABLE, VECTOR_COLUMNS)
  const wordsReady = await hasColumns(knex, WORDS_TABLE, WORD_COLUMNS)
  const recreated = !vectorReady || !wordsReady

  if (recreated) {
    await knex.schema.dropTableIfExists(WORDS_TABLE)
    await knex.schema.dropTableIfExists(VECTOR_TABLE)
    await knex.raw(`
      CREATE TABLE "pagesVector" (
        "pageId" integer PRIMARY KEY,
        path text NOT NULL,
        locale varchar(35) NOT NULL,
        title text NOT NULL,
        description text NOT NULL DEFAULT '',
        tags text[] NOT NULL DEFAULT '{}',
        facets text NOT NULL,
        tokens tsvector NOT NULL
      )
    `)
    await knex.raw(`
      CREATE TABLE "pagesWords" (
        "pageId" integer NOT NULL,
        word text NOT NULL,
        PRIMARY KEY ("pageId", word)
      )
    `)
  }

  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS pages_vector_identity_idx ON "pagesVector" (locale, path)')
  await knex.raw('CREATE INDEX IF NOT EXISTS pages_vector_tokens_idx ON "pagesVector" USING GIN (tokens)')
  await knex.raw('CREATE INDEX IF NOT EXISTS pages_vector_facets_trgm_idx ON "pagesVector" USING GIN (facets gin_trgm_ops)')
  await knex.raw('CREATE INDEX IF NOT EXISTS pages_words_word_trgm_idx ON "pagesWords" USING GIN (word gin_trgm_ops)')
  await knex.raw('CREATE INDEX IF NOT EXISTS page_links_page_id_idx ON "pageLinks" ("pageId")')
  await knex.raw('CREATE INDEX IF NOT EXISTS page_tags_page_id_idx ON "pageTags" ("pageId")')
  await knex.raw('CREATE INDEX IF NOT EXISTS page_tags_tag_id_idx ON "pageTags" ("tagId")')
  return recreated
}

const rebuildSearchIndex = async (knex: Knex, dictionary: string): Promise<void> => {
  const pageModel = wiki.models.pages as typeof wiki.models.pages & CanonicalPageModel
  await knex.transaction(async transaction => {
    await transaction(WORDS_TABLE).truncate()
    await transaction(VECTOR_TABLE).truncate()

    let pageIdCursor = 0
    while (true) {
      const pageIds = await transaction<PageIdRow>('pages')
        .select('id')
        .where('isPublished', true)
        .andWhere('visibility', 'public')
        .andWhere('id', '>', pageIdCursor)
        .orderBy('id')
        .limit(REBUILD_CURSOR_SIZE)
        .forShare()
      if (pageIds.length === 0) break

      for (const { id } of pageIds) {
        const page = await pageModel.getPageFromDb(id)
        if (!page || !isPublishedPublicPage(page)) continue
        await indexPage(transaction, dictionary, await pageModel.prepareSearchDocument(page))
      }
      pageIdCursor = pageIds.at(-1)?.id ?? pageIdCursor
      if (pageIds.length < REBUILD_CURSOR_SIZE) break
    }
  })
}

const pageTags = (page: WikiPage): { tags: string[]; tagText: string } => {
  const tags = new Set<string>()
  const terms = new Set<string>()
  for (const value of page.tags) {
    const tag = value as PageTag
    if (typeof tag.tag === 'string' && tag.tag.trim()) {
      const normalized = tag.tag.trim().toLocaleLowerCase()
      tags.add(normalized)
      terms.add(normalized)
    }
    if (typeof tag.title === 'string' && tag.title.trim()) terms.add(tag.title.trim())
  }
  return { tags: [...tags].sort(), tagText: [...terms].join(' ') }
}

const removePage = async (knex: Knex, pageId: number): Promise<void> => {
  await knex.transaction(async transaction => {
    await transaction(WORDS_TABLE).where({ pageId }).delete()
    await transaction(VECTOR_TABLE).where({ pageId }).delete()
  })
}

const indexPage = async (transaction: Knex.Transaction, dictionary: string, page: WikiPage): Promise<void> => {
  const tagValues = pageTags(page)
  await transaction.raw(
    `
    WITH document AS (
      SELECT
        ?::integer AS page_id,
        ?::text AS path,
        ?::text AS locale,
        ?::text AS title,
        ?::text AS description,
        ?::text[] AS tags,
        ?::text AS tag_text,
        ?::text AS searchable_content
    ), indexed AS (
      SELECT
        page_id,
        path,
        locale,
        title,
        description,
        tags,
        concat_ws(' ', title, replace(path, '/', ' '), description, tag_text) AS facets,
        setweight(to_tsvector(?::regconfig, title), 'A') ||
        setweight(to_tsvector(?::regconfig, tag_text), 'A') ||
        setweight(to_tsvector(?::regconfig, replace(path, '/', ' ')), 'B') ||
        setweight(to_tsvector(?::regconfig, description), 'B') ||
        setweight(to_tsvector(?::regconfig, searchable_content), 'C') AS tokens
      FROM document
    )
    INSERT INTO "pagesVector" ("pageId", path, locale, title, description, tags, facets, tokens)
    SELECT page_id, path, locale, title, description, tags, facets, tokens FROM indexed
    ON CONFLICT ("pageId") DO UPDATE SET
      path = EXCLUDED.path,
      locale = EXCLUDED.locale,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      tags = EXCLUDED.tags,
      facets = EXCLUDED.facets,
      tokens = EXCLUDED.tokens
  `,
    [
      page.id,
      page.path,
      page.localeCode,
      page.title,
      page.description ?? '',
      tagValues.tags,
      tagValues.tagText,
      page.safeContent,
      dictionary,
      dictionary,
      dictionary,
      dictionary,
      dictionary
    ]
  )
  await transaction(WORDS_TABLE).where({ pageId: page.id }).delete()
  await transaction.raw(
    `
    INSERT INTO "pagesWords" ("pageId", word)
    SELECT vector."pageId", words.word
    FROM "pagesVector" vector
    CROSS JOIN LATERAL unnest(tsvector_to_array(to_tsvector('simple', vector.facets))) words(word)
    WHERE vector."pageId" = ?
    ON CONFLICT DO NOTHING
  `,
    [page.id]
  )
}

const upsertPage = async (knex: Knex, dictionary: string, page: WikiPage): Promise<void> => {
  if (!isPublishedPublicPage(page)) {
    await removePage(knex, page.id)
    return
  }
  await knex.transaction(transaction => indexPage(transaction, dictionary, page))
}

const escapedLikeTerm = (value: string): string => `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`

const suggestionTerm = (query: string): string =>
  query
    .split(/\s+/u)
    .at(-1)
    ?.replace(/[^\p{L}\p{N}_-]+/gu, '') ?? ''

const replaceSuggestionTerm = (query: string, replacement: string): string => {
  const lastWhitespace = query.search(/\s+\S*$/u)
  return lastWhitespace < 0 ? replacement : `${query.slice(0, lastWhitespace + 1)}${replacement}`
}

const queryPages = async (
  knex: Knex,
  dictionary: string,
  query: string,
  options: { locale?: string; path?: string },
  maxHits: number
): Promise<PostgresSearchRow[]> => {
  const path = options.path ?? null
  const pathPrefix = path === null ? null : `${path.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}/%`
  const results = await knex.raw<PostgresRawResult<PostgresSearchRow>>(
    `
    WITH RECURSIVE query_input AS (
      SELECT
        ?::regconfig AS dictionary,
        websearch_to_tsquery(?::regconfig, ?) AS query,
        lower(trim(?)) AS raw_query,
        ?::text AS like_query,
        ?::text AS locale_filter,
        ?::text AS path_filter,
        ?::text AS path_prefix
    ), exact_ids AS MATERIALIZED (
      SELECT vector."pageId"
      FROM "pagesVector" vector
      CROSS JOIN query_input input
      WHERE (
        (input.query <> ''::tsquery AND vector.tokens @@ input.query) OR
        vector.facets ILIKE input.like_query ESCAPE '\\'
      )
      AND (input.locale_filter IS NULL OR vector.locale = input.locale_filter)
      AND (
        input.path_filter IS NULL OR
        vector.path = input.path_filter OR
        vector.path LIKE input.path_prefix ESCAPE '\\'
      )
    ), fuzzy_ids AS MATERIALIZED (
      SELECT vector."pageId"
      FROM "pagesVector" vector
      CROSS JOIN query_input input
      WHERE (SELECT count(*) FROM exact_ids) < 5
      AND length(input.raw_query) >= 3
      AND input.raw_query <% vector.facets
      AND (input.locale_filter IS NULL OR vector.locale = input.locale_filter)
      AND (
        input.path_filter IS NULL OR
        vector.path = input.path_filter OR
        vector.path LIKE input.path_prefix ESCAPE '\\'
      )
      ORDER BY word_similarity(input.raw_query, vector.facets) DESC, vector."pageId"
      LIMIT ?
    ), candidate_ids AS (
      SELECT "pageId" FROM exact_ids
      UNION
      SELECT "pageId" FROM fuzzy_ids
    ), matched AS MATERIALIZED (
      SELECT
        vector.*,
        input.dictionary,
        input.query,
        input.raw_query,
        ts_rank_cd('{0.05,0.2,0.6,1.0}'::real[], vector.tokens, input.query, 32) AS lexical_rank,
        lower(vector.title) = input.raw_query AS exact_title,
        lower(vector.path) = input.raw_query AS exact_path,
        lower(vector.title) LIKE input.raw_query || '%' AS title_prefix,
        EXISTS (SELECT 1 FROM unnest(vector.tags) tag WHERE lower(tag) = input.raw_query) AS exact_tag,
        EXISTS (SELECT 1 FROM unnest(vector.tags) tag WHERE lower(tag) LIKE input.raw_query || '%') AS tag_prefix,
        word_similarity(input.raw_query, vector.facets) AS facet_similarity
      FROM candidate_ids ids
      JOIN "pagesVector" vector ON vector."pageId" = ids."pageId"
      CROSS JOIN query_input input
    ), candidates AS MATERIALIZED (
      SELECT
        matched.*,
        (
          matched.lexical_rank * 5.0 +
          CASE WHEN matched.exact_title THEN 10.0 ELSE 0.0 END +
          CASE WHEN matched.exact_tag THEN 7.0 ELSE 0.0 END +
          CASE WHEN matched.exact_path THEN 6.0 ELSE 0.0 END +
          CASE WHEN matched.title_prefix AND NOT matched.exact_title THEN 3.0 ELSE 0.0 END +
          CASE WHEN matched.tag_prefix AND NOT matched.exact_tag THEN 2.0 ELSE 0.0 END +
          matched.facet_similarity * 1.25
        )::double precision AS preliminary_score
      FROM matched
      ORDER BY preliminary_score DESC, lower(matched.title), matched."pageId"
      LIMIT ?
    ), edges AS MATERIALIZED (
      SELECT links."pageId" AS source_id, target."pageId" AS target_id
      FROM "pageLinks" links
      JOIN candidates source ON source."pageId" = links."pageId"
      JOIN "pagesVector" target ON target.locale = links."localeCode" AND target.path = links.path
      JOIN candidates selected_target ON selected_target."pageId" = target."pageId"
      UNION
      SELECT target."pageId" AS source_id, links."pageId" AS target_id
      FROM "pageLinks" links
      JOIN candidates source ON source."pageId" = links."pageId"
      JOIN "pagesVector" target ON target.locale = links."localeCode" AND target.path = links.path
      JOIN candidates selected_target ON selected_target."pageId" = target."pageId"
    ), graph_walk(root_id, page_id, depth, root_score) AS (
      SELECT candidate."pageId", candidate."pageId", 0, candidate.preliminary_score
      FROM candidates candidate
      UNION
      SELECT walk.root_id, edge.target_id, walk.depth + 1, walk.root_score
      FROM graph_walk walk
      JOIN edges edge ON edge.source_id = walk.page_id
      WHERE walk.depth < ${GRAPH_DEPTH}
    ), reachable AS (
      SELECT root_id, page_id, min(depth) AS depth, max(root_score) AS root_score
      FROM graph_walk
      WHERE root_id <> page_id
      GROUP BY root_id, page_id
    ), graph_support AS (
      SELECT
        page_id,
        least(1.25, sum(root_score * CASE depth WHEN 1 THEN 0.08 ELSE 0.03 END))::double precision AS graph_score
      FROM reachable
      GROUP BY page_id
    ), ranked AS (
      SELECT
        candidate.*,
        coalesce(support.graph_score, 0.0) AS graph_score,
        candidate.exact_title OR
          candidate.query @@ to_tsvector(candidate.dictionary, candidate.title) OR
          word_similarity(candidate.raw_query, candidate.title) >= 0.6 AS title_match,
        candidate.exact_tag OR
          candidate.query @@ to_tsvector(candidate.dictionary, array_to_string(candidate.tags, ' ')) OR
          EXISTS (SELECT 1 FROM unnest(candidate.tags) tag WHERE word_similarity(candidate.raw_query, tag) >= 0.6) AS tag_match,
        candidate.exact_path OR
          candidate.query @@ to_tsvector(candidate.dictionary, replace(candidate.path, '/', ' ')) OR
          word_similarity(candidate.raw_query, replace(candidate.path, '/', ' ')) >= 0.6 AS path_match,
        candidate.query @@ to_tsvector(candidate.dictionary, candidate.description) OR
          word_similarity(candidate.raw_query, candidate.description) >= 0.6 AS description_match
      FROM candidates candidate
      LEFT JOIN graph_support support ON support.page_id = candidate."pageId"
    )
    SELECT
      ranked."pageId" AS id,
      ranked.path,
      ranked.locale,
      ranked.title,
      ranked.description,
      ranked.tags,
      round((ranked.preliminary_score + ranked.graph_score)::numeric, 6)::double precision AS score,
      array_remove(ARRAY[
        CASE WHEN ranked.title_match THEN 'title' END,
        CASE WHEN ranked.tag_match THEN 'tag' END,
        CASE WHEN ranked.path_match THEN 'path' END,
        CASE WHEN ranked.description_match THEN 'description' END,
        CASE WHEN ranked.lexical_rank > 0 AND NOT (ranked.title_match OR ranked.tag_match OR ranked.path_match OR ranked.description_match) THEN 'content' END,
        CASE WHEN ranked.graph_score > 0 THEN 'graph' END
      ], NULL)::text[] AS "matchedFields"
    FROM ranked
    ORDER BY score DESC, ranked.preliminary_score DESC, lower(ranked.title), ranked."pageId"
  `,
    [dictionary, dictionary, query, query, escapedLikeTerm(query), options.locale ?? null, path, pathPrefix, maxHits, maxHits]
  )
  return results.rows
}

const suggestionsFor = async (knex: Knex, query: string): Promise<string[]> => {
  const term = suggestionTerm(query)
  if (term.length < 2) return []
  const results = await knex.raw<PostgresRawResult<PostgresSuggestionRow>>(
    `
    SELECT word
    FROM "pagesWords"
    WHERE word % ?
    GROUP BY word
    ORDER BY similarity(word, ?) DESC, count(*) DESC, word
    LIMIT 5
  `,
    [term, term]
  )
  return results.rows
    .map(result => replaceSuggestionTerm(query, result.word))
    .filter(suggestion => suggestion.toLocaleLowerCase() !== query.toLocaleLowerCase())
}

const plugin: SearchPlugin<PostgresSearchConfig, PostgresSearchContext> = {
  async activate() {
    if (wiki.config.db.type !== 'postgres') {
      throw new wiki.Error.SearchActivationFailed('Must use PostgreSQL database to activate this engine!')
    }
  },

  async deactivate() {
    const knex = getKnexClient()
    wiki.logger.info('(SEARCH/POSTGRES) Dropping derived search tables...')
    await knex.schema.dropTableIfExists(WORDS_TABLE)
    await knex.schema.dropTableIfExists(VECTOR_TABLE)
    wiki.logger.info('(SEARCH/POSTGRES) Derived search tables have been dropped.')
  },

  async init() {
    const knex = getKnexClient()
    wiki.logger.info('(SEARCH/POSTGRES) Initializing hybrid lexical and graph search...')
    await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    const recreated = await createSearchSchema(knex)
    if (recreated) await rebuildSearchIndex(knex, this.config.dictLanguage)
    wiki.logger.info('(SEARCH/POSTGRES) Hybrid search is ready.')
  },

  async query(q, opts): Promise<SearchResult> {
    const query = q.trim()
    if (!query) return { results: [], suggestions: [], totalHits: 0 }
    const knex = getKnexClient()
    try {
      const results = await queryPages(knex, this.config.dictLanguage, query, opts, wiki.config.search.maxHits)
      const suggestions = results.length < 5 ? await suggestionsFor(knex, query) : []
      return { results, suggestions, totalHits: results.length }
    } catch (error: unknown) {
      wiki.logger.warn(`Search Engine Error: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  },

  async created(page) {
    await upsertPage(getKnexClient(), this.config.dictLanguage, page)
  },

  async updated(page) {
    await upsertPage(getKnexClient(), this.config.dictLanguage, page)
  },

  async deleted(page) {
    await removePage(getKnexClient(), page.id)
  },

  async renamed(page) {
    await upsertPage(getKnexClient(), this.config.dictLanguage, {
      ...page,
      path: page.destinationPath,
      localeCode: page.destinationLocaleCode
    })
  },

  async rebuild() {
    const knex = getKnexClient()
    wiki.logger.info('(SEARCH/POSTGRES) Rebuilding hybrid search index...')
    await rebuildSearchIndex(knex, this.config.dictLanguage)
    wiki.logger.info('(SEARCH/POSTGRES) Hybrid search index rebuilt successfully.')
  }
}

export default plugin
