import { wiki, type SearchConfig, type SearchContext, type SearchPlugin, type SearchResult, type UnknownRecord, type WikiPage } from '../../types.ts'
import type { Knex } from 'knex'

const VECTOR_TABLE = 'pagesVector'
const WORDS_TABLE = 'pagesWords'
const METADATA_TABLE = 'pagesSearchMetadata'
const SEARCH_SCHEMA_VERSION = 2
const GRAPH_DEPTH = 2
const REBUILD_CURSOR_SIZE = 100
const EXACT_MATCH_CANDIDATE_MULTIPLIER = 3
const REBUILD_LOCK_NAME = 'wiki.search.postgres.derived-index'

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

interface PostgresBooleanRow {
  value: boolean
}

interface PageTag {
  tag?: unknown
  title?: unknown
}

interface CanonicalSearchPageRow {
  description: string | null
  id: number
  isProtected: boolean
  isPublished: boolean
  localeCode: string
  path: string
  render: string | null
  sourceRevision: string | number
  tags: unknown
  title: string
  visibility: string
}

interface CanonicalPageModel {
  cleanHTML(rawHTML?: string): string
}

const isPublishedPublicPage = (page: WikiPage): boolean => {
  const visibility = Reflect.get(page, 'visibility')
  const isPublished = Reflect.get(page, 'isPublished')
  return visibility === 'public' && (isPublished === true || isPublished === 1)
}

const pageSourceRevision = (page: WikiPage): string => {
  const revision = Reflect.get(page, 'sourceRevision')
  if (typeof revision === 'bigint' && revision > 0n) return revision.toString()
  if (typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0) return String(revision)
  if (typeof revision === 'string' && /^[1-9]\d*$/u.test(revision)) return revision
  throw new Error(`Page ${page.id} has no valid source revision`)
}

const isKnexClient = (value: typeof wiki.models.knex): value is typeof value & Knex =>
  typeof value === 'function' && 'transaction' in value && typeof value.transaction === 'function'

const getKnexClient = (): Knex => {
  const client = wiki.models.knex
  if (!isKnexClient(client)) throw new Error('PostgreSQL search requires a Knex database client')
  return client
}

