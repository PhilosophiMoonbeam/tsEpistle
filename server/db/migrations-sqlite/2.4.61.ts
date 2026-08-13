import type { Knex } from 'knex'
export const up = (knex: Knex) => {
  return knex.schema
    .alterTable('comments', table => {
      table.integer('replyTo').unsigned().notNullable().defaultTo(0)
    })
}

export const down = (knex: Knex) => {
  void knex
}
