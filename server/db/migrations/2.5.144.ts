import type { Knex } from 'knex'

const TABLE_NAME = 'agentSkills'
const COLUMN_NAME = 'isAgentDiscoverable'

export const up = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasColumn(TABLE_NAME, COLUMN_NAME)) return
  await knex.schema.alterTable(TABLE_NAME, table => {
    table.boolean(COLUMN_NAME).notNullable().defaultTo(true)
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasColumn(TABLE_NAME, COLUMN_NAME)) return
  await knex.schema.alterTable(TABLE_NAME, table => {
    table.dropColumn(COLUMN_NAME)
  })
}
