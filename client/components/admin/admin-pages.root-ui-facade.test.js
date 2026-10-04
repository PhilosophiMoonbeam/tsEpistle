import path from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, beforeEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody, setLocation } from '../../test/browser-dom.mts'
import { translateEnglish as t } from '../../test/english-translate.mts'

resetBody()
// Platform modules must capture the prepared DOM; the SFC import intentionally
// follows registration of the module-loading test boundary.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
const { createRouter, createMemoryHistory } = await import('vue-router')
// Static store import would initialize against window.siteConfig before the fixture exists.
const importConfig = Object.getOwnPropertyDescriptor(browserWindow, 'siteConfig')
Object.defineProperty(browserWindow, 'siteConfig', { configurable: true, value: {
  company: '', contentLicense: '', footerOverride: '', banner: {}, darkMode: false,
  tocPosition: 'left', title: 'Directory verification', logoUrl: '', product: { name: 'tsEpistle', version: 'test' }
} })
let wikiStore
try {
  ;({ wikiStore } = await import('../../store/index.ts'))
} finally {
  if (importConfig) Object.defineProperty(browserWindow, 'siteConfig', importConfig)
  else Reflect.deleteProperty(browserWindow, 'siteConfig')
}

// Load complete SFC modules, including the publication review and real HTTP
// normalizer. Only styles and unrelated shell chrome are omitted.
Bun.plugin({
  name: 'admin-page-directory-consumer',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, ({ path: filename }) => ({ path: path.join(process.cwd(), 'client', filename.slice(2)) }))
    builder.onLoad({ filter: /\/(admin-pages|admin-pages-publication|async-state|status-indicator)\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const id = `directory-${path.basename(filename, '.vue')}`
      const script = compileScript(parsed.descriptor, { id, genDefaultAs: '__component', inlineTemplate: true })
      let template = ''
      if (!parsed.descriptor.scriptSetup) {
        const result = compileTemplate({ source: parsed.descriptor.template.content, filename, id })
        if (result.errors.length) throw result.errors[0]
        template = `${result.code}\n__component.render = render;`
      }
      return { loader: 'ts', contents: `${script.content}\n${template}\nexport default __component;` }
    })
  }
})
const Directory = (await import('./admin-pages.vue')).default
const cleanups = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetBody()
})
const settle = async () => {
  for (let turn = 0; turn < 8; turn++) { await Promise.resolve(); await Vue.nextTick() }
  await vi.advanceTimersByTimeAsync(0)
  await Vue.nextTick()
}
const until = async ready => {
  for (let turn = 0; turn < 100; turn++) {
    await settle()
    if (ready()) return
    await vi.advanceTimersByTimeAsync(300)
  }
  throw new Error('Directory consumer did not settle')
}
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const batch = (items, nextOffset = null, scanned = items.length) => response({ items, nextOffset, scanned })
const row = (id, overrides = {}) => ({
  id, title: `Record ${id}`, path: `records/${id}`, locale: 'en', description: null, tags: [], isPublished: true,
  visibility: 'public', ownerId: null, contentType: 'markdown',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', ...overrides
})
const deferred = () => Promise.withResolvers()
const button = (root, key) => {
  const control = [...root.querySelectorAll('button')].find(item => item.textContent.trim() === t(key))
  if (!control) throw new Error(`Missing directory action: ${key}`)
  return control
}
const click = async (root, key) => { button(root, key).click(); await settle() }
const links = host => [...host.querySelectorAll('.admin-record-link')].map(link => link.getAttribute('href'))
const loadingKeys = () => Object.keys(wikiStore.loadingCounts).filter(key => key.startsWith('admin-pages-refresh'))
const mount = async (transport, query = {}) => {
  setLocation('/a/pages')
  vi.stubGlobal('siteLangs', [{ code: 'en' }, { code: 'fr' }])
  const saved = { user: wikiStore.user, loadingCounts: { ...wikiStore.loadingCounts }, notification: { ...wikiStore.notification } }
  wikiStore.user = { ...wikiStore.user, id: 7, permissions: [] }
  cleanups.push(() => { wikiStore.user = saved.user; wikiStore.loadingCounts = saved.loadingCounts; wikiStore.notification = saved.notification })
  const fetch = vi.spyOn(browserWindow, 'fetch').mockImplementation(transport)
  const notify = vi.spyOn(wikiStore, 'showNotification')
  const errors = vi.spyOn(wikiStore, 'showError')
  const router = createRouter({ history: createMemoryHistory('/a'), routes: [{ path: '/pages/:id?', component: { render: () => null } }] })
  await router.push({ path: '/pages', query }); await router.isReady()
  const host = document.createElement('div'); document.body.append(host)
  const app = Vue.createApp(Directory)
  app.config.globalProperties.$t = t
  app.use(router)
  app.use(createVuetify({ components, directives, defaults: { VDialog: { transition: false } } }))
  app.component('admin-hero', Vue.defineComponent({ setup: (_props, { slots }) => () => Vue.h('header', slots.actions?.()) }))
  const vm = app.mount(host)
  let mounted = true
  const unmount = () => { if (mounted) { app.unmount(); host.remove(); mounted = false } }
  cleanups.push(unmount)
  await settle()
  return { host, vm, router, fetch, notify, errors, unmount }
}
const enterSearch = async (host, value) => {
  const input = host.querySelector('.pages-search input:not([role="combobox"])')
  input.value = value; input.dispatchEvent(new browserWindow.Event('input', { bubbles: true })); await settle()
}

