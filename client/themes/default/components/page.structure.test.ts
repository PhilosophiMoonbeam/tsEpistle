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
import { UTILITY_TOOLTIP_GAP } from '../../../helpers/utility-tooltip-placement'
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
  'siteLangs', 'UTILITY_TOOLTIP_GAP',
  executableScript
)(
  Vue.defineComponent, Vue.h, Vue.markRaw, Vue.mergeProps, () => () => {}, { t: (key: string) => key },
  componentStub, componentStub, componentStub, componentStub, componentStub,
  Prism, ClipboardJS, hydrateContentExtensions, selectMermaidRenderHosts, trackPageOutline, boot,
  [], UTILITY_TOOLTIP_GAP
) as {
  data: () => Record<string, unknown>
  methods: Record<string, (this: ReaderContentVm, ...args: unknown[]) => unknown>
}

type ReaderContentVm = {
  [name: string]: unknown
  $refs: { container: HTMLElement }
  $vuetify: { theme: { current: { dark: boolean } } }
  $nextTick: (callback: () => void) => Promise<void>
  tocFlattened: []
  mermaidAbortController: AbortController | null
  contentExtensionCleanup: (() => void) | null
  outlineCleanup: PageOutlineTracker | null
  refreshPageContent: () => void
  setupTocResizeObserver: () => void
  ensureActiveTocVisible: () => void
}

const cleanups: Array<() => void> = []
let clipboardDescriptor: PropertyDescriptor | undefined
let execCommandDescriptor: PropertyDescriptor | undefined
beforeEach(() => {
  resetBody()
  vi.useFakeTimers()
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
  const vm = {
    ...component.data(),
    $refs: { container },
    $vuetify: { theme: { current: { dark: false } } },
    $nextTick: async (callback: () => void) => { callback() },
    tocFlattened: []
  } as ReaderContentVm
  for (const [name, method] of Object.entries(component.methods)) vm[name] = method.bind(vm)
  // The copy fixture has no outline UI; keep only those unrelated layout seams.
  vm.setupTocResizeObserver = () => {}
  vm.ensureActiveTocVisible = () => {}
  cleanups.push(() => {
    vm.mermaidAbortController?.abort()
    vm.contentExtensionCleanup?.()
    vm.outlineCleanup?.dispose()
    main.remove()
  })
  vm.refreshPageContent()
  return container
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
    expect(writeText).not.toHaveBeenCalled()
    inline.click()
    resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(writeText).toHaveBeenCalledWith('npm run example')
    expect(inline.dataset.inlineCopyState).toBe(succeeds ? 'success' : 'error')
  })


  it.each([true, false])('reports ordinary and titled block copy outcomes for nonempty and empty content (nonempty: %s)', nonempty => {
    // ClipboardJS emits error for an empty copy action, not for execCommand
    // returning false. Exercise that actual dependency boundary on empty code.
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => true })
    const container = readerContent(!nonempty)
    for (const id of ['ordinary', 'framed']) {
      const panel = container.querySelector<HTMLElement>(`#${id}`)!
      const toolbar = id === 'ordinary' ? panel.closest<HTMLElement>('.code-toolbar')! : panel.querySelector<HTMLElement>('.code-toolbar')!
      const button = toolbar.querySelector<HTMLButtonElement>('.toolbar button')!
      button.click()
      expect(button.dataset.copyState).toBe(nonempty ? 'success' : 'error')
    }
  })
})
