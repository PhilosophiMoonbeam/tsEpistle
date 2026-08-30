const SOURCE_EXTENSION = '.ts'
const LEDGER_EXTENSION = '.js'
const TSFRANKI_MIGRATION_PATTERN = /^tsfranki-(\d{6})-[a-z0-9]+(?:-[a-z0-9]+)*$/

export const LEGACY_MIGRATION_IDS = Object.freeze([
  '2.0.0',
  '2.1.85',
  '2.2.3',
  '2.2.17',
  '2.3.10',
  '2.3.23',
  '2.4.13',
  '2.4.14',
  '2.4.36',
  '2.4.61',
  '2.5.1',
  '2.5.12',
  '2.5.108',
  '2.5.118',
  '2.5.122',
  '2.5.128',
  '2.5.129',
  '2.5.130',
  '2.5.131',
  '2.5.132',
  '2.5.133',
  '2.5.134',
  '2.5.135',
  '2.5.136',
  '2.5.137',
  '2.5.138',
  '2.5.139',
  '2.5.140',
  '2.5.141',
  '2.5.142',
  '2.5.143',
  '2.5.144',
  '2.5.145',
  '2.5.146',
  '2.5.147',
  '2.5.148',
  '2.5.149',
  '2.5.150',
  '2.5.151',
  '2.5.152',
  '2.5.153',
  '2.5.154',
  '2.5.155',
  '2.5.156',
  '2.5.157',
  '2.5.158',
  '2.5.159'
] as const)

const legacyMigrationIds: Readonly<Record<string, true>> = Object.freeze(Object.fromEntries(LEGACY_MIGRATION_IDS.map(id => [id, true] as const)))
const legacyForkMigrationNames: Readonly<Record<string, true>> = Object.freeze(
  Object.fromEntries(LEGACY_MIGRATION_IDS.slice(LEGACY_MIGRATION_IDS.indexOf('2.5.129')).map(id => [`${id}${LEDGER_EXTENSION}`, true] as const))
)

export const MIGRATION_LINEAGE_V1 = Object.freeze({
  tableName: 'schemaLineage',
  product: 'tsfranki',
  version: 1,
  upstreamCutoff: '2.5.128.js',
  legacyForkStart: '2.5.129.js',
  legacyForkEnd: '2.5.159.js',
  namespacedStart: 'tsfranki-000001-schema-lineage.js'
} as const)

export const migrationLedgerName = (id: string): string => `${id}${LEDGER_EXTENSION}`

export const isLegacyForkMigrationName = (name: string): boolean => legacyForkMigrationNames[name] === true

export const isTsfrankiMigrationName = (name: string): boolean =>
  name.endsWith(LEDGER_EXTENSION) && TSFRANKI_MIGRATION_PATTERN.test(name.slice(0, -LEDGER_EXTENSION.length))

export const orderMigrationFiles = (files: readonly string[]): string[] => {
  const ids = files.map(file => {
    if (!file.endsWith(SOURCE_EXTENSION)) throw new TypeError(`Migration source must be a TypeScript file: ${file}`)
    return file.slice(0, -SOURCE_EXTENSION.length)
  })
  const uniqueIds = new Set(ids)
  if (uniqueIds.size !== ids.length) throw new Error('Migration source contains duplicate identifiers')

  const missingLegacy = LEGACY_MIGRATION_IDS.filter(id => !uniqueIds.has(id))
  if (missingLegacy.length > 0) {
    throw new Error(`Migration source is missing immutable legacy migrations: ${missingLegacy.join(', ')}`)
  }

  const forkMigrations: Array<{ id: string; sequence: number }> = []
  for (const id of ids) {
    if (legacyMigrationIds[id] === true) continue
    const match = TSFRANKI_MIGRATION_PATTERN.exec(id)
    const sequence = match ? Number(match[1]) : null
    if (sequence === null) {
      throw new Error(`Unsupported migration identifier ${id}. Legacy migration history is frozen; new migrations must use tsfranki-NNNNNN-description.`)
    }
    forkMigrations.push({ id, sequence })
  }

  forkMigrations.sort((left, right) => left.sequence - right.sequence)
  for (const [index, migration] of forkMigrations.entries()) {
    const expected = index + 1
    if (migration.sequence !== expected) {
      throw new Error(
        `tsFranki migration sequence must be contiguous from 000001; expected ${String(expected).padStart(6, '0')}, found ${String(migration.sequence).padStart(6, '0')}`
      )
    }
  }

  return [...LEGACY_MIGRATION_IDS, ...forkMigrations.map(migration => migration.id)]
}
