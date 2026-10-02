import { describe, expect, it } from '../../server/test/bun-test.mts'
import { formatRevisionTime, friendlyEditorName, translatedParts } from './history-presentation.ts'

describe('history presentation', () => {
  const now = new Date(2026, 2, 10, 18, 0)

  it('shows the time so edits on the same day can be told apart', () => {
    const morning = formatRevisionTime(new Date(2026, 2, 10, 9, 15).toISOString(), now)
    const afternoon = formatRevisionTime(new Date(2026, 2, 10, 14, 2).toISOString(), now)
    expect(morning?.short).toBe('Today at 9:15 AM')
    expect(afternoon?.short).toBe('Today at 2:02 PM')
    expect(formatRevisionTime(new Date(2026, 2, 9, 9, 15).toISOString(), now)?.short).toBe('Yesterday at 9:15 AM')
  })

  it('shows the date and time for older revisions and a full label for assistive text', () => {
    const value = new Date(2025, 11, 3, 9, 15)
    const time = formatRevisionTime(value.toISOString(), now)
    expect(time?.short).toBe('Dec 3, 2025 9:15 AM')
    expect(time?.full).toBe('Wednesday, December 3, 2025 9:15 AM')
    expect(time?.iso).toBe(value.toISOString())
  })

  it('returns no label for a missing or invalid date', () => {
    expect(formatRevisionTime('', now)).toBeNull()
    expect(formatRevisionTime('not a date', now)).toBeNull()
  })

  it('maps editor keys to reader-facing names and hides unknown editors', () => {
    expect(friendlyEditorName('markdown')).toBe('Markdown')
    expect(friendlyEditorName('ckeditor')).toBe('Visual HTML')
    expect(friendlyEditorName('unknown-editor')).toBe('')
    expect(friendlyEditorName('')).toBe('')
  })

  it('splits a translated sentence into text and value parts in translation order', () => {
    const parts = translatedParts(
      values => `Moved from ${values.from} to ${values.to} by ${values.author}`,
      { from: '/old', to: '/new', author: 'Ada <admin>' }
    )
    expect(parts).toEqual([
      { text: 'Moved from ' },
      { text: '/old', value: 'from' },
      { text: ' to ' },
      { text: '/new', value: 'to' },
      { text: ' by ' },
      { text: 'Ada <admin>', value: 'author' }
    ])
    expect(translatedParts(values => `${values.author} edited`, { author: 'Ada' })).toEqual([
      { text: 'Ada', value: 'author' },
      { text: ' edited' }
    ])
  })
})
