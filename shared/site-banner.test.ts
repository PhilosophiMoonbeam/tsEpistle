import { describe, expect, it } from '../server/test/bun-test.mts'

import {
  SITE_BANNER_CONTENT_LIMIT,
  SITE_BANNER_TITLE_LIMIT,
  siteBannerOrDefault,
  validateSiteBanner
} from './site-banner.ts'

describe('site banner configuration', () => {
  it('normalizes valid banner text without changing markdown', () => {
    expect(validateSiteBanner({
      isEnabled: true,
      title: ' Maintenance notice ',
      content: ' **Read the [status](https://status.example.com).**\n '
    })).toEqual({
      ok: true,
      value: {
        isEnabled: true,
        title: 'Maintenance notice',
        content: '**Read the [status](https://status.example.com).**'
      }
    })
  })

  it.each([
    [null],
    [{ isEnabled: 'yes', title: '', content: '' }],
    [{ isEnabled: false, title: 'line one\nline two', content: '' }],
    [{ isEnabled: false, title: 'x'.repeat(SITE_BANNER_TITLE_LIMIT + 1), content: '' }],
    [{ isEnabled: false, title: '', content: 'x'.repeat(SITE_BANNER_CONTENT_LIMIT + 1) }],
    [{ isEnabled: true, title: ' ', content: ' ' }],
    [{ isEnabled: false, title: '', content: '', typo: true }]
  ])('rejects invalid configuration %#', (input) => {
    expect(validateSiteBanner(input).ok).toBe(false)
  })

  it('fails closed when persisted configuration is absent or malformed', () => {
    expect(siteBannerOrDefault(undefined)).toEqual({ isEnabled: false, title: '', content: '' })
    expect(siteBannerOrDefault({ isEnabled: true, title: '', content: '' })).toEqual({
      isEnabled: false,
      title: '',
      content: ''
    })
  })
})

describe('announcement publication window', () => {
  it('preserves legacy banners while validating schedule boundaries', async () => {
    const { siteBannerState, publicSiteBanner } = await import('./site-banner.ts')
    const legacyBanner = { isEnabled: true, title: 'Maintenance', content: 'Unscheduled work' }
    expect(publicSiteBanner(legacyBanner, Date.parse('2026-09-07T10:00:00Z'))).toEqual(legacyBanner)
    const banner = { isEnabled: true, title: 'Maintenance', content: 'Scheduled work', tone: 'info' as const, startsAt: '2026-09-07T10:00:00Z', endsAt: '2026-09-07T11:00:00Z' }
    expect(validateSiteBanner(banner).ok).toBe(true)
    expect(siteBannerState(banner, Date.parse(banner.startsAt) - 1)).toBe('scheduled')
    expect(publicSiteBanner(banner, Date.parse(banner.startsAt) - 1)).toEqual({ isEnabled: false, title: '', content: '' })
    expect(publicSiteBanner(banner, Date.parse(banner.startsAt))).toEqual(banner)
    expect(siteBannerState(banner, Date.parse(banner.endsAt))).toBe('ended')
    expect(publicSiteBanner(banner, Date.parse(banner.endsAt))).toEqual({ isEnabled: false, title: '', content: '' })
    for (const patch of [{ startsAt: '2026-02-30T10:00:00Z' }, { endsAt: banner.startsAt }, { startsAt: 'tomorrow' }, { startsAt: 123 }, { tone: 'urgent' }]) {
      expect(validateSiteBanner({ ...banner, ...patch }).ok).toBe(false)
    }
  })
})
