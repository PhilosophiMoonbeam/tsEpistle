import type { Knex } from 'knex'

interface MigrationRecord {
  id: number
  name: string
}

interface MigrationLockRecord {
  is_locked: boolean | number
}

export interface MigrationPreflightResult {
  applied: string[]
  available: string[]
  state: 'fresh' | 'legacy-beta' | 'ready'
}

export interface MigrationPreflightOptions {
  legacyMigrationNames?: string[]
}

export class MigrationPreflightError extends Error {
  readonly code = 'MIGRATION_PREFLIGHT_FAILED'
}

const applicationTables = ['pages', 'users', 'groups'] as const

const existingApplicationTables = async (knex: Knex): Promise<string[]> => {
  const exists = await Promise.all(applicationTables.map(async table => ({
    exists: await knex.schema.hasTable(table),
    table
  })))
  return exists.filter(result => result.exists).map(result => result.table)
}

const availableMigrationNames = async (
  migrationSource: Knex.MigrationSource<unknown>
): Promise<string[]> => {
  const migrations = await migrationSource.getMigrations([])
  return migrations.map(migration => migrationSource.getMigrationName(migration))
}

const assertMigrationLockIsClear = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable('migrations_lock')) return
  const lock = await knex<MigrationLockRecord>('migrations_lock').first('is_locked')
  if (lock && (lock.is_locked === true || Number(lock.is_locked) === 1)) {
    throw new MigrationPreflightError(
      'Database migrations are locked. Confirm that no other Wiki.ts instance is migrating, then clear a stale lock before retrying.'
    )
  }
}

export const preflightMigrations = async (
  knex: Knex,
  migrationSource: Knex.MigrationSource<unknown>,
  options: MigrationPreflightOptions = {}
): Promise<MigrationPreflightResult> => {
  const [hasLedger, applicationTableNames, available] = await Promise.all([
    knex.schema.hasTable('migrations'),
    existingApplicationTables(knex),
    availableMigrationNames(migrationSource)
  ])

  if (!hasLedger) {
    if (applicationTableNames.length > 0) {
      throw new MigrationPreflightError(
        `Database contains Wiki application tables (${applicationTableNames.join(', ')}) but has no migrations ledger. Refusing to infer or overwrite its schema.`
      )
    }
    return { applied: [], available, state: 'fresh' }
  }

  await assertMigrationLockIsClear(knex)
  const records = await knex<MigrationRecord>('migrations').select('id', 'name').orderBy('id', 'asc')
  const applied = records.map(record => record.name)

  if (applied.length === 0) {
    if (applicationTableNames.length > 0) {
      throw new MigrationPreflightError(
        `Database contains Wiki application tables (${applicationTableNames.join(', ')}) but its migrations ledger is empty. Refusing a potentially partial migration.`
      )
    }
    return { applied, available, state: 'fresh' }
  }

  const legacyMigrationNames = options.legacyMigrationNames ?? []
  if (applied.some(name => legacyMigrationNames.includes(name))) {
    const unknownLegacy = applied.filter(name => !legacyMigrationNames.includes(name))
    if (unknownLegacy.length > 0) {
      throw new MigrationPreflightError(
        `Legacy beta migration history contains unsupported records (${unknownLegacy.join(', ')}). Restore a consistent backup before retrying.`
      )
    }
    const expectedLegacyPrefix = legacyMigrationNames.slice(0, applied.length)
    const legacyMismatchIndex = applied.findIndex((name, index) => name !== expectedLegacyPrefix[index])
    if (legacyMismatchIndex >= 0) {
      throw new MigrationPreflightError(
        `Legacy beta migration history is incomplete or out of order at ${applied[legacyMismatchIndex]}. Restore a consistent backup before retrying.`
      )
    }
    if (applicationTableNames.length === 0) {
      throw new MigrationPreflightError(
        'Database has applied legacy beta migration records but none of the expected Wiki application tables. Refusing a partial schema.'
      )
    }
    return { applied, available, state: 'legacy-beta' }
  }
  const unknown = applied.filter(name => !available.includes(name))
  if (unknown.length > 0) {
    throw new MigrationPreflightError(
      `Database was migrated by an unknown or newer build (${unknown.join(', ')}). Upgrade Wiki.ts instead of running this older migration set.`
    )
  }

  const expectedPrefix = available.slice(0, applied.length)
  const mismatchIndex = applied.findIndex((name, index) => name !== expectedPrefix[index])
  if (mismatchIndex >= 0) {
    throw new MigrationPreflightError(
      `Database migration history is incomplete or out of order at ${applied[mismatchIndex]}. Restore a consistent backup before retrying.`
    )
  }

  if (applicationTableNames.length === 0) {
    throw new MigrationPreflightError(
      'Database has applied migration records but none of the expected Wiki application tables. Refusing a partial schema.'
    )
  }

  return { applied, available, state: 'ready' }
}
