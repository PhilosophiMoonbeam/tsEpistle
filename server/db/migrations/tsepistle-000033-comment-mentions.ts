import type { Knex } from 'knex'

const TABLE = 'users'
const COLUMN = 'handle'
const UNIQUE_INDEX = 'users_handle_unique'
const FORMAT_CONSTRAINT = 'users_handle_format'
const CLAIMS_TABLE = 'userHandleClaims'
const CLAIMS_FORMAT_CONSTRAINT = 'user_handle_claims_format'
const ROLLBACK_ERROR = 'Cannot discard permanent user mention handle claims. Preserve them and apply a forward fix or restore a compatible database backup.'

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(TABLE))) return
  if (!(await knex.schema.hasColumn(TABLE, COLUMN))) {
    await knex.schema.alterTable(TABLE, table => { table.string(COLUMN, 32).nullable() })
    await knex.raw(`ALTER TABLE "${TABLE}" ADD CONSTRAINT "${FORMAT_CONSTRAINT}" CHECK ("${COLUMN}" IS NULL OR "${COLUMN}" ~ '^[a-z0-9_-]{3,32}$')`)
    await knex.raw(`CREATE UNIQUE INDEX "${UNIQUE_INDEX}" ON "${TABLE}" ("${COLUMN}") WHERE "${COLUMN}" IS NOT NULL`)
  }
  if (!(await knex.schema.hasTable(CLAIMS_TABLE))) {
    await knex.schema.createTable(CLAIMS_TABLE, table => {
      table.string('handle', 32).primary()
      table.integer('userId').nullable().references('id').inTable(TABLE).onDelete('SET NULL')
      table.timestamp('createdAt', true).notNullable().defaultTo(knex.fn.now())
      table.index(['userId'], 'user_handle_claims_user_idx')
    })
    await knex.raw(`ALTER TABLE "${CLAIMS_TABLE}" ADD CONSTRAINT "${CLAIMS_FORMAT_CONSTRAINT}" CHECK ("handle" ~ '^[a-z0-9_-]{3,32}$')`)
  }
}

export const down = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(TABLE)) || !(await knex.schema.hasColumn(TABLE, COLUMN))) return
  const current = await knex<UserHandleRow>(TABLE).whereNotNull(COLUMN).first('id')
  const claimed = await knex.schema.hasTable(CLAIMS_TABLE) ? await knex<UserHandleRow>(CLAIMS_TABLE).first('userId as id') : undefined
  if (current || claimed) throw new Error(ROLLBACK_ERROR)
  if (await knex.schema.hasTable(CLAIMS_TABLE)) await knex.schema.dropTable(CLAIMS_TABLE)
  await knex.raw(`DROP INDEX IF EXISTS "${UNIQUE_INDEX}"`)
  await knex.raw(`ALTER TABLE "${TABLE}" DROP CONSTRAINT IF EXISTS "${FORMAT_CONSTRAINT}"`)
  await knex.schema.alterTable(TABLE, table => { table.dropColumn(COLUMN) })
}

interface UserHandleRow { readonly id: number }
