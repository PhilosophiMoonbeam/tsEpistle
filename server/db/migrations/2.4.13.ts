import type { Knex } from 'knex'

export const up = (knex: Knex) => {
  return knex.schema
    .alterTable('pages', table => {
      table.json('extra').notNullable().defaultTo('{}')
    })
    .alterTable('pageHistory', table => {
      table.json('extra').notNullable().defaultTo('{}')
    })
    .alterTable('users', table => {
      table.string('dateFormat').notNullable().defaultTo('')
      table.string('appearance').notNullable().defaultTo('')
    })
}

export const down = (knex: Knex) => {
  void knex
}
