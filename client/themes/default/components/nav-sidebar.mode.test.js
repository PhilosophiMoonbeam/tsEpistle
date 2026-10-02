import fs from 'node:fs'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import _ from 'lodash'
import { afterAll, afterEach, describe, expect, it, vi } from '../../../../server/test/bun-test.mts'
import { browserWindow } from '../../../test/browser-dom.mts'
import { fetchPageTree } from '../../../helpers/pages-api.ts'
import { loadingStart, loadingStop } from '../../../helpers/root-ui-store.ts'
import { isWikiNavigationClick, navigateToWikiPage } from '../../../helpers/wiki-navigation.ts'

const originalSiteConfig = Object.getOwnPropertyDescriptor(browserWindow, 'siteConfig')
Object.defineProperty(browserWindow, 'siteConfig', {
  configurable: true,
  value: {
    company: '', contentLicense: '', footerOverride: '', banner: {},
    darkMode: false, tocPosition: 'left', title: 'Test', logoUrl: '',
    product: { name: 'Test', version: '1.0.0' }
  }
})
afterAll(() => {
  if (originalSiteConfig) Object.defineProperty(browserWindow, 'siteConfig', originalSiteConfig)
  else Reflect.deleteProperty(browserWindow, 'siteConfig')
})
const { wikiStore } = await import('../../../store/index.ts')

