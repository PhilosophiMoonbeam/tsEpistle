import { createEventBus } from './simple-event-bus'
import type { EditorImagePropertiesRequest, EditorImageStyle } from './editor-image-properties'

export const EDITOR_INSERT_EVENT = 'editorInsert'
const editorInsertBus = createEventBus<[EditorInsertPayload | EditorImagePropertiesRequest]>()

export type EditorInsertPayload = {
  kind?: string
  path?: string
  text?: string
  align?: string
  width?: string
  height?: string
  styles?: readonly EditorImageStyle[]
  [key: string]: unknown
}

type EditorInsertHandler = (opts: EditorInsertPayload) => void

export function emitEditorInsert(opts: EditorInsertPayload): void {
  editorInsertBus.emit(EDITOR_INSERT_EVENT, opts)
}

export function onEditorInsert(handler?: EditorInsertHandler): void {
  editorInsertBus.on(EDITOR_INSERT_EVENT, handler as (payload: EditorInsertPayload | EditorImagePropertiesRequest) => void)
}

export function offEditorInsert(handler?: EditorInsertHandler): void {
  editorInsertBus.off(EDITOR_INSERT_EVENT, handler as (payload: EditorInsertPayload | EditorImagePropertiesRequest) => void)
}

export function emitEditorImagePropertiesRequest(request: EditorImagePropertiesRequest): void {
  editorInsertBus.emit('editorImageProperties', request)
}

export function subscribeEditorImageProperties(handler: (request: EditorImagePropertiesRequest) => void): () => void {
  const listener = handler as (payload: EditorInsertPayload | EditorImagePropertiesRequest) => void
  editorInsertBus.on('editorImageProperties', listener)
  return () => editorInsertBus.off('editorImageProperties', listener)
}
