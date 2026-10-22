import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { afterEach, expect, it, vi } from '../../../server/test/bun-test.mts'
import { browserWindow, resetBody, setLocation } from '../../test/browser-dom.mts'
import type { App, RenderFunction } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { yCollab, ySyncAnnotation } from 'y-codemirror.next'
import * as Y from 'yjs'
import MarkdownIt from 'markdown-it'
import { LiveNoteCollaboration, decodeNoteState, encodeNoteUpdate, type NoteCollaborationOptions } from '../../helpers/live-note-collaboration.ts'
import { LiveNoteHistory } from '../../helpers/live-note-history.ts'
import { LiveNotesApiError, type LiveNotesApi } from '../../helpers/live-notes-api.ts'
import { captureNotePublication } from '../../helpers/live-note-publication.ts'
import type { PageWriteInput } from '../../helpers/pages-api.ts'
import { LIVE_NOTE_MAX_TEXT_BYTES, parseLiveNoteClientMessage, type LiveNoteView } from '../../../shared/live-notes.ts'

// Vue must capture the browser-dom window installed above, not a pre-DOM module instance.
const Vue = await import('vue')
const filename = join(process.cwd(), 'client/components/notes/live-note.vue')
const descriptor = parse(readFileSync(filename, 'utf8'), { filename }).descriptor
const metadata = compileScript(descriptor, { id: 'note-lifecycle' })
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
const evaluate = new Function(
  `{ ${[...Object.keys(metadata.imports!), 'siteConfig', 'siteLangs'].join(', ')} }`,
  `${source}\nreturn { ${bindings.join(', ')} }`
)
const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'note-lifecycle', compilerOptions: { mode: 'function' } })
if (template.errors.length) throw template.errors[0]
const render = new Function('Vue', template.code)(Vue) as RenderFunction
const apps: App[] = []
const initialViewportWidth = browserWindow.innerWidth
class Socket {
  readyState = 0
  bufferedAmount = 0
  sent: string[] = []
  private listeners = new Map<string, Array<(event: unknown) => void>>()
  addEventListener(type: string, callback: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback])
  }
  send(value: string) {
    this.sent.push(value)
  }
  close(code = 1000) {
    this.readyState = 3
    this.emit('close', { code })
  }
  open() {
    this.readyState = 1
    this.emit('open', {})
  }
  message(message: unknown) {
    this.emit('message', { data: JSON.stringify(message) })
  }
  private emit(type: string, event: unknown) {
    for (const callback of this.listeners.get(type) ?? []) callback(event)
  }
}
const settle = async () => {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve()
    await Vue.nextTick()
  }
}
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label)!
const server = new Y.Doc()
const note = (canEdit = true, revision = 0): LiveNoteView => ({
  id: '146e48d1-d094-498a-8c0b-a1cf862ce44e',
  key: 'test-note',
  ownerId: 1,
  title: 'Title',
  access: 'edit',
  revision,
  updatedAt: '2026-10-22T00:00:00.000Z',
  canEdit,
  canManage: canEdit,
  state: encodeNoteUpdate(Y.encodeStateAsUpdate(server))
})

