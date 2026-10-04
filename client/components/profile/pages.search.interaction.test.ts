import path from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, beforeEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, resetBody, setLocation } from '../../test/browser-dom.mts'
import { translateEnglish as t } from '../../test/english-translate.mts'
import type { PageListRow } from '../../helpers/pages-api.ts'
import type { wikiStore as WikiStoreInstance } from '../../store/index.ts'

resetBody()
// DOM setup must precede Vue/Vuetify platform capture; the SFC import below
// intentionally follows registration of its module-loading test boundary.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
// Static store import would initialize against window.siteConfig before the fixture exists.
const importConfig = Object.getOwnPropertyDescriptor(browserWindow, 'siteConfig')
Object.defineProperty(browserWindow, 'siteConfig', { configurable: true, value: {
  company: '', contentLicense: '', footerOverride: '', banner: {}, darkMode: false,
  tocPosition: 'left', title: 'Directory verification', logoUrl: '', product: { name: 'tsEpistle', version: 'test' }
} })
let wikiStore: typeof WikiStoreInstance
try {
  ;({ wikiStore } = await import('../../store/index.ts'))
} finally {
  if (importConfig) Object.defineProperty(browserWindow, 'siteConfig', importConfig)
  else Reflect.deleteProperty(browserWindow, 'siteConfig')
}

