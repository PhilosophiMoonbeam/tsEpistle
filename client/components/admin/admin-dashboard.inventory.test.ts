import fs from 'node:fs'
import path from 'node:path'

import { compileTemplate, parse } from '@vue/compiler-sfc'
import type { App } from 'vue'
import { afterEach, describe, expect, it } from '../../../server/test/bun-test.mts'
import { document, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { installVuetifyFixture } from '../../test/vuetify-fixture.mts'

resetBody()
// Vue must initialize its DOM renderer after browser-dom has installed document.
const Vue = await import('vue')
const filename = path.join(process.cwd(), 'client/components/admin/admin-dashboard.vue')
const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
if (errors.length || !descriptor.template || !descriptor.script) throw new Error(`Cannot parse dashboard: ${errors}`)
const compiled = compileTemplate({
  filename,
  id: 'dashboard-inventory-test',
  source: descriptor.template.content,
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length) throw new Error(`Cannot compile dashboard: ${compiled.errors}`)
const render = new Function('Vue', compiled.code)(Vue)
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  descriptor.script.content.replace(/^import .*$/gm, '').replace('export default', 'return')
)
const evaluate = new Function(
  'markRaw', 'inject', 'adminSummaryKey', 'AsyncState', 'AdminHero', 'AnimatedNumber', 'wikiStore',
  'fetchRecentPages', 'fetchLastLogins', 'getErrorMessage', 'loadingStart', 'loadingStop', 'siteConfig', script
)
const passthrough = Vue.defineComponent({
  setup(_props, { attrs, slots }) {
    return () => Vue.h('div', attrs, slots.default?.())
  }
})
const animatedNumber = Vue.defineComponent({
  props: ['value'],
  setup(props) {
    return () => Vue.h('span', String(props.value))
  }
})
let app: App | undefined

afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.replaceChildren()
})

const mountInventory = async (permissions = ['manage:system']) => {
  const summary = { loading: Vue.ref(true), error: Vue.ref(''), refresh: () => {} }
  const info = Vue.reactive({
    pagesTotal: 0, tagsTotal: 0, usersTotal: 0, groupsTotal: 0,
    assetsTotal: null as number | null, assetsBytes: null as number | null, commentsTotal: null as number | null,
    product: { version: 'test' }
  })
  const summaryKey = Symbol('summary')
  const options = evaluate(
    Vue.markRaw, Vue.inject, summaryKey, passthrough, passthrough, animatedNumber,
    { admin: { info }, site: { title: 'Workspace' }, user: { permissions } },
    async () => [], async () => [], String, () => {}, () => {}, { agentsEnabled: false }
  )
  app = Vue.createApp({ ...options, render })
  app.provide(summaryKey, summary)
  for (const name of ['v-container', 'v-btn', 'v-icon', 'v-alert', 'v-row', 'v-col', 'v-card']) app.component(name, passthrough)
  app.component('router-link', Vue.defineComponent({
    props: ['to'],
    setup(props, { attrs, slots }) {
      return () => Vue.h('a', { ...attrs, href: props.to }, slots.default?.())
    }
  }))
  app.config.globalProperties.$t = translateEnglish
  installVuetifyFixture(app)
  const host = document.createElement('div')
  document.body.append(host)
  app.mount(host)
  await Vue.nextTick()
  return { host, summary, info }
}

describe('dashboard inventory stability', () => {
  it('preserves focused metric controls as loading settles and announces the busy transition', async () => {
    const { host, summary, info } = await mountInventory()
    const assetControl = host.querySelector<HTMLAnchorElement>('.admin-stat[href="/assets"]')
    const status = host.querySelector('[role="status"]')
    expect(assetControl?.querySelector('strong')?.textContent?.trim()).toBe('—')
    expect(host.querySelector('.dashboard-inventory')?.getAttribute('aria-busy')).toBe('true')
    expect(status?.textContent?.trim()).not.toBe('')
    assetControl?.focus()
    expect(document.activeElement).toBe(assetControl)

    Object.assign(info, { pagesTotal: 6, tagsTotal: 2, usersTotal: 3, groupsTotal: 4, assetsTotal: 1, assetsBytes: 42, commentsTotal: 5 })
    summary.loading.value = false
    await Vue.nextTick()

    expect(document.activeElement).toBe(assetControl)
    expect(assetControl?.querySelector('strong')?.textContent?.trim()).toBe('1')
    expect(host.querySelector('.dashboard-inventory')?.getAttribute('aria-busy')).toBe('false')
    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe('')
  })

  it('does not expose protected totals to a page-only editor while loading or unavailable', async () => {
    const { host, summary, info } = await mountInventory(['write:pages'])
    expect(host.querySelectorAll('.admin-stat')).toHaveLength(1)
    expect(host.querySelector('.admin-stat')?.getAttribute('href')).toBe('/pages')

    Object.assign(info, { assetsTotal: 9, assetsBytes: 100, commentsTotal: 10 })
    summary.loading.value = false
    summary.error.value = 'Unavailable'
    await Vue.nextTick()
    expect(host.querySelectorAll('.admin-stat')).toHaveLength(1)
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('does not render protected metrics when a settled summary withholds them', async () => {
    const { host, summary } = await mountInventory()
    summary.loading.value = false
    await Vue.nextTick()
    expect(host.querySelector('.admin-stat[href="/assets"]')).toBeNull()
    expect(host.querySelector('.admin-stat[href="/comments"]')).toBeNull()
    expect(host.querySelector('.admin-stat[href="/pages"]')).not.toBeNull()
  })
})
