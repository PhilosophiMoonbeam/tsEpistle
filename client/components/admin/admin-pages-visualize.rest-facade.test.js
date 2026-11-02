import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserWindow, document } from '../../test/browser-dom.mts'
import { afterEach, vi } from '../../../server/test/bun-test.mts'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
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

const template = compileTemplate({
  source: source.match(/<template>([\s\S]*?)<\/template>\s*<script/)[1],
  filename: componentPath,
  id: 'atlas-contract',
  compilerOptions: { mode: 'function' }
})
if (template.errors.length) throw template.errors[0]
const render = new Function('Vue', template.code)(Vue)
const heroPath = path.join(process.cwd(), 'client/components/common/admin-hero.vue')
const { descriptor: heroDescriptor } = parse(fs.readFileSync(heroPath, 'utf8'), { filename: heroPath })
const heroScript = compileScript(heroDescriptor, { id: 'atlas-hero', genDefaultAs: '__sfc__' })
const heroTemplate = compileTemplate({
  source: heroDescriptor.template.content,
  filename: heroPath,
  id: 'atlas-hero',
  preprocessLang: heroDescriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { bindingMetadata: heroScript.bindings, expressionPlugins: ['typescript'] }
})
if (heroTemplate.errors.length) throw heroTemplate.errors[0]
const heroCode = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  `${heroScript.content}\n${heroTemplate.code}\n__sfc__.render = render\nexport default __sfc__`
)
const { default: AdminHero } = await import('data:text/javascript;base64,' + Buffer.from(heroCode).toString('base64'))
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(script.replace(/^import .*$/gm, '').replace('export default', 'return'))
const createOptions = (wikiStore, loadLinks = fetchPageLinks, window = browserWindow) =>
  new Function(
    'defineComponent',
    'markRaw',
    '_',
    'd3',
    'AsyncState',
    'getErrorMessage',
    'fetchPageLinks',
    'wikiStore',
    'siteLangs',
    'siteConfig',
    'window',
    executable
  )(
    Vue.defineComponent,
    Vue.markRaw,
    _,
    d3,
    { render: () => null },
    error => error.message,
    loadLinks,
    wikiStore,
    [
      { code: 'en', name: 'English' },
      { code: 'fr', name: 'French' }
    ],
    { lang: 'en' },
    window
  )
const mounted = []
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount()
    host.remove()
  }
  vi.restoreAllMocks()
})
const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 0))
  await Vue.nextTick()
}
const mountAtlas = () => {
  const options = createOptions({
    startLoading() {},
    stopLoading() {},
    showError: error => {
      throw error
    }
  })
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({ ...options, render })
  app.config.globalProperties.$t = translateEnglish
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  app.component('admin-hero', AdminHero)
  app.component('router-link', { render: () => null })
  const vm = app.mount(host)
  mounted.push({ app, host })
  return { vm, host }
}

