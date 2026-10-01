import fs from 'node:fs'
import path from 'node:path'

import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import { browserWindow, document, resetBody, setLocation } from '../test/browser-dom.mts'

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
const evaluate = new Function('defineComponent', 'ref', 'watch', 'useDisplay', 'wikiStore', script)

const passthrough = (tag = 'div') =>
  Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, slots.default?.())
    }
  })

// Each route replaces its heading, so focusing the outgoing view before the
// render tick cannot accidentally satisfy the incoming-heading assertion.
const RoutePage = Vue.defineComponent({
  props: ['heading'],
  setup(props) {
    return () => Vue.h('section', props.heading ? Vue.h('h1', { key: props.heading }, props.heading) : Vue.h('p', 'Loading account settings'))
  }
})

let app
afterEach(() => {
  app?.unmount()
  app = undefined
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

const settle = async () => {
  await Vue.nextTick()
  await Vue.nextTick()
}

const mountProfile = async () => {
  const wikiStore = { page: { mode: 'view' } }
  const options = evaluate(Vue.defineComponent, Vue.ref, Vue.watch, () => ({ mdAndUp: Vue.ref(true) }), wikiStore)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/profile', component: RoutePage, props: { heading: 'Your profile' } },
      { path: '/pages', component: RoutePage, props: { heading: 'Your pages' } },
      { path: '/loading', component: RoutePage, props: { heading: null } }
    ]
  })
  app = Vue.createApp({ ...options, render })
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
  app.config.errorHandler = error => componentErrors.push(error)
  app.use(router)
  await router.push('/profile')
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
