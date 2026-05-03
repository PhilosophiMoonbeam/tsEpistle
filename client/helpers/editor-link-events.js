const { createEventBus } = require('./simple-event-bus')

const EDITOR_LINK_TO_PAGE_EVENT = 'editorLinkToPage'
const editorLinkBus = createEventBus()

function emitEditorLinkToPage (opts) {
  editorLinkBus.emit(EDITOR_LINK_TO_PAGE_EVENT, opts)
}

function onEditorLinkToPage (handler) {
  editorLinkBus.on(EDITOR_LINK_TO_PAGE_EVENT, handler)
}

function offEditorLinkToPage (handler) {
  editorLinkBus.off(EDITOR_LINK_TO_PAGE_EVENT, handler)
}

module.exports = {
  EDITOR_LINK_TO_PAGE_EVENT,
  emitEditorLinkToPage,
  onEditorLinkToPage,
  offEditorLinkToPage
}
