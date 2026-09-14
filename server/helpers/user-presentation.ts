import type { Knex } from 'knex'

import { isUserDateFormat, isUserTimeFormat, isUserTimezone, userPresentationDefaults, type UserPresentationDefaults } from '../../shared/user-presentation.ts'

type SettingRow = { value: unknown }
type PresentationOverrides = Partial<Pick<UserPresentationDefaults, 'timezone' | 'dateFormat' | 'timeFormat'>>

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

const validPresentation = (value: Record<string, unknown>): UserPresentationDefaults | undefined => {
  if (!isUserTimezone(value.timezone) || !isUserDateFormat(value.dateFormat) || !isUserTimeFormat(value.timeFormat)) return undefined
  return {
    timezone: value.timezone,
    dateFormat: value.dateFormat,
    timeFormat: value.timeFormat
  }
}

const fallbackPresentation = (): UserPresentationDefaults => ({ ...userPresentationDefaults })

const readSetting = async (transaction: Knex.Transaction): Promise<UserPresentationDefaults> => {
  // Knex transactions are callable query builders. Keep a safe shared default
  // for non-Knex adapters used by isolated model consumers.
  if (typeof transaction !== 'function') return fallbackPresentation()
  const row = (await transaction('settings').where('key', 'userDefaults').forShare().first('value')) as SettingRow | undefined
  return validPresentation(parseSetting(row?.value)) ?? fallbackPresentation()
}

export const resolveUserPresentation = async (transaction: Knex.Transaction, overrides: PresentationOverrides = {}): Promise<UserPresentationDefaults> => {
  const defaults = await readSetting(transaction)
  const candidate: Record<string, unknown> = {
    timezone: overrides.timezone === undefined ? defaults.timezone : overrides.timezone,
    dateFormat: overrides.dateFormat === undefined ? defaults.dateFormat : overrides.dateFormat,
    timeFormat: overrides.timeFormat === undefined ? defaults.timeFormat : overrides.timeFormat
  }
  return validPresentation(candidate) ?? defaults
}
