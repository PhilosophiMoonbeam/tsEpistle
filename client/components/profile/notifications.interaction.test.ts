import fs from 'node:fs'
import path from 'node:path'
import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { notificationIdentityInvalidated } from '../../helpers/site-notifications-api.ts'
import { OFFLINE_SESSION_INVALIDATED_EVENT } from '../../helpers/offline-session.ts'
import { NOTIFICATION_CATEGORIES, defaultNotificationCeilings, type NotificationPreferences, type NotificationPreferencesPatch, type NotificationPreferencesResponse } from '../../../shared/site-notifications.ts'
import type { App, Component } from 'vue'

// Vue/Vuetify must evaluate after browser-dom installs the test document.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
// This composable imports Vue, so it must also follow DOM installation.
const { useTranslate } = await import('../../helpers/use-translate.ts')

// Compile the real shared heading, including its actions/extra slots.
Bun.plugin({
  name: 'notification-preferences-heading',
  setup(builder) {
    builder.onLoad({ filter: /\/admin-hero\.vue$/ }, async ({ path: filename }) => {
      const { descriptor } = parse(await Bun.file(filename).text(), { filename })
      const compiled = compileScript(descriptor, {
        id: 'notification-preferences-heading',
        genDefaultAs: '__component',
        inlineTemplate: true,
        templateOptions: { preprocessLang: descriptor.template?.lang, preprocessOptions: { doctype: 'html' } }
      })
      return { loader: 'ts', contents: `${compiled.content}\nexport default __component;` }
    })
  }
})
// The heading SFC must load after its compiler loader is registered.
const AdminHero = (await import('../common/admin-hero.vue')).default as Component
const filename = path.join(process.cwd(), 'client/components/profile/notifications.vue')
const parsed = parse(fs.readFileSync(filename, 'utf8'), { filename })
if (parsed.errors.length) throw parsed.errors[0]
// Keep actual setup, imported bindings and the Pug template in one compiler-owned
// lexical scope; isolate only the store and HTTP boundary.
const compiled = compileScript(parsed.descriptor, {
  id: 'notification-preferences',
  genDefaultAs: 'TestComponent',
  inlineTemplate: true,
  templateOptions: { preprocessLang: parsed.descriptor.template?.lang, preprocessOptions: { doctype: 'html' } }
})
const imports = babelParse(compiled.content, { sourceType: 'module', plugins: ['typescript'] }).program.body.filter(node => node.type === 'ImportDeclaration')
let script = compiled.content
for (const declaration of [...imports].reverse()) script = script.slice(0, declaration.start!) + script.slice(declaration.end!)
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(`${script}\nreturn TestComponent`)
const evaluate = (modules: Record<string, Record<string, unknown>>) => {
  const bindings: Record<string, unknown> = {}
  for (const declaration of imports) {
    if (declaration.importKind === 'type') continue
    const module: Record<string, unknown> | undefined = declaration.source.value === 'vue' ? Vue : modules[declaration.source.value]
    if (!module) throw new Error(`Missing component dependency: ${declaration.source.value}`)
    for (const specifier of declaration.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') continue
      bindings[specifier.local.name] = specifier.type === 'ImportDefaultSpecifier' ? module.default :
        specifier.type === 'ImportNamespaceSpecifier' ? module :
          module[specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value]
    }
  }
  return new Function(...Object.keys(bindings), executable)(...Object.values(bindings))
}
const mounted: Array<{ app: App; host: HTMLElement }> = []
const settle = async () => {
  for (let pass = 0; pass < 6; pass++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}
const preferences = (): NotificationPreferences => ({
  pageCreated: { inApp: true, email: false },
  pageDeleted: { inApp: false, email: true },
  watchedPageComment: { inApp: true, email: false },
  commentReply: { inApp: false, email: false },
  mention: { inApp: false, email: false },
  feedbackStatus: { inApp: false, email: false },
  reviewReminder: { inApp: false, email: false },
  pageLifecycle: { inApp: false, email: false }
})
function mount(ceilings = defaultNotificationCeilings()) {
  const store = Vue.reactive({
    user: { id: 7, authenticated: true, authVersion: 1 },
    offlineIdentityEpoch: 0,
    refreshAuth: vi.fn(async (): Promise<'authenticated' | 'unavailable'> => 'authenticated')
  })
  const stored = preferences()
  const load = vi.fn(async () => ({ ownerId: 7, preferences: stored, ceilings }))
  const save = vi.fn(
    async (_owner: number, draft: NotificationPreferencesPatch, _signal: AbortSignal, stopAllEmail = false): Promise<NotificationPreferencesResponse> => {
      for (const category of NOTIFICATION_CATEGORIES) {
        stored[category] = { ...stored[category], ...draft[category] }
        if (stopAllEmail) stored[category].email = false
      }
      return { ownerId: 7, preferences: stored, ceilings }
    }
  )
  const host = document.createElement('div')
  document.body.append(host)
  const component = evaluate({
    '../common/admin-hero.vue': { default: AdminHero },
    '../../store/index.ts': { wikiStore: store },
    '../../helpers/use-translate.ts': { useTranslate },
    '../../../shared/site-notifications.ts': { NOTIFICATION_CATEGORIES, defaultNotificationCeilings },
    '../../helpers/offline-session.ts': { OFFLINE_SESSION_INVALIDATED_EVENT },
    '../../helpers/site-notifications-api.ts': {
      notificationIdentityInvalidated,
      fetchNotificationPreferences: load,
      updateNotificationPreferences: save
    }
  })
  const app = Vue.createApp(component)
  app.use(createVuetify({ components, directives }))
  app.config.globalProperties.$t = translateEnglish
  app.mount(host)
  mounted.push({ app, host })
  return { host, store, load, save }
}
const button = (root: ParentNode, label: string): HTMLButtonElement => {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  if (!found) throw new Error(`Missing control: ${label}`)
  return found
}
const bulk = (host: HTMLElement, channel: 'in-app' | 'email') => host.querySelector<HTMLInputElement>(`#profile-notifications-${channel} input`)!
const rows = (host: HTMLElement, channel: 'inApp' | 'email') =>
  [...host.querySelectorAll<HTMLTableRowElement>('tbody tr')].map(row => row.querySelectorAll<HTMLInputElement>('input')[channel === 'inApp' ? 0 : 1]!.checked)
const submit = async (form: HTMLFormElement) => {
  form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
  await settle()
}
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount()
    host.remove()
  }
  resetBody()
})

