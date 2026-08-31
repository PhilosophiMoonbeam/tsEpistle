import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from '../bun-test.mts'

import {
  isLegacyForkMigrationName,
  isTsfrankiMigrationName,
  LEGACY_MIGRATION_IDS,
  MIGRATION_LINEAGE_V1,
  migrationLedgerName,
  orderMigrationFiles
} from '../../db/migration-contract.ts'

const legacyFiles = LEGACY_MIGRATION_IDS.map(id => `${id}.ts`)

describe('database migration namespace contract', () => {
  it('freezes legacy order and appends contiguous namespaced migrations', () => {
    const files = ['tsfranki-000002-next-change.ts', ...legacyFiles.toReversed(), 'tsfranki-000001-schema-lineage.ts']

    expect(orderMigrationFiles(files)).toEqual([...LEGACY_MIGRATION_IDS, 'tsfranki-000001-schema-lineage', 'tsfranki-000002-next-change'])
  })

  it('accepts the repository migration inventory as the canonical sequence', async () => {
    const files = (await readdir(path.resolve('server/db/migrations'))).filter(file => file.endsWith('.ts'))
    const ordered = orderMigrationFiles(files)

    expect(ordered.at(-1)).toBe('tsfranki-000007-okf-authority-backfill')
    expect(ordered).toHaveLength(files.length)
  })

  it('rejects removal or insertion inside immutable legacy history', () => {
    expect(() => orderMigrationFiles(legacyFiles.filter(file => file !== '2.5.128.ts'))).toThrow('missing immutable legacy migrations: 2.5.128')
    expect(() => orderMigrationFiles([...legacyFiles, '2.5.160.ts', 'tsfranki-000001-schema-lineage.ts'])).toThrow('Legacy migration history is frozen')
  })

  it('rejects malformed, duplicate, and non-contiguous fork identifiers', () => {
    expect(() => orderMigrationFiles([...legacyFiles, 'tsfranki-1-change.ts'])).toThrow('tsfranki-NNNNNN-description')
    expect(() => orderMigrationFiles([...legacyFiles, 'tsfranki-000001-first.ts', 'tsfranki-000001-first.ts'])).toThrow('duplicate identifiers')
    expect(() => orderMigrationFiles([...legacyFiles, 'tsfranki-000002-second.ts'])).toThrow('expected 000001, found 000002')
  })

  it('distinguishes legacy fork and namespaced ledger identities', () => {
    expect(isLegacyForkMigrationName(MIGRATION_LINEAGE_V1.upstreamCutoff)).toBe(false)
    expect(isLegacyForkMigrationName(MIGRATION_LINEAGE_V1.legacyForkStart)).toBe(true)
    expect(isLegacyForkMigrationName(MIGRATION_LINEAGE_V1.legacyForkEnd)).toBe(true)
    expect(isTsfrankiMigrationName(MIGRATION_LINEAGE_V1.namespacedStart)).toBe(true)
    expect(isTsfrankiMigrationName('2.5.159.js')).toBe(false)
    expect(migrationLedgerName('tsfranki-000001-schema-lineage')).toBe(MIGRATION_LINEAGE_V1.namespacedStart)
  })
})
