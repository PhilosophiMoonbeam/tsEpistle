/**
 * Placement for the page utility tooltips. The tools card has no free space that
 * is the same in every layout, so the tooltip is measured when it opens and put on
 * the first side of the card where it covers no content: above, below, then beside
 * (the wider gutter first). If every side covers something, the side that covers
 * the least wins. Coordinates are viewport pixels.
 */

export interface PlacementRect {
  left: number
  top: number
  right: number
  bottom: number
}

export type UtilityTooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface UtilityTooltipPlacementInput {
  card: PlacementRect
  activator: PlacementRect
  size: { width: number; height: number }
  viewport: { width: number; height: number }
  /** True when the point shows page content (text, a control, a card, the top bar). */
  isContentAt: (x: number, y: number) => boolean
  gap?: number
  margin?: number
  step?: number
}

export interface UtilityTooltipPlacement {
  side: UtilityTooltipSide
  /** Vuetify `location` relative to the card. */
  location: 'top left' | 'bottom left' | 'right top' | 'left top'
  /** Vuetify `offset`: [distance from the card, shift along the card edge]. */
  offset: [number, number]
  rect: PlacementRect
  coversContent: boolean
}

// Same as the Vuetify overlay default, so Vuetify never shifts or flips the result.
export const UTILITY_TOOLTIP_MARGIN = 12
export const UTILITY_TOOLTIP_GAP = 6
// Wide enough for a label plus a one-line reason inside the 326px desktop rail.
export const UTILITY_TOOLTIP_MAX_WIDTH = 320

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), Math.max(min, max))

const samplePoints = (rect: PlacementRect, step: number): Array<[number, number]> => {
  const axis = (start: number, end: number): number[] => {
    const values: number[] = []
    for (let value = start + 1; value < end - 1; value += step) values.push(value)
    values.push(end - 1)
    return values
  }
  const xs = axis(rect.left, rect.right)
  const ys = axis(rect.top, rect.bottom)
  return ys.flatMap(y => xs.map(x => [x, y] as [number, number]))
}

const coveredPoints = (rect: PlacementRect, input: UtilityTooltipPlacementInput, step: number, stopAtFirst: boolean): number => {
  let covered = 0
  for (const [x, y] of samplePoints(rect, step)) {
    if (!input.isContentAt(x, y)) continue
    covered += 1
    if (stopAtFirst) return covered
  }
  return covered
}

export const chooseUtilityTooltipPlacement = (input: UtilityTooltipPlacementInput): UtilityTooltipPlacement => {
  const gap = input.gap ?? UTILITY_TOOLTIP_GAP
  const margin = input.margin ?? UTILITY_TOOLTIP_MARGIN
  const step = input.step ?? 10
  const { card, activator, viewport } = input
  const width = Math.ceil(input.size.width)
  const height = Math.ceil(input.size.height)

  // Centered on the hovered button, kept inside the card's column when it fits.
  const centerX = (activator.left + activator.right) / 2
  const centerY = (activator.top + activator.bottom) / 2
  const minX = width <= card.right - card.left ? Math.max(card.left, margin) : margin
  const maxX = (width <= card.right - card.left ? Math.min(card.right, viewport.width - margin) : viewport.width - margin) - width
  const left = clamp(Math.round(centerX - width / 2), minX, maxX)
  const top = clamp(Math.round(centerY - height / 2), margin, viewport.height - margin - height)

  const rightGutter = viewport.width - card.right
  const leftGutter = card.left
  const sides: UtilityTooltipSide[] = ['top', 'bottom', ...(rightGutter >= leftGutter ? (['right', 'left'] as const) : (['left', 'right'] as const))]

  const candidates = sides.map(side => {
    const rect: PlacementRect =
      side === 'top'
        ? { left, top: card.top - gap - height, right: left + width, bottom: card.top - gap }
        : side === 'bottom'
          ? { left, top: card.bottom + gap, right: left + width, bottom: card.bottom + gap + height }
          : side === 'right'
            ? { left: card.right + gap, top, right: card.right + gap + width, bottom: top + height }
            : { left: card.left - gap - width, top, right: card.left - gap, bottom: top + height }
    const inViewport = rect.left >= margin && rect.top >= margin && rect.right <= viewport.width - margin && rect.bottom <= viewport.height - margin
    return { side, rect, inViewport }
  })

  const toPlacement = (candidate: (typeof candidates)[number], coversContent: boolean): UtilityTooltipPlacement => {
    const { side, rect } = candidate
    if (side === 'top' || side === 'bottom') {
      return { side, location: side === 'top' ? 'top left' : 'bottom left', offset: [gap, card.left - rect.left], rect, coversContent }
    }
    return { side, location: side === 'right' ? 'right top' : 'left top', offset: [gap, card.top - rect.top], rect, coversContent }
  }

  const visible = candidates.filter(candidate => candidate.inViewport)
  for (const candidate of visible) {
    if (coveredPoints(candidate.rect, input, step, true) === 0) return toPlacement(candidate, false)
  }
  // Nothing is free: cover as little as possible (ties keep the order above).
  const pool = visible.length > 0 ? visible : candidates.filter(candidate => candidate.side === 'bottom')
  let best = pool[0]!
  let bestCovered = Number.POSITIVE_INFINITY
  for (const candidate of pool) {
    const covered = coveredPoints(candidate.rect, input, step, false)
    if (covered < bestCovered) {
      best = candidate
      bestCovered = covered
    }
  }
  return toPlacement(best, true)
}

/** Elements that count as content when a tooltip would cover them. */
export const UTILITY_TOOLTIP_CONTENT_SELECTOR = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'a', 'button', 'input', 'textarea', 'select', 'label',
  'img', 'svg', 'video', 'canvas', 'code', 'pre', 'table', 'blockquote', 'figure', 'summary',
  '[role="button"]', '[role="link"]', '[role="tab"]',
  '.v-btn', '.v-chip', '.v-card', '.v-field', '.v-list', '.v-alert', '.v-app-bar', '.v-toolbar', '.v-navigation-drawer'
].join(',')

/** Page content at a viewport point: a content element, or any element with its own text. */
export const isContentAtPoint = (x: number, y: number, doc: Document = document): boolean => {
  for (let node = doc.elementFromPoint(x, y); node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    if (node.matches(UTILITY_TOOLTIP_CONTENT_SELECTOR)) return true
    for (const child of node.childNodes) {
      if (child.nodeType === 3 && child.textContent?.trim()) return true
    }
  }
  return false
}