describe('notification preference drafts', () => {
  it('preserves limited choices on ordinary sparse saves and drafts an explicit hidden-category email opt-out', async () => {
    const ceilings = { ...defaultNotificationCeilings(), pageDeleted: 'off' as const, watchedPageComment: 'in-app-only' as const }
    const view = mount(ceilings)
    await settle()
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(view.host.querySelector(`#profile-notifications-${category}-label`)?.textContent).toBe(translateEnglish(`profile:notificationPreferences.categories.${category}.label`))
      expect(view.host.querySelector(`#profile-notifications-${category}-description`)?.textContent).toBe(translateEnglish(`profile:notificationPreferences.categories.${category}.description`))
    }
    expect(bulk(view.host, 'in-app').getAttribute('aria-label')).toBe(translateEnglish('profile:notificationPreferences.bulkPermittedInApp'))
    expect(bulk(view.host, 'email').getAttribute('aria-label')).toBe(translateEnglish('profile:notificationPreferences.bulkPermittedEmail'))
    expect(view.host.querySelector('#profile-notifications-pageDeleted-ceiling')?.textContent).toBe(translateEnglish('profile:notificationPreferences.ceilingOff'))
    expect(view.host.querySelector('#profile-notifications-watchedPageComment-ceiling')?.textContent).toBe(translateEnglish('profile:notificationPreferences.ceilingInAppOnly'))
    expect(view.host.querySelector('#profile-notifications-mention-ceiling')?.textContent).toBe(translateEnglish('profile:notificationPreferences.ceilingExistingConsentedChannels'))
    const hiddenEmail = view.host.querySelector<HTMLInputElement>('tbody tr:nth-child(2) td:nth-child(3) input')!
    expect(hiddenEmail.disabled).toBe(true)
    expect(hiddenEmail.checked).toBe(false)
    bulk(view.host, 'in-app').click()
    await settle()
    await submit(view.host.querySelector('form')!)
    expect(view.save.mock.calls[0]?.[1]).not.toHaveProperty('pageDeleted')
    expect(view.save.mock.calls[0]?.[3]).toBe(false)
    button(view.host, 'Stop all optional notification email').click()
    await settle()
    expect(view.save).toHaveBeenCalledTimes(1)
    expect(view.host.textContent).toContain(translateEnglish('profile:notificationPreferences.stopAllEmailDraft'))
    expect(bulk(view.host, 'email').disabled).toBe(true)
    button(view.host, 'Cancel changes').click()
    await settle()
    expect(button(view.host, 'Save preferences').disabled).toBe(true)
    button(view.host, 'Stop all optional notification email').click()
    await settle()
    await submit(view.host.querySelector('form')!)
    expect(view.save.mock.calls[1]?.[3]).toBe(true)
    expect(view.host.textContent).toContain('Notification preferences saved.')
  })

  it('explains an entirely limited matrix while retaining an explicit email opt-out draft', async () => {
    const ceilings = {
      ...defaultNotificationCeilings(),
      pageCreated: 'off' as const,
      pageDeleted: 'off' as const,
      watchedPageComment: 'off' as const,
      commentReply: 'off' as const,
      mention: 'off' as const,
      feedbackStatus: 'off' as const,
      reviewReminder: 'off' as const,
      pageLifecycle: 'off' as const,
      pageWatch: 'in-app-only' as const
    }
    const view = mount(ceilings)
    await settle()
    for (const channel of ['in-app', 'email'] as const) {
      expect(bulk(view.host, channel).disabled).toBe(true)
      expect(view.host.querySelector(`#profile-notifications-${channel}-count`)?.textContent).toBe(translateEnglish('profile:notificationPreferences.bulkUnavailable'))
    }
    expect(view.host.textContent).toContain(translateEnglish('profile:notificationPreferences.existingWatches', {
      limit: translateEnglish('profile:notificationPreferences.ceilingInAppOnly')
    }))
    for (const category of ['pageCreated', 'pageDeleted', 'watchedPageComment', 'commentReply', 'mention', 'feedbackStatus', 'reviewReminder', 'pageLifecycle']) {
      const row = view.host.querySelector(`#profile-notifications-${category}`)?.closest('tr')
      expect(row).not.toBeNull()
      for (const input of row!.querySelectorAll<HTMLInputElement>('input')) {
        expect(input.checked).toBe(false)
        expect(input.disabled).toBe(true)
      }
    }
    bulk(view.host, 'in-app').checked = true
    bulk(view.host, 'in-app').dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
    await settle()
    expect(button(view.host, 'Save preferences').disabled).toBe(true)
    expect(view.save).toHaveBeenCalledTimes(0)
    button(view.host, 'Stop all optional notification email').click()
    await settle()
    expect(view.save).toHaveBeenCalledTimes(0)
    await submit(view.host.querySelector('form')!)
    expect(view.save.mock.calls[0]?.[1]).toEqual({})
    expect(view.save.mock.calls[0]?.[3]).toBe(true)
    expect(button(view.host, 'Save preferences').disabled).toBe(true)
  })

  it('bulk switches expose partial/all/none counts, isolate channels and do not persist until Save', async () => {
    const view = mount()
    await settle()
    expect(view.host.querySelector('#profile-notifications-in-app-count')?.textContent).toBe(
      translateEnglish('profile:notificationPreferences.bulkMixed', { selected: 2, total: view.host.querySelectorAll('tbody tr').length })
    )
    expect(bulk(view.host, 'in-app').checked).toBe(false)
    const emailBefore = rows(view.host, 'email')
    bulk(view.host, 'in-app').click()
    await settle()
    expect(rows(view.host, 'inApp').every(Boolean)).toBe(true)
    expect(rows(view.host, 'email')).toEqual(emailBefore)
    expect(view.host.querySelector('#profile-notifications-in-app-count')?.textContent).toBe(
      translateEnglish('profile:notificationPreferences.bulkAll', { selected: rows(view.host, 'inApp').length, total: rows(view.host, 'inApp').length })
    )
    expect(view.save).toHaveBeenCalledTimes(0)
    bulk(view.host, 'in-app').click()
    await settle()
    expect(rows(view.host, 'inApp').some(Boolean)).toBe(false)
    expect(rows(view.host, 'email')).toEqual(emailBefore)
    expect(view.host.querySelector('#profile-notifications-in-app-count')?.textContent).toBe(
      translateEnglish('profile:notificationPreferences.bulkNone', { selected: 0, total: rows(view.host, 'inApp').length })
    )
    bulk(view.host, 'email').click()
    await settle()
    expect(rows(view.host, 'inApp').some(Boolean)).toBe(false)
    expect(rows(view.host, 'email').every(Boolean)).toBe(true)
    expect(view.save).toHaveBeenCalledTimes(0)
    expect(button(view.host, 'Save preferences').getAttribute('data-commitment')).toBe('active')
    const reload = view.host.querySelector<HTMLButtonElement>('.admin-hero__actions button')!
    expect(reload.disabled).toBe(true)
    reload.dispatchEvent(new browserWindow.MouseEvent('click', { bubbles: true }))
    await settle()
    expect(view.store.refreshAuth).toHaveBeenCalledTimes(0)
    expect(rows(view.host, 'email').every(Boolean)).toBe(true)
    await submit(view.host.querySelector('form')!)
    expect(view.save.mock.calls[0]?.[1]).toEqual({
      pageCreated: { inApp: false, email: true },
      watchedPageComment: { inApp: false, email: true },
      commentReply: { email: true },
      mention: { email: true },
      feedbackStatus: { email: true },
      reviewReminder: { email: true },
      pageLifecycle: { email: true }
    })
    expect(button(view.host, 'Save preferences').disabled).toBe(true)
    expect(view.host.textContent).toContain('Notification preferences saved.')
  })

  it('Cancel restores both channels and a failed Save retains a retryable draft while pending handlers are fenced', async () => {
    const view = mount()
    await settle()
    bulk(view.host, 'in-app').click()
    bulk(view.host, 'email').click()
    await settle()
    button(view.host, 'Cancel changes').click()
    await settle()
    expect(view.host.querySelector<HTMLInputElement>('#profile-notifications-pageCreated')?.closest('tr')?.querySelector('input')?.checked).toBe(true)
    for (const category of ['feedbackStatus', 'reviewReminder', 'pageLifecycle']) {
      const inputs = view.host.querySelector(`#profile-notifications-${category}`)!.closest('tr')!.querySelectorAll<HTMLInputElement>('input')
      expect([...inputs].every(input => !input.checked)).toBe(true)
    }
    expect(view.save).toHaveBeenCalledTimes(0)
    const pending = Promise.withResolvers<NotificationPreferencesResponse>()
    view.save.mockImplementationOnce(() => pending.promise)
    bulk(view.host, 'email').click()
    await settle()
    const form = view.host.querySelector('form')!
    await submit(form)
    expect(bulk(view.host, 'in-app').disabled).toBe(true)
    expect(button(view.host, 'Cancel changes').disabled).toBe(true)
    // Programmatic events bypass native disabled handling: production must fence them too.
    bulk(view.host, 'in-app').checked = true
    bulk(view.host, 'in-app').dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
    view.host.querySelector('.admin-hero__actions button')!.dispatchEvent(new browserWindow.MouseEvent('click', { bubbles: true }))
    await submit(form)
    expect(view.save).toHaveBeenCalledTimes(1)
    expect(view.store.refreshAuth).toHaveBeenCalledTimes(0)
    pending.reject(new Error('Delivery settings service unavailable'))
    await settle()
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Delivery settings service unavailable')
    expect(view.host.querySelector('#profile-notifications-pageCreated')!.closest('tr')!.querySelector<HTMLInputElement>('input')!.checked).toBe(true)
    expect(view.host.querySelector('#profile-notifications-pageDeleted')!.closest('tr')!.querySelector<HTMLInputElement>('input')!.checked).toBe(false)
    expect(rows(view.host, 'email').every(Boolean)).toBe(true)
    expect(button(view.host, 'Save preferences').disabled).toBe(false)
    await submit(form)
    expect(view.save).toHaveBeenCalledTimes(2)
    expect(view.host.textContent).toContain('Notification preferences saved.')
  })

  it('account loss aborts a pending save and its late receipt cannot restore the previous account draft', async () => {
    const view = mount()
    await settle()
    const pending = Promise.withResolvers<NotificationPreferencesResponse>()
    view.save.mockImplementationOnce(() => pending.promise)
    bulk(view.host, 'email').click()
    await settle()
    await submit(view.host.querySelector('form')!)
    const signal = view.save.mock.calls[0]![2]
    view.store.user.authenticated = false
    await settle()
    expect(signal.aborted).toBe(true)
    pending.resolve({ ownerId: 7, preferences: preferences(), ceilings: defaultNotificationCeilings() })
    await settle()
    expect(view.host.querySelector('form')).toBeNull()
    expect(view.host.textContent).toContain('Sign in to manage notifications.')
    expect(view.host.textContent).not.toContain('Notification preferences saved.')
  })

  it('session invalidation removes a dirty form and requires successful identity verification before reloading', async () => {
    const view = mount()
    await settle()
    bulk(view.host, 'email').click()
    await settle()
    const form = view.host.querySelector('form')!
    browserWindow.dispatchEvent(new browserWindow.Event(OFFLINE_SESSION_INVALIDATED_EVENT))
    await settle()
    expect(view.host.querySelector('form')).toBeNull()
    await submit(form)
    expect(view.save).toHaveBeenCalledTimes(0)
    expect(view.load).toHaveBeenCalledTimes(1)
    view.store.refreshAuth.mockResolvedValueOnce('unavailable')
    button(view.host, 'Refresh preferences').click()
    await settle()
    expect(view.host.querySelector('form')).toBeNull()
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Your account could not be verified')
    expect(view.load).toHaveBeenCalledTimes(1)
    const verification = Promise.withResolvers<'authenticated'>()
    view.store.refreshAuth.mockImplementationOnce(() => verification.promise)
    button(view.host, 'Refresh preferences').click()
    await settle()
    expect(view.host.querySelector('form')).toBeNull()
    expect(view.load).toHaveBeenCalledTimes(1)
    verification.resolve('authenticated')
    await settle()
    expect(view.load).toHaveBeenCalledTimes(2)
    for (const category of ['feedbackStatus', 'reviewReminder', 'pageLifecycle']) {
      expect([...view.host.querySelector(`#profile-notifications-${category}`)!.closest('tr')!.querySelectorAll<HTMLInputElement>('input')].some(input => input.checked)).toBe(false)
    }
    expect(button(view.host, 'Save preferences').disabled).toBe(true)
  })
})
