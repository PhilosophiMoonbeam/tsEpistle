import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { yCollab } from 'y-codemirror.next'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { CollaborationPresence } from './collaboration-presence'
import {
  COLLABORATION_TEXT_KEY,
  createCollaborationRange,
  type CollaborationAwareness,
  type CollaborationParticipant
} from '../../../shared/collaboration'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const createEditor = (source = 'shared source') => {
  const doc = new Y.Doc(), text = doc.getText(COLLABORATION_TEXT_KEY)
  text.insert(0, source)
  const sent: CollaborationAwareness[] = []
  const presence = new CollaborationPresence(text, 1, message => { sent.push(message); return true })
  const undo = new Y.UndoManager(text)
  const parent = document.body.appendChild(document.createElement('div'))
  const view = new EditorView({ parent, state: EditorState.create({ doc: text.toString(), extensions: [yCollab(text, null, { undoManager: undo }), presence.extension] }) })
  const checkbox = parent.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!checkbox) throw new Error('Presence sharing control is missing')
  const destroy = () => { presence.destroy(); view.destroy(); undo.destroy(); doc.destroy(); parent.remove() }
  return { doc, text, presence, sent, view, parent, checkbox, undo, destroy }
}

const participant = (text: Y.Text, from = 1, to = 3): CollaborationParticipant => ({
  token: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', label: 'Participant bbbbbbbb',
  selection: createCollaborationRange(text, from, to), recent: [createCollaborationRange(text, from, to)], expiresAt: Date.now() + 30_000
})
const self = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

const createPeerEditor = () => {
  const editor = createEditor('start  end')
  const remote = new Y.Doc()
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(editor.doc))
  const peerText = remote.getText(COLLABORATION_TEXT_KEY)
  peerText.insert(6, 'peer')
  Y.applyUpdate(editor.doc, Y.encodeStateAsUpdate(remote), remote)
  return {
    ...editor,
    peer: participant(peerText, 6, 10),
    destroy: () => { remote.destroy(); editor.destroy() }
  }
}

const expectPeerLocation = (
  view: EditorView,
  expected: { from: number; to: number; selection: string; recent: string[] }
): void => {
  const markedText = (selector: string): string[] => Array.from(view.dom.querySelectorAll<HTMLElement>(selector), mark =>
    view.state.sliceDoc(view.posAtDOM(mark), view.posAtDOM(mark, mark.childNodes.length)))
  expect(markedText('.cm-participant-selection').join('')).toBe(expected.selection)
  expect(markedText('.cm-participant-recent')).toEqual(expected.recent)
  const caret = view.dom.querySelector<HTMLElement>('.cm-participant-caret')
  if (!caret) throw new Error('Peer caret is missing')
  expect(view.posAtDOM(caret)).toBe(expected.to)
  const button = view.dom.querySelector<HTMLButtonElement>('ul button')
  if (!button) throw new Error('Peer location control is missing')
  button.click()
  expect(view.state.selection.main.from).toBe(expected.from)
  expect(view.state.selection.main.to).toBe(expected.to)
}

