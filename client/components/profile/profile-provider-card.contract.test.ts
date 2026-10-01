import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import type { App, ComponentOptions, EffectScope, RenderFunction } from 'vue'
import _ from 'lodash'
import { afterEach, describe, expect, test, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, document, setLocation } from '../../test/browser-dom.mts'
import { passwordPolicyMixin } from '../../helpers/password-policy.ts'
import { newPasswordIssue } from '../../../shared/security-policy.ts'
import validateValues from '../../../shared/validation.ts'
import * as usersApi from '../../helpers/users-api.ts'
import type { Profile } from '../../helpers/users-api.ts'
import { fetchLocales } from '../../helpers/locales-api.ts'
import { resolveThemeName } from '../../helpers/theme.ts'
import { getErrorMessage } from '../../helpers/root-ui-store.ts'

// Vue/Vuetify capture the document when loaded; the shared test DOM must exist first.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
const filename = join(process.cwd(), 'client/components/profile/profile.vue')
const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
if (errors.length || !descriptor.template || !descriptor.script) throw new Error(`Cannot parse profile.vue: ${errors}`)
const compiled = compileTemplate({
  filename,
  id: 'profile-controls-contract',
  source: descriptor.template.content,
  preprocessLang: descriptor.template.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (compiled.errors.length) throw new Error(`Cannot compile profile.vue: ${compiled.errors}`)
const render = new Function('Vue', compiled.code)(Vue) as RenderFunction
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  descriptor.script.content.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"]\s*;?/gm, '').replace('export default', 'return')
)
const evaluate = new Function(
  'passwordPolicyMixin', 'newPasswordIssue', 'AsyncState', 'PasswordStrength', 'wikiStore',
  'changeProfilePassword', 'fetchProfile', 'removeProfileAvatar', 'updateProfile',
  'updateProfilePreferences', 'uploadProfileAvatar', 'fetchLocales', '_', 'validateValues',
  'resolveThemeName', 'applyUserPresentation', 'getErrorMessage', executable
)

const translations: Record<string, string> = {
  'common:actions.edit': 'Modifier',
  'common:actions.save': 'Enregistrer',
  'common:header.view': 'Afficher',
  'common:actions.close': 'Masquer',
  'profile:displayName': 'Nom affiché',
  'profile:mentionHandle': 'Identifiant de mention',
  'profile:location': 'Lieu',
  'profile:jobTitle': 'Profession',
  'profile:timezone': 'Fuseau horaire',
  'profile:dateFormat': 'Format de date',
  'profile:timeFormat': 'Format horaire',
  'profile:appearance': 'Apparence',
  'profile:appearanceDefault': 'Par défaut',
  'profile:appearanceLight': 'Clair',
  'profile:appearanceDark': 'Sombre',
  'profile:appearanceSystem': 'Suivre l’appareil',
  'profile:auth.provider': 'Fournisseur d’authentification',
  'profile:auth.currentPassword': 'Mot de passe actuel',
  'profile:auth.newPassword': 'Nouveau mot de passe',
  'profile:auth.verifyPassword': 'Confirmer le mot de passe',
  'profile:avatar.upload': 'Importer un avatar',
  'profile:avatar.remove': 'Supprimer l’avatar',
  'profile:avatar.help': 'PNG, JPEG ou WebP ; l’avatar du fournisseur revient à la prochaine connexion.'
}
const translate = (key: string, options: { defaultValue?: string } = {}) => translations[key] ?? options.defaultValue ?? key
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'Content-Type': 'application/json' }
})
const profile = (overrides: Partial<Profile> = {}): Profile => ({
  id: 73, email: 'reader@example.test', name: 'Example Reader', handle: 'reader',
  providerKey: 'local', providerName: 'Compte local', pictureUrl: 'https://provider.example/avatar.png',
  isSystem: false, isVerified: true, location: '', jobTitle: '', timezone: '',
  dateFormat: '', timeFormat: 'locale', appearance: 'light', reduceMotion: false,
  underlineLinks: false, contentTextSize: 'default', communicationLocale: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
  lastLoginAt: '2026-09-03T00:00:00Z', groups: [], pagesTotal: 0, ...overrides
})
const placeholder = Vue.defineComponent({ render: () => Vue.h('div') })
let app: App | undefined
let fixtureScope: EffectScope | undefined
const restorers: Array<() => void> = []
const focusTimers = new Set<number>()
const observers = new Set<AvatarIntersectionObserver>()
const ownProperty = (target: object, key: PropertyKey, value: unknown) => {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, { configurable: true, writable: true, value })
  restorers.push(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else Reflect.deleteProperty(target, key)
  })
}
class AvatarIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = '0px'
  readonly thresholds = [0]
  readonly targets = new Set<Element>()
  constructor(private readonly callback: IntersectionObserverCallback) { observers.add(this) }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear(); observers.delete(this) }
  takeRecords(): IntersectionObserverEntry[] { return [] }
  intersect(target: Element) {
    const bounds = target.getBoundingClientRect()
    this.callback([{
      target, isIntersecting: true, intersectionRatio: 1, time: performance.now(),
      boundingClientRect: bounds, intersectionRect: bounds, rootBounds: null
    }], this)
  }
}
const intersectAvatar = async (host: HTMLElement) => {
  const avatar = host.querySelector('.profile-avatar-preview .v-img')!
  expect(avatar).not.toBeNull()
  const observer = [...observers].find(item => item.targets.has(avatar))
  expect(observer).toBeDefined()
  observer!.intersect(avatar)
  await settle()
}
let themeStyle: Element | null
let themeStyleContent: string | null
let componentErrors: unknown[] = []
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}
afterEach(() => {
  try {
    app?.unmount()
  } finally {
    app = undefined
    fixtureScope?.stop()
    fixtureScope = undefined
    for (const timer of focusTimers) clearTimeout(timer)
    focusTimers.clear()
    for (const observer of [...observers]) observer.disconnect()
    const currentStyle = document.querySelector('#vuetify-theme-stylesheet')
    if (themeStyle) themeStyle.textContent = themeStyleContent
    else currentStyle?.remove()
    for (const restore of restorers.splice(0).reverse()) restore()
  }
  expect(componentErrors).toEqual([])
})
const mount = async (initialProfile = profile()) => {
  const previousLocation = browserWindow.location.href
  restorers.push(() => setLocation(previousLocation))
  setLocation('/p/profile')
  const previousBody = [...document.body.childNodes]
  document.body.replaceChildren()
  restorers.push(() => document.body.replaceChildren(...previousBody))
  ownProperty(globalThis, 'IntersectionObserver', AvatarIntersectionObserver)
  ownProperty(browserWindow, 'IntersectionObserver', AvatarIntersectionObserver)
  themeStyle = document.querySelector('#vuetify-theme-stylesheet')
  themeStyleContent = themeStyle?.textContent ?? null
  ownProperty(globalThis, 'siteConfig', { lang: 'fr', darkMode: false })
  const activeLoading = new Set<string>()
  const store = {
    user: { id: 73, name: 'Example Reader', email: 'reader@example.test', pictureUrl: '', appearance: 'light' },
    startLoading: vi.fn((key: string) => activeLoading.add(key)),
    stopLoading: vi.fn((key: string) => activeLoading.delete(key)),
    refreshAuth: vi.fn(async () => undefined),
    showNotification: vi.fn(), showError: vi.fn()
  }
  const fetch = vi.fn(async (url: string, _init?: RequestInit): Promise<Response> => {
    if (url === '/_api/auth/password-policy') return response({ minimum: 12 })
    if (url === '/_api/users/profile') return response(initialProfile)
    if (url === '/_api/locales') return response([])
    throw new Error(`Unexpected profile request: ${url}`)
  })
  ownProperty(browserWindow, 'fetch', fetch)
  const options = evaluate(
    passwordPolicyMixin, newPasswordIssue, placeholder, placeholder, store,
    usersApi.changeProfilePassword, usersApi.fetchProfile, usersApi.removeProfileAvatar,
    usersApi.updateProfile, usersApi.updateProfilePreferences, usersApi.uploadProfileAvatar,
    fetchLocales, {
      ..._,
      delay: (callback: (...args: unknown[]) => unknown, wait: number, ...args: unknown[]) => {
        const timer = _.delay(callback, wait, ...args)
        focusTimers.add(timer)
        return timer
      }
    }, validateValues, resolveThemeName,
    vi.fn(), // Date/time presentation side effects are not a controls contract.
    getErrorMessage
  ) as ComponentOptions
  app = Vue.createApp({ ...options, render })
  fixtureScope = Vue.effectScope()
  const vuetify = fixtureScope.run(() => {
    const installed = createVuetify({ components, directives, theme: { defaultTheme: 'dark' }, defaults: {
      VMenu: { transition: false }, VSelect: { menuProps: { transition: false } }
    } })
    app!.use(installed)
    return installed
  })!
  app.component('v-card-chin', Vue.defineComponent({ setup(_props, { slots }) {
    return () => Vue.h(components.VCardActions, {}, slots)
  } }))
  app.config.globalProperties.$t = translate
  app.config.globalProperties.$helpers = { formatMoment: (date: string) => date }
  componentErrors = []
  app.config.errorHandler = error => componentErrors.push(error)
  const host = document.createElement('div')
  document.body.append(host)
  const vm = app.mount(host) as unknown as {
    loadProfile: () => Promise<boolean>
  }
  await settle()
  return { host, vm, fetch, store, activeLoading, vuetify, componentErrors }
}
const button = (host: ParentNode, name: string) => {
  const matches = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(item => item.getAttribute('aria-label') === name)
  expect(matches).toHaveLength(1)
  return matches[0]!
}
const fill = async (input: HTMLInputElement, value: string) => {
  input.value = value
  input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  await settle()
}
const passwordInputs = (host: HTMLElement) => [...host.querySelectorAll<HTMLInputElement>('form input')]
const fillPasswords = async (host: HTMLElement) => {
  const inputs = passwordInputs(host)
  await fill(inputs[0]!, 'Existing password 42!')
  await fill(inputs[1]!, 'Replacement password 73!')
  await fill(inputs[2]!, 'Replacement password 73!')
}
const deferred = () => {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('profile controls contracts', () => {
  test('localizes all eight field-specific edit names and hides the decorative provider mark', async () => {
    const { host } = await mount()
    for (const field of ['displayName', 'mentionHandle', 'location', 'jobTitle', 'timezone', 'dateFormat', 'timeFormat', 'appearance']) {
      expect(button(host, `Modifier ${translations[`profile:${field}`]}`).disabled).toBe(false)
    }
    const provider = host.querySelector('.profile-auth-provider')!
    expect(provider.textContent).toContain('Compte local')
    expect(provider.querySelector('.profile-auth-provider__mark .v-icon')?.getAttribute('aria-hidden')).toBe('true')
    expect(host.textContent).toContain(translations['profile:auth.provider'])
  })

  test('reveals and conceals each local password independently with localized names', async () => {
    const { host } = await mount()
    const inputs = passwordInputs(host)
    expect(inputs).toHaveLength(3)
    for (const [index, field] of ['currentPassword', 'newPassword', 'verifyPassword'].entries()) {
      const name = translations[`profile:auth.${field}`]
      expect(inputs[index]!.type).toBe('password')
      button(host, `Afficher ${name}`).click()
      await settle()
      expect(inputs[index]!.type).toBe('text')
      for (const other of inputs.filter((_input, otherIndex) => otherIndex !== index)) expect(other.type).toBe('password')
      button(host, `Masquer ${name}`).click()
      await settle()
      expect(inputs[index]!.type).toBe('password')
    }
  })

  test('does not offer local password changes to a provider account', async () => {
    const { host } = await mount(profile({ providerKey: 'oidc', providerName: 'Identity provider' }))
    expect(host.querySelector('form')).toBeNull()
    expect(host.querySelector('button[type="submit"]')).toBeNull()
    expect(host.querySelector('.profile-auth-provider')?.textContent).toContain('Identity provider')
  })

  test('submits the associated password form once while busy and settles success and failure', async () => {
    const { host, fetch, store, activeLoading } = await mount()
    await fillPasswords(host)
    const pending = deferred()
    fetch.mockImplementationOnce(() => pending.promise)
    const submit = host.querySelector<HTMLButtonElement>('button[type="submit"]')!
    const form = host.querySelector<HTMLFormElement>('form')!
    expect(submit.form).toBe(form)
    const initialRequests = fetch.mock.calls.length
    submit.click()
    await settle()
    form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(fetch.mock.calls.slice(initialRequests)).toHaveLength(1)
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('/_api/users/profile/password')
    expect(form.getAttribute('aria-busy')).toBe('true')
    expect(activeLoading.has('profile-changepassword')).toBe(true)
    for (const input of passwordInputs(host)) expect(input.disabled).toBe(true)
    for (const field of ['currentPassword', 'newPassword', 'verifyPassword']) {
      expect(button(host, `Afficher ${translations[`profile:auth.${field}`]}`).disabled).toBe(true)
    }
    expect(submit.disabled).toBe(true)
    pending.resolve(response({ message: 'Password changed' }))
    await settle()
    expect(form.getAttribute('aria-busy')).toBe('false')
    expect(activeLoading.has('profile-changepassword')).toBe(false)
    expect(submit.disabled).toBe(false)
    for (const input of passwordInputs(host)) {
      expect(input.disabled).toBe(false)
      expect(input.value).toBe('')
    }
    expect(store.showNotification).toHaveBeenCalledWith(expect.objectContaining({ style: 'success' }))
    await fillPasswords(host)
    store.showNotification.mockClear()
    fetch.mockRejectedValueOnce(new Error('Password change denied'))
    submit.click()
    await settle()
    expect(store.showError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Password change denied' }))
    expect(store.showNotification).not.toHaveBeenCalled()
    expect(form.getAttribute('aria-busy')).toBe('false')
    expect(activeLoading.has('profile-changepassword')).toBe(false)
    expect(submit.disabled).toBe(false)
    for (const input of passwordInputs(host)) expect(input.disabled).toBe(false)
  })

  test('uploads a selected avatar, revises its preview and permits only internal removal', async () => {
    const { host, fetch, activeLoading } = await mount()
    await intersectAvatar(host)
    expect(host.querySelector('.profile-avatar-preview img')?.getAttribute('src')).toBe('https://provider.example/avatar.png')
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept.split(',').map(value => value.trim()).sort()).toEqual(['image/jpeg', 'image/png', 'image/webp'])
    const upload = button(host, 'Importer un avatar')
    const remove = button(host, 'Supprimer l’avatar')
    expect(remove.disabled).toBe(true)
    expect(host.querySelector('.profile-avatar-actions')?.textContent).toContain(translations['profile:avatar.help'])
    const picker = vi.spyOn(input, 'click')
    try {
      upload.click()
      expect(picker).toHaveBeenCalledTimes(1)
    } finally {
      picker.mockRestore()
    }
    const file = new File(['avatar image'], 'avatar.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    const pending = deferred()
    fetch.mockImplementationOnce(() => pending.promise)
    input.dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
    await settle()
    expect(fetch.mock.calls.at(-1)?.[0]).toBe('/_api/users/profile/avatar')
    expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe('POST')
    expect(input.disabled).toBe(true)
    expect(upload.disabled).toBe(true)
    expect(remove.disabled).toBe(true)
    expect(upload.getAttribute('aria-busy')).toBe('true')
    expect(activeLoading.has('profile-avatar')).toBe(true)
    pending.resolve(response({ message: 'Avatar uploaded', pictureUrl: 'internal' }))
    await settle()
    expect(host.querySelector('.profile-avatar-preview img')?.getAttribute('src')).toBe('/_userav/73?v=1')
    expect(host.querySelector('.profile-avatar-actions [role="status"]')).toBeTruthy()
    expect(remove.disabled).toBe(false)
    expect(upload.disabled).toBe(false)
    expect(activeLoading.has('profile-avatar')).toBe(false)
    const removal = deferred()
    fetch.mockImplementationOnce(() => removal.promise)
    remove.click()
    await settle()
    expect(input.disabled).toBe(true)
    expect(upload.disabled).toBe(true)
    expect(remove.disabled).toBe(true)
    expect(remove.getAttribute('aria-busy')).toBe('true')
    removal.resolve(response({ message: 'Avatar removed', pictureUrl: null }))
    await settle()
    expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
    expect(host.querySelector('.profile-avatar-preview img')).toBeNull()
    expect(remove.disabled).toBe(true)
    expect(host.querySelector('.profile-avatar-actions [role="status"]')).toBeTruthy()
    fetch.mockRejectedValueOnce(new Error('Image upload denied'))
    input.dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
    await settle()
    expect(host.querySelector('.profile-avatar-actions [role="alert"]')?.textContent).toContain('Image upload denied')
    expect(host.querySelector('.profile-avatar-actions [role="status"]')).toBeNull()
    expect(input.disabled).toBe(false)
    expect(upload.disabled).toBe(false)
    expect(activeLoading.has('profile-avatar')).toBe(false)
  })

  test.each([
    ['Sombre', 'dark', 'dark', false], ['Clair', 'light', 'light', false],
    ['Suivre l’appareil', 'system', 'light', true], ['Par défaut', '', 'light', true]
  ] as const)('applies the %s appearance to the installed app while keeping its editor active', async (label, appearance, expectedName, expectedSystem) => {
    const { host, fetch, store, vuetify } = await mount()
    const decoy = fixtureScope!.run(() => createVuetify({ theme: { defaultTheme: 'dark' } }))!
    ownProperty(globalThis, 'WIKI', { $vuetify: decoy })
    const edit = button(host, 'Modifier Apparence')
    edit.click()
    await settle()
    expect(edit.getAttribute('aria-expanded')).toBe('true')
    const editor = document.getElementById(edit.getAttribute('aria-controls')!)!
    expect(editor?.classList.contains('v-overlay--active')).toBe(true)
    const combobox = editor.querySelector<HTMLInputElement>('[role="combobox"]')!
    expect(combobox).not.toBeNull()
    combobox.focus()
    if (appearance === 'dark' || appearance === 'system') {
      combobox.dispatchEvent(new browserWindow.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
    } else {
      combobox.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    }
    await settle()
    expect(edit.getAttribute('aria-expanded')).toBe('true')
    expect(combobox.getAttribute('aria-expanded')).toBe('true')
    const selectMenu = document.getElementById(combobox.getAttribute('aria-controls')!)!
    expect(selectMenu?.classList.contains('v-overlay--active')).toBe(true)
    const listbox = selectMenu.querySelector<HTMLElement>('[role="listbox"]')!
    expect(listbox).not.toBeNull()
    const options = [...listbox.querySelectorAll<HTMLElement>('[role="option"]')]
      .filter(item => item.textContent?.trim() === label)
    expect(options).toHaveLength(1)
    options[0]!.click()
    await settle()
    expect(vuetify.theme.name.value).toBe(expectedName)
    expect(vuetify.theme.current.value.dark).toBe(expectedName === 'dark')
    expect(vuetify.theme.isSystem.value).toBe(expectedSystem)
    expect(decoy.theme.name.value).toBe('dark')
    expect(edit.getAttribute('aria-expanded')).toBe('true')
    expect(editor.classList.contains('v-overlay--active')).toBe(true)
    expect(combobox.getAttribute('aria-expanded')).toBe('false')
    edit.click()
    await settle()
    expect(edit.getAttribute('aria-expanded')).toBe('false')
    const save = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find(item => item.textContent?.trim() === translations['common:actions.save'])!
    expect(save).toBeDefined()
    fetch.mockResolvedValueOnce(response({ message: 'Profile saved' }))
    save.click()
    await settle()
    const request = fetch.mock.calls.at(-1)!
    expect(request[0]).toBe('/_api/users/profile')
    expect(request[1]?.method).toBe('PATCH')
    expect(JSON.parse(request[1]?.body as string).appearance).toBe(appearance)
    expect(store.user.appearance).toBe(appearance)
    expect(save.disabled).toBe(false)
  })

  test('does not replace the installed theme when a failed profile load clears the editor', async () => {
    const { host, vm, fetch, vuetify, componentErrors } = await mount()
    await vuetify.theme.change('dark')
    fetch.mockRejectedValueOnce(new Error('Profile access denied'))
    expect(await vm.loadProfile()).toBe(false)
    await settle()
    expect(host.querySelector('button[aria-label="Modifier Apparence"]')).toBeNull()
    expect(vuetify.theme.name.value).toBe('dark')
    expect(vuetify.theme.isSystem.value).toBe(false)
    expect(componentErrors).toEqual([])
  })
})
