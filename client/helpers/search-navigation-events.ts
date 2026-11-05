import { createEventBus } from './simple-event-bus'
import { shallowRef } from 'vue'

export const SEARCH_ENTER_EVENT = 'searchEnter'
export const SEARCH_MOVE_EVENT = 'searchMove'
export const SEARCH_EXIT_EVENT = 'searchExit'
export const SEARCH_FOCUS_EVENT = 'searchFocus'

const searchEnterBus = createEventBus<[boolean]>()
const searchMoveBus = createEventBus<[string]>()
const searchExitBus = createEventBus<[boolean]>()
const searchFocusBus = createEventBus<[]>()

type SearchEnterHandler = (value: boolean) => void
type SearchMoveHandler = (dir: string) => void
type SearchExitHandler = (restoreFocus: boolean) => void
type SearchFocusHandler = () => void

export type SearchQuickCreateBridge = {
  canCreate: () => boolean
  open: () => boolean
}

export type SearchAgentExitIntent = 'close' | 'search'
/** Null leaves the intent to the caller; a promise owns it even when Stay resolves false. */
export type SearchAgentExitBridge = (intent: SearchAgentExitIntent) => Promise<boolean> | null

let searchAgentExit: SearchAgentExitBridge | null = null

export function registerSearchAgentExit(bridge: SearchAgentExitBridge): () => void {
  searchAgentExit = bridge
  return () => {
    if (searchAgentExit === bridge) searchAgentExit = null
  }
}

export function requestSearchAgentExit(intent: SearchAgentExitIntent): Promise<boolean> | null {
  return searchAgentExit?.(intent) ?? null
}

const searchQuickCreate = shallowRef<SearchQuickCreateBridge | null>(null)

export function registerSearchQuickCreate(bridge: SearchQuickCreateBridge): () => void {
  searchQuickCreate.value = bridge
  return () => {
    if (searchQuickCreate.value === bridge) searchQuickCreate.value = null
  }
}

export function canSearchQuickCreate(): boolean {
  return searchQuickCreate.value?.canCreate() === true
}

export function requestSearchQuickCreate(): boolean {
  const bridge = searchQuickCreate.value
  return bridge?.canCreate() === true && bridge.open()
}

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

export function emitSearchFocus(): void {
  searchFocusBus.emit(SEARCH_FOCUS_EVENT)
}

export function onSearchFocus(handler?: SearchFocusHandler): void {
  searchFocusBus.on(SEARCH_FOCUS_EVENT, handler)
}

export function offSearchFocus(handler?: SearchFocusHandler): void {
  searchFocusBus.off(SEARCH_FOCUS_EVENT, handler)
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
