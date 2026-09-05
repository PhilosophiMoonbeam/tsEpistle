import type { Knex } from 'knex'

// Change the default for future accounts without overwriting saved font choices.
export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable('users', table => {
    table.string('fontFamily').notNullable().defaultTo('blend').alter()
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable('users', table => {
    table.string('fontFamily').notNullable().defaultTo('roboto-flex').alter()
  })
}
