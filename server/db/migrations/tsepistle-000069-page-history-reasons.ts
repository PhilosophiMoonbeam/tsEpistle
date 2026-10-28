import type { Knex } from 'knex'

const TABLES = ['pages', 'pageHistory'] as const
const COLUMN = 'changeReason'
const usesPostgres = (knex: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLocaleLowerCase())

const replaceSourceRevisionTrigger = async (knex: Knex, includeReason: boolean): Promise<void> => {
  const columns = [
    'path', 'hash', 'title', 'description', 'visibility', 'ownerId', 'isPublished', 'isSearchable',
    'publishStartDate', 'publishEndDate', 'content', 'contentType', 'editorKey', 'localeCode', 'authorId', 'creatorId',
    ...(includeReason ? [COLUMN] : [])
  ]
  const source = (row: 'NEW' | 'OLD'): string => [...columns.map(column => `${row}."${column}"`), `${row}.extra::text`].join(', ')
  await knex.raw(`
    CREATE OR REPLACE FUNCTION wiki_increment_page_source_revision() RETURNS trigger AS $$
    BEGIN
      IF ROW(${source('NEW')}) IS DISTINCT FROM ROW(${source('OLD')}) THEN
        NEW."sourceRevision" := OLD."sourceRevision" + 1;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)
}

export const up = async (knex: Knex): Promise<void> => {
  for (const tableName of TABLES) {
    if (!(await knex.schema.hasTable(tableName)) || (await knex.schema.hasColumn(tableName, COLUMN))) continue
    await knex.schema.alterTable(tableName, table => {
      table.string(COLUMN, 200).nullable()
    })
  }
  if (usesPostgres(knex) && (await knex.schema.hasTable('pages')) && (await knex.schema.hasColumn('pages', 'sourceRevision'))) {
    await replaceSourceRevisionTrigger(knex, true)
  }
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    const existing: string[] = []
    for (const tableName of TABLES) {
      if (!(await transaction.schema.hasTable(tableName)) || !(await transaction.schema.hasColumn(tableName, COLUMN))) continue
      if (usesPostgres(transaction)) await transaction.raw(`LOCK TABLE "${tableName}" IN SHARE ROW EXCLUSIVE MODE`)
      existing.push(tableName)
    }
    for (const tableName of existing) {
      if (await transaction(tableName).whereNotNull(COLUMN).first()) {
        throw new Error('Cannot roll down page history reasons while saved reasons exist. Preserve them and apply a forward fix or restore a compatible database backup.')
      }
    }
    if (usesPostgres(transaction) && existing.includes('pages') && (await transaction.schema.hasColumn('pages', 'sourceRevision'))) {
      await replaceSourceRevisionTrigger(transaction, false)
    }
    for (const tableName of existing) {
      await transaction.schema.alterTable(tableName, table => {
        table.dropColumn(COLUMN)
      })
    }
  })
}