const hasCurrentSearchSchema = async (transaction: Knex.Transaction): Promise<boolean> => {
  const result = await transaction.raw<PostgresRawResult<PostgresBooleanRow>>(`
    WITH expected_columns(table_name, column_name, data_type, is_not_null, default_expression) AS (
      VALUES
        ('pagesVector', 'pageId', 'integer', true, NULL),
        ('pagesVector', 'sourceRevision', 'bigint', true, NULL),
        ('pagesVector', 'path', 'text', true, NULL),
        ('pagesVector', 'locale', 'character varying(35)', true, NULL),
        ('pagesVector', 'title', 'text', true, NULL),
        ('pagesVector', 'description', 'text', true, $default$''::text$default$),
        ('pagesVector', 'tags', 'text[]', true, $default$'{}'::text[]$default$),
        ('pagesVector', 'facets', 'text', true, NULL),
        ('pagesVector', 'tokens', 'tsvector', true, NULL),
        ('pagesWords', 'pageId', 'integer', true, NULL),
        ('pagesWords', 'word', 'text', true, NULL),
        ('pagesSearchMetadata', 'contractId', 'smallint', true, NULL),
        ('pagesSearchMetadata', 'schemaVersion', 'integer', true, NULL),
        ('pagesSearchMetadata', 'dictionary', 'text', true, NULL)
    ), actual_columns AS (
      SELECT
        table_class.relname AS table_name,
        attribute.attname AS column_name,
        format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
        attribute.attnotnull AS is_not_null,
        pg_get_expr(column_default.adbin, column_default.adrelid) AS default_expression
      FROM pg_class table_class
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid = table_class.oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      LEFT JOIN pg_attrdef column_default ON column_default.adrelid = table_class.oid
        AND column_default.adnum = attribute.attnum
      WHERE namespace.nspname = current_schema()
        AND table_class.relkind = 'r'
        AND table_class.relname IN ('pagesVector', 'pagesWords', 'pagesSearchMetadata')
    ), expected_constraints(table_name, constraint_name, definition) AS (
      VALUES
        ('pagesVector', 'pages_vector_pkey', 'PRIMARY KEY ("pageId")'),
        ('pagesWords', 'pages_words_pkey', 'PRIMARY KEY ("pageId", word)'),
        ('pagesSearchMetadata', 'pages_search_metadata_pkey', 'PRIMARY KEY ("contractId")')
    ), actual_constraints AS (
      SELECT
        table_class.relname AS table_name,
        constraint_data.conname AS constraint_name,
        pg_get_constraintdef(constraint_data.oid, false) AS definition
      FROM pg_constraint constraint_data
      JOIN pg_class table_class ON table_class.oid = constraint_data.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      WHERE namespace.nspname = current_schema()
        AND table_class.relname IN ('pagesVector', 'pagesWords', 'pagesSearchMetadata')
        AND constraint_data.contype = 'p'
    ), expected_indexes(index_name, table_name, method_name, is_unique, column_names, opclass_names) AS (
      VALUES
        ('pages_vector_identity_idx', 'pagesVector', 'btree', true, ARRAY['locale', 'path']::text[], ARRAY['text_ops', 'text_ops']::text[]),
        ('pages_vector_tokens_idx', 'pagesVector', 'gin', false, ARRAY['tokens']::text[], ARRAY['tsvector_ops']::text[]),
        ('pages_vector_tags_idx', 'pagesVector', 'gin', false, ARRAY['tags']::text[], ARRAY['array_ops']::text[]),
        ('pages_vector_facets_trgm_idx', 'pagesVector', 'gin', false, ARRAY['facets']::text[], ARRAY['gin_trgm_ops']::text[]),
        ('pages_words_word_trgm_idx', 'pagesWords', 'gin', false, ARRAY['word']::text[], ARRAY['gin_trgm_ops']::text[])
    ), actual_indexes AS (
      SELECT
        index_class.relname AS index_name,
        table_class.relname AS table_name,
        access_method.amname AS method_name,
        index_data.indisunique AS is_unique,
        index_data.indisvalid,
        index_data.indisready,
        index_data.indislive,
        index_data.indexprs IS NULL AND index_data.indpred IS NULL
          AND index_data.indnatts = index_data.indnkeyatts AS is_plain,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(index_data.indkey::smallint[]) WITH ORDINALITY AS index_key(attnum, ordinal)
          JOIN pg_attribute attribute ON attribute.attrelid = index_data.indrelid
            AND attribute.attnum = index_key.attnum
          WHERE index_key.ordinal <= index_data.indnkeyatts
          ORDER BY index_key.ordinal
        ) AS column_names,
        ARRAY(
          SELECT operator_class.opcname::text
          FROM unnest(index_data.indclass::oid[]) WITH ORDINALITY AS index_operator(opclass_oid, ordinal)
          JOIN pg_opclass operator_class ON operator_class.oid = index_operator.opclass_oid
          WHERE index_operator.ordinal <= index_data.indnkeyatts
          ORDER BY index_operator.ordinal
        ) AS opclass_names
      FROM pg_index index_data
      JOIN pg_class index_class ON index_class.oid = index_data.indexrelid
      JOIN pg_class table_class ON table_class.oid = index_data.indrelid
      JOIN pg_namespace namespace ON namespace.oid = index_class.relnamespace
      JOIN pg_am access_method ON access_method.oid = index_class.relam
      WHERE namespace.nspname = current_schema()
        AND index_class.relname IN (
          'pages_vector_identity_idx',
          'pages_vector_tokens_idx',
          'pages_vector_tags_idx',
          'pages_vector_facets_trgm_idx',
          'pages_words_word_trgm_idx'
        )
    )
    SELECT (
      (SELECT count(*) FROM actual_columns) = (SELECT count(*) FROM expected_columns)
      AND NOT EXISTS (
        SELECT 1
        FROM expected_columns expected
        LEFT JOIN actual_columns actual USING (table_name, column_name)
        WHERE actual.column_name IS NULL
          OR actual.data_type <> expected.data_type
          OR actual.is_not_null <> expected.is_not_null
          OR actual.default_expression IS DISTINCT FROM expected.default_expression
      )
      AND NOT EXISTS (
        SELECT 1
        FROM expected_constraints expected
        LEFT JOIN actual_constraints actual USING (table_name, constraint_name)
        WHERE actual.constraint_name IS NULL OR actual.definition <> expected.definition
      )
      AND NOT EXISTS (
        SELECT 1
        FROM expected_indexes expected
        LEFT JOIN actual_indexes actual USING (index_name)
        WHERE actual.index_name IS NULL
          OR actual.table_name <> expected.table_name
          OR actual.method_name <> expected.method_name
          OR actual.is_unique <> expected.is_unique
          OR NOT actual.indisvalid
          OR NOT actual.indisready
          OR NOT actual.indislive
          OR NOT actual.is_plain
          OR actual.column_names <> expected.column_names
          OR actual.opclass_names <> expected.opclass_names
      )
    ) AS value
  `)
  return result.rows[0]?.value === true
}

