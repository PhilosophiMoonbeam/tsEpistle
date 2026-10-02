import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import type { App, ComponentOptions, EffectScope, RenderFunction } from 'vue'
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
import * as draftModel from './profile-draft.ts'

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
  'updateProfilePreferences', 'uploadProfileAvatar', 'fetchLocales', 'validateValues',
  'resolveThemeName', 'applyUserPresentation', 'getErrorMessage', 'changedProfileFields',
  'PROFILE_DETAIL_FIELDS', 'PROFILE_PREFERENCE_FIELDS', 'profileDraftIssues', 'restoreProfileDraft',
  'restoreProfileField', 'snapshotProfileDraft', 'timezoneOptions', executable
)

const translations: Record<string, string> = {
  'auth:showPassword': 'Afficher le mot de passe',
  'auth:hidePassword': 'Masquer le mot de passe',
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
  'profile:reduceMotion': 'Réduire les animations',
  'profile:auth.provider': 'Fournisseur d’authentification',
  'profile:auth.currentPassword': 'Mot de passe actuel',
  'profile:auth.newPassword': 'Nouveau mot de passe',
  'profile:auth.verifyPassword': 'Confirmer le mot de passe',
  'profile:avatar.upload': 'Importer un avatar',
  'profile:avatar.remove': 'Supprimer l’avatar',
  'profile:avatar.help': 'PNG, JPEG ou WebP ; l’avatar du fournisseur revient à la prochaine connexion.',
  'profile:dock.save': 'Enregistrer les modifications',
  'profile:dock.reset': 'Réinitialiser',
  'profile:dock.clean': 'Aucune modification',
  'profile:dock.unsavedOne': '1 modification non enregistrée',
  'profile:dock.unsavedMany': '{{count}} modifications non enregistrées',
  'profile:dock.fixOne': 'Corrigez 1 champ avant d’enregistrer',
  'profile:discard.confirm': 'Abandonner les modifications',
  'profile:discard.keep': 'Continuer'
}
const translate = (key: string, options: Record<string, unknown> = {}) =>
  String(translations[key] ?? options.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options[name] ?? ''))
