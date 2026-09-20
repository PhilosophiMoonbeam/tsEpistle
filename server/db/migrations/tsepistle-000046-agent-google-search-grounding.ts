import type { Knex } from 'knex'

const SESSIONS = 'agentSessions'
const RUNS = 'agentRuns'
const MESSAGES = 'agentMessages'

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(SESSIONS)) || !(await knex.schema.hasTable(RUNS)) || !(await knex.schema.hasTable(MESSAGES))) return
  if (!(await knex.schema.hasColumn(SESSIONS, 'googleSearchEnabled'))) {
    await knex.schema.alterTable(SESSIONS, table => {
      table.boolean('googleSearchEnabled').notNullable().defaultTo(false)
    })
  }
  if (!(await knex.schema.hasColumn(RUNS, 'googleSearchEnabled'))) {
    await knex.schema.alterTable(RUNS, table => {
      table.boolean('googleSearchEnabled').notNullable().defaultTo(false)
    })
  }
  if (!(await knex.schema.hasColumn(MESSAGES, 'googleSearchGrounding'))) {
    await knex.schema.alterTable(MESSAGES, table => {
      table.text('googleSearchGrounding').nullable()
      table.index(['createdAt'], 'agent_messages_grounding_retention_idx')
    })
  }
}

export const down = async (knex: Knex): Promise<void> => {
  const hasGrounding = await knex.schema.hasColumn(MESSAGES, 'googleSearchGrounding')
  const hasRunConsent = await knex.schema.hasColumn(RUNS, 'googleSearchEnabled')
  const hasSessionConsent = await knex.schema.hasColumn(SESSIONS, 'googleSearchEnabled')
  if (hasGrounding && (await knex(MESSAGES).whereNotNull('googleSearchGrounding').first('id')))
    throw new Error('agentMessages contains retained Google Search grounding; refuse destructive rollback')
  if (hasRunConsent && (await knex(RUNS).where({ googleSearchEnabled: true }).first('id')))
    throw new Error('agentRuns contains admitted Google Search consent; refuse destructive rollback')
  if (hasSessionConsent && (await knex(SESSIONS).where({ googleSearchEnabled: true }).first('id')))
    throw new Error('agentSessions contains Google Search consent; refuse destructive rollback')
  if (hasGrounding) {
    await knex.schema.alterTable(MESSAGES, table => {
      table.dropIndex(['createdAt'], 'agent_messages_grounding_retention_idx')
      table.dropColumn('googleSearchGrounding')
    })
  }
  if (hasRunConsent) await knex.schema.alterTable(RUNS, table => table.dropColumn('googleSearchEnabled'))
  if (hasSessionConsent) await knex.schema.alterTable(SESSIONS, table => table.dropColumn('googleSearchEnabled'))
}
