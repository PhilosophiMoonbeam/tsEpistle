import { createEventBus } from './simple-event-bus'

export const EDITOR_LINK_TO_PAGE_EVENT = 'editorLinkToPage'
const editorLinkBus = createEventBus()

type EditorLinkPayload = {
  locale?: string
  path?: string
  [key: string]: unknown
}

type EditorLinkHandler = (opts: EditorLinkPayload) => void

export function emitEditorLinkToPage (opts: EditorLinkPayload): void {
  editorLinkBus.emit(EDITOR_LINK_TO_PAGE_EVENT, opts)
}

export function onEditorLinkToPage (handler?: EditorLinkHandler): void {
  editorLinkBus.on(EDITOR_LINK_TO_PAGE_EVENT, handler)
}

export function offEditorLinkToPage (handler?: EditorLinkHandler): void {
  editorLinkBus.off(EDITOR_LINK_TO_PAGE_EVENT, handler)
}
