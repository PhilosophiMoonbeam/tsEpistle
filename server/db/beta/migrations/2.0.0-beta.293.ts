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
    .createTable('pageLinks', table => {
      if (dbCompat.charset) { table.charset('utf8mb4') }
      table.increments('id').primary()
      table.integer('pageId').unsigned().references('id').inTable('pages').onDelete('CASCADE')
      table.string('path').notNullable()
      table.string('localeCode', 5).notNullable()
    })
    .table('pageLinks', table => {
      table.index(['path', 'localeCode'])
    })
}

export const down = (knex: Knex) => {
  return knex.schema
    .dropTableIfExists('pageLinks')
}
