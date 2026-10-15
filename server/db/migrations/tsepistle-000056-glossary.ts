import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('glossaryTerms', table => {
    table.increments('id').primary()
    table.string('locale', 35).notNullable()
    table.string('term', 255).notNullable()
    table.string('expansion', 255).notNullable().defaultTo('')
    table.text('definition').notNullable().defaultTo('')
    table.string('category', 255).notNullable().defaultTo('')
    table.integer('documentationPageId').nullable().references('id').inTable('pages').onDelete('SET NULL')
    table.string('documentationLabel', 255).notNullable().defaultTo('')
    table.jsonb('references').notNullable().defaultTo('[]')
    table.boolean('caseSensitive').notNullable().defaultTo(false)
    table.boolean('autoLink').notNullable().defaultTo(true)
    table.integer('revision').notNullable().defaultTo(1)
    table.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.unique(['id', 'locale'], { indexName: 'glossary_terms_id_locale_unique', useConstraint: true })
    table.index(['locale', 'id'], 'glossary_terms_catalog_idx')
  })
  await knex.raw('ALTER TABLE "glossaryTerms" ADD CONSTRAINT glossary_terms_revision_positive CHECK (revision > 0)')
  await knex.schema.createTable('glossaryNames', table => {
    table.string('locale', 35).notNullable()
    table.text('key').notNullable()
    table.string('name', 255).notNullable()
    table.integer('termId').notNullable()
    table.boolean('isAlias').notNullable()
    table.primary(['locale', 'key'], { constraintName: 'glossary_names_locale_key_unique' })
    table.foreign(['termId', 'locale']).references(['id', 'locale']).inTable('glossaryTerms').onDelete('CASCADE')
    table.index(['termId'], 'glossary_names_term_idx')
  })
  await knex.raw('CREATE UNIQUE INDEX glossary_names_one_canonical ON "glossaryNames" ("termId") WHERE NOT "isAlias"')
  await knex.schema.createTable('glossaryTermRelations', table => {
    table.string('locale', 35).notNullable()
    table.integer('leftId').notNullable()
    table.integer('rightId').notNullable()
    table.primary(['leftId', 'rightId'])
    table.foreign(['leftId', 'locale']).references(['id', 'locale']).inTable('glossaryTerms').onDelete('CASCADE')
    table.foreign(['rightId', 'locale']).references(['id', 'locale']).inTable('glossaryTerms').onDelete('CASCADE')
    table.index(['rightId'], 'glossary_relations_right_idx')
  })
  await knex.raw('ALTER TABLE "glossaryTermRelations" ADD CONSTRAINT glossary_relation_order CHECK ("leftId" < "rightId")')
}

export const down = async (knex: Knex): Promise<void> => {
  for (const table of ['glossaryTerms', 'glossaryNames', 'glossaryTermRelations']) {
    if ((await knex.schema.hasTable(table)) && (await knex(table).first())) {
      throw new Error('Cannot discard populated glossary data. Preserve it and apply a forward migration.')
    }
  }
  await knex.schema.dropTableIfExists('glossaryTermRelations')
  await knex.schema.dropTableIfExists('glossaryNames')
  await knex.schema.dropTableIfExists('glossaryTerms')
}