describe('admin pages visualize REST facade', () => {
  it('loads locale-scoped REST links on mount and after a locale change', async () => {
    const rows = {
      en: [{ id: 7, path: 'en/docs/alpha', title: 'Alpha', links: [] }],
      fr: [{ id: 8, path: 'fr/docs/beta', title: 'Beta', links: [] }]
    }
    const fetch = vi.spyOn(browserWindow, 'fetch').mockImplementation(async url => ({
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
    const browserWindow = { fetch() {} }
    const executeLoadPages = createOptions(wikiStore, fetchPageLinks, browserWindow).methods.loadPages
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

    const staleLocaleARequest = executeLoadPages.call(state)
    state.currentLocale = 'B'
    const staleLocaleBRequest = executeLoadPages.call(state)
    state.currentLocale = 'A'
    const latestLocaleARequest = executeLoadPages.call(state)

    expect(pendingRequests.map(request => request.locale)).toEqual(['A', 'B', 'A'])
    pendingRequests[2].resolve(latestLocaleAPages)
    await latestLocaleARequest
    expect(state.pages).toBe(latestLocaleAPages)

    pendingRequests[0].resolve(staleLocaleAPages)
    await staleLocaleARequest
    pendingRequests[1].resolve(staleLocaleBPages)
    await staleLocaleBRequest
    expect(state.pages).toBe(latestLocaleAPages)
    expect(state.loading).toBe(false)
    expect(state.errorMessage).toBe('')
  })

  it.each(['rradial', 'htree', 'hradial'])('activates generated page labels but not folders or unrelated keys in %s', graphMode => {
    const options = createOptions({})
    const pushed = []
    const opened = []
    const open = vi.spyOn(browserWindow, 'open').mockImplementation((...args) => {
      opened.push(args)
      return null
    })
    const container = document.createElement('div')
    document.body.append(container)
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
      expect(opened).toEqual([
        ['/a/pages/7', '_blank', 'noopener'],
        ['/a/pages/7', '_blank', 'noopener']
      ])
      const folder = [...container.querySelectorAll('text')].find(node => node.getAttribute('aria-hidden') !== 'true' && node.__data__?.data.id === undefined)
      expect(folder).toBeDefined()
      folder.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
      folder.dispatchEvent(new browserWindow.MouseEvent('click'))
      expect(pushed).toHaveLength(3)
      expect(opened).toHaveLength(2)
    } finally {
      options.beforeUnmount.call(state)
      open.mockRestore()
      container.remove()
    }
  })

  it.each(['htree', 'hradial', 'rradial'])('fits and resets the existing %s diagram after zoom, deferring fit while hidden or zero-sized', async graphMode => {
    // JSDOM supplies no SVG measurements. Supply only a native API result;
    // production D3 and Fit/Reset perform every size and transform operation.
    // Actual label spacing/getBBox correctness belongs to the native flow.
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1)
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {})
    const prototype = browserWindow.SVGElement.prototype
    const geometry = Object.getOwnPropertyDescriptor(prototype, 'getBBox')
    Object.defineProperty(prototype, 'getBBox', { configurable: true, value: () => ({ x: -120, y: -80, width: 1000, height: 600 }) })
    vi.spyOn(browserWindow, 'fetch').mockImplementation(async () => ({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => [{ id: 7, path: 'en/docs/alpha', title: 'Alpha', links: [] }]
    }))
    try {
      const { vm, host } = mountAtlas()
      await settle()
      vm.graphMode = graphMode
      await Vue.nextTick()
      const container = host.querySelector('.admin-pages-visualize-svg')
      let width = 640
      Object.defineProperties(container, {
        clientWidth: { configurable: true, get: () => width },
        clientHeight: { configurable: true, get: () => 360 }
      })
      const svg = container.querySelector('svg')
      const label = container.querySelector('text[role="link"]')
      const control = key => [...host.querySelectorAll('button')].find(button => button.textContent.trim() === translateEnglish(key))
      const zoomIn = () => host.querySelector(`button[aria-label="${translateEnglish('admin:pagesVisualize.zoomIn')}"]`).click()
      control('admin:pagesVisualize.fitDiagram').click()
      const fitted = d3.zoomTransform(svg)
      const bounds = svg.querySelector('g').getBBox()
      for (const [x, y] of [
        [bounds.x, bounds.y],
        [bounds.x + bounds.width, bounds.y + bounds.height]
      ]) {
        const [screenX, screenY] = fitted.apply([x, y])
        expect(screenX).toBeGreaterThanOrEqual(32 - 1e-7)
        expect(screenX).toBeLessThanOrEqual(width - 32 + 1e-7)
        expect(screenY).toBeGreaterThanOrEqual(32 - 1e-7)
        expect(screenY).toBeLessThanOrEqual(360 - 32 + 1e-7)
      }
      expect(Number(svg.getAttribute('width'))).toBeGreaterThanOrEqual(width)
      expect(Number(svg.getAttribute('height'))).toBeGreaterThanOrEqual(360)
      zoomIn()
      const zoomed = d3.zoomTransform(svg)
      expect(zoomed.k).toBeGreaterThan(fitted.k)

      vm.directory = true
      await Vue.nextTick()
      vm.fitDiagram()
      expect(d3.zoomTransform(svg)).toBe(zoomed)
      vm.directory = false
      width = 0
      await Vue.nextTick()
      control('admin:pagesVisualize.resetView').click()
      expect(d3.zoomTransform(svg)).toBe(zoomed)
      width = 640
      control('admin:pagesVisualize.resetView').click()
      expect(d3.zoomTransform(svg)).toEqual(fitted)
      expect(container.querySelector('svg')).toBe(svg)
      expect(container.querySelector('text[role="link"]')).toBe(label)
      zoomIn()
      host.querySelector(`button[aria-label="${translateEnglish('admin:pagesVisualize.zoomOut')}"]`).click()
      expect(d3.zoomTransform(svg).k).toBeCloseTo(fitted.k)
      zoomIn()
      control('admin:pagesVisualize.fitDiagram').click()
      expect(d3.zoomTransform(svg)).toEqual(fitted)
    } finally {
      for (const { app, host } of mounted.splice(0)) {
        app.unmount()
        host.remove()
      }
      if (geometry) Object.defineProperty(prototype, 'getBBox', geometry)
      else delete prototype.getBBox
    }
  })
})
