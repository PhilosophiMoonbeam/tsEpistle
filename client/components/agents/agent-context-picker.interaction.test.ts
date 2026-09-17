import { parse, compileTemplate } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import path from 'node:path'
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { AgentKnowledgeContextSchema } from '../../../shared/agents/knowledge-context.ts'
import type { AgentDraft } from '../../helpers/agent-draft.ts'
import type { AgentCurrentPageHint } from '../../../shared/agents/contracts.ts'
import type { PageSearchResult, PageSearchRow } from '../../helpers/pages-api.ts'
import type { WikiSource } from '../../../shared/wiki-source.ts'

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-context-picker.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const descriptor = parse(componentSource, { filename: componentPath }).descriptor
if (!descriptor.template || !descriptor.scriptSetup) throw new Error('agent-context-picker.vue template and setup script are required')

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/wiki/en/home'
})
const browserWindow = dom.window

const visualViewport = {
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
const previousWindowVisualViewport = Object.getOwnPropertyDescriptor(browserWindow, 'visualViewport')
const previousGlobalVisualViewport = Object.getOwnPropertyDescriptor(globalThis, 'visualViewport')
const installVisualViewport = (): void => {
  Object.defineProperty(browserWindow, 'visualViewport', { configurable: true, writable: true, value: visualViewport })
  Object.defineProperty(globalThis, 'visualViewport', { configurable: true, writable: true, value: visualViewport })
}
const restoreVisualViewport = (): void => {
  if (previousWindowVisualViewport) Object.defineProperty(browserWindow, 'visualViewport', previousWindowVisualViewport)
  else Reflect.deleteProperty(browserWindow, 'visualViewport')
  if (previousGlobalVisualViewport) Object.defineProperty(globalThis, 'visualViewport', previousGlobalVisualViewport)
  else Reflect.deleteProperty(globalThis, 'visualViewport')
}
const css = { escape: (value: string) => value, supports: () => false }
class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
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
  }
})
const globalValues: Record<string, unknown> = {
  CSS: css,
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLElement: browserWindow.HTMLElement,
  IntersectionObserver: ObserverStub,
  KeyboardEvent: browserWindow.KeyboardEvent,
  MouseEvent: browserWindow.MouseEvent,
  MutationObserver: browserWindow.MutationObserver,
  Node: browserWindow.Node,
  ResizeObserver: ObserverStub,
  SVGElement: browserWindow.SVGElement,
  document: browserWindow.document,
  getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
  navigator: browserWindow.navigator,
  window: browserWindow
}
for (const [name, value] of Object.entries(globalValues)) Object.defineProperty(globalThis, name, { configurable: true, value, writable: true })
installVisualViewport()

// Vuetify snapshots browser capabilities during module evaluation, so these test-only imports run after JSDOM globals exist.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const compiledTemplate = compileTemplate({
  source: descriptor.template.content,
  filename: componentPath,
  id: 'agent-context-picker-interaction-test',
  compilerOptions: { mode: 'function' }
})
if (compiledTemplate.errors.length > 0) throw compiledTemplate.errors[0]
const renderPicker = new Function('Vue', compiledTemplate.code)(Vue) as () => unknown
const setupScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(descriptor.scriptSetup.content.replace(/^import .*$/gm, ''))
const bindingNames = Array.from(descriptor.scriptSetup.content.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm), match => match[1])
const evaluatePicker = new Function(
  'computed',
  'nextTick',
  'onBeforeUnmount',
  'ref',
  'useId',
  'watch',
  'defineProps',
  'defineEmits',
  'searchPages',
  'fetchWikiSource',
  'AgentKnowledgeContextSchema',
  `${setupScript}\nreturn { ${bindingNames.join(', ')} }`
) as (...dependencies: unknown[]) => Record<string, unknown>
const settle = async (): Promise<void> => {
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}

