import { Editor, type ChainedCommands } from '@tiptap/core'
import { afterEach, describe, expect, it } from '../../../../server/test/bun-test.mts'
import markdownRenderer from '../../../../server/modules/rendering/markdown-core/renderer.ts'
import { createWikiMarkdownRenderer, sanitizeWikiMarkdownHtml } from '../markdown/preview.ts'
import { createTiptapExtensions, getVisualEditorDefinition, serializeVisualEditorData, VisualEditorSource, type VisualEditorFormat } from './editor-config.ts'
import { prepareTiptapHtml, prepareTiptapMarkdown } from './dialect.ts'
import { installTiptapSlashMenu } from './slash-menu.ts'
import { EditorAdapterController } from '../common/editor-adapter.ts'
import {
  VISUAL_MARKDOWN_GLYPHS,
  insertVisualMarkdownAdmonition,
  insertVisualMarkdownDefinitionList,
  insertVisualMarkdownGlyph,
  searchVisualMarkdownGlyphs
} from './visual-markdown-authoring.ts'
import { parseWikiLinkAt, resolveWikiLinkHref, type WikiLinkOptions } from '../../../../shared/wikilinks.ts'

const editors: Editor[] = []
let restoreRangeGeometry: (() => void) | undefined

function installRangeGeometry(): void {
  if (restoreRangeGeometry) return
  const { Range, DOMRect } = document.defaultView!
  const prototype = Range.prototype
  const methods = ['getClientRects', 'getBoundingClientRect'] as const
  const originals = methods.map(name => Object.getOwnPropertyDescriptor(prototype, name))
  const elementPrototype = document.defaultView!.HTMLElement.prototype
  const originalScroll = Object.getOwnPropertyDescriptor(elementPrototype, 'scrollIntoView')
  Object.defineProperty(elementPrototype, 'scrollIntoView', { configurable: true, value: () => {} })
  // JSDOM has no layout. Supply geometry only; keep native editor/menu behavior intact.
  const rectangle = new DOMRect(0, 0, 1, 16)
  Object.defineProperties(prototype, {
    getClientRects: {
      configurable: true,
      value: () =>
        Object.assign([rectangle], {
          item: (index: number) => (index === 0 ? rectangle : null)
        })
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => rectangle
    }
  })
  restoreRangeGeometry = () => {
    methods.forEach((name, index) => {
      const original = originals[index]
      if (original) Object.defineProperty(prototype, name, original)
      else Reflect.deleteProperty(prototype, name)
    })
    if (originalScroll) Object.defineProperty(elementPrototype, 'scrollIntoView', originalScroll)
    else Reflect.deleteProperty(elementPrototype, 'scrollIntoView')
    restoreRangeGeometry = undefined
  }
}
const enabledWikiLinks: WikiLinkOptions = {
  enabled: true,
  context: { locale: 'en', pagePath: 'guide', namespaced: true }
}

function createEditor(format: VisualEditorFormat, content: string, wikiLinks?: WikiLinkOptions): Editor {
  installRangeGeometry()
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

function findTextblockEnd(editor: Editor, text: string, parentType: string): number | null {
  let result: number | null = null
  editor.state.doc.descendants((node, position, parent) => {
    if (node.isTextblock && node.textContent === text && parent?.type.name === parentType) {
      result = position + 1 + node.content.size
    }
  })
  return result
}

function selectionHasAncestor(editor: Editor, name: string): boolean {
  const $from = editor.state.selection.$from
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === name) return true
  }
  return false
}

function pressEnter(editor: Editor): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  editor.view.dom.dispatchEvent(event)
  return event.defaultPrevented
}

function typeVisualText(editor: Editor, text: string): void {
  const { from, to } = editor.state.selection
  const defaultTransaction = () => editor.state.tr.insertText(text)
  const handled = editor.view.someProp('handleTextInput', handler => handler(editor.view, from, to, text, defaultTransaction))
  if (!handled) editor.view.dispatch(defaultTransaction())
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
  try {
    for (const editor of editors.splice(0)) editor.destroy()
    document.body.replaceChildren()
  } finally {
    restoreRangeGeometry?.()
  }
})

