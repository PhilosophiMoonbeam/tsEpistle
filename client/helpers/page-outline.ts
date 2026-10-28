export type OutlineEntry = { anchor: string; title: string; depth: number }

export type OutlineNode = OutlineEntry & {
  children: OutlineNode[]
  parentAnchor: string | null
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

export type PageReadingProgressScope = {
  /** Canonical site/workspace identity, not the current URL or a display name. */
  canonicalWorkspaceId: string
  reader: { kind: 'account'; accountId: string } | { kind: 'anonymous' }
  locale: string
  pageId: string
  sourceRevision: string
  /** Private reading requires an authenticated account and current authority. */
  authority: 'public-readable' | 'private-readable' | 'unavailable'
  /** Stable, non-secret authority revision; never a token/session identifier. */
  authorityKey: string
}

export type PageReadingSectionProgress = {
  /** Empty for an article without usable headings. */
  anchor: string
  progress: number
  completed: boolean
}

export type PageReadingProgressState = {
  status: 'disabled' | 'tracking'
  progress: number
  sections: PageReadingSectionProgress[]
  completedAnchors: string[]
}

/**
 * Opt-in only. Update scope synchronously before an authority/account/page
 * transition can render. Matching records expire after 90 days; future,
 * corrupt, unknown-version or mismatched scope/revision/page-fingerprint
 * records are ignored before display. A revision change resets everything;
 * a live same-revision refresh resets changed/renamed/removed sections only.
 * Same-scope tabs union earned coverage; storage deletion clears local state.
 * Storage denial/quota failure leaves the session usable in memory.
 */
export type PageReadingProgressOptions = {
  scope: PageReadingProgressScope | null
  onChange: (state: PageReadingProgressState) => void
}

type ReadingRange = [number, number]
type ReadingUnit = {
  start: number
  end: number
  ranges: ReadingRange[]
  disclosure?: HTMLDetailsElement
}
type ReadingSection = {
  anchor: string
  fingerprint: string
  units: ReadingUnit[]
}
type ReadingHeading = { anchor: string; element: HTMLElement; top: number | null }
type ReadingRecord = {
  version: 1
  scope: string
  fingerprint: string
  savedAt: number
  sections: { index: number; fingerprint: string; coverage: ReadingRange[][] }[]
}

const READING_DWELL_MS = 1_000
const READING_INTENT_MS = 1_500
const READING_SAVE_MS = 1_500
const READING_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000

// Fingerprints are change detectors, not a claim about authorship or mastery.
// Only opaque hashes, section ordinals and coverage data leave memory.
function readingFingerprint(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

function mergeReadingRanges(ranges: ReadingRange[]): ReadingRange[] {
  const merged: ReadingRange[] = []
  for (const range of ranges.sort((left, right) => left[0] - right[0])) {
    const previous = merged[merged.length - 1]
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
    else merged.push([range[0], range[1]])
  }
  return merged
}

function readingCoverage(unit: ReadingUnit): number {
  return unit.ranges.reduce((total, [start, end]) => total + end - start, 0)
}

/**
 * Local viewport traversal, never cognitive mastery or a server assertion.
 * A trusted reading gesture followed by one visible second earns only the
 * current viewport. Coverage must reach both ends with no gaps; jumps do not
 * fill intervening content. Disclosures additionally require an actual summary
 * activation that opens them. Initial visibility/active TOC/scalar 100 earn none.
 *
 * This model is driven by the outline's existing measurement/scroll lifecycle;
 * it adds no layout observer and performs no persistence on a scroll frame.
 */
function createReadingProgress(container: HTMLElement, options: PageReadingProgressOptions) {
  let scope: PageReadingProgressScope | null = null
  let scopeIdentity = ''
  let sections: ReadingSection[] = []
  let fingerprint = ''
  let loaded = false
  let disposed = false
  let storageAvailable = true
  let saveTimer: number | null = null
  let dwellTimer: number | null = null
  let changed = false
  let intentUntil = 0
  let previousScrollY = window.scrollY
  let viewTop = 0
  let viewBottom = 0
  let lastPublished = ''
  let deliberatelyOpen = new WeakMap<HTMLDetailsElement, MouseEvent>()

  const cancelDwell = (): void => {
    if (dwellTimer !== null) window.clearTimeout(dwellTimer)
    dwellTimer = null
  }
  const suspend = (): void => {
    intentUntil = 0
    previousScrollY = window.scrollY
    cancelDwell()
  }
  const cancelSave = (): void => {
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = null
  }
  const publish = (): void => {
    const values = sections.map(section => {
      const coverage = section.units.reduce((total, unit) => total + readingCoverage(unit), 0) / section.units.length
      const completed = section.units.every(unit => readingCoverage(unit) >= 1 - Number.EPSILON)
      return { anchor: section.anchor, progress: completed ? 100 : Math.min(99, Math.floor(coverage * 100)), completed }
    })
    const state: PageReadingProgressState = {
      status: scope ? 'tracking' : 'disabled',
      progress: values.length ? Math.floor(values.reduce((total, section) => total + section.progress, 0) / values.length) : 0,
      sections: values,
      completedAnchors: values.filter(section => section.completed).map(section => section.anchor)
    }
    const serialized = JSON.stringify(state)
    if (serialized === lastPublished) return
    lastPublished = serialized
    options.onChange(state)
  }
  const key = (): string => `wiki:reading-mastery:${scope!.pageId}`
  const decode = (raw: string | null): ReadingRecord | null => {
    if (!raw || raw.length > 1_000_000) return null
    try {
      const record = JSON.parse(raw) as ReadingRecord
      const now = Date.now()
      if (!record || record.version !== 1 || record.scope !== scopeIdentity || record.fingerprint !== fingerprint ||
        !Number.isFinite(record.savedAt) || record.savedAt > now || now - record.savedAt > READING_MAX_AGE_MS ||
        !Array.isArray(record.sections) || record.sections.length !== sections.length) return null
      for (let index = 0; index < sections.length; index++) {
        const expected = sections[index]!
        const saved = record.sections[index]
        if (!saved || saved.index !== index || saved.fingerprint !== expected.fingerprint ||
          !Array.isArray(saved.coverage) || saved.coverage.length !== expected.units.length) return null
        for (const ranges of saved.coverage) {
          if (!Array.isArray(ranges) || ranges.length > 4_096) return null
          let end = -1
          for (const range of ranges) {
            if (!Array.isArray(range) || range.length !== 2 || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) ||
              range[0] < 0 || range[1] > 1 || range[0] >= range[1] || range[0] <= end) return null
            end = range[1]
          }
        }
      }
      return record
    } catch {
      return null
    }
  }
  const mergeRecord = (record: ReadingRecord): boolean => {
    let merged = false
    sections.forEach((section, sectionIndex) => section.units.forEach((unit, unitIndex) => {
      const before = readingCoverage(unit)
      unit.ranges = mergeReadingRanges([...unit.ranges, ...record.sections[sectionIndex]!.coverage[unitIndex]!])
      if (readingCoverage(unit) > before) merged = true
    }))
    return merged
  }
  const readRecord = (): ReadingRecord | null => {
    if (!scope || !storageAvailable) return null
    try {
      return decode(window.localStorage.getItem(key()))
    } catch {
      storageAvailable = false
      return null
    }
  }
  const persist = (): void => {
    cancelSave()
    if (!scope || disposed || !storageAvailable || !changed) return
    // Read/merge just before writing so concurrent tabs converge by union,
    // rather than allowing the last viewport to erase another tab's progress.
    const existing = readRecord()
    if (existing && mergeRecord(existing)) publish()
    if (!storageAvailable) return
    const record: ReadingRecord = {
      version: 1,
      scope: scopeIdentity,
      fingerprint,
      savedAt: Date.now(),
      sections: sections.map((section, index) => ({
        index,
        fingerprint: section.fingerprint,
        coverage: section.units.map(unit => unit.ranges)
      }))
    }
    try {
      window.localStorage.setItem(key(), JSON.stringify(record))
      changed = false
    } catch {
      // Denied storage/quota must never interfere with in-memory reading.
      storageAvailable = false
    }
  }
  const scheduleSave = (): void => {
    changed = true
    if (storageAvailable && saveTimer === null) saveTimer = window.setTimeout(persist, READING_SAVE_MS)
  }
  const isVisible = (element: HTMLElement): boolean => {
    if (!container.isConnected || document.visibilityState === 'hidden') return false
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute('aria-hidden') === 'true') return false
      if (current instanceof HTMLDetailsElement && !current.open && current !== element) return false
      const style = window.getComputedStyle(current)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    }
    return true
  }
  const awardViewport = (): void => {
    dwellTimer = null
    if (!scope || disposed || Date.now() > intentUntil || !isVisible(container)) return
    let earned = false
    for (const section of sections) {
      for (const unit of section.units) {
        if (!Number.isFinite(unit.start) || unit.end <= unit.start) continue
        if (unit.disclosure && (!unit.disclosure.open || !deliberatelyOpen.has(unit.disclosure) ||
          deliberatelyOpen.get(unit.disclosure)?.defaultPrevented || !isVisible(unit.disclosure))) continue
        const start = Math.max(unit.start, viewTop)
        const end = Math.min(unit.end, viewBottom)
        if (end <= start) continue
        const before = readingCoverage(unit)
        const length = unit.end - unit.start
        unit.ranges = mergeReadingRanges([...unit.ranges, [(start - unit.start) / length, (end - unit.start) / length]])
        if (readingCoverage(unit) > before) earned = true
      }
    }
    if (earned) {
      publish()
      scheduleSave()
    }
  }
  const setScope = (next: PageReadingProgressScope | null): void => {
    if (disposed) return
    const valid = (next?.authority === 'public-readable' || (next?.authority === 'private-readable' && next.reader?.kind === 'account')) &&
      [next.canonicalWorkspaceId, next.locale, next.pageId, next.sourceRevision, next.authorityKey].every(value => typeof value === 'string' && value.trim().length > 0) &&
      (next.reader?.kind === 'anonymous' || (next.reader?.kind === 'account' && typeof next.reader.accountId === 'string' && next.reader.accountId.length > 0))
    const identity = valid && next ? JSON.stringify([
      next.canonicalWorkspaceId, next.reader.kind, next.reader.kind === 'account' ? next.reader.accountId : null,
      next.locale, next.pageId, next.sourceRevision, next.authority, next.authorityKey
    ]) : ''
    if (identity === scopeIdentity && Boolean(scope) === Boolean(valid)) return
    suspend()
    cancelSave()
    changed = false
    sections = []
    fingerprint = ''
    loaded = false
    deliberatelyOpen = new WeakMap()
    scope = valid && next ? { ...next, reader: { ...next.reader } } : null
    scopeIdentity = identity
    publish()
  }
  const measure = (headings: ReadingHeading[], articleTop: number, articleBottom: number): void => {
    cancelDwell()
    if (!scope) return
    const old = new Map(sections.map(section => [section.anchor, section]))
    const details = Array.from(container.querySelectorAll('details'))
    const next: ReadingSection[] = []
    const count = Math.max(1, headings.length)
    for (let index = 0; index < count; index++) {
      const heading = headings[index]
      const following = headings[index + 1]
      const range = document.createRange()
      if (index === 0) range.setStart(container, 0)
      else range.setStartBefore(heading!.element)
      if (following) range.setEndBefore(following.element)
      else range.setEnd(container, container.childNodes.length)
      const disclosures = details.filter(detail => range.intersectsNode(detail))
      const sectionFingerprint = readingFingerprint(`${range.toString()}\u0000${disclosures.length}`)
      const anchor = heading?.anchor ?? ''
      const units: ReadingUnit[] = [{
        start: heading && heading.top === null ? Infinity : index === 0 ? articleTop : heading!.top!,
        end: following?.top ?? articleBottom,
        ranges: []
      }]
      for (const detail of disclosures) {
        const summary = detail.querySelector(':scope > summary')
        const rect = detail.getBoundingClientRect()
        const summaryRect = summary?.getBoundingClientRect()
        const bodyStart = summaryRect?.bottom ?? rect.top
        const start = (rect.bottom > bodyStart ? bodyStart : summaryRect?.top ?? rect.top) + window.scrollY
        units.push({ start, end: Math.max(start, rect.bottom + window.scrollY), ranges: [], disclosure: detail })
      }
      const previous = old.get(anchor)
      if (previous?.fingerprint === sectionFingerprint && previous.units.length === units.length) {
        units.forEach((unit, unitIndex) => {
          const prior = previous.units[unitIndex]!
          // Completed coverage survives layout-only changes. Partial coverage
          // resets when its geometry changes rather than inventing a new span.
          if (readingCoverage(prior) >= 1 - Number.EPSILON || prior.end - prior.start === unit.end - unit.start) {
            unit.ranges = prior.ranges
          }
        })
      }
      next.push({ anchor, fingerprint: sectionFingerprint, units })
      range.detach()
    }
    sections = next
    const nextFingerprint = readingFingerprint(sections.map(section => `${section.anchor}\u0000${section.fingerprint}`).join('\u0001'))
    const contentChanged = fingerprint !== '' && fingerprint !== nextFingerprint
    fingerprint = nextFingerprint
    // A different revision or persisted page fingerprint resets all restored
    // progress. Live refresh keeps only exact, unchanged section fingerprints.
    if (!loaded) {
      loaded = true
      const saved = readRecord()
      if (saved) mergeRecord(saved)
    }
    publish()
    if (contentChanged) scheduleSave()
  }
  const sample = (scrollY: number, top: number, bottom: number): void => {
    const jumped = Math.abs(scrollY - previousScrollY) > Math.max(1, bottom - top)
    previousScrollY = scrollY
    viewTop = top
    viewBottom = bottom
    if (!scope || jumped || Date.now() > intentUntil || document.visibilityState === 'hidden') {
      suspend()
      return
    }
    if (dwellTimer === null) dwellTimer = window.setTimeout(awardViewport, READING_DWELL_MS)
  }
  const intent = (event: Event): void => {
    if (!scope || !event.isTrusted) return
    intentUntil = Date.now() + READING_INTENT_MS
  }
  const onSummaryClick = (event: MouseEvent): void => {
    if (!scope || !event.isTrusted || !(event.target instanceof Element)) return
    const summary = event.target.closest('summary')
    const detail = summary?.parentElement
    if (!(detail instanceof HTMLDetailsElement) || !container.contains(detail)) return
    if (detail.open) deliberatelyOpen.delete(detail)
    else deliberatelyOpen.set(detail, event)
    intent(event)
  }
  const toggle = (target: EventTarget | null): void => {
    if (target instanceof HTMLDetailsElement && !target.open) deliberatelyOpen.delete(target)
  }
  const onStorage = (event: StorageEvent): void => {
    if (!scope || !loaded || (event.key !== key() && event.key !== null)) return
    if (event.storageArea && storageAvailable) {
      try {
        if (event.storageArea !== window.localStorage) return
      } catch {
        storageAvailable = false
        return
      }
    }
    if (event.newValue === null) {
      suspend()
      cancelSave()
      changed = false
      sections.forEach(section => section.units.forEach(unit => { unit.ranges = [] }))
      publish()
      return
    }
    const record = decode(event.newValue)
    if (!record) return
    const merged = mergeRecord(record)
    const needsRepair = sections.some((section, sectionIndex) => section.units.some((unit, unitIndex) =>
      readingCoverage(unit) > record.sections[sectionIndex]!.coverage[unitIndex]!.reduce((total, [start, end]) => total + end - start, 0)
    ))
    if (merged) publish()
    // Repair a losing simultaneous write even if its sender closes before it
    // can receive our storage event. Equal records do not cause a write loop.
    if (merged || needsRepair) scheduleSave()
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') {
      suspend()
      persist()
    }
  }
  // Only the opt-in model owns these non-layout lifecycle listeners.
  container.addEventListener('click', onSummaryClick, true)
  window.addEventListener('storage', onStorage)
  window.addEventListener('pagehide', persist)
  document.addEventListener('visibilitychange', onVisibility)
  setScope(options.scope)
  publish()
  return {
    measure, sample, intent, suspend, setScope, toggle,
    dispose(): void {
      persist()
      disposed = true
      suspend()
      cancelSave()
      sections = []
      deliberatelyOpen = new WeakMap()
      container.removeEventListener('click', onSummaryClick, true)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('pagehide', persist)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
}

export type PageOutlineTracker = {
  dispose: () => void
  refresh: () => void
  setNavigationAnchor: (anchor: string | null) => void
  /** Available to the opt-in consumer; call before rendering changed authority. */
  setReadingProgressScope: (scope: PageReadingProgressScope | null) => void
}

/** Cache geometry on layout changes; ordinary scrolling performs a binary search. */
export function trackPageOutline(
  container: HTMLElement,
  entries: OutlineEntry[],
  onActive: (anchor: string) => void,
  onProgress?: (progress: number) => void,
  readingProgress?: PageReadingProgressOptions
): PageOutlineTracker {
  let headings: string[] = []
  let activationPositions: number[] = []
  let frame: number | null = null
  let dirty = true
  let disposed = false
  let lastAnchor = ''
  let lastProgress = -1
  let articleTop = 0
  let articleBottom = 0
  let viewportHeight = window.innerHeight
  let headerBottom = 64
  let documentScrollHeight = 0
  let navigationAnchor: string | null = null
  let navigationSettled = false
  let navigationScrollY = 0
  let navigationSettleTimer: number | null = null
  let scrollbarPointerDown = false
  const reading = readingProgress ? createReadingProgress(container, readingProgress) : null

  const clearNavigationSettleTimer = (): void => {
    if (navigationSettleTimer === null) return
    window.clearTimeout(navigationSettleTimer)
    navigationSettleTimer = null
  }

  const armNavigationSettleTimer = (): void => {
    clearNavigationSettleTimer()
    navigationSettleTimer = window.setTimeout(() => {
      navigationSettleTimer = null
      if (disposed || navigationAnchor === null) return
      navigationSettled = true
      navigationScrollY = window.scrollY
    }, 120)
  }

  const clearNavigationAnchor = (): boolean => {
    if (navigationAnchor === null) return false
    navigationAnchor = null
    navigationSettled = false
    clearNavigationSettleTimer()
    return true
  }

  const schedule = (): void => {
    if (frame === null) frame = requestAnimationFrame(update)
  }

  const isTocTarget = (target: EventTarget | null): boolean => {
    return target instanceof Element && Boolean(target.closest('.page-toc-content, .page-toc-list, .page-toc-filter'))
  }

  const isDocumentScrollKey = (event: KeyboardEvent): boolean => {
    if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key)) return false
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target?.isContentEditable || target?.closest('input, textarea, select, button, [contenteditable="true"]')) return false
    return !isTocTarget(event.target)
  }

  const update = (): void => {
    frame = null
    if (disposed) return
    if (container.style.display === 'none') {
      reading?.suspend()
      return
    }
    const scrollTop = window.scrollY
    if (dirty) {
      headings = []
      const positions: number[] = []
      const readingHeadings: ReadingHeading[] = []
      for (const entry of entries) {
        let id = entry.anchor.replace(/^#/, '')
        try {
          id = decodeURIComponent(id)
        } catch {
          /* Keep malformed literal IDs usable. */
        }
        const element = document.getElementById(id)
        if (!element || !container.contains(element)) continue
        // Keep offscreen headings, but exclude collapsed ones. Reuse these
        // rectangles for positioning instead of measuring every heading twice.
        const rects = element.getClientRects()
        if (rects.length === 0) {
          if (reading) readingHeadings.push({ anchor: entry.anchor, element, top: null })
          continue
        }
        let top = Infinity
        for (const rect of rects) {
          if (rect.width > 0 || rect.height > 0) top = Math.min(top, rect.top)
        }
        const position = (Number.isFinite(top) ? top : rects[0]!.top) + scrollTop
        headings.push(entry.anchor)
        positions.push(position)
        if (reading) readingHeadings.push({ anchor: entry.anchor, element, top: position })
      }
      const article = container.getBoundingClientRect()
      articleTop = article.top + scrollTop
      articleBottom = article.bottom + scrollTop
      viewportHeight = window.innerHeight
      headerBottom = document.querySelector('.nav-header')?.getBoundingClientRect().bottom ?? 64
      documentScrollHeight = document.scrollingElement?.scrollHeight ?? document.documentElement.scrollHeight
      activationPositions = positions.map(position => position - (headerBottom + 40))
      const maxScroll = Math.max(0, documentScrollHeight - viewportHeight)
      const terminalEnd = Math.max(0, Math.min(maxScroll, articleBottom - viewportHeight))
      const lastActivation = activationPositions[activationPositions.length - 1]
      if (terminalEnd > 0 && lastActivation !== undefined && lastActivation > terminalEnd) {
        const terminalStart = Math.max(0, terminalEnd - Math.max(1, viewportHeight - (headerBottom + 40)))
        const naturalTerminalSpan = lastActivation - terminalStart
        const reachableTerminalSpan = terminalEnd - terminalStart
        if (naturalTerminalSpan > 0 && reachableTerminalSpan > 0) {
          activationPositions = activationPositions.map(natural =>
            natural > terminalStart ? terminalStart + ((natural - terminalStart) * reachableTerminalSpan) / naturalTerminalSpan : natural
          )
        }
      }
      dirty = false
      reading?.measure(readingHeadings, articleTop, articleBottom)
    }

    const distance = articleBottom - articleTop - viewportHeight + headerBottom
    const progress = distance > 0 ? Math.round(Math.max(0, Math.min(1, (scrollTop + headerBottom - articleTop) / distance)) * 100) : 100
    if (progress !== lastProgress) {
      lastProgress = progress
      onProgress?.(progress)
    }
    if (navigationAnchor === null) reading?.sample(scrollTop, scrollTop + headerBottom, scrollTop + viewportHeight)
    else reading?.suspend()

    let anchor = navigationAnchor ?? ''
    if (anchor === '') {
      let index = activeOutlineIndex(activationPositions, scrollTop)
      // Before the first heading reaches its activation threshold the outline
      // has no active entry yet. As soon as the article is on screen the first
      // section is the honest highlight, so scrolling up never drops the
      // active row before it snaps back in.
      if (index === -1 && headings.length > 0 && scrollTop + viewportHeight > articleTop) index = 0
      anchor = headings[index] ?? ''
    }
    if (anchor !== lastAnchor) {
      lastAnchor = anchor
      onActive(anchor)
    }
  }

  const onScroll = (): void => {
    const currentScrollY = window.scrollY
    if (navigationAnchor !== null && (scrollbarPointerDown || (navigationSettled && currentScrollY !== navigationScrollY))) {
      clearNavigationAnchor()
    }
    if (navigationAnchor !== null) {
      navigationScrollY = currentScrollY
      navigationSettled = false
      armNavigationSettleTimer()
    }
    schedule()
  }

  const onWheel = (event: WheelEvent): void => {
    if (isTocTarget(event.target)) return
    reading?.intent(event)
    if (clearNavigationAnchor() || reading) schedule()
  }

  const onTouchStart = (event: TouchEvent): void => {
    if (isTocTarget(event.target)) return
    reading?.intent(event)
    if (clearNavigationAnchor() || reading) schedule()
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (!isDocumentScrollKey(event)) return
    if (event.key === 'End' || event.key === 'Home') reading?.suspend()
    else reading?.intent(event)
    if (clearNavigationAnchor() || reading) schedule()
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (isTocTarget(event.target)) return
    const root = document.documentElement
    scrollbarPointerDown = event.clientX >= root.clientWidth || event.clientY >= root.clientHeight
    if (scrollbarPointerDown) reading?.intent(event)
  }

  const onPointerUp = (): void => {
    scrollbarPointerDown = false
    reading?.suspend()
  }

  const measure = (event?: Event): void => {
    if (event?.type === 'toggle') reading?.toggle(event.target)
    dirty = true
    schedule()
  }

  const resize = new ResizeObserver(() => measure())
  resize.observe(container)
  const main = container.closest('main')
  if (main) resize.observe(main)
  const header = document.querySelector('.nav-header')
  if (header) resize.observe(header)
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', measure)
  window.addEventListener('wheel', onWheel, { passive: true })
  window.addEventListener('touchstart', onTouchStart, { passive: true })
  if (reading) window.addEventListener('touchmove', onTouchStart, { passive: true })
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('pointerdown', onPointerDown, { passive: true })
  window.addEventListener('pointerup', onPointerUp, { passive: true })
  window.addEventListener('pointercancel', onPointerUp, { passive: true })
  window.addEventListener('blur', onPointerUp)
  container.addEventListener('toggle', measure, true)
  container.addEventListener('load', measure, true)
  void document.fonts?.ready.then(() => {
    if (!disposed) measure()
  })
  schedule()

  return {
    refresh: measure,
    setReadingProgressScope(scope: PageReadingProgressScope | null): void {
      reading?.setScope(scope)
      measure()
    },
    setNavigationAnchor(anchor: string | null): void {
      reading?.suspend()
      if (!anchor) {
        clearNavigationAnchor()
      } else {
        navigationAnchor = anchor
        navigationSettled = false
        navigationScrollY = window.scrollY
        armNavigationSettleTimer()
      }
      schedule()
    },
    dispose(): void {
      disposed = true
      clearNavigationSettleTimer()
      reading?.dispose()
      resize.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', measure)
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchstart', onTouchStart)
      if (reading) window.removeEventListener('touchmove', onTouchStart)
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('blur', onPointerUp)
      container.removeEventListener('toggle', measure, true)
      container.removeEventListener('load', measure, true)
    }
  }
}
