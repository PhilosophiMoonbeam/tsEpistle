import type { Knex } from 'knex'

import { MIGRATION_LINEAGE_V1 } from '../migration-contract.ts'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable(MIGRATION_LINEAGE_V1.tableName, table => {
    table.string('product', 32).primary()
    table.integer('lineageVersion').notNullable()
    table.string('upstreamMigrationCutoff', 64).notNullable()
    table.string('legacyForkMigrationStart', 64).notNullable()
    table.string('legacyForkMigrationEnd', 64).notNullable()
    table.string('namespacedMigrationStart', 128).notNullable()
    table.timestamp('createdAt').notNullable().defaultTo(knex.fn.now())
  })

  await knex(MIGRATION_LINEAGE_V1.tableName).insert({
    product: MIGRATION_LINEAGE_V1.product,
    lineageVersion: MIGRATION_LINEAGE_V1.version,
    upstreamMigrationCutoff: MIGRATION_LINEAGE_V1.upstreamCutoff,
    legacyForkMigrationStart: MIGRATION_LINEAGE_V1.legacyForkStart,
    legacyForkMigrationEnd: MIGRATION_LINEAGE_V1.legacyForkEnd,
    namespacedMigrationStart: MIGRATION_LINEAGE_V1.namespacedStart
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTable(MIGRATION_LINEAGE_V1.tableName)
}
