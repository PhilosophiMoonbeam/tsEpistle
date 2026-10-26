import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type { AgentCurrentPageHint, AgentThreadState } from '../../shared/agents/contracts.ts'
import type { WikiSource } from '../../shared/wiki-source.ts'
import {
  AGENT_CHAT_RECENT_MAX_AGE,
  AGENT_CHAT_RECENT_STORAGE_KEY,
  clearAgentChatRecent,
  readAgentChatRecent,
  writeAgentChatRecent
} from '../helpers/agent-chat-continuity.ts'
import type { BrowserFetch } from '../helpers/json-transport.ts'
import { useAgentsStore } from './agents.ts'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const page = (n: number, locale = 'en'): AgentCurrentPageHint => ({ id: n, locale, path: `page-${n}`, observedUpdatedAt: '2026-09-18T00:00:00Z' })
const source = (n: number): WikiSource => ({
  id: n,
  locale: 'en',
  path: `page-${n}`,
  title: `Page ${n}`,
  description: '',
  visibility: 'public',
  updatedAt: '2026-09-18T00:00:00Z',
  sourceRevision: 'revision',
  excerpt: `Private excerpt ${n}`,
  excerptTruncated: false
})
const thread = (n: number): AgentThreadState => ({
  session: {
    id: id(n),
    title: '',
    retention: 'saved',
    folderId: null,
    status: 'active',
    executionMode: 'agent',
    version: 1,
    providerProfileId: null,
    profileResolutionToken: 'token',
    mediaCapabilities: null,
    skills: [],
    currentRun: null,
    createdAt: '2026-09-18T00:00:00Z',
    updatedAt: '2026-09-18T00:00:00Z',
    lastActivityAt: '2026-09-18T00:00:00Z',
    expiresAt: null
  },
  routingDecisions: [],
  specialistInvocations: [],
  messages: [],
  tools: [],
  tasks: [],
  goal: null,
  proposals: [],
  artifacts: [],
  suggestions: [],
  historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false }
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
  let sessionList: (() => Promise<Response>) | undefined
  const fetchHost: { fetch: BrowserFetch } = window
  const fetcher = vi.spyOn(fetchHost, 'fetch').mockImplementation(async (input, init) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    if (path === '/_api/agents/sessions') {
      if (method === 'POST')
        return createStatus === 201
          ? Response.json(thread(++created), { status: 201 })
          : Response.json({ message: 'Create unavailable' }, { status: createStatus })
      if (method === 'GET' && sessionList) return sessionList()
      return Response.json({ sessions: [], nextCursor: null })
    }
    if (path === '/_api/agents/conversation-folders') return Response.json({ folders: [] })
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
  return {
    fetcher,
    readStatus,
    sourceStatus,
    get created() {
      return created
    },
    failCreate: () => {
      createStatus = 503
    },
    deferPreview: (value: typeof preview) => {
      preview = value
    },
    deferSessionList: (value: typeof sessionList) => {
      sessionList = value
    }
  }
}
const initialize = (store: ReturnType<typeof useAgentsStore>, currentPage: AgentCurrentPageHint | null = page(1), ownerId = 1, resumeSessionId?: string) =>
  store.initialize('csrf', { ownerId, routeSync: false, currentPage, ...(resumeSessionId ? { resumeSessionId } : {}) })
afterEach(() => {
  for (const store of stores.splice(0)) store.closeWorkspace()
  vi.restoreAllMocks()
  clearAgentChatRecent()
})

describe('Automatic Agent conversation continuity', () => {
  it('resumes the same conversation and in-memory draft across pages, locales, and null-page navigation', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Keep my unsent composition')
    store.closeWorkspace()
    store.setCurrentPage(page(2))
    store.setCurrentPage(null)
    store.setCurrentPage(page(3, 'fr'))
    expect(api.created).toBe(1)
    expect(await initialize(store, page(3, 'fr'))).toBe(true)
    expect(store.thread?.session.id).toBe(id(1))
    expect(store.drafts[id(1)]?.text).toBe('Keep my unsent composition')
    expect(store.contextPage).toEqual(page(3, 'fr'))
    store.closeWorkspace()
    expect(await initialize(store, null)).toBe(true)
    expect(api.created).toBe(1)
    expect(api.fetcher.mock.calls.filter(([url]) => url === `/_api/agents/sessions/${id(1)}`)).toHaveLength(2)
  })

  it('stamps the first close once and expires closed continuity at the eight-hour wall-clock boundary', async () => {
    const api = fixture()
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Working-day draft')
    store.closeWorkspace()
    now += 60_000
    store.closeWorkspace()
    expect(readAgentChatRecent(1)?.closedAt).toBe(1_000_000)
    // A suspended tab may return without any timer callbacks having run.
    now = 1_000_000 + AGENT_CHAT_RECENT_MAX_AGE - 1
    expect(await initialize(store)).toBe(true)
    expect(api.created).toBe(1)
    expect(store.drafts[id(1)]?.text).toBe('Working-day draft')
    store.closeWorkspace()
    now += AGENT_CHAT_RECENT_MAX_AGE
    expect(await initialize(store, page(2))).toBe(true)
    expect(api.created).toBe(2)
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(2))
  })

  it('reloads the latest authorized open selection on another page without persisting plaintext', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Private unsent text')
    const reloaded = createStore()
    reloaded.setCurrentPage(page(2))
    expect(await initialize(reloaded, page(2))).toBe(true)
    expect(api.created).toBe(1)
    expect(api.fetcher.mock.calls.some(([url]) => url === `/_api/agents/sessions/${id(1)}`)).toBe(true)
    expect(reloaded.drafts[id(1)]?.text).toBe('')
    expect(window.sessionStorage.getItem(AGENT_CHAT_RECENT_STORAGE_KEY)).not.toContain('Private')
  })

  it('does not time out a live workspace or create a chat during navigation or read-only revalidation', async () => {
    const api = fixture()
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const store = createStore()
    await initialize(store)
    now += AGENT_CHAT_RECENT_MAX_AGE * 2
    store.setCurrentPage(page(2))
    expect(store.isWorkspaceReady()).toBe(true)
    expect(await store.initialize('csrf', { ownerId: 1, routeSync: false, currentPage: page(2), allowCreate: false })).toBe(true)
    expect(api.created).toBe(1)
    store.closeWorkspace()
    now += AGENT_CHAT_RECENT_MAX_AGE
    expect(await store.initialize('csrf', { ownerId: 1, routeSync: false, currentPage: page(3), allowCreate: false })).toBe(false)
    expect(api.created).toBe(1)
    expect(readAgentChatRecent(1)).toBeNull()
  })

  it('lets explicit history and New chat replace the automatic selection across later opens', async () => {
    const api = fixture()
    writeAgentChatRecent(1, id(20), Date.now())
    const store = createStore()
    await initialize(store, page(1), 1, id(40))
    expect(store.thread?.session.id).toBe(id(40))
    expect(api.fetcher.mock.calls.some(([url]) => url === `/_api/agents/sessions/${id(20)}`)).toBe(false)
    store.closeWorkspace()
    await initialize(store, page(2))
    expect(store.thread?.session.id).toBe(id(40))
    expect(await store.newSession('saved')).toBe(true)
    expect(store.thread?.session.id).toBe(id(1))
    store.closeWorkspace()
    await initialize(store, page(3))
    expect(store.thread?.session.id).toBe(id(1))
    expect(api.created).toBe(1)
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(1))
  })

  it('gives an explicit session route priority over both a requested resume and the tab selector', async () => {
    const api = fixture()
    writeAgentChatRecent(1, id(20), Date.now())
    const originalUrl = window.location.href
    try {
      window.history.replaceState(null, '', `/sessions/${id(40)}`)
      const store = createStore()
      expect(await store.initialize('csrf', { ownerId: 1, currentPage: page(2), resumeSessionId: id(30) })).toBe(true)
      expect(store.thread?.session.id).toBe(id(40))
      expect(readAgentChatRecent(1)?.sessionId).toBe(id(40))
      expect(api.fetcher.mock.calls.some(([url]) => url === `/_api/agents/sessions/${id(20)}` || url === `/_api/agents/sessions/${id(30)}`)).toBe(false)
      expect(api.created).toBe(0)
    } finally {
      window.history.replaceState(null, '', originalUrl)
    }
  })

  it('lets history selection supersede initialization while the initial history read is pending', async () => {
    const api = fixture()
    writeAgentChatRecent(1, id(20), Date.now())
    const history = Promise.withResolvers<Response>()
    api.deferSessionList(() => history.promise)
    const store = createStore()
    const initializing = initialize(store)
    expect(await store.openSession(id(40))).toBe(true)
    history.resolve(Response.json({ sessions: [], nextCursor: null }))
    expect(await initializing).toBe(false)
    expect(store.thread?.session.id).toBe(id(40))
    expect(store.isWorkspaceReady()).toBe(true)
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(40))
    expect(api.fetcher.mock.calls.some(([url]) => url === `/_api/agents/sessions/${id(20)}`)).toBe(false)
    expect(api.created).toBe(0)
  })

  it('preserves the selected conversation and its composition if explicit New chat fails', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Do not lose this')
    api.failCreate()
    await expect(store.newSession('saved')).rejects.toThrow('Create unavailable')
    expect(store.thread?.session.id).toBe(id(1))
    expect(store.drafts[id(1)]?.text).toBe('Do not lose this')
    store.closeWorkspace()
    expect(await initialize(store, page(2))).toBe(true)
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(1))
  })

  it('retains a forbidden selector without creating, then replaces a gone conversation without replaying its request', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Review this composition, do not replay it')
    store.closeWorkspace()
    api.readStatus.set(id(1), 403)
    expect(await initialize(store, page(2))).toBe(false)
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(1))
    expect(api.created).toBe(1)
    api.readStatus.set(id(1), 410)
    expect(await initialize(store, page(2))).toBe(true)
    expect(store.thread?.session.id).toBe(id(2))
    expect(store.drafts[id(2)]?.text).toBe('Review this composition, do not replay it')
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(2))
    expect(api.fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/messages') && init?.method === 'POST')).toBe(false)
  })

  it('recovers a same-owner composition after terminal deletion without restoring the retired selector', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Review this after the conversation expired')
    api.readStatus.set(id(1), 410)
    expect((await store.refreshThread()).accepted).toBe(false)
    expect(store.workspaceCloseReason).toBe('session-unavailable')
    expect(store.isWorkspaceReady()).toBe(false)
    expect(readAgentChatRecent(1)).toBeNull()
    expect(await store.initialize('csrf', { ownerId: 1, routeSync: false, currentPage: page(2), allowCreate: false })).toBe(false)
    expect(api.created).toBe(1)
    expect(await initialize(store, page(2))).toBe(true)
    expect(store.thread?.session.id).toBe(id(2))
    expect(store.drafts[id(2)]?.text).toBe('Review this after the conversation expired')
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(2))
    expect(api.fetcher.mock.calls.filter(([url, init]) => url === `/_api/agents/sessions/${id(1)}` && (init?.method ?? 'GET') === 'GET')).toHaveLength(1)
    expect(api.fetcher.mock.calls.some(([url, init]) => String(url).endsWith('/messages') && init?.method === 'POST')).toBe(false)
  })

  it('clears selectors and plaintext on authentication loss and owner changes', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Owner one')
    store.closeWorkspace()
    await initialize(store, page(2), 2)
    expect(store.drafts[id(1)]).toBeUndefined()
    expect(store.workspaceOwnerId).toBe(2)
    expect(readAgentChatRecent(2)?.sessionId).toBe(id(2))
    store.setDraft(id(2), 'Owner two')
    store.closeWorkspace()
    api.readStatus.set(id(2), 401)
    expect(await initialize(store, page(3), 2)).toBe(false)
    expect(store.thread).toBeNull()
    expect(store.drafts).toEqual({})
    expect(readAgentChatRecent(2)).toBeNull()
    expect(api.created).toBe(2)
    expect(store.workspaceCloseReason).toBe('authentication')
  })

  it('uses owner-scoped memory when tab storage is denied, and logout clears that fallback', async () => {
    const api = fixture()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Memory-only draft')
    store.closeWorkspace()
    expect(await initialize(store, page(2))).toBe(true)
    expect(api.created).toBe(1)
    expect(store.drafts[id(1)]?.text).toBe('Memory-only draft')
    store.destroyWorkspace()
    expect(store.thread).toBeNull()
    expect(store.drafts).toEqual({})
    expect(readAgentChatRecent(1)).toBeNull()
    await initialize(store, page(3), 2)
    expect(api.created).toBe(2)
    expect(store.drafts[id(1)]).toBeUndefined()
  })

  it('keeps memory authoritative through denied storage writes and removals, including after access recovers', () => {
    writeAgentChatRecent(1, id(20), Date.now())
    const deniedWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
    writeAgentChatRecent(1, id(40), Date.now())
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(40))
    deniedWrite.mockRestore()
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(40))
    const deniedRemoval = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
    clearAgentChatRecent()
    expect(readAgentChatRecent(1)).toBeNull()
    deniedRemoval.mockRestore()
    expect(readAgentChatRecent(1)).toBeNull()
    expect(window.sessionStorage.getItem(AGENT_CHAT_RECENT_STORAGE_KEY)).toBeNull()
  })

  it('does not resurrect a deleted or cleared selection if replacement creation fails', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.setDraft(id(1), 'Delete this draft')
    api.failCreate()
    expect(await store.removeSession(id(1))).toBe(true)
    expect(store.thread).toBeNull()
    expect(readAgentChatRecent(1)).toBeNull()
    store.closeWorkspace()
    expect(readAgentChatRecent(1)).toBeNull()
    expect(await initialize(store, page(2))).toBe(false)
    expect(api.fetcher.mock.calls.some(([url, init]) => url === `/_api/agents/sessions/${id(1)}` && (init?.method ?? 'GET') === 'GET')).toBe(false)

    await store.openSession(id(30))
    store.setDraft(id(30), 'Clear this draft')
    await store.clearUnfiledHistory()
    expect(store.thread).toBeNull()
    expect(store.drafts[id(30)]).toBeUndefined()
    expect(readAgentChatRecent(1)).toBeNull()
    store.closeWorkspace()
    expect(readAgentChatRecent(1)).toBeNull()
  })
})

