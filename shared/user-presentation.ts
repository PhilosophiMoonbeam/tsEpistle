import { z } from 'zod'
import { DEFAULT_PAGE_GUTTER_STYLE, PAGE_GUTTER_STYLES, type PageGutterStyle, normalizePageGutterCustomCss, normalizePageGutterStyle } from './page-gutters.ts'

export const PROFILE_APPEARANCE_VALUES = ['system', 'light', 'dark'] as const
export const USER_FONT_FAMILY_VALUES = ['newsreader', 'roboto-flex'] as const
export const USER_READING_GUTTER_VALUES = PAGE_GUTTER_STYLES

export const DEFAULT_USER_FONT_FAMILY = 'roboto-flex' as const
export const DEFAULT_USER_READING_GUTTER = DEFAULT_PAGE_GUTTER_STYLE

export const ProfileAppearanceSchema = z.enum(PROFILE_APPEARANCE_VALUES)
export const UserFontFamilySchema = z.enum(USER_FONT_FAMILY_VALUES)
export const UserReadingGutterSchema = z.enum(USER_READING_GUTTER_VALUES)

export type ProfileAppearance = z.infer<typeof ProfileAppearanceSchema>
export type UserFontFamily = z.infer<typeof UserFontFamilySchema>
export type UserReadingGutter = z.infer<typeof UserReadingGutterSchema>

export const isUserFontFamily = (value: unknown): value is UserFontFamily => UserFontFamilySchema.safeParse(value).success

export const normalizeUserFontFamily = (value: unknown): UserFontFamily => {
  const result = UserFontFamilySchema.safeParse(value)
  return result.success ? result.data : DEFAULT_USER_FONT_FAMILY
}

export const isUserReadingGutter = (value: unknown): value is UserReadingGutter => UserReadingGutterSchema.safeParse(value).success

export const normalizeUserReadingGutter = (value: unknown): UserReadingGutter => {
  const result = UserReadingGutterSchema.safeParse(value)
  return result.success ? result.data : DEFAULT_USER_READING_GUTTER
}

export const ProfilePreferencesInputSchema = z
  .object({
    appearance: ProfileAppearanceSchema,
    fontFamily: UserFontFamilySchema,
    readingGutter: UserReadingGutterSchema
  })
  .strict()
  .partial()
  .refine(value => Object.values(value).some(field => field !== undefined), { message: 'At least one profile preference is required.' })

export type ProfilePreferencesInput = z.infer<typeof ProfilePreferencesInputSchema>

export const isAdminCustomGutterAvailable = (customCss: unknown): boolean => normalizePageGutterCustomCss(customCss).length > 0

export const resolveUserReadingGutter = (userPreference: unknown, siteGutter: unknown, customCss: unknown): PageGutterStyle => {
  const normalizedSiteGutter = normalizePageGutterStyle(siteGutter)
  const result = UserReadingGutterSchema.safeParse(userPreference)

  if (!result.success) return normalizedSiteGutter
  if (result.data === 'custom' && !isAdminCustomGutterAvailable(customCss)) return normalizedSiteGutter
  return result.data
}
