import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable('users', table => {
    table.string('pronouns', 255).notNullable().defaultTo('')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable('users', table => {
    table.dropColumn('pronouns')
  })
}