describe('Automatic conversation source context', () => {
  it('keeps explicit sources and current-page opt-outs while browsing, without accumulating implicit pages', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.updateDraft(id(1), { sources: [source(9), source(2)], includeCurrentPage: false })
    await initialize(store, page(2))
    await initialize(store, page(3))
    await initialize(store, page(1, 'fr'))
    expect(store.drafts[id(1)]?.sources.map(item => item.id)).toEqual([9, 2])
    expect(store.drafts[id(1)]?.includeCurrentPage).toBe(false)
    expect(api.fetcher.mock.calls.some(([url]) => String(url).startsWith('/_api/pages/preview'))).toBe(false)
    store.updateDraft(id(1), { includeCurrentPage: true })
    await initialize(store, page(4))
    expect(store.drafts[id(1)]?.sources.map(item => item.id)).toEqual([9, 2])
    expect(store.drafts[id(1)]?.includeCurrentPage).toBe(true)
    expect(store.contextTransferNotice).toBe('')
  })

  it('stores bounded selectors only and reauthorizes explicit sources after cold cross-page restore', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.updateDraft(id(1), { text: 'Secret draft', sources: [source(9), source(10)], includeCurrentPage: false })
    store.closeWorkspace()
    const raw = window.sessionStorage.getItem(AGENT_CHAT_RECENT_STORAGE_KEY)!
    expect(JSON.parse(raw).context).toEqual({ includeCurrentPage: false, sources: [{ id: 9, locale: 'en' }, { id: 10, locale: 'en' }] })
    expect(raw).not.toContain('Secret')
    expect(raw).not.toContain('excerpt')
    expect(raw).not.toContain('token')
    api.sourceStatus.set(10, 403)
    const reloaded = createStore()
    expect(await initialize(reloaded, page(2))).toBe(true)
    expect(reloaded.drafts[id(1)]?.sources.map(item => item.id)).toEqual([9])
    expect(reloaded.drafts[id(1)]?.includeCurrentPage).toBe(false)
    expect(reloaded.drafts[id(1)]?.text).toBe('')
    expect(reloaded.contextTransferNotice).toContain('could not be restored')
    expect(api.fetcher.mock.calls.filter(([url]) => String(url).startsWith('/_api/pages/preview')).map(([url]) => new URL(String(url), 'http://localhost').searchParams.get('id'))).toEqual(['9', '10'])
    await initialize(reloaded, page(3))
    expect(reloaded.contextTransferNotice).toContain('could not be restored')
  })

  it('never converts a former implicit page into an explicit source after cold restore', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    store.closeWorkspace()
    const reloaded = createStore()
    await initialize(reloaded, page(2))
    expect(reloaded.drafts[id(1)]?.sources).toEqual([])
    expect(reloaded.drafts[id(1)]?.includeCurrentPage).toBe(true)
    expect(api.fetcher.mock.calls.some(([url]) => String(url).startsWith('/_api/pages/preview'))).toBe(false)
  })

  it('leaves a reviewed request original hint and source choices unchanged across navigation', async () => {
    fixture()
    const store = createStore()
    await initialize(store)
    const original = page(7)
    store.updateDraft(id(1), { text: 'Reviewed original request', currentPageOverride: original, sources: [source(9)], includeCurrentPage: true })
    store.closeWorkspace()
    await initialize(store, page(2))
    expect(store.drafts[id(1)]?.currentPageOverride).toEqual(original)
    expect(store.drafts[id(1)]?.sources.map(item => item.id)).toEqual([9])
    expect(store.contextPage).toEqual(page(2))
  })

  it('discards a late authorized source response after the owner changes', async () => {
    const api = fixture()
    writeAgentChatRecent(1, id(20), Date.now(), { includeCurrentPage: false, sources: [{ id: 9, locale: 'en' }] })
    const store = createStore()
    const preview = Promise.withResolvers<Response>()
    const requestStarted = Promise.withResolvers<void>()
    api.deferPreview(() => {
      requestStarted.resolve()
      return preview.promise
    })
    const oldInitialization = initialize(store, page(2))
    await requestStarted.promise
    await initialize(store, page(3), 2)
    preview.resolve(Response.json(source(9)))
    expect(await oldInitialization).toBe(false)
    expect(store.workspaceOwnerId).toBe(2)
    expect(store.drafts[id(20)]).toBeUndefined()
    expect(readAgentChatRecent(2)?.sessionId).toBe(id(1))
    expect(store.contextTransferNotice).toBe('')
  })

  it('cancels a cold source restore on close without losing selectors or marking the workspace ready', async () => {
    const api = fixture()
    const context = { includeCurrentPage: false, sources: [{ id: 9, locale: 'en' }] }
    writeAgentChatRecent(1, id(20), Date.now(), context)
    const store = createStore()
    const preview = Promise.withResolvers<Response>()
    const requestStarted = Promise.withResolvers<void>()
    api.deferPreview(() => {
      requestStarted.resolve()
      return preview.promise
    })
    const pending = initialize(store, page(2))
    await requestStarted.promise
    store.closeWorkspace()
    preview.resolve(Response.json(source(9)))
    expect(await pending).toBe(false)
    expect(store.drafts[id(20)]).toBeUndefined()
    expect(store.isWorkspaceReady()).toBe(false)
    expect(readAgentChatRecent(1)?.context).toEqual(context)
  })

  it('lets explicit history supersede a pending cold source restore without selecting the old chat again', async () => {
    const api = fixture()
    writeAgentChatRecent(1, id(20), Date.now(), { includeCurrentPage: true, sources: [{ id: 9, locale: 'en' }] })
    const store = createStore()
    const preview = Promise.withResolvers<Response>()
    const requestStarted = Promise.withResolvers<void>()
    api.deferPreview(() => {
      requestStarted.resolve()
      return preview.promise
    })
    const restoring = initialize(store, page(2))
    await requestStarted.promise
    expect(await store.openSession(id(40))).toBe(true)
    preview.resolve(Response.json(source(9)))
    expect(await restoring).toBe(false)
    expect(store.thread?.session.id).toBe(id(40))
    expect(store.drafts[id(20)]).toBeUndefined()
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(40))
    store.closeWorkspace()
    await initialize(store, page(3))
    expect(store.thread?.session.id).toBe(id(40))
    expect(api.created).toBe(0)
  })

  it('rejects malformed, expired, future, invalid-owner, extra-field and oversized selectors without memory resurrection', () => {
    const now = Date.now()
    const valid = { version: 1, ownerId: 1, sessionId: id(1), closedAt: now, context: { includeCurrentPage: true, sources: [] } }
    const invalid: unknown[] = [
      '{',
      { ...valid, closedAt: now + 1 },
      { ...valid, closedAt: now - AGENT_CHAT_RECENT_MAX_AGE },
      { ...valid, ownerId: 2 },
      { ...valid, ownerId: 0 },
      { ...valid, sessionId: 'not-a-session' },
      { ...valid, page: { id: 1, locale: 'en' } },
      { ...valid, context: { includeCurrentPage: true, sources: [{ id: 9, locale: 'en', excerpt: 'Private' }] } },
      { ...valid, context: { includeCurrentPage: true, sources: Array.from({ length: 9 }, (_, n) => ({ id: n + 1, locale: 'en' })) } },
      { ...valid, context: { includeCurrentPage: true, sources: [{ id: 9, locale: 'en' }, { id: 9, locale: 'en' }] } },
      'x'.repeat(4097)
    ]
    for (const value of invalid) {
      writeAgentChatRecent(1, id(1), now)
      window.sessionStorage.setItem(AGENT_CHAT_RECENT_STORAGE_KEY, typeof value === 'string' ? value : JSON.stringify(value))
      expect(readAgentChatRecent(1, now)).toBeNull()
      expect(window.sessionStorage.getItem(AGENT_CHAT_RECENT_STORAGE_KEY)).toBeNull()
    }
    writeAgentChatRecent(1, id(1), now)
    expect(readAgentChatRecent(0, now)).toBeNull()
    expect(readAgentChatRecent(1, now)).toBeNull()
    window.sessionStorage.setItem('agents.chat-pin.v1', JSON.stringify({ version: 1, ownerId: 1, sessionId: id(99) }))
    expect(readAgentChatRecent(1, now)).toBeNull()
    expect(window.sessionStorage.getItem('agents.chat-pin.v1')).toBeNull()
  })
})