const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status, headers: { 'Content-Type': 'application/json' }
})
const profile = (overrides: Partial<Profile> = {}): Profile => ({
  id: 73, email: 'reader@example.test', name: 'Example Reader', handle: 'reader',
  providerKey: 'local', providerName: 'Compte local', pictureUrl: 'https://provider.example/avatar.png',
  isSystem: false, isVerified: true, location: '', jobTitle: '', timezone: 'Europe/Paris',
  dateFormat: '', timeFormat: 'locale', appearance: 'light', reduceMotion: false,
  underlineLinks: false, contentTextSize: 'default', communicationLocale: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
  lastLoginAt: '2026-09-03T00:00:00Z', groups: [], pagesTotal: 0, ...overrides
})
const placeholder = Vue.defineComponent({ render: () => Vue.h('div') })
const AdminHero = Vue.defineComponent({
  props: ['title', 'description', 'icon', 'eyebrow', 'headingId'],
  setup(props, { slots }) {
    return () => Vue.h('header', [Vue.h('h1', { id: props.headingId }, props.title), slots.extra?.(), slots.actions?.()])
  }
})
type ProfileVm = {
  loadProfile: () => Promise<boolean>
  $options: ComponentOptions
}
let app: App | undefined
let fixtureScope: EffectScope | undefined
const restorers: Array<() => void> = []
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
  const applyUserPresentation = vi.fn()
  const options = evaluate(
    passwordPolicyMixin, newPasswordIssue, placeholder, placeholder, store,
    usersApi.changeProfilePassword, usersApi.fetchProfile, usersApi.removeProfileAvatar,
    usersApi.updateProfile, usersApi.updateProfilePreferences, usersApi.uploadProfileAvatar,
    fetchLocales, validateValues, resolveThemeName, applyUserPresentation, getErrorMessage,
    draftModel.changedProfileFields, draftModel.PROFILE_DETAIL_FIELDS, draftModel.PROFILE_PREFERENCE_FIELDS,
    draftModel.profileDraftIssues, draftModel.restoreProfileDraft, draftModel.restoreProfileField,
    draftModel.snapshotProfileDraft, draftModel.timezoneOptions
  ) as ComponentOptions
  app = Vue.createApp({ ...options, render })
  fixtureScope = Vue.effectScope()
  const vuetify = fixtureScope.run(() => {
    const installed = createVuetify({ components, directives, theme: { defaultTheme: 'dark' }, defaults: {
      VMenu: { transition: false }, VSelect: { menuProps: { transition: false } },
      VAutocomplete: { menuProps: { transition: false } }, VDialog: { transition: false }
    } })
    app!.use(installed)
    return installed
  })!
  app.component('admin-hero', AdminHero)
  const router = { push: vi.fn(async (_target: string) => undefined) }
  app.config.globalProperties.$router = router
  app.config.globalProperties.$t = translate
  app.config.globalProperties.$helpers = { formatMoment: (date: string) => date }
  componentErrors = []
  app.config.errorHandler = error => componentErrors.push(error)
  const host = document.createElement('div')
  document.body.append(host)
  const vm = app.mount(host) as unknown as ProfileVm
  await settle()
  return { host, vm, fetch, store, activeLoading, vuetify, componentErrors, applyUserPresentation, router, options }
}
const button = (host: ParentNode, name: string) => {
  const matches = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(item =>
    (item.getAttribute('aria-label') ?? item.textContent?.trim()) === name)
  expect(matches).toHaveLength(1)
  return matches[0]!
}
const field = (host: ParentNode, label: string) => {
  const labels = [...host.querySelectorAll<HTMLLabelElement>('label[for]')].filter(item => item.textContent?.trim() === label)
  expect(labels.length).toBeGreaterThan(0)
  const input = document.getElementById(labels[0]!.htmlFor) as HTMLInputElement | null
  expect(input).not.toBeNull()
  return input!
}
const fill = async (input: HTMLInputElement, value: string) => {
  input.value = value
  input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  await settle()
}
const press = async (target: Element, key: string) => {
  const event = new browserWindow.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  await settle()
  return event
}
const chooseOption = async (host: HTMLElement, label: string, option: string) => {
  const combobox = field(host, label)
  combobox.focus()
  combobox.dispatchEvent(new browserWindow.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }))
  await settle()
  const menu = document.getElementById(combobox.getAttribute('aria-controls')!)
  expect(menu?.classList.contains('v-overlay--active')).toBe(true)
  const matches = [...menu!.querySelectorAll<HTMLElement>('[role="option"]')].filter(item => item.textContent?.trim() === option)
  expect(matches).toHaveLength(1)
  matches[0]!.click()
  await settle()
  return combobox
}
const dockText = (host: HTMLElement) => host.querySelector('.profile-save-dock__copy')?.textContent?.trim()
const saveButton = (host: HTMLElement) => button(host, translations['profile:dock.save']!)
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
const requestsTo = (fetch: { mock: { calls: Array<[string, RequestInit?]> } }, url: string) =>
  fetch.mock.calls.filter(([target, init]) => target === url && init?.method === 'PATCH')

