const SEARCH_ENTER_EVENT = 'searchEnter'
const SEARCH_MOVE_EVENT = 'searchMove'

function emitSearchEnter (root) {
  root.$emit(SEARCH_ENTER_EVENT, true)
}

function emitSearchMove (root, dir) {
  root.$emit(SEARCH_MOVE_EVENT, dir)
}

function onSearchEnter (root, handler) {
  root.$on(SEARCH_ENTER_EVENT, handler)
}

function onSearchMove (root, handler) {
  root.$on(SEARCH_MOVE_EVENT, handler)
}

function offSearchEnter (root, handler) {
  if (!handler) {
    return
  }
  root.$off(SEARCH_ENTER_EVENT, handler)
}

function offSearchMove (root, handler) {
  if (!handler) {
    return
  }
  root.$off(SEARCH_MOVE_EVENT, handler)
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
