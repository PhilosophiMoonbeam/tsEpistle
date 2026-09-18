import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type { AgentCurrentPageHint, AgentThreadState } from '../../shared/agents/contracts.ts'
import type { WikiSource } from '../../shared/wiki-source.ts'
import { AGENT_CHAT_PIN_STORAGE_KEY, AGENT_CHAT_RECENT_STORAGE_KEY, AGENT_CHAT_RECENT_MAX_AGE, clearAgentChatPin, readAgentChatPin, readAgentChatRecent, writeAgentChatPin, writeAgentChatRecent } from '../helpers/agent-chat-pin.ts'
import { useAgentsStore } from './agents.ts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const page = (n: number, locale = 'en'): AgentCurrentPageHint => ({ id: n, locale, path: `page-${n}`, observedUpdatedAt: '2026-09-18T00:00:00Z' })
const source = (n: number): WikiSource => ({ id: n, locale: 'en', path: `page-${n}`, title: `Page ${n}`, description: '', visibility: 'public', updatedAt: '2026-09-18T00:00:00Z', sourceRevision: 'revision', excerpt: `Private excerpt ${n}`, excerptTruncated: false })
const thread = (n: number): AgentThreadState => ({
  session: { id: id(n), title: '', retention: 'saved', folderId: null, status: 'active', executionMode: 'agent', version: 1, providerProfileId: null, profileResolutionToken: 'token', skills: [], currentRun: null, createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z', lastActivityAt: '2026-09-18T00:00:00Z', expiresAt: null },
  messages: [], tools: [], tasks: [], goal: null, proposals: [], artifacts: [], suggestions: [], historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false }
})
const stores: ReturnType<typeof useAgentsStore>[] = []
const createStore = () => {
  setActivePinia(createPinia())
  const store = useAgentsStore()
  stores.push(store)
  return store
}
const fixture = () => {
  let created = 0
  let createStatus = 201
  const readStatus = new Map<string, number>()
  const sourceStatus = new Map<number, number>()
  let preview: ((n: number) => Promise<Response>) | undefined
  const fetcher = vi.spyOn(window, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    if (path === '/_api/agents/sessions') {
      if (method === 'POST') return createStatus === 201 ? Response.json(thread(++created), { status: 201 }) : Response.json({ message: 'Create unavailable' }, { status: createStatus })
      return Response.json({ sessions: [], nextCursor: null })
    }
    if (path === '/_api/agents/conversation-folders') return Response.json({ folders: [] })
    if (path === '/_api/agents/profiles') return Response.json({ profiles: [] })
    if (path === '/_api/agents/skills') return Response.json({ skills: [] })
    if (path.startsWith('/_api/pages/preview?')) {
      const n = Number(new URL(path, 'http://localhost').searchParams.get('id'))
      if (preview) return preview(n)
      const status = sourceStatus.get(n) ?? 200
      return Response.json(status === 200 ? source(n) : { message: 'Source unavailable' }, { status })
    }
    if (path.startsWith('/_api/agents/sessions/')) {
      if (method === 'DELETE') return Response.json({ deleted: true })
      const sessionId = path.split('/').at(-1)!
      const status = readStatus.get(sessionId) ?? 200
      return Response.json(status === 200 ? thread(Number(sessionId.slice(-12))) : { message: 'Session unavailable' }, { status })
    }
    throw new Error(`Unexpected ${method} ${path}`)
  })
  return { fetcher, readStatus, sourceStatus, get created() { return created }, failCreate: () => { createStatus = 503 }, deferPreview: (value: typeof preview) => { preview = value } }
}
const initialize = (store: ReturnType<typeof useAgentsStore>, currentPage: AgentCurrentPageHint | null = page(1), ownerId = 1, resumeSessionId?: string) => store.initialize('csrf', { ownerId, routeSync: false, currentPage, ...(resumeSessionId ? { resumeSessionId } : {}) })
afterEach(() => {
  for (const store of stores.splice(0)) store.closeWorkspace()
  clearAgentChatPin()
  vi.restoreAllMocks()
})

