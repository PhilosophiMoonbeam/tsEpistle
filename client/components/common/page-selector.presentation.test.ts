import { compileTemplate, parse } from '@vue/compiler-sfc'
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import type { ComponentOptions, PropType, RenderFunction } from 'vue'
import type { PageTreeRow } from '../../helpers/pages-api.ts'

const filename = join(process.cwd(), 'client/components/common/page-selector.vue')
const parsed = parse(readFileSync(filename, 'utf8'), { filename })
if (parsed.errors.length > 0 || !parsed.descriptor.template || !parsed.descriptor.script) {
  throw new Error(`Cannot parse page-selector.vue: ${parsed.errors.join(', ')}`)
}

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'https://wiki.test/en/docs/current'
})
const browserWindow = dom.window
for (const [name, value] of Object.entries({
  AbortController: globalThis.AbortController,
  CSS: { escape: (value: string) => value, supports: () => false },
  Element: browserWindow.Element,
  Event: browserWindow.Event,
  HTMLElement: browserWindow.HTMLElement,
  KeyboardEvent: browserWindow.KeyboardEvent,
  MouseEvent: browserWindow.MouseEvent,
  MutationObserver: browserWindow.MutationObserver,
  Node: browserWindow.Node,
  SVGElement: browserWindow.SVGElement,
  document: browserWindow.document,
  getComputedStyle: browserWindow.getComputedStyle.bind(browserWindow),
  navigator: browserWindow.navigator,
  window: browserWindow
})) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
}
const globals = globalThis as typeof globalThis & {
  siteConfig: { lang: string }
  siteLangs: Array<{ code: string; name: string }>
}
globals.siteConfig = { lang: 'en' }
globals.siteLangs = []

const Vue = await import('vue')
const compiled = compileTemplate({
  filename,
  id: 'page-selector-presentation-test',
  source: parsed.descriptor.template.content,
  preprocessLang: parsed.descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length > 0) throw new Error(`Cannot compile page-selector.vue: ${compiled.errors.join(', ')}`)
const render = new Function('Vue', compiled.code)(Vue) as RenderFunction
const executableScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  parsed.descriptor.script.content.replace(/^import .*$/gm, '').replace('export default', 'return')
)

const passthrough = (tag = 'div') =>
  Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, slots.default?.())
    }
  })

const AsyncState = Vue.defineComponent({
  props: {
    state: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, default: '' }
  },
  setup(props) {
    return () =>
      Vue.h(
        'div',
        {
          class: ['async-state', `async-state--${props.state}`],
          'data-state': props.state,
          role: 'status'
        },
        [Vue.h('strong', props.title), props.message ? Vue.h('span', props.message) : undefined]
      )
  }
})

const listActivationKey = Symbol('page-selector-list-activation')
const VList = Vue.defineComponent({
  inheritAttrs: false,
  props: {
    activated: { type: Array as PropType<number[]>, default: () => [] }
  },
  emits: ['update:activated'],
  setup(_props, { attrs, emit, slots }) {
    Vue.provide(listActivationKey, (value: number) => emit('update:activated', [value]))
    return () => Vue.h('div', { ...attrs, class: ['v-list', attrs.class] }, slots.default?.())
  }
})
const VListItem = Vue.defineComponent({
  inheritAttrs: false,
  props: { value: { type: Number, required: true } },
  setup(props, { attrs, slots }) {
    const activate = Vue.inject<(value: number) => void>(listActivationKey)
    return () =>
      Vue.h(
        'button',
        {
          ...attrs,
          type: 'button',
          'data-value': props.value,
          onClick: () => activate?.(props.value)
        },
        [slots.prepend?.({}), slots.default?.({})]
      )
  }
})

let app: ReturnType<typeof Vue.createApp> | undefined
let rows: PageTreeRow[] = []
afterEach(() => {
  app?.unmount()
  app = undefined
  dom.window.document.body.replaceChildren()
})

