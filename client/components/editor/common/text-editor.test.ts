import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it } from '../../../../server/test/bun-test.mts'
import { EDITOR_SELECTION, EDITOR_SELECTION_INACTIVE, TextEditor } from './text-editor.ts'

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

  it('resolves the Unicode word under an empty selection', () => {
    const value = 'Alpha café, omega'
    const { editor } = createEditor({ value })
    const from = value.indexOf('café')

    expect(editor.wordOffsetsAt(from + 2)).toEqual({ from, to: from + 'café'.length })
    expect(editor.wordOffsetsAt(value.indexOf(','))).toBeNull()
  })

  it('paints one visible selection token for focused and unfocused editors', () => {
    const { parent } = createEditor({ value: 'first second' })
    const css = [
      ...Array.from(document.querySelectorAll('style'), style => style.textContent ?? ''),
      ...(document.adoptedStyleSheets ?? []).flatMap(sheet => Array.from(sheet.cssRules, rule => rule.cssText))
    ].join('\n')
    const editorClasses = Array.from(parent.querySelector('.cm-editor')?.classList ?? [])

    expect(EDITOR_SELECTION).toContain('--wiki-editor-selection')
    expect(EDITOR_SELECTION_INACTIVE).toContain('--wiki-editor-selection-inactive')
    expect(editorClasses.length).toBeGreaterThan(1)
    expect(css).toContain(`.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`)
    expect(css).toContain(EDITOR_SELECTION_INACTIVE.slice(0, 40))
    expect(css).toContain(EDITOR_SELECTION.slice(0, 32))
    expect(css).not.toContain('rgba(var(--v-theme-primary), .24)')
  })
  it('reports the Markdown syntax path and undo depth for toolbar state', () => {
    const value = '- **bold** text'
    const { editor, parent } = createEditor({ value, language: markdown({ base: markdownLanguage }) })
    const view = EditorView.findFromDOM(parent.querySelector<HTMLElement>('.cm-editor')!)!
    ensureSyntaxTree(view.state, view.state.doc.length, 1000)

    editor.setSelection({ line: 0, ch: value.indexOf('bold') + 1 })
    expect(editor.syntaxPath()).toEqual(expect.arrayContaining(['StrongEmphasis', 'ListItem', 'BulletList']))
    editor.setSelection({ line: 0, ch: value.length })
    expect(editor.syntaxPath()).not.toContain('StrongEmphasis')

    expect(editor.historyDepth()).toEqual({ undo: 0, redo: 0 })
    editor.replaceRange('!', { line: 0, ch: value.length })
    expect(editor.historyDepth().undo).toBe(1)
    expect(editor.undo()).toBe(true)
    expect(editor.getValue()).toBe(value)
    expect(editor.historyDepth()).toEqual({ undo: 0, redo: 1 })
    expect(editor.redo()).toBe(true)
    expect(editor.getValue()).toBe(`${value}!`)
  })
})
