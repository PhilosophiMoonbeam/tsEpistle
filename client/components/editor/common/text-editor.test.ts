import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from '../../../../server/test/bun-test.mts'
import { TextEditor } from './text-editor.ts'

const editors: TextEditor[] = []

const createEditor = (options: Partial<ConstructorParameters<typeof TextEditor>[0]> = {}) => {
  const parent = document.body.appendChild(document.createElement('div'))
  const editor = new TextEditor({
    parent,
    ariaLabel: 'Markdown source',
    dark: false,
    value: '# Heading',
    ...options
  })
  editors.push(editor)
  return { editor, parent }
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.replaceChildren()
})

describe('TextEditor', () => {
  it('configures content attributes through CodeMirror extensions', () => {
    const { parent } = createEditor({ direction: 'rtl', spellcheck: false })
    const content = parent.querySelector<HTMLElement>('.cm-content')

    expect(content).not.toBeNull()
    expect(content?.getAttribute('aria-label')).toBe('Markdown source')
    expect(content?.getAttribute('dir')).toBe('rtl')
    expect(content?.getAttribute('spellcheck')).toBe('false')
  })

  it('reconfigures spellcheck and base-theme mode without changing the document', () => {
    const changes: string[] = []
    const { editor, parent } = createEditor({ dark: true, spellcheck: false, onChange: value => changes.push(value) })
    const content = parent.querySelector<HTMLElement>('.cm-content')
    const view = parent.querySelector<HTMLElement>('.cm-editor') ? EditorView.findFromDOM(parent.querySelector<HTMLElement>('.cm-editor')!) : null

    expect(view?.state.facet(EditorView.darkTheme)).toBe(true)

    editor.setSpellcheck(true)
    editor.setDark(false)

    expect(content?.getAttribute('spellcheck')).toBe('true')
    expect(content?.getAttribute('aria-label')).toBe('Markdown source')
    expect(view?.state.facet(EditorView.darkTheme)).toBe(false)
    expect(editor.getValue()).toBe('# Heading')
    expect(changes).toEqual([])
  })

  it('reports the pointer-selected position without coupling keyboard selection changes', () => {
    const clicks: Array<{ line: number; ch: number }> = []
    const { editor, parent } = createEditor({
      value: 'first\nsecond',
      onClick: position => clicks.push(position)
    })
    const content = parent.querySelector<HTMLElement>('.cm-content')

    editor.setSelection({ line: 1, ch: 3 })
    expect(clicks).toEqual([])

    content?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(clicks).toEqual([{ line: 1, ch: 3 }])
    expect(editor.getValue()).toBe('first\nsecond')
  })
})
