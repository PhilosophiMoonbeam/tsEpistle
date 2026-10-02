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
const toggleFilename = path.join(process.cwd(), 'client/components/common/password-visibility-toggle.vue')
const toggleDescriptor = parse(fs.readFileSync(toggleFilename, 'utf8'), { filename: toggleFilename }).descriptor
const toggleTemplate = compileTemplate({
  filename: toggleFilename,
  id: 'page-unlock-toggle-test',
  source: toggleDescriptor.template!.content,
  preprocessLang: toggleDescriptor.template!.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
const toggleScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(toggleDescriptor.script!.content.replace(/^import .*$/gm, '').replace('export default', 'return'))
const PasswordVisibilityToggle = {
  ...new Function('defineComponent', toggleScript)(Vue.defineComponent),
  render: new Function('Vue', toggleTemplate.code)(Vue) as RenderFunction
}
const options = new Function('defineComponent', 'wikiStore', 'PasswordVisibilityToggle', script)(Vue.defineComponent, {
  site: { title: 'Wiki', logoUrl: '' }
}, PasswordVisibilityToggle) as ComponentOptions

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

    // The shared toggle: a fixed name for the field, the state in aria-pressed.
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="common:password.show"]')
    const field = host.querySelector('[name="password"]')
    expect(toggle?.getAttribute('aria-pressed')).toBe('false')
    expect(field?.getAttribute('type')).toBe('password')
    toggle?.click()
    await Vue.nextTick()
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')
    expect(toggle?.getAttribute('aria-label')).toBe('common:password.show')
    expect(field?.getAttribute('type')).toBe('text')
  })
})