describe('Agent chat continuity', () => {
  it('resumes a same-page chat before fifteen minutes, stamps duplicate closes once, and expires at the boundary', async () => {
    const api = fixture()
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const store = createStore()
    expect(await initialize(store)).toBe(true)
    store.closeWorkspace()
    now += 60_000
    store.closeWorkspace()
    expect(readAgentChatRecent(1, page(1))?.closedAt).toBe(1_000_000)
    expect(await initialize(store)).toBe(true)
    expect(api.created).toBe(1)
    store.closeWorkspace()
    now += AGENT_CHAT_RECENT_MAX_AGE
    expect(await initialize(store)).toBe(true)
    expect(api.created).toBe(2)
  })

  it('resumes from tab storage after a same-page reload with a fresh authorization read', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.closeWorkspace()
    const reloaded = createStore()
    reloaded.notePageNavigation(page(1), 1)
    expect(await initialize(reloaded)).toBe(true)
    expect(api.created).toBe(1)
    expect(api.fetcher.mock.calls.some(([url]) => url === `/_api/agents/sessions/${id(1)}`)).toBe(true)
  })

  it('clears a recent session on 401 without creating or retaining its draft', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Sensitive draft')
    store.closeWorkspace()
    api.readStatus.set(id(1), 401)
    expect(await initialize(store)).toBe(false)
    expect(store.thread).toBeNull()
    expect(store.drafts).toEqual({})
    expect(api.created).toBe(1)
    expect(readAgentChatRecent(1, page(1))).toBeNull()
  })

  it('keeps an open workspace through revalidation beyond the close timeout', async () => {
    const api = fixture()
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const store = createStore()
    await initialize(store)
    now += AGENT_CHAT_RECENT_MAX_AGE * 2
    await initialize(store)
    expect(api.created).toBe(1)
  })

  it('resumes null-page contexts, but navigation between null and a page invalidates the recent chat', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store, null)
    store.closeWorkspace()
    await initialize(store, null)
    expect(api.created).toBe(1)
    store.closeWorkspace()
    store.notePageNavigation(page(1))
    store.notePageNavigation(null)
    await initialize(store, null)
    expect(api.created).toBe(2)
  })

  it('invalidates a stored recent selector on fresh-page mount before Agent is opened, even after returning', async () => {
    const api = fixture()
    const first = createStore()
    await initialize(first)
    first.closeWorkspace()
    const reloaded = createStore()
    reloaded.notePageNavigation(page(2), 1)
    reloaded.notePageNavigation(page(1), 1)
    await initialize(reloaded)
    expect(api.created).toBe(2)
  })

  it('creates on an unpinned page or locale change and preserves the old draft if creation fails', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Keep this unsent draft')
    api.failCreate()
    expect(await initialize(store, page(1, 'fr'))).toBe(false)
    expect(store.thread?.session.id).toBe(id(1))
    expect(store.drafts[id(1)]?.text).toBe('Keep this unsent draft')
    expect(store.isWorkspaceReady()).toBe(false)
  })

  it('honors explicit history before the pin, and a pin before a recent selector regardless of age', async () => {
    const api = fixture()
    writeAgentChatPin(1, id(20))
    writeAgentChatRecent(1, id(30), page(1), Date.now() - AGENT_CHAT_RECENT_MAX_AGE)
    const store = createStore()
    await initialize(store)
    expect(store.thread?.session.id).toBe(id(20))
    store.closeWorkspace()
    await initialize(store, page(1), 1, id(40))
    expect(store.thread?.session.id).toBe(id(40))
    expect(store.pinnedSessionId).toBeNull()
    expect(api.created).toBe(0)
  })

  it('falls back for a deleted pin but retains a forbidden pin without creating another chat', async () => {
    const api = fixture()
    writeAgentChatPin(1, id(20))
    api.readStatus.set(id(20), 403)
    const store = createStore()
    expect(await initialize(store)).toBe(false)
    expect(readAgentChatPin(1).sessionId).toBe(id(20))
    expect(api.created).toBe(0)
    api.readStatus.set(id(20), 410)
    expect(await initialize(store)).toBe(true)
    expect(readAgentChatPin(1).sessionId).toBeNull()
    expect(api.created).toBe(1)
  })

  it('isolates owners and clears selectors and plaintext on verified identity loss', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Owner one')
    store.closeWorkspace()
    await initialize(store, page(1), 2)
    expect(api.created).toBe(2)
    expect(store.drafts[id(1)]).toBeUndefined()
    store.setCurrentChatPinned(true)
    store.destroyWorkspace()
    expect(store.thread).toBeNull()
    expect(window.sessionStorage.getItem(AGENT_CHAT_PIN_STORAGE_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(AGENT_CHAT_RECENT_STORAGE_KEY)).toBeNull()
  })
})

