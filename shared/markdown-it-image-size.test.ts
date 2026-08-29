import { describe, expect, it } from '../server/test/bun-test.mts'
import MarkdownIt from 'markdown-it'
import markdownItImageSize from './markdown-it-image-size'

const render = (source: string): string => new MarkdownIt().use(markdownItImageSize).renderInline(source)

describe('markdown image dimensions', () => {
  it('renders explicit pixel dimensions without Node file access', () => {
    expect(render('![diagram](/assets/diagram.png =640x480)')).toBe(
      '<img src="/assets/diagram.png" alt="diagram" width="640" height="480">'
    )
  })

  it('supports percentage and one-sided dimensions', () => {
    expect(render('![wide](/assets/wide.png =100%x)')).toBe(
      '<img src="/assets/wide.png" alt="wide" width="100%">'
    )
  })

  it('rejects malformed percentage dimensions', () => {
    expect(render('![wide](/assets/wide.png =100%%x20)')).not.toContain('width=')
  })

  it('preserves ordinary Markdown image behavior', () => {
    expect(render('![logo](/logo.svg "Wiki")')).toBe(
      '<img src="/logo.svg" alt="logo" title="Wiki">'
    )
  })
})
