import { describe, expect, it } from 'vitest'

import { parseMarkdownCodeFenceInfo, renderMarkdownCodeFence } from './markdown-code-fence.ts'

describe('Markdown code fences', () => {
  it('parses, normalizes and merges supported fence metadata', () => {
    expect(parseMarkdownCodeFenceInfo(
      'TypeScript title="Say \\"hello\\"" linesStart="30" linesHighlight="35, 31-33, 33-34, nope, 40-38"',
      value => value.replaceAll('\\"', '"')
    )).toEqual({
      language: 'TypeScript',
      title: 'Say "hello"',
      lineStart: 30,
      lineHighlights: '31-35,38-40'
    })
  })

  it('renders Prism metadata safely and counts a trailing newline as part of the fence, not an extra row', () => {
    const rendered = renderMarkdownCodeFence({
      source: 'const first = 1\nconst second = 2\n',
      info: 'typescript title="src/<entry>.ts" linesStart=30 linesHighlight="31,30"',
      sourceLine: 12
    })

    expect(rendered).toBe(
      '<figure class="codeblock-framed" data-source-line="12"><figcaption class="codeblock-title">src/&lt;entry&gt;.ts</figcaption>' +
      '<pre class="prismjs language-typescript line-numbers" data-start="30" data-line="30-31">' +
      '<code class="language-typescript">const first = 1\nconst second = 2\n</code></pre></figure>\n'
    )
  })

  it('keeps a real two-line block numbered while leaving a plain single line compact', () => {
    expect(renderMarkdownCodeFence({ source: 'first\nsecond\n', info: 'text' }))
      .toContain('class="prismjs language-text line-numbers"')
    expect(renderMarkdownCodeFence({ source: 'only one line\n', info: 'text' }))
      .toContain('class="prismjs language-text"')
  })

  it('drops malformed or unsafe numeric metadata without expanding ranges', () => {
    const rendered = renderMarkdownCodeFence({
      source: 'safe\n',
      info: 'text linesStart=-3 linesHighlight="1-9007199254740992, wat, 8-5"'
    })

    expect(rendered).not.toContain('data-start')
    expect(rendered).toContain('data-line="5-8"')
  })

  it('preserves diagram rendering contracts and ignores code presentation metadata', () => {
    expect(renderMarkdownCodeFence({
      source: 'encoded',
      info: 'diagram title="Not a code title" linesHighlight=1',
      sourceLine: 4,
      decodeDiagram: source => `decoded:${source}`
    })).toBe('<pre class="diagram" data-source-line="4">decoded:encoded</pre>\n')

    expect(renderMarkdownCodeFence({ source: '<graph>', info: 'mermaid title="Ignored"' }))
      .toBe('<pre class="codeblock-mermaid"><code>&lt;graph&gt;</code></pre>\n')
  })
})
