import { performance } from 'node:perf_hooks'
import knexModule from 'knex'

import { scopePageQueryForOwner } from '../helpers/page-access.ts'
import { listPageIndexCandidates, PAGE_INDEX_CANDIDATE_LIMIT, type PageIndexCandidate } from '../repositories/page-index.ts'

const connection = process.env.WIKI_BENCHMARK_DATABASE_URL
if (!connection) throw new Error('WIKI_BENCHMARK_DATABASE_URL is required')

const outputPath = process.env.PAGE_INDEX_BENCHMARK_FILE
const iterations = Number(process.env.PAGE_INDEX_BENCHMARK_ITERATIONS ?? 30)
const warmups = Number(process.env.PAGE_INDEX_BENCHMARK_WARMUPS ?? 5)
const maxP95Milliseconds = Number(process.env.PAGE_INDEX_MAX_P95_MS ?? 250)
if (!Number.isSafeInteger(iterations) || iterations < 5) throw new Error('PAGE_INDEX_BENCHMARK_ITERATIONS must be at least 5')
if (!Number.isSafeInteger(warmups) || warmups < 1) throw new Error('PAGE_INDEX_BENCHMARK_WARMUPS must be positive')

const db = knexModule({ client: 'pg', connection, pool: { min: 1, max: 1 } })
const databaseNameResult = await db.raw<{ rows: Array<{ name: string }> }>('SELECT current_database() AS name')
const databaseName = databaseNameResult.rows[0]?.name ?? ''
if (!databaseName.endsWith('_page_index_benchmark')) {
  throw new Error(`Refusing to benchmark in non-dedicated database ${databaseName || '<unknown>'}`)
}

type Principal = 'anonymous' | 'owner' | 'restricted-group' | 'administrator'

const percentile = (sorted: number[], quantile: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0

const selectVisible = (
  candidates: PageIndexCandidate[],
  principal: Principal
): PageIndexCandidate[] => candidates.filter(page => {
  if (page.visibility === 'private') return principal === 'administrator' || (principal === 'owner' && page.ownerId === 7)
  if (principal === 'restricted-group') {
    return !page.tags.some(tag => tag.tag === 'restricted') && !page.path.startsWith('guide/denied/')
  }
  return true
})

const prepareDataset = async (): Promise<void> => {
  await db.schema.dropTableIfExists('pageTags')
  await db.schema.dropTableIfExists('tags')
  await db.schema.dropTableIfExists('pages')
  await db.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.string('localeCode', 8).notNullable()
    table.string('path', 512).notNullable()
    table.string('title', 255).notNullable()
    table.text('description').nullable()
    table.string('visibility', 16).notNullable()
    table.integer('ownerId').nullable()
    table.timestamp('updatedAt').notNullable()
    table.index(['localeCode', 'path'], 'page_index_benchmark_locale_path')
  })
  await db.schema.createTable('tags', table => {
    table.integer('id').primary()
    table.string('tag', 255).notNullable().unique()
  })
  await db.schema.createTable('pageTags', table => {
    table.integer('pageId').notNullable()
    table.integer('tagId').notNullable()
    table.index(['pageId', 'tagId'], 'page_index_benchmark_page_tags')
  })
  await db('tags').insert([{ id: 1, tag: 'docs' }, { id: 2, tag: 'restricted' }, { id: 3, tag: 'deep' }])
  await db.raw(`
    INSERT INTO pages (id, "localeCode", path, title, description, visibility, "ownerId", "updatedAt")
    SELECT sequence,
      CASE WHEN sequence <= 4800 THEN 'en' WHEN sequence <= 6000 THEN 'fr' ELSE 'de' END,
      CASE
        WHEN sequence <= 4800 AND sequence % 11 = 0 THEN 'guide/denied/' || sequence
        WHEN sequence <= 4800 AND sequence % 5 = 0 THEN 'guide/deep/section-' || (sequence % 40) || '/page-' || sequence
        WHEN sequence <= 4800 THEN 'guide/page-' || sequence
        ELSE 'other/page-' || sequence
      END,
      'Page ' || sequence,
      CASE WHEN sequence % 7 = 0 THEN NULL ELSE 'Benchmark page ' || sequence END,
      CASE WHEN sequence <= 4800 AND sequence % 10 = 0 THEN 'private' ELSE 'public' END,
      CASE WHEN sequence <= 4800 AND sequence % 10 = 0 THEN CASE WHEN sequence % 20 = 0 THEN 7 ELSE 8 END ELSE NULL END,
      TIMESTAMP '2026-01-01 00:00:00' + sequence * INTERVAL '1 second'
    FROM generate_series(1, 7200) AS sequence
  `)
  await db.raw(`
    INSERT INTO "pageTags" ("pageId", "tagId")
    SELECT id, CASE WHEN id % 13 = 0 THEN 2 WHEN id % 5 = 0 THEN 3 ELSE 1 END
    FROM pages
  `)
  await db.raw('ANALYZE pages')
  await db.raw('ANALYZE "pageTags"')
  await db.raw('ANALYZE tags')
}

