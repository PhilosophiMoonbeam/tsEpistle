import { describe, expect, it } from 'vitest'

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
    [null, 'Site banner must be an object.'],
    [{ isEnabled: 'yes', title: '', content: '' }, 'Site banner enabled flag must be a boolean.'],
    [{ isEnabled: false, title: 'line one\nline two', content: '' }, 'Site banner title must be a single line.'],
    [{ isEnabled: false, title: 'x'.repeat(SITE_BANNER_TITLE_LIMIT + 1), content: '' }, `Site banner title cannot exceed ${SITE_BANNER_TITLE_LIMIT} characters.`],
    [{ isEnabled: false, title: '', content: 'x'.repeat(SITE_BANNER_CONTENT_LIMIT + 1) }, `Site banner content cannot exceed ${SITE_BANNER_CONTENT_LIMIT} characters.`],
    [{ isEnabled: true, title: ' ', content: ' ' }, 'An enabled site banner must have a title or content.'],
    [{ isEnabled: false, title: '', content: '', typo: true }, 'Site banner contains unsupported fields.']
  ])('rejects invalid configuration %#', (input, message) => {
    expect(validateSiteBanner(input)).toEqual({ ok: false, message })
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
