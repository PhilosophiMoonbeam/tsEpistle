import type { Knex } from 'knex'

const USERS_TABLE = 'users'
const SETTINGS_TABLE = 'settings'
const THEMING_SETTINGS_KEY = 'theming'
const DEFAULT_READING_GUTTER = 'columns'
const GUTTER_SETTING_KEYS = ['gutterStyle', 'gutterCustomCss'] as const

type JsonObject = Record<string, unknown>

type ParsedThemingSettings = {
  readonly settings: JsonObject
  readonly wasString: boolean
}

const isJsonObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value)

const parseThemingSettings = (value: unknown): ParsedThemingSettings | null => {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isJsonObject(parsed) ? { settings: parsed, wasString: true } : null
    } catch {
      return null
    }
  }

  return isJsonObject(value) ? { settings: value, wasString: false } : null
}

const withoutGutterSettings = (settings: JsonObject): JsonObject | null => {
  const wrappedSettings = isJsonObject(settings.v) ? settings.v : null
  const hasTopLevelSettings = GUTTER_SETTING_KEYS.some(key => Object.hasOwn(settings, key))
  const hasWrappedSettings = wrappedSettings !== null && GUTTER_SETTING_KEYS.some(key => Object.hasOwn(wrappedSettings, key))
  if (!hasTopLevelSettings && !hasWrappedSettings) return null

  const nextSettings = { ...settings }
  for (const key of GUTTER_SETTING_KEYS) delete nextSettings[key]
  if (wrappedSettings !== null) {
    const nextWrappedSettings = { ...wrappedSettings }
    for (const key of GUTTER_SETTING_KEYS) delete nextWrappedSettings[key]
    nextSettings.v = nextWrappedSettings
  }
  return nextSettings
}

const removePersistedGutterSettings = async (knex: Knex): Promise<void> => {
  const row = await knex<{ key: string; value: unknown }>(SETTINGS_TABLE).where({ key: THEMING_SETTINGS_KEY }).first('value')
  if (!row) return

  const parsed = parseThemingSettings(row.value)
  if (parsed === null) return

  const settings = withoutGutterSettings(parsed.settings)
  if (settings === null) return

  await knex(SETTINGS_TABLE)
    .where({ key: THEMING_SETTINGS_KEY })
    .update({ value: parsed.wasString ? JSON.stringify(settings) : settings })
}

export const up = async (knex: Knex): Promise<void> => {
  await removePersistedGutterSettings(knex)
  await knex.schema.alterTable(USERS_TABLE, table => {
    table.dropColumn('readingGutter')
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.alterTable(USERS_TABLE, table => {
    table.string('readingGutter').notNullable().defaultTo(DEFAULT_READING_GUTTER)
  })
}
