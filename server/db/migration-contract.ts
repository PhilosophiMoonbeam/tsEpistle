const SOURCE_EXTENSION = '.ts'
const LEDGER_EXTENSION = '.js'
const DEPLOYED_NAMESPACE_PATTERN = /^tsfranki-(\d{6})-[a-z0-9]+(?:-[a-z0-9]+)*$/
const CURRENT_NAMESPACE_PATTERN = /^tsepistle-(\d{6})-[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEPLOYED_NAMESPACE_END_SEQUENCE = 12
const CURRENT_NAMESPACE_START_SEQUENCE = DEPLOYED_NAMESPACE_END_SEQUENCE + 1
interface NamespacedMigration {
  id: string
  namespace: 'deployed' | 'current'
  sequence: number
}

const parseNamespacedMigrationId = (id: string): NamespacedMigration | null => {
  const deployedMatch = DEPLOYED_NAMESPACE_PATTERN.exec(id)
  if (deployedMatch) return { id, namespace: 'deployed', sequence: Number(deployedMatch[1]) }
  const currentMatch = CURRENT_NAMESPACE_PATTERN.exec(id)
  if (currentMatch) return { id, namespace: 'current', sequence: Number(currentMatch[1]) }
  return null
}

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

export const isNamespacedMigrationName = (name: string): boolean => {
  if (!name.endsWith(LEDGER_EXTENSION)) return false
  const migration = parseNamespacedMigrationId(name.slice(0, -LEDGER_EXTENSION.length))
  if (!migration) return false
  if (migration.namespace === 'deployed') {
    return migration.sequence >= 1 && migration.sequence <= DEPLOYED_NAMESPACE_END_SEQUENCE
  }
  return migration.sequence >= CURRENT_NAMESPACE_START_SEQUENCE
}

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

  const namespacedMigrations: NamespacedMigration[] = []
  const namespacedSequences = new Set<number>()
  for (const id of ids) {
    if (legacyMigrationIds[id] === true) continue
    const migration = parseNamespacedMigrationId(id)
    if (!migration) {
      throw new Error(
        `Unsupported migration identifier ${id}. Legacy migration history is frozen; new migrations must use tsepistle-NNNNNN-description beginning at 000013.`
      )
    }

    const { namespace: namespaceKind, sequence } = migration
    if (namespaceKind === 'deployed' && sequence > DEPLOYED_NAMESPACE_END_SEQUENCE) {
      throw new Error(
        `Historical migration namespace tsfranki is closed after 000012; sequence ${String(sequence).padStart(6, '0')} must use tsepistle-NNNNNN-description.`
      )
    }
    if (namespaceKind === 'current' && sequence < CURRENT_NAMESPACE_START_SEQUENCE) {
      throw new Error(
        `Current migration namespace tsepistle begins at 000013; sequence ${String(sequence).padStart(6, '0')} must retain its deployed tsfranki filename.`
      )
    }
    if (namespacedSequences.has(sequence)) {
      throw new Error(`Migration source contains duplicate namespaced sequence ${String(sequence).padStart(6, '0')}`)
    }
    namespacedSequences.add(sequence)
    namespacedMigrations.push(migration)
  }

  namespacedMigrations.sort((left, right) => left.sequence - right.sequence)
  for (const [index, migration] of namespacedMigrations.entries()) {
    const expected = index + 1
    if (migration.sequence !== expected) {
      throw new Error(
        `tsEpistle migration sequence must be contiguous from 000001 across the historical tsfranki and current tsepistle namespaces; expected ${String(expected).padStart(6, '0')}, found ${String(migration.sequence).padStart(6, '0')}`
      )
    }
  }

  return [...LEGACY_MIGRATION_IDS, ...namespacedMigrations.map(migration => migration.id)]
}