const emptyDraft = (sources: WikiSource[] = [], includeCurrentPage = true): AgentDraft => ({
  text: 'Keep this unsent draft',
  mode: 'goal',
  skillVersionIds: ['skill-1'],
  sources,
  scope: { kind: 'section', locale: 'en', path: 'handbook' },
  includeCurrentPage
})
const source = (id: number): WikiSource => ({
  id,
  locale: 'en',
  path: `handbook/topic-${id}`,
  title: `Topic ${id}`,
  description: `Description for topic ${id}`,
  visibility: 'public',
  updatedAt: '2026-09-14T00:00:00.000Z',
  sourceRevision: String(id),
  excerpt: '',
  excerptTruncated: false
})
const row = (id: string | number): PageSearchRow => ({
  id,
  title: `Topic ${id}`,
  description: `Description for topic ${id}`,
  path: `handbook/topic-${id}`,
  locale: 'en',
  visibility: 'public',
  tags: [],
  score: 1,
  matchedFields: ['title']
})
const result = (results: PageSearchRow[], nextCursor: string | null = null): PageSearchResult => ({
  results,
  suggestions: [],
  totalHits: results.length,
  nextCursor
})
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } => {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

interface MountedPicker {
  app: { unmount: () => void }
  changes: Partial<AgentDraft>[]
  host: HTMLElement
  sourcesAdded: { value: number }
}

const mountedPickers: MountedPicker[] = []
const waitForSourcesAdded = async (mounted: MountedPicker, expected = 1): Promise<void> => {
  for (let attempt = 0; attempt < 20 && mounted.sourcesAdded.value < expected; attempt += 1) {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    await settle()
  }
}

const mountPicker = (
  searchPagesImpl: (fetchImpl: unknown, query: string, options: Record<string, unknown>) => Promise<PageSearchResult>,
  fetchWikiSourceImpl: (selector: { id: number }, query: string, signal: AbortSignal) => Promise<WikiSource>,
  draft = emptyDraft(),
  currentPage: AgentCurrentPageHint | null = null
): MountedPicker => {
  const host = document.createElement('div')
  document.body.append(host)
  const changes: Partial<AgentDraft>[] = []
  const sourcesAdded = { value: 0 }
  const picker = Vue.defineComponent({
    name: 'AgentContextPickerInteractionHarness',
    props: {
      draft: { type: Object, required: true },
      currentPage: { type: Object, default: null },
      disabled: { type: Boolean, default: false },
      connectionBlocked: { type: Boolean, default: false },
      connectionRetrying: { type: Boolean, default: false }
    },
    setup(componentProps) {
      return evaluatePicker(
        Vue.computed,
        Vue.nextTick,
        Vue.onBeforeUnmount,
        Vue.ref,
        Vue.useId,
        Vue.watch,
        () => componentProps,
        () => (event: string, patch?: Partial<AgentDraft>) => {
          if (event === 'change' && patch) changes.push(patch)
          if (event === 'sourcesAdded') sourcesAdded.value += 1
        },
        searchPagesImpl,
        fetchWikiSourceImpl,
        AgentKnowledgeContextSchema
      )
    },
    render: renderPicker
  })
  const app = Vue.createApp(picker, { draft, currentPage, disabled: false, connectionBlocked: false, connectionRetrying: false })
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.component('WikiSourcePreview', Vue.defineComponent({ render: () => Vue.h('div') }))
  app.mount(host)
  const mounted = { app, changes, host, sourcesAdded }
  mountedPickers.push(mounted)
  return mounted
}

const openPicker = async (mounted: MountedPicker): Promise<void> => {
  const button = mounted.host.querySelector<HTMLButtonElement>('.agent-context__scope button:last-child')
  if (!button) throw new Error('Add sources activator did not render')
  button.focus()
  button.click()
  await settle()
}
const search = async (_mounted: MountedPicker, query: string): Promise<void> => {
  const input = document.body.querySelector<HTMLInputElement>('.agent-context__search input')
  if (!input) throw new Error('Source search field did not render')
  input.value = query
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await settle()
}
const resultCheckboxes = (): NodeListOf<HTMLInputElement> => document.body.querySelectorAll<HTMLInputElement>('.agent-context__result input[type="checkbox"]')
const selectResult = async (index = 0): Promise<void> => {
  const checkbox = resultCheckboxes()[index]
  if (!checkbox) throw new Error(`Source result checkbox ${index} did not render`)
  checkbox.checked = true
  checkbox.dispatchEvent(new Event('change', { bubbles: true }))
  await settle()
}
const addButton = (): HTMLButtonElement => {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.agent-context__dialog-actions button')).find(candidate =>
    candidate.textContent?.includes('and return')
  )
  if (!button) throw new Error('Add sources primary action did not render')
  return button
}

beforeEach(installVisualViewport)

