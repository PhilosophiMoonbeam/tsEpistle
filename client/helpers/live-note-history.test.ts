import { afterEach, expect, it, vi } from '../../server/test/bun-test.mts'
import { document, resetBody } from '../test/browser-dom.mts'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'
import { LIVE_NOTE_MAX_UPDATE_BYTES } from '../../shared/live-notes.ts'
import { LiveNoteHistory } from './live-note-history.ts'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const destroy of cleanup.splice(0)) destroy()
  resetBody()
})
function fixture(source: string) {
  const doc = new Y.Doc(),
    text = doc.getText('content')
  text.insert(0, source)
  const rejected = vi.fn(),
    history = new LiveNoteHistory(text, () => true, rejected)
  const updates: Uint8Array[] = []
  doc.on('update', update => updates.push(update))
  const editor = new EditorView({
    parent: document.body.appendChild(document.createElement('div')),
    state: EditorState.create({
      doc: source,
      extensions: [
        history.extension,
        yCollab(text, null, { undoManager: history.manager }),
        EditorState.transactionFilter.of(transaction => {
          history.track(transaction)
          return transaction
        })
      ]
    })
  })
  cleanup.push(() => {
    editor.destroy()
    history.destroy()
    doc.destroy()
  })
  return { doc, text, history, editor, updates, rejected }
}

it('rejects a large undo before mutating Yjs, while keeping the document and subsequent small undo/redo usable', () => {
  const mounted = fixture('x'.repeat(100 * 1024))
  mounted.editor.dispatch({ changes: { from: 0, to: mounted.editor.state.doc.length }, userEvent: 'delete' })
  expect(mounted.text.toString()).toBe('')
  expect(mounted.updates).toHaveLength(1)
  mounted.history.run('undo')
  expect(mounted.rejected).toHaveBeenCalledTimes(1)
  expect(mounted.text.toString()).toBe('')
  expect(mounted.editor.state.doc.toString()).toBe('')
  expect(mounted.updates).toHaveLength(1)
  mounted.editor.dispatch({ changes: { from: 0, insert: 'small' }, userEvent: 'input.type' })
  expect(mounted.history.run('undo')).toBe(true)
  expect(mounted.text.toString()).toBe('')
  expect(mounted.history.run('redo')).toBe(true)
  expect(mounted.text.toString()).toBe('small')
  expect(mounted.updates.every(update => update.byteLength <= LIVE_NOTE_MAX_UPDATE_BYTES)).toBe(true)
})

it('splits merged typing history before a combined undo can exceed the safe update budget', () => {
  const mounted = fixture('')
  for (let index = 0; index < 3; index++)
    mounted.editor.dispatch({ changes: { from: mounted.editor.state.doc.length, insert: 'a'.repeat(20 * 1024) }, userEvent: 'input.type' })
  expect(mounted.history.manager.undoStack).toHaveLength(3)
  for (let index = 0; index < 3; index++) expect(mounted.history.run('undo')).toBe(true)
  expect(mounted.text.toString()).toBe('')
  for (let index = 0; index < 3; index++) expect(mounted.history.run('redo')).toBe(true)
  expect(mounted.text.length).toBe(60 * 1024)
  expect(mounted.rejected).not.toHaveBeenCalled()
  expect(mounted.updates.every(update => update.byteLength <= LIVE_NOTE_MAX_UPDATE_BYTES)).toBe(true)
})
