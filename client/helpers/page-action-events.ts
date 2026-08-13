import { createEventBus } from './simple-event-bus'

type PageActionHandler = () => void

export const PAGE_EDIT_EVENT = 'pageEdit'
export const PAGE_HISTORY_EVENT = 'pageHistory'
export const PAGE_SOURCE_EVENT = 'pageSource'
export const PAGE_CONVERT_EVENT = 'pageConvert'
export const PAGE_DUPLICATE_EVENT = 'pageDuplicate'
export const PAGE_MOVE_EVENT = 'pageMove'
export const PAGE_DELETE_EVENT = 'pageDelete'
const pageActionBus = createEventBus<[]>()

export function emitPageEdit (): void {
  pageActionBus.emit(PAGE_EDIT_EVENT)
}

export function emitPageHistory (): void {
  pageActionBus.emit(PAGE_HISTORY_EVENT)
}

export function emitPageSource (): void {
  pageActionBus.emit(PAGE_SOURCE_EVENT)
}

export function emitPageConvert (): void {
  pageActionBus.emit(PAGE_CONVERT_EVENT)
}

export function emitPageDuplicate (): void {
  pageActionBus.emit(PAGE_DUPLICATE_EVENT)
}

export function emitPageMove (): void {
  pageActionBus.emit(PAGE_MOVE_EVENT)
}

export function emitPageDelete (): void {
  pageActionBus.emit(PAGE_DELETE_EVENT)
}

export function onPageEdit (handler: PageActionHandler): void {
  pageActionBus.on(PAGE_EDIT_EVENT, handler)
}

export function onPageHistory (handler: PageActionHandler): void {
  pageActionBus.on(PAGE_HISTORY_EVENT, handler)
}

export function onPageSource (handler: PageActionHandler): void {
  pageActionBus.on(PAGE_SOURCE_EVENT, handler)
}

export function onPageConvert (handler: PageActionHandler): void {
  pageActionBus.on(PAGE_CONVERT_EVENT, handler)
}

export function onPageDuplicate (handler: PageActionHandler): void {
  pageActionBus.on(PAGE_DUPLICATE_EVENT, handler)
}

export function onPageMove (handler: PageActionHandler): void {
  pageActionBus.on(PAGE_MOVE_EVENT, handler)
}

export function onPageDelete (handler: PageActionHandler): void {
  pageActionBus.on(PAGE_DELETE_EVENT, handler)
}

export function offPageEdit (handler?: PageActionHandler): void {
  if (!handler) { return }
  pageActionBus.off(PAGE_EDIT_EVENT, handler)
}

export function offPageHistory (handler?: PageActionHandler): void {
  if (!handler) { return }
  pageActionBus.off(PAGE_HISTORY_EVENT, handler)
}

export function offPageSource (handler?: PageActionHandler): void {
  if (!handler) { return }
  pageActionBus.off(PAGE_SOURCE_EVENT, handler)
}

export function offPageConvert (handler?: PageActionHandler): void {
  if (!handler) { return }
  pageActionBus.off(PAGE_CONVERT_EVENT, handler)
}

export function offPageDuplicate (handler?: PageActionHandler): void {
  if (!handler) { return }
  pageActionBus.off(PAGE_DUPLICATE_EVENT, handler)
}

export function offPageMove (handler?: PageActionHandler): void {
  if (!handler) { return }
  pageActionBus.off(PAGE_MOVE_EVENT, handler)
}

export function offPageDelete (handler?: PageActionHandler): void {
  if (!handler) { return }
  pageActionBus.off(PAGE_DELETE_EVENT, handler)
}
