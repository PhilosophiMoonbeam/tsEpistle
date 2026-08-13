import type { Knex } from 'knex'
export const up = (knex: Knex) => {
  return knex.schema
    .createTable('assetData', table => {
      table.integer('id').primary()
      table.binary('data').notNullable()
    })
}

export const down = (knex: Knex) => {
  return knex.schema
    .dropTableIfExists('assetData')
}
