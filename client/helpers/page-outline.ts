export type OutlineEntry = { anchor: string; title: string; depth: number }

export type OutlineNode = OutlineEntry & {
  children: OutlineNode[]
  parentAnchor: string | null
}

/** Keep matching headings and their ancestors so filtered results retain context. */
export function filterOutline<T extends OutlineEntry>(entries: T[], query: string): T[] {
  const term = query.trim().toLocaleLowerCase()
  if (!term) return entries
  const included = new Set<number>()
  const ancestors: number[] = []
  entries.forEach((entry, index) => {
    while (ancestors.length && entries[ancestors[ancestors.length - 1]].depth >= entry.depth) ancestors.pop()
    if (entry.title.toLocaleLowerCase().includes(term)) {
      included.add(index)
      for (const ancestor of ancestors) included.add(ancestor)
    }
    ancestors.push(index)
  })
  return entries.filter((_, index) => included.has(index))
}

/**
 * Builds a hierarchical outline tree preserving arbitrary heading depths,
 * resolving parent anchors and child lists.
 */
export function buildOutlineTree(entries: OutlineEntry[]): OutlineNode[] {
  const root: OutlineNode[] = []
  const stack: OutlineNode[] = []

  for (const entry of entries) {
    const node: OutlineNode = {
      anchor: entry.anchor,
      title: entry.title,
      depth: entry.depth,
      children: [],
      parentAnchor: null
    }

    while (stack.length > 0 && stack[stack.length - 1].depth >= entry.depth) {
      stack.pop()
    }

    if (stack.length === 0) {
      root.push(node)
    } else {
      const parent = stack[stack.length - 1]
      node.parentAnchor = parent.anchor
      parent.children.push(node)
    }

    stack.push(node)
  }

  return root
}

/**
 * Filters the outline tree while retaining matching paths and their ancestors.
 */
export function filterOutlineTree(nodes: OutlineNode[], query: string): OutlineNode[] {
  const term = query.trim().toLocaleLowerCase()
  if (!term) return nodes

  function filterNodes(list: OutlineNode[]): OutlineNode[] {
    const result: OutlineNode[] = []
    for (const node of list) {
      const filteredChildren = filterNodes(node.children)
      const matches = node.title.toLocaleLowerCase().includes(term)
      if (matches || filteredChildren.length > 0) {
        result.push({
          ...node,
          children: filteredChildren
        })
      }
    }
    return result
  }

  return filterNodes(nodes)
}

/**
 * Returns the array of ancestor anchors for a given anchor in hierarchical order.
 */
export function getAncestorAnchors(entries: OutlineEntry[], targetAnchor: string): string[] {
  const ancestors: string[] = []
  const targetIndex = entries.findIndex(e => e.anchor === targetAnchor)
  if (targetIndex <= 0) return ancestors

  let currentDepth = entries[targetIndex].depth
  for (let i = targetIndex - 1; i >= 0; i--) {
    if (entries[i].depth < currentDepth) {
      ancestors.unshift(entries[i].anchor)
      currentDepth = entries[i].depth
      if (currentDepth === 0) break
    }
  }

  return ancestors
}

/**
 * Initial branch expansion: top-level branches (depth 0 with children) start open,
 * second-level branches closed.
 */
export function getInitialExpandedAnchors(entries: OutlineEntry[]): Set<string> {
  const expanded = new Set<string>()

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.depth === 0) {
      if (i + 1 < entries.length && entries[i + 1].depth > entry.depth) {
        expanded.add(entry.anchor)
      }
    }
  }

  return expanded
}

/**
 * During search, expands all ancestor paths leading to matching headings
 * so matching results are immediately visible without hidden matches.
 */
export function getSearchExpandedAnchors(entries: OutlineEntry[], query: string): Set<string> {
  const expanded = new Set<string>()
  const term = query.trim().toLocaleLowerCase()
  if (!term) return expanded

  for (const entry of entries) {
    if (entry.title.toLocaleLowerCase().includes(term)) {
      const ancestors = getAncestorAnchors(entries, entry.anchor)
      for (const anchor of ancestors) {
        expanded.add(anchor)
      }
    }
  }

  return expanded
}

/**
 * Generates a deterministic, collision-free DOM id from an anchor string
 * suitable for aria-controls and sublist containers.
 */
