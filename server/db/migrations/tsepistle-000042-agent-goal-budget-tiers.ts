import type { Knex } from 'knex'

const GOALS = 'agentGoals'
const CHECK_SELECTION = 'agent_goals_budget_selection_check'
const CHECK_TIER = 'agent_goals_budget_tier_check'
const CHECK_REASON = 'agent_goals_budget_limit_reason_check'

const isPostgres = (knex: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLowerCase())

const addChecks = async (knex: Knex): Promise<void> => {
  if (!isPostgres(knex)) return
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${CHECK_SELECTION}') THEN
        ALTER TABLE "${GOALS}" ADD CONSTRAINT "${CHECK_SELECTION}" CHECK ("budgetSelection" IN ('pending', 'utility', 'fallback', 'legacy'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${CHECK_TIER}') THEN
        ALTER TABLE "${GOALS}" ADD CONSTRAINT "${CHECK_TIER}" CHECK ("tokenTier" IS NULL OR "tokenTier" IN ('standard', 'extended'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${CHECK_REASON}') THEN
        ALTER TABLE "${GOALS}" ADD CONSTRAINT "${CHECK_REASON}" CHECK ("budgetLimitReason" IS NULL OR "budgetLimitReason" IN ('tokens', 'tool_calls', 'duration', 'continuations', 'quota', 'accounting', 'authority'));
      END IF;
    END $$;
  `)
}

const dropChecks = async (knex: Knex): Promise<void> => {
  if (!isPostgres(knex)) return
  await knex.raw(`ALTER TABLE "${GOALS}" DROP CONSTRAINT IF EXISTS "${CHECK_REASON}"`)
  await knex.raw(`ALTER TABLE "${GOALS}" DROP CONSTRAINT IF EXISTS "${CHECK_TIER}"`)
  await knex.raw(`ALTER TABLE "${GOALS}" DROP CONSTRAINT IF EXISTS "${CHECK_SELECTION}"`)
}

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(GOALS))) return
  const missing = {
    budgetPolicyVersion: !(await knex.schema.hasColumn(GOALS, 'budgetPolicyVersion')),
    budgetSelection: !(await knex.schema.hasColumn(GOALS, 'budgetSelection')),
    tokenTier: !(await knex.schema.hasColumn(GOALS, 'tokenTier')),
    tokenAllowance: !(await knex.schema.hasColumn(GOALS, 'tokenAllowance')),
    budgetCycle: !(await knex.schema.hasColumn(GOALS, 'budgetCycle')),
    budgetLimitReason: !(await knex.schema.hasColumn(GOALS, 'budgetLimitReason'))
  }
  if (Object.values(missing).some(Boolean)) {
    await knex.schema.alterTable(GOALS, table => {
      if (missing.budgetPolicyVersion) table.integer('budgetPolicyVersion').unsigned().nullable()
      if (missing.budgetSelection) table.string('budgetSelection', 16).notNullable().defaultTo('legacy')
      if (missing.tokenTier) table.string('tokenTier', 16).nullable()
      if (missing.tokenAllowance) table.bigInteger('tokenAllowance').nullable()
      if (missing.budgetCycle) table.integer('budgetCycle').unsigned().notNullable().defaultTo(0)
      if (missing.budgetLimitReason) table.string('budgetLimitReason', 24).nullable()
    })
  }
  if (await knex.schema.hasColumn(GOALS, 'budgetPolicyVersion')) {
    await knex(GOALS).whereNull('budgetPolicyVersion').update({ budgetSelection: 'legacy', budgetCycle: 0, tokenTier: null, tokenAllowance: null })
  }
  await addChecks(knex)
}

export const down = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(GOALS))) return
  if (await knex.schema.hasColumn(GOALS, 'budgetPolicyVersion')) {
    const modern = await knex(GOALS).whereNotNull('budgetPolicyVersion').first('id')
    if (modern) throw new Error('agentGoals contains selected token budget state; refuse destructive rollback')
  }
  const columns = {
    budgetLimitReason: await knex.schema.hasColumn(GOALS, 'budgetLimitReason'),
    budgetCycle: await knex.schema.hasColumn(GOALS, 'budgetCycle'),
    tokenAllowance: await knex.schema.hasColumn(GOALS, 'tokenAllowance'),
    tokenTier: await knex.schema.hasColumn(GOALS, 'tokenTier'),
    budgetSelection: await knex.schema.hasColumn(GOALS, 'budgetSelection'),
    budgetPolicyVersion: await knex.schema.hasColumn(GOALS, 'budgetPolicyVersion')
  }
  await dropChecks(knex)
  if (Object.values(columns).some(Boolean)) {
    await knex.schema.alterTable(GOALS, table => {
      if (columns.budgetLimitReason) table.dropColumn('budgetLimitReason')
      if (columns.budgetCycle) table.dropColumn('budgetCycle')
      if (columns.tokenAllowance) table.dropColumn('tokenAllowance')
      if (columns.tokenTier) table.dropColumn('tokenTier')
      if (columns.budgetSelection) table.dropColumn('budgetSelection')
      if (columns.budgetPolicyVersion) table.dropColumn('budgetPolicyVersion')
    })
  }
}
