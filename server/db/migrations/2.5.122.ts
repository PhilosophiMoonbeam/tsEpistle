import type { Knex } from 'knex'

export const up = (knex: Knex) => {
  return knex.schema
    .createTable('userAvatars', table => {
      
      table.integer('id').primary()
      table.binary('data').notNullable()
    })
}

export const down = (knex: Knex) => {
  void knex
}
