import type { Knex } from 'knex'

const PAGE_TABLE = 'pages'
const HISTORY_TABLE = 'pageHistory'
const SEARCHABILITY_COLUMN = 'isSearchable'
const SOURCE_REVISION_COLUMN = 'sourceRevision'
const TRIGGER_NAME = 'pages_source_revision_trigger'
const TRIGGER_FUNCTION = 'wiki_increment_page_source_revision'
const ROLLBACK_ERROR =
  'Cannot roll down page search inclusion migration while searchability preferences exist. Preserve them and apply a forward fix or restore a compatible database backup.'

const usesPostgres = (knex: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLocaleLowerCase())

const lockTableForRollback = async (knex: Knex, tableName: string): Promise<void> => {
  if (usesPostgres(knex)) await knex.raw(`LOCK TABLE "${tableName}" IN SHARE ROW EXCLUSIVE MODE`)
}

const hasFalseSearchability = async (knex: Knex, tableName: string): Promise<boolean> => {
  if (!(await knex.schema.hasTable(tableName)) || !(await knex.schema.hasColumn(tableName, SEARCHABILITY_COLUMN))) return false
  return Boolean(await knex(tableName).where(SEARCHABILITY_COLUMN, false).first())
}

const ensureSearchabilityColumn = async (knex: Knex, tableName: string): Promise<void> => {
  if (!(await knex.schema.hasTable(tableName)) || (await knex.schema.hasColumn(tableName, SEARCHABILITY_COLUMN))) return
  await knex.schema.alterTable(tableName, table => {
    table.boolean(SEARCHABILITY_COLUMN).notNullable().defaultTo(true)
  })
}

const replaceSourceRevisionTrigger = async (knex: Knex, includeSearchability: boolean): Promise<void> => {
  const pageColumns = [
    'NEW.path',
    'NEW.hash',
    'NEW.title',
    'NEW.description',
    'NEW.visibility',
    'NEW."ownerId"',
    'NEW."isPublished"',
    ...(includeSearchability ? ['NEW."isSearchable"'] : []),
    'NEW."publishStartDate"',
    'NEW."publishEndDate"',
    'NEW.content',
    'NEW."contentType"',
    'NEW."editorKey"',
    'NEW."localeCode"',
    'NEW."authorId"',
    'NEW."creatorId"',
    'NEW.extra::text'
  ].join(', ')
  const oldColumns = [
    'OLD.path',
    'OLD.hash',
    'OLD.title',
    'OLD.description',
    'OLD.visibility',
    'OLD."ownerId"',
    'OLD."isPublished"',
    ...(includeSearchability ? ['OLD."isSearchable"'] : []),
    'OLD."publishStartDate"',
    'OLD."publishEndDate"',
    'OLD.content',
    'OLD."contentType"',
    'OLD."editorKey"',
    'OLD."localeCode"',
    'OLD."authorId"',
    'OLD."creatorId"',
    'OLD.extra::text'
  ].join(', ')
  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${TRIGGER_FUNCTION}() RETURNS trigger AS $$
    BEGIN
      IF ROW(${pageColumns}) IS DISTINCT FROM ROW(${oldColumns}) THEN
        NEW."${SOURCE_REVISION_COLUMN}" := OLD."${SOURCE_REVISION_COLUMN}" + 1;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)
  await knex.raw(`DROP TRIGGER IF EXISTS "${TRIGGER_NAME}" ON "${PAGE_TABLE}"`)
  await knex.raw(`CREATE TRIGGER "${TRIGGER_NAME}" BEFORE UPDATE ON "${PAGE_TABLE}" FOR EACH ROW EXECUTE FUNCTION ${TRIGGER_FUNCTION}()`)
}

export const up = async (knex: Knex): Promise<void> => {
  await ensureSearchabilityColumn(knex, PAGE_TABLE)
  await ensureSearchabilityColumn(knex, HISTORY_TABLE)
  if (usesPostgres(knex) && (await knex.schema.hasTable(PAGE_TABLE)) && (await knex.schema.hasColumn(PAGE_TABLE, SOURCE_REVISION_COLUMN))) {
    await replaceSourceRevisionTrigger(knex, true)
  }
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    const existingTables: string[] = []
    for (const tableName of [PAGE_TABLE, HISTORY_TABLE]) {
      if (await transaction.schema.hasTable(tableName)) existingTables.push(tableName)
    }

    for (const tableName of existingTables) await lockTableForRollback(transaction, tableName)

    for (const tableName of [PAGE_TABLE, HISTORY_TABLE]) {
      if (await hasFalseSearchability(transaction, tableName)) throw new Error(ROLLBACK_ERROR)
    }

    if (
      usesPostgres(transaction) &&
      (await transaction.schema.hasTable(PAGE_TABLE)) &&
      (await transaction.schema.hasColumn(PAGE_TABLE, SOURCE_REVISION_COLUMN))
    ) {
      await replaceSourceRevisionTrigger(transaction, false)
    }
    if ((await transaction.schema.hasTable(HISTORY_TABLE)) && (await transaction.schema.hasColumn(HISTORY_TABLE, SEARCHABILITY_COLUMN))) {
      await transaction.schema.alterTable(HISTORY_TABLE, table => {
        table.dropColumn(SEARCHABILITY_COLUMN)
      })
    }
    if ((await transaction.schema.hasTable(PAGE_TABLE)) && (await transaction.schema.hasColumn(PAGE_TABLE, SEARCHABILITY_COLUMN))) {
      await transaction.schema.alterTable(PAGE_TABLE, table => {
        table.dropColumn(SEARCHABILITY_COLUMN)
      })
    }
  })
}