const recreateSearchSchema = async (transaction: Knex.Transaction): Promise<void> => {
  await transaction.raw(`
    DROP INDEX IF EXISTS pages_vector_identity_idx;
    DROP INDEX IF EXISTS pages_vector_tokens_idx;
    DROP INDEX IF EXISTS pages_vector_facets_trgm_idx;
    DROP INDEX IF EXISTS pages_words_word_trgm_idx;
  `)
  await transaction.schema.dropTableIfExists(METADATA_TABLE)
  await transaction.schema.dropTableIfExists(WORDS_TABLE)
  await transaction.schema.dropTableIfExists(VECTOR_TABLE)
  await transaction.raw(`
    CREATE TABLE "pagesVector" (
      "pageId" integer CONSTRAINT pages_vector_pkey PRIMARY KEY,
      "sourceRevision" bigint NOT NULL,
      path text NOT NULL,
      locale varchar(35) NOT NULL,
      title text NOT NULL,
      description text NOT NULL DEFAULT '',
      tags text[] NOT NULL DEFAULT '{}',
      facets text NOT NULL,
      tokens tsvector NOT NULL
    );
    CREATE TABLE "pagesWords" (
      "pageId" integer NOT NULL,
      word text NOT NULL,
      CONSTRAINT pages_words_pkey PRIMARY KEY ("pageId", word)
    );
    CREATE TABLE "pagesSearchMetadata" (
      "contractId" smallint CONSTRAINT pages_search_metadata_pkey PRIMARY KEY,
      "schemaVersion" integer NOT NULL,
      dictionary text NOT NULL
    );
    CREATE UNIQUE INDEX pages_vector_identity_idx ON "pagesVector" (locale, path);
    CREATE INDEX pages_vector_tokens_idx ON "pagesVector" USING GIN (tokens);
    CREATE INDEX pages_vector_tags_idx ON "pagesVector" USING GIN (tags);
    CREATE INDEX pages_vector_facets_trgm_idx ON "pagesVector" USING GIN (facets gin_trgm_ops);
    CREATE INDEX pages_words_word_trgm_idx ON "pagesWords" USING GIN (word gin_trgm_ops);
  `)
}

const ensureSourceIndexes = async (transaction: Knex.Transaction): Promise<void> => {
  await transaction.raw('CREATE INDEX IF NOT EXISTS page_links_page_id_idx ON "pageLinks" ("pageId")')
  await transaction.raw('CREATE INDEX IF NOT EXISTS page_tags_page_id_idx ON "pageTags" ("pageId")')
  await transaction.raw('CREATE INDEX IF NOT EXISTS page_tags_tag_id_idx ON "pageTags" ("tagId")')
}