describe('mounted administrative page directory', () => {
  test('renders administration identity and retains selected snapshots across windows and filter changes for review', async () => {
    const selected = row(7, { title: 'Original selected title', tags: ['review'] })
    const { host } = await mount(async url => {
      const parsed = new URL(url, browserWindow.location.href)
      if (parsed.pathname === '/_api/pages/7') return response({ error: 'Snapshot unavailable' }, 503)
      if (parsed.searchParams.get('search')) return batch([row(9)])
      if (parsed.searchParams.get('offset') === '25') return batch([row(8)])
      return batch([selected], 25, 25)
    })
    expect(links(host)).toEqual(['/a/pages/7'])
    host.querySelector('.pages-record input').click(); await settle()
    await click(host, 'admin:groups.next')
    expect(links(host)).toEqual(['/a/pages/8'])
    await enterSearch(host, 'another corpus window')
    await until(() => links(host).includes('/a/pages/9'))
    expect(links(host)).toEqual(['/a/pages/9'])
    expect(host.querySelector('.pages-selection')).not.toBeNull()
    await click(host, 'admin:pages.reviewPublication')
    expect([...document.querySelectorAll('.publication-review-list article strong')].map(node => node.textContent)).toEqual(['Original selected title'])
    expect(document.querySelector('[role="dialog"]').textContent).toContain('Snapshot unavailable')
  })

  test('caps cross-window selection at 25 while selected rows remain deselectable', async () => {
    const { host } = await mount(async url => new URL(url, browserWindow.location.href).searchParams.get('offset') === '25'
      ? batch([row(25), row(26)]) : batch(Array.from({ length: 24 }, (_, index) => row(index + 1)), 25, 25))
    await click(host, 'admin:pages.selectPage')
    expect([...host.querySelectorAll('.pages-record input')].filter(input => input.checked)).toHaveLength(24)
    await click(host, 'admin:groups.next')
    const [selected, unselected] = host.querySelectorAll('.pages-record input')
    expect(selected.checked).toBe(false)
    expect(unselected.disabled).toBe(false)
    selected.click(); await settle()
    expect(selected.checked).toBe(true)
    expect(selected.disabled).toBe(false)
    expect(unselected.disabled).toBe(true)
    unselected.click(); await settle()
    expect(unselected.checked).toBe(false)
    selected.click(); await settle()
    expect(unselected.disabled).toBe(false)
    unselected.click(); await settle()
    expect(unselected.checked).toBe(true)
  })

  test('restores creator/editor OR filters with private visibility and changes the native quick view without local filtering', async () => {
    const candidates = [
      { page: row(31, { visibility: 'private', ownerId: 7 }), creator: 7, editor: 90 },
      { page: row(32, { visibility: 'private', ownerId: 7 }), creator: 90, editor: 8 },
      { page: row(33), creator: 7, editor: 8 },
      { page: row(34, { visibility: 'private', ownerId: 7 }), creator: 90, editor: 90 }
    ]
    const { host } = await mount(async url => {
      const params = new URL(url, browserWindow.location.href).searchParams
      const creator = params.get('creatorId'), editor = params.get('authorId')
      const matching = candidates
        .filter(item => (!creator && !editor) || item.creator === Number(creator) || item.editor === Number(editor))
        .filter(item => params.get('visibility') !== 'private' || item.page.visibility === 'private')
      return batch(matching.map(item => item.page))
    }, { creatorId: '7', authorId: '8', visibility: 'private' })
    expect(links(host)).toEqual(['/a/pages/31', '/a/pages/32'])
    await click(host, 'admin:pages.privatePages')
    await until(() => links(host).length === 3)
    expect(links(host)).toEqual(['/a/pages/31', '/a/pages/32', '/a/pages/34'])
  })

  test('makes previous rows unselectable immediately during filter debounce and after a current error', async () => {
    const pending = deferred()
    const { host, fetch } = await mount(vi.fn().mockResolvedValueOnce(batch([row(1)])).mockImplementation(() => pending.promise))
    await enterSearch(host, 'different')
    expect(host.querySelector('.pages-record input').disabled).toBe(true)
    expect(button(host, 'admin:pages.selectPage').disabled).toBe(true)
    host.querySelector('.pages-record input').click(); await settle()
    expect(host.querySelector('.pages-selection')).toBeNull()
    expect(button(host, 'admin:shell.reload').disabled).toBe(true)
    await until(() => fetch.mock.calls.length === 2)
    pending.resolve(response({ error: 'Directory unavailable' }, 503)); await settle()
    expect(host.textContent).toContain('Directory unavailable')
    expect(host.querySelector('.pages-record input').disabled).toBe(true)
    expect(loadingKeys()).toEqual([])
  })

  test('keeps the newest request, balances real store loading, and ignores superseded failures', async () => {
    const oldest = deferred(), middle = deferred(), newest = deferred()
    const { host, vm, errors } = await mount(vi.fn().mockImplementationOnce(() => oldest.promise).mockImplementationOnce(() => middle.promise).mockImplementationOnce(() => newest.promise))
    const middleLoad = vm.loadPages(), newestLoad = vm.loadPages()
    middle.reject(new Error('Superseded transport failure'))
    expect(await middleLoad).toBe(false); await settle()
    expect(vm.loading).toBe(true)
    expect(loadingKeys().length).toBeGreaterThan(0)
    expect(errors).not.toHaveBeenCalled()
    newest.resolve(batch([row(3)]))
    expect(await newestLoad).toBe(true); await settle()
    expect(links(host)).toEqual(['/a/pages/3'])
    oldest.resolve(batch([row(1)])); await settle()
    expect(links(host)).toEqual(['/a/pages/3'])
    expect(vm.loading).toBe(false)
    expect(loadingKeys()).toEqual([])
    expect(host.textContent).not.toContain('Superseded transport failure')
  })

  test('preserves selected rows on current refresh errors and visibly recovers on retry', async () => {
    const { host } = await mount(vi.fn().mockResolvedValueOnce(batch([row(1)]))
      .mockResolvedValueOnce(response({ error: 'Page access denied' }, 403)).mockResolvedValueOnce(batch([row(2)])))
    host.querySelector('.pages-record input').click(); await settle()
    await click(host, 'admin:shell.reload')
    expect(host.textContent).toContain('Page access denied')
    expect(host.querySelector('.pages-selection')).not.toBeNull()
    expect(loadingKeys()).toEqual([])
    await click(host, 'admin:shell.reload')
    expect(links(host)).toEqual(['/a/pages/2'])
    expect(host.textContent).not.toContain('Page access denied')
    expect(host.querySelector('.pages-selection')).not.toBeNull()
    expect(loadingKeys()).toEqual([])
  })

  test('advances and returns through a zero-visible window without inferring exhaustion', async () => {
    const { host } = await mount(async url => new URL(url, browserWindow.location.href).searchParams.get('offset') === '1000'
      ? batch([row(50)]) : batch([], 1000, 1000))
    expect(links(host)).toEqual([])
    expect(button(host, 'admin:groups.next').disabled).toBe(false)
    expect(button(host, 'admin:groups.previous').disabled).toBe(true)
    await click(host, 'admin:groups.next')
    expect(links(host)).toEqual(['/a/pages/50'])
    expect(button(host, 'admin:groups.next').disabled).toBe(true)
    await click(host, 'admin:groups.previous')
    expect(links(host)).toEqual([])
    expect(button(host, 'admin:groups.next').disabled).toBe(false)
  })

  test('invalidates a pending request on actual unmount and releases its loading entry', async () => {
    const pending = deferred()
    const { unmount, vm, errors, notify } = await mount(() => pending.promise)
    unmount()
    pending.resolve(batch([row(99)])); await settle()
    expect(vm.pages).toEqual([])
    expect(loadingKeys()).toEqual([])
    expect(errors).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})
