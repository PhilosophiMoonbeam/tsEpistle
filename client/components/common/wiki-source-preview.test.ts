import { parse, compileTemplate } from '@vue/compiler-sfc'
import fs from 'node:fs'
import path from 'node:path'
import * as Vue from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { createSearchHighlighter } from '../../helpers/search-highlight.ts'
import { wikiSourceHref } from '../../../shared/wiki-source.ts'
import type { WikiSource, WikiSourceSelector } from '../../../shared/wiki-source.ts'
import { createModalFocusScope } from './modal-focus-scope.ts'

const componentPath = path.join(process.cwd(), 'client/components/common/wiki-source-preview.vue')
const descriptor = parse(fs.readFileSync(componentPath, 'utf8'), { filename: componentPath }).descriptor
if (!descriptor.template || !descriptor.scriptSetup) throw new Error('Source preview template and setup script are required')
const compiledTemplate = compileTemplate({
  source: descriptor.template.content,
  filename: componentPath,
  id: 'wiki-source-preview-test',
  compilerOptions: { mode: 'function' }
})
if (compiledTemplate.errors.length) throw compiledTemplate.errors[0]
const renderPreview = new Function('Vue', compiledTemplate.code)(Vue)
// Follow the existing interaction harness: execute the actual setup/template with only the network boundary replaced.
const setupScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(descriptor.scriptSetup.content.replace(/^import .*$/gm, ''))
const bindings = Array.from(descriptor.scriptSetup.content.matchAll(/^(?:const|let|function)\s+([A-Za-z_$][\w$]*)/gm), match => match[1])
const dependencies = {
  computed: Vue.computed,
  onBeforeUnmount: Vue.onBeforeUnmount,
  onMounted: Vue.onMounted,
  ref: Vue.ref,
  useId: Vue.useId,
  useTemplateRef: Vue.useTemplateRef,
  watch: Vue.watch,
  useTheme: () => ({ themeClasses: Vue.ref('v-theme--light') }),
  useTranslate: () => translateEnglish,
  createSearchHighlighter,
  createModalFocusScope,
  wikiSourceHref
}
const evaluatePreview = new Function(
  ...Object.keys(dependencies),
  'defineProps',
  'defineEmits',
  'fetchWikiSource',
  `${setupScript}\nreturn { wikiSourceHref, themeClasses, ${bindings.join(', ')} }`
)
const settle = async (): Promise<void> => {
  for (let pass = 0; pass < 4; pass += 1) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}
const source = (id: number, excerpt = 'Source passage'): WikiSource => ({
  id,
  locale: 'en',
  path: `handbook/topic-${id}`,
  title: `Topic ${id}`,
  description: 'Source description',
  visibility: 'public',
  updatedAt: '2026-09-14T00:00:00.000Z',
  sourceRevision: `rev-${id}`,
  excerpt,
  excerptTruncated: false
})
type FetchSource = (selector: WikiSourceSelector, query: string, signal: AbortSignal) => Promise<WikiSource>
const mountedApps: { unmount: () => void }[] = []
const originalRects = Object.getOwnPropertyDescriptor(browserWindow.HTMLElement.prototype, 'getClientRects')
const buttonStub = Vue.defineComponent({
  inheritAttrs: false,
  props: ['href', 'variant', 'icon', 'prependIcon', 'appendIcon'],
  setup(props, { attrs, slots }) {
    return () => Vue.h(props.href ? 'a' : 'button', { ...attrs, ...(props.href ? { href: props.href } : { type: 'button' }) }, slots.default?.())
  }
})
const mountPreview = (fetchSource: FetchSource, query = 'pizza', canAsk = false) => {
  const host = document.createElement('div')
  const searchInput = document.createElement('input')
  searchInput.value = query
  document.body.append(searchInput, host)
  searchInput.focus()
  searchInput.setSelectionRange(1, query.length)
  const inputs = Vue.reactive({ selector: { id: 1 } as WikiSourceSelector, query, canAsk })
  const visible = Vue.ref(true)
  const asked: WikiSource[] = []
  const preview = Vue.defineComponent({
    props: ['selector', 'query', 'canAsk'],
    emits: ['close', 'ask'],
    setup(props, { emit }) {
      return evaluatePreview(
        ...Object.values(dependencies),
        () => props,
        () => emit,
        fetchSource
      )
    },
    render: renderPreview
  })
  const app = Vue.createApp({
    setup() {
      return () =>
        visible.value
          ? Vue.h(preview, {
              ...inputs,
              onClose: () => {
                visible.value = false
              },
              onAsk: (selected: WikiSource) => asked.push(selected)
            })
          : null
    }
  })
  app.config.globalProperties.$t = translateEnglish
  app.component('VBtn', buttonStub)
  app.component('VIcon', Vue.defineComponent({ setup: () => () => Vue.h('span', { 'aria-hidden': 'true' }) }))
  app.component('VProgressCircular', Vue.defineComponent({ setup: () => () => Vue.h('span', { 'aria-hidden': 'true' }) }))
  app.mount(host)
  mountedApps.push(app)
  return { app, inputs, searchInput, asked }
}
const dialog = (): HTMLElement => {
  const element = document.querySelector<HTMLElement>('.wiki-source-preview__panel')
  if (!element) throw new Error('Source preview did not render')
  return element
}

