import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserWindow, document } from '../../test/browser-dom.mts'
import { afterEach, vi } from '../../../server/test/bun-test.mts'
import { compileTemplate } from '@vue/compiler-sfc'
import { fetchPageLinks } from '../../helpers/pages-api.ts'
import _ from 'lodash'
import * as d3 from 'd3'

import { translateEnglish } from '../../test/english-translate.mts'
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const componentPath = path.join(__dirname, 'admin-pages-visualize.vue')
const source = fs.readFileSync(componentPath, 'utf8')
const script = source.match(/<script(?:\s+lang=["']ts["'])?>([\s\S]*?)<\/script>/)[1]
const loadPagesStart = script.indexOf('async loadPages (): Promise<void> {')
const loadPagesEnd = script.indexOf('    goToPage', loadPagesStart)
const loadPagesBody = script.slice(loadPagesStart, loadPagesEnd)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const executeLoadPages = new AsyncFunction(
  'fetchPageLinks',
  'wikiStore',
  'markRaw',
  'getErrorMessage',
  'window',
  loadPagesBody.slice(loadPagesBody.indexOf('{') + 1, loadPagesBody.lastIndexOf('}'))
)

const template = compileTemplate({
  source: source.match(/<template>([\s\S]*?)<\/template>\s*<script/)[1],
  filename: componentPath,
  id: 'atlas-contract',
  compilerOptions: { mode: 'function' }
})
if (template.errors.length) throw template.errors[0]
const render = new Function('Vue', template.code)(Vue)
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '').replace('export default', 'return'))
const createOptions = wikiStore => new Function(
  'defineComponent', 'markRaw', '_', 'd3', 'AsyncState', 'getErrorMessage', 'fetchPageLinks', 'wikiStore', 'siteLangs', 'siteConfig', 'window',
  executable
)(
  Vue.defineComponent, Vue.markRaw, _, d3, { render: () => null }, error => error.message, fetchPageLinks, wikiStore,
  [{ code: 'en', name: 'English' }, { code: 'fr', name: 'French' }], { lang: 'en' }, browserWindow
)
const mounted = []
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) { app.unmount(); host.remove() }
  vi.restoreAllMocks()
})
const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  await Vue.nextTick()
}
const mountAtlas = () => {
  const options = createOptions({ startLoading() {}, stopLoading() {}, showError: error => { throw error } })
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({ ...options, render })
  app.config.globalProperties.$t = translateEnglish
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.component('admin-hero', { render: () => null })
  app.component('router-link', { render: () => null })
  const vm = app.mount(host)
  mounted.push({ app, host })
  return { vm, host }
}