const source = fs.readFileSync(new URL('./nav-sidebar.vue', import.meta.url), 'utf8')
const script = source.match(/<script lang='ts'>([\s\S]*?)<\/script>/)[1]
const executable = new Bun.Transpiler({ loader: 'ts' })
  .transformSync(script.replace(/^import .*$/gm, ''))
  .replace('export default defineComponent(', 'return defineComponent(')
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const vuetifyComponents = await import('vuetify/components')
const vuetifyDirectives = await import('vuetify/directives')
const descriptor = parse(source).descriptor
const compiled = compileTemplate({
  source: descriptor.template.content,
  filename: new URL('./nav-sidebar.vue', import.meta.url).pathname,
  id: 'nav-sidebar-mode',
  preprocessLang: 'pug',
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function', expressionPlugins: ['typescript'] }
})
if (compiled.errors.length) throw compiled.errors[0]
const renderSidebar = new Function('Vue', new Bun.Transpiler({ loader: 'ts' }).transformSync(compiled.code))(Vue)
// This child boundary supplies saved content only. The production sidebar
// decides whether it is rendered for the current connection state.
const OfflineNavigation = Vue.defineComponent({
  render: () => Vue.h('nav', { 'aria-label': 'Saved navigation' }, [
    Vue.h('a', { href: '/en/saved-guide' }, 'Saved guide')
  ])
})
const AsyncState = Vue.defineComponent({
  props: ['state'],
  render() { return Vue.h('div', { 'data-async-state': this.state }) }
})
const treeResponse = rows => ({
  ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }),
  json: async () => rows
})
const createComponent = ({ localStorage = storage(null), connection = Vue.reactive({ connectionState: 'online', mode: 'feature' }),
  checkConnection = vi.fn(async () => true), observeConnection = () => {}, reportConnectionFailure = () => {},
  transport = vi.fn(async () => treeResponse([])) } = {}) => {
  const dependencies = {
    defineComponent: Vue.defineComponent, markRaw: Vue.markRaw, _, AsyncState, OfflineNavigation,
    pwaState: connection, observeBrowserConnection: observeConnection, retryServerConnection: checkConnection,
    reportServerConnectionFailure: reportConnectionFailure, fetchPageTree, wikiStore, loadingStart, loadingStop,
    isWikiNavigationClick, navigateToWikiPage,
    window: { localStorage, fetch: transport, location: browserWindow.location }
  }
  return new Function(...Object.keys(dependencies), executable)(...Object.values(dependencies))
}
const cleanups = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()()
})
const renderMountedSidebar = (options = {}) => {
  const component = createComponent(options)
  const host = document.createElement('div')
  document.body.append(host)
  const app = Vue.createApp({ ...component, render: renderSidebar }, {
    items: options.items ?? [], navMode: 'MIXED', expandParentByDefault: false
  })
  app.config.globalProperties.$t = key => ({
    'common:sidebar.mainMenu': 'Main Menu', 'common:sidebar.browse': 'Browse'
  }[key] ?? key)
  app.use(createVuetify({ components: vuetifyComponents, directives: vuetifyDirectives }))
  const sidebar = app.mount(host)
  cleanups.push(() => { app.unmount(); host.remove() })
  return { sidebar, host }
}
const storage = preference => {
  const values = new Map(preference === null ? [] : [['navPref', preference]])
  return {
    getItem: vi.fn(key => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value))
  }
}
const mountSidebar = ({ localStorage = storage(null), items = [], navMode = 'MIXED', expandParentByDefault = false,
  connectionState = 'online', connection = Vue.reactive({ connectionState, mode: 'feature' }),
  checkConnection = vi.fn(async () => true), transport, realDirectory = false } = {}) => {
  const component = createComponent({ localStorage, connection, checkConnection, transport })
  const sidebar = { ...component.data.call({ $t: key => key }), items, navMode, expandParentByDefault, $t: key => key }
  for (const [name, method] of Object.entries(component.methods)) sidebar[name] = method.bind(sidebar)
  for (const [name, getter] of Object.entries(component.computed)) {
    Object.defineProperty(sidebar, name, { get: () => getter.call(sidebar) })
  }
  if (realDirectory) {
    component.mounted.call(sidebar)
    cleanups.push(() => component.beforeUnmount.call(sidebar))
    return { sidebar, component, connection }
  }
  sidebar.fetchBrowseItems = vi.fn()
  sidebar.loadFromCurrentPath = vi.fn()
  component.mounted.call(sidebar)
  return sidebar
}
const home = { k: 'link', y: 'home', t: '/', l: 'Home', c: 'mdi-home' }
const guide = { k: 'link', y: 'page', t: '/en/guide', l: 'Guide', c: 'mdi-book' }
const treeRow = (id, parent, title, overrides = {}) => ({
  id, parent, title, path: `guides/${id}`, locale: 'fr', pageId: id + 100,
  isFolder: false, visibility: 'private', ownerId: 7, canEdit: false, ...overrides
})
const currentDirectoryFixture = [
  treeRow(10, 0, 'Guides', { isFolder: true, pageId: null, path: 'guides' }),
  treeRow(20, 10, 'Current private guide', { pageId: 42, path: 'guides/current' }),
  treeRow(21, 10, 'Neighbour guide'),
  treeRow(30, 0, 'Root-only page')
]
const useCurrentPage = () => {
  const original = { id: wikiStore.page.id, path: wikiStore.page.path, locale: wikiStore.page.locale, visibility: wikiStore.page.visibility }
  Object.assign(wikiStore.page, { id: 42, path: 'guides/current', locale: 'fr', visibility: 'private' })
  cleanups.push(() => Object.assign(wikiStore.page, original))
}