beforeEach(() => {
  Object.defineProperty(browserWindow.HTMLElement.prototype, 'getClientRects', {
    configurable: true,
    value: () => [{ width: 1, height: 1 }] as unknown as DOMRectList
  })
})
afterEach(() => {
  for (const app of mountedApps.splice(0)) app.unmount()
  document.body.replaceChildren()
  if (originalRects) Object.defineProperty(browserWindow.HTMLElement.prototype, 'getClientRects', originalRects)
  else Reflect.deleteProperty(browserWindow.HTMLElement.prototype, 'getClientRects')
})

describe('source preview reader', () => {
  it('renders only positive structured matches as safe text and keeps page metadata and native actions', async () => {
    const excerpt = '<img src=x onerror=alert(1)> PASTA SAUCE, pasta, noodles, garlic, olive oil, OR'
    const loaded = { ...source(1, excerpt), visibility: 'private' as const, excerptTruncated: true }
    const fetchSource = vi.fn(async () => loaded)
    const mounted = mountPreview(fetchSource, '"pasta sauce" OR noodles -garlic - "olive oil"', true)
    await settle()
    expect(Array.from(dialog().querySelectorAll('mark'), element => element.textContent)).toEqual(['PASTA SAUCE', 'noodles'])
    expect(dialog().querySelector('.wiki-source-preview__excerpt')?.textContent).toBe(excerpt)
    expect(dialog().querySelector('img')).toBeNull()
    expect(dialog().querySelector('.wiki-source-preview__caption')?.textContent).toContain('Passage matching your search')
    expect(dialog().querySelector('.wiki-source-preview__metadata')?.textContent).toContain('Revision rev-1')
    expect(dialog().querySelector('time')?.getAttribute('datetime')).toBe(loaded.updatedAt)
    expect(dialog().querySelector('.wiki-source-preview__footnote')?.textContent).toContain('full context')
    const link = dialog().querySelector<HTMLAnchorElement>('a')!
    expect(link.getAttribute('href')).toBe('/_private/en/handbook/topic-1')
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')
    expect(mounted.asked).toEqual([])
    dialog().querySelector<HTMLButtonElement>('.wiki-source-preview__ask')!.click()
    expect(mounted.asked).toEqual([loaded])
    expect(fetchSource).toHaveBeenCalledTimes(1)
    expect(dialog().querySelector('.wiki-source-preview__draft-hint')?.textContent).toBe('Ask prepares a draft. Nothing is sent.')

    mounted.inputs.query = '-pasta OR -noodles'
    await settle()
    expect(dialog().querySelectorAll('mark')).toHaveLength(0)
    expect(dialog().querySelector('.wiki-source-preview__caption')?.textContent).toContain('From this page')
  })

  it('does not let superseded successes, failures, or finalizers replace the current request', async () => {
    const first = Promise.withResolvers<WikiSource>()
    const second = Promise.withResolvers<WikiSource>()
    const current = Promise.withResolvers<WikiSource>()
    const requests = [first, second, current]
    const signals: AbortSignal[] = []
    const fetchSource = vi.fn((_selector: WikiSourceSelector, _query: string, signal: AbortSignal) => {
      signals.push(signal)
      return requests[signals.length - 1].promise
    })
    const mounted = mountPreview(fetchSource)
    await settle()
    mounted.inputs.selector = { id: 2 }
    await settle()
    expect(signals[0].aborted).toBe(true)
    first.resolve(source(1, 'Superseded passage'))
    await settle()
    expect(dialog().getAttribute('aria-busy')).toBe('true')
    expect(dialog().querySelector('.wiki-source-preview__excerpt')).toBeNull()

    mounted.inputs.selector = { id: 3 }
    mounted.inputs.query = 'current query'
    await settle()
    expect(signals[1].aborted).toBe(true)
    current.resolve(source(3, 'Current passage'))
    await settle()
    second.reject(new Error('Superseded failure'))
    await settle()
    expect(dialog().querySelector('h2')?.textContent).toBe('Topic 3')
    expect(dialog().querySelector('.wiki-source-preview__excerpt')?.textContent).toBe('Current passage')
    expect(dialog().querySelector('[role="alert"]')).toBeNull()
    expect(dialog().getAttribute('aria-busy')).toBe('false')
  })

  it('retries the same selector/query and keeps Escape and input restoration working during retry', async () => {
    const retry = Promise.withResolvers<WikiSource>()
    const calls: { selector: WikiSourceSelector; query: string; signal: AbortSignal }[] = []
    const mounted = mountPreview((selector, query, signal) => {
      calls.push({ selector, query, signal })
      return calls.length === 1 ? Promise.reject(new Error('Source could not be loaded')) : retry.promise
    }, 'pizza -garlic')
    await settle()
    const retryButton = dialog().querySelector<HTMLButtonElement>('[role="alert"] button')!
    retryButton.focus()
    retryButton.click()
    await settle()
    expect(calls).toHaveLength(2)
    expect(calls[1].selector).toEqual(calls[0].selector)
    expect(calls[1].query).toBe('pizza -garlic')
    expect(dialog().getAttribute('aria-busy')).toBe('true')
    expect(dialog().contains(document.activeElement)).toBe(true)
    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.activeElement!.dispatchEvent(escapeEvent)
    await settle()
    expect(escapeEvent.defaultPrevented).toBe(true)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(calls[1].signal.aborted).toBe(true)
    expect(document.activeElement).toBe(mounted.searchInput)
    expect(mounted.searchInput.value).toBe('pizza -garlic')
    expect(mounted.searchInput.selectionStart).toBe(1)
    expect(mounted.searchInput.selectionEnd).toBe('pizza -garlic'.length)
    retry.resolve(source(1))
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('distinguishes a loaded empty excerpt from loading and error', async () => {
    const result = Promise.withResolvers<WikiSource>()
    mountPreview(() => result.promise)
    await settle()
    expect(dialog().querySelector('[role="status"]')?.textContent).toContain('Opening the source')
    result.resolve(source(1, ''))
    await settle()
    expect(dialog().querySelector('[role="status"]')).toBeNull()
    expect(dialog().querySelector('[role="alert"]')).toBeNull()
    expect(dialog().querySelector('.wiki-source-preview__empty')?.textContent).toContain('no preview text')
    expect(dialog().querySelector('a')).not.toBeNull()
    expect(dialog().querySelector('.wiki-source-preview__ask')).toBeNull()
  })

  it('does not start an unowned request after an immediate unmount', async () => {
    const pending = Promise.withResolvers<WikiSource>()
    const signals: AbortSignal[] = []
    const mounted = mountPreview((_selector, _query, signal) => {
      signals.push(signal)
      return pending.promise
    })
    mounted.app.unmount()
    mountedApps.splice(mountedApps.indexOf(mounted.app), 1)
    await settle()
    expect(signals.every(signal => signal.aborted)).toBe(true)
    pending.resolve(source(1))
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
