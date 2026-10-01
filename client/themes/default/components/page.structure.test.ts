import fs from 'node:fs'
import path from 'node:path'
import ClipboardJS from 'clipboard'
import * as Vue from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody } from '../../../test/browser-dom.mts'
import { hydrateContentExtensions } from '../../../helpers/content-extension-runtime'
import { selectMermaidRenderHosts } from '../../../helpers/content-extension-runtimes/mermaid'
import { trackPageOutline } from '../../../helpers/page-outline'
import type { PageOutlineTracker } from '../../../helpers/page-outline'
import boot from '../../../modules/boot'

import Prism from '../../../libs/prism/setup'
const source = fs.readFileSync(path.join(import.meta.dir, 'page.vue'), 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>\s*([\s\S]*?)\s*<\/script>/)?.[1]
if (!script) throw new Error('page.vue script block was not found')
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  script.replace(/^import[\s\S]*?from\s+["'][^"']+["']\s*$/gm, '').replace('export default defineComponent({', 'const pageComponent = defineComponent({') + '\nreturn pageComponent'
)
const componentStub = {}
const component = new Function(
  'defineComponent', 'h', 'markRaw', 'mergeProps', 'useGoTo', 'i18next',
  'AsyncState', 'PageBrandingMark', 'StatusIndicator', 'SiteBanner', 'NavSidebar',
  'Prism', 'ClipboardJS', 'hydrateContentExtensions', 'selectMermaidRenderHosts', 'trackPageOutline', 'boot',
  executableScript
)(
  Vue.defineComponent, Vue.h, Vue.markRaw, Vue.mergeProps, () => () => {}, { t: (key: string) => key },
  componentStub, componentStub, componentStub, componentStub, componentStub,
  Prism, ClipboardJS, hydrateContentExtensions, selectMermaidRenderHosts, trackPageOutline, boot
) as { methods: { refreshPageContent: (this: ReaderContentVm) => void } }

type ReaderContentVm = {
  $refs: { container: HTMLElement }
  $vuetify: { theme: { current: { dark: boolean } } }
  $nextTick: (callback: () => void) => Promise<void>
  tocFlattened: []
  mermaidAbortController?: AbortController
  contentExtensionCleanup?: () => void
  outlineCleanup?: PageOutlineTracker
  setupTocResizeObserver: () => void
  ensureActiveTocVisible: () => void
}

const cleanups: Array<() => void> = []
let clipboardDescriptor: PropertyDescriptor | undefined
let execCommandDescriptor: PropertyDescriptor | undefined
beforeEach(() => {
  resetBody()
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0)
  // The test preload bridges window timers to the fake global clock.
  clipboardDescriptor = Object.getOwnPropertyDescriptor(browserWindow.navigator, 'clipboard')
  execCommandDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  if (clipboardDescriptor) Object.defineProperty(browserWindow.navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(browserWindow.navigator, 'clipboard')
  if (execCommandDescriptor) Object.defineProperty(document, 'execCommand', execCommandDescriptor)
  else Reflect.deleteProperty(document, 'execCommand')
  vi.restoreAllMocks()
  vi.useRealTimers()
  resetBody()
})

const readerContent = (emptyBlocks = false): HTMLElement => {
  const main = document.createElement('main')
  main.className = 'v-main'
  main.innerHTML = `<article class="contents">
    <p>Inline <code id="inline-code">npm run example</code></p>
    <pre id="ordinary"><code class="language-javascript">${emptyBlocks ? '' : 'const ordinary = 1;'}</code></pre>
    <section id="framed" class="codeblock-framed"><header>Example</header><pre><code class="language-javascript">${emptyBlocks ? '' : 'const framed = 2;'}</code></pre></section>
  </article>`
  document.body.append(main)
  const container = main.querySelector<HTMLElement>('.contents')!
  const vm: ReaderContentVm = {
    $refs: { container },
    $vuetify: { theme: { current: { dark: false } } },
    $nextTick: async callback => { callback() },
    tocFlattened: [],
    setupTocResizeObserver: () => {},
    ensureActiveTocVisible: () => {}
  }
  component.methods.refreshPageContent.call(vm)
  cleanups.push(() => {
    vm.mermaidAbortController?.abort()
    vm.contentExtensionCleanup?.()
    vm.outlineCleanup?.dispose()
    main.remove()
  })
  return container
}