const metadataIsCurrent = async (transaction: Knex.Transaction, dictionary: string): Promise<boolean> => {
  const result = await transaction.raw<PostgresRawResult<PostgresBooleanRow>>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM "pagesSearchMetadata"
        WHERE "contractId" = 1 AND "schemaVersion" = ? AND dictionary = ?
      ) AS value
    `,
    [SEARCH_SCHEMA_VERSION, dictionary]
  )
  return result.rows[0]?.value === true
}

const sourceRevisionsAreCurrent = async (transaction: Knex.Transaction): Promise<boolean> => {
  const result = await transaction.raw<PostgresRawResult<PostgresBooleanRow>>(`
    SELECT NOT EXISTS (
      SELECT 1
      FROM pages page
      FULL OUTER JOIN "pagesVector" vector ON vector."pageId" = page.id
      WHERE (
        page.visibility = 'public'
        AND page."isPublished" = true
        AND (vector."pageId" IS NULL OR vector."sourceRevision" IS DISTINCT FROM page."sourceRevision")
      ) OR (
        vector."pageId" IS NOT NULL
        AND (page.id IS NULL OR page.visibility IS DISTINCT FROM 'public' OR page."isPublished" IS DISTINCT FROM true)
      )
    ) AS value
  `)
  return result.rows[0]?.value === true
}

const canonicalPageSelection = `
  SELECT
    page.id,
    page."sourceRevision",
    page.path,
    page."localeCode",
    page.title,
    page.description,
    page.render,
    page.visibility,
    page."isPublished",
    EXISTS (
      SELECT 1
      FROM "pageAccessPasswords" protection
      WHERE protection."pageId" = page.id
    ) AS "isProtected",
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('tag', tag.tag, 'title', tag.title)
        ORDER BY tag.tag, tag.title
      )
      FROM "pageTags" page_tag
      JOIN tags tag ON tag.id = page_tag."tagId"
      WHERE page_tag."pageId" = page.id
    ), '[]'::jsonb) AS tags
  FROM pages page
