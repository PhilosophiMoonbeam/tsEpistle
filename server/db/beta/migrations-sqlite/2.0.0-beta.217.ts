import type { Knex } from 'knex'


export const up = (knex: Knex) => {
  return knex.schema
    .table('locales', table => {
      table.integer('availability').notNullable().defaultTo(0)
    })
}

export const down = (knex: Knex) => {
  return knex.schema
    .table('locales', table => {
      table.dropColumn('availability')
    })
}
