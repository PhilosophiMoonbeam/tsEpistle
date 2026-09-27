import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, describe, expect, it } from '../../../../server/test/bun-test.mts'
import markdownRenderer from '../../../../server/modules/rendering/markdown-core/renderer.ts'
import { createWikiMarkdownRenderer, sanitizeWikiMarkdownHtml } from '../markdown/preview.ts'
import { createTiptapExtensions, getVisualEditorDefinition, serializeVisualEditorData, type VisualEditorFormat } from './editor-config.ts'
import { decodeWikiSource, prepareTiptapHtml, prepareTiptapMarkdown } from './dialect.ts'
import {
  VISUAL_MARKDOWN_GLYPHS,
  insertVisualMarkdownAdmonition,
  insertVisualMarkdownDefinitionList,
  insertVisualMarkdownGlyph,
  searchVisualMarkdownGlyphs,
  serializeVisualMarkdownAdmonition
} from './visual-markdown-authoring.ts'
import { parseWikiLinkAt, resolveWikiLinkHref, type WikiLinkOptions } from '../../../../shared/wikilinks.ts'

const editors: Editor[] = []
const enabledWikiLinks: WikiLinkOptions = {
  enabled: true,
  context: { locale: 'en', pagePath: 'guide', namespaced: true }
}

function createEditor (format: VisualEditorFormat, content: string, wikiLinks?: WikiLinkOptions): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const editor = new Editor({
    element,
    extensions: createTiptapExtensions(format, wikiLinks),
    content: format === 'markdown' ? prepareTiptapMarkdown(content) : prepareTiptapHtml(content),
    contentType: format
  })
  editors.push(editor)
  return editor
}

function findTextblockEnd (editor: Editor, text: string, parentType: string): number | null {
  let result: number | null = null
  editor.state.doc.descendants((node, position, parent) => {
    if (node.isTextblock && node.textContent === text && parent?.type.name === parentType) {
      result = position + 1 + node.content.size
    }
  })
  return result
}

function selectionHasAncestor (editor: Editor, name: string): boolean {
  const $from = editor.state.selection.$from
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === name) return true
  }
  return false
}

function pressEnter (editor: Editor): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  editor.view.dom.dispatchEvent(event)
  return event.defaultPrevented
}

function findSourceNodes(node: JSONContent): JSONContent[] {
  const children = node.content?.flatMap(findSourceNodes) ?? []
  return node.type?.startsWith('wikiSource') ? [node, ...children] : children
}

