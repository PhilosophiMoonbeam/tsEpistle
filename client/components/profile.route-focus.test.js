import fs from 'node:fs'
import path from 'node:path'

import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow, document, resetBody, setLocation } from '../test/browser-dom.mts'
import { focusRouteHeading } from './common/route-heading-focus.ts'

const filename = path.join(process.cwd(), 'client/components/profile.vue')
const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
if (errors.length || !descriptor.template || !descriptor.script) throw new Error(`Cannot parse profile.vue: ${errors}`)

resetBody()
setLocation('/p/profile')

const Vue = await import('vue')
const { createMemoryHistory, createRouter } = await import('vue-router')
const compiled = compileTemplate({
  filename,
  id: 'profile-route-focus-test',
  source: descriptor.template.content,
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length) throw new Error(`Cannot compile profile.vue: ${compiled.errors}`)
const render = new Function('Vue', compiled.code)(Vue)
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(descriptor.script.content.replace(/^import .*$/gm, '').replace('export default', 'return'))
const evaluate = new Function('defineComponent', 'ref', 'watch', 'useDisplay', 'wikiStore', 'ConfirmDialogHost', 'focusRouteHeading', script)
// Marks where the shell mounts the shared confirm dialog host.
const ConfirmDialogHost = Vue.defineComponent({ setup: () => () => Vue.h('div', { 'data-confirm-host': '' }) })

const passthrough = (tag = 'div') =>
  Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, slots.default?.())
    }
  })

// Each route is its own view, as in the app, so the out-in transition replaces the
// outgoing heading before focus moves; the old heading cannot satisfy the assertion.
const routePage = heading =>
  Vue.defineComponent({
    name: `RoutePage${heading ?? 'Loading'}`,
    setup() {
      return () => Vue.h('section', [
        heading ? Vue.h('h1', heading) : Vue.h('p', 'Loading account settings'),
        Vue.h('input', { 'aria-label': 'Incoming field' })
      ])
    }
  })

const offlinePage = Vue.defineComponent({
  setup: () => () => Vue.h('section', [
    Vue.h('h1', 'Offline access'),
    Vue.h('h2', { id: 'downloaded-pages-title' }, 'Saved pages'),
    Vue.h('input', { 'aria-label': 'Incoming field' }),
    Vue.h('details', [
      Vue.h('summary', 'Storage details'),
      Vue.h('h2', { id: 'storage-details' }, 'Storage location')
    ])
  ])
})

