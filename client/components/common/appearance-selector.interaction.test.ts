import fs from 'node:fs'
import path from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, expect, it, vi } from '../../../server/test/bun-test.mts'
import { resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { resolveThemeName } from '../../helpers/theme.ts'
import type { App, Component, RenderFunction } from 'vue'

// Install browser-dom before Vue/Vuetify evaluate their DOM capabilities.
const Vue = await import('vue')
const { createVuetify, useTheme } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
const filename = path.join(process.cwd(), 'client/components/common/appearance-selector.vue')
const descriptor = parse(fs.readFileSync(filename, 'utf8'), { filename }).descriptor
const metadata = compileScript(descriptor, { id: 'appearance-selector-interaction' })
const script = descriptor.scriptSetup!.content
const parts: string[] = []
let end = 0
for (const statement of metadata.scriptSetupAst!) {
  if (statement.type !== 'ImportDeclaration') continue
  parts.push(script.slice(end, statement.start!))
  end = statement.end!
}
parts.push(script.slice(end))
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(parts.join(''))
const bindings = Object.keys(metadata.bindings!).filter(name => metadata.bindings![name] !== 'props' && !metadata.imports?.[name])
const evaluate = new Function('{ computed, ref, useId, useTemplateRef, watch, useTheme, wikiStore, updateProfilePreferences, resolveThemeName, useTranslate, defineProps, siteConfig }', `${source}\nreturn { ${bindings.join(', ')} }`)
const template = compileTemplate({
  source: descriptor.template!.content,
  filename,
  id: 'appearance-selector-interaction',
  preprocessLang: descriptor.template!.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (template.errors.length) throw template.errors[0]
const render = new Function('Vue', template.code)(Vue) as RenderFunction
const apps: App[] = []
const settle = async () => {
  for (let n = 0; n < 8; n++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}

function mount(save: () => Promise<void>, appearance = 'system') {
  const host = document.createElement('div')
  document.body.append(host)
  const errors: unknown[] = []
  const store = Vue.reactive({
    user: { id: 1, authenticated: true, authVersion: 0, appearance },
    offlineIdentityEpoch: 0,
    authRefreshPending: false,
    authRefreshOutcome: 'authenticated',
    loadingCounts: {} as Record<string, number>,
    startLoading(key: string) { store.loadingCounts[key] = (store.loadingCounts[key] ?? 0) + 1 },
    stopLoading(key: string) { store.loadingCounts[key] = Math.max(0, (store.loadingCounts[key] ?? 0) - 1) },
    refreshAuth: vi.fn(async () => 'authenticated'),
    showError(error: unknown) { errors.push(error) }
  })
  const savePreference = vi.fn(save)
  const component = Vue.defineComponent({
    setup(props) {
      return evaluate({
        ...Vue, useTheme, wikiStore: store, updateProfilePreferences: savePreference,
        resolveThemeName, useTranslate: () => translateEnglish, defineProps: () => props,
        siteConfig: { darkMode: false, rtl: false }
      })
    },
    render
  })
  const vuetify = createVuetify({ components, directives, theme: { defaultTheme: appearance } })
  const app = Vue.createApp({ render: () => Vue.h(component as Component) })
  app.config.globalProperties.$t = translateEnglish
  app.use(vuetify)
  app.mount(host)
  apps.push(app)
  return { host, store, savePreference, errors }
}

function segment(host: HTMLElement, appearance: string): HTMLButtonElement {
  const found = host.querySelector<HTMLButtonElement>(`button[data-appearance="${appearance}"]`)
  if (!found) throw new Error(`Missing ${appearance} appearance control`)
  return found
}

afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  resetBody()
  vi.restoreAllMocks()
})

it('excludes a second selection while persistence is pending and allows retry after failure', async () => {
  const pending = Promise.withResolvers<void>()
  const mounted = mount(() => pending.promise)
  segment(mounted.host, 'light').click()
  await settle()
  expect(mounted.store.user.appearance).toBe('light')
  expect([...mounted.host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].every(button => button.getAttribute('aria-disabled') === 'true')).toBe(true)
  segment(mounted.host, 'dark').click()
  await settle()
  expect(mounted.savePreference).toHaveBeenCalledTimes(1)
  pending.reject(new Error('Disconnected'))
  await settle()
  expect(mounted.store.user.appearance).toBe('system')
  expect(segment(mounted.host, 'system').getAttribute('aria-checked')).toBe('true')
  expect(segment(mounted.host, 'light').getAttribute('aria-disabled')).toBe('false')
  expect(mounted.errors).toHaveLength(1)
})

for (const outcome of ['success', 'failure'] as const) {
  it(`discards a late ${outcome} after the signed-in account changes`, async () => {
    const pending = Promise.withResolvers<void>()
    const mounted = mount(() => pending.promise)
    segment(mounted.host, 'light').click()
    await settle()
    mounted.store.user = { id: 2, authenticated: true, authVersion: 4, appearance: 'dark' }
    await settle()
    if (outcome === 'success') pending.resolve()
    else pending.reject(new Error('Old account request failed'))
    await settle()
    expect(mounted.store.user).toEqual({ id: 2, authenticated: true, authVersion: 4, appearance: 'dark' })
    expect(segment(mounted.host, 'dark').getAttribute('aria-checked')).toBe('true')
    expect(mounted.store.refreshAuth).toHaveBeenCalledTimes(0)
    expect(mounted.errors).toEqual([])
    expect(segment(mounted.host, 'dark').getAttribute('aria-disabled')).toBe('false')
  })
}

it('does not roll back a replacement session of the same account when its old request fails', async () => {
  const pending = Promise.withResolvers<void>()
  const mounted = mount(() => pending.promise)
  segment(mounted.host, 'light').click()
  await settle()
  mounted.store.offlineIdentityEpoch++
  mounted.store.user.authVersion++
  mounted.store.user.appearance = 'dark'
  await settle()
  pending.reject(new Error('Retired session request failed'))
  await settle()
  expect(mounted.store.user.appearance).toBe('dark')
  expect(segment(mounted.host, 'dark').getAttribute('aria-checked')).toBe('true')
  expect(mounted.store.refreshAuth).toHaveBeenCalledTimes(0)
  expect(mounted.errors).toEqual([])
})
