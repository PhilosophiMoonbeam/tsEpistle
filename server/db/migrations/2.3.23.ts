import type { Knex } from 'knex'
export const up = (knex: Knex) => {
  return knex.schema
    .alterTable('pageTree', table => {
      table.json('ancestors')
    })
}

export const down = (knex: Knex) => {
  void knex
}
