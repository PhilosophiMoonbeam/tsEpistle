export type OutlineEntry = { anchor: string; title: string; depth: number }

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

/** An overview retains major sections and the current subsection's ancestry. */
export function overviewOutline<T extends OutlineEntry>(entries: T[], activeAnchor: string): T[] {
  const activeIndex = entries.findIndex(entry => entry.anchor === activeAnchor)
  const included = new Set<number>()
  if (activeIndex >= 0) {
    included.add(activeIndex)
    let depth = entries[activeIndex].depth
    for (let index = activeIndex - 1; index >= 0 && depth > 0; index -= 1) {
      if (entries[index].depth < depth) {
        included.add(index)
        depth = entries[index].depth
      }
    }
  }
  return entries.filter((entry, index) => entry.depth <= 1 || included.has(index))
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
export function trackPageOutline(container: HTMLElement, entries: OutlineEntry[], onActive: (anchor: string) => void, onProgress?: (progress: number) => void): () => void {
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
