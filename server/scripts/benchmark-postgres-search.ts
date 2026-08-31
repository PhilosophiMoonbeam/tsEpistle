import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import knexModule from 'knex'
import type { Knex } from 'knex'

export const POSTGRES_SEARCH_CORPUS = Object.freeze({
  seed: 20_260_831,
  pages: 20_000,
  renderedPages: 20_000,
  links: 20_000,
  distinctTags: 21,
  tagAssignments: 25_000,
  locales: Object.freeze({ en: 18_000, fr: 2_000 })
})

export const POSTGRES_SEARCH_CAPS = Object.freeze({
  maxHits: 100,
  fuzzyFallbackExactHitThreshold: 5,
  suggestionLimit: 5,
  graphDepth: 2,
  rebuildBatchSize: 100
})

export const POSTGRES_SEARCH_QUERIES = Object.freeze({
  exactTitleContent: Object.freeze(['Amber Falcon Runbook', 'ultraviolet marmot checksum']),
  typoFuzzy: Object.freeze(['celestal harbor handbook', 'amber falcn runbook']),
  multiTermDescription: Object.freeze(['orbital cedar calibration protocol', 'deterministic actuator calibration']),
  commonTag: Object.freeze(['common-platform'])
})

export type PostgresSearchQueryKind = keyof typeof POSTGRES_SEARCH_QUERIES
export const POSTGRES_SEARCH_SCHEMA_VERSION = 2
export const POSTGRES_SEARCH_DEFAULT_THRESHOLDS = Object.freeze({
  maxRebuildMilliseconds: 300_000,
  maxQueryP95Milliseconds: 200
})

export interface PostgresSearchThresholds {
  maxRebuildMilliseconds: number
  maxQueryP95Milliseconds: number
}

export interface CorpusShape {
  pages: number
  renderedPages: number
  links: number
  distinctTags: number
  tagAssignments: number
  locales: { en: number; fr: number }
}

export interface DerivedSearchShape {
  vectors: number
  suggestionTerms: number
  revisionMismatches: number
  orphanVectors: number
}

export interface RepresentativeCheck {
  name: string
  passed: boolean
  expected: string
  observed: string
}

export interface LatencyDistribution {
  kind: PostgresSearchQueryKind
  queries: readonly string[]
  samples: number
  durationsMilliseconds: number[]
  p50Milliseconds: number
  p95Milliseconds: number
  p99Milliseconds: number
  maximumMilliseconds: number
}

export interface BenchmarkViolation {
  scope: 'environment' | 'corpus' | 'projection' | 'rebuild' | 'correctness' | PostgresSearchQueryKind
  invariant: string
  measured: number | string
  threshold: number | string
}

export interface PostgresSearchBenchmarkReport {
  reportVersion: 1
  status: 'passed' | 'failed'
  environment: {
    postgresVersion: string
    postgresMajorVersion: number
    pgTrgmVersion: string
  }
  corpus: {
    seed: number
    expected: CorpusShape
    observed: CorpusShape
  }
  searchSchema: {
    version: number
    dictionary: string
  }
  derivedSearch: DerivedSearchShape
  caps: typeof POSTGRES_SEARCH_CAPS
  iterations: number
  warmupsPerDistribution: number
  thresholds: PostgresSearchThresholds
  rebuildMilliseconds: number
  queryDistributions: LatencyDistribution[]
  representativeChecks: RepresentativeCheck[]
  thresholdViolations: BenchmarkViolation[]
}

export interface PostgresSearchBenchmarkInput {
  postgresVersion: string
  postgresMajorVersion: number
  pgTrgmVersion: string
  observedCorpus: CorpusShape
  derivedSearch: DerivedSearchShape
  searchSchemaVersion: number
  dictionary: string
  iterations: number
  warmupsPerDistribution: number
  thresholds: PostgresSearchThresholds
  rebuildMilliseconds: number
  querySamples: Record<PostgresSearchQueryKind, number[]>
  representativeChecks: RepresentativeCheck[]
}

