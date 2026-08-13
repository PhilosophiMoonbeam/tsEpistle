import type { Knex } from 'knex'


interface WikiDatabaseContext {
  config: {
    db: { type: string }
  }
}

const wiki = WIKI as unknown as WikiDatabaseContext

export const up = async (knex: Knex) => {
  const dbCompat = {
    charset: (wiki.config.db.type === `mysql` || wiki.config.db.type === `mariadb`),
    selfCascadeDelete: wiki.config.db.type !== 'mssql'
  }

  return knex.schema
    .dropTable('pageTree')
    .createTable('pageTree', table => {
      if (dbCompat.charset) { table.charset('utf8mb4') }
      table.integer('id').unsigned().primary()
      table.string('path').notNullable()
      table.integer('depth').unsigned().notNullable()
      table.string('title').notNullable()
      table.boolean('isPrivate').notNullable().defaultTo(false)
      table.boolean('isFolder').notNullable().defaultTo(false)
      table.string('privateNS')
    })
    .table('pageTree', table => {
      if (dbCompat.selfCascadeDelete) {
        table.integer('parent').unsigned().references('id').inTable('pageTree').onDelete('CASCADE')
      } else {
        table.integer('parent').unsigned()
      }
      table.integer('pageId').unsigned().references('id').inTable('pages').onDelete('CASCADE')
      table.string('localeCode', 5).references('code').inTable('locales')
    })
}

export const down = (knex: Knex) => {
  const dbCompat = {
    charset: (wiki.config.db.type === `mysql` || wiki.config.db.type === `mariadb`),
    selfCascadeDelete: wiki.config.db.type !== 'mssql'
  }
  return knex.schema
    .dropTable('pageTree')
    .createTable('pageTree', table => {
      if (dbCompat.charset) { table.charset('utf8mb4') }
      table.integer('id').primary()
      table.string('path').notNullable()
      table.integer('depth').unsigned().notNullable()
      table.string('title').notNullable()
      table.boolean('isPrivate').notNullable().defaultTo(false)
      table.boolean('isFolder').notNullable().defaultTo(false)
      table.string('privateNS')
    })
    .table('pageTree', table => {
      table.integer('parent').unsigned().references('id').inTable('pageTree')
      table.integer('pageId').unsigned().references('id').inTable('pages')
      table.string('localeCode', 5).references('code').inTable('locales')
    })
}
