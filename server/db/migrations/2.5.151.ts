import type { Knex } from 'knex'

const PAGES = 'pages'
const UNIQUE_RELATION_LOCALE = 'pages_locale_group_locale_unique'

export const up = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(PAGES) || await knex.schema.hasColumn(PAGES, 'localeGroupId')) return
  await knex.schema.alterTable(PAGES, table => {
    table.uuid('localeGroupId').nullable()
    table.unique(['localeGroupId', 'localeCode'], { indexName: UNIQUE_RELATION_LOCALE })
  })
}

export const down = async (knex: Knex): Promise<void> => {
  if (!await knex.schema.hasTable(PAGES) || !await knex.schema.hasColumn(PAGES, 'localeGroupId')) return
  await knex.schema.alterTable(PAGES, table => {
    table.dropUnique(['localeGroupId', 'localeCode'], UNIQUE_RELATION_LOCALE)
    table.dropColumn('localeGroupId')
  })
}
