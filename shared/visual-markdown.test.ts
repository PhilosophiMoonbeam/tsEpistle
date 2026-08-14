import { describe, expect, it } from 'vitest'
import { assertVisualMarkdownCompatible, findVisualMarkdownIssue } from './visual-markdown.ts'

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
  ['highlight', 'This is ==marked== text'],
  ['subscript', 'H~2~O'],
  ['superscript', 'x^2^'],
  ['multiline-table', '| value ^^ |'],
  ['diagram', '```mermaid\ngraph TD\nA --> B\n```']
] as const

describe('Visual Markdown compatibility', () => {
  it('accepts the complete visual-safe GFM fixture', () => {
    expect(findVisualMarkdownIssue(visualSafeGfm)).toBeNull()
    expect(() => assertVisualMarkdownCompatible(visualSafeGfm)).not.toThrow()
  })

  it.each(unsupportedFixtures)('rejects unsupported %s syntax without changing the input', (kind, markdown) => {
    const original = markdown
    expect(findVisualMarkdownIssue(markdown)).toMatchObject({ kind })
    expect(() => assertVisualMarkdownCompatible(markdown)).toThrow(/Markdown source editor/)
    expect(markdown).toBe(original)
  })

  it('does not inspect extended syntax inside fenced or inline code', () => {
    const markdown = 'Use `<kbd>{.key}</kbd>` literally.\n\n```html\n<div>{.example}</div>\n```'
    expect(findVisualMarkdownIssue(markdown)).toBeNull()
  })

  it('does not mistake GFM autolinks for raw HTML', () => {
    expect(findVisualMarkdownIssue('Visit <https://example.com> or <docs@example.com>.')).toBeNull()
  })
})