describe('Custom Navigation preserves its two views', () => {
  for (const [label, items] of [
    ['empty or permission-filtered', []],
    ['home only', [home]],
    ['populated', [home, guide]]
  ]) {
    for (const preference of ['custom', 'browse', null, 'invalid']) {
      it(`respects ${preference ?? 'unset'} preference with a ${label} menu`, () => {
        const localStorage = storage(preference)
        const sidebar = mountSidebar({ items, localStorage })
        const expected = preference === 'browse' || preference === 'custom' ? preference : items.includes(guide) ? 'custom' : 'browse'
        expect(sidebar.currentMode).toBe(expected)
        expect(sidebar.fetchBrowseItems).toHaveBeenCalledTimes(expected === 'browse' ? 1 : 0)
        expect(localStorage.setItem).not.toHaveBeenCalled()
      })
    }
    it(`switches in both directions and remembers the choice with a ${label} menu`, () => {
      const localStorage = storage('custom')
      const sidebar = mountSidebar({ items, localStorage })
      sidebar.switchMode('browse')
      expect(sidebar.currentMode).toBe('browse')
      expect(sidebar.fetchBrowseItems).toHaveBeenCalledTimes(1)
      expect(mountSidebar({ items, localStorage }).currentMode).toBe('browse')
      sidebar.loadedCache = [0]
      sidebar.switchMode('custom')
      expect(sidebar.currentMode).toBe('custom')
      expect(mountSidebar({ items, localStorage }).currentMode).toBe('custom')
      sidebar.switchMode('browse')
      expect(sidebar.fetchBrowseItems).toHaveBeenCalledTimes(1)
    })
  }

  for (const [navMode, expected] of [
    ['STATIC', 'custom'],
    ['TREE', 'browse']
  ]) {
    it(`${navMode} uses its configured view regardless of the saved preference`, () => {
      const localStorage = storage(expected === 'custom' ? 'browse' : 'custom')
      const sidebar = mountSidebar({ navMode, localStorage })
      expect(sidebar.currentMode).toBe(expected)
      expect(localStorage.getItem).not.toHaveBeenCalled()
      expect(sidebar.fetchBrowseItems).toHaveBeenCalledTimes(expected === 'browse' ? 1 : 0)
    })
  }

  it('rechecks connectivity when opening Browse even when its tree was loaded earlier', async () => {
    const originalFetch = browserWindow.fetch
    const onlineDescriptor = Object.getOwnPropertyDescriptor(navigator, 'onLine')
    const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    let releaseHealth
    const pendingHealth = new Promise(resolve => { releaseHealth = resolve })
    const health = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockImplementation(() => pendingHealth)
    browserWindow.fetch = health
    // Capture only this import's registrations; later Vue/Vuetify listeners
    // and pre-existing PWA owners must remain outside this teardown.
    const listeners = []
    const registrationSpies = []
    const capturedTargets = new Set()
    const captureListeners = target => {
      if (capturedTargets.has(target)) return
      capturedTargets.add(target)
      const addEventListener = target.addEventListener
      registrationSpies.push(vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
        listeners.push({ target, type, listener, options })
        return addEventListener.call(target, type, listener, options)
      }))
    }
    const originalMatchMedia = browserWindow.matchMedia
    captureListeners(browserWindow)
    const matchMediaSpy = vi.spyOn(browserWindow, 'matchMedia').mockImplementation(query => {
      const media = originalMatchMedia.call(browserWindow, query)
      if (media.addEventListener) captureListeners(media)
      return media
    })
    cleanups.push(() => {
      // Run only this owner's suspension/channel-close path, never dispatch
      // pagehide on the shared window and suspend unrelated owners.
      for (const { target, type, listener } of listeners) {
        if (target === browserWindow && type === 'pagehide') {
          listener.call(target, new browserWindow.Event('pagehide'))
        }
      }
      for (const { target, type, listener, options } of listeners) {
        target.removeEventListener(type, listener, options)
      }
      releaseHealth(new Response('{}', { status: 503 }))
      browserWindow.fetch = originalFetch
      if (onlineDescriptor) Object.defineProperty(navigator, 'onLine', onlineDescriptor)
      else Reflect.deleteProperty(navigator, 'onLine')
      if (visibilityDescriptor) Object.defineProperty(document, 'visibilityState', visibilityDescriptor)
      else Reflect.deleteProperty(document, 'visibilityState')
    })
    let pwa
    try {
      pwa = await vi.importFresh('../../../helpers/pwa.ts?sidebar-cache-probe', import.meta.url)
    } finally {
      matchMediaSpy.mockRestore()
      for (const spy of registrationSpies.reverse()) spy.mockRestore()
    }
    await pwa.retryServerConnection()
    const directory = vi.fn(async () => treeResponse([]))
    const { sidebar, host } = renderMountedSidebar({
      items: [guide], localStorage: storage('custom'), connection: pwa.pwaState, transport: directory,
      checkConnection: pwa.retryServerConnection, observeConnection: pwa.observeBrowserConnection,
      reportConnectionFailure: pwa.reportServerConnectionFailure
    })
    sidebar.loadedCache = [0]
    sidebar.currentItems = [treeRow(20, 0, 'Previously loaded guide')]
    sidebar.switchMode('browse')
    await Vue.nextTick()
    expect(health).toHaveBeenCalledTimes(2)
    expect(health.mock.calls[1][0]).toBe('/healthz')
    expect(pwa.pwaState.connectionState).toBe('online')
    expect(host.querySelector('.nav-sidebar-modes')).not.toBeNull()
    expect(host.textContent).toContain('Previously loaded guide')
    sidebar.switchMode('browse')
    expect(health).toHaveBeenCalledTimes(2)
    expect(directory).not.toHaveBeenCalled()
    releaseHealth(new Response('{}', { status: 503 }))
    await vi.waitFor(() => expect(pwa.pwaState.connectionState).toBe('server-unavailable'))
    await Vue.nextTick()
    expect(host.querySelector('a[href="/en/saved-guide"]')).not.toBeNull()
    expect(host.querySelector('.nav-sidebar-modes')).toBeNull()
    expect(directory).not.toHaveBeenCalled()
  })

  it('loads the current page directory when expanding parents is enabled', async () => {
    useCurrentPage()
    const transport = vi.fn(async () => treeResponse(currentDirectoryFixture))
    const { sidebar } = mountSidebar({
      expandParentByDefault: true, items: [guide], localStorage: storage('custom'), transport, realDirectory: true
    })
    sidebar.switchMode('browse')
    await vi.waitFor(() => expect(sidebar.currentItems.map(item => item.id)).toEqual([20, 21]))
    expect(sidebar.currentParent).toMatchObject({ id: 10, title: 'Guides' })
    expect(sidebar.parents.map(item => item.id)).toEqual([0, 10])
    expect(transport).toHaveBeenCalledTimes(1)
    const request = new URL(transport.mock.calls[0][0], browserWindow.location.href)
    expect(Object.fromEntries(request.searchParams)).toEqual({
      path: 'guides/current', locale: 'fr', mode: 'ALL', includeAncestors: 'true', visibility: 'private'
    })
    expect(request.searchParams.has('parent')).toBe(false)
  })

  it('keeps both views usable when storage reads and writes fail', () => {
    const unavailable = () => {
      throw new Error('Storage unavailable')
    }
    const sidebar = mountSidebar({ localStorage: { getItem: unavailable, setItem: unavailable } })
    expect(sidebar.currentMode).toBe('browse')
    sidebar.loadedCache = [0]
    sidebar.switchMode('browse')
    expect(sidebar.currentMode).toBe('browse')
    expect(sidebar.fetchBrowseItems).toHaveBeenCalledTimes(1)
    sidebar.switchMode('custom')
    expect(sidebar.currentMode).toBe('custom')
  })

  it('leaves exactly one control selected and does not deselect when selecting the active mode', async () => {
    for (const items of [[], [home], [home, guide]]) {
      const { host } = renderMountedSidebar({ items, localStorage: storage('custom') })
      await Vue.nextTick()
      const mainMenu = [...host.querySelectorAll('button')].find(button => button.textContent.trim() === 'Main Menu')
      const browse = [...host.querySelectorAll('button')].find(button => button.textContent.trim() === 'Browse')
      expect(mainMenu).toBeDefined()
      expect(browse).toBeDefined()
      const selected = (main, tree) => {
        expect(mainMenu.getAttribute('aria-pressed')).toBe(main)
        expect(browse.getAttribute('aria-pressed')).toBe(tree)
      }
      selected('true', 'false')
      mainMenu.click()
      await Vue.nextTick()
      selected('true', 'false')
      browse.click()
      await vi.waitFor(() => expect(host.querySelector('[aria-busy="true"]')).toBeNull())
      await Vue.nextTick()
      selected('false', 'true')
      browse.click()
      await Vue.nextTick()
      selected('false', 'true')
      mainMenu.click()
      await Vue.nextTick()
      selected('true', 'false')
    }
  })
})


