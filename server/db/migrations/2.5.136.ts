import type { Knex } from 'knex'

const TABLE_NAME = 'pageCollaborationRooms'

export const up = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasTable(TABLE_NAME)) return
  await knex.schema.createTable(TABLE_NAME, table => {
    table.integer('pageId').unsigned().primary().references('id').inTable('pages').onDelete('CASCADE')
    table.string('format', 32).notNullable()
    table.integer('protocolVersion').unsigned().notNullable()
    table.integer('updateVersion').unsigned().notNullable()
    table.integer('revision').unsigned().notNullable().defaultTo(0)
    table.text('state', 'longtext').notNullable()
    table.string('baseUpdatedAt', 255).notNullable()
    table.dateTime('updatedAt').notNullable()
    table.integer('updatedBy').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists(TABLE_NAME)
}
