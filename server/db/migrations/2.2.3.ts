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
    .createTable('apiKeys', table => {
      if (dbCompat.charset) { table.charset('utf8mb4') }
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
