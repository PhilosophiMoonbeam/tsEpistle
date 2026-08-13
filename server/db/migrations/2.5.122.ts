import type { Knex } from 'knex'
interface WikiDatabaseContext {
  config: {
    db: { type: string }
  }
}

const wiki = WIKI as unknown as WikiDatabaseContext

export const up = (knex: Knex) => {
  const dbCompat = {
    blobLength: (wiki.config.db.type === `mysql` || wiki.config.db.type === `mariadb`),
    charset: (wiki.config.db.type === `mysql` || wiki.config.db.type === `mariadb`)
  }
  return knex.schema
    .createTable('userAvatars', table => {
      if (dbCompat.charset) { table.charset('utf8mb4') }
      table.integer('id').primary()
      if (dbCompat.blobLength) {
        table.specificType('data', 'LONGBLOB').notNullable()
      } else {
        table.binary('data').notNullable()
      }
    })
}

export const down = (knex: Knex) => {
  void knex
}
