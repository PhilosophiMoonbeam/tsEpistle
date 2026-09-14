import { z } from 'zod'

export const PROFILE_APPEARANCE_VALUES = ['system', 'light', 'dark'] as const
export const USER_FONT_FAMILY_VALUES = ['blend', 'newsreader', 'roboto-flex'] as const
export const USER_TIME_FORMAT_VALUES = ['locale', '12h', '24h'] as const

export const DEFAULT_USER_FONT_FAMILY = 'blend' as const
export const DEFAULT_USER_TIMEZONE = 'UTC' as const
export const DEFAULT_USER_DATE_FORMAT = '' as const
export const DEFAULT_USER_TIME_FORMAT = 'locale' as const

export const ProfileAppearanceSchema = z.enum(PROFILE_APPEARANCE_VALUES)
export const UserFontFamilySchema = z.enum(USER_FONT_FAMILY_VALUES)
export const UserTimeFormatSchema = z.enum(USER_TIME_FORMAT_VALUES)

export type ProfileAppearance = z.infer<typeof ProfileAppearanceSchema>
export type UserFontFamily = z.infer<typeof UserFontFamilySchema>
export type UserTimeFormat = z.infer<typeof UserTimeFormatSchema>

export interface UserPresentationDefaults {
  timezone: string
  dateFormat: string
  timeFormat: UserTimeFormat
}

export const userPresentationDefaults: UserPresentationDefaults = {
  timezone: DEFAULT_USER_TIMEZONE,
  dateFormat: DEFAULT_USER_DATE_FORMAT,
  timeFormat: DEFAULT_USER_TIME_FORMAT
}

export const isUserTimezone = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const isUserDateFormat = (value: unknown): value is string =>
  typeof value === 'string' && ['', 'DD/MM/YYYY', 'DD.MM.YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'YYYY/MM/DD'].includes(value)

export const isUserTimeFormat = (value: unknown): value is UserTimeFormat => UserTimeFormatSchema.safeParse(value).success

export const normalizeUserPresentationDefaults = (value: unknown): UserPresentationDefaults => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...userPresentationDefaults }
  const record = value as Record<string, unknown>
  return {
    timezone: isUserTimezone(record.timezone) ? record.timezone : DEFAULT_USER_TIMEZONE,
    dateFormat: isUserDateFormat(record.dateFormat) ? record.dateFormat : DEFAULT_USER_DATE_FORMAT,
    timeFormat: isUserTimeFormat(record.timeFormat) ? record.timeFormat : DEFAULT_USER_TIME_FORMAT
  }
}

export const isUserFontFamily = (value: unknown): value is UserFontFamily => UserFontFamilySchema.safeParse(value).success

export const normalizeUserFontFamily = (value: unknown): UserFontFamily => {
  const result = UserFontFamilySchema.safeParse(value)
  return result.success ? result.data : DEFAULT_USER_FONT_FAMILY
}

export const ProfilePreferencesInputSchema = z
  .object({
    appearance: ProfileAppearanceSchema,
    fontFamily: UserFontFamilySchema,
    timeFormat: UserTimeFormatSchema
  })
  .strict()
  .partial()
  .refine(value => Object.values(value).some(field => field !== undefined), { message: 'At least one profile preference is required.' })

export type ProfilePreferencesInput = z.infer<typeof ProfilePreferencesInputSchema>
