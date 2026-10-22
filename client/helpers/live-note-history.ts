import { keymap } from '@codemirror/view'
import type { Transaction } from '@codemirror/state'
import { ySyncAnnotation } from 'y-codemirror.next'
import * as Y from 'yjs'

const HISTORY_BYTES = Symbol('live-note-history-bytes')
const encoder = new TextEncoder()
const MAX_HISTORY_BYTES = 32 * 1024
interface HistoryItem {
  meta: Map<unknown, unknown>
}

/** Keep undo/redo inside the note update wire bound before Yjs mutates the doc. */
export class LiveNoteHistory {
  readonly manager: Y.UndoManager
  readonly extension = keymap.of([
    { key: 'Mod-z', run: () => this.run('undo'), preventDefault: true },
    { key: 'Mod-Shift-z', run: () => this.run('redo'), preventDefault: true },
    { key: 'Mod-y', run: () => this.run('redo'), preventDefault: true }
  ])
  private transactionBytes: number | null = null
  private actionBytes: number | null = null

  constructor(
    text: Y.Text,
    private readonly canEdit: () => boolean,
    private readonly rejected: () => void
  ) {
    this.manager = new Y.UndoManager(text, { captureTransaction: () => this.transactionBytes !== null || this.actionBytes !== null })
    this.manager.on('stack-item-added', this.added)
    this.manager.on('stack-item-updated', this.updated)
  }
  track(transaction: Transaction): void {
    if (!transaction.docChanged || transaction.annotation(ySyncAnnotation)) return
    let bytes = 0
    transaction.changes.iterChanges((from, to, _newFrom, _newTo, inserted) => {
      bytes += encoder.encode(transaction.startState.doc.sliceString(from, to)).byteLength + encoder.encode(inserted.toString()).byteLength
    })
    const previous = this.manager.undoStack.at(-1)?.meta.get(HISTORY_BYTES)
    // Ordinary typing stays grouped, but merging must not create a large undo.
    if (bytes > MAX_HISTORY_BYTES || (typeof previous === 'number' && previous + bytes > MAX_HISTORY_BYTES)) this.manager.stopCapturing()
    this.transactionBytes = bytes
  }
  private readonly added = ({ stackItem }: { stackItem: HistoryItem }): void => {
    stackItem.meta.set(HISTORY_BYTES, this.actionBytes ?? this.transactionBytes ?? Infinity)
    this.transactionBytes = null
  }
  private readonly updated = ({ stackItem }: { stackItem: HistoryItem }): void => {
    const previous = stackItem.meta.get(HISTORY_BYTES)
    stackItem.meta.set(HISTORY_BYTES, this.actionBytes ?? (typeof previous === 'number' ? previous : Infinity) + (this.transactionBytes ?? Infinity))
    this.transactionBytes = null
  }
  run(direction: 'undo' | 'redo'): boolean {
    if (!this.canEdit()) return true
    const item = (direction === 'undo' ? this.manager.undoStack : this.manager.redoStack).at(-1)
    if (!item) return false
    const bytes = item.meta.get(HISTORY_BYTES)
    if (typeof bytes !== 'number' || bytes > MAX_HISTORY_BYTES) {
      this.rejected()
      return true
    }
    this.actionBytes = bytes
    this.manager.stopCapturing()
    try {
      return (direction === 'undo' ? this.manager.undo() : this.manager.redo()) !== null
    } finally {
      this.actionBytes = null
      this.transactionBytes = null
      this.manager.stopCapturing()
    }
  }
  destroy(): void {
    this.manager.off('stack-item-added', this.added)
    this.manager.off('stack-item-updated', this.updated)
    this.manager.destroy()
  }
}