export interface AtomicReportFileSystem {
  writeFile(path: string, contents: string, options: { flag: 'wx' }): Promise<unknown>
  rename(source: string, destination: string): Promise<unknown>
  rm(path: string, options: { force: true }): Promise<unknown>
}

const defaultAtomicReportFileSystem: AtomicReportFileSystem = fs
const queryKinds = Object.keys(POSTGRES_SEARCH_QUERIES) as PostgresSearchQueryKind[]

export const percentile = (values: readonly number[], quantile: number): number => {
  if (values.length === 0) throw new Error('Cannot calculate a percentile without samples')
  if (!Number.isFinite(quantile) || quantile <= 0 || quantile > 1) throw new Error('Percentile quantile must be in (0, 1]')
  const sorted = [...values].sort((left, right) => left - right)
  const value = sorted[Math.ceil(sorted.length * quantile) - 1]
  if (value === undefined) throw new Error('Percentile sample selection failed')
  return value
}

export const summarizeDurations = (kind: PostgresSearchQueryKind, durationsMilliseconds: readonly number[]): LatencyDistribution => ({
  kind,
  queries: POSTGRES_SEARCH_QUERIES[kind],
  samples: durationsMilliseconds.length,
  durationsMilliseconds: [...durationsMilliseconds],
  p50Milliseconds: percentile(durationsMilliseconds, 0.5),
  p95Milliseconds: percentile(durationsMilliseconds, 0.95),
  p99Milliseconds: percentile(durationsMilliseconds, 0.99),
  maximumMilliseconds: Math.max(...durationsMilliseconds)
})

const expectedCorpusShape = (): CorpusShape => ({
  pages: POSTGRES_SEARCH_CORPUS.pages,
  renderedPages: POSTGRES_SEARCH_CORPUS.renderedPages,
  links: POSTGRES_SEARCH_CORPUS.links,
  distinctTags: POSTGRES_SEARCH_CORPUS.distinctTags,
  tagAssignments: POSTGRES_SEARCH_CORPUS.tagAssignments,
  locales: { ...POSTGRES_SEARCH_CORPUS.locales }
})

