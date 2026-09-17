import { afterEach, describe, expect, test, vi } from '../../server/test/bun-test.mts'
import {
  activeOutlineIndex,
  activeOutlineIndexAtScroll,
  buildOutlineTree,
  filterOutline,
  filterOutlineTree,
  getAncestorAnchors,
  getInitialExpandedAnchors,
  getSearchExpandedAnchors,
  isBranchEffectivelyExpanded,
  outlineSublistId,
  trackPageOutline
} from './page-outline'

const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY')
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
const originalDocumentScrollHeight = Object.getOwnPropertyDescriptor(document.documentElement, 'scrollHeight')
const originalBodyScrollHeight = Object.getOwnPropertyDescriptor(document.body, 'scrollHeight')

afterEach(() => {
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY)
  else Reflect.deleteProperty(window, 'scrollY')
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight)
  else Reflect.deleteProperty(window, 'innerHeight')
  if (originalDocumentScrollHeight) Object.defineProperty(document.documentElement, 'scrollHeight', originalDocumentScrollHeight)
  else Reflect.deleteProperty(document.documentElement, 'scrollHeight')
  if (originalBodyScrollHeight) Object.defineProperty(document.body, 'scrollHeight', originalBodyScrollHeight)
  else Reflect.deleteProperty(document.body, 'scrollHeight')
})

const outline = [
  { anchor: '#guide', title: 'Guide', depth: 0 },
  { anchor: '#setup', title: 'Setup', depth: 1 },
  { anchor: '#keys', title: 'API keys', depth: 2 },
  { anchor: '#search', title: 'Search', depth: 1 },
  { anchor: '#reference', title: 'Reference', depth: 0 },
  { anchor: '#api', title: 'API reference', depth: 1 },
  { anchor: '#standalone', title: 'Standalone leaf', depth: 0 }
]

