import type { Knex } from 'knex'

const TABLE = 'pageKnowledgeProjections'

export const up = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasTable(TABLE)) return
  await knex.schema.createTable(TABLE, table => {
    table.increments('id').primary()
    table.integer('pageId').unsigned().notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.string('sourceSha256', 64).notNullable()
    table.integer('schemaVersion').unsigned().notNullable()
    table.string('deterministicVersion', 64).notNullable()
    table.string('state', 32).notNullable()
    table.string('enrichmentState', 32).notNullable()
    table.string('conceptType', 128).nullable()
    table.text('summary').notNullable()
    table.text('searchText').notNullable()
    table.string('lifecycleStatus', 32).notNullable()
    table.string('trustTier', 32).notNullable()
    table.string('verification', 32).notNullable()
    table.dateTime('staleAfter').nullable()
    table.uuid('utilityProfileVersionId').nullable()
    table.string('utilityModel', 255).nullable()
    table.string('utilityInputSha256', 64).nullable()
    table.string('utilityOutputSha256', 64).nullable()
    table.dateTime('utilityGeneratedAt').nullable()
    table.text('projection').notNullable()
    table.text('lastError').nullable()
    table.dateTime('createdAt').notNullable().defaultTo(knex.fn.now())
    table.dateTime('updatedAt').notNullable().defaultTo(knex.fn.now())
    table.unique(['pageId', 'sourceRevision'], { indexName: 'page_knowledge_projection_revision_unique' })
    table.index(['pageId', 'sourceRevision'], 'page_knowledge_projection_current_idx')
    table.index(['state', 'lifecycleStatus'], 'page_knowledge_projection_lifecycle_idx')
    table.index(['conceptType'], 'page_knowledge_projection_type_idx')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists(TABLE)
}
