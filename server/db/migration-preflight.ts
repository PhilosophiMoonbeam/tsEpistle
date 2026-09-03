import type { Knex } from 'knex'

import { KNOWN_APPLICATION_TABLES } from './migrator-source.ts'
import { isLegacyForkMigrationName, isNamespacedMigrationName, MIGRATION_LINEAGE_V1 } from './migration-contract.ts'

interface MigrationRecord {
  id: number
  name: string
}

interface MigrationLockRecord {
  is_locked: boolean | number
}

interface SchemaLineageRecord {
  product: string
  lineageVersion: number
  upstreamMigrationCutoff: string
  legacyForkMigrationStart: string
  legacyForkMigrationEnd: string
  namespacedMigrationStart: string
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

const existingApplicationTables = async (knex: Knex): Promise<string[]> => {
  const exists = await Promise.all(
    Object.keys(KNOWN_APPLICATION_TABLES).map(async table => ({
      exists: await knex.schema.hasTable(table),
      table
    }))
  )
  return exists.filter(result => result.exists).map(result => result.table)
}

const availableMigrationNames = async (migrationSource: Knex.MigrationSource<unknown>): Promise<string[]> => {
  const migrations = await migrationSource.getMigrations([])
  return migrations.map(migration => migrationSource.getMigrationName(migration))
}

const lineageFailure = (detail: string): MigrationPreflightError =>
  new MigrationPreflightError(`Database migration lineage is ambiguous: ${detail} Refusing to infer or rewrite its schema history.`)

const assertLegacyForkSchemaSignature = async (knex: Knex): Promise<void> => {
  const expectedColumns = [
    ['pages', 'visibility'],
    ['pages', 'ownerId'],
    ['pageHistory', 'visibility'],
    ['pageHistory', 'ownerId'],
    ['pageTree', 'visibility'],
    ['pageTree', 'ownerId']
  ] as const
  const removedColumns = [
    ['pages', 'isPrivate'],
    ['pages', 'privateNS'],
    ['pageHistory', 'isPrivate'],
    ['pageHistory', 'privateNS'],
    ['pageTree', 'isPrivate'],
    ['pageTree', 'privateNS']
  ] as const
  const [expectedResults, removedResults] = await Promise.all([
    Promise.all(expectedColumns.map(async ([table, column]) => ({ column, exists: await knex.schema.hasColumn(table, column), table }))),
    Promise.all(removedColumns.map(async ([table, column]) => ({ column, exists: await knex.schema.hasColumn(table, column), table })))
  ])
  const missing = expectedResults.filter(result => !result.exists).map(result => `${result.table}.${result.column}`)
  const retained = removedResults.filter(result => result.exists).map(result => `${result.table}.${result.column}`)
  if (missing.length > 0 || retained.length > 0) {
    const details = [
      missing.length > 0 ? `missing tsEpistle columns ${missing.join(', ')}` : '',
      retained.length > 0 ? `retains pre-tsEpistle columns ${retained.join(', ')}` : ''
    ].filter(Boolean)
    throw lineageFailure(
      `the ledger contains ${MIGRATION_LINEAGE_V1.legacyForkStart} or a later legacy fork migration but the schema ${details.join(' and ')}.`
    )
  }
}

const assertSchemaLineageMarker = async (knex: Knex): Promise<void> => {
  const marker = await knex<SchemaLineageRecord>(MIGRATION_LINEAGE_V1.tableName).where('product', MIGRATION_LINEAGE_V1.product).first()
  if (
    !marker ||
    Number(marker.lineageVersion) !== MIGRATION_LINEAGE_V1.version ||
    marker.upstreamMigrationCutoff !== MIGRATION_LINEAGE_V1.upstreamCutoff ||
    marker.legacyForkMigrationStart !== MIGRATION_LINEAGE_V1.legacyForkStart ||
    marker.legacyForkMigrationEnd !== MIGRATION_LINEAGE_V1.legacyForkEnd ||
    marker.namespacedMigrationStart !== MIGRATION_LINEAGE_V1.namespacedStart
  ) {
    throw lineageFailure(`the ${MIGRATION_LINEAGE_V1.tableName} marker is missing or does not match this tsEpistle migration lineage.`)
  }
}

const assertProductLineage = async (knex: Knex, applied: readonly string[]): Promise<void> => {
  const hasLegacyForkHistory = applied.some(isLegacyForkMigrationName)
  const hasNamespacedHistory = applied.some(isNamespacedMigrationName)
  const hasMarker = await knex.schema.hasTable(MIGRATION_LINEAGE_V1.tableName)

  if (hasNamespacedHistory) {
    if (!hasMarker) throw lineageFailure(`namespaced tsEpistle migrations exist without the ${MIGRATION_LINEAGE_V1.tableName} marker.`)
    await assertSchemaLineageMarker(knex)
    return
  }
  if (hasMarker) {
    throw lineageFailure(`the ${MIGRATION_LINEAGE_V1.tableName} marker exists before ${MIGRATION_LINEAGE_V1.namespacedStart} appears in the ledger.`)
  }
  if (hasLegacyForkHistory) await assertLegacyForkSchemaSignature(knex)
}

const assertMigrationLockIsClear = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable('migrations_lock'))) return
  const lock = await knex<MigrationLockRecord>('migrations_lock').first('is_locked')
  if (lock && (lock.is_locked === true || Number(lock.is_locked) === 1)) {
    throw new MigrationPreflightError(
      'Database migrations are locked. Confirm that no other tsEpistle instance is migrating, then clear a stale lock before retrying.'
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
      `Database was migrated by an unknown or newer build (${unknown.join(', ')}). Upgrade tsEpistle instead of running this older migration set.`
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
    throw new MigrationPreflightError('Database has applied migration records but none of the expected Wiki application tables. Refusing a partial schema.')
  }
  await assertProductLineage(knex, applied)

  return { applied, available, state: 'ready' }
}
