import { describe, expect, it } from '../../../../server/test/bun-test.mts'
import { describePageVisibility } from './page-visibility.ts'

const now = new Date('2026-03-10T12:00:00Z')

describe('page visibility summary', () => {
  it('puts private before publishing state', () => {
    const summary = describePageVisibility({ visibility: 'private', isPublished: false }, now)
    expect(summary.state).toBe('private')
    expect(summary.chipKey).toBe('editor:props.visibilityChipPrivate')
  })

  it('treats unpublished and expired pages as editor-only, like the reader check', () => {
    expect(describePageVisibility({ visibility: 'public', isPublished: false }, now).state).toBe('unpublished')
    const expired = describePageVisibility({ visibility: 'public', isPublished: true, publishEndDate: '2026-03-01' }, now, 'en-US')
    expect(expired.state).toBe('expired')
  })

  it('reports scheduled windows and hides the chip for ordinary published pages', () => {
    const scheduled = describePageVisibility(
      { visibility: 'public', isPublished: true, publishStartDate: '2026-04-02', publishEndDate: '2026-05-01' },
      now,
      'en-US'
    )
    expect(scheduled.state).toBe('scheduled')
    expect(scheduled.summaryKey).toBe('editor:props.visibilityScheduledUntil')

    const until = describePageVisibility({ visibility: 'public', isPublished: true, publishEndDate: '2026-05-01' }, now)
    expect(until.state).toBe('publishedUntil')
    expect(until.chipKey).toBeNull()
    expect(describePageVisibility({ visibility: 'public', isPublished: true, publishStartDate: '', publishEndDate: '' }, now).state).toBe('published')
    expect(describePageVisibility({ visibility: 'public', isPublished: true, publishStartDate: '2024-02-29T12:00:00+05:30' }, now).state).toBe('published')
  })

  it.each(['2020-02-30T00:00:00Z', '0000-01-01T00:00:00Z', '2020-01-01T24:00:00Z', '2020-01-01T00:00:00+14:01', 'not a date'])(
    'does not describe an invalid provided boundary as published: %s',
    boundary => {
      const page = { visibility: 'public', isPublished: true }
      expect(describePageVisibility({ ...page, publishStartDate: boundary }, now).state).toBe('unpublished')
      expect(describePageVisibility({ ...page, publishEndDate: boundary }, now).state).toBe('unpublished')
      expect(describePageVisibility({ ...page, visibility: 'private', publishStartDate: boundary }, now).state).toBe('private')
    }
  )
})
