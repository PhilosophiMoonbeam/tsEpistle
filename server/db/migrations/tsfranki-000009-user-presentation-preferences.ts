import type { Knex } from 'knex'

const USERS_TABLE = 'users'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable(USERS_TABLE, table => {
    table.string('fontFamily').notNullable().defaultTo('newsreader')
    table.string('readingGutter').notNullable().defaultTo('site')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable(USERS_TABLE, table => {
    table.dropColumn('fontFamily')
    table.dropColumn('readingGutter')
  })
}
