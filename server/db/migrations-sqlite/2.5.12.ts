import type { Knex } from 'knex'
export const up = async (knex: Knex) => {
  await knex.schema
    .alterTable('groups', table => {
      table.string('redirectOnLogin').notNullable().defaultTo('/')
    })
}

export const down = (knex: Knex) => {
  void knex
}
