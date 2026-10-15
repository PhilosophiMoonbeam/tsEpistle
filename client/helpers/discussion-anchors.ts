import type { DiscussionAnnotationAnchor } from '../../shared/discussion-annotations.ts'

export const normalizeDiscussionQuote = (text: string): string => text.normalize('NFC').replace(/\s+/gu, ' ').trim()
export type DiscussionAnchorMatch = { status: 'found'; start: number; end: number } | { status: 'missing' | 'ambiguous' }
export function locateDiscussionAnchor(
  text: string,
  anchor: DiscussionAnnotationAnchor,
  headingAt: (offset: number) => string | null = () => null
): DiscussionAnchorMatch {
  const exact = normalizeDiscussionQuote(anchor.exact)
  if (!exact) return { status: 'missing' }
  const candidates: number[] = []
  for (let offset = text.indexOf(exact); offset >= 0; offset = text.indexOf(exact, offset + 1)) candidates.push(offset)
  if (!candidates.length) return { status: 'missing' }
  let surviving = candidates
  if (surviving.length > 1) {
    const prefix = anchor.prefix.normalize('NFC').replace(/\s+/gu, ' ')
    const suffix = anchor.suffix.normalize('NFC').replace(/\s+/gu, ' ')
    if (prefix || suffix) {
      const contextual = surviving.filter(
        offset => (!prefix || text.slice(0, offset).endsWith(prefix)) && (!suffix || text.slice(offset + exact.length).startsWith(suffix))
      )
      if (contextual.length) surviving = contextual
    }
    if (surviving.length > 1 && anchor.heading) {
      const headed = surviving.filter(offset => normalizeDiscussionQuote(headingAt(offset) ?? '') === normalizeDiscussionQuote(anchor.heading!))
      if (headed.length) surviving = headed
    }
  }
  // An old offset is never authority to choose between repeated surviving quotes.
  return surviving.length === 1 ? { status: 'found', start: surviving[0]!, end: surviving[0]! + exact.length } : { status: 'ambiguous' }
}

type Point = { node: Text; start: number; end: number; heading: string | null }
export interface DiscussionTextIndex {
  text: string
  points: Point[]
  root: HTMLElement
}
const excluded: Record<string, true> = {
  SCRIPT: true,
  STYLE: true,
  NOSCRIPT: true,
  CODE: true,
  PRE: true,
  BUTTON: true,
  INPUT: true,
  TEXTAREA: true,
  SELECT: true,
  OPTION: true,
  SVG: true,
  MATH: true,
  CANVAS: true,
  IFRAME: true,
  VIDEO: true,
  AUDIO: true
}
const blocks: Record<string, true> = {
  P: true,
  DIV: true,
  LI: true,
  UL: true,
  OL: true,
  BLOCKQUOTE: true,
  H1: true,
  H2: true,
  H3: true,
  H4: true,
  H5: true,
  H6: true,
  TR: true,
  TD: true,
  TH: true,
  BR: true,
  HR: true,
  SECTION: true,
  ARTICLE: true
}
export function indexDiscussionText(root: HTMLElement): DiscussionTextIndex {
  let text = '',
    heading: string | null = null,
    pendingSpace = false
  const points: Point[] = []
  const walk = (element: Node): void => {
    if (element.nodeType === 1) {
      const el = element as HTMLElement
      if (excluded[el.tagName] || el.hidden || el.getAttribute('aria-hidden') === 'true' || el.isContentEditable || el.tagName.includes('-')) return
      if (blocks[el.tagName]) pendingSpace = text.length > 0
      if (/^H[1-6]$/.test(el.tagName)) heading = normalizeDiscussionQuote(el.textContent ?? '').slice(0, 255) || null
      for (const child of el.childNodes) walk(child)
      if (blocks[el.tagName]) pendingSpace = text.length > 0
      return
    }
    if (element.nodeType !== 3) return
    const node = element as Text
    for (const match of node.data.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
      const raw = match[0],
        start = match.index!,
        end = start + raw.length
      if (/^\s+$/u.test(raw)) {
        pendingSpace = text.length > 0
        continue
      }
      if (pendingSpace && text.length) {
        text += ' '
        points.push({ node, start, end: start, heading })
      }
      pendingSpace = false
      const normalized = raw.normalize('NFC')
      text += normalized
      for (let i = 0; i < normalized.length; i++) points.push({ node, start, end, heading })
    }
  }
  walk(root)
  return { root, text, points }
}
export function discussionAnchorRange(
  index: DiscussionTextIndex,
  anchor: DiscussionAnnotationAnchor
): { status: 'found'; range: Range } | { status: 'missing' | 'ambiguous' } {
  const match = locateDiscussionAnchor(index.text, anchor, offset => index.points[offset]?.heading ?? null)
  if (match.status !== 'found') return match
  const start = index.points[match.start],
    end = index.points[match.end - 1]
  if (!start || !end || !index.root.contains(start.node) || !index.root.contains(end.node)) return { status: 'missing' }
  const range = index.root.ownerDocument.createRange()
  range.setStart(start.node, start.start)
  range.setEnd(end.node, end.end)
  return { status: 'found', range }
}
export function captureDiscussionAnchor(root: HTMLElement, selection: Selection | null): DiscussionAnnotationAnchor | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const index = indexDiscussionText(root)
  let start = -1,
    end = -1
  const piece = root.ownerDocument.createRange()
  for (let i = 0; i < index.points.length; i++) {
    const point = index.points[i]!
    if (point.start === point.end) continue
    piece.setStart(point.node, point.start)
    piece.setEnd(point.node, point.end)
    // Compare real range boundaries, not user-authored attributes or IDs.
    if (range.compareBoundaryPoints(range.END_TO_START, piece) < 0 && range.compareBoundaryPoints(range.START_TO_END, piece) > 0) {
      if (start < 0) start = i
      end = i + 1
    }
  }
  if (start < 0 || end <= start) return null
  const exact = index.text.slice(start, end).trim()
  if (!exact || exact.length > 1000 || normalizeDiscussionQuote(range.toString()).replace(/\s/gu, '') !== exact.replace(/\s/gu, '')) return null
  return {
    exact,
    prefix: index.text.slice(Math.max(0, start - 64), start),
    suffix: index.text.slice(end, end + 64),
    heading: index.points[start]?.heading ?? null,
    offset: start
  }
}
