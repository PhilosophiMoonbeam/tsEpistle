import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('pageAccessPasswords', table => {
    table.integer('pageId').unsigned().primary().references('id').inTable('pages').onDelete('CASCADE')
    table.text('passwordHash').notNullable()
    table.integer('version').unsigned().notNullable().defaultTo(1)
    table.integer('updatedBy').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT')
    table.dateTime('updatedAt').notNullable()
  })

  await knex.schema.createTable('pageUnlockGrants', table => {
    table.uuid('id').primary()
    table.integer('pageId').unsigned().notNullable().references('pageId').inTable('pageAccessPasswords').onDelete('CASCADE')
    table.string('sessionId', 255).notNullable()
    table.integer('userId').unsigned().nullable().references('id').inTable('users').onDelete('CASCADE')
    table.integer('passwordVersion').unsigned().notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('expiresAt').notNullable()
    table.unique(['pageId', 'sessionId'], { indexName: 'page_unlock_grants_session_unique' })
    table.index(['sessionId', 'expiresAt'], 'page_unlock_grants_session_lookup')
    table.index(['expiresAt'], 'page_unlock_grants_expiry')
  })

  await knex.schema.createTable('pageProtectedAssets', table => {
    table.integer('pageId').unsigned().notNullable().references('pageId').inTable('pageAccessPasswords').onDelete('CASCADE')
    table.string('assetPath', 512).notNullable()
    table.primary(['pageId', 'assetPath'], 'page_protected_assets_primary')
    table.index(['assetPath'], 'page_protected_assets_path_lookup')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists('pageProtectedAssets')
  await knex.schema.dropTableIfExists('pageUnlockGrants')
  await knex.schema.dropTableIfExists('pageAccessPasswords')
}