async function mount(
  canEdit = true,
  publishResult: () => Promise<unknown> = async () => ({ id: 1, sourceRevision: '1', updatedAt: '2026-10-22T00:00:00.000Z' })
) {
  setLocation('/p/notes/test-note?mode=edit')
  server.transact(() => {
    const text = server.getText('content')
    text.delete(0, text.length)
    text.insert(0, '# Title\n\nBody ![asset](/assets/image.png)')
  })
  const sockets: Socket[] = [],
    clients: LiveNoteCollaboration[] = [],
    errors: unknown[] = []
  const initial = note(canEdit)
  const api = {
    read: vi.fn(async () => initial),
    session: vi.fn(async () => ({ key: initial.key, token: 'token', websocketPath: '/_api/live-notes/_socket', expiresAt: '2099-01-01T00:00:00.000Z' })),
    history: vi.fn(async () => ({ items: [], hasMore: false, nextCursor: null })),
    revision: vi.fn(),
    restore: vi.fn(),
    access: vi.fn(),
    remove: vi.fn()
  } as unknown as LiveNotesApi
  const store = Vue.reactive({
    authRefreshOutcome: 'authenticated' as string | null,
    offlineIdentityEpoch: 1,
    user: { id: 1, authVersion: 1, authenticated: true, permissions: ['write:notes', 'write:pages'] },
    waitForAuthRefresh: async () => 'authenticated'
  })
  const createPage = vi.fn((_fetcher: typeof fetch, _input: PageWriteInput) => publishResult())
  let safety: (() => { safe: boolean }) | null = null
  class MountedCollaboration extends LiveNoteCollaboration {
    constructor(options: NoteCollaborationOptions) {
      super({
        ...options,
        socket: () => {
          const socket = new Socket()
          sockets.push(socket)
          return socket as unknown as WebSocket
        }
      })
      clients.push(this)
    }
  }
  const component = Vue.defineComponent({
    setup() {
      return evaluate({
        ...Vue,
        Compartment,
        EditorState,
        EditorView,
        keymap,
        lineNumbers,
        defaultKeymap,
        indentWithTab,
        markdown,
        yCollab,
        ySyncAnnotation,
        LiveNoteHistory,
        Y,
        wikiStore: store,
        translate: (_key: string, options: { defaultValue: string }) => options.defaultValue,
        createLiveNotesApi: () => api,
        LiveNotesApiError,
        LiveNoteCollaboration: MountedCollaboration,
        decodeNoteState,
        captureNotePublication,
        createPage,
        createWikiMarkdownRenderer: () => new MarkdownIt(),
        sanitizeWikiMarkdownHtml: (html: string) => html,
        enhanceWikiMarkdownPreview: () => {},
        requestConfirmation: async () => true,
        ConfirmDialogHost: Vue.defineComponent({ render: () => null }),
        LIVE_NOTE_MAX_TEXT_BYTES,
        notifyReloadSafetyChanged: vi.fn(),
        setReloadSafetyProvider: (provider: typeof safety) => {
          safety = provider
        },
        siteConfig: { lang: 'en', agentCsrfToken: 'csrf' },
        siteLangs: [{ code: 'en', name: 'English' }]
      })
    },
    render
  })
  const host = document.body.appendChild(document.createElement('div'))
  const app = Vue.createApp(component)
  const shell = Vue.defineComponent({
    setup(_props, { slots }) {
      return () => Vue.h('div', slots.default?.())
    }
  })
  for (const name of ['v-app', 'v-main', 'nav-header', 'nav-footer', 'notify', 'search-results', 'confirm-dialog-host']) app.component(name, shell)
  app.config.errorHandler = caught => errors.push(caught)
  app.mount(host)
  apps.push(app)
  await settle()
  sockets[0].open()
  sockets[0].message({ type: 'sync', note: initial })
  await settle()
  const editor = EditorView.findFromDOM(host.querySelector<HTMLElement>('.cm-editor')!)!
  return { host, editor, sockets, clients, api, store, createPage, errors, reloadSafe: () => safety?.().safe }
}
afterEach(() => {
  for (const app of apps.splice(0)) app.unmount()
  resetBody()
  Object.defineProperty(browserWindow, 'innerWidth', { configurable: true, value: initialViewportWidth })
  vi.restoreAllMocks()
})

it('switches Reader/Editor URLs on a narrow viewport without recreating document, editor, session or pending updates', async () => {
  Object.defineProperty(browserWindow, 'innerWidth', { configurable: true, value: 375 })
  const mounted = await mount()
  const client = mounted.clients[0],
    document = client.document,
    element = mounted.host.querySelector('.cm-editor')
  mounted.editor.dispatch({ changes: { from: mounted.editor.state.doc.length, insert: '\nLocal edit' }, userEvent: 'input.type' })
  await settle()
  const update = mounted.sockets[0].sent.map(value => parseLiveNoteClientMessage(JSON.parse(value))).find(message => message.type === 'update')!
  expect(client.pendingCount).toBe(1)
  expect(mounted.reloadSafe()).toBe(false)
  button(mounted.host, 'Reader').click()
  await settle()
  expect(browserWindow.location.search).toBe('?mode=read')
  expect(mounted.host.querySelector('article')?.textContent).toContain('Local edit')
  expect(client.document).toBe(document)
  expect(mounted.host.querySelector('.cm-editor')).toBe(element)
  expect(mounted.api.session).toHaveBeenCalledTimes(1)
  const exit = new browserWindow.Event('beforeunload', { cancelable: true })
  browserWindow.dispatchEvent(exit)
  expect(exit.defaultPrevented).toBe(true)
  if (update.type !== 'update') throw new Error('Missing local update')
  Y.applyUpdate(server, decodeNoteState(update.update))
  mounted.sockets[0].message({ type: 'sync', note: note(true, 1) })
  await settle()
  expect(client.pendingCount).toBe(1)
  mounted.sockets[0].message({ type: 'ack', requestId: update.requestId, note: note(true, 1) })
  await settle()
  expect(client.pendingCount).toBe(0)
  expect(mounted.reloadSafe()).toBe(true)
  const savedExit = new browserWindow.Event('beforeunload', { cancelable: true })
  browserWindow.dispatchEvent(savedExit)
  expect(savedExit.defaultPrevented).toBe(false)
  button(mounted.host, 'Editor').click()
  await settle()
  expect(browserWindow.location.search).toBe('?mode=edit')
  expect(mounted.editor.state.doc.toString()).toContain('Local edit')
  expect(mounted.errors).toEqual([])
})

