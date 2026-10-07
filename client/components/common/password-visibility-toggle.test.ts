/// <reference types="bun" />

import fs from 'node:fs'
import path from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import i18next from 'i18next'
import { localizationPlugin } from '../../modules/localization.ts'
import { afterEach, describe, expect, test } from '../../../server/test/bun-test.mts'
import { document, resetBody } from '../../test/browser-dom.mts'

import { translateEnglish } from '../../test/english-translate.mts'
Reflect.set(globalThis, 'useTranslate', () => translateEnglish)
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
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(descriptor.script.content.replace(/^import .*$/gm, '').replace('export default', 'return'))
const Toggle = { ...new Function('defineComponent', script)(Vue.defineComponent), render }

let app: ReturnType<typeof Vue.createApp> | undefined
afterEach(() => {
  app?.unmount()
  app = undefined
  resetBody()
})

const mount = async (
  options: {
    translate?: ((key: string, options?: Record<string, unknown>) => string) | null
    localization?: boolean
    fields?: string[]
    disabled?: boolean
  } = {}
) => {
  const fields = (options.fields ?? ['password']).map(field => Vue.ref(field))
  const visibility = fields.map(() => Vue.ref(false))
  app = Vue.createApp({
    setup: () => () =>
      Vue.h(
        'div',
        fields.map((field, index) =>
          Vue.h(Toggle, {
            visible: visibility[index]!.value,
            field: field.value,
            disabled: options.disabled ?? false,
            'onUpdate:visible': (value: boolean) => {
              visibility[index]!.value = value
            }
          })
        )
      )
  })
  app.component(
    'v-btn',
    Vue.defineComponent({
      inheritAttrs: false,
      props: ['disabled'],
      setup:
        (props, { attrs, slots }) =>
        () =>
          Vue.h('button', { ...attrs, disabled: props.disabled || undefined }, slots.default?.())
    })
  )
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
  return { button: buttons[0]!, buttons, visible: visibility[0]!, visibility, fields }
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

  test('preserves an active localized toggle resource and updates dynamic field names without resetting visibility', async () => {
    const engine = i18next.createInstance()
    await engine.init({
      lng: 'de',
      fallbackLng: false,
      ns: ['common'],
      defaultNS: 'common',
      resources: { de: { common: { passwordVisibilityToggle: { show: '{{field}} anzeigen' } } } },
      initAsync: false
    })
    const { button, visible, fields } = await mount({
      translate: (key, options) => engine.t(key, options) as string,
      fields: ['API Schlüssel & "Bestätigung" <em>秘密</em>!']
    })

    expect(button.getAttribute('aria-label')).toBe('API Schlüssel & "Bestätigung" <em>秘密</em>! anzeigen')
    expect(button.querySelector('em')).toBeNull()
    expect(button.getAttribute('aria-pressed')).toBe('false')
    button.click()
    await Vue.nextTick()
    expect(button.getAttribute('aria-label')).toBe('API Schlüssel & "Bestätigung" <em>秘密</em>! anzeigen')
    expect(button.getAttribute('aria-pressed')).toBe('true')

    fields[0]!.value = 'Neuer Token: Équipe & <strong>更新</strong>?'
    await Vue.nextTick()

    expect(button.getAttribute('aria-label')).toBe('Neuer Token: Équipe & <strong>更新</strong>? anzeigen')
    expect(button.querySelector('strong')).toBeNull()
    expect(visible.value).toBe(true)
    expect(button.getAttribute('aria-pressed')).toBe('true')

    button.click()
    await Vue.nextTick()
    expect(button.getAttribute('aria-label')).toBe('Neuer Token: Équipe & <strong>更新</strong>? anzeigen')
    expect(visible.value).toBe(false)
    expect(button.getAttribute('aria-pressed')).toBe('false')
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
        expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['Show administrator password', 'Show password confirmation'])

        buttons[1]!.focus()
        buttons[1]!.click()
        await Vue.nextTick()

        expect(document.activeElement).toBe(buttons[1]!)
        expect(visibility.map(value => value.value)).toEqual([false, true])
        expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true'])
        expect(buttons.map(button => button.getAttribute('aria-label'))).toEqual(['Show administrator password', 'Show password confirmation'])
      } finally {
        i18next.isInitialized = initialized
      }
    })
  }
})
