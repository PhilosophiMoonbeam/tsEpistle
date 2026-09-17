import type { Knex } from 'knex'

const TABLE = 'agentQuotaDaily'
const COLUMN = 'tokenResetCredit'
const CHECK = 'agent_quota_daily_token_reset_credit_check'
const isPostgres = (knex: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLowerCase())

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.schema.alterTable(TABLE, table => {
      table.bigInteger(COLUMN).notNullable().defaultTo(0)
    })
  }
  if (isPostgres(knex)) {
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${CHECK}' AND conrelid = '"${TABLE}"'::regclass) THEN
          ALTER TABLE "${TABLE}" ADD CONSTRAINT "${CHECK}" CHECK ("${COLUMN}" >= 0 AND "${COLUMN}" <= 9007199254740991);
        END IF;
      END $$;
    `)
  }
}

export const down = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(TABLE)) || !(await knex.schema.hasColumn(TABLE, COLUMN))) return
  if (await knex(TABLE).where(COLUMN, '>', 0).first('ownerId')) throw new Error('Daily token reset credits exist; refuse destructive rollback')
  if (isPostgres(knex)) await knex.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${CHECK}"`)
  await knex.schema.alterTable(TABLE, table => { table.dropColumn(COLUMN) })
}
