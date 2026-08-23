import { describe, expect, it } from 'vitest'
import {
  assertVisualMarkdownCompatible,
  findVisualMarkdownIssue,
  findVisualMarkdownIssues,
  inspectVisualMarkdownCapabilities
} from './visual-markdown.ts'

const visualSafeGfm = `# Visual-safe GFM

Paragraph with **bold**, *italic*, ~~strikethrough~~, \`inline code\`, and [a link](/en/docs).

---

> A blockquote.

1. First
   1. Nested
2. Second

- [x] Done
- [ ] Pending

\`\`\`typescript
const html = '<section>{.not-an-attribute}</section>'
\`\`\`

| Name | Value |
| --- | --- |
| Alpha | One |

![Alternative text](/assets/example.png)
`

const unsupportedFixtures = [
  ['attributes', '## Callout\n{.is-info}'],
  ['html', '<section>Raw HTML</section>'],
  ['footnote', 'Text with a footnote[^1].\n\n[^1]: Note'],
  ['abbreviation', '*[HTML]: Hyper Text Markup Language'],
  ['image-size', '![Image](/image.png =100x200)'],
  ['math', 'Inline $x + y$ math'],
  ['multiline-table', '| value ^^ |'],
] as const

describe('Visual Markdown compatibility', () => {
  it('accepts the complete visual-safe GFM fixture', () => {
    expect(findVisualMarkdownIssue(visualSafeGfm)).toBeNull()
    expect(() => assertVisualMarkdownCompatible(visualSafeGfm)).not.toThrow()
  })
  it('accepts source-editor formatting and diagram constructs with visual representations', () => {
    const markdown = [
      'This is ==marked== text with H~2~O, x^2^, and <kbd>Ctrl</kbd>.',
      '',
      'Term',
      ': Definition',
      '',
      '```mermaid',
      'graph TD',
      'A --> B',
      '```'
    ].join('\n')
    expect(inspectVisualMarkdownCapabilities(markdown)).toMatchObject({
      compatible: true,
      sourceEditorRequired: false
    })
  })


  it.each(unsupportedFixtures)('rejects unsupported %s syntax without changing the input', (kind, markdown) => {
    const original = markdown
    expect(findVisualMarkdownIssue(markdown)).toMatchObject({ kind })
    expect(() => assertVisualMarkdownCompatible(markdown)).toThrow(/Markdown source editor/)
    expect(markdown).toBe(original)
  })

  it('reports every unsupported capability while preserving source fallback', () => {
    const markdown = 'Inline $x$ math.\n\nFootnote[^1].'
    const report = inspectVisualMarkdownCapabilities(markdown)

    expect(findVisualMarkdownIssues(markdown).map(issue => issue.kind)).toEqual(['math', 'footnote'])
    expect(report).toMatchObject({
      compatible: false,
      sourceEditorRequired: true
    })
    expect(report.issues).toHaveLength(2)
  })

  it('does not inspect extended syntax inside fenced or inline code', () => {
    const markdown = 'Use `<kbd>{.key}</kbd>` literally.\n\n```html\n<div>{.example}</div>\n```'
    expect(findVisualMarkdownIssue(markdown)).toBeNull()
  })

  it('does not mistake GFM autolinks for raw HTML', () => {
    expect(findVisualMarkdownIssue('Visit <https://example.com> or <docs@example.com>.')).toBeNull()
  })
})
