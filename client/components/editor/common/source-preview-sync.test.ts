import { describe, expect, it } from '../../../../server/test/bun-test.mts'
import { mapLinePosition, SourcePreviewSync } from './source-preview-sync'

function withPanes(
  run: (fixture: {
    sync: SourcePreviewSync
    container: HTMLElement
    flush: () => void
    queued: Map<number, FrameRequestCallback>
    source: { line: number; moves: number[]; enabled: boolean }
    middle: { top: number }
  }) => void
): void {
  const originalRequest = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  const originalCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame')
  const originalAbortController = Object.getOwnPropertyDescriptor(globalThis, 'AbortController')
  const originalAbortSignal = Object.getOwnPropertyDescriptor(globalThis, 'AbortSignal')
  const queued = new Map<number, FrameRequestCallback>()
  let serial = 0
  const source = { line: 25, moves: [] as number[], enabled: true }
  const middle = { top: 700 }
  const container = document.createElement('div')
  const paneWindow = container.ownerDocument.defaultView!
  const preview = container.appendChild(document.createElement('div'))
  document.body.appendChild(container)
  Object.defineProperties(container, { clientHeight: { value: 100 }, scrollHeight: { value: 1100 } })
  container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  for (const [line, top] of [
    [0, 0],
    [50, 700],
    [100, 1000]
  ]) {
    const element = preview.appendChild(document.createElement('p'))
    element.dataset.sourceLine = String(line)
    element.getBoundingClientRect = () => ({ top: (line === 50 ? middle.top : top!) - container.scrollTop }) as DOMRect
  }
  const sync = new SourcePreviewSync(
    () => ({
      lineCount: 101,
      viewportLine: () => source.line,
      scrollToLine: line => {
        source.line = line
        source.moves.push(line)
        sync.sourceScrolled()
      }
    }),
    () => source.enabled,
    () => {}
  )
  const flush = () => {
    const pending = [...queued.values()]
    queued.clear()
    for (const callback of pending) callback(0)
  }
  try {
    Object.defineProperties(globalThis, {
      requestAnimationFrame: {
        configurable: true,
        writable: true,
        value: (callback: FrameRequestCallback) => {
          queued.set(++serial, callback)
          return serial
        }
      },
      cancelAnimationFrame: {
        configurable: true,
        writable: true,
        value: (id: number) => {
          queued.delete(id)
        }
      },
      AbortController: {
        configurable: true,
        writable: true,
        value: paneWindow.AbortController
      },
      AbortSignal: {
        configurable: true,
        writable: true,
        value: paneWindow.AbortSignal
      }
    })
    sync.attach(preview, container)
    run({ sync, container, flush, queued, source, middle })
  } finally {
    try {
      sync.detach()
      container.remove()
    } finally {
      if (originalRequest) Object.defineProperty(globalThis, 'requestAnimationFrame', originalRequest)
      else Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
      if (originalCancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', originalCancel)
      else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame')
      if (originalAbortController) Object.defineProperty(globalThis, 'AbortController', originalAbortController)
      else Reflect.deleteProperty(globalThis, 'AbortController')
      if (originalAbortSignal) Object.defineProperty(globalThis, 'AbortSignal', originalAbortSignal)
      else Reflect.deleteProperty(globalThis, 'AbortSignal')
    }
  }
}

describe('source/preview line synchronization', () => {
  it('interpolates uneven block heights in both directions, including fractional lines and endpoints', () => {
    const anchors = [
      { line: 0, top: 0 },
      { line: 10, top: 200 },
      { line: 50, top: 300 }
    ]
    expect(mapLinePosition(anchors, 5.5)).toBe(110)
    expect(mapLinePosition(anchors, 250, true)).toBe(30)
    expect(mapLinePosition(anchors, -10)).toBe(0)
    expect(mapLinePosition(anchors, 999)).toBe(300)
    expect(mapLinePosition(anchors, 999, true)).toBe(50)
    expect(mapLinePosition([], 4)).toBe(0)
  })

  it('elects the deliberately scrolled pane and ignores both follower echoes without changing leadership', () => {
    withPanes(({ sync, container, flush, queued, source }) => {
      flush()
      expect(container.scrollTop).toBe(350)
      expect(source.moves).toEqual([])
      container.dispatchEvent(new Event('scroll'))
      expect(queued.size).toBe(0)

      container.dispatchEvent(new Event('wheel'))
      container.scrollTop = 700
      container.dispatchEvent(new Event('scroll'))
      flush()
      expect(source.moves).toEqual([50])
      expect(queued.size).toBe(0)
      container.dispatchEvent(new Event('scroll'))
      expect(queued.size).toBe(0)

      sync.interact('source')
      source.line = 75
      sync.sourceScrolled()
      flush()
      expect(container.scrollTop).toBe(850)
      expect(source.moves).toEqual([50])
    })
  })

  it('retains preview leadership through pending edits and remeasures the accepted rerender instead of stale anchors', () => {
    withPanes(({ sync, container, flush, source, middle }) => {
      flush()
      container.dispatchEvent(new Event('wheel'))
      container.scrollTop = 700
      container.dispatchEvent(new Event('scroll'))
      flush()
      source.enabled = false
      middle.top = 900
      sync.request()
      flush()
      expect(container.scrollTop).toBe(700)
      expect(source.moves).toEqual([50])
      source.enabled = true
      sync.request()
      flush()
      expect(container.scrollTop).toBe(900)
      expect(source.moves).toEqual([50, 50])
    })
  })

  it('adopts the preview position when following is re-enabled instead of snapping to its former position', () => {
    withPanes(({ sync, container, flush, source }) => {
      flush()
      source.enabled = false
      container.dispatchEvent(new Event('wheel'))
      container.scrollTop = 700
      container.dispatchEvent(new Event('scroll'))
      flush()
      expect(source.moves).toEqual([])
      source.enabled = true
      sync.resumeFromLeader()
      flush()
      expect(container.scrollTop).toBe(700)
      expect(source.moves).toEqual([50])
    })
  })

  it('honors disabled synchronization and cancels queued work when input changes leader or panes close', () => {
    withPanes(({ sync, container, flush, queued, source }) => {
      source.enabled = false
      flush()
      expect(container.scrollTop).toBe(0)
      source.enabled = true
      sync.request()
      sync.interact('preview')
      flush()
      expect(container.scrollTop).toBe(0)
      expect(source.moves).toEqual([])
      sync.request()
      sync.detach()
      expect(queued.size).toBe(0)
      flush()
      expect(source.moves).toEqual([])
    })
  })
})
