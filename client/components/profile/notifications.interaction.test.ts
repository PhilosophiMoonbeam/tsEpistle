import fs from 'node:fs'
import path from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { notificationIdentityInvalidated } from '../../helpers/site-notifications-api.ts'
import { OFFLINE_SESSION_INVALIDATED_EVENT } from '../../helpers/offline-session.ts'
import { NOTIFICATION_CATEGORIES, type NotificationPreferences, type NotificationPreferencesResponse } from '../../../shared/site-notifications.ts'
import type { App, Component, RenderFunction } from 'vue'

// Vue/Vuetify must evaluate after browser-dom installs the test document.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')

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
const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
const metadata = compileScript(descriptor, { id: 'notification-preferences' })
const script = descriptor.scriptSetup!.content
const parts: string[] = []
let end = 0
for (const statement of metadata.scriptSetupAst!) {
  if (statement.type !== 'ImportDeclaration') continue
  parts.push(script.slice(end, statement.start!))
  end = statement.end!
}
parts.push(script.slice(end))
const executable = new Bun.Transpiler({ loader: 'ts' }).transformSync(parts.join(''))
const bindings = Object.keys(metadata.bindings!).filter(name => !metadata.imports?.[name])
const evaluate = new Function(`{ ${[...Object.keys(metadata.imports!), 'defineOptions'].join(', ')} }`, `${executable}\nreturn { ${bindings.join(', ')} }`)
const template = compileTemplate({
  source: descriptor.template!.content,
  filename,
  id: 'notification-preferences',
  preprocessLang: descriptor.template!.lang,
  preprocessOptions: { doctype: 'html' },
  compilerOptions: { mode: 'function' }
})
if (template.errors.length) throw template.errors[0]
const render = new Function('Vue', template.code)(Vue) as RenderFunction
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
  mention: { inApp: false, email: false }
})
function mount() {
  const store = Vue.reactive({
    user: { id: 7, authenticated: true, authVersion: 1 },
    offlineIdentityEpoch: 0,
    refreshAuth: vi.fn(async (): Promise<'authenticated' | 'unavailable'> => 'authenticated')
  })
  const load = vi.fn(async () => ({ ownerId: 7, preferences: preferences() }))
  const save = vi.fn(
    async (_owner: number, draft: NotificationPreferences, _signal: AbortSignal): Promise<NotificationPreferencesResponse> => ({
      ownerId: 7,
      preferences: draft
    })
  )
  const host = document.createElement('div')
  document.body.append(host)
  const component = Vue.defineComponent({
    components: { AdminHero },
    setup: () =>
      evaluate({
        ...Vue,
        AdminHero,
        wikiStore: store,
        translate: translateEnglish,
        NOTIFICATION_CATEGORIES,
        OFFLINE_SESSION_INVALIDATED_EVENT,
        notificationIdentityInvalidated,
        fetchNotificationPreferences: load,
        updateNotificationPreferences: save,
        defineOptions: () => undefined
      }),
    render
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
  it('bulk switches expose partial/all/none counts, isolate channels and do not persist until Save', async () => {
    const view = mount()
    await settle()
    expect(view.host.querySelector('#profile-notifications-in-app-count')?.textContent).toBe(
      translateEnglish('profile:notificationPreferences.bulkMixed', { selected: 2, total: 5 })
    )
    expect(bulk(view.host, 'in-app').checked).toBe(false)
    const emailBefore = rows(view.host, 'email')
    bulk(view.host, 'in-app').click()
    await settle()
    expect(rows(view.host, 'inApp')).toEqual([true, true, true, true, true])
    expect(rows(view.host, 'email')).toEqual(emailBefore)
    expect(view.host.querySelector('#profile-notifications-in-app-count')?.textContent).toBe(
      translateEnglish('profile:notificationPreferences.bulkAll', { selected: 5, total: 5 })
    )
    expect(view.save).toHaveBeenCalledTimes(0)
    bulk(view.host, 'in-app').click()
    await settle()
    expect(rows(view.host, 'inApp')).toEqual([false, false, false, false, false])
    expect(rows(view.host, 'email')).toEqual(emailBefore)
    expect(view.host.querySelector('#profile-notifications-in-app-count')?.textContent).toBe(
      translateEnglish('profile:notificationPreferences.bulkNone', { selected: 0, total: 5 })
    )
    bulk(view.host, 'email').click()
    await settle()
    expect(rows(view.host, 'inApp')).toEqual([false, false, false, false, false])
    expect(rows(view.host, 'email')).toEqual([true, true, true, true, true])
    expect(view.save).toHaveBeenCalledTimes(0)
    expect(button(view.host, 'Save preferences').getAttribute('data-commitment')).toBe('active')
    const reload = view.host.querySelector<HTMLButtonElement>('.admin-hero__actions button')!
    expect(reload.disabled).toBe(true)
    reload.dispatchEvent(new browserWindow.MouseEvent('click', { bubbles: true }))
    await settle()
    expect(view.store.refreshAuth).toHaveBeenCalledTimes(0)
    expect(rows(view.host, 'email')).toEqual([true, true, true, true, true])
    await submit(view.host.querySelector('form')!)
    expect(view.save.mock.calls[0]?.[1]).toEqual({
      pageCreated: { inApp: false, email: true },
      pageDeleted: { inApp: false, email: true },
      watchedPageComment: { inApp: false, email: true },
      commentReply: { inApp: false, email: true },
      mention: { inApp: false, email: true }
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
    expect(rows(view.host, 'inApp')).toEqual([true, false, true, false, false])
    expect(rows(view.host, 'email')).toEqual([false, true, false, false, false])
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
    expect(rows(view.host, 'inApp')).toEqual([true, false, true, false, false])
    expect(rows(view.host, 'email')).toEqual([true, true, true, true, true])
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
    pending.resolve({ ownerId: 7, preferences: preferences() })
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
    expect(rows(view.host, 'email')).toEqual([false, true, false, false, false])
    expect(button(view.host, 'Save preferences').disabled).toBe(true)
  })
})
