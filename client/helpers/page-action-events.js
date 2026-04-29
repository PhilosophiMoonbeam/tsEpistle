const PAGE_EDIT_EVENT = 'pageEdit'
const PAGE_HISTORY_EVENT = 'pageHistory'
const PAGE_SOURCE_EVENT = 'pageSource'
const PAGE_CONVERT_EVENT = 'pageConvert'
const PAGE_DUPLICATE_EVENT = 'pageDuplicate'
const PAGE_MOVE_EVENT = 'pageMove'
const PAGE_DELETE_EVENT = 'pageDelete'

function emitPageEdit (root) {
  root.$emit(PAGE_EDIT_EVENT)
}

function emitPageHistory (root) {
  root.$emit(PAGE_HISTORY_EVENT)
}

function emitPageSource (root) {
  root.$emit(PAGE_SOURCE_EVENT)
}

function emitPageConvert (root) {
  root.$emit(PAGE_CONVERT_EVENT)
}

function emitPageDuplicate (root) {
  root.$emit(PAGE_DUPLICATE_EVENT)
}

function emitPageMove (root) {
  root.$emit(PAGE_MOVE_EVENT)
}

function emitPageDelete (root) {
  root.$emit(PAGE_DELETE_EVENT)
}

function onPageEdit (root, handler) {
  root.$on(PAGE_EDIT_EVENT, handler)
}

function onPageHistory (root, handler) {
  root.$on(PAGE_HISTORY_EVENT, handler)
}

function onPageSource (root, handler) {
  root.$on(PAGE_SOURCE_EVENT, handler)
}

function onPageConvert (root, handler) {
  root.$on(PAGE_CONVERT_EVENT, handler)
}

function onPageDuplicate (root, handler) {
  root.$on(PAGE_DUPLICATE_EVENT, handler)
}

function onPageMove (root, handler) {
  root.$on(PAGE_MOVE_EVENT, handler)
}

function onPageDelete (root, handler) {
  root.$on(PAGE_DELETE_EVENT, handler)
}

function offPageEdit (root, handler) {
  if (!handler) { return }
  root.$off(PAGE_EDIT_EVENT, handler)
}

function offPageHistory (root, handler) {
  if (!handler) { return }
  root.$off(PAGE_HISTORY_EVENT, handler)
}

function offPageSource (root, handler) {
  if (!handler) { return }
  root.$off(PAGE_SOURCE_EVENT, handler)
}

function offPageConvert (root, handler) {
  if (!handler) { return }
  root.$off(PAGE_CONVERT_EVENT, handler)
}

function offPageDuplicate (root, handler) {
  if (!handler) { return }
  root.$off(PAGE_DUPLICATE_EVENT, handler)
}

function offPageMove (root, handler) {
  if (!handler) { return }
  root.$off(PAGE_MOVE_EVENT, handler)
}

function offPageDelete (root, handler) {
  if (!handler) { return }
  root.$off(PAGE_DELETE_EVENT, handler)
}

module.exports = {
  PAGE_EDIT_EVENT,
  PAGE_HISTORY_EVENT,
  PAGE_SOURCE_EVENT,
  PAGE_CONVERT_EVENT,
  PAGE_DUPLICATE_EVENT,
  PAGE_MOVE_EVENT,
  PAGE_DELETE_EVENT,
  emitPageEdit,
  emitPageHistory,
  emitPageSource,
  emitPageConvert,
  emitPageDuplicate,
  emitPageMove,
  emitPageDelete,
  onPageEdit,
  onPageHistory,
  onPageSource,
  onPageConvert,
  onPageDuplicate,
  onPageMove,
  onPageDelete,
  offPageEdit,
  offPageHistory,
  offPageSource,
  offPageConvert,
  offPageDuplicate,
  offPageMove,
  offPageDelete
}
