import type { Knex } from 'knex'

const VERSIONS = 'agentProviderProfileVersions'

export const up = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(VERSIONS) || await knex.schema.hasColumn(VERSIONS, 'utilityModel')) return
  await knex.schema.alterTable(VERSIONS, table => {
    table.string('utilityModel', 255).nullable()
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(VERSIONS) || !await knex.schema.hasColumn(VERSIONS, 'utilityModel')) return
  await knex.schema.alterTable(VERSIONS, table => {
    table.dropColumn('utilityModel')
  })
}
