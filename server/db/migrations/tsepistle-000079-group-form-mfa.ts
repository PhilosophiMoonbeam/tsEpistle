import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable('groups', table => {
    table.boolean('formMfaRequired').notNullable().defaultTo(false)
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (await knex('groups').where('formMfaRequired', true).first('id'))
    throw new Error('Cannot discard an active group form-MFA requirement. Remove it through reviewed group administration or apply a forward fix.')
  await knex.schema.alterTable('groups', table => {
    table.dropColumn('formMfaRequired')
  })
}
