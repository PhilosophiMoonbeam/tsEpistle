import type { Knex } from 'knex'


export const up = (knex: Knex) => {
  void knex
}

export const down = (knex: Knex) => {
  return knex.schema
    .table('assetData', table => {
      void table
    })
}
