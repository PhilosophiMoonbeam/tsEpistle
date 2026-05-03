import { createEventBus } from './simple-event-bus'

export const EDITOR_INSERT_EVENT = 'editorInsert'
const editorInsertBus = createEventBus()

type EditorInsertPayload = {
  kind?: string
  path?: string
  text?: string
  align?: string
  [key: string]: unknown
}

type EditorInsertHandler = (opts: EditorInsertPayload) => void

export function emitEditorInsert (opts: EditorInsertPayload): void {
  editorInsertBus.emit(EDITOR_INSERT_EVENT, opts)
}

export function onEditorInsert (handler?: EditorInsertHandler): void {
  editorInsertBus.on(EDITOR_INSERT_EVENT, handler)
}

export function offEditorInsert (handler?: EditorInsertHandler): void {
  editorInsertBus.off(EDITOR_INSERT_EVENT, handler)
}
