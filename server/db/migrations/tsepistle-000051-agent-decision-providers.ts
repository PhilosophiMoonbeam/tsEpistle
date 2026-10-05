import type { Knex } from 'knex'
import { TYPESAFE_DECISION_PROVIDER_ID, TYPESAFE_JEV_PRICING } from '../../../shared/agents/decision-providers.ts'

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable('agentDecisionProviderConfiguration'))) {
    await knex.schema.createTable('agentDecisionProviderConfiguration', table => {
      table.integer('id').primary()
      table.integer('revision').notNullable().defaultTo(1)
    })
    await knex('agentDecisionProviderConfiguration').insert({ id: 1, revision: 1 })
  }
  if (!(await knex.schema.hasTable('agentDecisionProviders'))) {
    await knex.schema.createTable('agentDecisionProviders', table => {
      table.uuid('id').primary()
      table.string('displayName', 255).notNullable()
      table.integer('revision').notNullable()
      table.text('config').notNullable()
      table.string('secretReference', 255).nullable()
      table.boolean('enabled').notNullable().defaultTo(false)
      table.boolean('isDefault').notNullable().defaultTo(false)
      table.timestamp('checkedAt', { useTz: true }).nullable()
      table.integer('createdBy').nullable().references('id').inTable('users').onDelete('SET NULL')
      table.integer('updatedBy').nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('createdAt', { useTz: true }).notNullable()
      table.timestamp('updatedAt', { useTz: true }).notNullable()
    })
    await knex.raw('CREATE UNIQUE INDEX "agentDecisionProviders_default" ON "agentDecisionProviders" ("isDefault") WHERE "isDefault" = true')
    await knex.raw('ALTER TABLE "agentDecisionProviders" ADD CONSTRAINT "agentDecisionProviders_default_enabled" CHECK (NOT "isDefault" OR "enabled")')
    await knex.raw('ALTER TABLE "agentDecisionProviders" ADD CONSTRAINT "agentDecisionProviders_revision_positive" CHECK ("revision" > 0)')
    const now = new Date()
    // This is a credential-free bootstrap, not an LLM profile. Selection still requires
    // the server-side environment key (or a subsequently configured managed secret).
    await knex('agentDecisionProviders').insert({
      id: TYPESAFE_DECISION_PROVIDER_ID,
      displayName: 'TypeSafe AI / Jev',
      revision: 1,
      config: JSON.stringify({ kind: 'typesafe', model: 'jev-latest', timeoutMs: 5_000, pricing: TYPESAFE_JEV_PRICING }),
      secretReference: null,
      enabled: true,
      isDefault: true,
      checkedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: now,
      updatedAt: now
    })
  }
}

export const down = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasTable('agentDecisionProviders')) {
    const changed = await knex('agentDecisionProviders').whereNot({ id: TYPESAFE_DECISION_PROVIDER_ID }).orWhereNot({ revision: 1 }).first('id')
    if (changed) throw new Error('Decision providers contain administrator configuration; refuse destructive rollback')
    await knex.schema.dropTable('agentDecisionProviders')
  }
  await knex.schema.dropTableIfExists('agentDecisionProviderConfiguration')
}
