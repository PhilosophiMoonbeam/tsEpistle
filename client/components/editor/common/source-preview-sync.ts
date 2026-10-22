import type { TextEditorHandle } from './text-editor'
import { resolveVisiblePreviewTarget } from '../markdown/preview-alignment'

export type LineAnchor = { line: number; top: number }
export type EditorPane = 'source' | 'preview'

/** Interpolate in source-line space, not proportional document heights. */
export function mapLinePosition(anchors: readonly LineAnchor[], value: number, reverse = false): number {
  if (!anchors.length) return 0
  const from = (anchor: LineAnchor) => (reverse ? anchor.top : anchor.line)
  const to = (anchor: LineAnchor) => (reverse ? anchor.line : anchor.top)
  let previous = anchors[0]!
  if (value <= from(previous)) return to(previous)
  for (let index = 1; index < anchors.length; index++) {
    const next = anchors[index]!
    if (value <= from(next)) {
      const span = from(next) - from(previous)
      return span <= 0 ? to(next) : to(previous) + ((to(next) - to(previous)) * (value - from(previous))) / span
    }
    previous = next
  }
  return to(previous)
}

export class SourcePreviewSync {
  private leadingPane: EditorPane = 'source'
  private container: HTMLElement | null = null
  private preview: HTMLElement | null = null
  private abort: AbortController | null = null
  private resize: ResizeObserver | null = null
  private mutation: MutationObserver | null = null
  private frame: number | null = null
  private previewLine = 0

  constructor(
    private readonly source: () => Pick<TextEditorHandle, 'viewportLine' | 'scrollToLine' | 'lineCount'> | null,
    private readonly enabled: () => boolean,
    private readonly current: (line: number) => void
  ) {}
  private expectedPreviewTop: number | null = null

  interact(pane: EditorPane): void {
    this.leadingPane = pane
    this.cancel()
    this.expectedPreviewTop = null
    if (pane === 'preview' && this.container && this.enabled()) this.previewLine = this.lineAtPreviewTop()
  }

  sourceScrolled(): void {
    if (this.leadingPane === 'source') this.request()
  }

  /** Enabling follow adopts the pane's current position, unlike a rerender. */
  resumeFromLeader(): void {
    if (this.leadingPane === 'preview' && this.container && this.enabled()) this.previewLine = this.lineAtPreviewTop()
    this.request()
  }

  attach(preview: HTMLElement, container: HTMLElement): void {
    if (this.preview !== preview || this.container !== container) {
      this.detach()
      this.preview = preview
      this.container = container
      this.abort = new AbortController()
      const signal = this.abort.signal
      for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        container.addEventListener(type, () => this.interact('preview'), { signal, passive: true })
      }
      container.addEventListener(
        'scroll',
        () => {
          if (this.leadingPane !== 'preview') return
          if (this.expectedPreviewTop !== null && Math.abs(container.scrollTop - this.expectedPreviewTop) < 1) return
          // Never derive a new position from stale anchors while an edit is pending.
          if (this.enabled()) this.previewLine = this.lineAtPreviewTop()
          this.request()
        },
        { signal, passive: true }
      )
      container.addEventListener('load', () => this.request(), { signal, capture: true })
      if (typeof ResizeObserver !== 'undefined') {
        this.resize = new ResizeObserver(() => this.request())
        this.resize.observe(preview)
        this.resize.observe(container)
      }
      if (typeof MutationObserver !== 'undefined') {
        this.mutation = new MutationObserver(() => this.request())
        this.mutation.observe(preview, { childList: true, subtree: true, attributes: true })
      }
    }
    this.request()
  }

  request(): void {
    if (this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      const source = this.source()
      if (!source) return
      const line = this.leadingPane === 'source' || !this.enabled() ? source.viewportLine() : this.previewLine
      this.current(line)
      if (!this.enabled() || !this.preview || !this.container || !this.container.clientHeight) return
      if (this.leadingPane === 'source') {
        this.setPreviewLine(line)
      } else {
        // Reapply the same logical line after asynchronous preview enhancement/rerender.
        this.setPreviewLine(line)
        source.scrollToLine(line)
      }
    })
  }

  private anchors(): LineAnchor[] {
    const container = this.container!
    const top = container.getBoundingClientRect().top
    const maximum = Math.max(0, container.scrollHeight - container.clientHeight)
    const anchors: LineAnchor[] = [{ line: 0, top: 0 }]
    for (const element of this.preview!.querySelectorAll<HTMLElement>('[data-source-line]')) {
      const line = Number(element.dataset.sourceLine)
      if (!Number.isFinite(line) || line < 0) continue
      const target = resolveVisiblePreviewTarget(element)
      anchors.push({ line, top: Math.min(maximum, Math.max(0, target.getBoundingClientRect().top - top + container.scrollTop)) })
    }
    anchors.sort((a, b) => a.line - b.line || a.top - b.top)
    const ordered: LineAnchor[] = []
    for (const anchor of anchors) {
      const previous = ordered[ordered.length - 1]
      if (previous && (anchor.line <= previous.line || anchor.top <= previous.top)) continue
      if (maximum > 0 && anchor.top >= maximum) continue
      ordered.push(anchor)
    }
    const end = Math.max(0, (this.source()?.lineCount ?? 1) - 1)
    if (end > ordered[ordered.length - 1]!.line) ordered.push({ line: end, top: maximum })
    return ordered
  }
  private setPreviewLine(line: number): void {
    const container = this.container!
    container.scrollTop = mapLinePosition(this.anchors(), line)
    this.expectedPreviewTop = container.scrollTop
  }

  private lineAtPreviewTop(): number {
    return mapLinePosition(this.anchors(), this.container!.scrollTop, true)
  }

  cancel(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
  }

  detach(): void {
    this.cancel()
    this.abort?.abort()
    this.resize?.disconnect()
    this.mutation?.disconnect()
    this.abort = null
    this.resize = null
    this.mutation = null
    this.preview = null
    this.container = null
  }
}
