import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody, setLocation } from '../../test/browser-dom.mts'
import type { ComponentOptions, PropType, RenderFunction } from 'vue'
import type { PageListRow } from '../../helpers/pages-api.ts'

const filename = join(process.cwd(), 'client/components/profile/pages.vue')
const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
if (errors.length || !descriptor.template || !descriptor.script) throw new Error(`Cannot parse pages.vue: ${errors}`)

resetBody()
setLocation('/p/pages')
browserWindow.fetch = globalThis.fetch

// Compile the actual Pug and Vue expressions, including translated count interpolation.
const Vue = await import('vue')
const compiled = compileTemplate({
  filename,
  id: 'profile-pages-search-test',
  source: descriptor.template.content,
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length) throw new Error(`Cannot compile pages.vue: ${compiled.errors}`)
const render = new Function('Vue', compiled.code)(Vue) as RenderFunction
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(descriptor.script.content.replace(/^import .*$/gm, '').replace('export default', 'return'))
const evaluate = new Function('AsyncState', 'fetchPages', 'getErrorMessage', 'showNotification', 'setLoading', 'wikiStore', script)

const passthrough = (tag = 'div') =>
  Vue.defineComponent({
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, slots.default?.())
    }
  })
const AsyncState = Vue.defineComponent({
  props: ['title', 'message'],
  setup(props) {
    return () => Vue.h('div', { role: 'status' }, [props.title, props.message])
  }
})
const TextField = Vue.defineComponent({
  inheritAttrs: false,
  props: ['modelValue', 'label', 'disabled'],
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () =>
      Vue.h('div', [
        Vue.h('input', {
          ...attrs,
          'aria-label': props.label,
          disabled: props.disabled,
          value: props.modelValue ?? '',
          onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
        }),
        Vue.h('button', { 'aria-label': 'Clear search', onClick: () => emit('update:modelValue', null) }, 'Clear')
      ])
  }
})
const DataTable = Vue.defineComponent({
  props: {
    items: { type: Array as PropType<PageListRow[]>, default: () => [] },
    page: { type: Number, default: 1 },
    itemsPerPage: { type: Number, default: 15 }
  },
  setup(props, { slots }) {
    return () =>
      Vue.h('table', { 'data-page': props.page }, [
        Vue.h('caption', slots.caption?.()),
        Vue.h(
          'tbody',
          props.items.length
            ? props.items.slice((props.page - 1) * props.itemsPerPage, props.page * props.itemsPerPage).map(item => slots.item?.({ item }))
            : Vue.h('tr', [Vue.h('td', slots['no-data']?.())])
        )
      ])
  }
})
const Pagination = Vue.defineComponent({
  props: ['length', 'modelValue'],
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    return () =>
      Vue.h(
        'nav',
        Array.from({ length: props.length }, (_, index) =>
          Vue.h(
            'button',
            {
              'aria-label': `Page ${index + 1}`,
              onClick: () => emit('update:modelValue', index + 1)
            },
            String(index + 1)
          )
        )
      )
  }
})

let app: ReturnType<typeof Vue.createApp> | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.replaceChildren()
})
const settle = async () => {
  await Promise.resolve()
  await Vue.nextTick()
  await Promise.resolve()
  await Vue.nextTick()
}
const mount = async (rows: PageListRow[], mobile = false) => {
  const fetchPages = vi.fn(async () => rows)
  const options = evaluate(AsyncState, fetchPages, String, vi.fn(), vi.fn(), { user: { id: 7 }, showError: vi.fn() }) as ComponentOptions
  app = Vue.createApp({ ...options, render })
  for (const name of ['v-container', 'v-row', 'v-col', 'v-card', 'v-avatar', 'v-icon', 'v-spacer', 'v-chip']) app.component(name, passthrough())
  app.component('v-btn', passthrough('button'))
  app.component('v-text-field', TextField)
  app.component('v-data-table', DataTable)
  app.component('v-pagination', Pagination)
  app.config.globalProperties.$vuetify = { display: { smAndDown: mobile, mdAndUp: !mobile } }
  app.config.globalProperties.$helpers = { formatMoment: (date: string) => date }
  app.config.globalProperties.$t = (key: string, params: Record<string, unknown> = {}) =>
    String(params.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_match, name) => String(params[name] ?? ''))
  const host = document.createElement('div')
  document.body.append(host)
  app.mount(host)
  await settle()
  return { host, fetchPages }
}
const makePage = (id: number, overrides: Partial<PageListRow> = {}): PageListRow => ({
  id,
  title: `Archive ${id}`,
  description: null,
  locale: 'en',
  path: `records/${id}`,
  visibility: 'public',
  ownerId: null,
  contentType: 'markdown',
  tags: [],
  createdAt: '2026-09-12T00:00:00Z',
  updatedAt: '2026-09-12T00:00:00Z',
  ...overrides
})
const search = async (host: HTMLElement, value: string) => {
  const input = host.querySelector('input')!
  input.value = value
  input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  await settle()
}
const click = async (host: HTMLElement, label: string) => {
  const button = [...host.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label)
  expect(button).toBeDefined()
  button!.click()
  await settle()
}

