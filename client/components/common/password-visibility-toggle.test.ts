import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import { document, resetBody } from '../../test/browser-dom.mts'

resetBody()
const Vue = await import('vue')
const filename = path.join(process.cwd(), 'client/components/common/password-visibility-toggle.vue')
const { descriptor, errors } = parse(fs.readFileSync(filename, 'utf8'), { filename })
if (errors.length || !descriptor.template || !descriptor.script) throw new Error(`Cannot parse password-visibility-toggle.vue: ${errors}`)
const compiled = compileTemplate({
  filename,
  id: 'password-visibility-toggle-test',
  source: descriptor.template.content,
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length) throw new Error(`Cannot compile password-visibility-toggle.vue: ${compiled.errors}`)
const render = new Function('Vue', compiled.code)(Vue)
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  descriptor.script.content.replace(/^import .*$/gm, '').replace('export default', 'return')
)
const Toggle = { ...new Function('defineComponent', script)(Vue.defineComponent), render }

let app: ReturnType<typeof Vue.createApp> | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  resetBody()
})

const mount = async (options: { translate?: boolean; disabled?: boolean } = {}) => {
  const visible = Vue.ref(false)
  app = Vue.createApp({
    setup: () => () =>
      Vue.h(Toggle, {
        visible: visible.value,
        field: 'Password',
        disabled: options.disabled ?? false,
        'onUpdate:visible': (value: boolean) => {
          visible.value = value
        }
      })
  })
  app.component('v-btn', Vue.defineComponent({
    inheritAttrs: false,
    props: ['disabled'],
    setup: (props, { attrs, slots }) => () => Vue.h('button', { ...attrs, disabled: props.disabled || undefined }, slots.default?.())
  }))
  app.component('v-icon', Vue.defineComponent({ props: ['icon'], setup: props => () => Vue.h('i', { 'data-icon': props.icon }) }))
  if (options.translate) {
    app.config.globalProperties.$t = (key: string, opts: { field: string }) => (key === 'common:password.show' ? `Passwort anzeigen: ${opts.field}` : key)
  }
  const host = document.createElement('div')
  document.body.append(host)
  app.mount(host)
  await Vue.nextTick()
  return { button: host.querySelector('button')!, visible }
}

describe('password visibility toggle', () => {
  test('is a toggle button with a stable name, a pressed state and the eye icon for the action', async () => {
    const { button, visible } = await mount()

    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('aria-label')).toBe('Show Password')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.querySelector('i')?.dataset.icon).toBe('mdi-eye-outline')

    button.click()
    await Vue.nextTick()

    expect(visible.value).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('Show Password')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.querySelector('i')?.dataset.icon).toBe('mdi-eye-off-outline')

    button.click()
    await Vue.nextTick()
    expect(visible.value).toBe(false)
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  test('uses the translated label when i18n is available and stays inert while disabled', async () => {
    const { button } = await mount({ translate: true, disabled: true })

    expect(button.getAttribute('aria-label')).toBe('Passwort anzeigen: Password')
    expect(button.disabled).toBe(true)
  })
})
