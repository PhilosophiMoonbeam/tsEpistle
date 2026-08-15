import type { Knex } from 'knex'

export const up = async (knex: Knex) => {
  const sqlVersionDate = 'UPDATE "pageHistory" h1 SET "versionDate" = COALESCE((SELECT prev."createdAt" FROM "pageHistory" prev WHERE prev."pageId" = h1."pageId" AND prev.id < h1.id ORDER BY prev.id DESC LIMIT 1), h1."createdAt")'
  await knex.schema
    .alterTable('pageHistory', table => {
      table.string('versionDate').notNullable().defaultTo('')
    })
    .raw(sqlVersionDate)
}

export const down = (knex: Knex) => {
  void knex
}
