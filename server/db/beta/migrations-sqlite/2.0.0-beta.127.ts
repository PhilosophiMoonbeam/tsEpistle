import type { Knex } from 'knex'


export const up = (knex: Knex) => {
  return knex.schema
    .table('assets', table => {
      table.dropColumn('basename')
      table.string('hash').notNullable().defaultTo('')
    })
}

export const down = (knex: Knex) => {
  return knex.schema
    .table('assets', table => {
      table.dropColumn('hash')
      table.string('basename').notNullable().defaultTo('')
    })
}
