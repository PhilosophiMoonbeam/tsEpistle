import type { Knex } from 'knex'

const TABLE_NAME = 'agentProviderProfiles'
const ACTIVE_NAME_INDEX = 'agent_provider_profiles_active_name_unique'

export const up = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasColumn(TABLE_NAME, 'deletedAt')) {
    await knex.schema.alterTable(TABLE_NAME, table => {
      table.dateTime('deletedAt').nullable()
      table.index(['deletedAt'], 'agent_provider_profiles_deleted_at_idx')
    })
    await knex.schema.alterTable(TABLE_NAME, table => {
      table.dropUnique(['displayName'])
    })
    await knex.raw(`CREATE UNIQUE INDEX ${ACTIVE_NAME_INDEX} ON "${TABLE_NAME}" ("displayName") WHERE "deletedAt" IS NULL`)
  }
}

export const down = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasColumn(TABLE_NAME, 'deletedAt')) return
  const row = await knex(TABLE_NAME).whereNotNull('deletedAt').count<{ count: string }[]>({ count: '*' }).first()
  if (Number(row?.count ?? 0) > 0) throw new Error(`Cannot roll down provider profile lifecycle migration while ${TABLE_NAME} contains removed profiles`)
  await knex.raw(`DROP INDEX IF EXISTS ${ACTIVE_NAME_INDEX}`)
  await knex.schema.alterTable(TABLE_NAME, table => {
    table.unique(['displayName'])
    table.dropIndex(['deletedAt'], 'agent_provider_profiles_deleted_at_idx')
    table.dropColumn('deletedAt')
  })
}