describe('profile workspace contracts', () => {
  test('edits every account field inline with localized labels and hides the decorative provider mark', async () => {
    const { host } = await mount()
    expect(host.querySelector('.v-menu, .v-toolbar')).toBeNull()
    for (const key of ['displayName', 'mentionHandle', 'location', 'jobTitle', 'timezone', 'dateFormat', 'timeFormat', 'appearance']) {
      const input = field(host, translations[`profile:${key}`]!)
      expect(input.disabled).toBe(false)
      expect(input.readOnly).toBe(false)
    }
    expect(field(host, translations['profile:displayName']!).value).toBe('Example Reader')
    const provider = host.querySelector('.profile-auth-provider')!
    expect(provider.textContent).toContain('Compte local')
    expect(provider.querySelector('.profile-auth-provider__mark .v-icon')?.getAttribute('aria-hidden')).toBe('true')
    expect(host.textContent).toContain(translations['profile:auth.provider'])
    expect(dockText(host)).toBe(translations['profile:dock.clean'])
    expect(saveButton(host).getAttribute('aria-disabled')).toBe('true')
    expect(saveButton(host).getAttribute('aria-describedby')).toBe('profile-save-state')
  })

  test('counts unsaved fields in one dock and Reset restores them and the theme preview', async () => {
    const { host, fetch, vuetify, applyUserPresentation } = await mount()
    await vuetify.theme.change('light')
    await fill(field(host, translations['profile:displayName']!), 'Renamed Reader')
    expect(dockText(host)).toBe(translations['profile:dock.unsavedOne'])
    await chooseOption(host, translations['profile:appearance']!, translations['profile:appearanceDark']!)
    expect(vuetify.theme.name.value).toBe('dark')
    await chooseOption(host, translations['profile:dateFormat']!, 'YYYY-MM-DD')
    expect(applyUserPresentation).toHaveBeenLastCalledWith(expect.objectContaining({ dateFormat: 'YYYY-MM-DD' }))
    const reduceMotion = field(host, translations['profile:reduceMotion']!)
    reduceMotion.click()
    await settle()
    expect(dockText(host)).toBe('4 modifications non enregistrées')
    expect(saveButton(host).hasAttribute('aria-disabled')).toBe(false)
    const requests = fetch.mock.calls.length
    button(host, translations['profile:dock.reset']!).click()
    await settle()
    expect(fetch.mock.calls).toHaveLength(requests)
    expect(field(host, translations['profile:displayName']!).value).toBe('Example Reader')
    expect(reduceMotion.checked).toBe(false)
    expect(vuetify.theme.name.value).toBe('light')
    expect(applyUserPresentation).toHaveBeenLastCalledWith(expect.objectContaining({ dateFormat: '' }))
    expect(dockText(host)).toBe(translations['profile:dock.clean'])
    expect([...host.querySelectorAll('button')].some(item => item.textContent?.trim() === translations['profile:dock.reset'])).toBe(false)
  })

  test('Esc restores the saved value of the focused field and lets an open option list close first', async () => {
    const { host, vuetify } = await mount()
    const name = field(host, translations['profile:displayName']!)
    const untouched = await press(name, 'Escape')
    expect(untouched.defaultPrevented).toBe(false)
    await fill(name, 'Typing a new name')
    const revert = await press(name, 'Escape')
    expect(revert.defaultPrevented).toBe(true)
    expect(name.value).toBe('Example Reader')
    expect(dockText(host)).toBe(translations['profile:dock.clean'])

    await vuetify.theme.change('light')
    const appearance = await chooseOption(host, translations['profile:appearance']!, translations['profile:appearanceDark']!)
    expect(vuetify.theme.name.value).toBe('dark')
    appearance.dispatchEvent(new browserWindow.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await settle()
    expect(appearance.getAttribute('aria-expanded')).toBe('true')
    await press(appearance, 'Escape')
    expect(appearance.getAttribute('aria-expanded')).toBe('false')
    expect(vuetify.theme.name.value).toBe('dark')
    await press(appearance, 'Escape')
    expect(vuetify.theme.name.value).toBe('light')
    expect(dockText(host)).toBe(translations['profile:dock.clean'])
  })

  test('saves only the endpoints whose fields changed and keeps a failed part dirty', async () => {
    const { host, fetch, store } = await mount()
    await fill(field(host, translations['profile:mentionHandle']!), '  New_Handle ')
    await fill(field(host, translations['profile:displayName']!), ' Renamed Reader ')
    fetch.mockResolvedValueOnce(response({ message: 'Profile saved' }))
    saveButton(host).click()
    await settle()
    expect(requestsTo(fetch, '/_api/users/profile')).toHaveLength(1)
    expect(requestsTo(fetch, '/_api/users/profile/preferences')).toHaveLength(0)
    const body = JSON.parse(requestsTo(fetch, '/_api/users/profile')[0]![1]!.body as string)
    expect(body).toMatchObject({ name: ' Renamed Reader ', handle: '  New_Handle ', appearance: 'light', timezone: 'Europe/Paris' })
    expect(field(host, translations['profile:mentionHandle']!).value).toBe('new_handle')
    expect(store.user.name).toBe('Renamed Reader')
    expect(store.refreshAuth).toHaveBeenCalledTimes(1)
    expect(store.showNotification).toHaveBeenCalledWith(expect.objectContaining({ style: 'success' }))
    expect(dockText(host)).toBe(translations['profile:dock.clean'])

    await fill(field(host, translations['profile:location']!), 'Lyon')
    field(host, translations['profile:reduceMotion']!).click()
    await settle()
    expect(dockText(host)).toBe('2 modifications non enregistrées')
    fetch.mockResolvedValueOnce(response({ message: 'Profile saved' }))
    fetch.mockRejectedValueOnce(new Error('Preferences unavailable'))
    store.showNotification.mockClear()
    saveButton(host).click()
    await settle()
    expect(requestsTo(fetch, '/_api/users/profile')).toHaveLength(2)
    expect(JSON.parse(requestsTo(fetch, '/_api/users/profile/preferences')[0]![1]!.body as string)).toEqual({
      reduceMotion: true, underlineLinks: false, contentTextSize: 'default', communicationLocale: null
    })
    expect(store.showError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Preferences unavailable' }))
    expect(store.showNotification).not.toHaveBeenCalled()
    expect(dockText(host)).toBe(translations['profile:dock.unsavedOne'])
    expect(saveButton(host).hasAttribute('aria-disabled')).toBe(false)
  })

  test('blocks saving an invalid mention handle and explains why in the dock', async () => {
    const { host, fetch } = await mount()
    const handle = field(host, translations['profile:mentionHandle']!)
    await fill(handle, 'no spaces')
    expect(dockText(host)).toBe(translations['profile:dock.fixOne'])
    const save = saveButton(host)
    expect(save.getAttribute('aria-disabled')).toBe('true')
    expect(save.disabled).toBe(false)
    const requests = fetch.mock.calls.length
    save.click()
    await settle()
    expect(fetch.mock.calls).toHaveLength(requests)
    expect(document.activeElement).toBe(handle)
    expect(host.textContent).toContain('Use 3–32 letters, numbers, underscores or hyphens.')
  })

  test('guards leaving with unsaved changes and restores the saved theme on discard or unmount', async () => {
    const { host, vm, vuetify, router, options, applyUserPresentation } = await mount()
    const leave = options.beforeRouteLeave as (this: unknown, to: { fullPath: string }) => boolean
    expect(leave.call(vm, { fullPath: '/pages' })).toBe(true)
    await vuetify.theme.change('light')
    await chooseOption(host, translations['profile:appearance']!, translations['profile:appearanceDark']!)
    expect(leave.call(vm, { fullPath: '/pages' })).toBe(false)
    await settle()
    button(document, translations['profile:discard.keep']!).click()
    await settle()
    expect(router.push).not.toHaveBeenCalled()
    expect(vuetify.theme.name.value).toBe('dark')

    expect(leave.call(vm, { fullPath: '/pages' })).toBe(false)
    await settle()
    button(document, translations['profile:discard.confirm']!).click()
    await settle()
    expect(vuetify.theme.name.value).toBe('light')
    expect(router.push).toHaveBeenCalledWith('/pages')
    expect(dockText(host)).toBe(translations['profile:dock.clean'])

    const unload = new browserWindow.Event('beforeunload', { cancelable: true })
    browserWindow.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(false)
    await chooseOption(host, translations['profile:dateFormat']!, 'DD.MM.YYYY')
    await chooseOption(host, translations['profile:appearance']!, translations['profile:appearanceDark']!)
    const dirtyUnload = new browserWindow.Event('beforeunload', { cancelable: true })
    browserWindow.dispatchEvent(dirtyUnload)
    expect(dirtyUnload.defaultPrevented).toBe(true)
    app!.unmount()
    app = undefined
    await settle()
    expect(vuetify.theme.name.value).toBe('light')
    expect(applyUserPresentation).toHaveBeenLastCalledWith(expect.objectContaining({ dateFormat: '', appearance: 'light' }))
  })

  test('filters the time zone list as the user types and previews the chosen zone', async () => {
    const { host, applyUserPresentation } = await mount()
    const timezone = field(host, translations['profile:timezone']!)
    timezone.focus()
    await settle()
    await fill(timezone, 'kolk')
    const menu = document.getElementById(timezone.getAttribute('aria-controls')!)
    expect(menu?.classList.contains('v-overlay--active')).toBe(true)
    const options = [...menu!.querySelectorAll<HTMLElement>('[role="option"]')].map(item => item.textContent?.trim())
    expect(options).toEqual(['(GMT+05:30) Asia/Kolkata'])
    ;[...menu!.querySelectorAll<HTMLElement>('[role="option"]')][0]!.click()
    await settle()
    expect(applyUserPresentation).toHaveBeenLastCalledWith(expect.objectContaining({ timezone: 'Asia/Kolkata' }))
    expect(dockText(host)).toBe(translations['profile:dock.unsavedOne'])
  })

  test('reveals and conceals each local password independently with show/hide names', async () => {
    const { host } = await mount()
    const inputs = passwordInputs(host)
    expect(inputs).toHaveLength(3)
    for (const [index, key] of ['currentPassword', 'newPassword', 'verifyPassword'].entries()) {
      const name = translations[`profile:auth.${key}`]
      expect(inputs[index]!.type).toBe('password')
      button(host, `${translations['auth:showPassword']}: ${name}`).click()
      await settle()
      expect(inputs[index]!.type).toBe('text')
      for (const other of inputs.filter((_input, otherIndex) => otherIndex !== index)) expect(other.type).toBe('password')
      button(host, `${translations['auth:hidePassword']}: ${name}`).click()
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

  test('submits the password form on its own once while busy and settles success and failure', async () => {
    const { host, fetch, store, activeLoading } = await mount()
    await fillPasswords(host)
    expect(dockText(host)).toBe(translations['profile:dock.clean'])
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
    expect(submit.disabled).toBe(false)
  })

  test('uploads a selected avatar, revises its preview and offers removal only for an uploaded avatar', async () => {
    const { host, fetch, activeLoading } = await mount()
    await intersectAvatar(host)
    expect(host.querySelector('.profile-avatar-preview img')?.getAttribute('src')).toBe('https://provider.example/avatar.png')
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(input.accept.split(',').map(value => value.trim()).sort()).toEqual(['image/jpeg', 'image/png', 'image/webp'])
    const upload = button(host, 'Importer un avatar')
    const removeButtons = () => [...host.querySelectorAll('button')].filter(item => item.getAttribute('aria-label') === 'Supprimer l’avatar')
    expect(removeButtons()).toHaveLength(0)
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
    expect(upload.getAttribute('aria-busy')).toBe('true')
    expect(activeLoading.has('profile-avatar')).toBe(true)
    pending.resolve(response({ message: 'Avatar uploaded', pictureUrl: 'internal' }))
    await settle()
    expect(host.querySelector('.profile-avatar-preview img')?.getAttribute('src')).toBe('/_userav/73?v=1')
    expect(host.querySelector('.profile-avatar-actions [role="status"]')).toBeTruthy()
    expect(upload.disabled).toBe(false)
    expect(activeLoading.has('profile-avatar')).toBe(false)
    expect(dockText(host)).toBe(translations['profile:dock.clean'])
    const remove = button(host, 'Supprimer l’avatar')
    expect(remove.disabled).toBe(false)
    const removal = deferred()
    fetch.mockImplementationOnce(() => removal.promise)
    remove.click()
    await settle()
    expect(input.disabled).toBe(true)
    expect(upload.disabled).toBe(true)
    expect(remove.getAttribute('aria-busy')).toBe('true')
    removal.resolve(response({ message: 'Avatar removed', pictureUrl: null }))
    await settle()
    expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
    expect(host.querySelector('.profile-avatar-preview img')).toBeNull()
    expect(removeButtons()).toHaveLength(0)
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
  ] as const)('previews the %s appearance on the installed app and saves it from the dock', async (label, appearance, expectedName, expectedSystem) => {
    const { host, fetch, store, vuetify } = await mount(profile({ appearance: appearance === 'light' ? 'dark' : 'light' }))
    const decoy = fixtureScope!.run(() => createVuetify({ theme: { defaultTheme: 'dark' } }))!
    ownProperty(globalThis, 'WIKI', { $vuetify: decoy })
    await chooseOption(host, translations['profile:appearance']!, label)
    expect(vuetify.theme.name.value).toBe(expectedName)
    expect(vuetify.theme.current.value.dark).toBe(expectedName === 'dark')
    expect(vuetify.theme.isSystem.value).toBe(expectedSystem)
    expect(decoy.theme.name.value).toBe('dark')
    expect(dockText(host)).toBe(translations['profile:dock.unsavedOne'])
    fetch.mockResolvedValueOnce(response({ message: 'Profile saved' }))
    saveButton(host).click()
    await settle()
    const request = requestsTo(fetch, '/_api/users/profile').at(-1)!
    expect(JSON.parse(request[1]?.body as string).appearance).toBe(appearance)
    expect(store.user.appearance).toBe(appearance)
    expect(dockText(host)).toBe(translations['profile:dock.clean'])
  })

  test('does not replace the installed theme when a failed profile load clears the editor', async () => {
    const { host, vm, fetch, vuetify, componentErrors } = await mount()
    await vuetify.theme.change('dark')
    fetch.mockRejectedValueOnce(new Error('Profile access denied'))
    expect(await vm.loadProfile()).toBe(false)
    await settle()
    expect(host.querySelector('.profile-save-dock')).toBeNull()
    expect(vuetify.theme.name.value).toBe('dark')
    expect(vuetify.theme.isSystem.value).toBe(false)
    expect(componentErrors).toEqual([])
  })
})