const finishAnimation = (element: Element, name?: string): void => {
  const event = new Event('animationend', { bubbles: true })
  if (name) Object.defineProperty(event, 'animationName', { value: name })
  element.dispatchEvent(event)
}

const hover = (element: Element, relatedTarget: EventTarget | null = null): void => {
  element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget }))
}
describe('reader code copy interactions', () => {
  it.each([true, false])('acknowledges inline click, not hover or ambient time (copy succeeds: %s)', async succeeds => {
    let resolve!: () => void
    const pendingCopy = new Promise<void>(done => { resolve = done })
    const writeText = vi.fn(() => pendingCopy)
    Object.defineProperty(browserWindow.navigator, 'clipboard', { configurable: true, value: { writeText } })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => succeeds })
    if (!succeeds) writeText.mockImplementation(() => Promise.reject(new Error('Clipboard denied')))
    const container = readerContent()
    const inline = container.querySelector<HTMLElement>('#inline-code')!
    hover(inline)
    await vi.advanceTimersByTimeAsync(36_000)
    expect(inline.classList.contains('wiki-inline-shimmer-run')).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
    inline.click()
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenCalledWith('npm run example')
    expect(inline.dataset.inlineCopyState).toBe(succeeds ? 'success' : 'error')
    expect(inline.classList.contains('wiki-inline-shimmer-run')).toBe(true)
    finishAnimation(inline)
    expect(inline.classList.contains('wiki-inline-shimmer-run')).toBe(false)
  })

  it('runs ambient and first-entry button sweeps, ignores child movement and later entries, then resumes', async () => {
    const container = readerContent()
    const pre = container.querySelector<HTMLElement>('#ordinary')!
    const toolbar = pre.closest<HTMLElement>('.code-toolbar')!
    const button = toolbar.querySelector<HTMLButtonElement>('.toolbar button')!
    expect(button.classList.contains('wiki-copy-shimmer-run')).toBe(false)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(button.classList.contains('wiki-copy-shimmer-run')).toBe(true)
    finishAnimation(button)
    hover(pre)
    expect(button.classList.contains('wiki-copy-shimmer-run')).toBe(true)
    finishAnimation(button)
    hover(button, pre)
    hover(pre)
    expect(button.classList.contains('wiki-copy-shimmer-run')).toBe(false)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(button.classList.contains('wiki-copy-shimmer-run')).toBe(false)
    await vi.advanceTimersByTimeAsync(1_900 + 3_000)
    expect(button.classList.contains('wiki-copy-shimmer-run')).toBe(true)
  })

  it.each([true, false])('flashes ordinary and titled panels for nonempty and empty clipboard content (nonempty: %s)', nonempty => {
    // ClipboardJS emits error for an empty copy action, not for execCommand
    // returning false. Exercise that actual dependency boundary on empty code.
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => true })
    const container = readerContent(!nonempty)
    for (const id of ['ordinary', 'framed']) {
      const panel = container.querySelector<HTMLElement>(`#${id}`)!
      const toolbar = id === 'ordinary' ? panel.closest<HTMLElement>('.code-toolbar')! : panel.querySelector<HTMLElement>('.code-toolbar')!
      const button = toolbar.querySelector<HTMLButtonElement>('.toolbar button')!
      button.click()
      expect(panel.classList.contains('wiki-code-copy-flash-run')).toBe(true)
      expect(toolbar.classList.contains('wiki-code-copy-flash-run')).toBe(false)
      if (id === 'framed') expect(panel.querySelector('pre')!.classList.contains('wiki-code-copy-flash-run')).toBe(false)
      expect(button.dataset.copyState).toBe(nonempty ? 'success' : 'error')
      finishAnimation(panel, 'wiki-code-block-copy-sweep')
      expect(panel.classList.contains('wiki-code-copy-flash-run')).toBe(false)
    }
  })
})