describe('document outline', () => {
  test('keeps only matching headings and their own ancestor chains', () => {
    expect(filterOutline(outline, '  API ').map(entry => entry.anchor)).toEqual(['#guide', '#setup', '#keys', '#reference', '#api'])
    expect(filterOutline(outline, 'search').map(entry => entry.anchor)).toEqual(['#guide', '#search'])
  })

  test('restores the original outline when the filter is cleared and handles no matches', () => {
    expect(filterOutline(outline, '  ')).toBe(outline)
    expect(filterOutline(outline, 'missing')).toEqual([])
    expect(filterOutline([], 'api')).toEqual([])
  })

  test('builds a hierarchical outline tree preserving arbitrary depths', () => {
    const tree = buildOutlineTree(outline)
    expect(tree).toHaveLength(3) // #guide, #reference, #standalone
    expect(tree[0].anchor).toBe('#guide')
    expect(tree[0].parentAnchor).toBeNull()
    expect(tree[0].children).toHaveLength(2) // #setup, #search

    expect(tree[0].children[0].anchor).toBe('#setup')
    expect(tree[0].children[0].parentAnchor).toBe('#guide')
    expect(tree[0].children[0].children).toHaveLength(1) // #keys

    expect(tree[0].children[0].children[0].anchor).toBe('#keys')
    expect(tree[0].children[0].children[0].parentAnchor).toBe('#setup')
    expect(tree[0].children[0].children[0].children).toHaveLength(0)

    expect(tree[0].children[1].anchor).toBe('#search')
    expect(tree[0].children[1].parentAnchor).toBe('#guide')

    expect(tree[1].anchor).toBe('#reference')
    expect(tree[1].children).toHaveLength(1)
    expect(tree[1].children[0].anchor).toBe('#api')

    expect(tree[2].anchor).toBe('#standalone')
    expect(tree[2].children).toHaveLength(0)
  })

  test('filters outline tree retaining matching paths and ancestor context', () => {
    const tree = buildOutlineTree(outline)
    const filtered = filterOutlineTree(tree, 'API keys')
    expect(filtered).toHaveLength(1)
    expect(filtered[0].anchor).toBe('#guide')
    expect(filtered[0].children).toHaveLength(1)
    expect(filtered[0].children[0].anchor).toBe('#setup')
    expect(filtered[0].children[0].children).toHaveLength(1)
    expect(filtered[0].children[0].children[0].anchor).toBe('#keys')

    expect(filterOutlineTree(tree, '   ')).toBe(tree)
    expect(filterOutlineTree(tree, 'missing')).toEqual([])
  })

  test('resolves ancestor anchors for deep links and active headings', () => {
    expect(getAncestorAnchors(outline, '#keys')).toEqual(['#guide', '#setup'])
    expect(getAncestorAnchors(outline, '#setup')).toEqual(['#guide'])
    expect(getAncestorAnchors(outline, '#guide')).toEqual([])
    expect(getAncestorAnchors(outline, '#standalone')).toEqual([])
    expect(getAncestorAnchors(outline, '#nonexistent')).toEqual([])
  })

  test('determines initial expanded branches: top-level open, second-level closed', () => {
    const defaultExpanded = getInitialExpandedAnchors(outline)
    expect(defaultExpanded.has('#guide')).toBe(true)
    expect(defaultExpanded.has('#reference')).toBe(true)
    expect(defaultExpanded.has('#setup')).toBe(false) // second-level branch closed initially
    expect(defaultExpanded.has('#standalone')).toBe(false) // leaf never advertises expansion
  })

  test('determines search expanded anchors so matching paths are visible', () => {
    const searchExpanded = getSearchExpandedAnchors(outline, 'keys')
    expect(searchExpanded.has('#guide')).toBe(true)
    expect(searchExpanded.has('#setup')).toBe(true)
    expect(searchExpanded.has('#reference')).toBe(false)

    expect(getSearchExpandedAnchors(outline, '  ').size).toBe(0)
    expect(getSearchExpandedAnchors(outline, 'unknown').size).toBe(0)
  })

  test('tracks the last heading crossed in either scroll direction, including boundaries', () => {
    const positions = [100, 260, 500, 910]
    expect(activeOutlineIndex(positions, 99)).toBe(-1)
    expect(activeOutlineIndex(positions, 260)).toBe(1)
    expect(activeOutlineIndex(positions, 1200)).toBe(3)
    expect(activeOutlineIndex(positions, 499)).toBe(1)
    expect(activeOutlineIndex([], 100)).toBe(-1)
  })

  test('compresses trailing heading activations into an ordered terminal window', () => {
    const positions = [100, 1_000, 1_100, 1_200]

    expect(activeOutlineIndexAtScroll(positions, 100, 800, 1_300, 104, 1_400)).toBe(0)
    expect(activeOutlineIndexAtScroll(positions, 410, 800, 1_300, 104, 1_400)).toBe(1)
    expect(activeOutlineIndexAtScroll(positions, 460, 800, 1_300, 104, 1_400)).toBe(2)
    expect(activeOutlineIndexAtScroll(positions, 500, 800, 1_300, 104, 1_400)).toBe(3)
  })

  test('does not force a final heading when the article has no scrollable end', () => {
    expect(activeOutlineIndexAtScroll([500, 600], 0, 800, 700, 104, 700)).toBe(-1)
  })

  test('generates deterministic collision-free DOM IDs from anchors for sublists', () => {
    const dot = outlineSublistId('#a.b')
    const colon = outlineSublistId('#a:b')
    const underscore = outlineSublistId('#a_b')
    const hyphen = outlineSublistId('#a-b')
    const bare = outlineSublistId('a.b')
    const empty = outlineSublistId('#')
    const literalRoot = outlineSublistId('#root')
    const bareEmpty = outlineSublistId('')

    expect(dot).not.toEqual(colon)
    expect(dot).not.toEqual(underscore)
    expect(colon).not.toEqual(underscore)
    expect(underscore).not.toEqual(hyphen)
    expect(bare).toBe(dot)
    expect(empty).toBe('page-toc-sub-_empty_')
    expect(bareEmpty).toBe('page-toc-sub-_empty_')
    expect(literalRoot).toBe('page-toc-sub-root')
    expect(empty).not.toEqual(literalRoot)
    expect(outlineSublistId('#section-1')).toBe('page-toc-sub-section-1')
  })

  test('evaluates effective branch expansion with baseline, search, and user overrides', () => {
    const baseline = new Set(['#guide'])
    // 1. Without search or overrides, baseline controls
    expect(isBranchEffectivelyExpanded('#guide', baseline)).toBe(true)
    expect(isBranchEffectivelyExpanded('#setup', baseline)).toBe(false)

    // 2. Search forces branch open even if not in baseline
    const searchExpanded = new Set(['#setup'])
    expect(isBranchEffectivelyExpanded('#setup', baseline, searchExpanded)).toBe(true)

    // 3. User override during search can explicitly collapse the search-expanded branch (first toggle succeeds)
    const overrides = new Map([['#setup', false]])
    expect(isBranchEffectivelyExpanded('#setup', baseline, searchExpanded, overrides)).toBe(false)

    // 4. User override can explicitly expand a non-matching branch
    overrides.set('#reference', true)
    expect(isBranchEffectivelyExpanded('#reference', baseline, searchExpanded, overrides)).toBe(true)

    // 5. Clearing search/overrides restores baseline
    expect(isBranchEffectivelyExpanded('#setup', baseline, null, null)).toBe(false)
    expect(isBranchEffectivelyExpanded('#guide', baseline, null, null)).toBe(true)
  })

  test('reconciles a clicked intermediate heading after scroll intent at the clamped document end', () => {
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
      const id = ++nextFrame
      frames.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
      frames.delete(id)
    })
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(_target: Element): void {}
        disconnect(): void {}
      }
    )

    Object.defineProperty(window, 'scrollY', { configurable: true, value: 600 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 1_400 })
    Object.defineProperty(document.body, 'scrollHeight', { configurable: true, value: 1_400 })

    const entries = [
      { anchor: '#start', title: 'Start', depth: 0 },
      { anchor: '#middle', title: 'Middle', depth: 0 },
      { anchor: '#terminal', title: 'Terminal', depth: 0 }
    ]
    const article = document.createElement('main')
    const rect = (top: number, bottom: number): DOMRect =>
      ({
        top,
        bottom,
        left: 0,
        right: 0,
        width: 0,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({})
      }) as DOMRect
    Object.defineProperty(article, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect(-window.scrollY, 1_400 - window.scrollY)
    })
    for (const [index, entry] of entries.entries()) {
      const heading = document.createElement('h2')
      heading.id = entry.anchor.slice(1)
      const documentTop = [100, 500, 1_300][index]!
      Object.defineProperty(heading, 'getBoundingClientRect', {
        configurable: true,
        value: () => rect(documentTop - window.scrollY, documentTop + 40 - window.scrollY)
      })
      Object.defineProperty(heading, 'getClientRects', {
        configurable: true,
        value: () => [rect(documentTop - window.scrollY, documentTop + 40 - window.scrollY)]
      })
      article.append(heading)
    }
    document.body.append(article)

    const active: string[] = []
    const tracker = trackPageOutline(article, entries, anchor => active.push(anchor))
    const flushFrames = (): void => {
      while (frames.size > 0) {
        const callbacks = [...frames.values()]
        frames.clear()
        for (const callback of callbacks) callback(0)
      }
    }

    try {
      tracker.setNavigationAnchor('#middle')
      flushFrames()
      expect(active[active.length - 1]).toBe('#middle')

      const intents: Event[] = [
        new WheelEvent('wheel', { bubbles: true, deltaY: 120 }),
        new Event('touchstart', { bubbles: true }),
        new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' })
      ]
      for (const intent of intents) {
        tracker.setNavigationAnchor('#middle')
        flushFrames()
        const callbackCount = active.length
        document.body.dispatchEvent(intent)
        expect(frames.size).toBe(1)
        expect(active).toHaveLength(callbackCount)
        flushFrames()
        expect(active[active.length - 1]).toBe('#terminal')
      }
    } finally {
      tracker.dispose()
    }
  })
})
