import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('commentAnnotations', table => {
    table.increments('id').primary()
    table.integer('commentId').notNullable().references('id').inTable('comments').onDelete('CASCADE')
    table.integer('position').notNullable()
    table.text('note').notNullable()
    table.jsonb('anchor').notNullable()
    table.integer('revision').notNullable().defaultTo(1)
    table.timestamp('resolvedAt', { useTz: true }).nullable()
    table.integer('resolvedById').nullable().references('id').inTable('users').onDelete('SET NULL')
    table.timestamp('createdAt', { useTz: true }).notNullable()
    table.timestamp('updatedAt', { useTz: true }).notNullable()
    table.unique(['commentId', 'position'], { indexName: 'comment_annotations_position_unique' })
  })
  // Use the native function so Knex cannot interpret the JSONB existence operator as a binding.
  await knex.raw(`ALTER TABLE "commentAnnotations"
    ADD CONSTRAINT "comment_annotations_position_check" CHECK ("position" BETWEEN 0 AND 7),
    ADD CONSTRAINT "comment_annotations_revision_check" CHECK ("revision" > 0),
    ADD CONSTRAINT "comment_annotations_note_check" CHECK (char_length("note") <= 5000),
    ADD CONSTRAINT "comment_annotations_anchor_check" CHECK (
      jsonb_typeof("anchor") = 'object'
      AND jsonb_typeof("anchor"->'exact') = 'string' AND char_length("anchor"->>'exact') BETWEEN 1 AND 1000
      AND jsonb_typeof("anchor"->'prefix') = 'string' AND char_length("anchor"->>'prefix') <= 64
      AND jsonb_typeof("anchor"->'suffix') = 'string' AND char_length("anchor"->>'suffix') <= 64
      AND ("anchor"->'heading' = 'null'::jsonb OR (jsonb_typeof("anchor"->'heading') = 'string' AND char_length("anchor"->>'heading') <= 255))
      AND jsonb_typeof("anchor"->'offset') = 'number'
      AND ("anchor"->>'offset')::numeric BETWEEN 0 AND 9007199254740991
      AND trunc(("anchor"->>'offset')::numeric) = ("anchor"->>'offset')::numeric
      AND jsonb_exists_all("anchor", ARRAY['exact', 'prefix', 'suffix', 'heading', 'offset'])
    )`)
  await knex.schema.alterTable('comments', table => {
    table.index(['authorId', 'createdAt', 'id'], 'comments_author_recent_order')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (await knex('commentAnnotations').first('id'))
    throw new Error('Cannot roll down discussion annotations while annotations exist. Restore a pre-migration backup or apply a forward fix.')
  await knex.schema.dropTable('commentAnnotations')
  await knex.schema.alterTable('comments', table => {
    table.dropIndex([], 'comments_author_recent_order')
  })
}
