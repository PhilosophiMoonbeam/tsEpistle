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

export type ReaderPageIdentity = {
  pageId: number
  locale: string
  path: string
  visibility: 'public' | 'private'
  sourceRevision: string
}

export type ReaderPageAction = 'print' | 'fullWidth' | 'watch' | 'watchSettings' | 'approval' | 'protection'

export type ReaderPageActionAvailability = {
  visible: boolean
  enabled: boolean
  active?: boolean
  blockedReason?: string
}

export type ReaderPageActionsState = {
  page: ReaderPageIdentity
  ready: boolean
  blockedReason?: string
  actions: Partial<Record<ReaderPageAction, ReaderPageActionAvailability>>
}

export type ReaderPageActionsRequest = {
  page: ReaderPageIdentity
  reply: (state: ReaderPageActionsState) => void
}

export type ReaderPageActionRequest = {
  page: ReaderPageIdentity
  action: ReaderPageAction
  returnFocusTo: HTMLElement | null
}

type ReaderPageActionsRequestHandler = (request: ReaderPageActionsRequest) => void
type ReaderPageActionRequestHandler = (request: ReaderPageActionRequest) => void
const READER_PAGE_ACTIONS_REQUEST_EVENT = 'readerPageActionsRequest'
const READER_PAGE_ACTIONS_CHANGED_EVENT = 'readerPageActionsChanged'
const READER_PAGE_ACTION_EVENT = 'readerPageAction'
const readerPageActionsRequestBus = createEventBus<[ReaderPageActionsRequest]>()
const readerPageActionBus = createEventBus<[ReaderPageActionRequest]>()

export function sameReaderPageIdentity (left: ReaderPageIdentity, right: ReaderPageIdentity): boolean {
  return left.pageId === right.pageId &&
    left.locale === right.locale &&
    left.path === right.path &&
    left.visibility === right.visibility &&
    left.sourceRevision === right.sourceRevision
}

// Query the mounted reader rather than keeping a second copy of its authority,
// watch state or layout preferences in the header.
export function getReaderPageActions (page: ReaderPageIdentity): ReaderPageActionsState | null {
  let state: ReaderPageActionsState | null = null
  readerPageActionsRequestBus.emit(READER_PAGE_ACTIONS_REQUEST_EVENT, {
    page,
    reply: current => {
      if (sameReaderPageIdentity(page, current.page)) state = current
    }
  })
  return state
}

export function onReaderPageActionsRequest (handler: ReaderPageActionsRequestHandler): void {
  readerPageActionsRequestBus.on(READER_PAGE_ACTIONS_REQUEST_EVENT, handler)
}

export function offReaderPageActionsRequest (handler?: ReaderPageActionsRequestHandler): void {
  if (!handler) { return }
  readerPageActionsRequestBus.off(READER_PAGE_ACTIONS_REQUEST_EVENT, handler)
}

// Readers announce availability changes after registering, when their reactive
// gates change, and after unregistering. Listeners always request fresh state.
export function emitReaderPageActionsChanged (): void {
  pageActionBus.emit(READER_PAGE_ACTIONS_CHANGED_EVENT)
}

export function onReaderPageActionsChanged (handler: PageActionHandler): void {
  pageActionBus.on(READER_PAGE_ACTIONS_CHANGED_EVENT, handler)
}

export function offReaderPageActionsChanged (handler?: PageActionHandler): void {
  if (!handler) { return }
  pageActionBus.off(READER_PAGE_ACTIONS_CHANGED_EVENT, handler)
}

export function emitReaderPageAction (request: ReaderPageActionRequest): void {
  const state = getReaderPageActions(request.page)
  const action = state?.actions[request.action]
  if (!state?.ready || !action?.visible || !action.enabled) return
  readerPageActionBus.emit(READER_PAGE_ACTION_EVENT, request)
}

export function onReaderPageAction (handler: ReaderPageActionRequestHandler): void {
  readerPageActionBus.on(READER_PAGE_ACTION_EVENT, handler)
}

export function offReaderPageAction (handler?: ReaderPageActionRequestHandler): void {
  if (!handler) { return }
  readerPageActionBus.off(READER_PAGE_ACTION_EVENT, handler)
}
