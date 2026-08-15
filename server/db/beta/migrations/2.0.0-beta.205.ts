import type { Knex } from 'knex'

export const up = (knex: Knex) => {
  return knex.schema
    .createTable('analytics', table => {
      
      table.string('key').notNullable().primary()
      table.boolean('isEnabled').notNullable().defaultTo(false)
      table.json('config').notNullable()
    })
}

export const down = (knex: Knex) => {
  return knex.schema
    .dropTableIfExists('analytics')
}
