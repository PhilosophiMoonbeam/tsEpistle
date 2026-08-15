import type { Knex } from 'knex'

const TABLE_NAME = 'contentExtensions'

export const up = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(TABLE_NAME)) {
    await knex.schema.createTable(TABLE_NAME, table => {
      table.string('key', 64).primary()
      table.boolean('isEnabled').notNullable().defaultTo(false)
      table.integer('version').unsigned().notNullable()
      table.dateTime('updatedAt').notNullable()
      table.integer('updatedBy').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
    })
  }

  const qr = await knex(TABLE_NAME).where({ key: 'qr' }).first('key')
  if (!qr) {
    await knex(TABLE_NAME).insert({
      key: 'qr',
      isEnabled: false,
      version: 1,
      updatedAt: knex.fn.now(),
      updatedBy: null
    })
  }
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists(TABLE_NAME)
}