async function renderServerMarkdown(input: string): Promise<string> {
  return Reflect.apply(
    markdownRenderer.render,
    {
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
    },
    []
  ) as Promise<string>
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

  it('round-trips enabled wikilinks as ordinary safe anchors in both Markdown surfaces', () => {
    const source = '[[target]] [[target|label]] [[target#section]] [[#section]]'
    const editor = createEditor('markdown', source, enabledWikiLinks)
    const output = editor.getMarkdown()
    const editorHtml = editor.getHTML()
    const previewHtml = createWikiMarkdownRenderer(enabledWikiLinks).render(source)

    expect(output).toBe(source)
    expect(editorHtml).toContain('href="/en/guide/target"')
    expect(editorHtml).toContain('href="/en/guide/target#section"')
    expect(editorHtml).toContain('href="#section"')
    expect(editorHtml).not.toContain('wikiLinkSource')
    expect(previewHtml).toContain('href="/en/guide/target"')
    expect(previewHtml).toContain('href="/en/guide/target#section"')
    expect(previewHtml).toContain('href="#section"')
    expect(resolveWikiLinkHref('[[target#section]]', enabledWikiLinks.context)).toBe('/en/guide/target#section')
    expect(resolveWikiLinkHref('[[file.name]]', enabledWikiLinks.context)).toBe('/en/guide/file%2Ename')
  })

  it('renders wikilink labels as escaped text', () => {
    const source = '[[target|<img src=x onerror=alert(1)> & text]]'
    const editor = createEditor('markdown', source, enabledWikiLinks)
    const preview = createWikiMarkdownRenderer(enabledWikiLinks).render(source)

    expect(editor.getHTML()).not.toContain('<img')
    expect(preview).not.toContain('<img')
    expect(preview).toContain('&lt;img')
    expect(preview).toContain('&amp;')
  })

  it('keeps wikilinks disabled by default', () => {
    const source = '[[target]]'
    const editor = createEditor('markdown', source)
    const preview = createWikiMarkdownRenderer().render(source)

    expect(editor.getMarkdown()).toBe(source)
    expect(editor.getHTML()).not.toContain('<a')
    expect(preview).not.toContain('<a')
  })

  it('leaves Markdown citations, code, HTML attributes, and unsafe malformed wikilinks untouched', () => {
    const source = 'Citation [[1]](https://example.com), inline `[[target]]`.\n\n```md\n[[target]]\n```'
    const editor = createEditor('markdown', source, enabledWikiLinks)
    const preview = createWikiMarkdownRenderer(enabledWikiLinks).render(source)

    expect(editor.getMarkdown()).toContain('[[1]](https://example.com)')
    expect(editor.getMarkdown()).toContain('`[[target]]`')
    expect(editor.getMarkdown()).toContain('[[target]]')
    expect(preview).toContain('href="https://example.com"')
    expect(preview).not.toContain('href="/en/guide/target"')
    expect(preview).toContain('<code>[[target]]</code>')

    const htmlAttribute = createWikiMarkdownRenderer(enabledWikiLinks).render('<span data-source="[[target]]">literal</span>')
    expect(htmlAttribute).toContain('data-source="[[target]]"')
    expect(htmlAttribute).not.toContain('href="/en/guide/target"')

    const malformed = '[[javascript:alert(1)]] [[//evil.example]] [[target#]] [[target|one|two]]'
    expect(parseWikiLinkAt('[[1]](https://example.com)')).toBeNull()
    expect(parseWikiLinkAt('[[target]][reference]')).toBeNull()
    expect(parseWikiLinkAt('[[target]][[next]]')?.raw).toBe('[[target]]')
    for (const candidate of malformed.split(' ')) expect(parseWikiLinkAt(candidate)).toBeNull()
    const malformedEditor = createEditor('markdown', malformed, enabledWikiLinks)
    const malformedPreview = createWikiMarkdownRenderer(enabledWikiLinks).render(malformed)
    expect(malformedEditor.getMarkdown()).toContain(malformed)
    expect(malformedPreview).toContain(malformed)
    expect(malformedPreview).not.toContain('href="javascript:')
    expect(malformedPreview).not.toContain('href="//evil.example')
  })

  it('falls back to an ordinary Markdown link when a wikilink label is edited', () => {
    const editor = createEditor('markdown', '[[target|label]]', enabledWikiLinks)

    const link = editor.state.doc.firstChild?.firstChild
    expect(link?.type.name).toBe('wikiLink')
    editor.commands.setTextSelection({ from: 2, to: 2 + (link?.content.size ?? 0) })
    editor.commands.insertContent('Changed label')

    expect(editor.getMarkdown()).toContain('[Changed label](/en/guide/target)')
    expect(editor.getMarkdown()).not.toContain('[[target|label]]')
  })

  it('progresses through definition terms and descriptions without dropping existing entries', () => {
    const editor = createEditor('markdown', 'Term\n: Definition')
    const termEnd = findTextblockEnd(editor, 'Term', 'definitionList')
    expect(termEnd).not.toBeNull()
    editor.commands.setTextSelection(termEnd!)
    expect(pressEnter(editor)).toBe(true)
    expect(selectionHasAncestor(editor, 'definitionDescription')).toBe(true)
    expect(editor.state.selection.$from.parent.textContent).toBe('Definition')

    const definitionEnd = findTextblockEnd(editor, 'Definition', 'definitionDescription')
    expect(definitionEnd).not.toBeNull()
    editor.commands.setTextSelection(definitionEnd!)
    expect(pressEnter(editor)).toBe(true)
    expect(editor.state.selection.$from.parent.type.name).toBe('definitionTerm')
    expect(editor.state.selection.$from.parent.textContent).toBe('')

    expect(pressEnter(editor)).toBe(true)
    expect(selectionHasAncestor(editor, 'definitionDescription')).toBe(true)
    expect(pressEnter(editor)).toBe(true)
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(selectionHasAncestor(editor, 'definitionList')).toBe(false)
    expect(editor.getJSON().content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('Term')
    expect(editor.getJSON().content?.[0]?.content).toHaveLength(2)
  })

  it('moves to an existing next term and keeps nested, multi-paragraph definitions editable', () => {
    const nextTermEditor = createEditor('markdown', 'Term\n: Definition\n\nNext\n: Explanation')
    const definitionEnd = findTextblockEnd(nextTermEditor, 'Definition', 'definitionDescription')
    expect(definitionEnd).not.toBeNull()
    nextTermEditor.commands.setTextSelection(definitionEnd!)
    expect(pressEnter(nextTermEditor)).toBe(true)
    expect(nextTermEditor.state.selection.$from.parent.type.name).toBe('definitionTerm')
    expect(nextTermEditor.state.selection.$from.parent.textContent).toBe('Next')

    const source = '<dl><dt>Term</dt><dd><p>First paragraph</p><p>Second paragraph</p><ul><li><p>Nested item</p></li></ul></dd><dd><p>Alternate definition</p></dd></dl>'
    const editor = createEditor('html', source)
    const firstParagraphEnd = findTextblockEnd(editor, 'First paragraph', 'definitionDescription')
    expect(firstParagraphEnd).not.toBeNull()
    editor.commands.setTextSelection(firstParagraphEnd!)
    expect(pressEnter(editor)).toBe(true)
    expect(editor.getText()).toContain('First paragraph')
    expect(editor.getText()).toContain('Second paragraph')
    expect(editor.getText()).toContain('Nested item')
    expect(editor.getText()).toContain('Alternate definition')
    const list = editor.getJSON().content?.[0]
    expect(list?.content?.filter(child => child.type === 'definitionDescription')).toHaveLength(2)
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
    const preview = sanitizeWikiMarkdownHtml(markdown.render('```ts title="src/main.ts" linesStart=30 linesHighlight="31,30"\nfirst\nsecond\n```'))

    expect(preview).toContain('<figure class="codeblock-framed">')
    expect(preview).not.toContain('data-source-line')
    expect(preview).toContain('<figcaption class="codeblock-title">src/main.ts</figcaption>')
    expect(preview).toContain('class="prismjs language-ts line-numbers"')
    expect(preview).toContain('data-start="30"')
    expect(preview).toContain('data-line-offset="29"')
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

  it('keeps both serializers independent of canvas theme and layout classes', () => {
    const fixtures: Array<{ format: VisualEditorFormat; source: string }> = [
      { format: 'markdown', source: '# Themed heading\n\nBody with **meaning**.' },
      { format: 'html', source: '<h1>Themed heading</h1><p>Body with <strong>meaning</strong>.</p>' }
    ]

    for (const fixture of fixtures) {
      const editor = createEditor(fixture.format, fixture.source)
      const serialized = serializeVisualEditorData(fixture.format, editor)

      editor.options.element.classList.add('contents', 'editor-page-canvas')

      expect(serializeVisualEditorData(fixture.format, editor)).toBe(serialized)
    }
  })

  it('preserves unknown HTML elements and comments as editable source nodes', () => {
    const source =
      '<h2 id="heading">Known</h2><custom-widget data-mode="full"><b>Unknown</b></custom-widget><!--keep--><table style="min-width: 75px"><colgroup><col style="min-width: 25px"></colgroup><tbody><tr><td><p>Cell</p></td></tr></tbody></table>'
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