`

const canonicalPageBatch = async (transaction: Knex.Transaction, pageIdCursor: number): Promise<CanonicalSearchPageRow[]> => {
  const result = await transaction.raw<PostgresRawResult<CanonicalSearchPageRow>>(
    `
      ${canonicalPageSelection}
      WHERE page.visibility = 'public'
        AND page."isPublished" = true
        AND page.id > ?
      ORDER BY page.id
      LIMIT ?
      FOR SHARE OF page
    `,
    [pageIdCursor, REBUILD_CURSOR_SIZE]
  )
  return result.rows
}

const rebuildSearchIndex = async (transaction: Knex.Transaction, dictionary: string): Promise<void> => {
  const pageModel = wiki.models.pages as typeof wiki.models.pages & CanonicalPageModel
  await transaction(WORDS_TABLE).truncate()
  await transaction(VECTOR_TABLE).truncate()

  let pageIdCursor = 0
  while (true) {
    const pages = await canonicalPageBatch(transaction, pageIdCursor)
    if (pages.length === 0) break

    for (const page of pages) {
      const tags = Array.isArray(page.tags) ? page.tags : []
      await indexPage(transaction, dictionary, {
        ...page,
        safeContent: page.isProtected ? '' : pageModel.cleanHTML(page.render ?? ''),
        tags
      } as unknown as WikiPage)
    }
    pageIdCursor = pages.at(-1)?.id ?? pageIdCursor
    if (pages.length < REBUILD_CURSOR_SIZE) break
  }
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

const reconcilePage = async (knex: Knex, dictionary: string, pageId: number): Promise<void> => {
  const pageModel = wiki.models.pages as typeof wiki.models.pages & CanonicalPageModel
  await knex.transaction(async transaction => {
    const result = await transaction.raw<PostgresRawResult<CanonicalSearchPageRow>>(
      `
        ${canonicalPageSelection}
        WHERE page.id = ?
        FOR SHARE OF page
      `,
      [pageId]
    )
    const page = result.rows[0]
    if (!page || page.visibility !== 'public' || page.isPublished !== true) {
      await transaction(WORDS_TABLE).where({ pageId }).delete()
      await transaction(VECTOR_TABLE).where({ pageId }).delete()
      return
    }
    await indexPage(transaction, dictionary, {
      ...page,
      safeContent: page.isProtected ? '' : pageModel.cleanHTML(page.render ?? ''),
      tags: Array.isArray(page.tags) ? page.tags : []
    } as unknown as WikiPage)
  })
}

const indexPage = async (transaction: Knex.Transaction, dictionary: string, page: WikiPage): Promise<void> => {
  const tagValues = pageTags(page)
  await transaction.raw(
    `
    WITH document AS (
      SELECT
        ?::integer AS page_id,
        ?::bigint AS source_revision,
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
        source_revision,
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
    INSERT INTO "pagesVector" ("pageId", "sourceRevision", path, locale, title, description, tags, facets, tokens)
    SELECT page_id, source_revision, path, locale, title, description, tags, facets, tokens FROM indexed
    ON CONFLICT ("pageId") DO UPDATE SET
      "sourceRevision" = EXCLUDED."sourceRevision",
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
      pageSourceRevision(page),
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

const ensureSearchIndex = async (knex: Knex, dictionary: string, forceRebuild: boolean): Promise<boolean> =>
  knex.transaction(async transaction => {
    const lockResult = await transaction.raw<PostgresRawResult<PostgresBooleanRow>>('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS value', [
      REBUILD_LOCK_NAME
    ])
    if (lockResult.rows[0]?.value !== true) {
      throw new Error('PostgreSQL search rebuild is already in progress')
    }

    const schemaCurrent = await hasCurrentSearchSchema(transaction)
    if (!schemaCurrent) await recreateSearchSchema(transaction)
    await ensureSourceIndexes(transaction)

    const metadataCurrent = schemaCurrent && (await metadataIsCurrent(transaction, dictionary))
    const revisionsCurrent = metadataCurrent && (await sourceRevisionsAreCurrent(transaction))
    const rebuildRequired = forceRebuild || !schemaCurrent || !metadataCurrent || !revisionsCurrent
    if (!rebuildRequired) return false

    await rebuildSearchIndex(transaction, dictionary)
    await transaction.raw(
      `
        INSERT INTO "pagesSearchMetadata" ("contractId", "schemaVersion", dictionary)
        VALUES (1, ?, ?)
        ON CONFLICT ("contractId") DO UPDATE SET
          "schemaVersion" = EXCLUDED."schemaVersion",
          dictionary = EXCLUDED.dictionary
      `,
      [SEARCH_SCHEMA_VERSION, dictionary]
    )
    return true
  })

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
    ), priority_ids AS MATERIALIZED (
      SELECT vector."pageId"
      FROM "pagesVector" vector
      CROSS JOIN query_input input
      WHERE (
        lower(vector.title) = input.raw_query OR
        vector.tags @> ARRAY[input.raw_query]::text[] OR
        lower(vector.path) = input.raw_query
      )
      AND (input.locale_filter IS NULL OR vector.locale = input.locale_filter)
      AND (
        input.path_filter IS NULL OR
        vector.path = input.path_filter OR
        vector.path LIKE input.path_prefix ESCAPE '\\'
      )
      ORDER BY
        (lower(vector.title) = input.raw_query) DESC,
        (vector.tags @> ARRAY[input.raw_query]::text[]) DESC,
        (lower(vector.path) = input.raw_query) DESC,
        lower(vector.title),
        vector."pageId"
      LIMIT ?
    ), lexical_ids AS MATERIALIZED (
      SELECT vector."pageId"
      FROM "pagesVector" vector
      CROSS JOIN query_input input
      WHERE (SELECT count(*) FROM priority_ids) < ?
      AND (
        (input.query <> ''::tsquery AND vector.tokens @@ input.query) OR
        vector.facets ILIKE input.like_query ESCAPE '\\'
      )
      AND NOT EXISTS (SELECT 1 FROM priority_ids priority WHERE priority."pageId" = vector."pageId")
      AND (input.locale_filter IS NULL OR vector.locale = input.locale_filter)
      AND (
        input.path_filter IS NULL OR
        vector.path = input.path_filter OR
        vector.path LIKE input.path_prefix ESCAPE '\\'
      )
      ORDER BY
        ts_rank_cd('{0.05,0.2,0.6,1.0}'::real[], vector.tokens, input.query, 32) DESC,
        lower(vector.title),
        vector."pageId"
      LIMIT ?
    ), exact_ids AS MATERIALIZED (
      SELECT "pageId" FROM priority_ids
      UNION ALL
      SELECT "pageId" FROM lexical_ids
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
    [dictionary, dictionary, query, query, escapedLikeTerm(query), options.locale ?? null, path, pathPrefix, maxHits * EXACT_MATCH_CANDIDATE_MULTIPLIER, maxHits, maxHits * EXACT_MATCH_CANDIDATE_MULTIPLIER, maxHits, maxHits]
  )
  return results.rows
}

