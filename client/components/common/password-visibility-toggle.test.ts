import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import i18next from 'i18next'
import { localizationPlugin } from '../../modules/localization.ts'
import { afterEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import { document, resetBody } from '../../test/browser-dom.mts'

import { translateEnglish } from '../../test/english-translate.mts'
;globalThis.useTranslate = () => translateEnglish
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

const mount = async (options: {
  translate?: ((key: string, options?: Record<string, unknown>) => string) | null
  localization?: boolean
  fields?: string[]
  disabled?: boolean
} = {}) => {
  const fields = options.fields ?? ['password']
  const visibility = fields.map(() => Vue.ref(false))
  app = Vue.createApp({
    setup: () => () =>
      Vue.h('div', fields.map((field, index) => Vue.h(Toggle, {
        visible: visibility[index]!.value,
        field,
        disabled: options.disabled ?? false,
        'onUpdate:visible': (value: boolean) => {
          visibility[index]!.value = value
        }
      })))
  })
  app.component('v-btn', Vue.defineComponent({
    inheritAttrs: false,
    props: ['disabled'],
    setup: (props, { attrs, slots }) => () => Vue.h('button', { ...attrs, disabled: props.disabled || undefined }, slots.default?.())
  }))
  app.component('v-icon', Vue.defineComponent({ props: ['icon'], setup: props => () => Vue.h('i', { 'data-icon': props.icon }) }))
  if (options.localization) {
    app.use(localizationPlugin)
  } else if (options.translate !== null) {
    app.config.globalProperties.$t = options.translate ?? translateEnglish
  }
  const host = document.createElement('div')
  document.body.append(host)
  app.mount(host)
  await Vue.nextTick()
  const buttons = [...host.querySelectorAll('button')]
  return { button: buttons[0]!, buttons, visible: visibility[0]!, visibility }
}

describe('password visibility toggle', () => {
  test('is a toggle button with a stable name, a pressed state and the eye icon for the action', async () => {
    const { button, visible } = await mount()

    expect(button.getAttribute('type')).toBe('button')
    expect(button.getAttribute('aria-label')).toBe('Show password')
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(button.querySelector('i')?.dataset.icon).toBe('mdi-eye-outline')

    button.click()
    await Vue.nextTick()

    expect(visible.value).toBe(true)
    expect(button.getAttribute('aria-label')).toBe('Show password')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.querySelector('i')?.dataset.icon).toBe('mdi-eye-off-outline')

    button.click()
    await Vue.nextTick()
    expect(visible.value).toBe(false)
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  test('uses initialized localized resources and stays inert while disabled', async () => {
    const engine = i18next.createInstance()
    await engine.init({
      lng: 'de',
      fallbackLng: false,
      ns: ['common'],
      defaultNS: 'common',
      resources: { de: { common: { password: { show: '{{field}} anzeigen' } } } },
      initAsync: false
    })
    const { button } = await mount({
      translate: (key, options) => engine.t(key, options) as string,
      fields: ['Passwort & Bestätigung'],
      disabled: true
    })

    expect(button.getAttribute('aria-label')).toBe('Passwort & Bestätigung anzeigen')
    expect(button.disabled).toBe(true)
    button.click()
    await Vue.nextTick()
    expect(button.getAttribute('aria-pressed')).toBe('false')
  })

  test('preserves an active localized toggle resource when the password key is unavailable', async () => {
    const engine = i18next.createInstance()
    await engine.init({
      lng: 'de',
      fallbackLng: false,
      ns: ['common'],
      defaultNS: 'common',
      resources: { de: { common: { passwordVisibilityToggle: { show: '{{field}} anzeigen' } } } },
      initAsync: false
    })
    const { button } = await mount({
      translate: (key, options) => engine.t(key, options) as string,
      fields: ['Passwort & Bestätigung']
    })

    expect(button.getAttribute('aria-label')).toBe('Passwort & Bestätigung anzeigen')
    button.click()
    await Vue.nextTick()
    expect(button.getAttribute('aria-label')).toBe('Passwort & Bestätigung anzeigen')
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  for (const localization of [false, true]) {
    test(`keeps setup fields distinguishable ${localization ? 'before the installed localization plugin initializes' : 'without a translation helper'}`, async () => {
      const initialized = i18next.isInitialized
      i18next.isInitialized = false
      try {
        const { buttons, visibility } = await mount({
          localization,
          translate: null,
          fields: ['administrator password', 'password confirmation']
        })
        expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
          'Show administrator password',
          'Show password confirmation'
        ])

        buttons[1]!.focus()
        buttons[1]!.click()
        await Vue.nextTick()

        expect(document.activeElement).toBe(buttons[1]!)
        expect(visibility.map(value => value.value)).toEqual([false, true])
        expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
        expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual([
          'Show administrator password',
          'Show password confirmation'
        ])
      } finally {
        i18next.isInitialized = initialized
      }
    })
  }
})

describe('password visibility toggle names', () => {
  // The name is "Show <field>", so every caller passes a lowercase noun
  // ("Show page password", not "Show Page password").
  test('every caller passes a lowercase field noun', () => {
    const locale = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'server/locales/en.json'), 'utf8')) as Record<string, unknown>
    const resolve = (key: string): unknown => {
      const [namespace, rest] = key.split(':') as [string, string]
      return rest.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), locale[namespace])
    }
    const files = new Bun.Glob('client/**/*.vue').scanSync({ cwd: process.cwd() })
    const fields: string[] = []
    for (const file of files) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
      for (const usage of source.matchAll(/<password-visibility-toggle\b[^>]*>|(?<![.\w-])password-visibility-toggle\((?:[^()]|\([^()]*\))*\)/g)) {
        const text = usage[0]
        const bound = text.match(/:field=["']\$t\([`'"]([^`'"]+)[`'"]/)
        const literal = text.match(/(?<![:\w])field=["']([^"']+)["']/)
        const value = bound ? resolve(bound[1]!) : literal?.[1]
        expect(typeof value).toBe('string')
        fields.push(value as string)
      }
    }
    expect(fields.length).toBeGreaterThanOrEqual(12)
    for (const field of fields) expect(field).toMatch(/^[a-z][a-z ]*$/)
  })
})