describe('Tiptap visual formats', () => {
  it('keeps persisted editor keys stable across the engine replacement', () => {
    expect(getVisualEditorDefinition('html').editorKey).toBe('ckeditor')
    expect(getVisualEditorDefinition('markdown').editorKey).toBe('visual-markdown')
  })

  it('captures exact HTML source through pristine startup, selection changes, and Undo', async () => {
    const original = "<h2 id='saved-heading'> Saved heading</h2>\r\n<p>Original <a href='/home' class='saved-link'>link</a>.</p>\r\n<div class='table-container'><table><colgroup><col></col></colgroup><tbody><tr><td>Cell</td></tr></tbody></table></div><p>End</p>"
    const editor = createEditor('html', original)
    const created = new Promise<void>(resolve => editor.once('create', () => resolve()))
    const source = new VisualEditorSource(editor, 'html', original)
    const adapter = new EditorAdapterController({
      readText: () => source.readText(),
      writeText: text => source.replaceText(text),
      clearText: () => source.replaceText('')
    })
    editor.on('update', () => adapter.noteTextChange())
    adapter.initialize()

    // This legacy input is intentionally not the serializer's canonical output.
    expect(serializeVisualEditorData('html', editor)).not.toBe(original)
    expect(adapter.capture()).toEqual({ text: original, editVersion: 0 })
    editor.commands.setTextSelection({ from: 1, to: 6 })
    await created
    expect(adapter.capture()).toEqual({ text: original, editVersion: 0 })
    expect(adapter.snapshot().nonPersisted).toBe(false)

    editor.commands.setLink({ href: '/chosen-page' })
    expect(adapter.capture().text).toContain('href="/chosen-page"')
    expect(adapter.snapshot().nonPersisted).toBe(true)
    expect(editor.commands.undo()).toBe(true)
    expect(adapter.capture().text).toBe(original)
    // Restoring equivalent content is not permission to acknowledge a version.
    expect(adapter.capture().editVersion).toBeGreaterThan(0)
    expect(adapter.snapshot().nonPersisted).toBe(true)
    adapter.destroy()
  })

  it('pairs discarded or replaced HTML with its exact source without hiding later native edits', async () => {
    const original = "<h2> Saved heading</h2>\r\n<p>Original draft baseline.</p>"
    const replacement = "<p class='server-source'> Replacement bytes &amp; spacing.</p>\r\n"
    const editor = createEditor('html', original)
    const created = new Promise<void>(resolve => editor.once('create', () => resolve()))
    const source = new VisualEditorSource(editor, 'html', original)
    const adapter = new EditorAdapterController({
      readText: () => source.readText(),
      writeText: text => source.replaceText(text),
      clearText: () => source.replaceText('')
    })
    editor.on('update', () => adapter.noteTextChange())
    adapter.initialize()

    editor.commands.insertContent('Unsaved link draft')
    const editedVersion = adapter.capture().editVersion
    adapter.replaceText(original, { detached: true })
    const discarded = adapter.capture()
    expect(discarded.text).toBe(original)
    expect(discarded.editVersion).toBeGreaterThan(editedVersion)
    expect(editor.getText()).not.toContain('Unsaved link draft')
    adapter.markPersisted(discarded.editVersion)
    expect(adapter.snapshot().nonPersisted).toBe(false)

    adapter.replaceText(replacement, { detached: true })
    const replaced = adapter.capture()
    expect(replaced.text).toBe(replacement)
    expect(editor.getText()).toContain('Replacement bytes & spacing.')
    adapter.markPersisted(replaced.editVersion)
    editor.commands.insertContent('Early native edit')
    // A deferred create callback must never reset the new document's baseline.
    await created
    expect(adapter.capture().text).toContain('Early native edit')
    expect(adapter.capture().text).not.toBe(replacement)
    expect(adapter.capture().editVersion).toBeGreaterThan(replaced.editVersion)
    adapter.markPersisted(replaced.editVersion)
    expect(adapter.snapshot().nonPersisted).toBe(true)

    adapter.clear()
    expect(adapter.capture().text).toBe('')
    expect(editor.getText()).toBe('')
    expect(adapter.snapshot().nonPersisted).toBe(true)
    adapter.destroy()
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

  it('preserves every extended dialect family through source-backed nodes', async () => {
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

    const source =
      '<dl><dt>Term</dt><dd><p>First paragraph</p><p>Second paragraph</p><ul><li><p>Nested item</p></li></ul></dd><dd><p>Alternate definition</p></dd></dl>'
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
    const canonical = '> **WARNING: Deployment window**\n>\n> Restart one node at a time.'
    insertVisualMarkdownAdmonition(editor, {
      kind: 'WARNING',
      title: 'Deployment window',
      body: 'Restart one node at a time.'
    })
    insertVisualMarkdownGlyph(editor, VISUAL_MARKDOWN_GLYPHS.find(glyph => glyph.label === 'Rocket')!)

    expect(editor.getMarkdown()).toContain(canonical.trim())
    expect(editor.getMarkdown()).toContain('🚀')
  })

  it('offers unique glyph choices with semantic and typo-tolerant search', () => {
    expect(new Set(VISUAL_MARKDOWN_GLYPHS.map(glyph => glyph.value)).size).toBe(VISUAL_MARKDOWN_GLYPHS.length)
    expect(searchVisualMarkdownGlyphs('celebrte')[0]?.label).toBe('Celebrate')
    expect(searchVisualMarkdownGlyphs('deploy')[0]?.label).toBe('Rocket')
    expect(searchVisualMarkdownGlyphs('secure')[0]?.label).toBe('Lock')
    const shapes = searchVisualMarkdownGlyphs('shape', 'icon')
    expect(shapes.map(glyph => glyph.value)).toEqual(expect.arrayContaining(['◆', '●', '■']))
    expect(shapes.every(glyph => glyph.category === 'icon')).toBe(true)
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

  it('edits real sized image nodes without rewriting titles or unrelated source classes', () => {
    const source = '![A diagram](/assets/diagram.png "Architecture" =120x80){.align-right .keep-me .wiki-image-border}'
    const editor = createEditor('markdown', source)
    expect(editor.state.doc.firstChild?.type.name).toBe('image')
    expect(editor.getMarkdown()).toBe(source)

    editor.commands.setNodeSelection(0)
    editor.commands.updateAttributes('image', { width: '50%', class: 'keep-me align-center wiki-image-shadow' })
    const updated = editor.getMarkdown()
    expect(updated).toContain('"Architecture" =50%x80')
    expect(updated).toContain('keep-me')
    expect(updated).toContain('align-center')
    expect(updated).toContain('wiki-image-shadow')
    expect(updated).not.toContain('align-right')
    const reopened = createEditor('markdown', updated)
    expect(reopened.state.doc.firstChild?.attrs.width).toBe('50%')
    expect(reopened.state.doc.firstChild?.attrs.class).toContain('keep-me')
  })

  it('keeps supported HTML image properties editable and unknown image attributes opaque', () => {
    const supported = '<img src="/assets/photo.png" alt="Photo" width="160" height="auto" class="align-abstopright wiki-image-rounded" style="width:160px">'
    const editor = createEditor('markdown', supported)
    expect(editor.state.doc.firstChild?.type.name).toBe('image')
    expect(editor.getMarkdown()).toBe(supported)
    editor.commands.setNodeSelection(0)
    editor.commands.updateAttributes('image', { alt: 'Updated photograph', width: '320' })
    const edited = editor.getMarkdown()
    expect(edited).toContain('alt="Updated photograph"')
    expect(edited).toContain('width="320"')
    expect(edited).toContain('width:320px')
    expect(edited).toContain('align-abstopright wiki-image-rounded')
    editor.commands.updateAttributes('image', { alt: '' })
    expect(editor.getMarkdown()).toContain('alt=""')

    const withoutAlt = createEditor('markdown', '<img src="/assets/photo.png">')
    withoutAlt.commands.setNodeSelection(0)
    withoutAlt.commands.updateAttributes('image', { alt: 'New description' })
    expect(withoutAlt.getMarkdown()).toContain('alt="New description"')

    const unknown = '<img src="/assets/photo.png" data-custom="keep exactly" class="foreign" style="object-fit:contain">'
    for (const format of ['markdown', 'html'] as const) {
      const opaque = createEditor(format, unknown)
      expect(opaque.state.doc.firstChild?.type.name).toBe('wikiSourceBlock')
      expect(serializeVisualEditorData(format, opaque)).toContain(unknown)
    }
  })

  it('executes filtered slash commands through native keyboard and pointer actions', () => {
    for (const format of ['markdown', 'html'] as const) {
      const editor = createEditor(format, '')
      installTiptapSlashMenu(
        editor,
        [
          { id: 'heading', label: 'Heading', run: (chain: ChainedCommands) => chain.setHeading({ level: 2 }) },
          { id: 'table', label: 'Table', run: (chain: ChainedCommands) => chain.insertTable({ rows: 2, cols: 2, withHeaderRow: true }) }
        ],
        'Insert'
      )
      typeVisualText(editor, '/')
      typeVisualText(editor, 'heading')
      expect(pressEnter(editor)).toBe(true)
      expect(editor.state.doc.firstChild?.type.name).toBe('heading')
      expect(editor.state.doc.firstChild?.attrs.level).toBe(2)

      editor.commands.setContent('')
      typeVisualText(editor, '/')
      editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      expect(pressEnter(editor)).toBe(true)
      expect(editor.state.doc.firstChild?.type.name).toBe('table')

      editor.commands.setContent('')
      typeVisualText(editor, '/')
      typeVisualText(editor, 'table')
      const menu = document.querySelector<HTMLElement>(`#${editor.view.dom.getAttribute('aria-controls')}`)
      expect(menu?.hidden).toBe(false)
      menu?.querySelector<HTMLButtonElement>('button')?.click()
      expect(editor.state.doc.firstChild?.type.name).toBe('table')
      expect(editor.state.doc.firstChild?.childCount).toBe(2)
      editor.destroy()
    }
  })

  it('maps an active slash line past unrelated document edits and refuses replaced queries', () => {
    const editor = createEditor('markdown', '')
    installTiptapSlashMenu(editor, [{ id: 'heading', label: 'Heading', run: chain => chain.setHeading({ level: 2 }) }], 'Insert')
    typeVisualText(editor, '/')
    const paragraph = editor.schema.nodes.paragraph!.create(null, editor.schema.text('Remote paragraph'))
    editor.view.dispatch(editor.state.tr.insert(0, paragraph))
    const menuId = editor.view.dom.getAttribute('aria-controls')
    expect(menuId).not.toBeNull()
    const menu = document.getElementById(menuId!)!
    expect(menu.hidden).toBe(false)
    const button = menu.querySelector<HTMLButtonElement>('button')
    expect(button).not.toBeNull()
    button!.click()
    expect(editor.state.doc.firstChild?.textContent).toBe('Remote paragraph')
    const mappedBlock = editor.state.doc.nodeAt(paragraph.nodeSize)
    expect(mappedBlock?.type.name).toBe('heading')
    expect(mappedBlock?.attrs.level).toBe(2)
    expect(mappedBlock?.textContent).toBe('')

    editor.commands.setContent('')
    typeVisualText(editor, '/')
    const staleButton = document.querySelector<HTMLButtonElement>('.editor-tiptap-slash-menu button')
    editor.view.dispatch(editor.state.tr.insertText('other', editor.state.selection.from))
    staleButton?.click()
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph')
    expect(editor.getText()).toBe('/other')
  })

  it('dismisses slash suggestions without consuming source during Escape, IME or read-only transitions', () => {
    const editor = createEditor('markdown', '')
    installTiptapSlashMenu(editor, [{ id: 'heading', label: 'Heading', run: chain => chain.setHeading({ level: 2 }) }], 'Insert')
    typeVisualText(editor, '/')
    const menu = document.querySelector<HTMLElement>('.editor-tiptap-slash-menu')!
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(menu.hidden).toBe(true)
    expect(editor.getText()).toBe('/')

    editor.commands.setContent('')
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    typeVisualText(editor, '/')
    expect(menu.hidden).toBe(true)
    expect(editor.getText()).toBe('/')
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))

    // A fresh editor avoids depending on the browser's deferred composition-end timer.
    const readonly = createEditor('html', '')
    installTiptapSlashMenu(readonly, [{ id: 'heading', label: 'Heading', run: chain => chain.setHeading({ level: 2 }) }], 'Insert')
    typeVisualText(readonly, '/')
    const activeMenu = document.querySelector<HTMLElement>(`#${readonly.view.dom.getAttribute('aria-controls')}`)!
    const staleButton = activeMenu.querySelector<HTMLButtonElement>('button')
    readonly.setEditable(false)
    staleButton?.click()
    expect(activeMenu.hidden).toBe(true)
    expect(readonly.getText()).toBe('/')
    readonly.setEditable(true)
    expect(activeMenu.hidden).toBe(true)
    readonly.destroy()
    expect(activeMenu.isConnected).toBe(false)
  })

  it('does not trigger a slash menu in code, nested lists, or a replaced selection', () => {
    for (const fixture of [
      { source: '<pre><code></code></pre>', position: 1 },
      { source: '<ul><li><p></p></li></ul>', position: 3 },
      { source: '<p>Replace</p>', position: { from: 1, to: 8 } }
    ]) {
      const editor = createEditor('html', fixture.source)
      installTiptapSlashMenu(editor, [{ id: 'heading', label: 'Heading', run: chain => chain.setHeading({ level: 2 }) }], 'Insert')
      editor.commands.setTextSelection(fixture.position)
      typeVisualText(editor, '/')
      expect(editor.view.dom.hasAttribute('aria-controls')).toBe(false)
      expect(editor.getText()).toContain('/')
    }
  })

  it('losslessly preserves unknown HTML elements and comments across reopening', () => {
    const source =
      '<h2 id="heading">Known</h2><custom-widget data-mode="full"><b>Unknown</b></custom-widget><!--keep--><table style="min-width: 75px"><colgroup><col style="min-width: 25px"></colgroup><tbody><tr><td><p>Cell</p></td></tr></tbody></table>'
    const editor = createEditor('html', source)
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