// Compile whole modules, not extracted methods. Native Vuetify inputs, buttons,
// empty/error states and the production HTTP normalizer remain in the path.
Bun.plugin({
  name: 'profile-page-directory-consumer',
  setup(builder) {
    builder.onResolve({ filter: /^@\// }, ({ path: filename }) => ({ path: path.join(process.cwd(), 'client', filename.slice(2)) }))
    builder.onLoad({ filter: /\/(pages|async-state)\.vue$/ }, async ({ path: filename }) => {
      const parsed = parse(await Bun.file(filename).text(), { filename })
      if (parsed.errors.length) throw parsed.errors[0]
      const id = `profile-directory-${path.basename(filename, '.vue')}`
      const script = compileScript(parsed.descriptor, { id, genDefaultAs: '__component', inlineTemplate: true })
      let template = ''
      if (!parsed.descriptor.scriptSetup) {
        const result = compileTemplate({ source: parsed.descriptor.template!.content, filename, id,
          preprocessLang: parsed.descriptor.template!.lang, preprocessOptions: { doctype: 'html' } })
        if (result.errors.length) throw result.errors[0]
        template = `${result.code}\n__component.render = render;`
      }
      return { loader: 'ts', contents: `${script.content}\n${template}\nexport default __component;` }
    })
  }
})
const Directory = (await import('./pages.vue')).default
const cleanups: Array<() => void> = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetBody()
})
const settle = async () => {
  for (let turn = 0; turn < 8; turn++) { await Promise.resolve(); await Vue.nextTick() }
  await vi.advanceTimersByTimeAsync(0)
  await Vue.nextTick()
}
const until = async (ready: () => boolean) => {
  for (let turn = 0; turn < 100; turn++) {
    await settle()
    if (ready()) return
    await vi.advanceTimersByTimeAsync(300)
  }
  throw new Error('Profile directory consumer did not settle')
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const batch = (items: PageListRow[], nextOffset: number | null = null, scanned = items.length) => response({ items, nextOffset, scanned })
const row = (id: number, overrides: Partial<PageListRow> = {}): PageListRow => ({
  id, title: `Record ${id}`, path: `records/${id}`, locale: 'en', description: null, tags: [],
  visibility: 'public', ownerId: null, contentType: 'markdown',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', ...overrides
})
const deferred = () => Promise.withResolvers<Response>()
const button = (root: ParentNode, key: string): HTMLButtonElement => {
  const control = [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === t(key))
  if (!control) throw new Error(`Missing profile action: ${key}`)
  return control
}
const click = async (root: ParentNode, key: string) => { button(root, key).click(); await settle() }
const links = (host: HTMLElement) => [...host.querySelectorAll('.profile-page-link')].map(link => link.getAttribute('href'))
const loadingKeys = () => Object.keys(wikiStore.loadingCounts).filter(key => key.startsWith('profile-pages-refresh'))
const mount = async (transport: typeof browserWindow.fetch, accountId = 7) => {
  setLocation('/p/pages')
  const saved = { user: wikiStore.user, loadingCounts: { ...wikiStore.loadingCounts }, notification: { ...wikiStore.notification } }
  wikiStore.user = { ...wikiStore.user, id: accountId }
  cleanups.push(() => { wikiStore.user = saved.user; wikiStore.loadingCounts = saved.loadingCounts; wikiStore.notification = saved.notification })
  const fetch = vi.spyOn(browserWindow, 'fetch').mockImplementation(transport)
  const notify = vi.spyOn(wikiStore, 'showNotification')
  const host = document.createElement('div'); document.body.append(host)
  const app = Vue.createApp(Directory)
  app.config.globalProperties.$t = t
  app.config.globalProperties.$helpers = { formatMoment: (date: string) => date }
  app.use(createVuetify({ components, directives }))
  app.component('admin-hero', Vue.defineComponent({ setup: (_props, { slots }) => () => Vue.h('header', slots.actions?.()) }))
  const vm = app.mount(host)
  let mounted = true
  const unmount = () => { if (mounted) { app.unmount(); host.remove(); mounted = false } }
  cleanups.push(unmount)
  await settle()
  return { host, vm, fetch, notify, unmount }
}
const search = async (host: HTMLElement, value: string) => {
  const input = host.querySelector<HTMLInputElement>('.profile-pages-search input')!
  input.value = value; input.dispatchEvent(new browserWindow.Event('input', { bubbles: true })); await settle()
  host.querySelector('form')!.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
  await settle()
}

describe('mounted My Pages directory', () => {
  test('waits for authenticated identity and discards contributions from superseded accounts', async () => {
    const former = deferred(), current = deferred()
    const { host, fetch } = await mount(async url => {
      const accountId = Number(new URL(String(url), browserWindow.location.href).searchParams.get('creatorId'))
      if (accountId === 7) return former.promise
      if (accountId === 8) return current.promise
      return response({ error: 'Invalid contribution owner' }, 400)
    }, 0)
    expect(fetch).not.toHaveBeenCalled()
    expect(links(host)).toEqual([])
    expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('true')
    wikiStore.user.id = 7
    await settle()
    expect(loadingKeys().length).toBeGreaterThan(0)
    wikiStore.user.id = 8
    await settle()
    current.resolve(batch([row(8)]))
    await settle()
    expect(links(host)).toEqual(['/en/records/8'])
    former.resolve(batch([row(7, { visibility: 'private', ownerId: 7 })]))
    await settle()
    expect(links(host)).toEqual(['/en/records/8'])
    expect(loadingKeys()).toEqual([])
    wikiStore.user.id = 0
    await settle()
    expect(links(host)).toEqual([])
    expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('true')
    expect(loadingKeys()).toEqual([])
  })
  test('includes created OR edited contributions, composes private filtering with server search and preserves public/private link identity', async () => {
    // Independent contribution records: creator-only, editor-only, both and
    // unrelated. This HTTP fixture enforces the documented OR contract; it does
    // not echo requested values into the response or assert forwarding syntax.
    const contributions = [
      { page: row(1, { title: 'Created roadmap' }), creator: 7, editor: 90 },
      { page: row(2, { title: 'Edited roadmap', visibility: 'private', ownerId: 7, locale: 'fr', path: 'plans/edited' }), creator: 90, editor: 7 },
      { page: row(3, { title: 'Private archive', visibility: 'private', ownerId: 7 }), creator: 7, editor: 7 },
      { page: row(4, { title: 'Unrelated roadmap' }), creator: 90, editor: 90 }
    ]
    const { host } = await mount(async url => {
      const params = new URL(String(url), browserWindow.location.href).searchParams
      const creator = Number(params.get('creatorId')), editor = Number(params.get('authorId'))
      const visible = contributions.filter(item => item.creator === creator || item.editor === editor)
        .filter(item => params.get('visibility') !== 'private' || item.page.visibility === 'private')
        .filter(item => !params.get('search') || item.page.title!.toLowerCase().includes(params.get('search')!.toLowerCase()))
      return batch(visible.map(item => item.page))
    })
    expect(links(host)).toEqual(['/en/records/1', '/_private/fr/plans/edited', '/_private/en/records/3'])
    await click(host, 'profile:pages.privateOnly')
    await until(() => links(host).length === 2)
    expect(links(host)).toEqual(['/_private/fr/plans/edited', '/_private/en/records/3'])
    await search(host, 'ROADMAP')
    expect(links(host)).toEqual(['/_private/fr/plans/edited'])
    expect(button(host, 'profile:pages.privateOnly').getAttribute('aria-pressed')).toBe('true')
    await click(host, 'profile:pages.privateOnly')
    await until(() => links(host).length === 2)
    expect(links(host)).toEqual(['/en/records/1', '/_private/fr/plans/edited'])
    await search(host, '')
    expect(links(host)).toHaveLength(3)
  })

  test('continues a zero-readable batch, returns to its previous window and searches from the first window', async () => {
    const { host } = await mount(async url => {
      const params = new URL(String(url), browserWindow.location.href).searchParams
      if (params.get('search')) return params.get('offset') === '0' ? batch([row(9)]) : response({ error: 'Search must start in the first window' }, 400)
      return params.get('offset') === '1000' ? batch([row(50)], 1001, 1) : batch([], 1000, 1000)
    })
    expect(links(host)).toEqual([])
    expect(button(host, 'common:actions.previous').disabled).toBe(true)
    expect(button(host, 'common:actions.next').disabled).toBe(false)
    await click(host, 'common:actions.next')
    expect(links(host)).toEqual(['/en/records/50'])
    await click(host, 'common:actions.previous')
    expect(links(host)).toEqual([])
    expect(button(host, 'common:actions.next').disabled).toBe(false)
    await click(host, 'common:actions.next')
    await search(host, 'outside the loaded window')
    expect(links(host)).toEqual(['/en/records/9'])
    expect(button(host, 'common:actions.previous').disabled).toBe(true)
    expect(button(host, 'common:actions.next').disabled).toBe(true)
  })

  test('keeps previous link identity but disables window navigation as soon as filters become stale', async () => {
    const pending = deferred()
    const { host, fetch } = await mount(vi.fn().mockResolvedValueOnce(batch([row(1, { visibility: 'private', ownerId: 7 })], 25, 25)).mockImplementation(() => pending.promise))
    await click(host, 'profile:pages.privateOnly')
    expect(links(host)).toEqual(['/_private/en/records/1'])
    expect(button(host, 'common:actions.next').disabled).toBe(true)
    await until(() => fetch.mock.calls.length === 2)
    pending.resolve(response({ error: 'Private directory unavailable' }, 503)); await settle()
    expect(host.textContent).toContain('Private directory unavailable')
    expect(links(host)).toEqual(['/_private/en/records/1'])
    expect(button(host, 'common:actions.next').disabled).toBe(true)
    expect(loadingKeys()).toEqual([])
  })

  test('keeps newest results and current loading while superseded requests resolve or fail', async () => {
    const oldest = deferred(), middle = deferred(), newest = deferred()
    const { host, vm, notify } = await mount(vi.fn().mockImplementationOnce(() => oldest.promise).mockImplementationOnce(() => middle.promise).mockImplementationOnce(() => newest.promise))
    const middleLoad = vm.loadPages(), newestLoad = vm.loadPages()
    middle.reject(new Error('Superseded failure'))
    expect(await middleLoad).toBe(false); await settle()
    expect(vm.loading).toBe(true)
    expect(loadingKeys().length).toBeGreaterThan(0)
    expect(host.textContent).not.toContain('Superseded failure')
    newest.resolve(batch([row(3)]))
    expect(await newestLoad).toBe(true); await settle()
    oldest.resolve(batch([row(1)])); await settle()
    expect(links(host)).toEqual(['/en/records/3'])
    expect(vm.loading).toBe(false)
    expect(loadingKeys()).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })

  test('surfaces current refresh failures and retains links until successful retry', async () => {
    const { host } = await mount(vi.fn().mockResolvedValueOnce(batch([row(1)]))
      .mockResolvedValueOnce(response({ error: 'Page access denied' }, 403)).mockResolvedValueOnce(batch([row(2)])))
    await click(host, 'profile:pages.reloadShort')
    expect(host.textContent).toContain('Page access denied')
    expect(links(host)).toEqual(['/en/records/1'])
    expect(loadingKeys()).toEqual([])
    await click(host, 'profile:pages.reloadShort')
    expect(links(host)).toEqual(['/en/records/2'])
    expect(host.textContent).not.toContain('Page access denied')
    expect(loadingKeys()).toEqual([])
  })

  test('does not publish a pending refresh after unmount and releases actual loading state', async () => {
    const pending = deferred()
    const { vm, unmount, notify } = await mount(vi.fn().mockResolvedValueOnce(batch([row(1)])).mockImplementationOnce(() => pending.promise))
    const refresh = vm.refresh()
    unmount()
    pending.resolve(batch([row(2)])); await refresh; await settle()
    expect(vm.pages.map((page: PageListRow) => page.id)).toEqual([1])
    expect(loadingKeys()).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })
})
