import type { Knex } from 'knex'

const PAGE_TABLE = 'pages'
const RENDERED_SOURCE_REVISION_COLUMN = 'renderedSourceRevision'

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(PAGE_TABLE)) || (await knex.schema.hasColumn(PAGE_TABLE, RENDERED_SOURCE_REVISION_COLUMN))) return
  await knex.schema.alterTable(PAGE_TABLE, table => {
    // Existing render bytes are unverified until a guarded render certifies them.
    table.bigInteger(RENDERED_SOURCE_REVISION_COLUMN).nullable()
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(PAGE_TABLE)) || !(await knex.schema.hasColumn(PAGE_TABLE, RENDERED_SOURCE_REVISION_COLUMN))) return
  await knex.schema.alterTable(PAGE_TABLE, table => {
    table.dropColumn(RENDERED_SOURCE_REVISION_COLUMN)
  })
}
