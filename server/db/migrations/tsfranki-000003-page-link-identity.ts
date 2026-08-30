import type { Knex } from 'knex'

const PAGE_LINK_IDENTITY_INDEX = 'page_links_page_locale_path_unique'

export const up = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    await transaction.raw('LOCK TABLE "pageLinks" IN SHARE ROW EXCLUSIVE MODE')
    await transaction.raw(`
      DELETE FROM "pageLinks" AS duplicate
      USING "pageLinks" AS canonical
      WHERE duplicate.id > canonical.id
        AND duplicate."pageId" IS NOT DISTINCT FROM canonical."pageId"
        AND duplicate."localeCode" IS NOT DISTINCT FROM canonical."localeCode"
        AND duplicate.path IS NOT DISTINCT FROM canonical.path
    `)
    await transaction.raw(`
      CREATE UNIQUE INDEX ${PAGE_LINK_IDENTITY_INDEX}
      ON "pageLinks" ("pageId", "localeCode", path) NULLS NOT DISTINCT
    `)
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.raw(`DROP INDEX IF EXISTS ${PAGE_LINK_IDENTITY_INDEX}`)
}
