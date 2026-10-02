import fs from 'node:fs'
import path from 'node:path'

import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow, document, resetBody, setLocation } from '../test/browser-dom.mts'
import { focusRouteHeading } from './common/route-heading-focus.ts'

import { translateEnglish } from '../test/english-translate.mts'
;globalThis.useTranslate = () => translateEnglish
const filename = path.join(process.cwd(), 'client/components/admin.vue')
const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
if (errors.length || !descriptor.template || !descriptor.script) throw new Error(`Cannot parse admin.vue: ${errors}`)

resetBody()
setLocation('/a/dashboard')
// jsdom has no scrolling; the shell resets scroll on every route change.
browserWindow.scrollTo = () => {}

const Vue = await import('vue')
const { createMemoryHistory, createRouter } = await import('vue-router')
const compiled = compileTemplate({
  filename,
  id: 'admin-route-focus-test',
  source: descriptor.template.content,
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length) throw new Error(`Cannot compile admin.vue: ${compiled.errors}`)
const render = new Function('Vue', compiled.code)(Vue)
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  descriptor.script.content.replace(/^import [\s\S]*?from .*$/gm, '').replace('export default', 'return')
)
const evaluate = new Function(
  'defineComponent', 'provide', 'ref', 'watch', 'useDisplay', 'wikiStore', 'adminSummaryKey', 'fetchSystemSummary',
  'getErrorMessage', 'loadingStart', 'loadingStop', 'showNotification', 'buildAdminNavigation', 'filterAdminNavigation',
  'ConfirmDialogHost', 'focusRouteHeading',
  script
)

const passthrough = (tag = 'div') =>
  Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, slots.default?.())
    }
  })

const routePage = () =>
  Vue.defineComponent({
    props: ['heading'],
    setup(props) {
      return () => Vue.h('section', Vue.h('h1', { key: props.heading }, props.heading))
    }
  })
const DashboardPage = routePage()
const MembersPage = routePage()
const MemberPage = routePage()

let app
afterEach(() => {
  app?.unmount()
  app = undefined
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

// The out-in transition waits for animation frames before after-enter fires.
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await Vue.nextTick()
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const mountAdmin = async () => {
  const wikiStore = {
    page: { mode: 'view' },
    user: { permissions: ['manage:system'] },
    site: { title: 'Field notes' },
    admin: { info: {} }
  }
  const options = evaluate(
    Vue.defineComponent, Vue.provide, Vue.ref, Vue.watch, () => ({ mdAndUp: Vue.ref(true) }), wikiStore, Symbol('summary'),
    async () => ({}), String, () => {}, () => {}, () => {},
    () => [{ key: 'people', label: 'People', icon: 'mdi-account', items: [{ to: '/users', label: 'Members', icon: 'mdi-account' }] }],
    groups => groups,
    passthrough(), focusRouteHeading
  )
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', component: DashboardPage, props: { heading: 'Dashboard' } },
      { path: '/users', component: MembersPage, props: { heading: 'Members' } },
      { path: '/users/:id', component: MemberPage, props: route => ({ heading: `Member ${route.params.id}` }) }
    ]
  })
  app = Vue.createApp({ ...options, render })
  for (const name of [
    'v-app', 'nav-header', 'v-navigation-drawer', 'v-icon', 'v-spacer', 'v-text-field', 'vue-scroll', 'v-list-item',
    'v-list-item-title', 'v-chip', 'v-expand-transition', 'nav-footer', 'notify', 'search-results'
  ]) {
    app.component(name, passthrough())
  }
  app.component('v-main', passthrough('main'))
  app.component('v-btn', passthrough('button'))
  app.config.globalProperties.$vuetify = { display: { mdAndUp: true, smAndDown: false }, locale: { isRtl: false } }
  app.config.globalProperties.$t = key => key
  const componentErrors = []
  app.config.errorHandler = error => componentErrors.push(error)
  app.use(router)
  await router.push('/dashboard')
  await router.isReady()
  const host = document.createElement('div')
  document.body.append(host)
  const control = document.createElement('button')
  control.textContent = 'Skip to content'
  document.body.append(control)
  control.focus()
  app.mount(host)
  await settle()
  return { host, router, wikiStore, control, componentErrors }
}

describe('admin shell route focus', () => {
  it('does not move focus on the first route', async () => {
    const { host, wikiStore, control, componentErrors } = await mountAdmin()

    expect(wikiStore.page.mode).toBe('admin')
    expect(host.querySelector('main h1')?.textContent).toBe('Dashboard')
    expect(document.activeElement).toBe(control)
    expect(componentErrors).toEqual([])
  })

  it('names the dashboard once in the breadcrumb and links back to it from other pages', async () => {
    const { host, router } = await mountAdmin()
    const crumbs = () => host.querySelector('nav[aria-label="admin:shell.breadcrumb"]')

    expect(crumbs()?.querySelector('a')).toBeNull()
    expect(crumbs()?.querySelector('[aria-current="page"]')?.textContent).toBe('admin:dashboard.title')

    await router.push('/users')
    await settle()

    expect(crumbs()?.querySelector('[aria-current="page"]')?.textContent).toBe('Members')
    expect(crumbs()?.textContent).toContain('People')
  })

  it('focuses the incoming heading once after in-app navigation, without scrolling', async () => {
    const { host, router } = await mountAdmin()
    const focus = vi.spyOn(browserWindow.HTMLElement.prototype, 'focus')

    await router.push('/users')
    await settle()

    const heading = host.querySelector('main h1')
    expect(heading?.textContent).toBe('Members')
    expect(heading?.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(heading)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })
  it('also focuses the heading when a reused view changes its record', async () => {
    const { host, router } = await mountAdmin()
    await router.push('/users/1')
    await settle()
    const other = document.createElement('button')
    document.body.append(other)
    other.focus()

    await router.push('/users/2')
    await settle()

    const heading = host.querySelector('main h1')
    expect(heading?.textContent).toBe('Member 2')
    expect(document.activeElement).toBe(heading)
  })
})
