import { afterEach, vi } from './bun-test.mts'
import { JSDOM } from 'jsdom'
import { configureTransportRuntime } from '../controllers/_types.ts'

Reflect.set(globalThis, 'vi', vi)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'https://wiki.example.test/' })
const window = dom.window

for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis) continue
  Object.defineProperty(globalThis, key, {
    configurable: true,
    enumerable: false,
    get: () => Reflect.get(window, key)
  })
}

for (const key of [
  'window', 'self', 'document', 'navigator', 'location', 'Node', 'Element', 'HTMLElement', 'HTMLCanvasElement',
  'Event', 'CustomEvent', 'EventTarget', 'MouseEvent', 'KeyboardEvent', 'MutationObserver', 'DOMParser', 'XMLSerializer'
]) {
  const value = key === 'window' || key === 'self' ? window : Reflect.get(window, key)
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
}
window.setTimeout = (...args) => globalThis.setTimeout(...args)
window.clearTimeout = handle => globalThis.clearTimeout(handle)
window.setInterval = (...args) => globalThis.setInterval(...args)
window.clearInterval = handle => globalThis.clearInterval(handle)


window.fetch = globalThis.fetch.bind(globalThis)
window.Headers = globalThis.Headers
window.Request = globalThis.Request
window.Response = globalThis.Response

configureTransportRuntime(new Proxy({}, {
  get: (_target, property) => {
    const wiki = Reflect.get(globalThis, 'WIKI')
    return typeof wiki === 'object' && wiki !== null ? Reflect.get(wiki, property) : undefined
  }
}))

afterEach(() => {
  vi.clearAllMocks()
})