it('renders live reader updates with no editing, sharing, publishing or destructive controls for reader-only access', async () => {
  const mounted = await mount(false)
  expect(button(mounted.host, 'Editor')).toBeUndefined()
  expect(button(mounted.host, 'Reader')).toBeUndefined()
  expect(button(mounted.host, 'Publish as page')).toBeUndefined()
  expect(button(mounted.host, 'Delete note')).toBeUndefined()
  expect(mounted.editor.state.readOnly).toBe(true)
  server.getText('content').insert(server.getText('content').length, '\nRemote change')
  mounted.sockets[0].message({ type: 'sync', note: note(false, 1) })
  await settle()
  expect(mounted.host.querySelector('article')?.textContent).toContain('Remote change')
  expect(mounted.clients[0].pendingCount).toBe(0)
  expect(mounted.errors).toEqual([])
})

it('publishes one captured revision via normal page creation and never retries an uncertain outcome', async () => {
  const mounted = await mount(true, async () => {
    throw new TypeError('Connection interrupted')
  })
  button(mounted.host, 'Publish as page').click()
  await settle()
  const form = mounted.host.querySelector<HTMLFormElement>('.live-note__publication form')!
  const path = form.querySelectorAll<HTMLInputElement>('input')[1]
  path.value = 'notes/published'
  path.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  server.getText('content').insert(server.getText('content').length, '\nLater collaborator change')
  mounted.sockets[0].message({ type: 'sync', note: note(true, 1) })
  await settle()
  form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(mounted.createPage).toHaveBeenCalledTimes(1)
  expect(mounted.createPage.mock.calls[0][1]).toMatchObject({
    title: 'Title',
    content: 'Body ![asset](/assets/image.png)',
    locale: 'en',
    path: 'notes/published',
    isPublished: false,
    editor: 'markdown'
  })
  expect(mounted.clients[0].text.toString()).toContain('# Title')
  expect(mounted.clients[0].text.toString()).toContain('Later collaborator change')
  expect(form.textContent).toContain('This request will not be retried')
  form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(mounted.createPage).toHaveBeenCalledTimes(1)
  button(mounted.host, 'Close').click()
  await settle()
  expect(button(mounted.host, 'Publish as page').disabled).toBe(true)
  expect(mounted.host.textContent).toContain('This request will not be retried')
  expect(mounted.errors).toEqual([])
})

it('fences the live writer synchronously on account change while leaving recovery text available', async () => {
  const mounted = await mount()
  mounted.editor.dispatch({ changes: { from: 0, insert: 'Unsaved ' }, userEvent: 'input.type' })
  await settle()
  mounted.store.user.id = 2
  mounted.store.user.authVersion = 2
  await settle()
  expect(mounted.clients[0].state).toBe('blocked')
  expect(mounted.editor.state.readOnly).toBe(true)
  expect(mounted.clients[0].text.toString()).toContain('Unsaved ')
  expect(mounted.clients[0].pendingCount).toBe(1)
  expect(button(mounted.host, 'Download Markdown')).toBeDefined()
  expect(button(mounted.host, 'Publish as page')).toBeUndefined()
  expect(mounted.errors).toEqual([])
})

