const Vue = require('vue')

const EDITOR_SAVE_CONFLICT_EVENT = 'saveConflict'
const EDITOR_CONTENT_OVERWRITE_EVENT = 'overwriteEditorContent'
const EDITOR_CONFLICT_RESET_EVENT = 'resetEditorConflict'

const editorConflictBus = new Vue()

function emitEditorSaveConflict () {
  editorConflictBus.$emit(EDITOR_SAVE_CONFLICT_EVENT)
}

function emitEditorContentOverwrite () {
  editorConflictBus.$emit(EDITOR_CONTENT_OVERWRITE_EVENT)
}

function emitEditorConflictReset () {
  editorConflictBus.$emit(EDITOR_CONFLICT_RESET_EVENT)
}

function emitEditorConflictResolved () {
  emitEditorContentOverwrite()
  emitEditorConflictReset()
}

function onEditorSaveConflict (handler) {
  editorConflictBus.$on(EDITOR_SAVE_CONFLICT_EVENT, handler)
}

function onEditorContentOverwrite (handler) {
  editorConflictBus.$on(EDITOR_CONTENT_OVERWRITE_EVENT, handler)
}

function onEditorConflictReset (handler) {
  editorConflictBus.$on(EDITOR_CONFLICT_RESET_EVENT, handler)
}

function offEditorSaveConflict (handler) {
  if (!handler) { return }
  editorConflictBus.$off(EDITOR_SAVE_CONFLICT_EVENT, handler)
}

function offEditorContentOverwrite (handler) {
  if (!handler) { return }
  editorConflictBus.$off(EDITOR_CONTENT_OVERWRITE_EVENT, handler)
}

function offEditorConflictReset (handler) {
  if (!handler) { return }
  editorConflictBus.$off(EDITOR_CONFLICT_RESET_EVENT, handler)
}

module.exports = {
  EDITOR_SAVE_CONFLICT_EVENT,
  EDITOR_CONTENT_OVERWRITE_EVENT,
  EDITOR_CONFLICT_RESET_EVENT,
  emitEditorSaveConflict,
  emitEditorContentOverwrite,
  emitEditorConflictReset,
  emitEditorConflictResolved,
  onEditorSaveConflict,
  onEditorContentOverwrite,
  onEditorConflictReset,
  offEditorSaveConflict,
  offEditorContentOverwrite,
  offEditorConflictReset
}