describe('Pinned page context', () => {
  it('carries included pages, preserves user sources, deduplicates the current page, and honors exclusions', async () => {
    fixture()
    const store = createStore()
    await initialize(store)
    store.updateDraft(id(1), { sources: [source(9)] })
    store.setCurrentChatPinned(true)
    store.notePageNavigation(page(2))
    await initialize(store, page(2))
    expect(store.drafts[id(1)]?.sources.map(item => item.id)).toEqual([9, 1])
    store.updateDraft(id(1), { includeCurrentPage: false })
    await initialize(store, page(2))
    expect(store.drafts[id(1)]?.includeCurrentPage).toBe(false)
    await initialize(store, page(3))
    expect(store.drafts[id(1)]?.sources.map(item => item.id)).toEqual([9, 1])
    expect(store.drafts[id(1)]?.includeCurrentPage).toBe(true)
    await initialize(store, page(1))
    expect(store.drafts[id(1)]?.sources.map(item => item.id)).toEqual([9, 3])
  })

  it('retains eight sources and explains how to include the previous page without evicting a source', async () => {
    fixture()
    const store = createStore()
    await initialize(store)
    store.updateDraft(id(1), { sources: Array.from({ length: 8 }, (_, n) => source(n + 10)) })
    store.setCurrentChatPinned(true)
    await initialize(store, page(2))
    expect(store.drafts[id(1)]?.sources.map(item => item.id)).toEqual([10, 11, 12, 13, 14, 15, 16, 17])
    expect(store.contextTransferNotice).toContain('Remove a source')
  })

  it('stores selectors only, hydrates fresh previews after reload, and skips sources without current access', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.updateDraft(id(1), { text: 'Secret draft', sources: [source(9), source(10)], includeCurrentPage: false })
    store.setCurrentChatPinned(true)
    store.closeWorkspace()
    const raw = window.sessionStorage.getItem(AGENT_CHAT_PIN_STORAGE_KEY)!
    expect(raw).not.toContain('Secret')
    expect(raw).not.toContain('excerpt')
    api.sourceStatus.set(10, 403)
    const reloaded = createStore()
    await initialize(reloaded)
    expect(reloaded.drafts[id(1)]?.sources.map(item => item.id)).toEqual([9])
    expect(reloaded.drafts[id(1)]?.includeCurrentPage).toBe(false)
    expect(reloaded.contextTransferNotice).toContain('Check access')
    expect(reloaded.drafts[id(1)]?.text).toBe('')
  })

  it('does not manufacture an old page when a pinned chat started outside a page', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store, null)
    store.setCurrentChatPinned(true)
    store.notePageNavigation(page(2))
    await initialize(store, page(2))
    expect(store.drafts[id(1)]?.sources).toEqual([])
    expect(api.fetcher.mock.calls.filter(([url]) => String(url).startsWith('/_api/pages/preview'))).toHaveLength(0)
  })

  it('discards a late authorized preview after the owner changes', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setCurrentChatPinned(true)
    let resolve!: (response: Response) => void
    let requested!: () => void
    const requestStarted = new Promise<void>(done => { requested = done })
    api.deferPreview(() => { requested(); return new Promise(done => { resolve = done }) })
    const oldInitialization = initialize(store, page(2))
    await requestStarted
    await initialize(store, page(3), 2)
    resolve(Response.json(source(1)))
    expect(await oldInitialization).toBe(false)
    expect(store.pinOwnerId).toBe(2)
    expect(store.drafts[id(1)]).toBeUndefined()
    expect(store.contextTransferNotice).toBe('')
  })

  it('aborts pending page hydration on close without committing sources or a ready workspace', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setCurrentChatPinned(true)
    let resolve!: (response: Response) => void
    let requested!: () => void
    const requestStarted = new Promise<void>(done => { requested = done })
    api.deferPreview(() => { requested(); return new Promise(done => { resolve = done }) })
    const pending = initialize(store, page(2))
    await requestStarted
    store.closeWorkspace()
    resolve(Response.json(source(1)))
    expect(await pending).toBe(false)
    expect(store.drafts[id(1)]?.sources ?? []).toEqual([])
    expect(store.isWorkspaceReady()).toBe(false)
    expect(readAgentChatPin(1).context?.page?.id).toBe(1)
  })

  it('rejects malformed, future, wrong-owner and extra-field selectors without memory resurrection', () => {
    const now = Date.now()
    writeAgentChatRecent(1, id(1), page(1), now)
    window.sessionStorage.setItem(AGENT_CHAT_RECENT_STORAGE_KEY, '{')
    expect(readAgentChatRecent(1, page(1), now)).toBeNull()
    writeAgentChatRecent(1, id(1), page(1), now + 1)
    expect(readAgentChatRecent(1, page(1), now)).toBeNull()
    writeAgentChatRecent(1, id(1), page(1), now)
    expect(readAgentChatRecent(2, page(1), now)).toBeNull()
    window.sessionStorage.setItem(AGENT_CHAT_PIN_STORAGE_KEY, JSON.stringify({ version: 1, ownerId: 1, sessionId: id(1), context: { page: null, includeCurrentPage: true, sources: [{ id: 1, locale: 'en', excerpt: 'Private' }] } }))
    expect(readAgentChatPin(1).sessionId).toBeNull()
  })
})