let app
afterEach(() => {
  app?.unmount()
  app = undefined
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

// The out-in route transition finishes on animation frames, so wait past them.
const settle = async () => {
  for (let turn = 0; turn < 6; turn += 1) {
    await Vue.nextTick()
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
// Keep the compiled shell's actual built-in Transition and slot ownership.
// Only the enter clock is controlled; Vue still owns entry and after-enter.
const heldEntry = () => {
  let entered
  let fail
  const ready = new Promise((resolve, reject) => { entered = resolve; fail = reject })
  // Errors can occur during mount, before the test awaits the entry hook.
  void ready.catch(() => {})
  const controlEntry = create => (type, props, ...children) => create(type,
    type === Vue.Transition
      ? { ...props, onEnter: (element, done) => entered({ element, finish: done }) }
      : props,
    ...children
  )
  return {
    ready,
    fail,
    runtime: {
      ...Vue,
      createBlock: controlEntry(Vue.createBlock),
      createVNode: controlEntry(Vue.createVNode)
    }
  }
}

const mountProfile = async (initialPath = '/profile', { entry, extraRoutes = [] } = {}) => {
  const wikiStore = { page: { mode: 'view' } }
  const options = evaluate(Vue.defineComponent, Vue.ref, Vue.watch, () => ({ mdAndUp: Vue.ref(true) }), wikiStore, ConfirmDialogHost, focusRouteHeading)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/profile', component: routePage('Your profile') },
      { path: '/pages', component: routePage('Your pages') },
      { path: '/loading', component: routePage(null) },
      { path: '/offline', component: () => Promise.resolve(offlinePage) },
      ...extraRoutes
    ]
  })
  const profileRender = entry ? new Function('Vue', compiled.code)(entry.runtime) : render
  app = Vue.createApp({ ...options, render: profileRender })
  for (const name of [
    'v-app',
    'nav-header',
    'v-navigation-drawer',
    'v-icon',
    'v-spacer',
    'v-list',
    'v-list-subheader',
    'v-list-item',
    'v-list-item-title',
    'nav-footer',
    'notify',
    'search-results'
  ]) {
    app.component(name, passthrough())
  }
  app.component('v-main', passthrough('main'))
  app.component('v-btn', passthrough('button'))
  app.config.globalProperties.$vuetify = { display: { mdAndUp: true, smAndDown: false } }
  app.config.globalProperties.$t = key => key
  const componentErrors = []
  app.config.errorHandler = error => {
    componentErrors.push(error)
    entry?.fail(error)
  }
  app.use(router)
  await router.push(initialPath)
  await router.isReady()
  const host = document.createElement('div')
  document.body.append(host)
  app.mount(host)
  await settle()
  return { host, router, wikiStore, componentErrors }
}

describe('profile route accessibility', () => {
  it('enters profile mode and exposes a programmatically focusable main region', async () => {
    const { host, wikiStore } = await mountProfile()

    expect(wikiStore.page.mode).toBe('profile')
    expect(host.querySelector('main').getAttribute('tabindex')).toBe('-1')
    // The first load leaves focus alone; only in-app navigation moves it.
    expect(document.activeElement).not.toBe(host.querySelector('main h1'))
    expect(host.querySelector('main h1').hasAttribute('tabindex')).toBe(false)
  })

  it('mounts one shared confirm dialog host for the leave guard of its views', async () => {
    const { host } = await mountProfile()

    expect(host.querySelectorAll('[data-confirm-host]')).toHaveLength(1)
  })

  it('names the shell once and offers a way back to the wiki', async () => {
    const { host } = await mountProfile()

    expect(host.textContent.split('profile:workspace')).toHaveLength(2)
    expect(host.querySelector('nav').getAttribute('aria-label')).toBe('profile:nav.label')
    const back = host.querySelector('a[href="/"]')
    expect(back.textContent).toContain('profile:nav.backToWiki')
  })

  it('focuses the incoming route heading after rendering without scrolling', async () => {
    const { host, router } = await mountProfile()
    const previousHeading = host.querySelector('main h1')
    previousHeading.setAttribute('tabindex', '-1')
    previousHeading.focus()
    const focus = vi.spyOn(browserWindow.HTMLElement.prototype, 'focus')

    await router.push('/pages')
    await settle()

    const heading = host.querySelector('main h1')
    expect(heading.textContent).toBe('Your pages')
    expect(heading).not.toBe(previousHeading)
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(heading)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  for (const destination of ['/pages', '/offline#downloaded-pages-title']) {
    it(`preserves input claimed before entry completes for ${destination}`, async () => {
      const entry = heldEntry()
      const { host, router, componentErrors } = await mountProfile('/profile', { entry })
      await router.push(destination)
      const { element, finish } = await entry.ready
      await Vue.nextTick()
      const field = element.querySelector('input')
      field.focus()
      field.value = 'Draft before entry finishes'
      const focus = vi.spyOn(browserWindow.HTMLElement.prototype, 'focus')
      const scroll = vi.spyOn(browserWindow.Element.prototype, 'scrollIntoView')

      finish()
      await Vue.nextTick()

      expect(document.activeElement).toBe(field)
      expect(field.value).toBe('Draft before entry finishes')
      expect(focus).not.toHaveBeenCalled()
      expect(scroll).not.toHaveBeenCalled()
      expect(host.querySelector('main h1').textContent).toBe(destination === '/pages' ? 'Your pages' : 'Offline access')
      expect(componentErrors).toEqual([])
    })
  }

  it('preserves a newly claimed teleported control instead of announcing the background', async () => {
    const entry = heldEntry()
    const { router } = await mountProfile('/profile', { entry })
    await router.push('/pages')
    const { finish } = await entry.ready
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    const focus = vi.spyOn(browserWindow.HTMLElement.prototype, 'focus')

    finish()
    await Vue.nextTick()

    expect(document.activeElement).toBe(field)
    expect(focus).not.toHaveBeenCalled()
  })

  it('resolves and focuses a direct lazy-route fragment instead of its first heading', async () => {
    const scroll = vi.spyOn(browserWindow.Element.prototype, 'scrollIntoView')
    const { host, componentErrors } = await mountProfile('/offline#downloaded-pages-title')
    const target = host.querySelector('#downloaded-pages-title')

    expect(document.activeElement).toBe(target)
    expect(target.getAttribute('tabindex')).toBe('-1')
    expect(host.querySelector('main h1').hasAttribute('tabindex')).toBe(false)
    expect(scroll).toHaveBeenCalledWith({ block: 'start' })
    expect(componentErrors).toEqual([])
  })

  it('does not override a control claimed while a direct lazy fragment view mounts', async () => {
    const claimedPage = Vue.defineComponent({
      setup() {
        const field = Vue.ref(null)
        Vue.onMounted(() => field.value.focus())
        return () => Vue.h('section', [
          Vue.h('h1', 'Account details'),
          Vue.h('h2', { id: 'account-fragment' }, 'Account fragment'),
          Vue.h('input', { ref: field, 'aria-label': 'Claimed during mount' })
        ])
      }
    })
    const scroll = vi.spyOn(browserWindow.Element.prototype, 'scrollIntoView')
    const { host, componentErrors } = await mountProfile('/claimed#account-fragment', {
      extraRoutes: [{ path: '/claimed', component: () => Promise.resolve(claimedPage) }]
    })

    expect(document.activeElement).toBe(host.querySelector('main input'))
    expect(host.querySelector('#account-fragment').hasAttribute('tabindex')).toBe(false)
    expect(scroll).not.toHaveBeenCalled()
    expect(componentErrors).toEqual([])
  })

  it('honors in-app and same-view fragment navigation after rendering', async () => {
    const { host, router, componentErrors } = await mountProfile()
    const scroll = vi.spyOn(browserWindow.Element.prototype, 'scrollIntoView')

    await router.push('/offline#downloaded-pages-title')
    await settle()
    const target = host.querySelector('#downloaded-pages-title')
    expect(document.activeElement).toBe(target)
    expect(scroll).toHaveBeenCalledWith({ block: 'start' })

    await router.push('/offline')
    await settle()
    host.querySelector('main h1').setAttribute('tabindex', '-1')
    host.querySelector('main h1').focus()
    await router.push('/offline#downloaded%2Dpages%2Dtitle')
    await settle()
    expect(document.activeElement).toBe(target)
    expect(componentErrors).toEqual([])
  })

  it('treats a new same-view fragment as intentional navigation from the currently focused field', async () => {
    const { host, router } = await mountProfile('/offline')
    const field = host.querySelector('main input')
    field.focus()

    await router.push('/offline#storage-details')
    await Vue.nextTick()

    expect(document.activeElement).toBe(host.querySelector('#storage-details'))
    expect(host.querySelector('details').open).toBe(true)
  })

  it('does not reclaim focus on a query-only update', async () => {
    const { host, router } = await mountProfile()
    const field = host.querySelector('main input')
    field.focus()
    const focus = vi.spyOn(browserWindow.HTMLElement.prototype, 'focus')

    await router.push('/profile?tab=preferences')
    await Vue.nextTick()

    expect(document.activeElement).toBe(field)
    expect(focus).not.toHaveBeenCalled()
  })

  for (const concealed of [{ hidden: '' }, { inert: '' }, { 'aria-hidden': 'true' }]) {
    it(`never attempts background heading or fragment focus under ${Object.keys(concealed)[0]}`, async () => {
      const hiddenPage = Vue.defineComponent({
        setup: () => () => Vue.h('section', concealed, [
          Vue.h('h1', 'Unavailable heading'),
          Vue.h('h2', { id: 'unavailable-fragment' }, 'Unavailable fragment')
        ])
      })
      const { host, router, componentErrors } = await mountProfile('/profile', {
        extraRoutes: [{ path: '/unavailable', component: hiddenPage }]
      })
      const focus = vi.spyOn(browserWindow.HTMLElement.prototype, 'focus')
      const scroll = vi.spyOn(browserWindow.Element.prototype, 'scrollIntoView')

      await router.push('/unavailable#unavailable-fragment')
      await settle()

      expect(host.querySelector('main h1')).not.toBeNull()
      expect(focus).not.toHaveBeenCalled()
      expect(scroll).not.toHaveBeenCalled()
      expect(componentErrors).toEqual([])
    })
  }

  it('falls back to the incoming heading for missing or malformed fragments', async () => {
    const { host, router, componentErrors } = await mountProfile()
    await router.push('/offline#missing')
    await settle()
    expect(document.activeElement).toBe(host.querySelector('main h1'))

    await router.push('/pages#%E0%A4%A')
    await settle()
    expect(document.activeElement).toBe(host.querySelector('main h1'))
    expect(componentErrors).toEqual([])
  })

  it('preserves focus when a route has no heading and can focus the next available heading', async () => {
    const { host, router, componentErrors } = await mountProfile()
    const control = document.createElement('button')
    control.textContent = 'Account navigation'
    document.body.append(control)
    control.focus()
    const focus = vi.spyOn(browserWindow.HTMLElement.prototype, 'focus')

    await router.push('/loading')
    await settle()

    expect(host.querySelector('main h1')).toBeNull()
    expect(host.querySelector('main p').textContent).toBe('Loading account settings')
    expect(document.activeElement).toBe(control)
    expect(focus).not.toHaveBeenCalled()
    expect(componentErrors).toEqual([])

    await router.push('/pages')
    await settle()

    expect(document.activeElement).toBe(host.querySelector('main h1'))
    expect(componentErrors).toEqual([])
  })
})
