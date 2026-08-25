import type { Knex } from 'knex'

const SESSIONS = 'agentSessions'

export const up = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(SESSIONS) || await knex.schema.hasColumn(SESSIONS, 'titleSource')) return
  await knex.schema.alterTable(SESSIONS, table => {
    table.string('titleSource', 16).notNullable().defaultTo('none')
  })
  await knex(SESSIONS).whereNot('title', '').update({ titleSource: 'manual' })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(SESSIONS) || !await knex.schema.hasColumn(SESSIONS, 'titleSource')) return
  await knex.schema.alterTable(SESSIONS, table => {
    table.dropColumn('titleSource')
  })
}