interface PrincipalMetrics {
  principal: Principal
  items: number
  p50Milliseconds: number
  p95Milliseconds: number
  p99Milliseconds: number
  maxHeapGrowthBytes: number
  queriesPerIteration: number
  peakConnectionsUsed: number
  candidatePlanRows: number
  rowsRemovedByFilter: number
  sharedBlocksRead: number
  sharedBlocksHit: number
}

const benchmarkPrincipal = async (
  principal: Principal,
  ownerId: number | null,
  includeAll: boolean
): Promise<PrincipalMetrics> => {
  const durations: number[] = []
  let maxHeapGrowthBytes = 0
  let queryCount = 0
  let peakConnectionsUsed = 0
  const onQuery = (): void => {
    queryCount += 1
    peakConnectionsUsed = Math.max(peakConnectionsUsed, db.client.pool.numUsed())
  }
  db.on('query', onQuery)
  let visible: PageIndexCandidate[] = []
  try {
    for (let iteration = 0; iteration < warmups + iterations; iteration += 1) {
      const heapBefore = process.memoryUsage().heapUsed
      const startedAt = performance.now()
      const candidates = await listPageIndexCandidates(db, {
        locale: 'en',
        path: 'guide',
        scope: query => {
          if (!includeAll) scopePageQueryForOwner(query, ownerId, { table: 'pages' })
        }
      })
      visible = selectVisible(candidates, principal)
        .filter(page => page.path.slice('guide/'.length).split('/').length <= 3)
        .sort((left, right) => left.path.localeCompare(right.path))
        .slice(0, 200)
      const duration = performance.now() - startedAt
      maxHeapGrowthBytes = Math.max(maxHeapGrowthBytes, process.memoryUsage().heapUsed - heapBefore)
      if (iteration >= warmups) durations.push(duration)
    }
  } finally {
    db.removeListener('query', onQuery)
  }
  durations.sort((left, right) => left - right)

  const visibilitySql = includeAll
    ? ''
    : ownerId === null
      ? `AND visibility = 'public'`
      : `AND (visibility = 'public' OR (visibility = 'private' AND "ownerId" = ?))`
  const bindings = ownerId === null || includeAll ? ['en', 'guide/'] : ['en', 'guide/', ownerId]
  const explained = await db.raw<{ rows: Array<{ 'QUERY PLAN': unknown }> }>(`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT id, path, "localeCode", title, description, visibility, "ownerId", "updatedAt"
    FROM pages
    WHERE "localeCode" = ? AND starts_with(path, ?) ${visibilitySql}
    ORDER BY path ASC
    LIMIT ${PAGE_INDEX_CANDIDATE_LIMIT}
  `, bindings)
  const document = explained.rows[0]?.['QUERY PLAN']
  if (!Array.isArray(document) || !document[0] || typeof document[0] !== 'object') throw new Error('PostgreSQL returned an invalid EXPLAIN document')
  const root = Reflect.get(document[0], 'Plan')
  if (!root || typeof root !== 'object') throw new Error('PostgreSQL EXPLAIN did not include a root plan')
  let rowsRemovedByFilter = 0
  let sharedBlocksRead = 0
  let sharedBlocksHit = 0
  const visitPlan = (node: object): void => {
    const removed = Reflect.get(node, 'Rows Removed by Filter')
    const read = Reflect.get(node, 'Shared Read Blocks')
    const hit = Reflect.get(node, 'Shared Hit Blocks')
    if (typeof removed === 'number') rowsRemovedByFilter += removed
    if (typeof read === 'number') sharedBlocksRead += read
    if (typeof hit === 'number') sharedBlocksHit += hit
    const children = Reflect.get(node, 'Plans')
    if (Array.isArray(children)) children.filter((child): child is object => Boolean(child && typeof child === 'object')).forEach(visitPlan)
  }
  visitPlan(root)
  const candidatePlanRows = Reflect.get(root, 'Actual Rows')
  if (typeof candidatePlanRows !== 'number') throw new Error('PostgreSQL EXPLAIN did not report actual rows')

  return {
    principal,
    items: visible.length,
    p50Milliseconds: percentile(durations, 0.5),
    p95Milliseconds: percentile(durations, 0.95),
    p99Milliseconds: percentile(durations, 0.99),
    maxHeapGrowthBytes,
    queriesPerIteration: queryCount / (warmups + iterations),
    peakConnectionsUsed,
    candidatePlanRows,
    rowsRemovedByFilter,
    sharedBlocksRead,
    sharedBlocksHit
  }
}

