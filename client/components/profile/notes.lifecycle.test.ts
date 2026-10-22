import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import type { App, RenderFunction } from 'vue'
import { LiveNotesApiError, type LiveNotesApi } from '../../helpers/live-notes-api.ts'
import type { LiveNoteSummary } from '../../../shared/live-notes.ts'

// The runtime must capture the shared browser-dom window before component mounting.
const Vue = await import('vue')
const filename = join(process.cwd(), 'client/components/profile/notes.vue')
const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor
const metadata = compileScript(descriptor, { id: 'notes-inventory' })
const script = descriptor.scriptSetup!.content,
  parts: string[] = []
let end = 0
for (const statement of metadata.scriptSetupAst!) {
  if (statement.type === 'ImportDeclaration') {
    parts.push(script.slice(end, statement.start!))
    end = statement.end!
  }
}
parts.push(script.slice(end))
const source = new Bun.Transpiler({ loader: 'ts' }).transformSync(parts.join(''))
const bindings = Object.keys(metadata.bindings!).filter(name => !metadata.imports?.[name])
const evaluate = new Function(`{ ${[...Object.keys(metadata.imports!), 'siteConfig'].join(', ')} }`, `${source}\nreturn { ${bindings.join(', ')} }`)
const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'notes-inventory', compilerOptions: { mode: 'function' } })
if (template.errors.length) throw template.errors[0]
const render = new Function('Vue', template.code)(Vue) as RenderFunction
const apps: App[] = []
const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}
const empty = { items: [] as LiveNoteSummary[], hasMore: false, nextCursor: null }
function mount(api: Partial<LiveNotesApi>) {
  const store = Vue.reactive({
    authRefreshOutcome: 'authenticated' as string | null,
    offlineIdentityEpoch: 1,
    user: { id: 1, authVersion: 1, authenticated: true, permissions: ['write:notes'] },
    waitForAuthRefresh: async () => 'authenticated'
  })
  const errors: unknown[] = []
  const component = Vue.defineComponent({
    setup: () =>
      evaluate({
        ...Vue,
        wikiStore: store,
        createLiveNotesApi: () => api,
        LiveNotesApiError,
        translate: (_key: string, options: { defaultValue: string }) => options.defaultValue,
        onBeforeRouteLeave: () => {},
        requestConfirmation: async () => true,
        notifyReloadSafetyChanged: vi.fn(),
        setReloadSafetyProvider: vi.fn(),
        siteConfig: { agentCsrfToken: 'csrf' }
      }),
    render
  })
  const host = document.body.appendChild(document.createElement('div')),
    app = Vue.createApp(component)
  app.config.errorHandler = error => errors.push(error)
  app.mount(host)
  apps.push(app)
  return { host, store, errors }
}
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  resetBody()
  vi.restoreAllMocks()
})

it('clears owner inventory immediately and ignores an old-account response after an identity change', async () => {
  const pending = Promise.withResolvers<typeof empty>()
  const list = vi.fn(async () => empty).mockImplementationOnce(() => pending.promise)
  const mounted = mount({ list })
  await settle()
  mounted.store.user.id = 2
  await settle()
  pending.resolve({
    ...empty,
    items: [
      {
        id: '0f06c1c1-31bf-4b7b-9cce-36990c104f59',
        key: 'private-owner-one',
        ownerId: 1,
        title: 'Owner one private note',
        access: 'private',
        revision: 0,
        updatedAt: '2026-10-22T00:00:00.000Z',
        canEdit: true,
        canManage: true
      }
    ]
  })
  await settle()
  expect(mounted.host.textContent).not.toContain('Owner one private note')
  expect(mounted.host.querySelector('a[href*="private-owner-one"]')).toBeNull()
  expect(list).toHaveBeenCalledTimes(2)
  expect(mounted.errors).toEqual([])
})

it('does not retry uncertain creation and keeps recovery/reload available', async () => {
  const create = vi.fn(async () => {
    throw new TypeError('Connection lost')
  })
  const list = vi.fn(async () => empty)
  const mounted = mount({ list, create })
  await settle()
  const input = mounted.host.querySelector<HTMLInputElement>('input')!
  input.value = 'my-custom-note'
  input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  await settle()
  const form = mounted.host.querySelector('form')!
  form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(create).toHaveBeenCalledTimes(1)
  expect(create).toHaveBeenCalledWith('my-custom-note', expect.any(AbortSignal))
  expect(mounted.host.textContent).toContain('Creation will not be retried automatically')
  form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(create).toHaveBeenCalledTimes(1)
  const reload = [...mounted.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Reload')!
  expect(reload.disabled).toBe(false)
  reload.click()
  await settle()
  expect(list).toHaveBeenCalledTimes(2)
  expect(create).toHaveBeenCalledTimes(1)
  expect(mounted.errors).toEqual([])
})

it('keeps the unsent custom-key draft across same-account auth revalidation', async () => {
  const create = vi.fn(async () => {
    throw new Error('Not requested')
  })
  const mounted = mount({ list: vi.fn(async () => empty), create })
  await settle()
  const input = mounted.host.querySelector<HTMLInputElement>('input')!
  input.value = 'my-unsent-key'
  input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  await settle()
  mounted.store.authRefreshOutcome = null
  await settle()
  expect(mounted.host.querySelector('form')).toBeNull()
  mounted.store.authRefreshOutcome = 'authenticated'
  await settle()
  expect(mounted.host.querySelector<HTMLInputElement>('input')?.value).toBe('my-unsent-key')
  expect(create).not.toHaveBeenCalled()
  expect(mounted.errors).toEqual([])
})
