import type { Knex } from 'knex'


export const up = (knex: Knex) => {
  return knex.schema
    .table('storage', table => {
      table.string('syncInterval')
      table.json('state')
    })
}

export const down = (knex: Knex) => {
  return knex.schema
    .table('storage', table => {
      table.dropColumn('syncInterval')
      table.dropColumn('state')
    })
}
