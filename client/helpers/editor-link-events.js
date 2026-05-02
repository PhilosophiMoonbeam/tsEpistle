const EDITOR_LINK_TO_PAGE_EVENT = 'editorLinkToPage'

function emitEditorLinkToPage (root, opts) {
  root.$emit(EDITOR_LINK_TO_PAGE_EVENT, opts)
}

function onEditorLinkToPage (root, handler) {
  root.$on(EDITOR_LINK_TO_PAGE_EVENT, handler)
}

function offEditorLinkToPage (root, handler) {
  if (!handler) {
    return
  }

  root.$off(EDITOR_LINK_TO_PAGE_EVENT, handler)
}

module.exports = {
  EDITOR_LINK_TO_PAGE_EVENT,
  emitEditorLinkToPage,
  onEditorLinkToPage,
  offEditorLinkToPage
}
