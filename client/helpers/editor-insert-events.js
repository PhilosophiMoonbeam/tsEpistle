const { createEventBus } = require('./simple-event-bus')

const EDITOR_INSERT_EVENT = 'editorInsert'
const editorInsertBus = createEventBus()

function emitEditorInsert (opts) {
  editorInsertBus.emit(EDITOR_INSERT_EVENT, opts)
}

function onEditorInsert (handler) {
  editorInsertBus.on(EDITOR_INSERT_EVENT, handler)
}

function offEditorInsert (handler) {
  if (!handler) { return }
  editorInsertBus.off(EDITOR_INSERT_EVENT, handler)
}

module.exports = {
  EDITOR_INSERT_EVENT,
  emitEditorInsert,
  onEditorInsert,
  offEditorInsert
}
