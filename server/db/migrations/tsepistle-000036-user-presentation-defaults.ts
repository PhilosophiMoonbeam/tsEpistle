import type { Knex } from 'knex'

import { userPresentationDefaults, normalizeUserPresentationDefaults } from '../../../shared/user-presentation.ts'

const USERS_TABLE = 'users'
const SETTINGS_TABLE = 'settings'
const SETTINGS_KEY = 'userDefaults'
const TIME_FORMAT_CHECK = 'users_time_format_check'

type SettingRow = { value: unknown }

const isPostgres = (knex: Knex): boolean => ['pg', 'postgres', 'postgresql'].includes(String(knex.client.config.client).toLowerCase())

const parseSetting = (value: unknown): Record<string, unknown> => {
  let parsed = value
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown
    } catch {
      return {}
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const record = parsed as Record<string, unknown>
  const wrapped = record.v
  if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) return wrapped as Record<string, unknown>
  return record
}

const canonicalDefaults = JSON.stringify(userPresentationDefaults)

export const up = async (knex: Knex): Promise<void> => {
  if ((await knex.schema.hasTable(USERS_TABLE)) && !(await knex.schema.hasColumn(USERS_TABLE, 'timeFormat'))) {
    await knex.schema.alterTable(USERS_TABLE, table => {
      table.string('timeFormat', 16).notNullable().defaultTo(userPresentationDefaults.timeFormat)
    })
    if (isPostgres(knex)) await knex.raw(`ALTER TABLE "${USERS_TABLE}" ADD CONSTRAINT "${TIME_FORMAT_CHECK}" CHECK ("timeFormat" IN ('locale', '12h', '24h'))`)
  }

  if (!(await knex.schema.hasTable(SETTINGS_TABLE))) return
  const existing = await knex<SettingRow>(SETTINGS_TABLE).where('key', SETTINGS_KEY).first('value')
  if (existing) return
  const value = JSON.stringify(userPresentationDefaults)
  const setting: Record<string, unknown> = { key: SETTINGS_KEY, value }
  if (await knex.schema.hasColumn(SETTINGS_TABLE, 'updatedAt')) setting.updatedAt = new Date().toISOString()
  await knex(SETTINGS_TABLE).insert(setting)
}

export const down = async (knex: Knex): Promise<void> => {
  if ((await knex.schema.hasTable(USERS_TABLE)) && (await knex.schema.hasColumn(USERS_TABLE, 'timeFormat'))) {
    const customized = await knex(USERS_TABLE).whereNot('timeFormat', userPresentationDefaults.timeFormat).first('id')
    if (customized) throw new Error('Cannot roll down user presentation defaults after a non-locale time format was saved.')
    if (isPostgres(knex)) await knex.raw(`ALTER TABLE "${USERS_TABLE}" DROP CONSTRAINT IF EXISTS "${TIME_FORMAT_CHECK}"`)
    await knex.schema.alterTable(USERS_TABLE, table => {
      table.dropColumn('timeFormat')
    })
  }

  if (!(await knex.schema.hasTable(SETTINGS_TABLE))) return
  const existing = await knex<SettingRow>(SETTINGS_TABLE).where('key', SETTINGS_KEY).first('value')
  if (!existing) return
  const normalized = normalizeUserPresentationDefaults(parseSetting(existing.value))
  if (JSON.stringify(normalized) !== canonicalDefaults || JSON.stringify(parseSetting(existing.value)) !== canonicalDefaults)
    throw new Error('Cannot roll down user presentation defaults after the account default policy changed.')
  await knex(SETTINGS_TABLE).where('key', SETTINGS_KEY).delete()
}
