import { parse, compileTemplate } from '@vue/compiler-sfc'
import type { Component } from 'vue'
import path from 'node:path'
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { AgentKnowledgeContextSchema } from '../../../shared/agents/knowledge-context.ts'
import type { AgentDraft } from '../../helpers/agent-draft.ts'
import type { AgentCurrentPageHint } from '../../../shared/agents/contracts.ts'
import {
  fetchRecentPages as requestRecentPages,
  searchPages as requestPageSearch,
  type PageSearchResult,
  type PageSearchRow,
  type RecentPageRow
} from '../../helpers/pages-api.ts'
import type { WikiSource } from '../../../shared/wiki-source.ts'

const componentPath = path.join(process.cwd(), 'client/components/agents/agent-context-picker.vue')
const componentSource = fs.readFileSync(componentPath, 'utf8')
const descriptor = parse(componentSource, { filename: componentPath }).descriptor
if (!descriptor.template || !descriptor.scriptSetup) throw new Error('agent-context-picker.vue template and setup script are required')

import { browserWindow, setLocation, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
const translateWithDefaultEscaping = (key: string, options: Record<string, unknown> = {}): string =>
  translateEnglish(key, { interpolation: { escapeValue: true }, ...options })

setLocation('/wiki/en/home')

resetBody()

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
  'mergeProps',
  'nextTick',
  'onBeforeUnmount',
  'ref',
  'useId',
  'watch',
  'defineProps',
  'defineEmits',
  'defineExpose',
  'searchPages',
  'fetchRecentPages',
  'fetchWikiSource',
  'AgentKnowledgeContextSchema',
  'useTranslate',
  `${setupScript}\nreturn { mergeProps, ${bindingNames.join(', ')} }`
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
const recent = (id: number): RecentPageRow => {
  const { locale, path, title, updatedAt, visibility } = source(id)
  return { id, locale, path, title, updatedAt, visibility }
}
const row = (id: string | number): PageSearchRow => ({
  id,
  title: `Topic ${id}`,
  description: `Description for topic ${id}`,
  excerpt: null,
  copySource: null,
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
  updateProps: (patch: Partial<{ draft: AgentDraft; disabled: boolean; connectionBlocked: boolean }>) => void
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
  currentPage: AgentCurrentPageHint | null = null,
  extraProps: { connectionBlocked?: boolean; currentPageTitle?: string; commitChanges?: boolean } = {},
  fetchRecentPagesImpl: (fetchImpl: Parameters<typeof requestRecentPages>[0]) => Promise<RecentPageRow[]> = async () => []
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
      connectionRetrying: { type: Boolean, default: false },
      currentPageTitle: { type: String, default: undefined },
      sourceTrigger: { type: Object, default: null }
    },
    setup(componentProps, { expose }) {
      return evaluatePicker(
        Vue.computed,
        Vue.mergeProps,
        Vue.nextTick,
        Vue.onBeforeUnmount,
        Vue.ref,
        Vue.useId,
        Vue.watch,
        () => componentProps,
        () => (event: string, patch?: Partial<AgentDraft>) => {
          if (event === 'change' && patch) {
            changes.push(patch)
            // Commit as the real parent does, before the child's nextTick focus.
            if (extraProps.commitChanges) rootProps.draft = { ...rootProps.draft, ...patch }
          }
          if (event === 'sourcesAdded') sourcesAdded.value += 1
        },
        expose,
        searchPagesImpl,
        fetchRecentPagesImpl,
        fetchWikiSourceImpl,
        AgentKnowledgeContextSchema,
        () => translateWithDefaultEscaping
      )
    },
    render: renderPicker
  })
  const rootProps = Vue.reactive({
    draft,
    currentPage,
    disabled: false,
    connectionBlocked: extraProps.connectionBlocked ?? false,
    connectionRetrying: false,
    currentPageTitle: extraProps.currentPageTitle
  })
  // Runtime-compiled setup bindings have unknown keys; use Vue's public renderable contract.
  const pickerRef = Vue.ref<{ openSources: (opener: HTMLElement) => void } | null>(null)
  const sourceTrigger = Vue.ref<HTMLButtonElement | null>(null)
  const app = Vue.createApp({
    setup: () => () =>
      Vue.h('div', [
        Vue.h(
          'button',
          {
            ref: sourceTrigger,
            type: 'button',
            class: 'test-source-trigger',
            onClick: (event: MouseEvent) => pickerRef.value?.openSources(event.currentTarget as HTMLElement)
          },
          'Source'
        ),
        Vue.h(picker as Component, { ...rootProps, ref: pickerRef, sourceTrigger: sourceTrigger.value })
      ])
  })
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.config.globalProperties.$t = translateWithDefaultEscaping
  app.component(
    'WikiSourcePreview',
    Vue.defineComponent({
      props: ['selector'],
      emits: ['close'],
      setup(props, { emit }) {
        return () =>
          Vue.h('div', { role: 'dialog', 'aria-label': 'Source preview', 'data-source-id': props.selector.id }, [
            Vue.h('button', { type: 'button', onClick: () => emit('close') }, 'Close preview')
          ])
      }
    })
  )
  app.mount(host)
  const mounted = { app, changes, host, sourcesAdded, updateProps: (patch: Partial<typeof rootProps>) => Object.assign(rootProps, patch) }
  mountedPickers.push(mounted)
  return mounted
}

