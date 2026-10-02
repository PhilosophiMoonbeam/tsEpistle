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
    expect(expired.values.end).toBe('Mar 1, 2026')
  })

  it('reports scheduled windows and hides the chip for ordinary published pages', () => {
    const scheduled = describePageVisibility({ visibility: 'public', isPublished: true, publishStartDate: '2026-04-02', publishEndDate: '2026-05-01' }, now, 'en-US')
    expect(scheduled.state).toBe('scheduled')
    expect(scheduled.summaryKey).toBe('editor:props.visibilityScheduledUntil')
    expect(scheduled.values).toEqual({ start: 'Apr 2, 2026', end: 'May 1, 2026' })

    const until = describePageVisibility({ visibility: 'public', isPublished: true, publishEndDate: '2026-05-01' }, now)
    expect(until.state).toBe('publishedUntil')
    expect(until.chipKey).toBeNull()
    expect(describePageVisibility({ visibility: 'public', isPublished: true, publishStartDate: 'not a date' }, now).state).toBe('published')
  })
})
