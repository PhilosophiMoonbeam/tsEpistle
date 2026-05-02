const EDITOR_INSERT_EVENT = 'editorInsert'

function emitEditorInsert (root, opts) {
  root.$emit(EDITOR_INSERT_EVENT, opts)
}

function onEditorInsert (root, handler) {
  root.$on(EDITOR_INSERT_EVENT, handler)
}

function offEditorInsert (root, handler) {
  if (!handler) { return }
  root.$off(EDITOR_INSERT_EVENT, handler)
}

module.exports = {
  EDITOR_INSERT_EVENT,
  emitEditorInsert,
  onEditorInsert,
  offEditorInsert
}
