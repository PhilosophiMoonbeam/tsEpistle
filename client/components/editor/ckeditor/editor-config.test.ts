import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DecoupledEditor, Markdown } from 'ckeditor5'
import markdownRenderer from '../../../../server/modules/rendering/markdown-core/renderer.ts'
import {
  createVisualEditorConfig,
  getVisualEditorDefinition,
  serializeVisualEditorData
} from './editor-config.ts'

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
})
