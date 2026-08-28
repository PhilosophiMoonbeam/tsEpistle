import type { Knex } from 'knex'

const FOLDERS = 'agentConversationFolders'
const SESSIONS = 'agentSessions'

export const up = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(FOLDERS)) {
    await knex.schema.createTable(FOLDERS, table => {
      table.uuid('id').primary()
      table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('name', 64).notNullable()
      table.string('normalizedName', 64).notNullable()
      table.integer('version').unsigned().notNullable().defaultTo(1)
      table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
      table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
      table.unique(['ownerId', 'normalizedName'], { indexName: 'agent_conversation_folders_owner_name_unique' })
      table.index(['ownerId', 'updatedAt'], 'agent_conversation_folders_owner_updated_idx')
    })
  }
  if (await knex.schema.hasTable(SESSIONS) && !await knex.schema.hasColumn(SESSIONS, 'folderId')) {
    await knex.schema.alterTable(SESSIONS, table => {
      table.uuid('folderId').nullable().references('id').inTable(FOLDERS).onDelete('SET NULL')
      table.index(['ownerId', 'folderId', 'lastActivityAt'], 'agent_sessions_owner_folder_activity_idx')
    })
  }
}

export const down = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasTable(SESSIONS) && await knex.schema.hasColumn(SESSIONS, 'folderId')) {
    await knex.schema.alterTable(SESSIONS, table => {
      table.dropIndex(['ownerId', 'folderId', 'lastActivityAt'], 'agent_sessions_owner_folder_activity_idx')
      table.dropForeign(['folderId'])
      table.dropColumn('folderId')
    })
  }
  if (await knex.schema.hasTable(FOLDERS)) await knex.schema.dropTable(FOLDERS)
}