describe('admin pages visualize REST facade', () => {
  it('loads locale-scoped REST links on mount and after a locale change without Apollo', async () => {
    expect(script).not.toContain('graphql-tag')
    expect(script).not.toMatch(/apollo\s*:/)
    expect(script).not.toContain('this.$apollo')
    const rows = {
      en: [{ id: 7, path: 'en/docs/alpha', title: 'Alpha', links: [] }],
      fr: [{ id: 8, path: 'fr/docs/beta', title: 'Beta', links: [] }]
    }
    const fetch = vi.spyOn(browserWindow, 'fetch').mockImplementation(async (url) => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => rows[new URL(url, browserWindow.location.href).searchParams.get('locale')]
    }))
    const { vm, host } = mountAtlas()
    await settle()
    expect(fetch.mock.calls[0][0]).toBe('/_api/pages/links?locale=en')
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', headers: { Accept: 'application/json' } })
    expect(vm.pages).toEqual(rows.en)
    expect(host.querySelector('text[role="link"]').textContent).toContain('Alpha')
    vm.currentLocale = 'fr'
    await settle()
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/_api/pages/links?locale=en', '/_api/pages/links?locale=fr'])
    expect(fetch.mock.calls[1][1]).toMatchObject({ credentials: 'same-origin', headers: { Accept: 'application/json' } })
    expect(vm.pages).toEqual(rows.fr)
    expect(host.querySelector('text[role="link"]').textContent).toContain('Beta')
    expect(host.textContent).not.toContain('Alpha')
  })

  it('keeps the newest request rendered when older requests for the same or another locale resolve afterward', async () => {
    const pendingRequests = []
    const fetchPageLinks = (_fetch, locale) =>
      new Promise(resolve => {
        pendingRequests.push({ locale, resolve })
      })
    const wikiStore = {
      startLoading() {},
      stopLoading() {},
      showError() {}
    }
    const markRaw = pages => pages
    const getErrorMessage = err => err.message
    const browserWindow = { fetch() {} }
    const state = {
      currentLocale: 'A',
      pageLoadRequestId: 0,
      pages: [],
      loading: false,
      errorMessage: '',
      $t: translateEnglish
    }
    const staleLocaleAPages = [{ id: 1, path: 'a-old', title: 'Old Locale A', links: [] }]
    const staleLocaleBPages = [{ id: 2, path: 'b', title: 'Locale B', links: [] }]
    const latestLocaleAPages = [{ id: 3, path: 'a-new', title: 'New Locale A', links: [] }]

    const staleLocaleARequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, markRaw, getErrorMessage, browserWindow)
    state.currentLocale = 'B'
    const staleLocaleBRequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, markRaw, getErrorMessage, browserWindow)
    state.currentLocale = 'A'
    const latestLocaleARequest = executeLoadPages.call(state, fetchPageLinks, wikiStore, markRaw, getErrorMessage, browserWindow)

    expect(pendingRequests.map(request => request.locale)).toEqual(['A', 'B', 'A'])
    pendingRequests[2].resolve(latestLocaleAPages)
    await latestLocaleARequest
    expect(state.pages).toBe(latestLocaleAPages)

    pendingRequests[0].resolve(staleLocaleAPages)
    await staleLocaleARequest
    pendingRequests[1].resolve(staleLocaleBPages)
    await staleLocaleBRequest
    expect(state.pages).toBe(latestLocaleAPages)
  })

  it.each(['rradial', 'htree', 'hradial'])('activates generated page labels but not folders or unrelated keys in %s', graphMode => {
    const options = createOptions({})
    const pushed = []
    const opened = []
    const open = vi.spyOn(browserWindow, 'open').mockImplementation((...args) => { opened.push(args); return null })
    const container = document.createElement('div')
    document.body.append(container)
    const prototype = browserWindow.SVGElement.prototype
    const geometry = Object.getOwnPropertyDescriptor(prototype, 'getBBox')
    Object.defineProperty(prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 800, height: 800 }) })
    const state = {
      ...options.data.call({ $t: translateEnglish }),
      $t: translateEnglish,
      graphMode,
      pages: [{ id: 7, path: 'en/docs/alpha', title: 'Alpha', links: [] }],
      $refs: { svgContainer: container },
      $router: { push: path => pushed.push(path), resolve: path => ({ href: `/a${path}` }) }
    }
    for (const [name, method] of Object.entries(options.methods)) state[name] = method.bind(state)
    try {
      state.redraw()
      const label = container.querySelector('text[role="link"][tabindex="0"]')
      expect(label).not.toBeNull()
      for (const key of ['Enter', ' ']) {
        const event = new browserWindow.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
        label.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(true)
      }
      label.dispatchEvent(new browserWindow.MouseEvent('click', { bubbles: true }))
      expect(pushed).toEqual(['/pages/7', '/pages/7', '/pages/7'])
      const ignored = new browserWindow.KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true })
      label.dispatchEvent(ignored)
      expect(ignored.defaultPrevented).toBe(false)
      expect(pushed).toHaveLength(3)
      for (const modifier of ['ctrlKey', 'metaKey']) {
        label.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, cancelable: true }))
      }
      expect(opened).toEqual([['/a/pages/7', '_blank', 'noopener'], ['/a/pages/7', '_blank', 'noopener']])
      const folder = [...container.querySelectorAll('text')].find(node => node.getAttribute('aria-hidden') !== 'true' && node.__data__?.data.id === undefined)
      expect(folder).toBeDefined()
      folder.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      folder.dispatchEvent(new browserWindow.MouseEvent('click'))
      expect(pushed).toHaveLength(3)
      expect(opened).toHaveLength(2)
    } finally {
      if (geometry) Object.defineProperty(prototype, 'getBBox', geometry)
      else delete prototype.getBBox
      open.mockRestore()
      container.remove()
    }
  })
})
