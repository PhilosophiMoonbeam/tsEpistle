import { createEventBus } from './simple-event-bus'

export const SEARCH_ENTER_EVENT = 'searchEnter'
export const SEARCH_MOVE_EVENT = 'searchMove'
export const SEARCH_EXIT_EVENT = 'searchExit'

const searchEnterBus = createEventBus<[boolean]>()
const searchMoveBus = createEventBus<[string]>()
const searchExitBus = createEventBus<[boolean]>()

type SearchEnterHandler = (value: boolean) => void
type SearchMoveHandler = (dir: string) => void
type SearchExitHandler = (restoreFocus: boolean) => void

export function emitSearchEnter(): void {
  searchEnterBus.emit(SEARCH_ENTER_EVENT, true)
}

export function emitSearchMove(dir: string): void {
  searchMoveBus.emit(SEARCH_MOVE_EVENT, dir)
}

export function emitSearchExit(restoreFocus: boolean): void {
  searchExitBus.emit(SEARCH_EXIT_EVENT, restoreFocus)
}

export function onSearchEnter(handler?: SearchEnterHandler): void {
  searchEnterBus.on(SEARCH_ENTER_EVENT, handler)
}

export function onSearchMove(handler?: SearchMoveHandler): void {
  searchMoveBus.on(SEARCH_MOVE_EVENT, handler)
}

export function onSearchExit(handler?: SearchExitHandler): void {
  searchExitBus.on(SEARCH_EXIT_EVENT, handler)
}

export function offSearchEnter(handler?: SearchEnterHandler): void {
  searchEnterBus.off(SEARCH_ENTER_EVENT, handler)
}

export function offSearchMove(handler?: SearchMoveHandler): void {
  searchMoveBus.off(SEARCH_MOVE_EVENT, handler)
}

export function offSearchExit(handler?: SearchExitHandler): void {
  searchExitBus.off(SEARCH_EXIT_EVENT, handler)
}