try {
  await prepareDataset()
  const principals: PrincipalMetrics[] = []
  for (const specification of [
    { principal: 'anonymous', ownerId: null, includeAll: false },
    { principal: 'owner', ownerId: 7, includeAll: false },
    { principal: 'restricted-group', ownerId: null, includeAll: false },
    { principal: 'administrator', ownerId: null, includeAll: true }
  ] satisfies Array<{ principal: Principal, ownerId: number | null, includeAll: boolean }>) {
    principals.push(await benchmarkPrincipal(specification.principal, specification.ownerId, specification.includeAll))
  }
  await db('pages').insert({
    id: 100_001,
    localeCode: 'en',
    path: 'overflow/page-5001',
    title: 'Overflow 5001',
    description: null,
    visibility: 'public',
    ownerId: null,
    updatedAt: new Date('2026-01-02T00:00:00.000Z')
  })
  await db.raw(`
    INSERT INTO pages (id, "localeCode", path, title, description, visibility, "ownerId", "updatedAt")
    SELECT 100001 + sequence, 'en', 'overflow/page-' || sequence, 'Overflow ' || sequence, NULL, 'public', NULL, TIMESTAMP '2026-01-02 00:00:00'
    FROM generate_series(1, 5000) AS sequence
  `)
  const overflow = await listPageIndexCandidates(db, {
    locale: 'en',
    path: 'overflow',
    scope: query => { scopePageQueryForOwner(query, null, { table: 'pages' }) }
  })
  if (overflow.length !== PAGE_INDEX_CANDIDATE_LIMIT) throw new Error('The repository did not expose the 5,001-candidate overflow sentinel')
  if (principals.some(metric => metric.p95Milliseconds > maxP95Milliseconds)) {
    throw new Error(`Page index p95 exceeded ${maxP95Milliseconds} ms`)
  }
  if (principals.some(metric => metric.queriesPerIteration !== 2 || metric.peakConnectionsUsed > 1)) {
    throw new Error('Page index repository exceeded its two-query, one-connection contract')
  }
  const version = await db.raw<{ rows: Array<{ server_version: string }> }>('SHOW server_version')
  const report = {
    schemaVersion: 1,
    postgresVersion: version.rows[0]?.server_version ?? 'unknown',
    dataset: { pages: 7200, benchmarkLocalePages: 4800, overflowCandidates: overflow.length },
    iterations,
    warmups,
    maxP95Milliseconds,
    principals,
    projectionRequired: false
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (outputPath) await import('node:fs/promises').then(fs => fs.writeFile(outputPath, serialized))
  process.stdout.write(serialized)
} finally {
  await db.destroy()
}
