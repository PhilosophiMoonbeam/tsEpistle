import { z } from 'zod'

export const PROFILE_APPEARANCE_VALUES = ['system', 'light', 'dark'] as const
export const USER_FONT_FAMILY_VALUES = ['blend', 'newsreader', 'roboto-flex'] as const

export const DEFAULT_USER_FONT_FAMILY = 'blend' as const

export const ProfileAppearanceSchema = z.enum(PROFILE_APPEARANCE_VALUES)
export const UserFontFamilySchema = z.enum(USER_FONT_FAMILY_VALUES)

export type ProfileAppearance = z.infer<typeof ProfileAppearanceSchema>
export type UserFontFamily = z.infer<typeof UserFontFamilySchema>

export const isUserFontFamily = (value: unknown): value is UserFontFamily => UserFontFamilySchema.safeParse(value).success

export const normalizeUserFontFamily = (value: unknown): UserFontFamily => {
  const result = UserFontFamilySchema.safeParse(value)
  return result.success ? result.data : DEFAULT_USER_FONT_FAMILY
}

export const ProfilePreferencesInputSchema = z
  .object({
    appearance: ProfileAppearanceSchema,
    fontFamily: UserFontFamilySchema
  })
  .strict()
  .partial()
  .refine(value => Object.values(value).some(field => field !== undefined), { message: 'At least one profile preference is required.' })

export type ProfilePreferencesInput = z.infer<typeof ProfilePreferencesInputSchema>
