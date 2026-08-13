import type { Knex } from 'knex'
interface WikiDatabaseContext {
  config: {
    db: { type: string }
  }
}

const wiki = WIKI as unknown as WikiDatabaseContext

export const up = (knex: Knex) => {
  return knex.schema
    .alterTable('pages', table => {
      if (wiki.config.db.type === 'mysql') {
        table.json('extra')
      } else {
        table.json('extra').notNullable().defaultTo('{}')
      }
    })
    .alterTable('pageHistory', table => {
      if (wiki.config.db.type === 'mysql') {
        table.json('extra')
      } else {
        table.json('extra').notNullable().defaultTo('{}')
      }
    })
    .alterTable('users', table => {
      table.string('dateFormat').notNullable().defaultTo('')
      table.string('appearance').notNullable().defaultTo('')
    })
}

export const down = (knex: Knex) => {
  void knex
}