describe('My Pages local search', () => {
  test('compiles and renders the count, filters all four fields, and clears a nullable model', async () => {
    const { host, fetchPages } = await mount([
      makePage(1, { title: 'Nebula guide' }),
      makePage(2, { description: 'Spectrometer setup' }),
      makePage(3, { path: 'laboratory/optics' }),
      makePage(4, { locale: 'fr' })
    ])
    expect(host.querySelector('input')?.getAttribute('aria-label')).toBe('Find your pages')
    expect(host.querySelector('#profile-pages-result-count')?.textContent).toBe('4 of 4 pages')
    for (const [query, expectedPath] of [
      [' NEBULA ', '/en/records/1'],
      ['spectrometer', '/en/records/2'],
      ['laboratory/optics', '/en/laboratory/optics'],
      ['FR', '/fr/records/4']
    ]) {
      await search(host, query)
      expect(host.querySelectorAll('.profile-page-link')).toHaveLength(1)
      expect(host.querySelector('.profile-page-link')?.getAttribute('href')).toBe(expectedPath)
      expect(host.querySelector('#profile-pages-result-count')?.textContent).toBe('1 of 4 pages')
    }
    await click(host, 'Clear search')
    expect(host.querySelector('input')?.value).toBe('')
    expect(host.querySelectorAll('.profile-page-link')).toHaveLength(4)
    expect(fetchPages).toHaveBeenCalledTimes(1)
  })

  test('filters private pages, composes with case-insensitive search, and resets without changing links', async () => {
    const { host } = await mount([
      makePage(1, { title: 'Roadmap notes' }),
      makePage(2, { title: 'Private roadmap', visibility: 'private' }),
      makePage(3, { title: 'Private archive', visibility: 'private' })
    ])
    expect(host.querySelector('button[aria-label="Show private pages only"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(host.querySelector('#profile-pages-result-count')?.textContent).toBe('3 of 3 pages')

    await click(host, 'Show private pages only')
    expect(host.querySelector('button[aria-label="Show private pages only"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelectorAll('.profile-page-link')).toHaveLength(2)
    expect(host.querySelector('a[href="/_private/en/records/2"]')).toBeTruthy()
    expect(host.querySelector('a[href="/_private/en/records/3"]')).toBeTruthy()
    expect([...host.querySelectorAll('.ms-2')].some(node => node.textContent?.trim() === 'Private')).toBe(true)
    expect(host.querySelector('#profile-pages-result-count')?.textContent).toBe('2 of 3 pages')

    await search(host, ' ROADMAP ')
    expect(host.querySelectorAll('.profile-page-link')).toHaveLength(1)
    expect(host.querySelector('.profile-page-link')?.getAttribute('href')).toBe('/_private/en/records/2')
    expect(host.querySelector('#profile-pages-result-count')?.textContent).toBe('1 of 3 pages')

    await click(host, 'Show private pages only')
    expect(host.querySelector('button[aria-label="Show private pages only"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(host.querySelectorAll('.profile-page-link')).toHaveLength(2)
    expect(host.querySelector('#profile-pages-result-count')?.textContent).toBe('2 of 3 pages')
    await click(host, 'Clear search')
    expect(host.querySelectorAll('.profile-page-link')).toHaveLength(3)
  })

  test('explains an empty private view and keeps its reset available', async () => {
    const { host } = await mount([makePage(1, { title: 'Roadmap notes' })])
    await click(host, 'Show private pages only')
    expect(host.textContent).toContain('No private pages yet')
    expect(host.textContent).toContain('Turn off Private only to see all your pages.')
    expect(host.querySelector('#profile-pages-result-count')?.textContent).toBe('0 of 1 pages')

    await search(host, 'ROADMAP')
    expect(host.textContent).toContain('No matching private pages')
    expect(host.textContent).toContain('clear your search or turn off Private only')
    await click(host, 'Show private pages only')
    expect(host.querySelectorAll('.profile-page-link')).toHaveLength(1)
    expect(host.querySelector('.profile-page-link')?.getAttribute('href')).toBe('/en/records/1')
  })

  test('keeps the private link and indicator in mobile rows', async () => {
    const { host } = await mount([makePage(7, { title: 'Private mobile page', visibility: 'private' })], true)
    expect(host.querySelector('.profile-pages-mobile-title')?.getAttribute('href')).toBe('/_private/en/records/7')
    expect(host.querySelector('.profile-pages-mobile-meta .me-2')?.textContent?.trim()).toBe('Private')
  })

  test('distinguishes no matching results from an account with no contributions', async () => {
    const { host, fetchPages } = await mount([makePage(1)])
    await search(host, 'nonexistent')
    expect(host.textContent).toContain('No matching pages')
    expect(host.querySelector('#profile-pages-result-count')?.textContent).toBe('0 of 1 pages')
    expect(host.textContent).not.toContain('Pages you create or contribute to')
    fetchPages.mockResolvedValue([])
    await click(host, 'Refresh pages')
    expect(host.textContent).toContain('Pages you create or contribute to will appear here.')
    expect(host.textContent).not.toContain('No matching pages')
  })

  test('resets a later page when filtering and clamps pagination when refresh removes matching pages', async () => {
    const rows = Array.from({ length: 32 }, (_, index) => makePage(index + 1))
    const { host, fetchPages } = await mount(rows)
    await click(host, 'Page 3')
    expect(host.querySelector('table')?.getAttribute('data-page')).toBe('3')
    await search(host, 'records/1')
    expect(host.querySelector('table')?.getAttribute('data-page')).toBe('1')
    expect(host.querySelectorAll('.profile-page-link')).toHaveLength(11)
    await click(host, 'Clear search')
    await search(host, 'archive')
    await click(host, 'Page 3')
    // Total rows still need three pages, but only sixteen match the current filter.
    fetchPages.mockResolvedValue([...rows.slice(0, 16), ...rows.slice(16).map(row => ({ ...row, title: 'Other' }))])
    await click(host, 'Refresh pages')
    expect(host.querySelector('table')?.getAttribute('data-page')).toBe('2')
    expect(host.querySelectorAll('.profile-page-link')).toHaveLength(1)
    expect(host.querySelector('#profile-pages-result-count')?.textContent).toBe('16 of 32 pages')
  })
})
