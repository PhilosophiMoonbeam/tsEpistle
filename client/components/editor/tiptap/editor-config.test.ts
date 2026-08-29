import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import markdownRenderer from '../../../../server/modules/rendering/markdown-core/renderer.ts'
import {
  createWikiMarkdownRenderer,
  sanitizeWikiMarkdownHtml
} from '../markdown/preview.ts'
import {
  createTiptapExtensions,
  getVisualEditorDefinition,
  serializeVisualEditorData,
  type VisualEditorFormat
} from './editor-config.ts'
import {
  decodeWikiSource,
  prepareTiptapHtml,
  prepareTiptapMarkdown
} from './dialect.ts'
import {
  VISUAL_MARKDOWN_GLYPHS,
  insertVisualMarkdownAdmonition,
  insertVisualMarkdownDefinitionList,
  insertVisualMarkdownGlyph,
  searchVisualMarkdownGlyphs,
  serializeVisualMarkdownAdmonition
} from './visual-markdown-authoring.ts'

const editors: Editor[] = []

function createEditor (format: VisualEditorFormat, content: string): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: createTiptapExtensions(format),
    content: format === 'markdown' ? prepareTiptapMarkdown(content) : prepareTiptapHtml(content),
    contentType: format
  })
  editors.push(editor)
  return editor
}

function findSourceNodes (node: JSONContent): JSONContent[] {
  const children = node.content?.flatMap(findSourceNodes) ?? []
  return node.type?.startsWith('wikiSource') ? [node, ...children] : children
}

async function renderServerMarkdown (input: string): Promise<string> {
  return Reflect.apply(markdownRenderer.render, {
    input,
    config: {
      allowHTML: true,
      linebreaks: false,
      linkify: false,
      typographer: false,
      quotes: 'English',
      underline: false
    },
    children: [
      { key: 'markdownAbbr', config: {} },
      { key: 'markdownDeflist', config: {} },
      { key: 'markdownFootnotes', config: {} },
      { key: 'markdownImsize', config: {} },
      { key: 'markdownMark', config: {} },
      { key: 'markdownMultiTable', config: {} },
      { key: 'markdownSupsub', config: {} },
      { key: 'markdownTasklists', config: {} }
    ]
  }, []) as Promise<string>
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.replaceChildren()
})