const openPicker = async (mounted: MountedPicker): Promise<void> => {
  const button = mounted.host.querySelector<HTMLButtonElement>('.test-source-trigger')
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
  const button = document.body.querySelector<HTMLButtonElement>('.agent-context__dialog-confirm')
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

describe('Agent context source dialog focus', () => {
  it('returns focus to Source after cancelling a pending selection and short query', async () => {
    const draft = { ...emptyDraft(), scope: { kind: 'all' } as const }
    const mounted = mountPicker(
      vi.fn(async () => result([])),
      vi.fn(async (selector: { id: number }) => source(selector.id)),
      draft,
      null,
      {},
      vi.fn(async () => [recent(1)])
    )
    const activator = mounted.host.querySelector<HTMLButtonElement>('.test-source-trigger')
    if (!activator) throw new Error('Source activator did not render')
    await openPicker(mounted)
    await selectResult()
    await search(mounted, 'x')
    const cancel = document.body.querySelector<HTMLButtonElement>('.agent-context__dialog-close')
    if (!cancel) throw new Error('Cancel action did not render')
    const focusReturned = Promise.withResolvers<void>()
    activator.addEventListener('focus', () => focusReturned.resolve(), { once: true })
    cancel.focus()
    cancel.click()
    await focusReturned.promise
    expect(document.activeElement).toBe(activator)
    expect(mounted.changes).toEqual([])
    await openPicker(mounted)
    expect(addButton().textContent).toBe('Apply (0)')
    expect(document.body.querySelector('.agent-context__pending-list .v-chip')).toBeNull()
  })
})

describe('Agent context recent suggestions', () => {
  it('offers eight distinct real recents without typing and keeps only pending additions in Apply', async () => {
    const recents = [recent(1), { ...recent(2), locale: 'fr' }, { ...recent(2), locale: 'fr' }, ...Array.from({ length: 7 }, (_, index) => recent(index + 3))]
    const fetchRecentPagesImpl = vi.fn(async () => recents)
    const searchPagesImpl = vi.fn(async () => result([{ ...row('2'), locale: 'fr' }, row(10)]))
    const draft = { ...emptyDraft([source(1)]), scope: { kind: 'all' } as const }
    const mounted = mountPicker(
      searchPagesImpl,
      vi.fn(async (selector: { id: number }) => source(selector.id)),
      draft,
      null,
      {},
      fetchRecentPagesImpl
    )
    await openPicker(mounted)

    expect(fetchRecentPagesImpl).toHaveBeenCalledTimes(1)
    expect(searchPagesImpl).not.toHaveBeenCalled()
    expect(Array.from(resultCheckboxes(), input => input.getAttribute('aria-label'))).toEqual(
      recents.filter((item, index) => index !== 0 && index !== 2).map(item => `${item.title}, ${item.locale}, ${item.path}`)
    )
    expect(addButton().textContent).toBe('Apply (0)')
    expect(addButton().disabled).toBe(true)
    await selectResult()
    expect(addButton().textContent).toBe('Apply (1)')
    expect(resultCheckboxes()[0]?.getAttribute('aria-label')).toContain('Pending addition')

    await search(mounted, 'x')
    expect(resultCheckboxes()).toHaveLength(0)
    expect(document.body.querySelector('.agent-context__results-state')?.textContent).toContain('at least two characters')
    expect(addButton().textContent).toBe('Apply (1)')
    await search(mounted, 'topics')
    expect(resultCheckboxes()[0]?.checked).toBe(true)
    await selectResult(1)
    expect(addButton().textContent).toBe('Apply (2)')
    await search(mounted, '')
    expect(resultCheckboxes()).toHaveLength(8)
    expect(resultCheckboxes()[0]?.checked).toBe(true)
    resultCheckboxes()[0]?.click()
    await settle()
    expect(addButton().textContent).toBe('Apply (1)')
    expect(mounted.changes).toEqual([])
    expect(mounted.sourcesAdded.value).toBe(0)

    document.body.querySelector<HTMLButtonElement>('.agent-context__dialog-close')?.click()
    await settle()
    await openPicker(mounted)
    expect(addButton().textContent).toBe('Apply (0)')
    expect(addButton().disabled).toBe(true)
    expect(document.body.querySelector('.agent-context__pending')).toBeNull()
    expect(mounted.changes).toEqual([])
  })

  for (const scope of [{ kind: 'locale', locale: 'en' }, { kind: 'section', locale: 'en', path: 'handbook' }, { kind: 'selected' }] as const) {
    it(`preserves ${scope.kind} discovery semantics through recents and paginated search`, async () => {
      const candidates = [recent(91), { ...recent(92), locale: 'fr' }, { ...recent(93), path: 'handbookish/topic-93' }]
      const expectedIds = scope.kind === 'section' ? [91] : scope.kind === 'locale' ? [91, 93] : [91, 92, 93]
      const expectedOptions = scope.kind === 'section' ? { locale: 'en', path: 'handbook' } : scope.kind === 'locale' ? { locale: 'en' } : {}
      const searchPagesImpl = vi.fn(async (_fetchImpl: unknown, _query: string, options: Record<string, unknown>) =>
        options.cursor
          ? result([row(94)])
          : result(
              candidates.map(item => ({ ...row(item.id), ...item })),
              'next-page'
            )
      )
      const mounted = mountPicker(
        searchPagesImpl,
        vi.fn(async (selector: { id: number }) => source(selector.id)),
        { ...emptyDraft([source(99)]), scope },
        null,
        {},
        vi.fn(async () => candidates)
      )
      await openPicker(mounted)
      expect(Array.from(document.body.querySelectorAll('.agent-context__result strong'), item => item.textContent)).toEqual(
        expectedIds.map(id => `Topic ${id}`)
      )
      expect(document.body.querySelector('.agent-context__recent-title')?.textContent).toContain(
        scope.kind === 'section' ? 'en/handbook' : scope.kind === 'locale' ? 'EN pages' : 'All Wiki'
      )
      await selectResult()
      await search(mounted, 'topics')
      expect(searchPagesImpl.mock.calls[0]?.[2]).toEqual({ ...expectedOptions, paginated: true })
      expect(resultCheckboxes()[0]?.checked).toBe(true)
      document.body.querySelector<HTMLButtonElement>('.agent-context__more')?.click()
      await settle()
      expect(searchPagesImpl.mock.calls[1]?.[2]).toEqual({ ...expectedOptions, paginated: true, cursor: 'next-page' })
      expect(addButton().textContent).toBe('Apply (1)')
      expect(mounted.changes).toEqual([])
      expect(mounted.sourcesAdded.value).toBe(0)
    })
  }

  it('reports recent failure safely, retries the existing endpoint, and distinguishes an empty recent list from short-query guidance', async () => {
    let attempts = 0
    const fetchRecentPagesImpl = vi.fn(async () =>
      requestRecentPages(async url => {
        expect(url).toBe('/_api/pages/recent')
        attempts += 1
        return new Response(JSON.stringify(attempts === 1 ? { message: 'sensitive server detail' } : []), {
          status: attempts === 1 ? 500 : 200,
          headers: { 'content-type': 'application/json' }
        })
      })
    )
    const mounted = mountPicker(
      vi.fn(async () => result([])),
      vi.fn(async (selector: { id: number }) => source(selector.id)),
      emptyDraft(),
      null,
      {},
      fetchRecentPagesImpl
    )
    await openPicker(mounted)
    const error = document.body.querySelector('.agent-context__search-error')
    expect(error?.textContent).toContain('Recent pages could not be loaded.')
    expect(error?.textContent).not.toContain('sensitive server detail')
    error?.querySelector<HTMLButtonElement>('button')?.click()
    await settle()
    expect(fetchRecentPagesImpl).toHaveBeenCalledTimes(2)
    expect(resultCheckboxes()).toHaveLength(0)
    expect(document.body.querySelector('.agent-context__results-state')?.textContent).toContain('No new eligible pages in the recent list')
    expect(document.body.querySelector('.agent-context__results-state')?.textContent).not.toContain('two characters')
    expect(mounted.changes).toEqual([])
  })

  it('ignores recent suggestions that finish after a query replaces them', async () => {
    const stale = deferred<RecentPageRow[]>()
    const mounted = mountPicker(
      vi.fn(async () => result([row(96)])),
      vi.fn(async (selector: { id: number }) => source(selector.id)),
      emptyDraft(),
      null,
      {},
      vi.fn(() => stale.promise)
    )
    await openPicker(mounted)
    await search(mounted, 'fresh')
    stale.resolve([recent(95)])
    await settle()
    expect(Array.from(document.body.querySelectorAll('.agent-context__result strong'), item => item.textContent)).toEqual(['Topic 96'])
    expect(mounted.changes).toEqual([])
  })
})

describe('Agent context source transaction', () => {
  it('keeps selections across queries and commits both hydrated pages in one change', async () => {
    const searchPagesImpl = vi.fn(async (_fetchImpl: unknown, query: string, _options: Record<string, unknown>) =>
      query === 'alpha' ? result([row('11')]) : result([row(12)])
    )
    const fetchWikiSourceImpl = vi.fn(async (selector: { id: number }) => source(selector.id))
    const mounted = mountPicker(searchPagesImpl, fetchWikiSourceImpl)
    await openPicker(mounted)
    expect(addButton().disabled).toBe(true)
    await search(mounted, 'alpha')
    expect(searchPagesImpl.mock.calls[0]?.[2].paginated).toBe(true)
    await selectResult()
    await settle()
    await search(mounted, 'beta')
    await selectResult()
    await settle()

    expect(document.body.querySelectorAll('.agent-context__pending-list .v-chip')).toHaveLength(2)
    expect(addButton().textContent).toBe('Apply (2)')
    expect(addButton().disabled).toBe(false)
    addButton().click()
    await settle()
    await waitForSourcesAdded(mounted)
    expect(document.body.querySelector('[role="alert"]')?.textContent ?? '').toBe('')

    expect(mounted.changes).toHaveLength(1)
    expect(mounted.changes[0]).toEqual({ sources: [source(11), source(12)] })
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
    const alerts = Array.from(document.body.querySelectorAll('[role="alert"]')).filter(alert => alert.textContent?.trim())
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.textContent).toContain('Topic 22')
    expect(resultCheckboxes()).toHaveLength(2)
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
    const cancel = document.body.querySelector<HTMLButtonElement>('.agent-context__dialog-close')
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
    const mounted = mountPicker(searchPagesImpl, fetchWikiSourceImpl, emptyDraft(existing), {
      id: 99,
      locale: 'en',
      path: 'handbook/current',
      observedUpdatedAt: '2026-09-16T00:00:00.000Z'
    })
    await openPicker(mounted)
    await search(mounted, 'eight')
    await selectResult()
    await settle()
    await search(mounted, 'same')
    expect(resultCheckboxes()[0]?.checked).toBe(true)
    await search(mounted, 'nine')
    const ninth = resultCheckboxes()[0]
    expect(ninth?.getAttribute('aria-disabled')).toBe('true')
    expect(ninth?.getAttribute('aria-label')).toContain('eight-source limit')
    expect(ninth?.disabled).toBe(false)
    ninth?.focus()
    ninth?.click()
    await settle()
    expect(ninth?.checked).toBe(false)
    expect(document.body.querySelectorAll('.agent-context__pending-list .v-chip')).toHaveLength(1)
    expect(addButton().textContent).toBe('Apply (1)')
    addButton().click()
    await settle()

    expect(mounted.changes).toHaveLength(1)
    expect((mounted.changes[0].sources as WikiSource[]).map(item => item.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('Agent context authoritative source admission', () => {
  for (const invalid of [{ id: 122 }, { locale: 'fr' }, { path: 'handbook/moved' }, { sourceRevision: '0' }]) {
    it(`rejects authoritative ${Object.keys(invalid)[0]} mismatch without a partial commit`, async () => {
      const mounted = mountPicker(
        vi.fn(async () => result([row(121)])),
        vi.fn(async () => ({ ...source(121), ...invalid }))
      )
      await openPicker(mounted)
      await search(mounted, 'identity')
      await selectResult()
      addButton().click()
      await settle()
      expect(mounted.changes).toEqual([])
      expect(mounted.sourcesAdded.value).toBe(0)
      expect(document.body.querySelectorAll('.agent-context__pending-list .v-chip')).toHaveLength(1)
      expect(addButton().textContent).toBe('Apply (1)')
      expect(addButton().disabled).toBe(false)
    })
  }

  it('rejects the whole attachment set when valid multibyte identities exceed the 24000-byte context budget', async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      ...row(index + 130),
      title: '界'.repeat(490),
      path: `handbook/${'界'.repeat(1000)}${index}`
    }))
    const mounted = mountPicker(
      vi.fn(async () => result(candidates)),
      vi.fn(async (selector: { id: number }) => ({
        ...source(selector.id),
        title: candidates[selector.id - 130].title,
        path: candidates[selector.id - 130].path
      }))
    )
    await openPicker(mounted)
    await search(mounted, 'budget')
    for (let index = 0; index < candidates.length; index += 1) await selectResult(index)
    expect(addButton().textContent).toBe('Apply (8)')
    addButton().click()
    await settle()
    expect(mounted.changes).toEqual([])
    expect(mounted.sourcesAdded.value).toBe(0)
    expect(document.body.querySelectorAll('.agent-context__pending-list .v-chip')).toHaveLength(8)
    expect(addButton().disabled).toBe(false)
  })

  it('aborts an in-flight Apply on disconnection, retains pending picks, and resumes discovery only after reconnecting', async () => {
    const hydration = deferred<WikiSource>()
    let signal: AbortSignal | undefined
    const mounted = mountPicker(
      vi.fn(async () => result([row(141)])),
      vi.fn((_selector: { id: number }, _query: string, nextSignal: AbortSignal) => {
        signal = nextSignal
        return hydration.promise
      })
    )
    await openPicker(mounted)
    await search(mounted, 'offline')
    await selectResult()
    addButton().click()
    await settle()
    expect(addButton().disabled).toBe(true)
    mounted.updateProps({ connectionBlocked: true })
    await settle()
    expect(signal?.aborted).toBe(true)
    hydration.resolve(source(141))
    await settle()
    expect(mounted.changes).toEqual([])
    expect(mounted.sourcesAdded.value).toBe(0)
    expect(resultCheckboxes()).toHaveLength(0)
    expect(document.body.querySelector('.agent-context__results-state')?.textContent).toContain('Connection required')
    expect(addButton().textContent).toBe('Apply (1)')
    expect(addButton().disabled).toBe(true)
    mounted.updateProps({ connectionBlocked: false })
    await settle()
    expect(resultCheckboxes()[0]?.checked).toBe(true)
    expect(addButton().disabled).toBe(false)
  })

  it('removes externally attached identities from the actual pending count without emitting another commit', async () => {
    const mounted = mountPicker(
      vi.fn(async () => result([row(151)])),
      vi.fn(async (selector: { id: number }) => source(selector.id))
    )
    await openPicker(mounted)
    await search(mounted, 'dedupe')
    await selectResult()
    expect(addButton().textContent).toBe('Apply (1)')
    mounted.updateProps({ draft: emptyDraft([source(151)]) })
    await settle()
    expect(addButton().textContent).toBe('Apply (0)')
    expect(addButton().disabled).toBe(true)
    expect(resultCheckboxes()[0]?.getAttribute('aria-label')).toContain('Attached')
    expect(mounted.changes).toEqual([])
    expect(mounted.sourcesAdded.value).toBe(0)
  })
})

describe('Agent context current-page inclusion', () => {
  it('removes the included navigation hint and re-includes it explicitly through Source without navigating', async () => {
    const page: AgentCurrentPageHint = { id: 77, locale: 'en', path: 'handbook/context', observedUpdatedAt: '2026-09-16T00:00:00.000Z' }
    const mounted = mountPicker(
      vi.fn(async () => result([])),
      vi.fn(async (selector: { id: number }) => source(selector.id)),
      emptyDraft(),
      page,
      { commitChanges: true }
    )
    const remove = mounted.host.querySelector<HTMLButtonElement>('.agent-context__source-remove')
    if (!remove) throw new Error('Included source removal did not render')
    remove.click()
    expect(mounted.changes).toEqual([{ sources: [], includeCurrentPage: false }])
    await settle()
    expect(mounted.host.querySelectorAll('.agent-context__source-group')).toHaveLength(0)
    expect(document.activeElement).toBe(mounted.host.querySelector('.test-source-trigger'))

    await openPicker(mounted)
    const include = document.body.querySelector<HTMLButtonElement>('.agent-context__scope [aria-pressed]')
    if (!include) throw new Error('Current-page inclusion control missing from Source dialog')
    expect(include.getAttribute('aria-pressed')).toBe('false')
    include.click()
    await settle()
    expect(mounted.changes[1]).toEqual({ includeCurrentPage: true })
    expect(window.location.pathname).toBe('/wiki/en/home')
  })

  it('renders an unescaped current-page title while disabling both source actions offline', async () => {
    const page: AgentCurrentPageHint = { id: 78, locale: 'en', path: 'handbook/title', observedUpdatedAt: '2026-09-16T00:00:00.000Z' }
    const currentPageTitle = 'Team & <Ops> / "Handbook"'
    const mounted = mountPicker(
      vi.fn(async () => result([])),
      vi.fn(async (selector: { id: number }) => source(selector.id)),
      emptyDraft(),
      page,
      { connectionBlocked: true, currentPageTitle }
    )
    const group = mounted.host.querySelector<HTMLElement>('.agent-context__source-group')
    if (!group) throw new Error('Current-page source group did not render')
    expect(group.getAttribute('aria-label')).toBe(currentPageTitle)
    expect(group.textContent).toContain(currentPageTitle)
    expect(group.querySelector('ops')).toBeNull()
    const actions = Array.from(group.querySelectorAll<HTMLButtonElement>('button'))
    expect(actions).toHaveLength(2)
    for (const action of actions) {
      expect(action.disabled).toBe(true)
      action.click()
    }
    await settle()
    expect(mounted.changes).toEqual([])
    expect(mounted.host.querySelector('[data-source-id]')).toBeNull()
  })
})

describe('Agent context source and scope affordances', () => {
  it('keeps preview and removal as independent sibling actions and returns focus to the next source', async () => {
    const searchPagesImpl = vi.fn(async () => result([]))
    const fetchWikiSourceImpl = vi.fn(async (selector: { id: number }) => source(selector.id))
    const mounted = mountPicker(searchPagesImpl, fetchWikiSourceImpl, emptyDraft([source(7), source(8)]), null, { commitChanges: true })
    const group = mounted.host.querySelector<HTMLElement>('.agent-context__source-group')
    const previewButton = group?.querySelector<HTMLButtonElement>('.agent-context__source-preview')
    const remove = group?.querySelector<HTMLButtonElement>('.agent-context__source-remove')
    if (!group || !previewButton || !remove) throw new Error('Sibling source actions missing')
    expect(group).toBeInstanceOf(browserWindow.HTMLFieldSetElement)
    expect(group.getAttribute('aria-label')).toBe(source(7).title)
    expect(previewButton.parentElement).toBe(remove.parentElement)
    expect(mounted.host.querySelector('button button, [role="button"] button')).toBeNull()
    // JSDOM does not perform native keyboard button activation.
    previewButton.focus()
    previewButton.click()
    await settle()
    expect(mounted.host.querySelector('[role="dialog"][data-source-id="7"]')).not.toBeNull()
    expect(mounted.changes).toEqual([])
    mounted.host.querySelector<HTMLButtonElement>('[data-source-id="7"] button')!.click()
    await settle()
    remove.focus()
    remove.click()
    await settle()
    expect(mounted.changes).toEqual([{ sources: [source(8)] }])
    expect(mounted.host.querySelector('[role="dialog"][data-source-id]')).toBeNull()
    expect(document.activeElement).toBe(mounted.host.querySelector('.agent-context__source-preview'))
    expect(searchPagesImpl).not.toHaveBeenCalled()
    expect(fetchWikiSourceImpl).not.toHaveBeenCalled()
  })

  it('deduplicates an attached current page and removes both provenance states atomically with selected-scope fallback', async () => {
    const attached = source(7)
    const page = { id: attached.id, locale: attached.locale, path: attached.path, observedUpdatedAt: '2026-09-16T00:00:00.000Z' }
    const draft = { ...emptyDraft([attached]), scope: { kind: 'selected' as const } }
    const mounted = mountPicker(
      vi.fn(async () => result([])),
      vi.fn(async () => attached),
      draft,
      page,
      { commitChanges: true }
    )
    expect(mounted.host.querySelectorAll('.agent-context__source-group')).toHaveLength(1)
    expect(mounted.host.querySelector('.agent-context__source-group small')?.textContent).toBe(translateEnglish('common:agentContextPicker.currentAndAttached'))
    mounted.host.querySelector<HTMLButtonElement>('.agent-context__source-remove')!.click()
    expect(mounted.changes).toEqual([{ sources: [], includeCurrentPage: false, scope: { kind: 'all' } }])
    await settle()
    expect(document.activeElement).toBe(mounted.host.querySelector('.test-source-trigger'))
  })

  it('shows a distinct current hint alongside eight explicit attachments without granting a ninth slot', async () => {
    const attachments = Array.from({ length: 8 }, (_, index) => source(index + 1))
    const page = { id: 99, locale: 'en', path: 'current/page', observedUpdatedAt: '2026-09-16T00:00:00.000Z' }
    const mounted = mountPicker(
      vi.fn(async () => result([])),
      vi.fn(async (selector: { id: number }) => source(selector.id)),
      emptyDraft(attachments),
      page
    )
    expect(mounted.host.querySelectorAll('.agent-context__source-group')).toHaveLength(9)
    mounted.host.querySelector<HTMLButtonElement>('.agent-context__source-remove')!.click()
    expect(mounted.changes).toEqual([{ sources: attachments, includeCurrentPage: false }])
    await openPicker(mounted)
    expect(addButton().disabled).toBe(true)
  })

  it('keeps empty selected scope unavailable while allowing Wiki-wide scope from Source', async () => {
    const searchPagesImpl = vi.fn(async () => result([]))
    const fetchWikiSourceImpl = vi.fn(async (selector: { id: number }) => source(selector.id))
    const mounted = mountPicker(searchPagesImpl, fetchWikiSourceImpl)
    await openPicker(mounted)
    const scope = document.body.querySelector<HTMLButtonElement>('.agent-context__scope button[aria-haspopup="menu"]')
    if (!scope) throw new Error('Scope control did not render in Source dialog')
    scope.click()
    await settle()
    const selected = Array.from(document.body.querySelectorAll<HTMLElement>('.v-list-item')).find(
      item => item.querySelector('.v-list-item-title')?.textContent === translateEnglish('common:agentContextPicker.selectedPages')
    )
    expect(selected?.getAttribute('aria-disabled')).toBe('true')
    selected?.click()
    await settle()
    expect(mounted.changes).toEqual([])
    const allWiki = Array.from(document.body.querySelectorAll<HTMLElement>('.v-list-item')).find(
      item => item.querySelector('.v-list-item-title')?.textContent === translateEnglish('common:agentContextPicker.allWiki')
    )
    allWiki?.click()
    await settle()
    expect(mounted.changes).toEqual([{ scope: { kind: 'all' } }])
    expect(searchPagesImpl).not.toHaveBeenCalled()
    expect(fetchWikiSourceImpl).not.toHaveBeenCalled()
  })
})

describe('Agent context source search recovery', () => {
  for (const recoveredRows of [[row(61)], []]) {
    it(`shows one safe search failure and retries to ${recoveredRows.length ? 'results' : 'empty'} without attaching selections`, async () => {
      const retryResult = deferred<PageSearchResult>()
      let attempts = 0
      const searchPagesImpl = vi.fn(async (_fetchImpl: unknown, query: string) => {
        attempts += 1
        if (query === 'selected') return result([row(60)])
        if (attempts === 2) {
          return requestPageSearch(
            async () =>
              new Response(JSON.stringify({ message: 'sensitive server detail' }), {
                status: 500,
                headers: { 'content-type': 'application/json' }
              }),
            query,
            { paginated: true }
          )
        }
        return retryResult.promise
      })
      const fetchWikiSourceImpl = vi.fn(async (selector: { id: number }) => source(selector.id))
      const mounted = mountPicker(searchPagesImpl, fetchWikiSourceImpl, emptyDraft(Array.from({ length: 7 }, (_, index) => source(index + 1))))
      await openPicker(mounted)
      vi.useFakeTimers()
      try {
        await search(mounted, 'selected')
        await selectResult()
        await search(mounted, 'failed')

        const alerts = Array.from(document.body.querySelectorAll('.agent-context__dialog [role="alert"]')).filter(alert => alert.textContent?.trim())
        expect(alerts).toHaveLength(1)
        expect(alerts[0]?.textContent).toContain(translateEnglish('common:agentContextPicker.pageSearchCouldNot'))
        expect(alerts[0]?.textContent).not.toContain('sensitive server detail')
        expect(document.body.querySelector('.agent-context__results-state')).toBeNull()
        expect(document.body.querySelector('.agent-context__status')).toBeNull()
        expect(document.body.querySelectorAll('.agent-context__pending-list .v-chip')).toHaveLength(1)
        expect(searchPagesImpl).toHaveBeenCalledTimes(2)

        const retry = alerts[0]?.querySelector<HTMLButtonElement>('button')
        if (!retry) throw new Error('Search failure retry action did not render')
        retry.click()
        await settle()
        expect(searchPagesImpl).toHaveBeenCalledTimes(3)
        expect(document.body.querySelector('.agent-context__results-state[role="status"]')).not.toBeNull()
        expect(document.body.querySelector('.agent-context__search-error')).toBeNull()
        retryResult.resolve(result(recoveredRows))
        await settle()
        expect(Array.from(document.body.querySelectorAll('.agent-context__dialog [role="alert"]')).filter(alert => alert.textContent?.trim())).toHaveLength(0)
        expect(resultCheckboxes()).toHaveLength(recoveredRows.length)
        if (recoveredRows.length) expect(resultCheckboxes()[0]?.getAttribute('aria-disabled')).toBe('true')
        else
          expect(document.body.querySelector('.agent-context__results-state')?.textContent).toBe(
            translateEnglish('common:agentContextPicker.noAccessiblePagesMatched')
          )
        expect(document.body.querySelectorAll('.agent-context__pending-list .v-chip')).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(320)
        await settle()
        expect(searchPagesImpl).toHaveBeenCalledTimes(3)
        expect(fetchWikiSourceImpl).not.toHaveBeenCalled()
        expect(mounted.changes).toHaveLength(0)
        expect(mounted.sourcesAdded.value).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  }
})

describe('Agent context final source continuation focus', () => {
  const moreButton = (): HTMLButtonElement => {
    const button = document.body.querySelector<HTMLButtonElement>('.agent-context__more')
    if (!button) throw new Error('Source continuation action did not render')
    return button
  }
  const searchInput = (): HTMLInputElement => {
    const input = document.body.querySelector<HTMLInputElement>('.agent-context__search input')
    if (!input) throw new Error('Source search field did not render')
    return input
  }

  it('moves focus from the exhausted continuation to the first newly appended enabled source', async () => {
    const finalPage = deferred<PageSearchResult>()
    const mounted = mountPicker(
      vi.fn((_fetchImpl: unknown, _query: string, options: Record<string, unknown>) =>
        options.cursor ? finalPage.promise : Promise.resolve(result([row(71)], 'last-page'))
      ),
      vi.fn(async (selector: { id: number }) => source(selector.id)),
      emptyDraft([source(72)])
    )
    await openPicker(mounted)
    await search(mounted, 'topics')
    const more = moreButton()
    more.focus()
    expect(document.activeElement).toBe(more)
    more.click()
    await settle()

    finalPage.resolve(result([row(72), row(73), row(74)], null))
    await settle()

    expect(document.body.querySelector('.agent-context__more')).toBeNull()
    expect(Array.from(document.body.querySelectorAll('.agent-context__result strong'), element => element.textContent)).toEqual([
      'Topic 71',
      'Topic 72',
      'Topic 73',
      'Topic 74'
    ])
    expect(resultCheckboxes()[1]?.getAttribute('aria-disabled')).toBe('true')
    expect(resultCheckboxes()[2]?.disabled).toBe(false)
    expect(document.activeElement).toBe(resultCheckboxes()[2])
    expect(mounted.changes).toHaveLength(0)
  })

  it('returns focus to the surviving search input when the final page appends no unique source', async () => {
    const finalPage = deferred<PageSearchResult>()
    const mounted = mountPicker(
      vi.fn((_fetchImpl: unknown, _query: string, options: Record<string, unknown>) =>
        options.cursor ? finalPage.promise : Promise.resolve(result([row(75)], 'last-page'))
      ),
      vi.fn(async (selector: { id: number }) => source(selector.id))
    )
    await openPicker(mounted)
    await search(mounted, 'topics')
    const input = searchInput()
    const more = moreButton()
    more.focus()
    expect(document.activeElement).toBe(more)
    more.click()
    await settle()

    finalPage.resolve(result([row('75')], null))
    await settle()

    expect(document.body.querySelector('.agent-context__more')).toBeNull()
    expect(resultCheckboxes()).toHaveLength(1)
    expect(searchInput()).toBe(input)
    expect(document.activeElement).toBe(input)
  })

  it('does not steal focus when the exhausted continuation was not focused', async () => {
    const finalPage = deferred<PageSearchResult>()
    const mounted = mountPicker(
      vi.fn((_fetchImpl: unknown, _query: string, options: Record<string, unknown>) =>
        options.cursor ? finalPage.promise : Promise.resolve(result([row(76)], 'last-page'))
      ),
      vi.fn(async (selector: { id: number }) => source(selector.id))
    )
    await openPicker(mounted)
    await search(mounted, 'topics')
    const existingCheckbox = resultCheckboxes()[0]
    existingCheckbox.focus()
    expect(document.activeElement).toBe(existingCheckbox)
    moreButton().click()
    await settle()

    finalPage.resolve(result([row(77)], null))
    await settle()

    expect(document.body.querySelector('.agent-context__more')).toBeNull()
    expect(resultCheckboxes()).toHaveLength(2)
    expect(document.activeElement).toBe(existingCheckbox)
  })

  for (const replacement of ['reopened', 'query-replaced'] as const) {
    it(`does not let a cancelled final continuation steal focus from the ${replacement} dialog`, async () => {
      const staleFinalPage = deferred<PageSearchResult>()
      const mounted = mountPicker(
        vi.fn((_fetchImpl: unknown, query: string, options: Record<string, unknown>) => {
          if (options.cursor) return staleFinalPage.promise
          return Promise.resolve(query === 'original' ? result([row(78)], 'last-page') : result([row(79), row(80)]))
        }),
        vi.fn(async (selector: { id: number }) => source(selector.id))
      )
      await openPicker(mounted)
      await search(mounted, 'original')
      const more = moreButton()
      more.focus()
      expect(document.activeElement).toBe(more)
      more.click()
      await settle()

      if (replacement === 'reopened') {
        const cancel = document.body.querySelector<HTMLButtonElement>('.agent-context__dialog-close')
        if (!cancel) throw new Error('Cancel action did not render')
        cancel.click()
        await settle()
        await openPicker(mounted)
      }
      await search(mounted, 'replacement')
      const freshCheckbox = resultCheckboxes()[1]
      freshCheckbox.focus()
      expect(document.activeElement).toBe(freshCheckbox)

      staleFinalPage.resolve(result([row(81)], null))
      await settle()

      expect(Array.from(document.body.querySelectorAll('.agent-context__result strong'), element => element.textContent)).toEqual(['Topic 79', 'Topic 80'])
      expect(document.body.querySelector('.agent-context__more')).toBeNull()
      expect(document.activeElement).toBe(freshCheckbox)
      expect(mounted.changes).toHaveLength(0)
    })
  }
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
      expect(document.body.querySelector('.agent-context__results-state[role="status"] .v-progress-circular')).not.toBeNull()
      expect(document.body.querySelector('.agent-context__status[role="status"]')?.textContent).toMatch(/\b(searching|loading)\b/i)
      expect(document.body.querySelector('.agent-context__status')?.textContent).not.toMatch(/\b0\s+results?\b/i)

      await vi.advanceTimersByTimeAsync(299)
      await settle()
      expect(searchPagesImpl).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await settle()
      expect(searchPagesImpl).toHaveBeenCalledTimes(1)

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
  it('resumes interrupted discovery after Apply fails instead of reporting an unsearched query as empty', async () => {
    const results = deferred<PageSearchResult>()
    const searchPagesImpl = vi.fn(async (_fetchImpl: unknown, query: string) => (query === 'selected' ? result([row(171)]) : results.promise))
    const mounted = mountPicker(
      searchPagesImpl,
      vi.fn(async () => {
        throw new Error('This source is no longer available to you.')
      })
    )
    await openPicker(mounted)
    await search(mounted, 'selected')
    await selectResult()
    await search(mounted, 'loading')
    addButton().click()
    await settle()
    expect(document.body.querySelector('.agent-context__results-state[role="status"]')?.textContent).toContain('Searching pages')
    expect(document.body.querySelector('.agent-context__results-state')?.textContent).not.toContain('No accessible pages')
    results.resolve(result([row(172)]))
    await settle()
    expect(resultCheckboxes()).toHaveLength(1)
    expect(resultCheckboxes()[0]?.getAttribute('aria-label')).toContain('Topic 172')
    expect(document.body.querySelectorAll('.agent-context__pending-list .v-chip')).toHaveLength(1)
    expect(addButton().textContent).toBe('Apply (1)')
    expect(mounted.changes).toEqual([])
  })

  for (const cancellation of ['cancel', 'unmount'] as const) {
    it(`discards late recent suggestions after ${cancellation}`, async () => {
      const stale = deferred<RecentPageRow[]>()
      const mounted = mountPicker(
        vi.fn(async () => result([])),
        vi.fn(async (selector: { id: number }) => source(selector.id)),
        emptyDraft(),
        null,
        {},
        vi.fn(() => stale.promise)
      )
      await openPicker(mounted)
      if (cancellation === 'cancel') document.body.querySelector<HTMLButtonElement>('.agent-context__dialog-close')?.click()
      else {
        mounted.app.unmount()
        mounted.host.remove()
        mountedPickers.splice(mountedPickers.indexOf(mounted), 1)
      }
      stale.resolve([recent(161)])
      await settle()
      expect(document.body.querySelector('.agent-context__result')).toBeNull()
      expect(mounted.changes).toEqual([])
      expect(mounted.sourcesAdded.value).toBe(0)
    })
  }

  it('keeps fresh results after reopening when a cancelled search completes late', async () => {
    const stale = deferred<PageSearchResult>()
    const fresh = deferred<PageSearchResult>()
    const searchPagesImpl = vi.fn((_fetchImpl: unknown, query: string) => (query === 'stale' ? stale.promise : fresh.promise))
    const mounted = mountPicker(
      searchPagesImpl,
      vi.fn(async (selector: { id: number }) => source(selector.id))
    )
    await openPicker(mounted)
    await search(mounted, 'stale')
    const cancel = document.body.querySelector<HTMLButtonElement>('.agent-context__dialog-close')
    if (!cancel) throw new Error('Cancel action did not render')
    cancel.click()
    await settle()
    expect(document.body.querySelector('.agent-context__result')).toBeNull()
    await openPicker(mounted)
    await search(mounted, 'fresh')
    expect(document.body.querySelector('.agent-context__results-state[role="status"] .v-progress-circular')).not.toBeNull()

    fresh.resolve(result([row(42)]))
    await settle()
    expect(Array.from(document.body.querySelectorAll('.agent-context__result strong'), element => element.textContent)).toEqual(['Topic 42'])

    stale.resolve(result([row(41)]))
    await settle()

    expect(Array.from(document.body.querySelectorAll('.agent-context__result strong'), element => element.textContent)).toEqual(['Topic 42'])
    expect(document.body.querySelector('.agent-context__results-state')).toBeNull()
    expect(mounted.sourcesAdded.value).toBe(0)
    expect(mounted.changes).toHaveLength(0)
  })
})