export const createPostgresSearchBenchmarkReport = (input: PostgresSearchBenchmarkInput): PostgresSearchBenchmarkReport => {
  const expected = expectedCorpusShape()
  const queryDistributions = queryKinds.map(kind => summarizeDurations(kind, input.querySamples[kind]))
  const thresholdViolations: BenchmarkViolation[] = []

  if (input.postgresMajorVersion !== 17) {
    thresholdViolations.push({
      scope: 'environment',
      invariant: 'postgresMajorVersion === 17',
      measured: input.postgresMajorVersion,
      threshold: 17
    })
  }
  if (!input.pgTrgmVersion) {
    thresholdViolations.push({
      scope: 'environment',
      invariant: 'pg_trgm extension version is recorded',
      measured: input.pgTrgmVersion,
      threshold: 'non-empty version'
    })
  }
  for (const key of ['pages', 'renderedPages', 'links', 'distinctTags', 'tagAssignments'] as const) {
    if (input.observedCorpus[key] !== expected[key]) {
      thresholdViolations.push({
        scope: 'corpus',
        invariant: `observedCorpus.${key} === expectedCorpus.${key}`,
        measured: input.observedCorpus[key],
        threshold: expected[key]
      })
    }
  }
  for (const locale of ['en', 'fr'] as const) {
    if (input.observedCorpus.locales[locale] !== expected.locales[locale]) {
      thresholdViolations.push({
        scope: 'corpus',
        invariant: `observedCorpus.locales.${locale} === expectedCorpus.locales.${locale}`,
        measured: input.observedCorpus.locales[locale],
        threshold: expected.locales[locale]
      })
    }
  }
  if (input.derivedSearch.vectors !== expected.pages) {
    thresholdViolations.push({
      scope: 'projection',
      invariant: 'derivedSearch.vectors === expectedCorpus.pages',
      measured: input.derivedSearch.vectors,
      threshold: expected.pages
    })
  }
  if (input.derivedSearch.suggestionTerms <= 0) {
    thresholdViolations.push({
      scope: 'projection',
      invariant: 'derivedSearch.suggestionTerms > 0',
      measured: input.derivedSearch.suggestionTerms,
      threshold: 'positive count'
    })
  }
  for (const key of ['revisionMismatches', 'orphanVectors'] as const) {
    if (input.derivedSearch[key] !== 0) {
      thresholdViolations.push({
        scope: 'projection',
        invariant: `derivedSearch.${key} === 0`,
        measured: input.derivedSearch[key],
        threshold: 0
      })
    }
  }
  if (input.searchSchemaVersion !== POSTGRES_SEARCH_SCHEMA_VERSION) {
    thresholdViolations.push({
      scope: 'environment',
      invariant: `searchSchema.version === ${POSTGRES_SEARCH_SCHEMA_VERSION}`,
      measured: input.searchSchemaVersion,
      threshold: POSTGRES_SEARCH_SCHEMA_VERSION
    })
  }
  if (input.dictionary !== 'english') {
    thresholdViolations.push({
      scope: 'environment',
      invariant: "searchSchema.dictionary === 'english'",
      measured: input.dictionary,
      threshold: 'english'
    })
  }
  if (!Number.isFinite(input.rebuildMilliseconds) || input.rebuildMilliseconds > input.thresholds.maxRebuildMilliseconds) {
    thresholdViolations.push({
      scope: 'rebuild',
      invariant: 'rebuildMilliseconds <= thresholds.maxRebuildMilliseconds',
      measured: input.rebuildMilliseconds,
      threshold: input.thresholds.maxRebuildMilliseconds
    })
  }
  for (const distribution of queryDistributions) {
    if (distribution.samples !== input.iterations) {
      thresholdViolations.push({
        scope: distribution.kind,
        invariant: 'distribution.samples === iterations',
        measured: distribution.samples,
        threshold: input.iterations
      })
    }
    if (!Number.isFinite(distribution.p95Milliseconds) || distribution.p95Milliseconds > input.thresholds.maxQueryP95Milliseconds) {
      thresholdViolations.push({
        scope: distribution.kind,
        invariant: 'p95Milliseconds <= thresholds.maxQueryP95Milliseconds',
        measured: distribution.p95Milliseconds,
        threshold: input.thresholds.maxQueryP95Milliseconds
      })
    }
  }
  const failedChecks = input.representativeChecks.filter(check => !check.passed)
  if (failedChecks.length > 0) {
    thresholdViolations.push({
      scope: 'correctness',
      invariant: 'all representative result checks pass',
      measured: failedChecks.length,
      threshold: 0
    })
  }

  return {
    reportVersion: 1,
    status: thresholdViolations.length === 0 ? 'passed' : 'failed',
    environment: {
      postgresVersion: input.postgresVersion,
      postgresMajorVersion: input.postgresMajorVersion,
      pgTrgmVersion: input.pgTrgmVersion
    },
    corpus: { seed: POSTGRES_SEARCH_CORPUS.seed, expected, observed: input.observedCorpus },
    searchSchema: { version: input.searchSchemaVersion, dictionary: input.dictionary },
    derivedSearch: input.derivedSearch,
    caps: POSTGRES_SEARCH_CAPS,
    iterations: input.iterations,
    warmupsPerDistribution: input.warmupsPerDistribution,
    thresholds: input.thresholds,
    rebuildMilliseconds: input.rebuildMilliseconds,
    queryDistributions,
    representativeChecks: input.representativeChecks,
    thresholdViolations
  }
}

export const writeBenchmarkReportAtomically = async (
  path: string,
  serialized: string,
  fileSystem: AtomicReportFileSystem = defaultAtomicReportFileSystem
): Promise<void> => {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fileSystem.writeFile(temporaryPath, serialized, { flag: 'wx' })
    await fileSystem.rename(temporaryPath, path)
  } catch (error: unknown) {
    await fileSystem.rm(temporaryPath, { force: true })
    throw error
  }
}

