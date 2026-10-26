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
import { captureNotePublication } from '../../../shared/live-note-publication.ts'
import { createPage as writePage, type PageWriteInput } from '../../helpers/pages-api.ts'
import { listLiveNoteCreations, readPageCreationStatus, PageCreationApiError } from '../../helpers/page-creation-api.ts'
import { PAGE_CREATION_OWNER_HEADER, type PageCreationCommitted, type PageCreationInventory, type PageCreationStatus } from '../../../shared/page-creation.ts'
import { wikiSourceHref } from '../../../shared/wiki-source.ts'
import { helpers } from '../../helpers/index.ts'
import { describePageVisibility } from '../editor/common/page-visibility.ts'
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
// Match script-setup exposure: locals plus runtime imports used by the template.
const bindings = Object.keys(metadata.bindings!)
  .filter(name => metadata.bindings![name] !== 'props' && (!metadata.imports?.[name] || (!metadata.imports[name].isType && metadata.imports[name].isUsedInTemplate)))
  .map(name => {
    if (metadata.imports?.[name]) return `get ${name}() { return ${name} }`
    if (metadata.bindings![name] === 'setup-let') return `get ${name}() { return ${name} }, set ${name}(value) { ${name} = value }`
    return name
  })
const evaluate = new Function(
  `{ ${[...Object.keys(metadata.imports!), 'siteConfig', 'siteLangs'].join(', ')} }`,
  `${source}\nreturn { ${bindings.join(', ')} }`
)
const template = compileTemplate({
  source: descriptor.template!.content,
  filename,
  id: 'note-lifecycle',
  compilerOptions: { mode: 'function', prefixIdentifiers: true, bindingMetadata: metadata.bindings, expressionPlugins: ['typescript'] }
})
if (template.errors.length) throw template.errors[0]
// Template event expressions can contain TypeScript just like the setup script.
const render = new Function('Vue', new Bun.Transpiler({ loader: 'ts' }).transformSync(template.code))(Vue) as RenderFunction
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

