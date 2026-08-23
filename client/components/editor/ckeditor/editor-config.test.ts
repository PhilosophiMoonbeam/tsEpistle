import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DecoupledEditor, Markdown } from 'ckeditor5'
import markdownRenderer from '../../../../server/modules/rendering/markdown-core/renderer.ts'
import {
  createVisualEditorConfig,
  getVisualEditorDefinition,
  serializeVisualEditorData
} from './editor-config.ts'
import {
  insertVisualMarkdownDefinitionList,
  prepareVisualMarkdownData
} from './visual-markdown-fidelity.ts'
import {
  VISUAL_MARKDOWN_GLYPHS,
  insertVisualMarkdownAdmonition,
  insertVisualMarkdownGlyph,
  serializeVisualMarkdownAdmonition
} from './visual-markdown-authoring.ts'

const visualSafeGfm = `# Visual-safe GFM
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6


Paragraph with **bold**, *italic*, ~~strikethrough~~, \`inline code\`, and [a link](/en/docs).

---

> A blockquote.

1. First
   1. Nested
2. Second

- [x] Done
- [ ] Pending

\`\`\`javascript
const answer = 42
\`\`\`

| Name | Value |
| --- | --- |
| Alpha | One |

![Alternative text](/assets/example.png)
`
async function renderServerMarkdown (input: string): Promise<string> {
  return Reflect.apply(markdownRenderer.render, {
    input,
    config: {
      allowHTML: false,
      linebreaks: false,
      linkify: false,
      typographer: false,
      quotes: 'English',
      underline: false
    },
    children: [
      { key: 'markdownTasklists', config: {} }
    ]
  }, []) as Promise<string>
}


const editors: DecoupledEditor[] = []
class ResizeObserverStub implements ResizeObserver {
  observe (): void {}
  unobserve (): void {}
  disconnect (): void {}
}

beforeAll(() => {
  window.ResizeObserver = ResizeObserverStub
})


afterEach(async () => {
  await Promise.all(editors.splice(0).map(editor => editor.destroy()))
})

