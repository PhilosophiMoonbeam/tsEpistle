import type { Knex } from 'knex'


interface WikiDatabaseContext {
  config: {
    db: { type: string }
  }
}

const wiki = WIKI as unknown as WikiDatabaseContext

export const up = (knex: Knex) => {
  return knex.schema
    .table('pages', table => {
      switch (wiki.config.db.type) {
        case 'mariadb':
        case 'mysql':
          table.specificType('content', 'LONGTEXT').alter()
          table.specificType('render', 'LONGTEXT').alter()
          break
        case 'mssql':
          table.specificType('content', 'VARCHAR(max)').alter()
          table.specificType('render', 'VARCHAR(max)').alter()
          break
      }
    })
}

export const down = (knex: Knex) => {
  void knex
}
