import { describe, expect, it } from '../server/test/bun-test.mts'
import {
  DEFAULT_USER_FONT_FAMILY,
  ProfileAppearanceSchema,
  isUserFontFamily,
  normalizeUserFontFamily
} from './user-presentation.ts'

describe('user presentation preferences', () => {
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

})