export function outlineSublistId(anchor: string): string {
  const normalized = anchor.startsWith('#') ? anchor.slice(1) : anchor
  if (!normalized) {
    return 'page-toc-sub-_empty_'
  }
  const encoded = Array.from(normalized)
    .map(char => {
      const code = char.codePointAt(0)!
      if (
        (code >= 0x30 && code <= 0x39) || // 0-9
        (code >= 0x41 && code <= 0x5a) || // A-Z
        (code >= 0x61 && code <= 0x7a) || // a-z
        code === 0x2d // -
      ) {
        return char
      }
      return `_${code.toString(16)}_`
    })
    .join('')
  return `page-toc-sub-${encoded}`
}

/**
 * Determines if a branch is effectively expanded given the baseline expansion,
 * active search matches, and search-specific user overrides.
 */
export function isBranchEffectivelyExpanded(
  anchor: string,
  baselineExpanded: Set<string>,
  searchExpanded?: Set<string> | null,
  searchOverrides?: Map<string, boolean> | null
): boolean {
  if (searchOverrides && searchOverrides.has(anchor)) {
    return Boolean(searchOverrides.get(anchor))
  }
  if (searchExpanded && searchExpanded.has(anchor)) {
    return true
  }
  return baselineExpanded.has(anchor)
}

export function activeOutlineIndex(positions: number[], scrollTop: number): number {
  let low = 0
  let high = positions.length - 1
  let active = -1
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (positions[middle] <= scrollTop) {
      active = middle
      low = middle + 1
    } else high = middle - 1
  }
  return active
}

/** Cache geometry on layout changes; scrolling only performs a binary search. */
export function trackPageOutline(
  container: HTMLElement,
  entries: OutlineEntry[],
  onActive: (anchor: string) => void,
  onProgress?: (progress: number) => void
): () => void {
  let headings: { anchor: string; element: HTMLElement }[] = []
  let positions: number[] = []
  let frame: number | null = null
  let dirty = true
  let disposed = false
  let lastAnchor = ''
  let lastProgress = -1
  let articleTop = 0
  let articleBottom = 0
  let viewportHeight = window.innerHeight
  let headerBottom = 64
  const update = () => {
    frame = null
    if (disposed) return
    if (dirty) {
      headings = entries.flatMap(entry => {
        let id = entry.anchor.replace(/^#/, '')
        try {
          id = decodeURIComponent(id)
        } catch {
          /* Keep malformed literal IDs usable. */
        }
        const element = document.getElementById(id)
        return element && container.contains(element) && element.checkVisibility() ? [{ anchor: entry.anchor, element }] : []
      })
      positions = headings.map(({ element }) => element.getBoundingClientRect().top + window.scrollY)
      const article = container.getBoundingClientRect()
      articleTop = article.top + window.scrollY
      articleBottom = article.bottom + window.scrollY
      viewportHeight = window.innerHeight
      headerBottom = document.querySelector('.nav-header')?.getBoundingClientRect().bottom ?? 64
      dirty = false
    }
    const distance = articleBottom - articleTop - viewportHeight + headerBottom
    const progress = distance > 0 ? Math.round(Math.max(0, Math.min(1, (window.scrollY + headerBottom - articleTop) / distance)) * 100) : 100
    if (progress !== lastProgress) {
      lastProgress = progress
      onProgress?.(progress)
    }
    const index = activeOutlineIndex(positions, window.scrollY + headerBottom + 40)
    const anchor = headings[index]?.anchor ?? ''
    if (anchor !== lastAnchor) {
      lastAnchor = anchor
      onActive(anchor)
    }
  }
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(update)
  }
  const measure = () => {
    dirty = true
    schedule()
  }
  const resize = new ResizeObserver(measure)
  resize.observe(container)
  const main = container.closest('main')
  if (main) resize.observe(main)
  const header = document.querySelector('.nav-header')
  if (header) resize.observe(header)
  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', measure)
  container.addEventListener('toggle', measure, true)
  container.addEventListener('load', measure, true)
  void document.fonts?.ready.then(() => {
    if (!disposed) measure()
  })
  schedule()
  return () => {
    disposed = true
    resize.disconnect()
    if (frame !== null) cancelAnimationFrame(frame)
    window.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', measure)
    container.removeEventListener('toggle', measure, true)
    container.removeEventListener('load', measure, true)
  }
}
