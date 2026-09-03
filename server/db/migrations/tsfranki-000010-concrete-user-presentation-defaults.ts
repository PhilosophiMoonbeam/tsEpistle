import type { Knex } from 'knex'

const USERS_TABLE = 'users'
const SETTINGS_TABLE = 'settings'
const THEMING_SETTINGS_KEY = 'theming'
const DEFAULT_READING_GUTTER = 'columns'

const PAGE_GUTTER_STYLES: Record<string, true> = {
  columns: true,
  orbits: true,
  laurel: true,
  aurora: true,
  none: true,
  custom: true
}

type ThemingSettings = Record<string, unknown> & { gutterStyle?: unknown }

const parseThemingSettings = (value: unknown): ThemingSettings | undefined => {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return undefined
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const unwrapped = record.v
  if (typeof unwrapped === 'object' && unwrapped !== null && !Array.isArray(unwrapped)) {
    return unwrapped as ThemingSettings
  }
  return record
}

export const up = async (knex: Knex): Promise<void> => {
  const theming = await knex<{ key: string; value: unknown }>(SETTINGS_TABLE).where({ key: THEMING_SETTINGS_KEY }).first('value')
  const themingSettings = parseThemingSettings(theming?.value)
  const configuredGutter = themingSettings?.gutterStyle
  const readingGutter = typeof configuredGutter === 'string' && PAGE_GUTTER_STYLES[configuredGutter] ? configuredGutter : DEFAULT_READING_GUTTER

  await knex(USERS_TABLE).where({ fontFamily: 'newsreader' }).update({ fontFamily: 'roboto-flex' })
  await knex(USERS_TABLE).where({ readingGutter: 'site' }).update({ readingGutter })

  await knex.schema.alterTable(USERS_TABLE, table => {
    table.string('fontFamily').notNullable().defaultTo('roboto-flex').alter()
    table.string('readingGutter').notNullable().defaultTo(DEFAULT_READING_GUTTER).alter()
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable(USERS_TABLE, table => {
    table.string('fontFamily').notNullable().defaultTo('newsreader').alter()
    table.string('readingGutter').notNullable().defaultTo('site').alter()
  })
}
