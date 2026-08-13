import type { Knex } from 'knex'
export const up = (knex: Knex) => {
  return knex.schema
    .alterTable('users', table => {
      table.string('lastLoginAt')
    })
}

export const down = (knex: Knex) => {
  void knex
}
