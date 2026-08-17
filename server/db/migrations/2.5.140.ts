import type { Knex } from 'knex'

const TABLE_NAME = 'agentLaunchHandoffs'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists(TABLE_NAME)
}

export const down = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasTable(TABLE_NAME)) return

  await knex.schema.createTable(TABLE_NAME, table => {
    table.uuid('id').primary()
    table.binary('tokenSha256').notNullable().unique()
    table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.integer('pageId').unsigned().nullable().references('id').inTable('pages').onDelete('SET NULL')
    table.string('localeCode', 16).nullable()
    table.text('path').nullable()
    table.dateTime('observedUpdatedAt').nullable()
    table.binary('pageHintSha256').notNullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('expiresAt').notNullable()
    table.dateTime('consumedAt').nullable()
    table.index(['expiresAt'], 'agent_launch_handoffs_expiry_idx')
  })
}