const emptyCreations: PageCreationInventory = { items: [], hasMore: false, nextCursor: null }
const creationReceipt = (requestId: string, overrides: Partial<PageCreationCommitted> = {}): PageCreationCommitted => ({
  status: 'committed',
  requestId,
  sourceRevision: '3',
  createdAt: '2026-10-22T00:00:00.000Z',
  creationOrigin: { kind: 'live-note', noteId: note().id, revision: 0 },
  destination: {
    id: 71,
    sourceRevision: '9',
    path: 'actual/moved-page',
    locale: 'en',
    title: 'Authorized destination',
    visibility: 'private',
    isPublished: false
  },
  ...overrides
})
const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
type PublicationTransport = {
  create?: (input: PageWriteInput) => Promise<Response>
  status?: (requestId: string) => Promise<PageCreationStatus | Response>
  inventory?: () => Promise<PageCreationInventory | Response>
}
async function mount(canEdit = true, transport: PublicationTransport = {}) {
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
    list: vi.fn<LiveNotesApi['list']>(async () => { throw new Error('Unexpected note inventory request') }),
    create: vi.fn<LiveNotesApi['create']>(async () => { throw new Error('Unexpected note creation request') }),
    read: vi.fn<LiveNotesApi['read']>(async () => initial),
    session: vi.fn<LiveNotesApi['session']>(async () => ({ key: initial.key, token: 'token', websocketPath: '/_api/live-notes/_socket', expiresAt: '2099-01-01T00:00:00.000Z' })),
    history: vi.fn<LiveNotesApi['history']>(async () => ({ items: [], hasMore: false, nextCursor: null })),
    revision: vi.fn<LiveNotesApi['revision']>(async () => { throw new Error('Unexpected note revision request') }),
    restore: vi.fn<LiveNotesApi['restore']>(async () => { throw new Error('Unexpected note restoration request') }),
    access: vi.fn<LiveNotesApi['access']>(async () => { throw new Error('Unexpected note access mutation') }),
    remove: vi.fn<LiveNotesApi['remove']>(async () => { throw new Error('Unexpected note deletion request') })
  } satisfies LiveNotesApi
  const store = Vue.reactive({
    authRefreshOutcome: 'authenticated' as string | null,
    offlineIdentityEpoch: 1,
    user: { id: 1, authVersion: 1, authenticated: true, permissions: ['write:notes', 'write:pages'] },
    waitForAuthRefresh: async () => 'authenticated'
  })
  const writes: PageWriteInput[] = []
  const fetchPageCreation = vi.spyOn(browserWindow, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === '/_api/pages' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as PageWriteInput
      writes.push(body)
      return transport.create ? transport.create(body) : jsonResponse({ page: { id: 71, sourceRevision: 3, updatedAt: '2026-10-22T00:00:00.000Z' } })
    }
    if (url.startsWith('/_api/pages/creation-requests/')) {
      const requestId = url.split('/').at(-1)!
      const result = transport.status ? await transport.status(requestId) : creationReceipt(requestId)
      return result instanceof Response ? result : jsonResponse(result)
    }
    if (url.startsWith('/_api/pages/creation-origins/live-notes/')) {
      const result = transport.inventory ? await transport.inventory() : emptyCreations
      return result instanceof Response ? result : jsonResponse(result)
    }
    throw new Error(`Unexpected publication request: ${url}`)
  })
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
        translate: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
        createLiveNotesApi: () => api,
        LiveNotesApiError,
        LiveNoteCollaboration: MountedCollaboration,
        decodeNoteState,
        captureNotePublication,
        createPage: writePage,
        listLiveNoteCreations,
        readPageCreationStatus,
        PageCreationApiError,
        wikiSourceHref,
        helpers,
        describePageVisibility,
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
  expect(errors).toEqual([])
  const editorHost = host.querySelector<HTMLElement>('.cm-editor')
  expect(editorHost).not.toBeNull()
  const editor = EditorView.findFromDOM(editorHost!)!
  return { host, editor, sockets, clients, api, store, fetchPageCreation, writes, errors, reloadSafe: () => safety?.().safe }
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

const publicationForm = (host: HTMLElement) => host.querySelector<HTMLFormElement>('[aria-labelledby="note-publish-title"] form')!
const submitPublication = async (host: HTMLElement) => {
  publicationForm(host).dispatchEvent(new browserWindow.Event('submit', { bubbles: true, cancelable: true }))
  await settle()
}
const openPublication = async (host: HTMLElement) => {
  button(host, 'Publish as page').click()
  await settle()
}

