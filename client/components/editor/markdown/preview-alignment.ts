const detailsBlockStart = /^(\s*<details)(?=[\s>])/i

export type PreviewAlignmentMeasurements = {
  sourceViewportTop: number
  sourceViewportHeight: number
  cursorTop: number
  cursorBottom: number
  previewViewportTop: number
  previewViewportHeight: number
  destinationTop: number
  destinationBottom: number
  currentScrollTop: number
  maxScrollTop: number
}

export type PreviewAlignment = {
  scrollTop: number
}

const finiteOr = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(Math.max(value, minimum), maximum)

/**
 * Compute a bounded scroll plan that puts the preview destination at the same
 * relative vertical position as the source cursor.
 */
export function calculatePreviewAlignment(measurements: PreviewAlignmentMeasurements): PreviewAlignment {
  const sourceViewportTop = finiteOr(measurements.sourceViewportTop, 0)
  const sourceViewportHeight = Math.max(0, finiteOr(measurements.sourceViewportHeight, 0))
  const cursorTop = finiteOr(measurements.cursorTop, sourceViewportTop)
  const cursorBottom = finiteOr(measurements.cursorBottom, cursorTop)
  const cursorCenter = (Math.min(cursorTop, cursorBottom) + Math.max(cursorTop, cursorBottom)) / 2
  const cursorRatio = clamp(
    (cursorCenter - sourceViewportTop) / Math.max(sourceViewportHeight, 1),
    0,
    1
  )
  const previewViewportTop = finiteOr(measurements.previewViewportTop, 0)
  const previewViewportHeight = Math.max(0, finiteOr(measurements.previewViewportHeight, 0))
  const destinationTop = finiteOr(measurements.destinationTop, previewViewportTop)
  const destinationBottom = finiteOr(measurements.destinationBottom, destinationTop)
  const destinationHeight = Math.max(0, destinationBottom - destinationTop)
  const destinationTravel = Math.max(0, previewViewportHeight - destinationHeight)
  const desiredDestinationTop = clamp(
    cursorRatio * previewViewportHeight - destinationHeight / 2,
    0,
    destinationTravel
  )
  const maxScrollTop = Math.max(0, finiteOr(measurements.maxScrollTop, 0))
  const currentScrollTop = clamp(finiteOr(measurements.currentScrollTop, 0), 0, maxScrollTop)
  const currentDestinationTop = destinationTop - previewViewportTop
  const scrollTop = clamp(
    currentScrollTop + currentDestinationTop - desiredDestinationTop,
    0,
    maxScrollTop
  )

  return {
    scrollTop
  }
}

/** Merge cursor/click notifications, and invalidate queued work when follow is turned off. */
export class PreviewAlignmentScheduler {
  private revision = 0
  private pending = false
  private force = false

  constructor(
    private readonly canAlign: () => boolean,
    private readonly align: (force: boolean) => void,
    private readonly schedule: (callback: () => void) => void = callback => queueMicrotask(callback)
  ) {}

  request(force = false): void {
    if (!this.canAlign()) return
    this.force ||= force
    if (this.pending) return
    this.pending = true
    const revision = this.revision
    this.schedule(() => {
      if (revision !== this.revision) return
      this.pending = false
      const force = this.force
      this.force = false
      if (this.canAlign()) this.align(force)
    })
  }

  cancel(): void {
    this.revision++
    this.pending = false
    this.force = false
  }
}

/**
 * Gives a raw details block a stable source anchor without changing the saved Markdown.
 */
export function stampDetailsSourceLine(html: string, sourceLine: number): string | null {
  if (!detailsBlockStart.test(html)) return null
  return html.replace(detailsBlockStart, `$1 data-source-line="${sourceLine}"`)
}

/**
 * Hidden descendants retain layout offsets in some browsers. Align a source line inside
 * a collapsed disclosure to its outermost visible summary instead.
 */
export function resolveVisiblePreviewTarget(target: HTMLElement): HTMLElement {
  let disclosure = target.closest<HTMLDetailsElement>('details')
  let collapsedDisclosure: HTMLDetailsElement | null = null

  while (disclosure) {
    if (!disclosure.open) collapsedDisclosure = disclosure
    disclosure = disclosure.parentElement?.closest<HTMLDetailsElement>('details') ?? null
  }

  if (!collapsedDisclosure) return target
  for (const child of collapsedDisclosure.children) {
    if (child.localName === 'summary') return child as HTMLElement
  }
  return collapsedDisclosure
}
