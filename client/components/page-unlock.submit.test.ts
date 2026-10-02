import fs from 'node:fs'
import path from 'node:path'

import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it } from '../../server/test/bun-test.mts'
import { document, resetBody, setLocation } from '../test/browser-dom.mts'
import type { ComponentOptions, RenderFunction } from 'vue'

const filename = path.join(process.cwd(), 'client/components/page-unlock.vue')
const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
if (errors.length || !descriptor.template || !descriptor.script) throw new Error(`Cannot parse page-unlock.vue: ${errors}`)

resetBody()
setLocation('/en/protected')

const Vue = await import('vue')
const compiled = compileTemplate({
  filename,
  id: 'page-unlock-submit-test',
  source: descriptor.template.content,
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length) throw new Error(`Cannot compile page-unlock.vue: ${compiled.errors}`)
const render = new Function('Vue', compiled.code)(Vue) as RenderFunction
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(descriptor.script.content.replace(/^import .*$/gm, '').replace('export default', 'return'))
const options = new Function('defineComponent', 'wikiStore', script)(Vue.defineComponent, {
  site: { title: 'Wiki', logoUrl: '' }
}) as ComponentOptions

const passthrough = (tag = 'div') =>
  Vue.defineComponent({
    inheritAttrs: false,
    setup(_props, { attrs, slots }) {
      return () => Vue.h(tag, attrs, [slots.default?.(), slots['append-inner']?.()])
    }
  })

let app: { unmount: () => void } | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.replaceChildren()
})

describe('page unlock', () => {
  it('uses one heading, shows the page title and blocks a second password submit', async () => {
    app = Vue.createApp({ ...options, render }, { pageId: 4, pageTitle: 'Payroll', returnTo: '/en/payroll' })
    for (const name of ['v-app', 'v-card', 'v-card-text', 'v-icon', 'v-alert', 'v-text-field']) app.component(name, passthrough())
    app.component('v-btn', Vue.defineComponent({
      inheritAttrs: false,
      props: { loading: Boolean },
      setup(props, { attrs, slots }) {
        return () => Vue.h('button', { ...attrs, 'data-loading': String(props.loading) }, slots.default?.())
      }
    }))
    app.config.globalProperties.$t = (key: string) => key
    const host = document.createElement('div')
    document.body.append(host)
    app.mount(host)
    await Vue.nextTick()

    expect(Array.from(host.querySelectorAll('h1'), heading => heading.textContent?.trim())).toEqual(['common:pageUnlock.title'])
    expect(host.querySelector('.page-unlock-page-title')?.textContent?.trim()).toBe('Payroll')

    const form = host.querySelector('form')
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')
    const first = new Event('submit', { cancelable: true })
    form?.dispatchEvent(first)
    await Vue.nextTick()
    expect(first.defaultPrevented).toBe(false)
    expect(submit?.dataset.loading).toBe('true')
    expect(form?.getAttribute('aria-busy')).toBe('true')

    const second = new Event('submit', { cancelable: true })
    form?.dispatchEvent(second)
    expect(second.defaultPrevented).toBe(true)

    window.dispatchEvent(new Event('pageshow'))
    await Vue.nextTick()
    expect(submit?.dataset.loading).toBe('false')

    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="common:pageUnlock.showPassword"]')
    expect(toggle?.getAttribute('aria-pressed')).toBe('false')
  })
})
