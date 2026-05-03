const Vue = require('vue')

const PAGE_EDIT_EVENT = 'pageEdit'
const PAGE_HISTORY_EVENT = 'pageHistory'
const PAGE_SOURCE_EVENT = 'pageSource'
const PAGE_CONVERT_EVENT = 'pageConvert'
const PAGE_DUPLICATE_EVENT = 'pageDuplicate'
const PAGE_MOVE_EVENT = 'pageMove'
const PAGE_DELETE_EVENT = 'pageDelete'
const pageActionBus = new Vue()

function emitPageEdit () {
  pageActionBus.$emit(PAGE_EDIT_EVENT)
}

function emitPageHistory () {
  pageActionBus.$emit(PAGE_HISTORY_EVENT)
}

function emitPageSource () {
  pageActionBus.$emit(PAGE_SOURCE_EVENT)
}

function emitPageConvert () {
  pageActionBus.$emit(PAGE_CONVERT_EVENT)
}

function emitPageDuplicate () {
  pageActionBus.$emit(PAGE_DUPLICATE_EVENT)
}

function emitPageMove () {
  pageActionBus.$emit(PAGE_MOVE_EVENT)
}

function emitPageDelete () {
  pageActionBus.$emit(PAGE_DELETE_EVENT)
}

function onPageEdit (handler) {
  pageActionBus.$on(PAGE_EDIT_EVENT, handler)
}

function onPageHistory (handler) {
  pageActionBus.$on(PAGE_HISTORY_EVENT, handler)
}

function onPageSource (handler) {
  pageActionBus.$on(PAGE_SOURCE_EVENT, handler)
}

function onPageConvert (handler) {
  pageActionBus.$on(PAGE_CONVERT_EVENT, handler)
}

function onPageDuplicate (handler) {
  pageActionBus.$on(PAGE_DUPLICATE_EVENT, handler)
}

function onPageMove (handler) {
  pageActionBus.$on(PAGE_MOVE_EVENT, handler)
}

function onPageDelete (handler) {
  pageActionBus.$on(PAGE_DELETE_EVENT, handler)
}

function offPageEdit (handler) {
  if (!handler) { return }
  pageActionBus.$off(PAGE_EDIT_EVENT, handler)
}

function offPageHistory (handler) {
  if (!handler) { return }
  pageActionBus.$off(PAGE_HISTORY_EVENT, handler)
}

function offPageSource (handler) {
  if (!handler) { return }
  pageActionBus.$off(PAGE_SOURCE_EVENT, handler)
}

function offPageConvert (handler) {
  if (!handler) { return }
  pageActionBus.$off(PAGE_CONVERT_EVENT, handler)
}

function offPageDuplicate (handler) {
  if (!handler) { return }
  pageActionBus.$off(PAGE_DUPLICATE_EVENT, handler)
}

function offPageMove (handler) {
  if (!handler) { return }
  pageActionBus.$off(PAGE_MOVE_EVENT, handler)
}

function offPageDelete (handler) {
  if (!handler) { return }
  pageActionBus.$off(PAGE_DELETE_EVENT, handler)
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
