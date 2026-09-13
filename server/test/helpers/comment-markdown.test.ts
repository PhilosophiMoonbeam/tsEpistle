import { describe, expect, it } from '../bun-test.mts'
import { commentMentionHandles, renderCommentMarkdown } from '../../helpers/comment-markdown.ts'

describe('comment mention rendering', () => {
  it('highlights only allowed prose mentions outside code, links, email and paths', () => {
    const source = '@alice plain; user@alice.example email; docs/@alice path; `@alice` code; [@alice](https://example.invalid); @unknown\n\n```text\n@alice\n```'
    const rendered = renderCommentMarkdown(source, new Set(['alice']))

    expect(rendered.match(/class="comment-mention"/g)).toHaveLength(1)
    expect(rendered).toContain('<span class="comment-mention">@alice</span> plain')
    expect(rendered).toContain('<code>@alice</code>')
    expect(rendered).toContain('href="https://example.invalid"')
    expect(rendered).toContain('@unknown')
    expect(commentMentionHandles(source)).toEqual(['alice', 'unknown'])
  })

  it('sanitizes source HTML while preserving generated mention markup', () => {
    const rendered = renderCommentMarkdown('<img src=x onerror=alert(1)> @alice', new Set(['alice']))
    expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(rendered).not.toContain('<img src=')
    expect(rendered).toContain('<span class="comment-mention">@alice</span>')
  })
})
