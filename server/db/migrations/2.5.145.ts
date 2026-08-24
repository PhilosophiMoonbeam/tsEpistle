import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable('agentSessions')) return
  await knex('agentSessions').where({ executionMode: 'generation-only' }).update({ executionMode: 'agent' })
}

export const down = async (): Promise<void> => {
  // The previous per-session mode cannot be reconstructed after the Agent-only cutover.
}
