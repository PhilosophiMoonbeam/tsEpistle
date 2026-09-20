import type { Knex } from 'knex'

const GOALS = 'agentGoals'
const CHECK_TIER = 'agent_goals_budget_tier_check'
const POLICY_VERSION = 2

const isPostgres = (knex: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLowerCase())

const replaceTierCheck = async (knex: Knex, tiers: readonly string[]): Promise<void> => {
  if (!isPostgres(knex)) return
  const values = tiers.map(tier => `'${tier}'`).join(', ')
  await knex.raw(`ALTER TABLE "${GOALS}" DROP CONSTRAINT IF EXISTS "${CHECK_TIER}"`)
  await knex.raw(`ALTER TABLE "${GOALS}" ADD CONSTRAINT "${CHECK_TIER}" CHECK ("tokenTier" IS NULL OR "tokenTier" IN (${values}))`)
}

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(GOALS))) return
  if (!(await knex.schema.hasColumn(GOALS, 'budgetPolicyVersion')) || !(await knex.schema.hasColumn(GOALS, 'budgetSelection'))) {
    throw new Error('agentGoals budget policy columns are missing')
  }

  await replaceTierCheck(knex, ['small', 'standard', 'extended'])
  await knex(GOALS).where({ budgetPolicyVersion: 1, budgetSelection: 'pending' }).update({ budgetPolicyVersion: POLICY_VERSION })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(GOALS))) return
  const policyV2 = await knex(GOALS).where({ budgetPolicyVersion: POLICY_VERSION }).first('id')
  const small = await knex(GOALS).where({ tokenTier: 'small' }).first('id')
  if (policyV2 || small) throw new Error('agentGoals contains policy v2 token budget state; refuse destructive rollback')
  await replaceTierCheck(knex, ['standard', 'extended'])
}
