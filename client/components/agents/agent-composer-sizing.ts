export interface ComposerSizing {
  readonly height: number
  readonly overflowing: boolean
}

export const calculateComposerSizing = (contentHeight: number, minHeight: number, maxHeight: number): ComposerSizing => {
  const height = Math.min(Math.max(contentHeight, minHeight), maxHeight)
  return { height, overflowing: contentHeight > maxHeight }
}

export interface CaretBounds {
  readonly top: number
  readonly bottom: number
}

export const caretBoundsFromMirror = (caretTop: number, mirrorTop: number, caretHeight: number, lineHeight: number): CaretBounds => {
  const top = caretTop - mirrorTop
  return { top, bottom: top + Math.max(caretHeight, lineHeight) }
}

export interface CaretScrollInput {
  readonly scrollTop: number
  readonly clientHeight: number
  readonly scrollHeight: number
  readonly paddingTop: number
  readonly paddingBottom: number
  readonly caret: CaretBounds
}

export const scrollTopForCaret = ({ scrollTop, clientHeight, scrollHeight, paddingTop, paddingBottom, caret }: CaretScrollInput): number => {
  const visibleTop = scrollTop + paddingTop
  const visibleBottom = scrollTop + clientHeight - paddingBottom
  if (caret.top < visibleTop) return Math.max(0, caret.top - paddingTop)
  if (caret.bottom > visibleBottom) return Math.min(scrollHeight - clientHeight, caret.bottom - clientHeight + paddingBottom)
  return scrollTop
}
