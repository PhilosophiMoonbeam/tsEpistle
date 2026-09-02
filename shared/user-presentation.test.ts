import { describe, expect, it } from '../server/test/bun-test.mts'
import {
  DEFAULT_USER_FONT_FAMILY,
  DEFAULT_USER_READING_GUTTER,
  PROFILE_APPEARANCE_VALUES,
  ProfileAppearanceSchema,
  ProfilePreferencesInputSchema,
  USER_FONT_FAMILY_VALUES,
  USER_READING_GUTTER_VALUES,
  isAdminCustomGutterAvailable,
  isUserFontFamily,
  isUserReadingGutter,
  normalizeUserFontFamily,
  normalizeUserReadingGutter,
  resolveUserReadingGutter
} from './user-presentation.ts'

describe('user presentation preferences', () => {
  it('defines stable defaults for new user preferences', () => {
    expect(DEFAULT_USER_FONT_FAMILY).toBe('newsreader')
    expect(DEFAULT_USER_READING_GUTTER).toBe('site')
    expect(normalizeUserFontFamily(undefined)).toBe(DEFAULT_USER_FONT_FAMILY)
    expect(normalizeUserReadingGutter(undefined)).toBe(DEFAULT_USER_READING_GUTTER)
  })

  it('accepts every supported appearance, font family, and reading gutter', () => {
    for (const appearance of PROFILE_APPEARANCE_VALUES) {
      expect(ProfileAppearanceSchema.safeParse(appearance).success).toBe(true)
    }
    for (const fontFamily of USER_FONT_FAMILY_VALUES) {
      expect(isUserFontFamily(fontFamily)).toBe(true)
      expect(normalizeUserFontFamily(fontFamily)).toBe(fontFamily)
    }
    for (const readingGutter of USER_READING_GUTTER_VALUES) {
      expect(isUserReadingGutter(readingGutter)).toBe(true)
      expect(normalizeUserReadingGutter(readingGutter)).toBe(readingGutter)
    }
  })

  it('rejects invalid preference values and normalizes them to defaults', () => {
    expect(ProfileAppearanceSchema.safeParse('sepia').success).toBe(false)
    expect(isUserFontFamily('comic-sans')).toBe(false)
    expect(isUserFontFamily(null)).toBe(false)
    expect(normalizeUserFontFamily('comic-sans')).toBe(DEFAULT_USER_FONT_FAMILY)
    expect(isUserReadingGutter('marble')).toBe(false)
    expect(isUserReadingGutter(null)).toBe(false)
    expect(normalizeUserReadingGutter('marble')).toBe(DEFAULT_USER_READING_GUTTER)
  })

  it('parses a strict, non-empty partial profile-preferences request', () => {
    expect(ProfilePreferencesInputSchema.safeParse({ appearance: 'dark' }).success).toBe(true)
    expect(ProfilePreferencesInputSchema.safeParse({ fontFamily: 'roboto-flex' }).success).toBe(true)
    expect(ProfilePreferencesInputSchema.safeParse({ readingGutter: 'orbits' }).success).toBe(true)
    expect(
      ProfilePreferencesInputSchema.safeParse({
        appearance: 'system',
        fontFamily: 'newsreader',
        readingGutter: 'site'
      }).success
    ).toBe(true)

    expect(ProfilePreferencesInputSchema.safeParse({}).success).toBe(false)
    expect(ProfilePreferencesInputSchema.safeParse({ fontFamily: undefined }).success).toBe(false)
    expect(ProfilePreferencesInputSchema.safeParse({ appearance: 'sepia' }).success).toBe(false)
    expect(ProfilePreferencesInputSchema.safeParse({ fontFamily: 'newsreader', extra: true }).success).toBe(false)
  })

  it('keeps an explicit none reading gutter effective', () => {
    expect(resolveUserReadingGutter('none', 'columns', '')).toBe('none')
  })

  it('inherits the normalized site gutter for site, missing, and invalid preferences', () => {
    expect(resolveUserReadingGutter('site', 'aurora', '')).toBe('aurora')
    expect(resolveUserReadingGutter(undefined, 'laurel', '')).toBe('laurel')
    expect(resolveUserReadingGutter('marble', 'orbits', '')).toBe('orbits')
    expect(resolveUserReadingGutter('site', 'marble', '')).toBe('columns')
  })

  it('enables a custom user gutter only for configured normalized admin CSS', () => {
    expect(isAdminCustomGutterAvailable('  background: linear-gradient(red, blue);  ')).toBe(true)
    expect(resolveUserReadingGutter('custom', 'columns', '  background: linear-gradient(red, blue);  ')).toBe('custom')
  })

  it('falls back to the site gutter for stale or invalid custom CSS', () => {
    expect(isAdminCustomGutterAvailable('   ')).toBe(false)
    expect(isAdminCustomGutterAvailable('.page { display: none; }')).toBe(false)
    expect(resolveUserReadingGutter('custom', 'laurel', '   ')).toBe('laurel')
    expect(resolveUserReadingGutter('custom', 'aurora', '.page { display: none; }')).toBe('aurora')
  })
})
