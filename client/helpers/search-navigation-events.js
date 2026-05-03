const { createEventBus } = require('./simple-event-bus')

const SEARCH_ENTER_EVENT = 'searchEnter'
const SEARCH_MOVE_EVENT = 'searchMove'
const searchNavigationBus = createEventBus()

function emitSearchEnter () {
  searchNavigationBus.emit(SEARCH_ENTER_EVENT, true)
}

function emitSearchMove (dir) {
  searchNavigationBus.emit(SEARCH_MOVE_EVENT, dir)
}

function onSearchEnter (handler) {
  searchNavigationBus.on(SEARCH_ENTER_EVENT, handler)
}

function onSearchMove (handler) {
  searchNavigationBus.on(SEARCH_MOVE_EVENT, handler)
}

function offSearchEnter (handler) {
  searchNavigationBus.off(SEARCH_ENTER_EVENT, handler)
}

function offSearchMove (handler) {
  searchNavigationBus.off(SEARCH_MOVE_EVENT, handler)
}

module.exports = {
  SEARCH_ENTER_EVENT,
  SEARCH_MOVE_EVENT,
  emitSearchEnter,
  emitSearchMove,
  onSearchEnter,
  onSearchMove,
  offSearchEnter,
  offSearchMove
}