export const publishPostgresSearchBenchmarkReport = async (
  report: PostgresSearchBenchmarkReport,
  path: string,
  fileSystem: AtomicReportFileSystem = defaultAtomicReportFileSystem
): Promise<void> => {
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  await writeBenchmarkReportAtomically(path, serialized, fileSystem)
  process.stdout.write(serialized)
  if (report.status === 'failed') {
    throw new Error(
      `PostgreSQL search benchmark failed: ${report.thresholdViolations.map(violation => `${violation.scope}: ${violation.invariant}`).join('; ')}`
    )
  }
}

const positiveInteger = (name: string, fallback: number, minimum: number): number => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer of at least ${minimum}`)
  return value
}

const positiveNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`)
  return value
}

const recreateSourceSchema = async (knex: Knex): Promise<void> => {
  await knex.raw(`
    DROP TABLE IF EXISTS "pageAccessPasswords", "pageLinks", "pageTags", tags, pages CASCADE;
    CREATE TABLE pages (
      id integer PRIMARY KEY,
      "sourceRevision" bigint NOT NULL,
      path text NOT NULL,
      "localeCode" varchar(35) NOT NULL,
      title text NOT NULL,
      description text,
      render text NOT NULL,
      visibility text NOT NULL,
      "isPublished" boolean NOT NULL
    );
    CREATE TABLE tags (
      id integer PRIMARY KEY,
      tag text NOT NULL UNIQUE,
      title text NOT NULL
    );
    CREATE TABLE "pageTags" (
      "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      "tagId" integer NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY ("pageId", "tagId")
    );
    CREATE TABLE "pageLinks" (
      "pageId" integer NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
      "localeCode" varchar(35) NOT NULL,
      path text NOT NULL,
      PRIMARY KEY ("pageId", "localeCode", path)
    );
    CREATE TABLE "pageAccessPasswords" (
      "pageId" integer PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE
    );
  `)
}

const prepareCorpus = async (knex: Knex): Promise<void> => {
  await knex.raw(
    `
      INSERT INTO pages (id, "sourceRevision", path, "localeCode", title, description, render, visibility, "isPublished")
      SELECT
        sequence,
        sequence,
        'knowledge/topic-' || (sequence % 200) || '/page-' || sequence,
        CASE WHEN sequence <= 18000 THEN 'en' ELSE 'fr' END,
        CASE
          WHEN sequence = 42 THEN 'Amber Falcon Runbook'
          WHEN sequence = 314 THEN 'Celestial Harbor Handbook'
          ELSE 'Benchmark Page ' || sequence || ' Seed ' || ?
        END,
        CASE
          WHEN sequence = 2718 THEN 'Orbital cedar calibration protocol for deterministic actuator calibration'
          ELSE 'Deterministic description for benchmark page ' || sequence || ' in topic ' || (sequence % 200)
        END,
        CASE
          WHEN sequence = 42 THEN '<article><h1>Amber Falcon</h1><p>ultraviolet marmot checksum recovery procedure</p></article>'
          ELSE '<article><h1>Rendered page ' || sequence || '</h1><p>Deterministic corpus seed ' || ? || ' content family ' || (sequence % 97) || '</p></article>'
        END,
        'public',
        true
      FROM generate_series(1, ?) AS sequence
    `,
    [POSTGRES_SEARCH_CORPUS.seed, POSTGRES_SEARCH_CORPUS.seed, POSTGRES_SEARCH_CORPUS.pages]
  )
  await knex.raw(`
    INSERT INTO tags (id, tag, title) VALUES (1, 'common-platform', 'Common Platform');
    INSERT INTO tags (id, tag, title)
    SELECT sequence + 2, 'topic-' || sequence, 'Topic ' || sequence
    FROM generate_series(0, 19) AS sequence;

    INSERT INTO "pageTags" ("pageId", "tagId")
    SELECT id, (id % 20) + 2 FROM pages;
    INSERT INTO "pageTags" ("pageId", "tagId")
    SELECT id, 1 FROM pages WHERE id % 4 = 0;

    INSERT INTO "pageLinks" ("pageId", "localeCode", path)
    SELECT
      source.id,
      source."localeCode",
      target.path
    FROM pages source
    JOIN pages target ON target.id = CASE
      WHEN source.id < 18000 THEN source.id + 1
      WHEN source.id = 18000 THEN 1
      WHEN source.id < 20000 THEN source.id + 1
      ELSE 18001
    END;

    ANALYZE pages;
    ANALYZE tags;
    ANALYZE "pageTags";
    ANALYZE "pageLinks";
  `)
}

