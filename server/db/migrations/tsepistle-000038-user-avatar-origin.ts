import type { Knex } from 'knex'

const AVATARS_TABLE = 'userAvatars'
const ORIGIN_COLUMN = 'origin'
const ORIGIN_CHECK = 'user_avatars_origin_check'
const PROVIDER_ORIGIN = 'provider'
const SELF_SERVICE_ORIGIN = 'self-service'

const isPostgres = (knex: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLowerCase())

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(AVATARS_TABLE)) || (await knex.schema.hasColumn(AVATARS_TABLE, ORIGIN_COLUMN))) return

  await knex.schema.alterTable(AVATARS_TABLE, table => {
    table.string(ORIGIN_COLUMN, 16).nullable()
  })

  if (isPostgres(knex)) {
    await knex.raw(
      `ALTER TABLE "${AVATARS_TABLE}" ADD CONSTRAINT "${ORIGIN_CHECK}" CHECK ("${ORIGIN_COLUMN}" IS NULL OR "${ORIGIN_COLUMN}" IN ('${PROVIDER_ORIGIN}', '${SELF_SERVICE_ORIGIN}'))`
    )
  }
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    if (!(await transaction.schema.hasTable(AVATARS_TABLE)) || !(await transaction.schema.hasColumn(AVATARS_TABLE, ORIGIN_COLUMN))) return

    if (isPostgres(transaction)) await transaction.raw(`LOCK TABLE "${AVATARS_TABLE}" IN SHARE ROW EXCLUSIVE MODE`)

    const rows = await transaction(AVATARS_TABLE).select(ORIGIN_COLUMN)
    const hasUnsafeOrigin = rows.some(row => row[ORIGIN_COLUMN] !== PROVIDER_ORIGIN)
    if (hasUnsafeOrigin) {
      throw new Error('Cannot roll down user avatar origin while unknown or self-service avatar provenance remains.')
    }

    if (isPostgres(transaction)) await transaction.raw(`ALTER TABLE "${AVATARS_TABLE}" DROP CONSTRAINT IF EXISTS "${ORIGIN_CHECK}"`)
    await transaction.schema.alterTable(AVATARS_TABLE, table => {
      table.dropColumn(ORIGIN_COLUMN)
    })
  })
}
