import { createEventBus } from './simple-event-bus'

export const SEARCH_ENTER_EVENT = 'searchEnter'
export const SEARCH_MOVE_EVENT = 'searchMove'

const searchNavigationBus = createEventBus()

type SearchEnterHandler = (value: boolean) => void
type SearchMoveHandler = (dir: string) => void

export function emitSearchEnter (): void {
  searchNavigationBus.emit(SEARCH_ENTER_EVENT, true)
}

export function emitSearchMove (dir: string): void {
  searchNavigationBus.emit(SEARCH_MOVE_EVENT, dir)
}

export function onSearchEnter (handler?: SearchEnterHandler): void {
  searchNavigationBus.on(SEARCH_ENTER_EVENT, handler)
}

export function onSearchMove (handler?: SearchMoveHandler): void {
  searchNavigationBus.on(SEARCH_MOVE_EVENT, handler)
}

export function offSearchEnter (handler?: SearchEnterHandler): void {
  searchNavigationBus.off(SEARCH_ENTER_EVENT, handler)
}

export function offSearchMove (handler?: SearchMoveHandler): void {
  searchNavigationBus.off(SEARCH_MOVE_EVENT, handler)
}