describe('Tiptap visual formats', () => {
  it('keeps persisted editor keys stable across the engine replacement', () => {
    expect(getVisualEditorDefinition('html')).toEqual({ editorKey: 'ckeditor', label: 'Visual Editor' })
    expect(getVisualEditorDefinition('markdown')).toEqual({ editorKey: 'visual-markdown', label: 'Visual Markdown' })
  })

  it('round-trips the Standard Markdown authoring surface', () => {
    const source = `# Visual Markdown

Paragraph with **bold**, *italic*, ~~strike~~, ==highlight==, H~2~O, x^2^, <kbd>Ctrl</kbd>, \`code\`, and [link](/docs).

- [x] Done
- [ ] Pending

| Name | Value |
| --- | --- |
| Alpha | One |

\`\`\`mermaid
graph TD
  A --> B
\`\`\`

Term
: Definition
`
    const editor = createEditor('markdown', source)
    const output = editor.getMarkdown()

    expect(output).toContain('==highlight==')
    expect(output).toContain('H~2~O')
    expect(output).toContain('x^2^')
    expect(output).toContain('<kbd>Ctrl</kbd>')
    expect(output).toContain('- [x] Done')
    expect(output).toContain('```mermaid')
    expect(output).toContain('Term\n: Definition')

    const reopened = createEditor('markdown', output)
    expect(reopened.getMarkdown()).toBe(output)
  })

  it('preserves every extended dialect family without source fallback', async () => {
    const source = `# Dialect {#dialect .reference}

HTML is an abbreviation.[^note]

*[HTML]: Hyper Text Markup Language

[^note]: A footnote with **formatting**.

An image ![Sized](/assets/image.png =120x80) and inline math $E=mc^2$.

$$
a^2 + b^2 = c^2
$$

<div class="raw-widget">Raw <strong>HTML</strong></div>

| A | B |
| --- | --- |
| one \\ | continued |
| ^^ | rowspan |
`
    const editor = createEditor('markdown', source)
    const output = editor.getMarkdown()

    expect(output).toContain('{#dialect .reference}')
    expect(output).toContain('[^note]')
    expect(output).toContain('*[HTML]: Hyper Text Markup Language')
    expect(output).toContain('[^note]: A footnote with **formatting**.')
    expect(output).toContain('![Sized](/assets/image.png =120x80)')
    expect(output).toContain('$E=mc^2$')
    expect(output).toContain('a^2 + b^2 = c^2')
    expect(output).toContain('<div class="raw-widget">Raw <strong>HTML</strong></div>')
    expect(output).toContain('| ^^ | rowspan |')

    const prepared = prepareTiptapMarkdown(source)
    expect(prepared).toContain(':::wikiSourceBlock')
    expect(prepared).toContain('[wikiSourceInline')
    const reopened = createEditor('markdown', output)
    expect(reopened.getMarkdown()).toBe(output)
    expect(await renderServerMarkdown(output)).toBe(await renderServerMarkdown(source))
  })

  it('renders the complete Markdown editor dialect after a visual round trip', () => {
    const source = `# Dialect {#dialect .reference}

"Smart quotes" -- autolink https://example.com, [reference][guide], and emoji :rocket:.
First line
second line with ==mark==, H~2~O, x^2^, <kbd>Ctrl</kbd>, and a	tab.[^note]

- [x] Complete

HTML
: Hyper Text Markup Language

*[HTML]: Hyper Text Markup Language

[^note]: Footnote **body**.

![Sized](/assets/image.png =120x80)

Inline math $E=mc^2$.

$$
a^2 + b^2 = c^2
$$

<div class="raw-widget">Raw <strong>HTML</strong></div>

| A | B |
| --- | --- |
| one \\ | continued |
| ^^ | rowspan |

## Tabs {.tabset}

### First

Tab content.

[guide]: /guide "Guide"

\`\`\`plantuml
Alice -> Bob
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`
`
    const editor = createEditor('markdown', source)
    const output = editor.getMarkdown()
    const sourceRenderer = createWikiMarkdownRenderer()
    const visualRenderer = createWikiMarkdownRenderer()

    expect(visualRenderer.render(output)).toBe(sourceRenderer.render(source))
    expect(visualRenderer.render(output)).toContain('/_assets/svg/twemoji/1f680.svg')
    expect(visualRenderer.render(output)).toContain('class="katex"')
    expect(visualRenderer.render(output)).toContain('class="footnotes')
    expect(visualRenderer.render(output)).toContain('rowspan="2"')
  })

  it('sanitizes the renderer shared by both Markdown previews', () => {
    const markdown = createWikiMarkdownRenderer()
    const preview = sanitizeWikiMarkdownHtml(markdown.render('<img src=x onerror=alert(1)><script>alert(2)</script>'))

    expect(preview).toContain('<img src="x">')
    expect(preview).not.toContain('onerror')
    expect(preview).not.toContain('<script')
  })

  it('keeps code fence presentation metadata in the shared preview renderer', () => {
    const markdown = createWikiMarkdownRenderer()
    const preview = sanitizeWikiMarkdownHtml(markdown.render(
      '```ts title="src/main.ts" linesStart=30 linesHighlight="31,30"\nfirst\nsecond\n```'
    ))

    expect(preview).toContain('<figure class="codeblock-framed">')
    expect(preview).not.toContain('data-source-line')
    expect(preview).toContain('<figcaption class="codeblock-title">src/main.ts</figcaption>')
    expect(preview).toContain('class="prismjs language-ts line-numbers"')
    expect(preview).toContain('data-start="30"')
    expect(preview).toContain('data-line="30-31"')
  })

  it('applies visual marks and inserts canonical definition lists', () => {
    const editor = createEditor('markdown', 'Important H2O x2 Ctrl')

    editor.commands.setTextSelection({ from: 1, to: 10 })
    editor.commands.toggleHighlight()
    editor.commands.setTextSelection({ from: 12, to: 13 })
    editor.commands.toggleSubscript()
    editor.commands.setTextSelection({ from: 16, to: 17 })
    editor.commands.toggleSuperscript()
    editor.commands.setTextSelection({ from: 18, to: 22 })
    editor.commands.toggleMark('keyboard')
    editor.commands.setTextSelection(editor.state.doc.content.size)
    insertVisualMarkdownDefinitionList(editor)

    const output = editor.getMarkdown()
    expect(output).toContain('==Important== H~2~O x^2^ <kbd>Ctrl</kbd>')
    expect(output).toContain('Term\n: Definition')
  })

  it('inserts canonical admonitions and local glyphs', () => {
    const editor = createEditor('markdown', '')
    const canonical = serializeVisualMarkdownAdmonition({
      kind: 'WARNING',
      title: 'Deployment window',
      body: 'Restart one node at a time.'
    })
    insertVisualMarkdownAdmonition(editor, {
      kind: 'WARNING',
      title: 'Deployment window',
      body: 'Restart one node at a time.'
    })
    insertVisualMarkdownGlyph(editor, VISUAL_MARKDOWN_GLYPHS.find(glyph => glyph.label === 'Rocket')!)

    expect(editor.getMarkdown()).toContain(canonical.trim())
    expect(editor.getMarkdown()).toContain('🚀')
  })

  it('offers a broad glyph catalog with semantic and typo-tolerant search', () => {
    expect(VISUAL_MARKDOWN_GLYPHS.length).toBeGreaterThanOrEqual(80)
    expect(new Set(VISUAL_MARKDOWN_GLYPHS.map(glyph => glyph.value)).size).toBe(VISUAL_MARKDOWN_GLYPHS.length)
    expect(searchVisualMarkdownGlyphs('celebrte')[0]?.label).toBe('Celebrate')
    expect(searchVisualMarkdownGlyphs('deploy')[0]?.label).toBe('Rocket')
    expect(searchVisualMarkdownGlyphs('secure')[0]?.label).toBe('Lock')
    expect(searchVisualMarkdownGlyphs('shape', 'icon').every(glyph => glyph.category === 'icon')).toBe(true)
    expect(searchVisualMarkdownGlyphs('zzqxy')).toEqual([])
  })

  it('preserves unknown HTML elements and comments as editable source nodes', () => {
    const source = '<h2 id="heading">Known</h2><custom-widget data-mode="full"><b>Unknown</b></custom-widget><!--keep--><table style="min-width: 75px"><colgroup><col style="min-width: 25px"></colgroup><tbody><tr><td><p>Cell</p></td></tr></tbody></table>'
    const editor = createEditor('html', source)
    const sourceNodes = findSourceNodes(editor.getJSON())

    expect(sourceNodes).toHaveLength(2)
    expect(decodeWikiSource(sourceNodes[0]?.attrs?.source)).toContain('<custom-widget')
    const output = serializeVisualEditorData('html', editor)
    expect(output).toContain('<h2 id="heading">Known</h2>')
    expect(output).toContain('<custom-widget data-mode="full"><b>Unknown</b></custom-widget>')
    expect(output).toContain('<!--keep-->')
    expect(output).toContain('<colgroup>')
    expect(output).toContain('<td')

    const reopened = createEditor('html', output)
    expect(serializeVisualEditorData('html', reopened)).toBe(output)
  })
})
