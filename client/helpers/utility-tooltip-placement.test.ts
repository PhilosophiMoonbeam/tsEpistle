import { JSDOM } from 'jsdom'
import { describe, expect, it } from '../../server/test/bun-test.mts'
import { chooseUtilityTooltipPlacement, isContentAtPoint, type PlacementRect } from './utility-tooltip-placement.ts'

// Desktop rail at 1440: top bar 0-53, rail card 301-627 x 122-201, H1 to the right.
const viewport = { width: 1440, height: 900 }
const card = { left: 301, top: 122, right: 627, bottom: 201 }
const button = (left: number): PlacementRect => ({ left, top: 130, right: left + 36, bottom: 166 })
const topBar = { left: 0, top: 0, right: 1440, bottom: 53 }
const h1 = { left: 667, top: 90, right: 982, bottom: 142 }
const toc = { left: 301, top: 217, right: 627, bottom: 876 }
const navDrawer = { left: 0, top: 52, right: 270, bottom: 900 }
const inside = (rect: PlacementRect) => (x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
const contentAt = (...rects: PlacementRect[]) => (x: number, y: number) => rects.some(rect => inside(rect)(x, y))

describe('chooseUtilityTooltipPlacement', () => {
  it('opens above the card in the free band under the top bar, centered on the button inside the card column', () => {
    const placement = chooseUtilityTooltipPlacement({
      card,
      activator: button(400),
      size: { width: 100, height: 30 },
      viewport,
      isContentAt: contentAt(topBar, h1, toc)
    })
    expect(placement).toMatchObject({ side: 'top', location: 'top left', coversContent: false })
    expect(placement.rect).toEqual({ left: 368, top: 86, right: 468, bottom: 116 })
    // Vuetify offset: 6px away from the card, shifted from the card's left edge to the rect.
    expect(placement.offset).toEqual([6, card.left - 368])
  })

  it('keeps a wide tooltip inside the card column so it cannot reach the title', () => {
    const placement = chooseUtilityTooltipPlacement({ card, activator: button(590), size: { width: 300, height: 50 }, viewport, isContentAt: contentAt(topBar, h1, toc) })
    expect(placement.side).toBe('top')
    expect(placement.rect.right).toBe(card.right)
    expect(placement.rect.left).toBe(card.right - 300)
  })

  it('goes below the card when the band above is too short, and beside it when both are taken', () => {
    const tall = { width: 280, height: 68 }
    const below = chooseUtilityTooltipPlacement({ card, activator: button(400), size: tall, viewport, isContentAt: contentAt(topBar, h1) })
    expect(below).toMatchObject({ side: 'bottom', location: 'bottom left', coversContent: false })
    expect(below.rect.top).toBe(card.bottom + 6)

    // Beside the card: the H1 is on the right and the navigation drawer on the left.
    const taken = chooseUtilityTooltipPlacement({ card, activator: button(400), size: tall, viewport, isContentAt: contentAt(topBar, h1, toc, navDrawer) })
    expect(taken.coversContent).toBe(true)

    const freeLeft = chooseUtilityTooltipPlacement({ card, activator: button(400), size: tall, viewport, isContentAt: contentAt(topBar, h1, toc) })
    expect(freeLeft).toMatchObject({ side: 'left', location: 'left top', coversContent: false })
    expect(freeLeft.rect.right).toBe(card.left - 6)

    const freeRight = chooseUtilityTooltipPlacement({ card, activator: button(400), size: tall, viewport, isContentAt: contentAt(topBar, toc, navDrawer) })
    expect(freeRight).toMatchObject({ side: 'right', location: 'right top', coversContent: false })
    expect(freeRight.rect.left).toBe(card.right + 6)
    expect(freeRight.offset).toEqual([6, card.top - freeRight.rect.top])
  })

  it('covers as little as possible when no side is free', () => {
    // Tablet: full-width card, page header text just above, outline card just below.
    const tablet = { left: 24, top: 219, right: 1076, bottom: 298 }
    const header = { left: 24, top: 60, right: 1076, bottom: 180 }
    const outline = { left: 24, top: 314, right: 1076, bottom: 360 }
    const placement = chooseUtilityTooltipPlacement({
      card: tablet,
      activator: { left: 500, top: 227, right: 536, bottom: 263 },
      size: { width: 280, height: 68 },
      viewport: { width: 1100, height: 900 },
      isContentAt: contentAt(topBar, header, outline)
    })
    expect(placement.coversContent).toBe(true)
    // Above overlaps the header by 33px; below overlaps the outline card by its full height.
    expect(placement.side).toBe('top')
  })

  it('never leaves the viewport margin on a narrow screen', () => {
    const phone = { left: 14, top: 209, right: 376, bottom: 288 }
    const placement = chooseUtilityTooltipPlacement({
      card: phone,
      activator: { left: 330, top: 217, right: 366, bottom: 253 },
      size: { width: 200, height: 30 },
      viewport: { width: 390, height: 844 },
      isContentAt: () => false
    })
    expect(placement.side).toBe('top')
    expect(placement.rect.right).toBeLessThanOrEqual(390 - 12)
    expect(placement.rect.left).toBeGreaterThanOrEqual(12)
  })
})

describe('isContentAtPoint', () => {
  const documentWith = (html: string, selector: string | null) => {
    const { window } = new JSDOM(`<body>${html}</body>`)
    const doc = window.document
    doc.elementFromPoint = () => (selector ? doc.querySelector(selector) : null)
    return doc
  }

  it('counts text, controls and cards, but not empty layout containers', () => {
    expect(isContentAtPoint(1, 1, documentWith('<div class="hero"><div class="pad"></div></div>', '.pad'))).toBe(false)
    expect(isContentAtPoint(1, 1, documentWith('<div class="summary">  </div>', '.summary'))).toBe(false)
    expect(isContentAtPoint(1, 1, documentWith('<div class="label">Knowledge</div>', '.label'))).toBe(true)
    expect(isContentAtPoint(1, 1, documentWith('<nav class="v-card"><div class="inner"></div></nav>', '.inner'))).toBe(true)
    expect(isContentAtPoint(1, 1, documentWith('<header class="v-app-bar"><div class="spacer"></div></header>', '.spacer'))).toBe(true)
    expect(isContentAtPoint(1, 1, documentWith('<p>Text</p>', null))).toBe(false)
  })
})