describe('offline navigation continuity', () => {
  it('does not attempt directory requests when the connection is known to be unavailable', async () => {
    useCurrentPage()
    const transport = vi.fn(async () => treeResponse(currentDirectoryFixture))
    const { sidebar } = mountSidebar({ connectionState: 'offline', transport, realDirectory: true })
    const visible = [treeRow(50, 0, 'Previously visible guide')]
    sidebar.currentItems = visible
    for (const method of ['fetchBrowseItems', 'loadFromCurrentPath']) {
      await sidebar[method]()
      expect(transport).not.toHaveBeenCalled()
      expect(sidebar.currentItems).toBe(visible)
      expect(sidebar.navLoading).toBe(false)
      expect(sidebar.navError).toBe('')
    }
  })

  it('cancels obsolete requests on disconnect, preserves visible navigation and reloads after reconnect', async () => {
    useCurrentPage()
    let releaseObsolete
    const obsolete = new Promise(resolve => { releaseObsolete = resolve })
    const freshItems = [treeRow(21, 10, 'Reconnected directory guide')]
    const transport = vi.fn()
      .mockImplementationOnce(() => obsolete)
      .mockResolvedValue(treeResponse(freshItems))
    const { sidebar, component, connection } = mountSidebar({
      localStorage: storage('custom'), transport, realDirectory: true
    })
    sidebar.currentMode = 'browse'
    sidebar.currentParent = currentDirectoryFixture[0]
    const visible = [treeRow(50, 10, 'Previously visible guide')]
    sidebar.currentItems = visible
    const request = sidebar.fetchBrowseItems()
    const controller = sidebar.browseRequestController
    const abort = vi.spyOn(controller, 'abort')
    expect(sidebar.navLoading).toBe(true)
    connection.connectionState = 'offline'
    component.watch.connectionState.call(sidebar, 'offline')
    expect(abort).toHaveBeenCalledTimes(1)
    expect(controller.signal.aborted).toBe(true)
    expect(sidebar.navLoading).toBe(false)
    expect(sidebar.currentItems).toBe(visible)
    expect(transport).toHaveBeenCalledTimes(1)
    releaseObsolete(treeResponse([treeRow(99, 10, 'Obsolete directory result')]))
    await request
    expect(sidebar.currentItems).toBe(visible)
    expect(sidebar.navError).toBe('')
    expect(sidebar.navLoading).toBe(false)
    connection.connectionState = 'checking'
    component.watch.connectionState.call(sidebar, 'checking')
    expect(transport).toHaveBeenCalledTimes(1)
    connection.connectionState = 'online'
    component.watch.connectionState.call(sidebar, 'online')
    await vi.waitFor(() => expect(sidebar.currentItems).toEqual(freshItems))
    expect(transport).toHaveBeenCalledTimes(2)
    expect(new URL(transport.mock.calls[1][0], browserWindow.location.href).searchParams.get('parent')).toBe('10')
    expect(sidebar.navLoading).toBe(false)
    expect(sidebar.navError).toBe('')
    abort.mockRestore()
  })
})


