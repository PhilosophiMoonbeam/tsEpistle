import type { Knex } from 'knex'

/** Applied migration history stays intact; only the rejected field and its mappings are removed. */
export const up = async (knex: Knex): Promise<void> => {
  await knex.raw(`
    UPDATE authentication
    SET config = (config::jsonb - ARRAY['mappingPronouns', 'pronounsClaim'])::json
    WHERE jsonb_typeof(config::jsonb) = 'object'
      AND jsonb_exists_any(config::jsonb, ARRAY['mappingPronouns', 'pronounsClaim'])
  `)
  await knex.schema.alterTable('users', table => {
    table.dropColumn('pronouns')
  })
}

export const down = async (_knex: Knex): Promise<void> => {
  throw new Error('Retired profile data cannot be reconstructed; use a paired recovery point or fix forward.')
}
