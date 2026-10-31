import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { compileScript, parse } from '@vue/compiler-sfc'
import { defineComponent } from 'vue'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../../test/browser-dom.mts'
import { serializeContentExtensionFence } from '../../../shared/content-extensions.ts'
import {
  COLLABORATION_FORMAT,
  COLLABORATION_PROTOCOL_VERSION,
  COLLABORATION_TEXT_KEY,
  COLLABORATION_UPDATE_VERSION,
  COLLABORATION_WEBSOCKET_PATH,
  encodeCollaborationUpdate
} from '../../../shared/collaboration.ts'
import * as Y from 'yjs'
import type { EditorInsertPayload } from '../../helpers/editor-insert-events.ts'
import { createSourceAuthoring, type SourceAuthoring } from '../../helpers/editor-source-authoring.ts'
import { createMarkdownCollaboration } from './collaboration.ts'
import { TextEditor, type TextEditorHistory } from './common/text-editor.ts'
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
    toggleMarkup: (this: { cm: TextEditor }, options: { start: string; end?: string }) => void
  }
}
// Compile the production routing method, including its legacy cursor insertion
// method, so bypassing guarded block insertion reproduces the browser defect.
// Unused preview animation/help metadata is not mounted in this insertion scope.
const component = new Function(
  'defineComponent',
  'EditorView',
  'Velocity',
  'markdownHelp',
  'vRovingToolbar',
  'EditorContentsPane',
  `${executable}\nreturn component`
)(defineComponent, EditorView, null, {}, vRovingToolbar, {}) as InsertionComponent

const serialized = serializeContentExtensionFence({
  key: 'links-grid',
  version: 1,
  props: { cards: [{ title: 'Owned guide', url: '/en/owned/reader' }] }
})
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose()
  resetBody()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function createEditor(source: string, extensions: Extension[] = [], history?: TextEditorHistory) {
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
    history,
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

describe('Markdown toolbar history', () => {
  test('keeps bold separate from adjacent typing and restores formatted source on redo', () => {
    for (const selected of [false, true]) {
      const { editor, view } = createEditor('omega tail')
      // Cover both a caret within the typed word and a backward selection
      // delivered with the input transaction, without an intervening history
      // boundary from a separate selection transaction or a typing pause.
      view.dispatch({
        changes: { from: 0, insert: 'fresh' },
        selection: selected ? { anchor: 10, head: 0 } : { anchor: 5 },
        userEvent: 'input.type'
      })
      const authoredSource = editor.getValue()
      const authoredSelection = view.state.selection

      component.methods.toggleMarkup.call({ cm: editor }, { start: '**' })

      expect(editor.getValue()).toBe('**freshomega** tail')
      expect(view.state.selection.main.anchor).toBe(selected ? 12 : 7)
      expect(view.state.selection.main.head).toBe(selected ? 2 : 7)
      const formattedSelection = view.state.selection
      view.dispatch(view.state.replaceSelection('!'), { userEvent: 'input.type' })
      expect(editor.getValue()).toBe(selected ? '**!** tail' : '**fresh!omega** tail')
      expect(editor.undo()).toBe(true)
      expect(editor.getValue()).toBe('**freshomega** tail')
      expect(view.state.selection.eq(formattedSelection)).toBe(true)
      expect(editor.undo()).toBe(true)
      expect(editor.getValue()).toBe(authoredSource)
      expect(view.state.selection.eq(authoredSelection)).toBe(true)
      expect(editor.redo()).toBe(true)
      expect(editor.getValue()).toBe('**freshomega** tail')
      expect(editor.undo()).toBe(true)
      expect(editor.getValue()).toBe(authoredSource)
      expect(editor.undo()).toBe(true)
      expect(editor.getValue()).toBe('omega tail')
    }
  })

  test('keeps collaborative bold atomic between typing through the production Yjs history provider', async () => {
    // Keep all changes in the same Yjs capture interval: no selection-only
    // dispatch or elapsed-time boundary may accidentally isolate formatting.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'))
    // Transport is intentionally unopened; history uses the production
    // collaboration, real Y.Doc/Y.Text and real y-codemirror view plugins.
    vi.stubGlobal('WebSocket', class extends EventTarget {
      static readonly OPEN = 1
      readonly readyState = 0
      close(): void {}
    })
    for (const selected of [false, true]) {
      const seed = new Y.Doc()
      seed.getText(COLLABORATION_TEXT_KEY).insert(0, 'omega tail')
      const state = encodeCollaborationUpdate(Y.encodeStateAsUpdate(seed))
      seed.destroy()
      const history = await createMarkdownCollaboration({
        pageId: 42,
        expectedUpdatedAt: () => '2026-08-15T12:00:00.000Z',
        fetchImpl: async () => Response.json({
          token: 'signed.token.value',
          pageId: 42,
          format: COLLABORATION_FORMAT,
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
          updateVersion: COLLABORATION_UPDATE_VERSION,
          generation: 1,
          revision: 0,
          baseSourceRevision: '1',
          baseUpdatedAt: '2026-08-15T12:00:00.000Z',
          state,
          websocketPath: COLLABORATION_WEBSOCKET_PATH
        }),
        onBaseline: () => {},
        onStatus: () => {}
      })
      const { editor, view } = createEditor(history.content, [], history)
      cleanup.push(() => history.destroy())
      view.dispatch({
        changes: { from: 0, insert: 'fresh' },
        selection: selected ? { anchor: 10, head: 0 } : { anchor: 5 },
        userEvent: 'input.type'
      })

      component.methods.toggleMarkup.call({ cm: editor }, { start: '**' })

      expect(editor.getValue()).toBe('**freshomega** tail')
      expect(view.state.selection.main.anchor).toBe(selected ? 12 : 7)
      expect(view.state.selection.main.head).toBe(selected ? 2 : 7)
      expect(history.content).toBe(editor.getValue())
      view.dispatch(view.state.replaceSelection('!'), { userEvent: 'input.type' })
      expect(editor.getValue()).toBe(selected ? '**!** tail' : '**fresh!omega** tail')
      // Use the native provider rather than an ordinary CodeMirror history
      // command, which is deliberately absent from collaborative editors.
      expect(history.undo()).toBe(true)
      expect(editor.getValue()).toBe('**freshomega** tail')
      expect(history.undo()).toBe(true)
      expect(editor.getValue()).toBe('freshomega tail')
      expect(history.redo()).toBe(true)
      expect(editor.getValue()).toBe('**freshomega** tail')
      expect(history.undo()).toBe(true)
      expect(editor.getValue()).toBe('freshomega tail')
      expect(history.undo()).toBe(true)
      expect(editor.getValue()).toBe('omega tail')
      expect(history.content).toBe('omega tail')
      expect(history.undo()).toBe(false)
    }
  })
})
