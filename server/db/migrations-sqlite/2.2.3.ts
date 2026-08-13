import type { Knex } from 'knex'
export const up = (knex: Knex) => {
  return knex.schema
    .createTable('apiKeys', table => {
      table.increments('id').primary()
      table.string('name').notNullable()
      table.text('key').notNullable()
      table.string('expiration').notNullable()
      table.boolean('isRevoked').notNullable().defaultTo(false)
      table.string('createdAt').notNullable()
      table.string('updatedAt').notNullable()
    })
}

export const down = (knex: Knex) => {
  void knex
}
