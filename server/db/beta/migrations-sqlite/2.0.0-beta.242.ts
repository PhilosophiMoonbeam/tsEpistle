import type { Knex } from 'knex'


export const up = (knex: Knex) => {
  return knex.schema
    .table('users', table => {
      table.boolean('mustChangePwd').notNullable().defaultTo(false)
    })
}

export const down = (knex: Knex) => {
  return knex.schema
    .table('users', table => {
      table.dropColumn('mustChangePwd')
    })
}