it('keeps the canonical capture independent and recovers a lost success with one POST and an explicit receipt GET', async () => {
  const status = vi.fn(async (requestId: string) => creationReceipt(requestId))
  const mounted = await mount(true, {
    create: async () => {
      throw new TypeError('Connection interrupted after commit')
    },
    status
  })
  await openPublication(mounted.host)
  const form = publicationForm(mounted.host)
  const destination = form.querySelector<HTMLDetailsElement>('details:has(input)')!
  destination.querySelector<HTMLElement>('summary')!.click()
  destination.dispatchEvent(new browserWindow.Event('toggle'))
  await settle()
  expect(destination.open).toBe(true)
  const path = destination.querySelector<HTMLInputElement>('input')!
  path.value = 'notes/requested-path'
  path.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  server.getText('content').insert(server.getText('content').length, '\nLater collaborator change')
  mounted.sockets[0].message({ type: 'sync', note: note(true, 1) })
  await settle()
  await submitPublication(mounted.host)
  expect(mounted.writes).toHaveLength(1)
  expect(mounted.writes[0]).toMatchObject({
    title: 'Title',
    content: 'Body ![asset](/assets/image.png)',
    locale: 'en',
    path: 'notes/requested-path',
    visibility: 'private',
    isPublished: false,
    creationRequestId: expect.any(String),
    creationOrigin: { kind: 'live-note', noteId: note().id, revision: 0 }
  })
  const post = mounted.fetchPageCreation.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(new Headers(post[1]?.headers).get(PAGE_CREATION_OWNER_HEADER)).toBe('1')
  expect(status).not.toHaveBeenCalled()
  await submitPublication(mounted.host)
  button(mounted.host, 'Close').click()
  await settle()
  await openPublication(mounted.host)
  expect(publicationForm(mounted.host).querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
  button(mounted.host, 'Check creation status').click()
  await settle()
  expect(status).toHaveBeenCalledTimes(1)
  expect(status).toHaveBeenCalledWith(mounted.writes[0].creationRequestId)
  expect(mounted.writes).toHaveLength(1)
  const link = mounted.host.querySelector<HTMLAnchorElement>('a[href*="actual/moved-page"]')
  expect(link?.textContent).toBe('Authorized destination')
  expect(mounted.host.querySelector('a[href*="notes/requested-path"]')).toBeNull()
  const inventory = mounted.host.querySelector('[aria-labelledby="note-creations-title"]')!
  expect(inventory.textContent).toMatch(/Created page revision\s+3/u)
  expect(inventory.textContent).toMatch(/Current page revision\s+9/u)
  expect(mounted.clients[0].text.toString()).toBe('# Title\n\nBody ![asset](/assets/image.png)\nLater collaborator change')
  expect(mounted.api.remove).not.toHaveBeenCalled()
  expect(mounted.api.restore).not.toHaveBeenCalled()
  expect(mounted.errors).toEqual([])
})

for (const outcome of ['unknown', 'missing', 'malformed'] as const) {
  it(`does not interpret a ${outcome} status check as permission to create another page`, async () => {
    const mounted = await mount(true, {
      create: async () => {
        throw new TypeError('Lost response')
      },
      status: async requestId =>
        outcome === 'unknown'
          ? { status: 'unknown', requestId }
          : outcome === 'missing'
            ? jsonResponse({ error: 'Not available' }, 404)
            : jsonResponse({ status: 'committed', requestId })
    })
    await openPublication(mounted.host)
    await submitPublication(mounted.host)
    button(mounted.host, 'Check creation status').click()
    await settle()
    await submitPublication(mounted.host)
    expect(mounted.writes).toHaveLength(1)
    expect(button(mounted.host, 'Review a corrected new attempt')).toBeUndefined()
    expect(button(mounted.host, 'Prepare another snapshot')).toBeUndefined()
    expect(mounted.host.querySelector('a[href*="actual/moved-page"]')).toBeNull()
    expect(mounted.host.querySelector('[aria-labelledby="note-publish-title"] pre')?.textContent).toBe('Body ![asset](/assets/image.png)')
    expect(mounted.errors).toEqual([])
  })
}

it('requires a deliberate correction after a definite rejection and uses a fresh request identity for the retained capture', async () => {
  const create = vi
    .fn(async () => jsonResponse({ page: { id: 71, sourceRevision: 3, updatedAt: '2026-10-22T00:00:00.000Z' } }))
    .mockResolvedValueOnce(jsonResponse({ error: 'That destination is occupied.', code: 'PAGE_CONFLICT' }, 409))
  const mounted = await mount(true, { create })
  await openPublication(mounted.host)
  await submitPublication(mounted.host)
  await submitPublication(mounted.host)
  expect(mounted.writes).toHaveLength(1)
  button(mounted.host, 'Review a corrected new attempt').click()
  await settle()
  const title = publicationForm(mounted.host).querySelector<HTMLInputElement>('input')!
  title.value = 'Corrected title'
  title.dispatchEvent(new browserWindow.Event('input', { bubbles: true }))
  await submitPublication(mounted.host)
  expect(mounted.writes).toHaveLength(2)
  expect(mounted.writes[1].creationRequestId).not.toBe(mounted.writes[0].creationRequestId)
  expect(mounted.writes[1]).toMatchObject({
    title: 'Corrected title',
    content: 'Body ![asset](/assets/image.png)',
    creationOrigin: mounted.writes[0].creationOrigin
  })
  expect(mounted.errors).toEqual([])
})

it('reconciles an already-committed conflict without enabling a corrected retry or leaking a redacted destination', async () => {
  const status = vi.fn(async (requestId: string) => creationReceipt(requestId, { destination: null }))
  const mounted = await mount(true, {
    create: async () => jsonResponse({ error: 'Already committed', code: 'PAGE_CREATION_ALREADY_COMMITTED' }, 409),
    status
  })
  await openPublication(mounted.host)
  await submitPublication(mounted.host)
  expect(status).toHaveBeenCalledTimes(1)
  expect(status).toHaveBeenCalledWith(mounted.writes[0].creationRequestId)
  expect(button(mounted.host, 'Review a corrected new attempt')).toBeUndefined()
  expect(button(mounted.host, 'Prepare another snapshot')).toBeDefined()
  await submitPublication(mounted.host)
  expect(mounted.writes).toHaveLength(1)
  expect(mounted.host.querySelector('[aria-labelledby="note-creations-title"] li')?.textContent).toContain('Creation is confirmed')
  expect(mounted.host.querySelector('[aria-labelledby="note-creations-title"] a')).toBeNull()
  expect(mounted.errors).toEqual([])
})

it('recovers multiple intentional publications after reopening by their actual destinations, without writing or changing the note', async () => {
  const first = creationReceipt('1ce8ef11-12c4-4a45-a761-2743761911aa')
  const second = creationReceipt('5f788aa1-a114-4c94-b52e-591e0f17c03a', {
    sourceRevision: '4',
    creationOrigin: { kind: 'live-note', noteId: note().id, revision: 7 },
    destination: {
      id: 72,
      sourceRevision: '12',
      path: 'actual/second-page',
      locale: 'fr',
      title: 'Another publication',
      visibility: 'public',
      isPublished: true
    }
  })
  const mounted = await mount(true, { inventory: async () => ({ ...emptyCreations, items: [second, first] }) })
  const inventory = mounted.host.querySelector('[aria-labelledby="note-creations-title"]')!
  expect([...inventory.querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Another publication', '/fr/actual/second-page'],
    ['Authorized destination', '/_private/en/actual/moved-page']
  ])
  expect(inventory.querySelectorAll('li')).toHaveLength(2)
  expect(inventory.textContent).toMatch(/Committed capture: note revision\s+7/u)
  expect(mounted.writes).toHaveLength(0)
  expect(mounted.editor.state.doc.toString()).toBe('# Title\n\nBody ![asset](/assets/image.png)')
  await openPublication(mounted.host)
  await submitPublication(mounted.host)
  button(mounted.host, 'Prepare another snapshot').click()
  await settle()
  await submitPublication(mounted.host)
  expect(mounted.writes).toHaveLength(2)
  expect(mounted.writes[1].creationRequestId).not.toBe(mounted.writes[0].creationRequestId)
  expect(mounted.api.remove).not.toHaveBeenCalled()
  expect(mounted.errors).toEqual([])
})

for (const boundary of ['identity', 'permission', 'source'] as const) {
  it(`clears receipt metadata and ignores an in-flight success after ${boundary} loss while keeping captured Markdown`, async () => {
    const pending = Promise.withResolvers<PageCreationStatus>()
    const prior = creationReceipt('1ce8ef11-12c4-4a45-a761-2743761911aa')
    const mounted = await mount(true, {
      inventory: async () => ({ ...emptyCreations, items: [prior] }),
      create: async () => {
        throw new TypeError('Lost response')
      },
      status: () => pending.promise
    })
    expect(mounted.host.textContent).toContain('Authorized destination')
    await openPublication(mounted.host)
    await submitPublication(mounted.host)
    button(mounted.host, 'Check creation status').click()
    await settle()
    if (boundary === 'identity') mounted.store.user.id = 2
    else if (boundary === 'permission') {
      mounted.api.read.mockRejectedValue(new LiveNotesApiError(403, 'NOTE_FORBIDDEN', 'Access revoked'))
      mounted.store.user.permissions = []
    } else mounted.sockets[0].message({ type: 'error', code: 'NOTE_FORBIDDEN', error: 'Source no longer accessible' })
    await settle()
    expect(mounted.host.textContent).not.toContain('Authorized destination')
    pending.resolve(
      creationReceipt(mounted.writes[0].creationRequestId!, {
        destination: { ...prior.destination!, title: 'Late private destination' }
      })
    )
    await settle()
    expect(mounted.host.textContent).not.toContain('Late private destination')
    expect(mounted.host.querySelector('a[href*="actual/"]')).toBeNull()
    expect(mounted.host.querySelector('[aria-labelledby="note-publish-title"] pre')?.textContent).toBe('Body ![asset](/assets/image.png)')
    expect(mounted.clients[0].text.toString()).toContain('Body ![asset](/assets/image.png)')
    await submitPublication(mounted.host)
    expect(mounted.writes).toHaveLength(1)
    expect(mounted.errors).toEqual([])
  })
}

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
  mounted.api.history.mockResolvedValue({
    items: [{ revision: 0, title: 'Original', actorId: 1, createdAt: '2026-10-22T00:00:00.000Z' }],
    hasMore: false,
    nextCursor: null
  })
  mounted.api.revision.mockResolvedValue(historical)
  mounted.api.restore.mockImplementation(async () => {
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
  mounted.api.access.mockRejectedValue(new LiveNotesApiError(409, 'NOTE_CONFLICT', 'Changed elsewhere'))
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

for (const boundary of ['identity', 'permission', 'source'] as const) {
  it(`does not turn a late page POST success into a receipt after note ${boundary} loss`, async () => {
    const pending = Promise.withResolvers<Response>()
    const status = vi.fn(async (requestId: string) => creationReceipt(requestId))
    const mounted = await mount(true, { create: () => pending.promise, status })
    await openPublication(mounted.host)
    await submitPublication(mounted.host)
    expect(mounted.writes).toHaveLength(1)
    if (boundary === 'identity') mounted.store.user.id = 2
    else if (boundary === 'permission') {
      mounted.api.read.mockRejectedValue(new LiveNotesApiError(403, 'NOTE_FORBIDDEN', 'Access revoked'))
      mounted.store.user.permissions = []
    } else mounted.sockets[0].message({ type: 'error', code: 'NOTE_FORBIDDEN', error: 'Source access revoked' })
    await settle()
    pending.resolve(jsonResponse({ page: { id: 999, sourceRevision: 23, updatedAt: '2026-10-22T00:00:00.000Z' } }))
    await settle()
    expect(status).not.toHaveBeenCalled()
    expect(mounted.host.querySelector('[aria-labelledby="note-creations-title"] a')).toBeNull()
    expect(mounted.host.querySelector('[aria-labelledby="note-publish-title"] pre')?.textContent).toBe('Body ![asset](/assets/image.png)')
    await submitPublication(mounted.host)
    expect(mounted.writes).toHaveLength(1)
    expect(mounted.errors).toEqual([])
  })
}

it('keeps a malformed 4xx write response uncertain rather than offering a corrected second POST', async () => {
  const mounted = await mount(true, { create: async () => jsonResponse({}, 409) })
  await openPublication(mounted.host)
  await submitPublication(mounted.host)
  expect(button(mounted.host, 'Review a corrected new attempt')).toBeUndefined()
  expect(button(mounted.host, 'Check creation status')).toBeDefined()
  await submitPublication(mounted.host)
  expect(mounted.writes).toHaveLength(1)
  expect(mounted.host.querySelector('[aria-labelledby="note-publish-title"] pre')?.textContent).toBe('Body ![asset](/assets/image.png)')
  expect(mounted.errors).toEqual([])
})
