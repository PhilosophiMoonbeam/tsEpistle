import { describe, expect, it } from '../../server/test/bun-test.mts'

import { fallbackLocalizationLabel } from './localization.ts'

describe('localization fallback labels', () => {
  it('turns missing nested keys into readable labels instead of exposing raw keys', () => {
    expect(fallbackLocalizationLabel('common:header.pageActions')).toBe('Page Actions')
    expect(fallbackLocalizationLabel('admin:security.authTfaUrl')).toBe('Auth 2FA URL')
    expect(fallbackLocalizationLabel('page.editExternal')).toBe('Edit External')
    expect(fallbackLocalizationLabel('')).toBe('Translation unavailable')
  })
})
