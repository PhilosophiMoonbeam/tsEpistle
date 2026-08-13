import type { Knex } from 'knex'


interface WikiDatabaseContext {
  config: {
    db: { type: string }
  }
}

const wiki = WIKI as unknown as WikiDatabaseContext

export const up = (knex: Knex) => {
  const dbCompat = {
    blobLength: (wiki.config.db.type === `mysql` || wiki.config.db.type === `mariadb`)
  }
  return knex.schema
    .table('assetData', table => {
      if (dbCompat.blobLength) {
        table.dropColumn('data')
      }
    })
    .table('assetData', table => {
      if (dbCompat.blobLength) {
        table.specificType('data', 'LONGBLOB').notNullable()
      }
    })
}

export const down = (knex: Knex) => {
  return knex.schema
    .table('assetData', table => {
      void table
    })
}