const settle = async (): Promise<void> => {
  await Promise.resolve()
  await Vue.nextTick()
  await Promise.resolve()
  await Vue.nextTick()
}

const mountSelector = async (initialRows: PageTreeRow[]) => {
  rows = initialRows
  const fetchPageTree = async (): Promise<PageTreeRow[]> => rows
  const getErrorMessage = (error: unknown): string => String(error)
  const mountedSelector = new Function('defineComponent', 'markRaw', 'useId', 'fetchPageTree', 'getErrorMessage', 'AsyncState', executableScript)(
    Vue.defineComponent,
    Vue.markRaw,
    Vue.useId,
    fetchPageTree,
    getErrorMessage,
    AsyncState
  ) as ComponentOptions
  mountedSelector.render = render
  const host = dom.window.document.createElement('div')
  dom.window.document.body.append(host)
  app = Vue.createApp(mountedSelector, {
    modelValue: true,
    mode: 'select',
    mustExist: true,
    path: 'docs/current',
    locale: 'en'
  })
  for (const name of ['v-card', 'v-col', 'v-icon', 'v-progress-circular', 'v-row', 'v-select', 'v-spacer', 'v-text-field', 'v-toolbar', 'vue-scroll'])
    app.component(name, passthrough())
  app.component('v-alert', passthrough())
  app.component('v-btn', passthrough('button'))
  app.component('v-card-actions', passthrough())
  app.component('v-card-chin', passthrough())
  app.component('v-dialog', passthrough())
  app.component('v-list', VList)
  app.component('v-list-item', VListItem)
  app.component('v-list-item-title', passthrough('span'))
  app.component('v-tooltip', passthrough())
  app.component('v-treeview', passthrough())
  app.config.globalProperties.$t = (key: string): string =>
    ({
      'common:pageSelector.createTitle': 'Select New Page Location',
      'common:pageSelector.moveTitle': 'Move / Rename Page Location',
      'common:pageSelector.pages': 'Pages',
      'common:pageSelector.selectTitle': 'Select a Page',
      'common:pageSelector.virtualFolders': 'Virtual Folders',
      'common:pageSelector.folderEmptyWarning': 'This folder is empty.'
    })[key] ?? key
  app.config.globalProperties.$vuetify = { display: { smAndDown: false } }
  const instance = app.mount(host) as unknown as { currentLocale: string }
  await settle()
  return { host, instance }
}

const page = (id: number, path: string, title: string): PageTreeRow => ({
  id,
  path,
  title,
  isFolder: false,
  pageId: id,
  parent: 0,
  locale: 'en',
  visibility: 'public',
  ownerId: null
})

describe('Browse page selector presentation', () => {
  test('keeps current and selected pages distinct and gives an empty folder a visible state', async () => {
    const { host, instance } = await mountSelector([page(11, 'docs/current', 'Current page'), page(12, 'docs/other', 'Another page')])

    const current = host.querySelector<HTMLElement>('.page-selector__page--current')
    expect(current?.textContent).toContain('Current page')
    expect(current?.getAttribute('aria-current')).toBe('page')
    expect(host.querySelector('.page-selector__page--selected')).toBeNull()
    expect(host.querySelector('[data-selection-state="none"]')).not.toBeNull()

    const other = host.querySelector<HTMLButtonElement>('[data-value="12"]')
    expect(other).not.toBeNull()
    other!.click()
    await settle()

    const selected = host.querySelector<HTMLElement>('.page-selector__page--selected')
    expect(selected?.textContent).toContain('Another page')
    expect(selected?.getAttribute('aria-current')).toBeNull()
    expect(host.querySelector('.page-selector__page--current')?.textContent).toContain('Current page')
    expect(host.querySelector('[data-selection-state="selected"]')).not.toBeNull()

    rows = []
    instance.currentLocale = 'fr'
    await settle()
    expect(host.querySelector('.async-state--empty')?.getAttribute('data-state')).toBe('empty')
    expect(host.querySelector('[data-selection-state]')).toBeNull()
  })
})