afterEach(() => {
  for (const mounted of mountedPickers.splice(0)) {
    mounted.app.unmount()
    mounted.host.remove()
  }
  document.body.replaceChildren()
  restoreVisualViewport()
})

describe('Agent context source transaction', () => {
  it('keeps selections across queries and commits both hydrated pages in one change', async () => {
    const searchPagesImpl = vi.fn(async (_fetchImpl: unknown, query: string) => (query === 'alpha' ? result([row('11')]) : result([row(12)])))
    const fetchWikiSourceImpl = vi.fn(async (selector: { id: number }) => source(selector.id))
    const mounted = mountPicker(searchPagesImpl, fetchWikiSourceImpl)
    await openPicker(mounted)
    await search(mounted, 'alpha')
    expect(searchPagesImpl).toHaveBeenCalledWith(expect.anything(), 'alpha', { paginated: true })
    await selectResult()
    await settle()
    await search(mounted, 'beta')
    await selectResult()
    await settle()

    expect(document.body.querySelectorAll('.agent-context__pending-list .v-chip')).toHaveLength(2)
    expect(addButton().textContent?.trim()).toBe('Add 2 sources and return')
    addButton().click()
    await settle()
    await waitForSourcesAdded(mounted)
    expect(document.body.querySelector('[role="alert"]')?.textContent ?? '').toBe('')

    expect(mounted.changes).toHaveLength(1)
    expect((mounted.changes[0].sources as WikiSource[]).map(item => item.id)).toEqual([11, 12])
    expect(fetchWikiSourceImpl).toHaveBeenCalledTimes(2)
    expect(mounted.sourcesAdded.value).toBe(1)
    expect(window.location.pathname).toBe('/wiki/en/home')
  })

  it('keeps the draft untouched when one hydration fails, while retaining every pending selection', async () => {
    const searchPagesImpl = vi.fn(async () => result([row(21), row(22)]))
    const fetchWikiSourceImpl = vi.fn(async (selector: { id: number }) => {
      if (selector.id === 22) throw new Error('This source is no longer available to you.')
      return source(selector.id)
    })
    const mounted = mountPicker(searchPagesImpl, fetchWikiSourceImpl)
    await openPicker(mounted)
    await search(mounted, 'failure')
    await selectResult(0)
    await selectResult(1)
    await settle()
    addButton().click()
    await settle()

    expect(mounted.changes).toHaveLength(0)
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Topic 22')
    expect(Array.from(resultCheckboxes()).every(checkbox => checkbox.checked)).toBe(true)
  })

  it('aborts pending hydration on cancel without committing a late response', async () => {
    const hydration = deferred<WikiSource>()
    let signal: AbortSignal | undefined
    const searchPagesImpl = vi.fn(async () => result([row(31)]))
    const fetchWikiSourceImpl = vi.fn((_selector: { id: number }, _query: string, nextSignal: AbortSignal) => {
      signal = nextSignal
      return hydration.promise
    })
    const mounted = mountPicker(searchPagesImpl, fetchWikiSourceImpl)
    await openPicker(mounted)
    await search(mounted, 'cancel')
    await selectResult()
    await settle()
    addButton().click()
    await settle()
    const cancel = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.agent-context__dialog-actions button')).find(
      button => button.textContent?.trim() === 'Cancel'
    )
    if (!cancel) throw new Error('Cancel action did not render')
    cancel.click()
    hydration.resolve(source(31))
    await settle()

    expect(signal?.aborted).toBe(true)
    expect(mounted.changes).toHaveLength(0)
    expect(mounted.sourcesAdded.value).toBe(0)
    expect(document.body.querySelector('.v-overlay--active .agent-context__dialog')).toBeNull()
  })

  it('deduplicates identity across representations and enforces the eight-source boundary', async () => {
    const existing = Array.from({ length: 7 }, (_, index) => source(index + 1))
    const searchPagesImpl = vi.fn(async (_fetchImpl: unknown, query: string) =>
      query === 'eight' ? result([row('8')]) : query === 'same' ? result([row(8)]) : result([row(9)])
    )
    const fetchWikiSourceImpl = vi.fn(async (selector: { id: number }) => source(selector.id))
    const mounted = mountPicker(searchPagesImpl, fetchWikiSourceImpl, emptyDraft(existing))
    await openPicker(mounted)
    await search(mounted, 'eight')
    await selectResult()
    await settle()
    await search(mounted, 'same')
    expect(resultCheckboxes()[0]?.checked).toBe(true)
    await search(mounted, 'nine')
    const ninth = resultCheckboxes()[0]
    expect(ninth?.disabled).toBe(true)
    expect(document.body.querySelectorAll('.agent-context__pending-list .v-chip')).toHaveLength(1)
    expect(addButton().textContent?.trim()).toBe('Add 1 source and return')
    addButton().click()
    await settle()

    expect(mounted.changes).toHaveLength(1)
    expect((mounted.changes[0].sources as WikiSource[]).map(item => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('Agent context current-page inclusion', () => {
  it('emits an inclusion toggle for the next message without changing the opening page', async () => {
    const page: AgentCurrentPageHint = {
      id: 77,
      locale: 'en',
      path: 'handbook/context',
      observedUpdatedAt: '2026-09-16T00:00:00.000Z'
    }
    const searchPagesImpl = vi.fn(async () => result([]))
    const fetchWikiSourceImpl = vi.fn(async (selector: { id: number }) => source(selector.id))
    const included = mountPicker(searchPagesImpl, fetchWikiSourceImpl, emptyDraft(), page)
    const includeControl = included.host.querySelector<HTMLButtonElement>('.agent-context__page-toggle')
    if (!includeControl) throw new Error('Current-page inclusion control did not render')

    expect(includeControl.getAttribute('aria-pressed')).toBe('true')
    includeControl.click()
    await settle()
    expect(included.changes).toEqual([{ includeCurrentPage: false }])

    const excluded = mountPicker(searchPagesImpl, fetchWikiSourceImpl, emptyDraft([], false), page)
    const excludeControl = excluded.host.querySelector<HTMLButtonElement>('.agent-context__page-toggle')
    if (!excludeControl) throw new Error('Current-page inclusion control did not render')
    expect(excludeControl.getAttribute('aria-pressed')).toBe('false')
    excludeControl.click()
    await settle()
    expect(excluded.changes).toEqual([{ includeCurrentPage: true }])
  })
})

describe('Agent context source debounce', () => {
  it('shows loading while a valid query is debounced, then renders its results without Enter', async () => {
    const pending = deferred<PageSearchResult>()
    const searchPagesImpl = vi.fn(() => pending.promise)
    const mounted = mountPicker(
      searchPagesImpl,
      vi.fn(async (selector: { id: number }) => source(selector.id))
    )
    await openPicker(mounted)
    vi.useFakeTimers()
    try {
      const input = document.body.querySelector<HTMLInputElement>('.agent-context__search input')
      if (!input) throw new Error('Source search field did not render')
      input.value = 'pending'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await settle()

      expect(searchPagesImpl).not.toHaveBeenCalled()
      expect(document.body.querySelector('.agent-context__results-state')?.textContent).toContain('Searching pages…')
      expect(document.body.querySelector('.agent-context__status')?.textContent).toContain('Searching pages…')
      expect(document.body.querySelector('.agent-context__results-state')?.textContent).not.toContain('No accessible pages')
      expect(document.body.querySelector('.agent-context__status')?.textContent).not.toContain('0 results')

      await vi.advanceTimersByTimeAsync(299)
      await settle()
      expect(searchPagesImpl).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await settle()
      expect(searchPagesImpl).toHaveBeenCalledWith(expect.anything(), 'pending', { paginated: true })

      pending.resolve(result([row(51)]))
      await settle()
      expect(document.body.querySelector('.agent-context__result')?.textContent).toContain('Topic 51')
      expect(document.body.querySelector('.agent-context__results-state')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Agent context source cancellation', () => {
  it('ignores a stale search completion after the dialog is cancelled', async () => {
    const pending = deferred<PageSearchResult>()
    const searchPagesImpl = vi.fn(() => pending.promise)
    const mounted = mountPicker(
      searchPagesImpl,
      vi.fn(async (selector: { id: number }) => source(selector.id))
    )
    await openPicker(mounted)
    await search(mounted, 'stale')
    const cancel = document.body.querySelector<HTMLButtonElement>('.agent-context__dialog-actions button')
    if (!cancel) throw new Error('Cancel action did not render')
    cancel.click()
    pending.resolve(result([row(41)]))
    await settle()

    expect(document.body.querySelector('.agent-context__result')).toBeNull()
    expect(mounted.sourcesAdded.value).toBe(0)
    expect(mounted.changes).toHaveLength(0)
  })
})
