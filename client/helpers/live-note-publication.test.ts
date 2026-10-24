import { describe, expect, it } from '../../server/test/bun-test.mts'
import { captureNotePublication } from '../../shared/live-note-publication.ts'

describe('note page publication capture', () => {
  it('takes the first real H1, not a fenced example, removes only that heading and leaves canonical asset URLs unchanged', () => {
    const source = '```md\n# Example\n```\n\n# A **real** title\n\n![Photo](/assets/team/photo.png)\n\n# Later heading\nText'
    const capture = captureNotePublication(source, 17)
    expect(capture.revision).toBe(17)
    expect(capture.title).toBe('A real title')
    expect(capture.content).toBe('```md\n# Example\n```\n\n\n![Photo](/assets/team/photo.png)\n\n# Later heading\nText')
    expect(source).toContain('# A **real** title')
  })
  it('supports setext H1 titles and preserves note source when there is no H1', () => {
    expect(captureNotePublication('Title with `code`\n===\n\nBody', 2)).toEqual({ title: 'Title with code', content: 'Body', revision: 2 })
    expect(captureNotePublication('## Smaller title\r\nBody', 0)).toEqual({ title: '', content: '## Smaller title\r\nBody', revision: 0 })
  })
})