it('previews history separately and restores into the same live document using the current expected revision', async () => {
  const mounted = await mount()
  const historical = note(true, 0),
    originalDocument = mounted.clients[0].document
  server.getText('content').insert(server.getText('content').length, '\nNewer text')
  mounted.sockets[0].message({ type: 'sync', note: note(true, 1) })
  await settle()
  vi.mocked(mounted.api.history).mockResolvedValue({
    items: [{ revision: 0, title: 'Original', actorId: 1, createdAt: '2026-10-22T00:00:00.000Z' }],
    hasMore: false,
    nextCursor: null
  })
  vi.mocked(mounted.api.revision).mockResolvedValue(historical)
  vi.mocked(mounted.api.restore).mockImplementation(async () => {
    server.transact(() => {
      const text = server.getText('content')
      text.delete(0, text.length)
      text.insert(0, '# Title\n\nBody ![asset](/assets/image.png)')
    })
    return note(true, 2)
  })
  button(mounted.host, 'History').click()
  await settle()
  mounted.host.querySelector<HTMLButtonElement>('.live-note__history li button')!.click()
  await settle()
  expect(mounted.host.querySelector('.live-note__snapshot')?.textContent).not.toContain('Newer text')
  expect(mounted.editor.state.doc.toString()).toContain('Newer text')
  button(mounted.host, 'Restore this revision').click()
  await settle()
  expect(mounted.api.restore).toHaveBeenCalledWith('test-note', 0, 1, expect.any(AbortSignal))
  expect(mounted.clients[0].document).toBe(originalDocument)
  expect(mounted.editor.state.doc.toString()).toBe('# Title\n\nBody ![asset](/assets/image.png)')
  expect(mounted.clients[0].pendingCount).toBe(0)
  expect(mounted.errors).toEqual([])
})

it('blocks repeated stale metadata mutations until current access has been refreshed and reviewed', async () => {
  const mounted = await mount()
  vi.mocked(mounted.api.access).mockRejectedValue(new LiveNotesApiError(409, 'NOTE_CONFLICT', 'Changed elsewhere'))
  const select = mounted.host.querySelector<HTMLSelectElement>('.live-note__management select')!
  select.value = 'read'
  select.dispatchEvent(new browserWindow.Event('change', { bubbles: true }))
  await settle()
  expect(mounted.reloadSafe()).toBe(false)
  const form = mounted.host.querySelector<HTMLFormElement>('.live-note__management form')!
  form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(mounted.api.access).toHaveBeenCalledTimes(1)
  expect(mounted.host.textContent).toContain('The note changed elsewhere')
  form.dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
  await settle()
  expect(mounted.api.access).toHaveBeenCalledTimes(1)
  button(mounted.host, 'Refresh current access').click()
  await settle()
  expect(select.value).toBe('edit')
  expect(mounted.reloadSafe()).toBe(true)
  expect(mounted.errors).toEqual([])
})

it('resumes the same document and pending request after same-account unavailable/revalidated auth readiness', async () => {
  const mounted = await mount()
  const originalDocument = mounted.clients[0].document
  mounted.editor.dispatch({ changes: { from: mounted.editor.state.doc.length, insert: '\nHeld across verification' }, userEvent: 'input.type' })
  await settle()
  const request = mounted.sockets[0].sent.map(value => parseLiveNoteClientMessage(JSON.parse(value))).find(message => message.type === 'update')!
  mounted.store.authRefreshOutcome = null
  await settle()
  expect(mounted.clients[0].state).toBe('offline')
  expect(mounted.editor.state.readOnly).toBe(true)
  expect(mounted.clients[0].pendingCount).toBe(1)
  mounted.store.authRefreshOutcome = 'unavailable'
  await settle()
  expect(mounted.clients[0].state).not.toBe('blocked')
  mounted.store.authRefreshOutcome = 'authenticated'
  await settle()
  expect(mounted.sockets).toHaveLength(2)
  mounted.sockets[1].open()
  mounted.sockets[1].message({ type: 'sync', note: note(true, 0) })
  await settle()
  expect(mounted.clients[0].document).toBe(originalDocument)
  expect(mounted.editor.state.doc.toString()).toContain('Held across verification')
  expect(mounted.editor.state.readOnly).toBe(false)
  const resent = mounted.sockets[1].sent.map(value => parseLiveNoteClientMessage(JSON.parse(value))).find(message => message.type === 'update')
  expect(resent).toEqual(request)
  if (request.type !== 'update') throw new Error('Expected pending update')
  Y.applyUpdate(server, decodeNoteState(request.update))
  mounted.sockets[1].message({ type: 'ack', requestId: request.requestId, note: note(true, 1) })
  await settle()
  expect(mounted.clients[0].pendingCount).toBe(0)
  expect(mounted.errors).toEqual([])
})