describe('CKEditor visual formats', () => {
  it('keeps the existing HTML data processor and formatter isolated from Markdown', () => {
    const htmlConfig = createVisualEditorConfig('html', 'en', () => {})
    const markdownConfig = createVisualEditorConfig('markdown', 'en', () => {})

    expect(htmlConfig.plugins).not.toContain(Markdown)
    expect(markdownConfig.plugins).toContain(Markdown)
    expect(htmlConfig.toolbar.items).toContain('underline')
    expect(markdownConfig.toolbar.items).not.toContain('underline')
    expect(markdownConfig.toolbar.items).toContain('todoList')
    expect(markdownConfig.toolbar.items).toContain('horizontalLine')
    expect(markdownConfig.toolbar.items).toEqual(expect.arrayContaining([
      'wikiHighlight',
      'wikiSubscript',
      'wikiSuperscript',
      'wikiKeyboard'
    ]))
    expect(markdownConfig.codeBlock?.languages).toEqual(expect.arrayContaining([
      { language: 'diagram', label: 'Draw.io diagram' },
      { language: 'mermaid', label: 'Mermaid diagram' },
      { language: 'plantuml', label: 'PlantUML diagram' },
      { language: 'kroki', label: 'Kroki diagram' }
    ]))
    expect(markdownConfig.codeBlock?.languages).toContainEqual({
      language: 'wiki-extension',
      label: 'Wiki content extension'
    })

    expect(serializeVisualEditorData('html', '<p>One</p><p>Two</p>')).toBe('<p>One</p>\n<p>Two</p>\n')
    expect(serializeVisualEditorData('markdown', '# One\n')).toBe('# One\n')
    expect(getVisualEditorDefinition('html')).toEqual({ editorKey: 'ckeditor', label: 'Visual Editor' })
    expect(getVisualEditorDefinition('markdown')).toEqual({ editorKey: 'visual-markdown', label: 'Visual Markdown' })
  })

  it('round-trips the visual-safe GFM fixture through CKEditor Markdown', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = await DecoupledEditor.create(element, createVisualEditorConfig('markdown', 'en', () => {}))
    editors.push(editor)

    editor.setData(visualSafeGfm)
    const output = editor.getData()

    expect(output).toMatch(/^# Visual-safe GFM/m)
    for (let level = 2; level <= 6; level += 1) {
      expect(output).toContain(`${'#'.repeat(level)} Heading ${level}`)
    }
    expect(output).toContain('**bold**')
    expect(output).toMatch(/(?:\*|_)italic(?:\*|_)/)
    expect(output).toContain('~~strikethrough~~')
    expect(output).toContain('`inline code`')
    expect(output).toContain('[a link](/en/docs)')
    expect(output).toContain('> A blockquote.')
    expect(output).toMatch(/1\. First\n {3,}\d+\. Nested/)
    expect(output).toMatch(/[*-] \[x\] Done/)
    expect(output).toMatch(/[*-] \[ \] Pending/)
    expect(output).toContain('```javascript')
    expect(output).toMatch(/\| Name\s+\| Value\s+\|/)
    expect(output).toContain('![Alternative text](/assets/example.png)')

    const rendered = await renderServerMarkdown(output)
    expect(rendered).toContain('<h1>Visual-safe GFM</h1>')
    expect(rendered).toContain('<h6>Heading 6</h6>')
    expect(rendered).toContain('<strong>bold</strong>')
    expect(rendered).toContain('<em>italic</em>')
    expect(rendered).toContain('<s>strikethrough</s>')
    expect(rendered).toContain('<code>inline code</code>')
    expect(rendered).toContain('<a href="/en/docs">a link</a>')
    expect(rendered).toContain('<blockquote>')
    expect(rendered).toMatch(/<ol>[\s\S]*<ol>[\s\S]*Nested/)
    expect(rendered).toContain('class="task-list-item-checkbox" checked=""')
    expect(rendered).toContain('<code class="language-javascript">')
    expect(rendered).toContain('<th>Name</th>')
    expect(rendered).toContain('<td>Alpha</td>')
    expect(rendered).toContain('<img src="/assets/example.png" alt="Alternative text">')
    expect(rendered).toContain('<hr>')
  })
  it('round-trips highlights and definition lists as canonical Markdown', async () => {
    const source = [
      '# Extended Markdown',
      '',
      'A ==highlighted== value.',
      'Formula H~2~O and x^2^; press <kbd>Ctrl</kbd>.',
      '',
      'First term',
      ': First **definition**',
      '',
      'Second term',
      ': Second definition'
    ].join('\n')
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = await DecoupledEditor.create(element, createVisualEditorConfig('markdown', 'en', () => {}))
    editors.push(editor)

    editor.setData(prepareVisualMarkdownData(source))
    const output = serializeVisualEditorData('markdown', editor.getData())

    expect(output).toContain('A ==highlighted== value.')
    expect(output).toContain('Formula H~2~O and x^2^; press <kbd>Ctrl</kbd>.')
    expect(output).toContain('First term\n: First **definition**')
    expect(output).toContain('Second term\n: Second definition')

    const reopenedElement = document.createElement('div')
    document.body.appendChild(reopenedElement)
    const reopened = await DecoupledEditor.create(reopenedElement, createVisualEditorConfig('markdown', 'en', () => {}))
    editors.push(reopened)
    reopened.setData(prepareVisualMarkdownData(output))
    expect(serializeVisualEditorData('markdown', reopened.getData())).toBe(output)
  })

  it('authors highlights and definition lists through visual editor commands', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = await DecoupledEditor.create(element, createVisualEditorConfig('markdown', 'en', () => {}))
    editors.push(editor)

    editor.setData('Important')
    editor.model.change(writer => {
      const paragraph = editor.model.document.getRoot().getChild(0)!
      writer.setSelection(writer.createRangeIn(paragraph))
    })
    editor.execute('wikiHighlight')
    expect(serializeVisualEditorData('markdown', editor.getData())).toBe('==Important==')

    editor.setData('H2O x2')
    editor.model.change(writer => {
      const paragraph = editor.model.document.getRoot().getChild(0)!
      writer.setSelection(writer.createRange(
        writer.createPositionAt(paragraph, 1),
        writer.createPositionAt(paragraph, 2)
      ))
    })
    editor.execute('wikiSubscript')
    editor.model.change(writer => {
      const paragraph = editor.model.document.getRoot().getChild(0)!
      writer.setSelection(writer.createRange(
        writer.createPositionAt(paragraph, 5),
        writer.createPositionAt(paragraph, 6)
      ))
    })
    editor.execute('wikiSuperscript')
    expect(serializeVisualEditorData('markdown', editor.getData())).toBe('H~2~O x^2^')

    editor.setData('Ctrl')
    editor.model.change(writer => {
      const paragraph = editor.model.document.getRoot().getChild(0)!
      writer.setSelection(writer.createRangeIn(paragraph))
    })
    editor.execute('wikiKeyboard')
    expect(serializeVisualEditorData('markdown', editor.getData())).toBe('<kbd>Ctrl</kbd>')

    editor.model.change(writer => {
      writer.setSelection(editor.model.document.getRoot(), 'end')
    })
    insertVisualMarkdownDefinitionList(editor)
    const output = serializeVisualEditorData('markdown', editor.getData())
    expect(output).toContain('Term\n: Definition')
  })


  it('edits table rows and columns without exposing unsupported merge semantics', async () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = await DecoupledEditor.create(element, createVisualEditorConfig('markdown', 'en', () => {}))
    editors.push(editor)

    editor.execute('insertTable', { rows: 2, columns: 2 })
    editor.execute('insertTableRowBelow')
    editor.execute('insertTableColumnRight')
    let rows = editor.getData().trim().split('\n')
    expect(rows).toHaveLength(5)
    expect(rows.every(row => row.split('|').length === 5)).toBe(true)

    editor.execute('removeTableRow')
    editor.execute('removeTableColumn')
    rows = editor.getData().trim().split('\n')
    expect(rows).toHaveLength(4)
    expect(createVisualEditorConfig('markdown', 'en', () => {}).table?.contentToolbar).not.toContain('mergeTableCells')
  })

  it('inserts and reopens a canonical titled admonition and local glyph', async () => {
    const canonical = serializeVisualMarkdownAdmonition({
      kind: 'WARNING',
      title: 'Deployment window',
      body: 'Restart one node at a time.'
    })
    expect(canonical).toBe('> **WARNING: Deployment window**\n>\n> Restart one node at a time.\n')
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = await DecoupledEditor.create(element, createVisualEditorConfig('markdown', 'en', () => {}))
    editors.push(editor)

    insertVisualMarkdownAdmonition(editor, {
      kind: 'WARNING',
      title: 'Deployment window',
      body: 'Restart one node at a time.'
    })
    editor.model.change(writer => {
      writer.setSelection(editor.model.document.getRoot(), 'end')
    })
    insertVisualMarkdownGlyph(editor, VISUAL_MARKDOWN_GLYPHS.find(glyph => glyph.label === 'Rocket')!)
    const output = editor.getData()
    expect(output).toContain('> **WARNING: Deployment window**')
    expect(output).toContain('> Restart one node at a time.🚀')

    const reopenedElement = document.createElement('div')
    document.body.appendChild(reopenedElement)
    const reopened = await DecoupledEditor.create(reopenedElement, createVisualEditorConfig('markdown', 'en', () => {}))
    editors.push(reopened)
    reopened.setData(output)
    expect(reopened.getData()).toBe(output)

    const rendered = await renderServerMarkdown(output)
    expect(rendered).toContain('class="admonition is-warning"')
    expect(rendered).toContain('class="admonition__title"')
    expect(rendered).toContain('Deployment window')
    expect(rendered).not.toContain('WARNING:')
  })

  it('preserves a canonical wiki-extension fence through insertion and reopen', async () => {
    const body = '{"key":"qr","version":1,"props":{"value":"https://example.test","size":256,"errorCorrection":"M"}}'
    const canonicalFence = `\`\`\`wiki-extension\n${body}\n\`\`\`\n`
    const ckeditorCanonicalFence = canonicalFence.trimEnd()
    const element = document.createElement('div')
    document.body.appendChild(element)
    const editor = await DecoupledEditor.create(element, createVisualEditorConfig('markdown', 'en', () => {}))
    editors.push(editor)

    editor.execute('codeBlock', { language: 'wiki-extension' })
    editor.model.change(writer => {
      editor.model.insertContent(writer.createText(body), editor.model.document.selection)
    })
    expect(editor.getData()).toBe(ckeditorCanonicalFence)

    const reopenedElement = document.createElement('div')
    document.body.appendChild(reopenedElement)
    const reopened = await DecoupledEditor.create(reopenedElement, createVisualEditorConfig('markdown', 'en', () => {}))
    editors.push(reopened)
    reopened.setData(editor.getData())
    expect(reopened.getData()).toBe(ckeditorCanonicalFence)
  })
})