describe('offline-only Browse mode', () => {
  for (const connectionState of ['checking', 'offline', 'server-unavailable']) {
    it(`opens local navigation immediately while ${connectionState} without changing the online preference`, async () => {
      const localStorage = storage('browse')
      const directory = vi.fn(async () => treeResponse([]))
      const { sidebar, host } = renderMountedSidebar({
        localStorage, connection: Vue.reactive({ connectionState, mode: 'feature' }), transport: directory
      })
      await Vue.nextTick()
      expect(sidebar.connectionUnavailable).toBe(true)
      expect(host.querySelector('a[href="/en/saved-guide"]')).not.toBeNull()
      expect(host.querySelector('.nav-sidebar-modes')).toBeNull()
      expect(host.querySelector('.nav-sidebar-list')).toBeNull()
      expect(host.querySelector('.nav-sidebar-loading-status')).toBeNull()
      expect(host.querySelector('[data-async-state="error"]')).toBeNull()
      expect(directory).not.toHaveBeenCalled()
      sidebar.switchMode('custom')
      expect(sidebar.currentMode).toBe('browse')
      expect(localStorage.setItem).not.toHaveBeenCalled()
      expect(localStorage.getItem('navPref')).toBe('browse')
      expect(directory).not.toHaveBeenCalled()
    })
  }
})
