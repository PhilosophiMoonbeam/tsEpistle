import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from '../bun-test.mts'

import {
  isLegacyForkMigrationName,
  isNamespacedMigrationName,
  LEGACY_MIGRATION_IDS,
  MIGRATION_LINEAGE_V1,
  migrationLedgerName,
  orderMigrationFiles
} from '../../db/migration-contract.ts'

const legacyFiles = LEGACY_MIGRATION_IDS.map(id => `${id}.ts`)
const deployedNamespacedFiles = Array.from({ length: 12 }, (_, index) => {
  const sequence = String(index + 1).padStart(6, '0')
  return `tsfranki-${sequence}-deployed-change.ts`
})
const deployedNamespacedIds = deployedNamespacedFiles.map(file => file.slice(0, -'.ts'.length))
const completeHistoricalFiles = [...legacyFiles, ...deployedNamespacedFiles]

describe('database migration namespace contract', () => {
  it('orders one contiguous sequence across the deployed and current namespaces', () => {
    const files = ['tsepistle-000013-next-change.ts', ...deployedNamespacedFiles.toReversed(), ...legacyFiles.toReversed()]

    expect(orderMigrationFiles(files)).toEqual([...LEGACY_MIGRATION_IDS, ...deployedNamespacedIds, 'tsepistle-000013-next-change'])
  })

  it('accepts the repository migration inventory as the canonical deployed sequence', async () => {
    const files = (await readdir(path.resolve('server/db/migrations'))).filter(file => file.endsWith('.ts'))
    const ordered = orderMigrationFiles(files)

    expect(ordered.at(-1)).toBe('tsepistle-000013-site-logo-authority')
    expect(ordered).toHaveLength(files.length)
  })

  it('accepts tsepistle-000013 as the first migration in the current namespace', () => {
    expect(orderMigrationFiles([...completeHistoricalFiles, 'tsepistle-000013-product-rename.ts']).at(-1)).toBe('tsepistle-000013-product-rename')
  })

  it('rejects removal or insertion inside immutable legacy history', () => {
    expect(() => orderMigrationFiles(legacyFiles.filter(file => file !== '2.5.128.ts'))).toThrow('missing immutable legacy migrations: 2.5.128')
    expect(() => orderMigrationFiles([...legacyFiles, '2.5.160.ts', 'tsfranki-000001-schema-lineage.ts'])).toThrow('Legacy migration history is frozen')
  })

  it('rejects malformed and duplicate namespaced identifiers', () => {
    expect(() => orderMigrationFiles([...legacyFiles, 'tsfranki-1-change.ts'])).toThrow(
      'new migrations must use tsepistle-NNNNNN-description beginning at 000013'
    )
    expect(() => orderMigrationFiles([...completeHistoricalFiles, 'tsepistle-13-change.ts'])).toThrow(
      'new migrations must use tsepistle-NNNNNN-description beginning at 000013'
    )
    expect(() => orderMigrationFiles([...completeHistoricalFiles, 'tsepistle-000013-first.ts', 'tsepistle-000013-first.ts'])).toThrow('duplicate identifiers')
    expect(() => orderMigrationFiles([...legacyFiles, 'tsfranki-000001-first.ts', 'tsfranki-000001-second.ts'])).toThrow('duplicate namespaced sequence 000001')
  })

  it('rejects identifiers that cross the namespace boundary', () => {
    expect(() => orderMigrationFiles([...completeHistoricalFiles, 'tsfranki-000013-wrong-namespace.ts'])).toThrow(
      'Historical migration namespace tsfranki is closed after 000012'
    )
    expect(() => orderMigrationFiles([...completeHistoricalFiles, 'tsepistle-000012-wrong-namespace.ts'])).toThrow(
      'Current migration namespace tsepistle begins at 000013'
    )
  })

  it('rejects a non-contiguous sequence across the namespace transition', () => {
    expect(() => orderMigrationFiles([...completeHistoricalFiles, 'tsepistle-000014-skipped-sequence.ts'])).toThrow(
      'tsEpistle migration sequence must be contiguous'
    )
    expect(() => orderMigrationFiles([...completeHistoricalFiles, 'tsepistle-000014-skipped-sequence.ts'])).toThrow('expected 000013, found 000014')
  })

  it('distinguishes legacy fork and namespaced ledger identities', () => {
    expect(MIGRATION_LINEAGE_V1.product).toBe('tsfranki')
    expect(MIGRATION_LINEAGE_V1.namespacedStart).toBe('tsfranki-000001-schema-lineage.js')
    expect(isLegacyForkMigrationName(MIGRATION_LINEAGE_V1.upstreamCutoff)).toBe(false)
    expect(isLegacyForkMigrationName(MIGRATION_LINEAGE_V1.legacyForkStart)).toBe(true)
    expect(isLegacyForkMigrationName(MIGRATION_LINEAGE_V1.legacyForkEnd)).toBe(true)
    expect(isNamespacedMigrationName(MIGRATION_LINEAGE_V1.namespacedStart)).toBe(true)
    expect(isNamespacedMigrationName('tsepistle-000013-product-rename.js')).toBe(true)
    expect(isNamespacedMigrationName('tsfranki-000013-wrong-namespace.js')).toBe(false)
    expect(isNamespacedMigrationName('tsepistle-000012-wrong-namespace.js')).toBe(false)
    expect(isNamespacedMigrationName('2.5.159.js')).toBe(false)
    expect(migrationLedgerName('tsfranki-000001-schema-lineage')).toBe(MIGRATION_LINEAGE_V1.namespacedStart)
  })
})
