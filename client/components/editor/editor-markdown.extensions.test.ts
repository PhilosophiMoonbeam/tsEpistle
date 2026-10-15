import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { compileScript, parse } from '@vue/compiler-sfc'
import { defineComponent } from 'vue'
import { afterEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../../test/browser-dom.mts'
import { serializeContentExtensionFence } from '../../../shared/content-extensions.ts'
import type { EditorInsertPayload } from '../../helpers/editor-insert-events.ts'
import { createSourceAuthoring, type SourceAuthoring } from '../../helpers/editor-source-authoring.ts'
import { TextEditor } from './common/text-editor.ts'
import { vRovingToolbar } from './common/roving-toolbar.ts'

const filename = join(process.cwd(), 'client/components/editor/editor-markdown.vue')
const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor
const script = compileScript(descriptor, { id: 'markdown-extension-insertion', genDefaultAs: 'component' })
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.content.replace(/^import\s[\s\S]*?\sfrom\s['"][^'"]+['"];?\s*$/gm, ''))

type InsertionContext = {
  cm: TextEditor
  sourceAuthoring: SourceAuthoring
  insertAtCursor: (options: { content: string }) => void
}
type InsertionComponent = {
  methods: {
    handleEditorInsert: (this: InsertionContext, payload: EditorInsertPayload) => void
    insertAtCursor: (this: InsertionContext, options: { content: string }) => void
  }
}
// Compile the production routing method, including its legacy cursor insertion
// method, so bypassing guarded block insertion reproduces the browser defect.
// Unused preview animation/help metadata is not mounted in this insertion scope.
const component = new Function('defineComponent', 'EditorView', 'Velocity', 'markdownHelp', 'vRovingToolbar', `${executable}\nreturn component`)(
  defineComponent,
  EditorView,
  null,
  {},
  vRovingToolbar
) as InsertionComponent

const serialized = serializeContentExtensionFence({
  key: 'links-grid',
  version: 1,
  props: { cards: [{ title: 'Owned guide', url: '/en/owned/reader' }] }
})
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
  resetBody()
})

function createEditor(source: string, extensions: Extension[] = []) {
  let owner = 'account-a:epoch-1:page-1'
  const sourceAuthoring = createSourceAuthoring(
    'markdown',
    () => true,
    () => owner
  )
  const parent = document.body.appendChild(document.createElement('div'))
  const editor = new TextEditor({
    parent,
    value: source,
    ariaLabel: 'Markdown source',
    dark: false,
    language: markdown({ base: markdownLanguage }),
    extensions: [sourceAuthoring.extension, ...extensions]
  })
  cleanup.push(() => {
    sourceAuthoring.destroy()
    editor.destroy()
  })
  const view = EditorView.findFromDOM(parent.querySelector<HTMLElement>('.cm-editor')!)!
  const context = { cm: editor, sourceAuthoring } as InsertionContext
  context.insertAtCursor = component.methods.insertAtCursor.bind(context)
  return {
    editor,
    view,
    insert: () => component.methods.handleEditorInsert.call(context, { kind: 'EXTENSION', text: serialized }),
    changeOwner: () => {
      owner = 'account-b:epoch-2:page-1'
    }
  }
}

describe('Markdown native content-extension insertion', () => {
  test('separates a canonical fence from adjacent media and following prose in one undoable edit', () => {
    const image = '![Owned raster](/owned/image.png)'
    const source = `${image}Following prose`
    const { editor, view, insert } = createEditor(source)
    view.dispatch({ selection: { anchor: image.length } })

    insert()

    expect(editor.getValue()).toBe(`${image}\n${serialized}Following prose`)
    expect(view.state.selection.main.head).toBe(image.length + 1 + serialized.length)
    expect(editor.undo()).toBe(true)
    expect(editor.getValue()).toBe(source)
  })

  test('replaces the selected source without changing the surrounding existing line boundaries', () => {
    const source = 'Before\nReplace this\nAfter'
    const { editor, view, insert } = createEditor(source)
    const from = source.indexOf('Replace this')
    view.dispatch({ selection: { anchor: from, head: from + 'Replace this'.length } })

    insert()

    expect(editor.getValue()).toBe(`Before\n${serialized}\nAfter`)
    expect(view.state.selection.main.empty).toBe(true)
    expect(view.state.selection.main.head).toBe('Before\n'.length + serialized.length)
    expect(editor.undo()).toBe(true)
    expect(editor.getValue()).toBe(source)
  })

  for (const boundary of ['changed actor', 'read-only', 'non-editable', 'composition'] as const) {
    test(`refuses the insert event after ${boundary}`, () => {
      const source = 'Owned source'
      const { editor, view, insert, changeOwner } = createEditor(source, [
        ...(boundary === 'read-only' ? [EditorState.readOnly.of(true)] : []),
        ...(boundary === 'non-editable' ? [EditorView.editable.of(false)] : [])
      ])
      view.dispatch({ selection: { anchor: source.length } })
      if (boundary === 'changed actor') changeOwner()
      if (boundary === 'composition') {
        view.contentDOM.dispatchEvent(new browserWindow.CompositionEvent('compositionstart', { bubbles: true }))
      }

      insert()

      expect(editor.getValue()).toBe(source)
      expect(editor.historyDepth().undo).toBe(0)
    })
  }
})