const suggestionsFor = async (knex: Knex, query: string, pageIds: number[]): Promise<string[]> => {
  const term = suggestionTerm(query)
  if (term.length < 2 || pageIds.length === 0) return []
  const results = await knex.raw<PostgresRawResult<PostgresSuggestionRow>>(
    `
    SELECT word
    FROM "pagesWords"
    WHERE "pageId" = ANY(?::integer[]) AND word % ?
    GROUP BY word
    ORDER BY similarity(word, ?) DESC, count(*) DESC, word
    LIMIT 5
  `,
    [pageIds, term, term]
  )
  return results.rows
    .map(result => replaceSuggestionTerm(query, result.word))
    .filter(suggestion => suggestion.toLocaleLowerCase() !== query.toLocaleLowerCase())
}

interface PostgresProjectionSearchEngine {
  reconcilePage(this: PostgresSearchContext, pageId: number): Promise<void>
  removePage(this: PostgresSearchContext, pageId: number): Promise<void>
}

const plugin: SearchPlugin<PostgresSearchConfig, PostgresSearchContext> & PostgresProjectionSearchEngine = {
  async activate() {
    if (wiki.config.db.type !== 'postgres') {
      throw new wiki.Error.SearchActivationFailed('Must use PostgreSQL database to activate this engine!')
    }
  },

  async deactivate() {
    const knex = getKnexClient()
    wiki.logger.info('(SEARCH/POSTGRES) Dropping derived search tables...')
    await knex.schema.dropTableIfExists(METADATA_TABLE)
    await knex.schema.dropTableIfExists(WORDS_TABLE)
    await knex.schema.dropTableIfExists(VECTOR_TABLE)
    wiki.logger.info('(SEARCH/POSTGRES) Derived search tables have been dropped.')
  },

  async init() {
    const knex = getKnexClient()
    wiki.logger.info('(SEARCH/POSTGRES) Initializing hybrid lexical and graph search...')
    await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    await ensureSearchIndex(knex, this.config.dictLanguage, false)
    wiki.logger.info('(SEARCH/POSTGRES) Hybrid search is ready.')
  },

  async query(q, opts): Promise<SearchResult> {
    const query = q.trim()
    if (!query) return { results: [], suggestions: [], totalHits: 0 }
    const knex = getKnexClient()
    try {
      const results = await queryPages(knex, this.config.dictLanguage, query, opts, wiki.config.search.maxHits)
      const suggestions =
        results.length < 5
          ? await suggestionsFor(
              knex,
              query,
              results.map(result => result.id)
            )
          : []
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

  async reconcilePage(pageId) {
    await reconcilePage(getKnexClient(), this.config.dictLanguage, pageId)
  },

  async removePage(pageId) {
    await removePage(getKnexClient(), pageId)
  },

  async rebuild() {
    const knex = getKnexClient()
    wiki.logger.info('(SEARCH/POSTGRES) Rebuilding hybrid search index...')
    await ensureSearchIndex(knex, this.config.dictLanguage, true)
    wiki.logger.info('(SEARCH/POSTGRES) Hybrid search index rebuilt successfully.')
  }
}

export default plugin
