import type { Knex } from 'knex'
import { DEFAULT_ROUTING_POLICY } from '../../../shared/agents/routing.ts'

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable('agentRoutingPolicy'))) {
    await knex.schema.createTable('agentRoutingPolicy', table => {
      table.integer('id').primary()
      table.integer('revision').notNullable().defaultTo(1)
      table.text('config').notNullable()
      table.integer('updatedBy').nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('updatedAt', { useTz: true }).nullable()
    })
    await knex('agentRoutingPolicy').insert({ id: 1, revision: 1, config: JSON.stringify(DEFAULT_ROUTING_POLICY) })
    await knex.raw('ALTER TABLE "agentRoutingPolicy" ADD CONSTRAINT "agentRoutingPolicy_revision_positive" CHECK ("revision" > 0)')
  }
  if (!(await knex.schema.hasTable('agentRoutingModelPolicies'))) {
    await knex.schema.createTable('agentRoutingModelPolicies', table => {
      table.uuid('profileId').primary().references('id').inTable('agentProviderProfiles').onDelete('CASCADE')
      table.uuid('profileVersionId').notNullable().references('id').inTable('agentProviderProfileVersions').onDelete('CASCADE')
      table.integer('revision').notNullable()
      table.text('config').notNullable()
      table.integer('updatedBy').nullable().references('id').inTable('users').onDelete('SET NULL')
      table.timestamp('updatedAt', { useTz: true }).notNullable()
    })
    await knex.raw('ALTER TABLE "agentRoutingModelPolicies" ADD CONSTRAINT "agentRoutingModelPolicies_revision_positive" CHECK ("revision" > 0)')
  }
}

export const down = async (knex: Knex): Promise<void> => {
  const policy = await knex('agentRoutingPolicy').where({ id: 1 }).first('revision')
  if (policy?.revision !== 1 || (await knex('agentRoutingModelPolicies').first('profileId')))
    throw new Error('Routing policy contains administrator configuration; refuse destructive rollback')
  await knex.schema.dropTableIfExists('agentRoutingModelPolicies')
  await knex.schema.dropTableIfExists('agentRoutingPolicy')
}
