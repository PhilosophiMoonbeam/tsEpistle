import type { Knex } from 'knex'
import { publicationTimestampPattern } from '../../shared/publication-window.ts'

export const SEARCH_INDEX_LOCK = 'wiki.search.postgres.derived-index'
const SEARCH_PAGE_LOCK = 'wiki.search.postgres.page'
const hasAdvisoryLocks = (db: Knex | Knex.Transaction): boolean =>
  !['sqlite3', 'better-sqlite3', 'mysql', 'mysql2', 'mssql', 'oracle', 'oracledb'].includes(db.client.config.client)

// PostgreSQL 15 has no pg_input_is_valid. Guard the cast itself with CASE;
// boolean predicate order is not a guarantee against malformed persisted dates.

/** A trusted SQL text expression; malformed ISO/calendar values produce NULL. */
export const publicationTimestampSql = (expression: string): string =>
  `(CASE WHEN ${expression} ~ '${publicationTimestampPattern}' AND left(${expression}, 4) <> '0000' THEN ${expression}::timestamptz ELSE NULL END)`

export const lockSearchIndex = async (trx: Knex.Transaction, exclusive: boolean, wait = true): Promise<void> => {
  if (!hasAdvisoryLocks(trx)) return
  const lock = exclusive
    ? wait
      ? 'pg_advisory_xact_lock'
      : 'pg_try_advisory_xact_lock'
    : wait
      ? 'pg_advisory_xact_lock_shared'
      : 'pg_try_advisory_xact_lock_shared'
  const result = await trx.raw<{ rows: Array<{ acquired: boolean }> }>(`SELECT ${lock}(hashtext(?)) AS acquired`, [SEARCH_INDEX_LOCK])
  if (!wait && result.rows[0]?.acquired !== true) throw new Error('PostgreSQL search rebuild is already in progress')
}

export const lockSearchPage = async (trx: Knex.Transaction, pageId: number): Promise<void> => {
  if (!Number.isSafeInteger(pageId) || pageId <= 0 || pageId > 2147483647) throw new Error('Invalid search page identity')
  if (!hasAdvisoryLocks(trx)) return
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), ?::integer)', [SEARCH_PAGE_LOCK, pageId])
}

export const readSearchDictionary = async (db: Knex | Knex.Transaction): Promise<string> => {
  const result = await db.raw<{
    rows: Array<{ contractId: number; dictionary: string; valid: boolean }>
  }>(`
    SELECT "contractId", dictionary, dictionary::regconfig IS NOT NULL AS valid
    FROM "pagesSearchMetadata"
  `)
  const metadata = result.rows[0]
  if (
    result.rows.length !== 1 ||
    metadata?.contractId !== 1 ||
    typeof metadata.dictionary !== 'string' ||
    metadata.dictionary.trim() !== metadata.dictionary ||
    !metadata.dictionary ||
    metadata.valid !== true
  )
    throw new Error('PostgreSQL search dictionary metadata is missing or invalid')
  return metadata.dictionary
}

export const withSearchContract = async <T>(db: Knex | Knex.Transaction, work: (trx: Knex.Transaction, dictionary: string) => Promise<T>): Promise<T> => {
  const run = async (trx: Knex.Transaction): Promise<T> => {
    await lockSearchIndex(trx, false)
    return work(trx, await readSearchDictionary(trx))
  }
  return db.isTransaction ? run(db as Knex.Transaction) : db.transaction(run)
}
