import { createEventBus } from './simple-event-bus'
import type { PageConflictLatest } from './pages-api'

export const EDITOR_SAVE_CONFLICT_EVENT = 'saveConflict'
export const EDITOR_CONTENT_OVERWRITE_EVENT = 'overwriteEditorContent'
export const EDITOR_CONFLICT_RESET_EVENT = 'resetEditorConflict'

const editorConflictBus = createEventBus<[]>()
const editorConflictResetBus = createEventBus<[PageConflictLatest]>()

type EditorConflictHandler = () => void
type EditorConflictResetHandler = (baseline: PageConflictLatest) => void

export function emitEditorSaveConflict (): void {
  editorConflictBus.emit(EDITOR_SAVE_CONFLICT_EVENT)
}

export function emitEditorContentOverwrite (): void {
  editorConflictBus.emit(EDITOR_CONTENT_OVERWRITE_EVENT)
}

export function emitEditorConflictReset (baseline: PageConflictLatest): void {
  editorConflictResetBus.emit(EDITOR_CONFLICT_RESET_EVENT, baseline)
}

export function emitEditorConflictResolved (baseline: PageConflictLatest): void {
  emitEditorContentOverwrite()
  emitEditorConflictReset(baseline)
}

export function onEditorSaveConflict (handler?: EditorConflictHandler): void {
  editorConflictBus.on(EDITOR_SAVE_CONFLICT_EVENT, handler)
}

export function onEditorContentOverwrite (handler?: EditorConflictHandler): void {
  editorConflictBus.on(EDITOR_CONTENT_OVERWRITE_EVENT, handler)
}

export function onEditorConflictReset (handler?: EditorConflictResetHandler): void {
  editorConflictResetBus.on(EDITOR_CONFLICT_RESET_EVENT, handler)
}

export function offEditorSaveConflict (handler?: EditorConflictHandler): void {
  if (!handler) { return }
  editorConflictBus.off(EDITOR_SAVE_CONFLICT_EVENT, handler)
}

export function offEditorContentOverwrite (handler?: EditorConflictHandler): void {
  if (!handler) { return }
  editorConflictBus.off(EDITOR_CONTENT_OVERWRITE_EVENT, handler)
}

export function offEditorConflictReset (handler?: EditorConflictResetHandler): void {
  if (!handler) { return }
  editorConflictResetBus.off(EDITOR_CONFLICT_RESET_EVENT, handler)
}
