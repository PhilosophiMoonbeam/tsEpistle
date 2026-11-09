import { babelParse, compileScript, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import { defaultNotificationCeilings, NOTIFICATION_CEILING_CATEGORIES, NOTIFICATION_CEILING_MODES, type NotificationSettingsResponse } from '../../../shared/site-notifications.ts'
import { translateEnglish } from '../../test/english-translate.mts'
import type { App } from 'vue'

// Vue/Vuetify capture DOM globals during evaluation; browser-dom must install them first.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const { VBtn } = await import('vuetify/components')
// This composable imports Vue, so it must also follow DOM installation.
const { useTranslate } = await import('../../helpers/use-translate.ts')
const filename = `${process.cwd()}/client/components/admin/admin-notification-settings.vue`
const parsed = parse(await Bun.file(filename).text(), { filename })
if (parsed.errors.length) throw parsed.errors[0]
// Compile script setup and its actual template together so imported bindings and
// compiler-generated helpers retain the same lexical scope as the production SFC.
const compiled = compileScript(parsed.descriptor, {
  id: 'admin-notification-settings-test', genDefaultAs: 'TestComponent', inlineTemplate: true
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
const mounted: App[] = []
const settle = async () => { for (let pass = 0; pass < 8; pass++) { await Promise.resolve(); await Vue.nextTick() } }
const mount = async () => {
  const store = Vue.reactive({ user: { id: 7, authenticated: true, authVersion: 0 }, offlineIdentityEpoch: 0 })
  let saved: NotificationSettingsResponse = { ceilings: defaultNotificationCeilings(), fingerprint: 'initial' }
  const transport = vi.fn(async (_fetch: unknown, _url: string, init: RequestInit): Promise<Response> => {
    if (init.method === 'PUT') saved = { ...JSON.parse(init.body as string), fingerprint: 'changed' }
    return new Response(JSON.stringify(saved), { headers: { 'Content-Type': 'application/json' } })
  })
  const leave = vi.fn((_guard: () => Promise<boolean>) => undefined)
  const confirm = vi.fn(async () => false)
  const host = document.createElement('div')
  document.body.append(host)
  const component = evaluate({
    '../../store/index.ts': { wikiStore: store },
    '../../helpers/json-transport.ts': { sameOriginJsonFetch: transport },
    '../../helpers/use-translate.ts': { useTranslate },
    'vue-router': { onBeforeRouteLeave: leave },
    '../common/confirm-dialog.ts': { confirmDiscard: confirm },
    '../../../shared/site-notifications.ts': { NOTIFICATION_CEILING_CATEGORIES, NOTIFICATION_CEILING_MODES, defaultNotificationCeilings }
  })
  const app = Vue.createApp(component)
  app.use(createVuetify({ components: { VBtn } }))
  app.config.globalProperties.$t = translateEnglish
  app.mount(host)
  mounted.push(app)
  await settle()
  return { host, store, transport, leave, confirm }
}
const button = (host: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)
  if (!found) throw new Error(`Missing ${text}`)
  return found
}
const choose = async (host: HTMLElement, category: string, value: string) => {
  const select = host.querySelector<HTMLSelectElement>(`#admin-notification-${category}`)!
  select.value = value
  select.dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
  await settle()
}
afterEach(() => { for (const app of mounted.splice(0)) app.unmount(); resetBody() })

describe('administrator notification ceiling drafts', () => {
  it('labels every optional category, keeps changes as drafts, and saves only on explicit submission', async () => {
    const view = await mount()
    expect(view.host.querySelector<HTMLSelectElement>('#admin-notification-feedbackStatus')?.value).toBe('existing-consented-channels')
    expect(view.host.querySelector<HTMLSelectElement>('#admin-notification-reviewReminder')?.value).toBe('existing-consented-channels')
    expect(view.host.querySelector<HTMLSelectElement>('#admin-notification-pageLifecycle')?.value).toBe('existing-consented-channels')
    expect(view.host.querySelector('h2')?.textContent).toBe(translateEnglish('admin:notificationSettings.title'))
    for (const category of NOTIFICATION_CEILING_CATEGORIES) {
      const select = view.host.querySelector<HTMLSelectElement>(`#admin-notification-${category}`)!
      expect(view.host.querySelector(`label[for="${select.id}"]`)?.textContent?.trim()).toBe(translateEnglish(`admin:notificationSettings.categories.${category}`))
      expect([...select.options].map(option => [option.value, option.textContent])).toEqual([
        ['off', translateEnglish('admin:notificationSettings.modes.off')],
        ['in-app-only', translateEnglish('admin:notificationSettings.modes.inAppOnly')],
        ['existing-consented-channels', translateEnglish('admin:notificationSettings.modes.existingConsentedChannels')]
      ])
      expect(select.getAttribute('aria-describedby')).toBe('admin-notification-settings-help')
    }
    await choose(view.host, 'pageWatch', 'off')
    expect(view.transport).toHaveBeenCalledTimes(1)
    expect(button(view.host, 'Reload notification limits').disabled).toBe(true)
    const leaveGuard = view.leave.mock.calls[0]![0] as () => Promise<boolean>
    expect(await leaveGuard()).toBe(false)
    expect(view.confirm).toHaveBeenCalledTimes(1)
    button(view.host, 'Cancel notification changes').click()
    await settle()
    expect(view.host.querySelector<HTMLSelectElement>('#admin-notification-pageWatch')!.value).toBe('existing-consented-channels')
    await choose(view.host, 'mention', 'in-app-only')
    view.host.querySelector('form')!.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(JSON.parse(view.transport.mock.calls[1]![2].body as string)).toMatchObject({ ceilings: { mention: 'in-app-only', pageWatch: 'existing-consented-channels' }, fingerprint: 'initial' })
    expect(view.host.textContent).toContain('Notification limits saved.')
    expect(button(view.host, 'Save notification limits').disabled).toBe(true)
  })

  it('retires a pending save when identity changes and ignores its late response', async () => {
    const view = await mount()
    const pending = Promise.withResolvers<Response>()
    view.transport.mockImplementationOnce(() => pending.promise)
    await choose(view.host, 'pageWatch', 'off')
    view.host.querySelector('form')!.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    const signal = view.transport.mock.calls[1]![2].signal!
    view.store.user.authenticated = false
    await settle()
    expect(signal.aborted).toBe(true)
    pending.resolve(new Response(JSON.stringify({ ceilings: defaultNotificationCeilings(), fingerprint: 'late' })))
    await settle()
    expect(view.host.querySelector('form')).toBeNull()
    expect(view.host.textContent).not.toContain('Notification limits saved.')
  })
})
