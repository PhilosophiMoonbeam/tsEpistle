import type { Knex } from 'knex'
import { canonicalJson } from '../../helpers/canonical-json.ts'

const additions = {
  specialistEnabled: false,
  specialistMaxContexts: 4,
  specialistMaxContextBytes: 65_536,
  specialistMaxReportTokens: 1_024,
  specialistMaxTurns: 3
} as const

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('agentSpecialistContexts', table => {
    table.uuid('id').primary()
    table.integer('ownerId').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.uuid('rootSessionId').notNullable().references('id').inTable('agentSessions').onDelete('CASCADE')
    table.text('data').notNullable()
    table.string('dataSha256', 64).notNullable()
    table.string('scopeSha256', 64).notNullable()
    table.integer('version').notNullable()
    table.integer('turnCount').notNullable()
    table.timestamp('expiresAt', { useTz: true }).notNullable()
    table.timestamp('lastUsedAt', { useTz: true }).notNullable()
    table.timestamp('scrubbedAt', { useTz: true }).nullable()
    table.index(['ownerId', 'rootSessionId', 'scopeSha256', 'expiresAt'], 'agentSpecialistContexts_scope_idx')
    table.index(['expiresAt'], 'agentSpecialistContexts_expiry_idx')
    table.check('"version" > 0 AND "turnCount" >= 0')
  })
  await knex.schema.createTable('agentSpecialistInvocations', table => {
    table.uuid('id').primary()
    table.integer('ownerId').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.uuid('rootSessionId').notNullable().references('id').inTable('agentSessions').onDelete('CASCADE')
    table.uuid('rootRunId').notNullable().unique().references('id').inTable('agentRuns').onDelete('CASCADE')
    // Keep the historical context ID after expiry removes its sensitive payload.
    table.uuid('contextId').notNullable()
    table.integer('contextVersion').notNullable()
    table.string('status', 16).notNullable()
    table.text('data').notNullable()
    table.string('dataSha256', 64).notNullable()
    table.string('beginSha256', 64).notNullable()
    table.string('completionSha256', 64).nullable()
    table.integer('rootAttempt').notNullable()
    table.string('rootLeaseOwner', 256).notNullable()
    table.uuid('rootLeaseToken').notNullable()
    table.integer('maximumContextBytes').notNullable()
    table.timestamp('expiresAt', { useTz: true }).notNullable()
    table.timestamp('startedAt', { useTz: true }).notNullable()
    table.timestamp('completedAt', { useTz: true }).nullable()
    table.timestamp('scrubbedAt', { useTz: true }).nullable()
    table.index(['ownerId', 'rootSessionId', 'startedAt'], 'agentSpecialistInvocations_root_idx')
    table.index(['contextId', 'status'], 'agentSpecialistInvocations_active_idx')
    table.index(['expiresAt'], 'agentSpecialistInvocations_expiry_idx')
    table.check('"contextVersion" > 0 AND "rootAttempt" > 0')
    table.check('"maximumContextBytes" BETWEEN 4096 AND 262144')
    table.check("\"status\" IN ('running', 'completed', 'failed')")
  })
  const rows = await knex('agentRoutingPolicy').select('id', 'config')
  for (const row of rows) {
    const config: unknown = typeof row.config === 'string' ? JSON.parse(row.config) : row.config
    if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error('Cannot extend invalid routing policy')
    // Existing values, unknown settings, revisions and updater metadata are untouched.
    await knex('agentRoutingPolicy')
      .where({ id: row.id })
      .update({ config: canonicalJson({ ...additions, ...config }) })
  }
}

export const down = async (knex: Knex): Promise<void> => {
  if ((await knex('agentSpecialistContexts').first('id')) || (await knex('agentSpecialistInvocations').first('id')))
    throw new Error('Cannot discard specialist context or invocation receipts. Apply a forward migration.')
  const policies = await knex('agentRoutingPolicy').select('id', 'config')
  for (const row of policies) {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : row.config
    if (Object.entries(additions).some(([key, value]) => config[key] !== value))
      throw new Error('Cannot discard administrator specialist policy. Apply a forward migration.')
  }
  await knex.schema.dropTable('agentSpecialistInvocations')
  await knex.schema.dropTable('agentSpecialistContexts')
  for (const row of policies) {
    const config = typeof row.config === 'string' ? JSON.parse(row.config) : { ...row.config }
    for (const key of Object.keys(additions)) delete config[key]
    await knex('agentRoutingPolicy')
      .where({ id: row.id })
      .update({ config: canonicalJson(config) })
  }
}
