import fs from 'node:fs'
import path from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, describe, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import { translateEnglish } from '../../test/english-translate.mts'
import { notificationIdentityInvalidated, notificationPageHref } from '../../helpers/site-notifications-api.ts'
import { OFFLINE_SESSION_INVALIDATED_EVENT } from '../../helpers/offline-session.ts'
import type { MyDiscussionsPage } from '../../../shared/discussion-annotations.ts'
import type { App, Component, RenderFunction } from 'vue'

// Vue/Vuetify must capture browser-dom's installed document before evaluation.
const Vue = await import('vue')
const { createVuetify } = await import('vuetify')
const components = await import('vuetify/components')
const directives = await import('vuetify/directives')
const { createRouter, createMemoryHistory } = await import('vue-router')
Bun.plugin({
  name: 'profile-discussions-shared-components',
  setup(builder) {
    builder.onLoad({ filter: /\/(?:admin-hero|async-state)\.vue$/ }, async ({ path: filename }) => {
      const { descriptor } = parse(await Bun.file(filename).text(), { filename })
      const compiled = compileScript(descriptor, {
        id: path.basename(filename, '.vue'),
        genDefaultAs: '__component',
        inlineTemplate: true,
        templateOptions: { preprocessLang: descriptor.template?.lang, preprocessOptions: { doctype: 'html' } }
      })
      return { loader: 'ts', contents: `${compiled.content}\nexport default __component;` }
    })
  }
})
// These SFC imports must wait for the compiler loader above.
const AdminHero = (await import('../common/admin-hero.vue')).default as Component
const AsyncState = (await import('../common/async-state.vue')).default as Component
const filename = path.join(process.cwd(), 'client/components/profile/discussions.vue')
const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
const metadata = compileScript(descriptor, { id: 'profile-discussions' })
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
const bindings = Object.keys(metadata.bindings!)
const evaluate = new Function(`{ ${[...Object.keys(metadata.imports!), 'defineOptions'].join(', ')} }`, `${executable}\nreturn { ${bindings.join(', ')} }`)
const template = compileTemplate({
  source: descriptor.template!.content,
  filename,
  id: 'profile-discussions',
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
function mount(read: () => Promise<MyDiscussionsPage>, outcome: 'authenticated' | 'unavailable' = 'authenticated') {
  const store = Vue.reactive({
    user: { id: 7, authenticated: true, authVersion: 1 },
    offlineIdentityEpoch: 0,
    authRefreshOutcome: outcome,
    refreshAuth: vi.fn(async () => 'authenticated' as const)
  })
  const load = vi.fn((_owner: number, _cursor: string | null, _signal: AbortSignal) => read())
  const host = document.createElement('div')
  document.body.append(host)
  const component = Vue.defineComponent({
    components: { AdminHero, AsyncState },
    setup: () =>
      evaluate({
        ...Vue,
        AdminHero,
        AsyncState,
        wikiStore: store,
        OFFLINE_SESSION_INVALIDATED_EVENT,
        notificationIdentityInvalidated,
        notificationPageHref,
        fetchMyDiscussions: load,
        defineOptions: () => undefined
      }),
    render
  })
  const app = Vue.createApp(component)
  app.use(createVuetify({ components, directives }))
  app.use(
    createRouter({
      history: createMemoryHistory('/p'),
      routes: [{ path: '/:pathMatch(.*)*', component: Vue.defineComponent({ render: () => null }) }]
    })
  )
  app.config.globalProperties.$t = translateEnglish
  app.mount(host)
  mounted.push({ app, host })
  return { host, store, load }
}
const button = (host: HTMLElement, label: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)
  if (!found) throw new Error(`Missing control: ${label}`)
  return found
}
afterEach(() => {
  for (const { app, host } of mounted.splice(0)) {
    app.unmount()
    host.remove()
  }
  resetBody()
})

describe('discussion terminal-empty presentation', () => {
  it('offers Browse pages only after an authenticated, successful terminal empty response, not while loading', async () => {
    const pending = Promise.withResolvers<MyDiscussionsPage>()
    const view = mount(() => pending.promise)
    await settle()
    expect(view.host.textContent).toContain('Loading your discussions')
    expect(view.host.querySelector('.async-state--empty')).toBeNull()
    expect(view.host.querySelector('a[href="/t"]')).toBeNull()
    pending.resolve({ items: [], nextCursor: null })
    await settle()
    const empty = view.host.querySelector('.async-state--empty')!
    expect(empty.getAttribute('role')).toBe('status')
    expect(empty.textContent).toContain('No readable contributions')
    expect(empty.querySelector('a')?.getAttribute('href')).toBe('/t')
    expect(empty.querySelector('a')?.textContent?.trim()).toBe('Browse pages')
    expect(view.host.textContent).not.toContain('Loading your discussions')
    expect(view.host.querySelector('.profile-discussions__list')).toBeNull()
  })

  it('does not claim empty after a failed read and transitions to empty only after successful recovery', async () => {
    const view = mount(async () => {
      throw new Error('Discussion service unavailable')
    })
    await settle()
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Discussion service unavailable')
    expect(view.host.querySelector('.async-state--empty')).toBeNull()
    const recovery = Promise.withResolvers<MyDiscussionsPage>()
    view.load.mockImplementationOnce(() => recovery.promise)
    button(view.host, 'Refresh discussions').click()
    await settle()
    expect(view.host.querySelector('.async-state--empty')).toBeNull()
    expect(view.host.textContent).toContain('Loading your discussions')
    recovery.resolve({ items: [], nextCursor: null })
    await settle()
    expect(view.host.querySelector('[role="alert"]')).toBeNull()
    expect(view.host.querySelector('.async-state--empty')).not.toBeNull()
  })

  it('keeps an unread next window actionable across failure instead of treating an empty page as terminal', async () => {
    const view = mount(async () => ({ items: [], nextCursor: 'remaining-window' }))
    await settle()
    expect(view.host.querySelector('.async-state--empty')).toBeNull()
    expect(button(view.host, 'Check next window').disabled).toBe(false)
    const next = Promise.withResolvers<MyDiscussionsPage>()
    view.load.mockImplementationOnce(() => next.promise)
    button(view.host, 'Check next window').click()
    await settle()
    expect(view.load.mock.calls[1]?.[1]).toBe('remaining-window')
    expect(button(view.host, 'Check next window').disabled).toBe(true)
    expect(view.host.querySelector('.async-state--empty')).toBeNull()
    next.reject(new Error('Next window unavailable'))
    await settle()
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Next window unavailable')
    expect(view.host.querySelector('.async-state--empty')).toBeNull()
    expect(button(view.host, 'Check next window').disabled).toBe(false)
    view.load.mockResolvedValueOnce({ items: [], nextCursor: null })
    button(view.host, 'Check next window').click()
    await settle()
    expect(view.load.mock.calls[2]?.[1]).toBe('remaining-window')
    expect(view.host.querySelector('.async-state--empty')).not.toBeNull()
    expect(view.host.textContent).not.toContain('Check next window')
  })

  it('never substitutes terminal empty for unavailable identity or an invalidated in-flight response', async () => {
    const view = mount(async () => ({ items: [], nextCursor: null }), 'unavailable')
    await settle()
    expect(view.host.querySelector('.async-state--empty')).toBeNull()
    view.store.authRefreshOutcome = 'authenticated'
    await settle()
    expect(view.host.querySelector('.async-state--empty')).not.toBeNull()
    const pending = Promise.withResolvers<MyDiscussionsPage>()
    view.load.mockImplementationOnce(() => pending.promise)
    view.host.querySelector<HTMLButtonElement>('.admin-hero__actions button')!.click()
    await settle()
    const signal = view.load.mock.calls[1]![2]
    browserWindow.dispatchEvent(new browserWindow.Event(OFFLINE_SESSION_INVALIDATED_EVENT))
    await settle()
    expect(signal.aborted).toBe(true)
    pending.resolve({ items: [], nextCursor: null })
    await settle()
    expect(view.host.querySelector('.async-state--empty')).toBeNull()
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Your session changed')
    expect(view.host.querySelector<HTMLButtonElement>('.admin-hero__actions button')?.disabled).toBe(true)
  })
})
