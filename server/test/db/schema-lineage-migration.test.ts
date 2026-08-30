import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { MIGRATION_LINEAGE_V1 } from '../../db/migration-contract.ts'
import { down, up } from '../../db/migrations/tsfranki-000001-schema-lineage.ts'

describe('tsFranki schema lineage migration', () => {
  const databases: Knex[] = []

  afterEach(async () => {
    await Promise.all(databases.splice(0).map(database => database.destroy()))
  })

  it('persists an immutable marker for the inherited and fork-owned migration ranges', async () => {
    const database = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { max: 1, min: 1 },
      useNullAsDefault: true
    })
    databases.push(database)

    await up(database)

    expect(await database(MIGRATION_LINEAGE_V1.tableName).where('product', MIGRATION_LINEAGE_V1.product).first()).toMatchObject({
      product: MIGRATION_LINEAGE_V1.product,
      lineageVersion: MIGRATION_LINEAGE_V1.version,
      upstreamMigrationCutoff: MIGRATION_LINEAGE_V1.upstreamCutoff,
      legacyForkMigrationStart: MIGRATION_LINEAGE_V1.legacyForkStart,
      legacyForkMigrationEnd: MIGRATION_LINEAGE_V1.legacyForkEnd,
      namespacedMigrationStart: MIGRATION_LINEAGE_V1.namespacedStart
    })

    await down(database)
    expect(await database.schema.hasTable(MIGRATION_LINEAGE_V1.tableName)).toBe(false)
  })
})
