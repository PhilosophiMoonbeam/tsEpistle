import type { Knex } from 'knex'

const MEMORIES = 'agentMemories'
const SESSIONS = 'agentSessions'
const EMPTY_SNAPSHOT = '{"agent":[],"user":[]}'

export const up = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(MEMORIES)) {
    await knex.schema.createTable(MEMORIES, table => {
      table.uuid('id').primary()
      table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('target', 16).notNullable()
      table.text('content').notNullable()
      table.string('contentSha256', 64).notNullable()
      table.integer('version').unsigned().notNullable().defaultTo(1)
      table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
      table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
      table.unique(['ownerId', 'target', 'contentSha256'], { indexName: 'agent_memories_owner_target_content_unique' })
      table.index(['ownerId', 'target', 'createdAt'], 'agent_memories_owner_target_created_idx')
    })
  }
  if (await knex.schema.hasTable(SESSIONS) && !await knex.schema.hasColumn(SESSIONS, 'memorySnapshot')) {
    await knex.schema.alterTable(SESSIONS, table => {
      table.text('memorySnapshot').notNullable().defaultTo(EMPTY_SNAPSHOT)
    })
  }
}

export const down = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasTable(SESSIONS) && await knex.schema.hasColumn(SESSIONS, 'memorySnapshot')) {
    await knex.schema.alterTable(SESSIONS, table => {
      table.dropColumn('memorySnapshot')
    })
  }
  if (await knex.schema.hasTable(MEMORIES)) await knex.schema.dropTable(MEMORIES)
}
