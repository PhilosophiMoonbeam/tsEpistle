import type { Knex } from 'knex'
import has from 'lodash/has.js'

export const up = async (knex: Knex) => {
  // -> Fix 2.5.1 added isEnabled columns for beta users
  const localStrategy = await knex('authentication').where('key', 'local').first()
  if (localStrategy && !has(localStrategy, 'isEnabled')) {
    await knex.schema
      .alterTable('authentication', table => {
        table.boolean('isEnabled').notNullable().defaultTo(true)
      })
  }
}

export const down = (knex: Knex) => {
  void knex
}
