import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody } from '../../test/browser-dom.mts'
import type { App, RenderFunction } from 'vue'
import { LiveNotesApiError, type LiveNotesApi } from '../../helpers/live-notes-api.ts'
import type { LiveNoteSummary, LiveNoteView } from '../../../shared/live-notes.ts'

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

const button = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!
const submit = async (host: HTMLElement) => {
  host.querySelector('form')!.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
  await settle()
}
const availableNote = (key: string): LiveNoteView => ({
  id: '146e48d1-d094-498a-8c0b-a1cf862ce44e',
  key,
  ownerId: 2,
  title: 'An existing shared note',
  access: 'read',
  revision: 8,
  updatedAt: '2026-10-22T00:00:00.000Z',
  canEdit: false,
  canManage: false,
  state: 'AA=='
})

it('checks an ambiguous custom address read-only without claiming that a preexisting other-owner note was created by this attempt', async () => {
  const create = vi.fn(async () => {
    throw new TypeError('Connection lost')
  })
  const read = vi.fn(async () => availableNote('my-custom-note'))
  const mounted = mount({ list: vi.fn(async () => empty), create, read })
  await settle()
  const input = mounted.host.querySelector<HTMLInputElement>('input')!
  input.value = 'my-custom-note'
  input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  await submit(mounted.host)
  expect(create).toHaveBeenCalledWith('my-custom-note', expect.any(AbortSignal))
  expect(read).not.toHaveBeenCalled()
  const location = browserWindow.location.href
  button(mounted.host, 'Check requested note address').click()
  await settle()
  expect(read).toHaveBeenCalledWith('my-custom-note', expect.any(AbortSignal))
  expect(mounted.host.querySelector<HTMLAnchorElement>('a[href="/p/notes/my-custom-note?mode=read"]')?.textContent).toBe('Open note')
  expect(mounted.host.querySelector('a[href$="mode=edit"]')).toBeNull()
  expect(mounted.host.textContent).toContain('does not prove this creation attempt made it')
  expect(button(mounted.host, 'Create private note').disabled).toBe(true)
  await submit(mounted.host)
  expect(create).toHaveBeenCalledTimes(1)
  expect(browserWindow.location.href).toBe(location)
  expect(mounted.errors).toEqual([])
})

it('captures one generated key and keeps missing or inaccessible reads uncertain without replaying creation', async () => {
  const create = vi.fn(async (_key: string, _signal?: AbortSignal) => {
    throw new TypeError('Lost creation response')
  })
  const read = vi.fn(async (_key: string, _signal?: AbortSignal) => {
    throw new LiveNotesApiError(404, 'NOTE_NOT_FOUND', 'Unavailable')
  })
  const list = vi.fn(async () => empty)
  const mounted = mount({ list, create, read })
  await settle()
  await submit(mounted.host)
  const key = create.mock.calls[0][0]
  expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
  for (let check = 0; check < 2; check++) {
    button(mounted.host, 'Check requested note address').click()
    await settle()
    await submit(mounted.host)
  }
  button(mounted.host, 'Reload').click()
  await settle()
  expect(read).toHaveBeenCalledTimes(2)
  expect(read.mock.calls.every(([capturedKey]) => capturedKey === key)).toBe(true)
  expect(mounted.host.querySelector('code')?.textContent).toBe(key)
  expect(mounted.host.querySelector('a[href*="/p/notes/"]')).toBeNull()
  expect(button(mounted.host, 'Create private note').disabled).toBe(true)
  expect(create).toHaveBeenCalledTimes(1)
  expect(list).toHaveBeenCalledTimes(2)
  expect(mounted.errors).toEqual([])
})

for (const boundary of ['identity', 'permission'] as const) {
  it(`clears an authorized address result and ignores its late replacement after ${boundary} loss`, async () => {
    const pending = Promise.withResolvers<LiveNoteView>()
    const create = vi.fn(async () => {
      throw new TypeError('Lost response')
    })
    const read = vi
      .fn(async () => availableNote('my-custom-note'))
      .mockImplementationOnce(async () => availableNote('my-custom-note'))
      .mockImplementationOnce(() => pending.promise)
    const mounted = mount({ list: vi.fn(async () => empty), create, read })
    await settle()
    const input = mounted.host.querySelector<HTMLInputElement>('input')!
    input.value = 'my-custom-note'
    input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    await submit(mounted.host)
    button(mounted.host, 'Check requested note address').click()
    await settle()
    expect(mounted.host.querySelector('a[href*="my-custom-note"]')).not.toBeNull()
    button(mounted.host, 'Check requested note address').click()
    await settle()
    if (boundary === 'identity') mounted.store.user.id = 2
    else mounted.store.user.permissions = []
    await settle()
    expect(mounted.host.querySelector('a[href*="my-custom-note"]')).toBeNull()
    pending.resolve(availableNote('my-custom-note'))
    await settle()
    expect(mounted.host.querySelector('a[href*="my-custom-note"]')).toBeNull()
    expect(create).toHaveBeenCalledTimes(1)
    expect(mounted.errors).toEqual([])
  })
}

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

it('allows a deliberate new generated address after a definite rejected attempt, not an automatic replay', async () => {
  const create = vi
    .fn(async (_key: string, _signal?: AbortSignal) => {
      throw new TypeError('Second response lost')
    })
    .mockRejectedValueOnce(new LiveNotesApiError(409, 'NOTE_KEY_CONFLICT', 'Address occupied'))
  const mounted = mount({ list: vi.fn(async () => empty), create })
  await settle()
  await submit(mounted.host)
  expect(create).toHaveBeenCalledTimes(1)
  expect(button(mounted.host, 'Create private note').disabled).toBe(false)
  expect(button(mounted.host, 'Check requested note address')).toBeUndefined()
  await submit(mounted.host)
  expect(create).toHaveBeenCalledTimes(2)
  expect(create.mock.calls[1][0]).not.toBe(create.mock.calls[0][0])
  expect(button(mounted.host, 'Create private note').disabled).toBe(true)
  expect(mounted.errors).toEqual([])
})

for (const mismatch of ['owner', 'address'] as const) {
  it(`does not trust a successful create response with the wrong ${mismatch} as this attempt's new note`, async () => {
    const create = vi.fn(async () => ({
      ...availableNote(mismatch === 'address' ? 'another-note' : 'my-custom-note'),
      ownerId: mismatch === 'owner' ? 2 : 1
    }))
    const mounted = mount({ list: vi.fn(async () => empty), create })
    await settle()
    const input = mounted.host.querySelector<HTMLInputElement>('input')!
    input.value = 'my-custom-note'
    input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
    const location = browserWindow.location.href
    await submit(mounted.host)
    expect(button(mounted.host, 'Create private note').disabled).toBe(true)
    expect(button(mounted.host, 'Check requested note address')).toBeDefined()
    expect(mounted.host.querySelector('a[href*="/p/notes/"]')).toBeNull()
    expect(browserWindow.location.href).toBe(location)
    await submit(mounted.host)
    expect(create).toHaveBeenCalledTimes(1)
    expect(mounted.errors).toEqual([])
  })
}
