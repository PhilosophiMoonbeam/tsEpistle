import { createEventBus } from './simple-event-bus'

export const EDITOR_SAVE_CONFLICT_EVENT = 'saveConflict'
export const EDITOR_CONTENT_OVERWRITE_EVENT = 'overwriteEditorContent'
export const EDITOR_CONFLICT_RESET_EVENT = 'resetEditorConflict'

const editorConflictBus = createEventBus()

type EditorConflictHandler = () => void

export function emitEditorSaveConflict (): void {
  editorConflictBus.emit(EDITOR_SAVE_CONFLICT_EVENT)
}

export function emitEditorContentOverwrite (): void {
  editorConflictBus.emit(EDITOR_CONTENT_OVERWRITE_EVENT)
}

export function emitEditorConflictReset (): void {
  editorConflictBus.emit(EDITOR_CONFLICT_RESET_EVENT)
}

export function emitEditorConflictResolved (): void {
  emitEditorContentOverwrite()
  emitEditorConflictReset()
}

export function onEditorSaveConflict (handler?: EditorConflictHandler): void {
  editorConflictBus.on(EDITOR_SAVE_CONFLICT_EVENT, handler)
}

export function onEditorContentOverwrite (handler?: EditorConflictHandler): void {
  editorConflictBus.on(EDITOR_CONTENT_OVERWRITE_EVENT, handler)
}

export function onEditorConflictReset (handler?: EditorConflictHandler): void {
  editorConflictBus.on(EDITOR_CONFLICT_RESET_EVENT, handler)
}

export function offEditorSaveConflict (handler?: EditorConflictHandler): void {
  if (!handler) { return }
  editorConflictBus.off(EDITOR_SAVE_CONFLICT_EVENT, handler)
}

export function offEditorContentOverwrite (handler?: EditorConflictHandler): void {
  if (!handler) { return }
  editorConflictBus.off(EDITOR_CONTENT_OVERWRITE_EVENT, handler)
}

export function offEditorConflictReset (handler?: EditorConflictHandler): void {
  if (!handler) { return }
  editorConflictBus.off(EDITOR_CONFLICT_RESET_EVENT, handler)
}
