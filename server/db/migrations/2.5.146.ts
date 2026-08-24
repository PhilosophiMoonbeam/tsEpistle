import type { Knex } from 'knex'

const PREFERENCES = 'agentUserSkillPreferences'
const SESSION_SKILLS = 'agentSessionSkills'

export const up = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(PREFERENCES)) {
    await knex.schema.createTable(PREFERENCES, table => {
      table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.uuid('skillId').notNullable().references('id').inTable('agentSkills').onDelete('CASCADE')
      table.integer('ordinal').unsigned().notNullable()
      table.dateTime('selectedAt').notNullable().defaultTo(knex.fn.now())
      table.primary(['ownerId', 'skillId'], 'agent_user_skill_preferences_pk')
      table.unique(['ownerId', 'ordinal'], { indexName: 'agent_user_skill_preferences_ordinal_unique' })
      table.index(['skillId'], 'agent_user_skill_preferences_skill_idx')
    })
  }
  if (!await knex.schema.hasTable(SESSION_SKILLS)) return

  const sessions = await knex('agentSessions')
    .select('id', 'ownerId', 'updatedAt')
    .whereNull('deletedAt')
    .orderBy('ownerId')
    .orderBy('updatedAt', 'desc')
    .orderBy('id', 'desc') as Array<{ id: string, ownerId: number, updatedAt: Date | string }>
  const latestSessionByOwner = new Map<number, string>()
  for (const session of sessions) if (!latestSessionByOwner.has(session.ownerId)) latestSessionByOwner.set(session.ownerId, session.id)

  const latestSessionIds = [...latestSessionByOwner.values()]
  if (latestSessionIds.length > 0) {
    const rows = await knex(`${SESSION_SKILLS} as selected`)
      .innerJoin('agentSkillVersions as versions', 'versions.id', 'selected.skillVersionId')
      .innerJoin('agentSessions as sessions', 'sessions.id', 'selected.sessionId')
      .select('sessions.ownerId', 'versions.skillId', 'selected.ordinal', 'selected.selectedAt')
      .whereIn('selected.sessionId', latestSessionIds)
      .orderBy('sessions.ownerId')
      .orderBy('selected.ordinal') as Array<{ ownerId: number, skillId: string, ordinal: number, selectedAt: Date | string }>
    const seenByOwner = new Map<number, Set<string>>()
    const preferences: Array<{ ownerId: number, skillId: string, ordinal: number, selectedAt: Date | string }> = []
    for (const row of rows) {
      const seen = seenByOwner.get(row.ownerId) ?? new Set<string>()
      if (seen.size >= 8 || seen.has(row.skillId)) continue
      seen.add(row.skillId)
      seenByOwner.set(row.ownerId, seen)
      preferences.push({ ownerId: row.ownerId, skillId: row.skillId, ordinal: seen.size - 1, selectedAt: row.selectedAt })
    }
    if (preferences.length > 0) await knex(PREFERENCES).insert(preferences)
  }
  await knex.schema.dropTable(SESSION_SKILLS)
}

export const down = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(SESSION_SKILLS)) {
    await knex.schema.createTable(SESSION_SKILLS, table => {
      table.uuid('sessionId').notNullable().references('id').inTable('agentSessions').onDelete('CASCADE')
      table.uuid('skillVersionId').notNullable().references('id').inTable('agentSkillVersions').onDelete('RESTRICT')
      table.integer('ordinal').unsigned().notNullable()
      table.integer('selectedBy').unsigned().notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table.dateTime('selectedAt').notNullable().defaultTo(knex.fn.now())
      table.unique(['sessionId', 'skillVersionId'], { indexName: 'agent_session_skills_version_unique' })
      table.unique(['sessionId', 'ordinal'], { indexName: 'agent_session_skills_ordinal_unique' })
    })
  }
  if (!await knex.schema.hasTable(PREFERENCES)) return
  const rows = await knex(`${PREFERENCES} as preferences`)
    .innerJoin('agentSkills as skills', 'skills.id', 'preferences.skillId')
    .innerJoin('agentSessions as sessions', 'sessions.ownerId', 'preferences.ownerId')
    .select('sessions.id as sessionId', 'skills.currentVersionId as skillVersionId', 'preferences.ordinal', 'preferences.ownerId as selectedBy', 'preferences.selectedAt')
    .whereNotNull('skills.currentVersionId')
    .whereNull('sessions.deletedAt') as Array<{ sessionId: string, skillVersionId: string, ordinal: number, selectedBy: number, selectedAt: Date | string }>
  if (rows.length > 0) await knex(SESSION_SKILLS).insert(rows)
  await knex.schema.dropTable(PREFERENCES)
}
