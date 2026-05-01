const EDITOR_SAVE_CONFLICT_EVENT = 'saveConflict'
const EDITOR_CONTENT_OVERWRITE_EVENT = 'overwriteEditorContent'
const EDITOR_CONFLICT_RESET_EVENT = 'resetEditorConflict'

function emitEditorSaveConflict (root) {
  root.$emit(EDITOR_SAVE_CONFLICT_EVENT)
}

function emitEditorContentOverwrite (root) {
  root.$emit(EDITOR_CONTENT_OVERWRITE_EVENT)
}

function emitEditorConflictReset (root) {
  root.$emit(EDITOR_CONFLICT_RESET_EVENT)
}

function emitEditorConflictResolved (root) {
  emitEditorContentOverwrite(root)
  emitEditorConflictReset(root)
}

function onEditorSaveConflict (root, handler) {
  root.$on(EDITOR_SAVE_CONFLICT_EVENT, handler)
}

function onEditorContentOverwrite (root, handler) {
  root.$on(EDITOR_CONTENT_OVERWRITE_EVENT, handler)
}

function onEditorConflictReset (root, handler) {
  root.$on(EDITOR_CONFLICT_RESET_EVENT, handler)
}

function offEditorSaveConflict (root, handler) {
  if (!handler) { return }
  root.$off(EDITOR_SAVE_CONFLICT_EVENT, handler)
}

function offEditorContentOverwrite (root, handler) {
  if (!handler) { return }
  root.$off(EDITOR_CONTENT_OVERWRITE_EVENT, handler)
}

function offEditorConflictReset (root, handler) {
  if (!handler) { return }
  root.$off(EDITOR_CONFLICT_RESET_EVENT, handler)
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
