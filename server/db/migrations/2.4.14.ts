import type { Knex } from 'knex'
interface WikiDatabaseContext {
  config: {
    db: { type: string }
  }
}

const wiki = WIKI as unknown as WikiDatabaseContext

export const up = (knex: Knex) => {
  const dbCompat = {
    charset: (wiki.config.db.type === `mysql` || wiki.config.db.type === `mariadb`)
  }
  return knex.schema
    .createTable('commentProviders', table => {
      if (dbCompat.charset) { table.charset('utf8mb4') }
      table.string('key').notNullable().primary()
      table.boolean('isEnabled').notNullable().defaultTo(false)
      table.json('config').notNullable()
    })
}

export const down = (knex: Knex) => {
  void knex
}
