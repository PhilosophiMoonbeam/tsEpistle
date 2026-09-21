import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable('agentMedia'))) return
  if (!(await knex.schema.hasColumn('agentMedia', 'promptTokens'))) {
    await knex.schema.alterTable('agentMedia', table => {
      table.integer('promptTokens').nullable()
    })
  }
  if (!(await knex.schema.hasColumn('agentMedia', 'detachedAt'))) {
    await knex.schema.alterTable('agentMedia', table => {
      table.timestamp('detachedAt', { useTz: true }).nullable()
    })
  }
}

export const down = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable('agentMedia'))) return
  if (await knex('agentMedia').whereNotNull('detachedAt').first('id'))
    throw new Error('agentMedia contains compaction-detached attachments; refuse destructive rollback')
  if (await knex('agentMedia').whereNotNull('promptTokens').first('id'))
    throw new Error('agentMedia contains measured prompt token counts; refuse destructive rollback')
  if (await knex.schema.hasColumn('agentMedia', 'detachedAt')) {
    await knex.schema.alterTable('agentMedia', table => table.dropColumn('detachedAt'))
  }
  if (await knex.schema.hasColumn('agentMedia', 'promptTokens')) {
    await knex.schema.alterTable('agentMedia', table => table.dropColumn('promptTokens'))
  }
}
