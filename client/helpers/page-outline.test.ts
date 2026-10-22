import { afterEach, describe, expect, test, vi } from '../../server/test/bun-test.mts'
import {
  activeOutlineIndex,
  buildOutlineTree,
  filterOutlineTree,
  getAncestorAnchors,
  getInitialExpandedAnchors,
  getSearchExpandedAnchors,
  isBranchEffectivelyExpanded,
  outlineSublistId,
  trackPageOutline,
  type OutlineNode
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

    const anchors = (nodes: OutlineNode[]): string[] =>
      nodes.flatMap(node => [node.anchor, ...anchors(node.children)])
    expect(anchors(filterOutlineTree(tree, '  aPi '))).toEqual(['#guide', '#setup', '#keys', '#reference', '#api'])
    expect(anchors(filterOutlineTree(tree, 'search'))).toEqual(['#guide', '#search'])
    expect(anchors(filterOutlineTree(tree, 'guide'))).toEqual(['#guide'])

    for (const query of ['', '   ']) {
      expect(anchors(filterOutlineTree(tree, query))).toEqual(['#guide', '#setup', '#keys', '#search', '#reference', '#api', '#standalone'])
    }
    expect(filterOutlineTree(tree, 'missing')).toEqual([])
    expect(filterOutlineTree([], 'api')).toEqual([])
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

  for (const scenario of [
    {
      name: 'compresses trailing tracker heading activations into an ordered terminal window',
      positions: [100, 1_000, 1_100, 1_200],
      anchors: ['#start', '#second', '#third', '#terminal'],
      articleBottom: 1_300,
      documentHeight: 1_400,
      scrolls: [100, 410, 460, 500, 460, 410, 100],
      expected: ['#start', '#second', '#third', '#terminal', '#third', '#second', '#start'],
      expectedProgress: [29, 84, 93, 100, 93, 84, 29]
    },
    {
      name: 'does not force a final tracker heading when the article has no scrollable end',
      positions: [500, 600],
      anchors: ['#start', '#terminal'],
      articleBottom: 700,
      documentHeight: 700,
      scrolls: [0],
      expected: ['#start'],
      expectedProgress: [100]
    }
  ]) {
    test(scenario.name, () => {
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
      vi.stubGlobal('ResizeObserver', class {
        observe(_target: Element): void {}
        disconnect(): void {}
      })
      Object.defineProperty(window, 'scrollY', { configurable: true, value: scenario.scrolls[0] })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
      Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: scenario.documentHeight })
      Object.defineProperty(document.body, 'scrollHeight', { configurable: true, value: scenario.documentHeight })

      const rect = (top: number, bottom: number): DOMRect =>
        ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
      const header = document.createElement('header')
      header.className = 'nav-header'
      Object.defineProperty(header, 'getBoundingClientRect', { value: () => rect(0, 64) })
      const article = document.createElement('main')
      Object.defineProperty(article, 'getBoundingClientRect', {
        value: () => rect(-window.scrollY, scenario.articleBottom - window.scrollY)
      })
      const entries = scenario.anchors.map(anchor => ({ anchor, title: anchor.slice(1), depth: 0 }))
      for (const [index, entry] of entries.entries()) {
        const heading = document.createElement('h2')
        heading.id = entry.anchor.slice(1)
        const top = scenario.positions[index]!
        Object.defineProperty(heading, 'getBoundingClientRect', {
          value: () => rect(top - window.scrollY, top + 40 - window.scrollY)
        })
        Object.defineProperty(heading, 'getClientRects', {
          value: () => [rect(top - window.scrollY, top + 40 - window.scrollY)]
        })
        article.append(heading)
      }
      document.body.append(header, article)

      const active: string[] = []
      const progress: number[] = []
      const tracker = trackPageOutline(article, entries, anchor => active.push(anchor), value => progress.push(value))
      const flushFrames = (): void => {
        while (frames.size > 0) {
          const callbacks = [...frames.values()]
          frames.clear()
          for (const callback of callbacks) callback(0)
        }
      }
      try {
        for (const [index, scrollY] of scenario.scrolls.entries()) {
          Object.defineProperty(window, 'scrollY', { configurable: true, value: scrollY })
          window.dispatchEvent(new Event('scroll'))
          flushFrames()
          expect(active[active.length - 1]).toBe(scenario.expected[index])
          expect(progress[progress.length - 1]).toBe(scenario.expectedProgress[index])
        }
        expect(active).toEqual(scenario.expected)
        expect(progress).toEqual(scenario.expectedProgress)

        // Teardown must suppress both an already queued update and later events.
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 500 })
        window.dispatchEvent(new Event('scroll'))
        tracker.dispose()
        flushFrames()
        Object.defineProperty(window, 'scrollY', { configurable: true, value: 410 })
        window.dispatchEvent(new Event('scroll'))
        window.dispatchEvent(new Event('resize'))
        flushFrames()
        expect(active).toEqual(scenario.expected)
        expect(progress).toEqual(scenario.expectedProgress)
      } finally {
        tracker.dispose()
      }
    })
  }

  test('measures each heading once per layout change, keeps offscreen and zero-size anchors, and defers setup reads', async () => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    let resize = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe(): void {}
      disconnect(): void {}
    })
    let scrollTop = 0
    let scrollReads = 0
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => { scrollReads++; return scrollTop } })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 11_000 })
    const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
    const { promise: fontReadiness, resolve: fontsReady } = Promise.withResolvers<void>()
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: fontReadiness }
    })
    const article = document.createElement('main')
    const rect = (top: number, height = 40): DOMRect => ({
      top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({})
    })
    article.getBoundingClientRect = () => rect(-scrollTop, 10_000)
    let collapsed = true
    let fontShift = 0
    const reads = Array.from({ length: 47 }, () => 0)
    const entries = reads.map((_, index) => {
      const heading = document.createElement('h2')
      heading.id = `section-${index}`
      heading.getClientRects = () => {
        reads[index]!++
        if (index === 1 && collapsed) return [] as unknown as DOMRectList
        const top = index * 200 + fontShift - scrollTop
        // A zero-size rendered anchor is valid. Fragmented anchors use the
        // top of nonempty boxes, just like getBoundingClientRect.
        return (index === 2 ? [rect(1, 0), rect(top + 40), rect(top)] : [rect(top, index === 0 ? 0 : 40)]) as unknown as DOMRectList
      }
      heading.getBoundingClientRect = () => { throw new Error('A heading must not be measured a second time') }
      article.append(heading)
      return { anchor: `#${heading.id}`, title: heading.id, depth: 0 }
    })
    document.body.append(article)
    const active: string[] = []
    const tracker = trackPageOutline(article, entries, anchor => active.push(anchor))
    const flush = () => {
      const callbacks = [...frames.values()]
      frames.clear()
      for (const callback of callbacks) callback(0)
    }
    try {
      expect(scrollReads).toBe(0)
      expect(reads.every(count => count === 0)).toBe(true)
      resize()
      resize()
      expect(frames.size).toBe(1)
      flush()
      expect(active.at(-1)).toBe('#section-0')
      expect(reads.every(count => count === 1)).toBe(true)
      expect(scrollReads).toBe(1)
      for (const [top, anchor] of [[320, '#section-2'], [6_000, '#section-30']] as const) {
        scrollTop = top
        window.dispatchEvent(new Event('scroll'))
        flush()
        expect(active.at(-1)).toBe(anchor)
        expect(reads.every(count => count === 1)).toBe(true)
      }
      collapsed = false
      scrollTop = 100
      resize()
      window.dispatchEvent(new Event('resize'))
      flush()
      expect(active.at(-1)).toBe('#section-1')
      expect(reads.every(count => count === 2)).toBe(true)
      fontShift = 600
      fontsReady()
      await Promise.resolve()
      flush()
      expect(active.at(-1)).toBe('#section-0')
      expect(reads.every(count => count === 3)).toBe(true)
      tracker.refresh()
      tracker.dispose()
      flush()
      expect(reads.every(count => count === 3)).toBe(true)
    } finally {
      tracker.dispose()
      if (originalFonts) Object.defineProperty(document, 'fonts', originalFonts)
      else Reflect.deleteProperty(document, 'fonts')
    }
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
    expect(bareEmpty).toBe(empty)
    expect(empty).not.toEqual(literalRoot)
    expect(outlineSublistId('#a.b')).toBe(dot)
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
        expect(active).toHaveLength(callbackCount)
        flushFrames()
        expect(active[active.length - 1]).toBe('#terminal')
      }
    } finally {
      tracker.dispose()
    }
  })
})
