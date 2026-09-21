import { JSDOM } from 'jsdom'

// Shared singleton test DOM for client component tests.
//
// bun test evaluates CJS dependencies (vue is CJS) during import-graph loading,
// which can happen before any ESM module body runs, so vue's runtime-dom always
// captures the document of the bunfig preload window created by
// server/test/setup-runtime.js. Rather than racing that, this harness ADOPTS the
// preload window as the one shared test DOM: every mounted element, every test
// file, and vue all use the same window for the whole process. The common
// browser stubs are installed on it exactly once, here. When the harness is
// imported without the preload (bun without bunfig), it creates its own window
// and exposes it the same way.
//
// Per-file overrides (matchMedia, visualViewport, fetch, ...) keep working: they
// simply redefine the properties on the shared window.

function ownWindow(): { dom: JSDOM; browserWindow: Window } {
  const shared = (globalThis as { __wikiTestJsdom?: JSDOM }).__wikiTestJsdom
  if (shared) return { dom: shared, browserWindow: shared.window as unknown as Window }
  const created = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/'
  })
  Reflect.set(globalThis, '__wikiTestJsdom', created)
  return { dom: created, browserWindow: created.window as unknown as Window }
}

const singleton = ownWindow()
export const dom = singleton.dom
export const browserWindow = singleton.browserWindow
export const document = browserWindow.document

const css = { escape: (value: string) => value, supports: () => false }
class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const visualViewportStub = {
  width: 1024,
  height: 768,
  offsetLeft: 0,
  offsetTop: 0,
  pageLeft: 0,
  pageTop: 0,
  scale: 1,
  addEventListener: () => undefined,
  removeEventListener: () => undefined
}

Object.defineProperty(browserWindow, 'fetch', { configurable: true, writable: true, value: () => Promise.resolve() })
Object.defineProperty(browserWindow.Element.prototype, 'scrollIntoView', { configurable: true, value(): void {} })
Object.defineProperties(browserWindow, {
  CSS: { configurable: true, value: css },
  IntersectionObserver: { configurable: true, value: ObserverStub },
  ResizeObserver: { configurable: true, value: ObserverStub },
  devicePixelRatio: { configurable: true, value: 1 },
  matchMedia: {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('max-width: 639.98px'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true
    })
  },
  visualViewport: { configurable: true, value: visualViewportStub }
})

const browserGlobals: Record<string, unknown> = {
  CSS: css,
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLElement: browserWindow.HTMLElement,
  HTMLButtonElement: browserWindow.HTMLButtonElement,
  HTMLDetailsElement: browserWindow.HTMLDetailsElement,
  HTMLImageElement: browserWindow.HTMLImageElement,
  HTMLInputElement: browserWindow.HTMLInputElement,
  HTMLTextAreaElement: browserWindow.HTMLTextAreaElement,
  IntersectionObserver: ObserverStub,
  KeyboardEvent: browserWindow.KeyboardEvent,
  MouseEvent: browserWindow.MouseEvent,
  MutationObserver: browserWindow.MutationObserver,
  Node: browserWindow.Node,
  ResizeObserver: ObserverStub,
  SVGElement: browserWindow.SVGElement,
  Text: browserWindow.Text,
  cancelAnimationFrame: (browserWindow.cancelAnimationFrame as (h: number) => void).bind(browserWindow),
  devicePixelRatio: 1,
  document: browserWindow.document,
  fetch: browserWindow.fetch,
  getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
  navigator: browserWindow.navigator,
  requestAnimationFrame: (browserWindow.requestAnimationFrame as (cb: (t: number) => void) => number).bind(browserWindow),
  visualViewport: visualViewportStub,
  window: browserWindow
}
for (const [name, value] of Object.entries(browserGlobals)) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}

// Per-file location overrides without touching the shared window identity.
// Accepts absolute URLs and same-origin paths; jsdom's history.pushState cannot
// change origin, so full reconfiguration is used instead (same as jest-environment-jsdom).
export function setLocation(target: string): void {
  const url = /^https?:\/\//.test(target) ? target : new URL(target, browserWindow.location.href).href
  dom.reconfigure({ url })
}

// Give each converted test file the same empty body it used to get from its own JSDOM.
export function resetBody(): void {
  document.body.innerHTML = ''
}
