import { describe, expect, it } from '../../server/test/bun-test.mts'

import { fallbackLocalizationLabel, localizationCacheVersion } from './localization.ts'

describe('localization fallback labels', () => {
  it('turns missing nested keys into readable labels instead of exposing raw keys', () => {
    expect(fallbackLocalizationLabel('common:header.pageActions')).toBe('Page Actions')
    expect(fallbackLocalizationLabel('admin:security.authTfaUrl')).toBe('Auth 2FA URL')
    expect(fallbackLocalizationLabel('page.editExternal')).toBe('Edit External')
    expect(fallbackLocalizationLabel('')).toBe('Translation unavailable')
  })
})

describe('localization cache version', () => {
  it('invalidates cached translations for each build and locale revision', () => {
    const firstBuild = { revision: 'abc123', date: '2026-09-08T07:30:45.000Z' }
    const secondBuild = { ...firstBuild, date: '2026-09-08T08:00:00.000Z' }

    expect(localizationCacheVersion(firstBuild)).toBe('abc123:2026-09-08T07:30:45.000Z:legacy')
    expect(localizationCacheVersion(secondBuild)).not.toBe(localizationCacheVersion(firstBuild))
    expect(localizationCacheVersion(firstBuild, 'locale-2')).toBe('abc123:2026-09-08T07:30:45.000Z:locale-2')
  })
})
