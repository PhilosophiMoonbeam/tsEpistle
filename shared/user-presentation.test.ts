import { describe, expect, it } from '../server/test/bun-test.mts'
import {
  DEFAULT_USER_FONT_FAMILY,
  ProfileAppearanceSchema,
  ProfilePreferencesInputSchema,
  isUserFontFamily,
  normalizeUserFontFamily
} from './user-presentation.ts'

describe('user presentation preferences', () => {
  it('defines the stable default font family', () => {
    expect(DEFAULT_USER_FONT_FAMILY).toBe('blend')
    expect(normalizeUserFontFamily(undefined)).toBe(DEFAULT_USER_FONT_FAMILY)
  })

  it('accepts every supported appearance and font family', () => {
    for (const appearance of ['system', 'light', 'dark']) {
      expect(ProfileAppearanceSchema.safeParse(appearance).success).toBe(true)
    }
    for (const fontFamily of ['blend', 'newsreader', 'roboto-flex']) {
      expect(isUserFontFamily(fontFamily)).toBe(true)
      expect(normalizeUserFontFamily(fontFamily)).toBe(fontFamily)
    }
  })

  it('rejects invalid values and normalizes font families to the default', () => {
    expect(ProfileAppearanceSchema.safeParse('sepia').success).toBe(false)
    expect(isUserFontFamily('comic-sans')).toBe(false)
    expect(isUserFontFamily(null)).toBe(false)
    expect(normalizeUserFontFamily('comic-sans')).toBe(DEFAULT_USER_FONT_FAMILY)
  })

  it('parses a strict, non-empty partial profile-preferences request', () => {
    expect(ProfilePreferencesInputSchema.safeParse({ appearance: 'dark' }).success).toBe(true)
    expect(ProfilePreferencesInputSchema.safeParse({ fontFamily: 'roboto-flex' }).success).toBe(true)
    expect(ProfilePreferencesInputSchema.safeParse({ fontFamily: 'blend' }).success).toBe(true)
    expect(ProfilePreferencesInputSchema.safeParse({ appearance: 'system', fontFamily: 'newsreader' }).success).toBe(true)

    expect(ProfilePreferencesInputSchema.safeParse({}).success).toBe(false)
    expect(ProfilePreferencesInputSchema.safeParse({ fontFamily: undefined }).success).toBe(false)
    expect(ProfilePreferencesInputSchema.safeParse({ appearance: 'sepia' }).success).toBe(false)
    expect(ProfilePreferencesInputSchema.safeParse({ readingGutter: 'none' }).success).toBe(false)
    expect(ProfilePreferencesInputSchema.safeParse({ appearance: 'light', readingGutter: 'none' }).success).toBe(false)
    expect(ProfilePreferencesInputSchema.safeParse({ fontFamily: 'newsreader', extra: true }).success).toBe(false)
  })
})