describe('session-only collaboration presence adapter', () => {
  it('defaults off and never announces initial sync or reconnect aggregates as edits', async () => {
    const editor = createEditor()
    const remote = new Y.Doc()
    try {
      expect(editor.checkbox.checked).toBe(false)
      expect(editor.checkbox.disabled).toBe(true)
      editor.presence.setReady(true)
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(250)
      expect(editor.sent).toEqual([])
      editor.checkbox.click()
      await vi.advanceTimersByTimeAsync(250)
      expect(editor.sent).toHaveLength(1)
      expect(editor.sent[0]).toMatchObject({ enabled: true, recent: [] })
      editor.presence.receive({ generation: 1, self, peers: [participant(editor.text)] })
      editor.presence.setReady(false)
      Y.applyUpdate(remote, Y.encodeStateAsUpdate(editor.doc))
      remote.getText(COLLABORATION_TEXT_KEY).insert(0, 'reconnected ')
      Y.applyUpdate(editor.doc, Y.encodeStateAsUpdate(remote))
      editor.presence.setReady(true)
      await Promise.resolve()
      expect(editor.checkbox.checked).toBe(false)
      expect(editor.parent.querySelector('.cm-participant-caret')).toBeNull()
      editor.checkbox.click()
      await vi.advanceTimersByTimeAsync(250)
      expect(editor.sent.at(-1)).toMatchObject({ enabled: true, recent: [] })
    } finally { remote.destroy(); editor.destroy() }
  })

  it('exposes named keyboard location controls and noncolor cues without changing source or undo', async () => {
    const editor = createEditor()
    try {
      editor.presence.setReady(true)
      await Promise.resolve()
      editor.checkbox.click()
      await vi.advanceTimersByTimeAsync(250)
      const before = Y.encodeStateAsUpdate(editor.doc)
      editor.presence.receive({ generation: 1, self, peers: [participant(editor.text)] })
      await Promise.resolve()
      expect(Y.encodeStateAsUpdate(editor.doc)).toEqual(before)
      expect(editor.undo.undoStack).toHaveLength(0)
      const button = editor.parent.querySelector<HTMLButtonElement>('ul button')
      if (!button) throw new Error('Peer location control is missing')
      expect(button.textContent).toContain('Participant bbbbbbbb: selection, line 1, column 4')
      expect(editor.parent.querySelector('.cm-participant-caret')?.textContent).toContain('Participant bbbbbbbb')
      expect(editor.parent.querySelector('.cm-participant-recent')).not.toBeNull()
      button.focus()
      editor.presence.receive({ generation: 1, self, peers: [{ ...participant(editor.text), selection: createCollaborationRange(editor.text, 4) }] })
      await Promise.resolve()
      expect(document.activeElement).toBe(button)
      button.click()
      expect(editor.view.state.selection.main.from).toBe(4)
      expect(editor.view.state.selection.main.to).toBe(4)
      editor.view.dispatch({ changes: { from: 4, insert: 'mine' } })
      await vi.advanceTimersByTimeAsync(250)
      expect(editor.sent.at(-1)?.recent).toHaveLength(1)
      expect(editor.undo.undoStack).toHaveLength(1)
      editor.presence.receive({ generation: 1, self, peers: [] })
      await Promise.resolve()
      expect(editor.undo.undoStack).toHaveLength(1)
      expect(editor.parent.querySelector('.cm-participant-caret')).toBeNull()
    } finally { editor.destroy() }
  })

  it('moves peer cues immediately after local insertions without attributing adjacent or interleaved local text', async () => {
    const editor = createPeerEditor()
    try {
      editor.presence.setReady(true)
      await Promise.resolve()
      editor.checkbox.click()
      await vi.advanceTimersByTimeAsync(250)
      expect(editor.sent.at(-1)?.recent).toEqual([])
      editor.presence.receive({ generation: 1, self, peers: [editor.peer] })
      await Promise.resolve()

      editor.view.dispatch({ changes: [
        { from: 0, insert: 'mine ' },
        { from: 6, insert: '[' },
        { from: 8, insert: 'my' },
        { from: 10, insert: ']' }
      ] })
      // Inspect the rendered cues before any timer, microtask or new peer message.
      expect(editor.view.state.doc.toString()).toBe('mine start [pemyer] end')
      expect(editor.text.toString()).toBe('mine start [pemyer] end')
      expectPeerLocation(editor.view, { from: 12, to: 18, selection: 'pemyer', recent: ['pe', 'er'] })
      expect(editor.undo.undoStack).toHaveLength(1)

      editor.undo.undo()
      expect(editor.view.state.doc.toString()).toBe('start peer end')
      expect(editor.text.toString()).toBe('start peer end')
      expectPeerLocation(editor.view, { from: 6, to: 10, selection: 'peer', recent: ['peer'] })
      editor.undo.redo()
      expect(editor.view.state.doc.toString()).toBe('mine start [pemyer] end')
      expect(editor.text.toString()).toBe('mine start [pemyer] end')
      expectPeerLocation(editor.view, { from: 12, to: 18, selection: 'pemyer', recent: ['pe', 'er'] })
    } finally { editor.destroy() }
  })

  it('keeps peer cues on surviving text after local deletions and clears them when that text is gone', async () => {
    const editor = createPeerEditor()
    try {
      editor.presence.setReady(true)
      await Promise.resolve()
      editor.checkbox.click()
      await vi.advanceTimersByTimeAsync(250)
      editor.presence.receive({ generation: 1, self, peers: [editor.peer] })
      await Promise.resolve()

      editor.view.dispatch({ changes: [{ from: 0, to: 6 }, { from: 7, to: 9 }] })
      expect(editor.view.state.doc.toString()).toBe('pr end')
      expect(editor.text.toString()).toBe('pr end')
      expectPeerLocation(editor.view, { from: 0, to: 2, selection: 'pr', recent: ['pr'] })
      expect(editor.undo.undoStack).toHaveLength(1)

      editor.undo.stopCapturing()
      editor.view.dispatch({ changes: { from: 0, to: 2 } })
      expect(editor.view.state.doc.toString()).toBe(' end')
      expect(editor.text.toString()).toBe(' end')
      expect(editor.parent.querySelector('.cm-participant-caret')).toBeNull()
      expect(editor.parent.querySelector('.cm-participant-selection')).toBeNull()
      expect(editor.parent.querySelector('.cm-participant-recent')).toBeNull()
      expect(editor.parent.querySelector<HTMLButtonElement>('ul button')?.disabled).toBe(true)
      expect(editor.undo.undoStack).toHaveLength(2)

      editor.undo.undo()
      expect(editor.view.state.doc.toString()).toBe('pr end')
      expect(editor.text.toString()).toBe('pr end')
      editor.undo.undo()
      expect(editor.view.state.doc.toString()).toBe('start peer end')
      expect(editor.text.toString()).toBe('start peer end')
    } finally { editor.destroy() }
  })

  it('expires recent marks, then tokens, and prevents disposed listeners from sending', async () => {
    const editor = createEditor()
    try {
      editor.presence.setReady(true)
      await Promise.resolve()
      editor.checkbox.click()
      await vi.advanceTimersByTimeAsync(250)
      editor.presence.receive({ generation: 1, self, peers: [participant(editor.text)] })
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(8_001)
      expect(editor.parent.querySelector('.cm-participant-recent')).toBeNull()
      expect(editor.parent.querySelector('.cm-participant-caret')).not.toBeNull()
      await vi.advanceTimersByTimeAsync(22_000)
      expect(editor.parent.querySelector('.cm-participant-caret')).toBeNull()
      expect(editor.checkbox.checked).toBe(false)
      const count = editor.sent.length
      editor.presence.destroy()
      editor.view.dispatch({ changes: { from: 0, insert: 'still editable ' } })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(editor.sent).toHaveLength(count)
      expect(editor.text.toString()).toStartWith('still editable ')
    } finally { editor.destroy() }
  })
})