const countValue = (value: unknown): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid corpus count ${String(value)}`)
  return parsed
}

const observeCorpus = async (knex: Knex): Promise<CorpusShape> => {
  const result = await knex.raw<{
    rows: Array<{
      pages: unknown
      renderedPages: unknown
      links: unknown
      distinctTags: unknown
      tagAssignments: unknown
      englishPages: unknown
      frenchPages: unknown
    }>
  }>(`
    SELECT
      (SELECT count(*) FROM pages) AS pages,
      (SELECT count(*) FROM pages WHERE render <> '') AS "renderedPages",
      (SELECT count(*) FROM "pageLinks") AS links,
      (SELECT count(*) FROM tags) AS "distinctTags",
      (SELECT count(*) FROM "pageTags") AS "tagAssignments",
      (SELECT count(*) FROM pages WHERE "localeCode" = 'en') AS "englishPages",
      (SELECT count(*) FROM pages WHERE "localeCode" = 'fr') AS "frenchPages"
  `)
  const row = result.rows[0]
  if (!row) throw new Error('PostgreSQL did not return corpus counts')
  return {
    pages: countValue(row.pages),
    renderedPages: countValue(row.renderedPages),
    links: countValue(row.links),
    distinctTags: countValue(row.distinctTags),
    tagAssignments: countValue(row.tagAssignments),
    locales: { en: countValue(row.englishPages), fr: countValue(row.frenchPages) }
  }
}

const observeDerivedSearch = async (knex: Knex): Promise<DerivedSearchShape> => {
  const result = await knex.raw<{
    rows: Array<{ vectors: unknown; suggestionTerms: unknown; revisionMismatches: unknown; orphanVectors: unknown }>
  }>(`
    SELECT
      (SELECT count(*) FROM "pagesVector") AS vectors,
      (SELECT count(*) FROM "pagesWords") AS "suggestionTerms",
      (
        SELECT count(*)
        FROM pages page
        LEFT JOIN "pagesVector" vector ON vector."pageId" = page.id
        WHERE page.visibility = 'public'
          AND page."isPublished" = true
          AND (vector."pageId" IS NULL OR vector."sourceRevision" IS DISTINCT FROM page."sourceRevision")
      ) AS "revisionMismatches",
      (
        SELECT count(*)
        FROM "pagesVector" vector
        LEFT JOIN pages page ON page.id = vector."pageId"
        WHERE page.id IS NULL
          OR page.visibility IS DISTINCT FROM 'public'
          OR page."isPublished" IS DISTINCT FROM true
      ) AS "orphanVectors"
  `)
  const row = result.rows[0]
  if (!row) throw new Error('PostgreSQL did not return derived search counts')
  return {
    vectors: countValue(row.vectors),
    suggestionTerms: countValue(row.suggestionTerms),
    revisionMismatches: countValue(row.revisionMismatches),
    orphanVectors: countValue(row.orphanVectors)
  }
}

interface SearchRow {
  id: number
  tags: string[]
}

interface SearchResponse {
  results: SearchRow[]
}

interface BenchmarkEngine {
  config: { dictLanguage: string }
  init(): Promise<void>
  rebuild(): Promise<void>
  query(query: string, options: { locale?: string; path?: string }): Promise<SearchResponse>
}

const asSearchResponse = (value: unknown): SearchResponse => {
  if (!value || typeof value !== 'object' || !Array.isArray(Reflect.get(value, 'results'))) throw new Error('Search engine returned an invalid result')
  return value as SearchResponse
}

const benchmarkQueries = async (engine: BenchmarkEngine, iterations: number, warmups: number): Promise<Record<PostgresSearchQueryKind, number[]>> => {
  const samples = Object.fromEntries(queryKinds.map(kind => [kind, []])) as unknown as Record<PostgresSearchQueryKind, number[]>
  for (const kind of queryKinds) {
    const queries = POSTGRES_SEARCH_QUERIES[kind]
    for (let index = 0; index < warmups + iterations; index += 1) {
      const query = queries[index % queries.length]
      if (query === undefined) throw new Error(`PostgreSQL search benchmark query set "${kind}" is empty`)
      const startedAt = performance.now()
      await engine.query(query, {})
      const duration = performance.now() - startedAt
      if (index >= warmups) samples[kind].push(duration)
    }
  }
  return samples
}

const representativeChecks = async (engine: BenchmarkEngine): Promise<RepresentativeCheck[]> => {
  const exactTitle = asSearchResponse(await engine.query('Amber Falcon Runbook', { locale: 'en' }))
  const exactContent = asSearchResponse(await engine.query('ultraviolet marmot checksum', { locale: 'en' }))
  const typo = asSearchResponse(await engine.query('celestal harbor handbook', { locale: 'en' }))
  const description = asSearchResponse(await engine.query('orbital cedar calibration protocol', { locale: 'en' }))
  const commonTag = asSearchResponse(await engine.query('common-platform', { locale: 'en' }))
  return [
    {
      name: 'exact title ranks the seeded page first',
      passed: exactTitle.results[0]?.id === 42,
      expected: 'first page id 42',
      observed: `first page id ${exactTitle.results[0]?.id ?? '<none>'}`
    },
    {
      name: 'rendered content retrieves the seeded page',
      passed: exactContent.results.some(result => result.id === 42),
      expected: 'results include page id 42',
      observed: `result ids ${exactContent.results.map(result => result.id).join(',') || '<none>'}`
    },
    {
      name: 'typo fallback retrieves the seeded page',
      passed: typo.results.some(result => result.id === 314),
      expected: 'results include page id 314',
      observed: `result ids ${typo.results.map(result => result.id).join(',') || '<none>'}`
    },
    {
      name: 'multi-term description retrieves the seeded page',
      passed: description.results.some(result => result.id === 2718),
      expected: 'results include page id 2718',
      observed: `result ids ${description.results.map(result => result.id).join(',') || '<none>'}`
    },
    {
      name: 'common tag fills the cap with matching pages',
      passed:
        commonTag.results.length === POSTGRES_SEARCH_CAPS.maxHits &&
        commonTag.results.every(result => Array.isArray(result.tags) && result.tags.includes('common-platform')),
      expected: `${POSTGRES_SEARCH_CAPS.maxHits} results tagged common-platform`,
      observed: `${commonTag.results.length} results, ${commonTag.results.filter(result => result.tags?.includes('common-platform')).length} tagged common-platform`
    }
  ]
}

const installBenchmarkWiki = (knex: Knex): void => {
  Reflect.set(globalThis, 'WIKI', {
    config: { db: { type: 'postgres' }, search: { maxHits: POSTGRES_SEARCH_CAPS.maxHits } },
    Error: { SearchActivationFailed: class SearchActivationFailed extends Error {} },
    logger: {
      info: () => undefined,
      warn: (message: unknown) => process.stderr.write(`${String(message)}\n`),
      error: (message: unknown) => process.stderr.write(`${String(message)}\n`)
    },
    models: {
      knex,
      pages: {
        cleanHTML: (render: string): string =>
          render
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLocaleLowerCase()
      }
    }
  })
}

export const runPostgresSearchBenchmark = async (): Promise<void> => {
  const connection = process.env.WIKI_BENCHMARK_DATABASE_URL
  if (!connection) throw new Error('WIKI_BENCHMARK_DATABASE_URL is required')
  const configuredDatabaseName = decodeURIComponent(new URL(connection).pathname.replace(/^\/+/u, ''))
  if (!configuredDatabaseName.endsWith('_postgres_search_benchmark')) {
    throw new Error(`Refusing to connect to non-dedicated database ${configuredDatabaseName || '<unknown>'}`)
  }
  const outputPath = process.env.POSTGRES_SEARCH_BENCHMARK_FILE ?? 'postgres-search-benchmark.json'
  const iterations = positiveInteger('POSTGRES_SEARCH_BENCHMARK_ITERATIONS', 30, 5)
  const warmupsPerDistribution = positiveInteger('POSTGRES_SEARCH_BENCHMARK_WARMUPS', 5, 1)
  const thresholds: PostgresSearchThresholds = {
    maxRebuildMilliseconds: positiveNumber('POSTGRES_SEARCH_MAX_REBUILD_MS', POSTGRES_SEARCH_DEFAULT_THRESHOLDS.maxRebuildMilliseconds),
    maxQueryP95Milliseconds: positiveNumber('POSTGRES_SEARCH_MAX_QUERY_P95_MS', POSTGRES_SEARCH_DEFAULT_THRESHOLDS.maxQueryP95Milliseconds)
  }
  const knex = knexModule({ client: 'pg', connection, pool: { min: 1, max: 1 } })
  try {
    const database = await knex.raw<{ rows: Array<{ name: string }> }>('SELECT current_database() AS name')
    const databaseName = database.rows[0]?.name ?? ''
    if (!databaseName.endsWith('_postgres_search_benchmark')) {
      throw new Error(`Refusing to benchmark in non-dedicated database ${databaseName || '<unknown>'}`)
    }

    await recreateSourceSchema(knex)
    installBenchmarkWiki(knex)
    // The engine captures the WIKI runtime during module evaluation, so the isolated benchmark runtime must exist before it is loaded.
    const engineModule = await import('../modules/search/postgres/engine.ts')
    const engine = Object.assign(engineModule.default, { config: { dictLanguage: 'english' } }) as unknown as BenchmarkEngine
    await engine.init()
    await prepareCorpus(knex)

    const rebuildStartedAt = performance.now()
    await engine.rebuild()
    const rebuildMilliseconds = performance.now() - rebuildStartedAt
    await knex.raw('ANALYZE "pagesVector"; ANALYZE "pagesWords";')

    const querySamples = await benchmarkQueries(engine, iterations, warmupsPerDistribution)
    const checks = await representativeChecks(engine)
    const observedCorpus = await observeCorpus(knex)
    const derivedSearch = await observeDerivedSearch(knex)
    const versions = await knex.raw<{ rows: Array<{ postgresVersion: string; postgresMajorVersion: unknown; pgTrgmVersion: string }> }>(`
      SELECT
        current_setting('server_version') AS "postgresVersion",
        current_setting('server_version_num')::integer / 10000 AS "postgresMajorVersion",
        COALESCE((SELECT extversion FROM pg_extension WHERE extname = 'pg_trgm'), '') AS "pgTrgmVersion"
    `)
    const metadata = await knex.raw<{ rows: Array<{ schemaVersion: unknown; dictionary: string }> }>(
      'SELECT "schemaVersion", dictionary FROM "pagesSearchMetadata" WHERE "contractId" = 1'
    )
    const version = versions.rows[0]
    const schema = metadata.rows[0]
    if (!version || !schema) throw new Error('PostgreSQL search benchmark metadata is missing')

    const report = createPostgresSearchBenchmarkReport({
      postgresVersion: version.postgresVersion,
      postgresMajorVersion: countValue(version.postgresMajorVersion),
      pgTrgmVersion: version.pgTrgmVersion,
      observedCorpus,
      derivedSearch,
      searchSchemaVersion: countValue(schema.schemaVersion),
      dictionary: schema.dictionary,
      iterations,
      warmupsPerDistribution,
      thresholds,
      rebuildMilliseconds,
      querySamples,
      representativeChecks: checks
    })
    await publishPostgresSearchBenchmarkReport(report, outputPath)
  } finally {
    await knex.destroy()
  }
}

if (import.meta.main) await runPostgresSearchBenchmark()
