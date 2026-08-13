import type { Knex } from 'knex'
interface WikiDatabaseContext {
  config: {
    db: { type: string }
  }
}

const wiki = WIKI as unknown as WikiDatabaseContext

export const up = (knex: Knex) => {
  return knex.schema
    .alterTable('pageHistory', table => {
      switch (wiki.config.db.type) {
        // No change needed for PostgreSQL and SQLite
        case 'mariadb':
        case 'mysql':
          table.specificType('content', 'LONGTEXT').alter()
          break
        case 'mssql':
          table.specificType('content', 'VARCHAR(max)').alter()
          break
      }
    })
}

export const down = (knex: Knex) => {
  void knex
}
