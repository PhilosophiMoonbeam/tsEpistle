import type { Knex } from 'knex'

const TABLE_NAME = 'agentSkills'
const SYSTEM_NAME_INDEX = 'agent_skills_active_system_name_unique'
const OWNER_NAME_INDEX = 'agent_skills_active_owner_name_unique'

export const up = async (knex: Knex): Promise<void> => {
  if (await knex.schema.hasColumn(TABLE_NAME, 'ownerUserId')) return

  await knex.schema.alterTable(TABLE_NAME, table => {
    table.integer('ownerUserId').unsigned().nullable().references('id').inTable('users').onDelete('RESTRICT')
    table.dateTime('deletedAt').nullable()
    table.index(['ownerUserId', 'deletedAt'], 'agent_skills_owner_deleted_idx')
  })
  await knex.schema.alterTable(TABLE_NAME, table => {
    table.integer('rootPageId').unsigned().nullable().alter()
    table.dropUnique(['name'])
  })
  await knex.raw(`CREATE UNIQUE INDEX ${SYSTEM_NAME_INDEX} ON "${TABLE_NAME}" (name) WHERE "ownerUserId" IS NULL AND "deletedAt" IS NULL`)
  await knex.raw(`CREATE UNIQUE INDEX ${OWNER_NAME_INDEX} ON "${TABLE_NAME}" ("ownerUserId", name) WHERE "ownerUserId" IS NOT NULL AND "deletedAt" IS NULL`)
}

export const down = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasColumn(TABLE_NAME, 'ownerUserId')) return
  const row = await knex(TABLE_NAME)
    .whereNotNull('ownerUserId')
    .orWhereNotNull('deletedAt')
    .count<{ count: string }[]>({ count: '*' })
    .first()
  if (Number(row?.count ?? 0) > 0) throw new Error(`Cannot roll down personal skills migration while ${TABLE_NAME} contains personal or removed skills`)

  await knex.raw(`DROP INDEX IF EXISTS ${OWNER_NAME_INDEX}`)
  await knex.raw(`DROP INDEX IF EXISTS ${SYSTEM_NAME_INDEX}`)
  await knex.schema.alterTable(TABLE_NAME, table => {
    table.integer('rootPageId').unsigned().notNullable().alter()
    table.unique(['name'])
    table.dropIndex(['ownerUserId', 'deletedAt'], 'agent_skills_owner_deleted_idx')
    table.dropColumn('deletedAt')
    table.dropColumn('ownerUserId')
  })
}
