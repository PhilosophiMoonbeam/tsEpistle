import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'
import type { AgentCurrentPageHint, AgentPresetId, AgentThreadState } from '../../shared/agents/contracts.ts'
import type { WikiSource, WikiSourcePreview } from '../../shared/wiki-source.ts'
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
  sourceRevision: '1',
  excerpt: `Private excerpt ${n}`,
  excerptTruncated: false
})
const previewSource = (n: number): WikiSourcePreview => ({
  ...source(n),
  structuredExcerpt: { html: `<p>Private excerpt ${n}</p>`, truncated: false }
})
let fixtureOwnerId = 1
// Fixture envelope only: these client tests do not exercise server signature verification.
const admissionToken = (sessionId: string, ownerId: number, sessionVersion = 1): string => {
  const kid = 'continuity-test'
  const payload = {
    v: 1,
    kid,
    ownerId,
    sessionId,
    sessionVersion,
    profileId: id(900),
    profileVersionId: id(901),
    profileVersion: 1,
    profilePolicyVersion: 1,
    defaultGeneration: 1,
    executionMode: 'agent',
    exp: 4_000_000_000
  }
  return `${kid}.${btoa(JSON.stringify(payload)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')}.fixture-signature`
}
const thread = (n: number): AgentThreadState => ({
  memoryContext: {
    ownerId: fixtureOwnerId,
    sessionId: id(n),
    frozen: { snapshotId: null, user: { state: 'unknown' }, agent: { state: 'unknown' } },
    latestSaved: { user: { state: 'unknown' }, agent: { state: 'unknown' } },
    nextSession: { user: 'unknown', agent: 'unknown' }
  },
  session: {
    id: id(n),
    title: '',
    retention: 'saved',
    folderId: null,
    status: 'active',
    executionMode: 'agent',
    version: 1,
    providerProfileId: null,
    profileResolutionToken: admissionToken(id(n), fixtureOwnerId),
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
type Submission = { readonly sessionId: string; readonly endpoint: string; readonly body: Record<string, unknown> }
// Match the polling fixture's transport boundary: subscription stays real, but
// these command-continuity cases do not deliver stream frames.
class FakeEventSource {
  readonly listeners: Record<string, EventListener[]> = {}
  readonly close = vi.fn()
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: EventListener) {
    const listeners = (this.listeners[type] ??= [])
    listeners.push(listener)
  }
}
const fixture = () => {
  vi.stubGlobal('EventSource', FakeEventSource)
  let created = 0
  let createStatus = 201
  const readStatus = new Map<string, number>()
  const sourceStatus = new Map<number, number>()
  let preview: ((n: number) => Promise<Response>) | undefined
  let sessionList: (() => Promise<Response>) | undefined
  let threadRead: ((n: number) => Promise<Response>) | undefined
  let submissionPost: ((submission: Submission) => Promise<Response>) | undefined
  const messages = new Map<number, AgentThreadState['messages']>()
  const submissions: Submission[] = []
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
      return Response.json(status === 200 ? previewSource(n) : { message: 'Source unavailable' }, { status })
    }
    if (path.startsWith('/_api/agents/sessions/')) {
      if (method === 'DELETE') return Response.json({ deleted: true })
      if (method === 'POST') {
        const sessionId = path.split('/')[4]!
        const endpoint = path.split('/')[5]!
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        const submission = { sessionId, endpoint, body }
        submissions.push(submission)
        if (submissionPost) return submissionPost(submission)
        const run = {
          id: id(950),
          sessionId,
          status: 'queued',
          attempt: 0,
          eventSequence: 1,
          canCancel: true,
          createdAt: '2026-09-18T00:00:00Z',
          startedAt: null,
          completedAt: null,
          errorCode: null,
          errorMessage: null
        }
        if (endpoint === 'messages') {
          messages.set(Number(sessionId.slice(-12)), [
            {
              id: id(951),
              runId: run.id,
              ordinal: 1,
              role: 'user',
              status: 'complete',
              content: String(body.content),
              citations: [],
              createdAt: run.createdAt,
              updatedAt: run.createdAt,
              ...(body.presetId === undefined ? {} : { presetId: body.presetId as AgentPresetId })
            }
          ])
          return Response.json({ run, replayed: false }, { status: 202 })
        }
        if (endpoint === 'goals') {
          const goal: NonNullable<AgentThreadState['goal']> = {
            id: String(body.goalId),
            sessionId,
            objective: String(body.objective),
            status: 'active',
            version: 1,
            currentRunId: run.id,
            continuationCount: 0,
            maxContinuations: 3,
            consumedTokens: 0,
            maxTokens: 48_000,
            consumedToolCalls: 0,
            maxToolCalls: 96,
            budgetPolicyVersion: 1,
            budgetSelection: 'pending',
            tokenTier: null,
            tokenAllowance: null,
            budgetCycle: 0,
            budgetLimitReason: null,
            canRenewTokenBudget: false,
            startedAt: run.createdAt,
            deadlineAt: '2026-09-18T01:00:00Z',
            completedAt: null,
            errorCode: null,
            errorMessage: null,
            completion: null
          }
          return Response.json({ goal, run, replayed: false }, { status: 202 })
        }
        throw new Error(`Unexpected admission endpoint ${endpoint}`)
      }
      const sessionId = path.split('/').at(-1)!
      const status = readStatus.get(sessionId) ?? 200
      const n = Number(sessionId.slice(-12))
      if (status === 200 && threadRead) return threadRead(n)
      return Response.json(status === 200 ? { ...thread(n), messages: messages.get(n) ?? [] } : { message: 'Session unavailable' }, { status })
    }
    throw new Error(`Unexpected ${method} ${path}`)
  })
  return {
    fetcher,
    submissions,
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
    },
    deferThreadRead: (value: typeof threadRead) => {
      threadRead = value
    },
    deferSubmission: (value: typeof submissionPost) => {
      submissionPost = value
    }
  }
}
type AdmissionFixture = {
  readonly deferThreadRead: (read: (n: number) => Promise<Response>) => void
  readonly deferSubmission: (post: (submission: Submission) => Promise<Response>) => void
}
const idempotentMessageBoundary = (api: AdmissionFixture) => {
  type AcceptedCommand = { readonly payload: string; run: NonNullable<AgentThreadState['session']['currentRun']> }
  const commands = new Map<string, AcceptedCommand>()
  const snapshots = new Map<string, AgentThreadState>()
  const accepted = Promise.withResolvers<void>()
  const firstResponse = Promise.withResolvers<Response>()
  let first: AcceptedCommand | undefined
  // This boundary models server acceptance/replay only, not client retry or draft retirement.
  // A persisted replay proof retains the raw payload but excludes replaceable admission authority.
  const stablePayload = (body: Submission['body']): string => {
    const payload = { ...body }
    delete payload.expectedSessionVersion
    delete payload.profileResolutionToken
    return JSON.stringify(payload)
  }
  api.deferThreadRead(n => {
    const snapshot = snapshots.get(id(n))
    return Promise.resolve(Response.json(snapshot?.memoryContext.ownerId === fixtureOwnerId ? snapshot : thread(n)))
  })
  api.deferSubmission(async ({ sessionId, endpoint, body }) => {
    if (endpoint !== 'messages') throw new Error(`Unexpected command endpoint ${endpoint}`)
    const key = `${fixtureOwnerId}:${sessionId}:${String(body.clientRequestId)}`
    const payload = stablePayload(body)
    const previous = commands.get(key)
    if (previous)
      return previous.payload === payload
        ? Response.json({ run: previous.run, replayed: true }, { status: 202 })
        : Response.json({ error: 'RUN_REPLAY_CONFLICT', message: 'The original command payload changed.' }, { status: 409 })
    const run: AcceptedCommand['run'] = {
      id: id(950 + commands.size),
      sessionId,
      status: 'queued',
      attempt: 0,
      eventSequence: 1,
      canCancel: true,
      createdAt: '2026-09-18T00:00:00Z',
      startedAt: null,
      completedAt: null,
      errorCode: null,
      errorMessage: null
    }
    const command = { payload, run }
    commands.set(key, command)
    const current = snapshots.get(sessionId) ?? thread(Number(sessionId.slice(-12)))
    snapshots.set(sessionId, {
      ...current,
      session: { ...current.session, currentRun: run },
      messages: [
        ...current.messages,
        {
          id: id(1_500 + commands.size),
          runId: run.id,
          ordinal: current.messages.length + 1,
          role: 'user',
          status: 'complete',
          content: String(body.content),
          citations: [],
          createdAt: run.createdAt,
          updatedAt: run.createdAt,
          ...(body.presetId === undefined ? {} : { presetId: body.presetId as AgentPresetId })
        }
      ]
    })
    if (!first) {
      first = command
      accepted.resolve()
      return firstResponse.promise
    }
    return Response.json({ run, replayed: false }, { status: 202 })
  })
  return {
    get acceptedCommandCount() {
      return commands.size
    },
    waitForAcceptance: (sending: Promise<boolean>) =>
      Promise.race([
        accepted.promise,
        sending.then(() => {
          throw new Error('Send settled before the server accepted its POST')
        })
      ]),
    completeFirst: () => {
      if (!first) throw new Error('No accepted command to complete')
      first.run = {
        ...first.run,
        status: 'succeeded',
        canCancel: false,
        eventSequence: 2,
        startedAt: first.run.createdAt,
        completedAt: '2026-09-18T00:00:01Z'
      }
      const snapshot = snapshots.get(first.run.sessionId)!
      snapshots.set(first.run.sessionId, {
        ...snapshot,
        session: {
          ...snapshot.session,
          version: 2,
          profileResolutionToken: admissionToken(snapshot.session.id, snapshot.memoryContext.ownerId, 2),
          currentRun: first.run
        }
      })
    },
    dropFirstResponse: () => firstResponse.reject(new TypeError('Response lost after command acceptance')),
    deliverFirstResponse: () => {
      if (!first) throw new Error('No accepted command to acknowledge')
      firstResponse.resolve(Response.json({ run: first.run, replayed: false }, { status: 202 }))
    }
  }
}
const initialize = (store: ReturnType<typeof useAgentsStore>, currentPage: AgentCurrentPageHint | null = page(1), ownerId = 1, resumeSessionId?: string) => {
  fixtureOwnerId = ownerId
  return store.initialize('csrf', { ownerId, routeSync: false, currentPage, ...(resumeSessionId ? { resumeSessionId } : {}) })
}
afterEach(() => {
  fixtureOwnerId = 1
  for (const store of stores.splice(0)) store.closeWorkspace()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError')
    })
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
    const deniedWrite = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError')
    })
    writeAgentChatRecent(1, id(40), Date.now())
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(40))
    deniedWrite.mockRestore()
    expect(readAgentChatRecent(1)?.sessionId).toBe(id(40))
    const deniedRemoval = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Denied', 'SecurityError')
    })
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
    expect(JSON.parse(raw).context).toEqual({
      includeCurrentPage: false,
      sources: [
        { id: 9, locale: 'en' },
        { id: 10, locale: 'en' }
      ]
    })
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
    expect(
      api.fetcher.mock.calls
        .filter(([url]) => String(url).startsWith('/_api/pages/preview'))
        .map(([url]) => new URL(String(url), 'http://localhost').searchParams.get('id'))
    ).toEqual(['9', '10'])
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
    preview.resolve(Response.json(previewSource(9)))
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
    preview.resolve(Response.json(previewSource(9)))
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
    preview.resolve(Response.json(previewSource(9)))
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
      {
        ...valid,
        context: {
          includeCurrentPage: true,
          sources: [
            { id: 9, locale: 'en' },
            { id: 9, locale: 'en' }
          ]
        }
      },
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

  it('projects only committed attachments, dedupes the independent ninth hint and keeps pending selections out of requests', async () => {
    fixture()
    const store = createStore()
    await initialize(store, page(9))
    expect(store.sourceContext).toMatchObject({ attachedSources: [], currentPage: { included: true }, generation: store.workspaceVersion })
    const sources = Array.from({ length: 8 }, (_, index) => source(index + 1))
    store.updateDraft(id(1), { sources, pendingSources: [{ id: 10, locale: 'en', path: 'page-10' }] })
    expect(store.sourceContext?.attachedSources).toHaveLength(8)
    expect(store.sourceContext?.accessibleIdentities).toHaveLength(9)
    expect(store.sourceContext?.pendingSources).toEqual([{ id: 10, locale: 'en', path: 'page-10' }])
    expect(store.sourceContext?.accessibleIdentities.some(row => row.id === 10)).toBe(false)
    store.setCurrentPage(page(1))
    expect(store.sourceContext?.accessibleIdentities).toHaveLength(8)
    store.updateDraft(id(1), { sources: sources.slice(0, 1) })
    expect(store.sourceContext?.pendingSources).toEqual([])
    store.updateDraft(id(1), { includeCurrentPage: false })
    expect(store.sourceContext?.currentPage.included).toBe(false)
    expect(store.sourceContext?.identity).toEqual({ kind: 'draft', ownerId: 1, draftId: id(1), sessionId: id(1) })
    store.updateDraft(id(1), { sources: [], scope: { kind: 'selected' } })
    expect(store.sourceContext).toBeNull()
    store.updateDraft(id(1), { sources: [source(1), source(1)], scope: { kind: 'all' } })
    expect(store.sourceContext).toBeNull()
    store.updateDraft(id(1), { sources: sources.map(row => ({ ...row, path: '界'.repeat(1000) })) })
    expect(store.sourceContext).toBeNull()
    store.closeWorkspace()
    expect(store.sourceContext).toBeNull()
  })

  it('preserves the historical source revision and page override instead of silently replacing them with navigation or fresh revisions', async () => {
    fixture()
    const store = createStore()
    await initialize(store, page(2))
    const historicalSource = { ...source(9), sourceRevision: '2' }
    const { id: sourceId, locale, path, title, visibility, sourceRevision } = historicalSource
    store.thread = {
      ...store.thread!,
      messages: [
        {
          id: id(101),
          runId: null,
          role: 'user',
          ordinal: 1,
          status: 'complete',
          content: 'Original request',
          citations: [],
          createdAt: '2026-09-18T00:00:00Z',
          updatedAt: '2026-09-18T00:00:00Z',
          currentPage: page(7),
          knowledgeContext: { scope: { kind: 'selected' }, sources: [{ id: sourceId, locale, path, title, visibility, sourceRevision }] }
        }
      ]
    }
    expect(await store.restoreRequest(id(101))).toBe('Original request')
    expect(store.drafts[id(1)]?.sources[0]?.sourceRevision).toBe('2')
    expect(store.sourceContext?.attachedSources[0]).toMatchObject({ source: { sourceRevision: '2' }, access: 'stale' })
    expect(store.sourceContext?.currentPage).toMatchObject({ included: true, origin: 'historical', hint: page(7), access: 'unknown' })
    store.setCurrentPage(page(3))
    expect(store.sourceContext?.currentPage.hint).toEqual(page(7))
    store.updateDraft(id(1), { currentPageOverride: null, includeCurrentPage: false })
    expect(store.sourceContext?.currentPage).toMatchObject({ included: false, origin: 'historical', hint: null })
  })
})

describe('Unresolved Agent command continuity', () => {
  it('retries an accepted message after a lost response and terminal run using its original identity and envelope', async () => {
    const api = fixture()
    const server = idempotentMessageBoundary(api)
    const storageWrites = vi.spyOn(Storage.prototype, 'setItem')
    const store = createStore()
    expect(await initialize(store, page(2))).toBe(true)
    const content = 'Private unresolved command: summarize the selected source.'
    const skills = [id(700)]
    const media = { attachmentIds: [id(701)] }
    store.updateDraft(id(1), { text: content, scope: { kind: 'selected' }, sources: [source(9)], skillVersionIds: skills })
    const onAccepted = vi.fn()
    const sending = store.send(content, skills, 'message', media, onAccepted)
    await server.waitForAcceptance(sending)
    const original = structuredClone(api.submissions[0]!)
    expect(original).toMatchObject({
      sessionId: id(1),
      endpoint: 'messages',
      body: { content, expectedSessionVersion: 1, currentPage: page(2), attachmentIds: [id(701)], invokedSkillVersionIds: [id(700)] }
    })
    expect(typeof original.body.clientRequestId).toBe('string')
    expect(Object.hasOwn(original.body, 'generationTools')).toBe(false)
    expect(server.acceptedCommandCount).toBe(1)
    server.dropFirstResponse()
    expect(await sending).toBe(false)
    expect(onAccepted).not.toHaveBeenCalled()
    expect(store.drafts[id(1)]?.text).toBe(content)

    server.completeFirst()
    store.setCurrentPage(page(3))
    expect((await store.refreshThread()).accepted).toBe(true)
    expect(store.thread?.session.currentRun).toMatchObject({ status: 'succeeded', canCancel: false })
    expect(store.thread?.goal).toBeNull()
    expect(store.thread?.tools).toEqual([])
    expect(store.thread?.tasks).toEqual([])
    expect(store.isWorkspaceReady()).toBe(true)
    expect(store.thread?.session.version).toBe(2)
    expect(store.thread?.session.profileResolutionToken).not.toBe(original.body.profileResolutionToken)
    expect(api.submissions).toHaveLength(1)

    // The composer labels this second explicit send as Retry; a terminal run is not proof of nonacceptance.
    const retried = await store.send(content, skills, 'message', media, onAccepted)
    expect(JSON.stringify(storageWrites.mock.calls)).not.toContain(content)
    expect(api.submissions).toHaveLength(2)
    expect(server.acceptedCommandCount).toBe(1)
    expect(api.submissions[1]).toEqual(original)
    expect(retried).toBe(true)
    expect(store.thread?.messages.filter(message => message.role === 'user')).toHaveLength(1)
    expect(store.drafts[id(1)]?.text).toBe('')
    expect(onAccepted).toHaveBeenCalledTimes(1)
  })

  it.each(['text', 'restored text', 'source', 'skills', 'media', 'owner'] as const)(
    'does not reuse an unresolved command for a genuine %s intent change',
    async change => {
      const api = fixture()
      const server = idempotentMessageBoundary(api)
      const store = createStore()
      expect(await initialize(store, page(2))).toBe(true)
      const content = 'typed words voice words'
      const skills = [id(700)]
      const media = { attachmentIds: [id(701)] }
      store.updateDraft(id(1), { text: content, sources: [source(9)], skillVersionIds: skills })
      const sending = store.send(content, skills, 'message', media)
      await server.waitForAcceptance(sending)
      const original = structuredClone(api.submissions[0]!)
      server.dropFirstResponse()
      expect(await sending).toBe(false)
      server.completeFirst()
      expect((await store.refreshThread()).accepted).toBe(true)
      if (change === 'owner') {
        expect(await initialize(store, page(2), 2)).toBe(true)
        store.updateDraft(store.thread!.session.id, { text: content, sources: [source(9)], skillVersionIds: skills })
      } else if (change === 'text') store.setDraft(id(1), `${content} `)
      else if (change === 'restored text') {
        store.setDraft(id(1), `${content} edited`)
        store.setDraft(id(1), content)
      } else if (change === 'source') store.updateDraft(id(1), { sources: [source(10)] })
      else if (change === 'skills') store.updateDraft(id(1), { skillVersionIds: [id(702)] })
      expect(
        await store.send(
          store.drafts[store.thread!.session.id]!.text,
          change === 'skills' ? [id(702)] : skills,
          'message',
          change === 'media' ? { attachmentIds: [id(703)] } : media
        )
      ).toBe(true)
      expect(api.submissions).toHaveLength(2)
      expect(server.acceptedCommandCount).toBe(2)
      expect(api.submissions[1]!.body.clientRequestId).not.toBe(original.body.clientRequestId)
    }
  )

  it.each(['before Close', 'after Close'] as const)('retires the unchanged raw draft when its trimmed send succeeds %s', async timing => {
    const api = fixture()
    const server = idempotentMessageBoundary(api)
    const store = createStore()
    expect(await initialize(store)).toBe(true)
    const rawDraft = '  Accepted before the workspace closed \n'
    const content = rawDraft.trim()
    store.setDraft(id(1), rawDraft)
    const onAccepted = vi.fn()
    const sending = store.send(content, [], 'message', undefined, onAccepted)
    await server.waitForAcceptance(sending)
    expect(store.drafts[id(1)]?.text).toBe(rawDraft)
    if (timing === 'after Close') store.closeWorkspace()
    server.completeFirst()
    server.deliverFirstResponse()
    expect(await sending).toBe(true)
    if (timing === 'before Close') store.closeWorkspace()
    expect(store.drafts[id(1)]?.text).toBe('')
    expect(store.workspaceDisposed).toBe(true)
    expect(onAccepted).toHaveBeenCalledTimes(timing === 'before Close' ? 1 : 0)
    expect(api.submissions).toHaveLength(1)
    expect(server.acceptedCommandCount).toBe(1)
    expect(await initialize(store, page(3))).toBe(true)
    expect(store.thread?.session.id).toBe(id(1))
    expect(store.drafts[id(1)]?.text).toBe('')
    expect(api.submissions).toHaveLength(1)
  })

  it.each(['text bytes', 'source context'] as const)('preserves a newer %s edit when the old accepted POST settles after close and reopen', async edit => {
    const api = fixture()
    const server = idempotentMessageBoundary(api)
    const store = createStore()
    expect(await initialize(store, page(2))).toBe(true)
    const content = 'Keep this composition'
    store.updateDraft(id(1), { text: content, scope: { kind: 'selected' }, sources: [source(9)], includeCurrentPage: true })
    const sending = store.send(content)
    await server.waitForAcceptance(sending)
    store.closeWorkspace()
    server.completeFirst()
    expect(await initialize(store, page(3))).toBe(true)
    const newerText = edit === 'text bytes' ? `  ${content}  ` : content
    if (edit === 'text bytes') store.setDraft(id(1), newerText)
    else store.updateDraft(id(1), { scope: { kind: 'all' }, sources: [source(10)], includeCurrentPage: false })
    server.deliverFirstResponse()
    expect(await sending).toBe(true)
    expect(store.drafts[id(1)]?.text).toBe(newerText)
    expect(store.drafts[id(1)]?.sources.map(item => item.id)).toEqual([edit === 'source context' ? 10 : 9])
    expect(store.drafts[id(1)]?.includeCurrentPage).toBe(edit === 'text bytes')
    expect(api.submissions).toHaveLength(1)
    expect(server.acceptedCommandCount).toBe(1)
  })

  it('retires only the original matching draft when a different conversation is selected before the late success', async () => {
    const api = fixture()
    const server = idempotentMessageBoundary(api)
    const store = createStore()
    expect(await initialize(store)).toBe(true)
    const content = 'The same text in two independent conversations'
    store.setDraft(id(1), content)
    const sending = store.send(content)
    await server.waitForAcceptance(sending)
    store.closeWorkspace()
    server.completeFirst()
    expect(await initialize(store, page(3), 1, id(40))).toBe(true)
    store.setDraft(id(40), content)
    server.deliverFirstResponse()
    expect(await sending).toBe(true)
    expect(store.drafts[id(1)]?.text).toBe('')
    expect(store.drafts[id(40)]?.text).toBe(content)
    expect(store.thread?.session.id).toBe(id(40))
    expect(store.thread?.messages).toEqual([])
    expect(api.submissions).toHaveLength(1)
    expect(server.acceptedCommandCount).toBe(1)
  })

  it.each(['owner change', 'logout and return'] as const)(
    'does not retire or replay another identity generation after %s during an accepted POST',
    async boundary => {
      const api = fixture()
      const server = idempotentMessageBoundary(api)
      const store = createStore()
      expect(await initialize(store)).toBe(true)
      const content = 'An identical draft is not an identity proof'
      store.setDraft(id(1), content)
      const onAccepted = vi.fn()
      const sending = store.send(content, [], 'message', undefined, onAccepted)
      await server.waitForAcceptance(sending)
      store.closeWorkspace()
      server.completeFirst()
      if (boundary === 'owner change') expect(await initialize(store, page(3), 2)).toBe(true)
      else {
        store.destroyWorkspace()
        expect(await initialize(store, page(3), 1, id(1))).toBe(true)
      }
      const currentSessionId = store.thread!.session.id
      const currentOwnerId = store.workspaceOwnerId
      store.setDraft(currentSessionId, content)
      server.deliverFirstResponse()
      expect(await sending).toBe(true)
      expect(store.workspaceOwnerId).toBe(currentOwnerId)
      expect(store.thread?.session.id).toBe(currentSessionId)
      expect(store.drafts[currentSessionId]?.text).toBe(content)
      if (boundary === 'owner change') {
        expect(store.workspaceOwnerId).toBe(2)
        expect(store.drafts[id(1)]).toBeUndefined()
        expect(store.thread?.messages).toEqual([])
      } else expect(currentSessionId).toBe(id(1))
      expect(onAccepted).not.toHaveBeenCalled()
      expect(api.submissions).toHaveLength(1)
      expect(server.acceptedCommandCount).toBe(1)
    }
  )
})

describe('Explicit Agent preset admission', () => {
  it('captures the clicked preset and original bytes before refresh, admits one POST and preserves a newer draft', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store, page(2))
    const original = '  # Full starter request\n\nPreserve all instructions and trailing space.  '
    store.updateDraft(id(1), { text: original, scope: { kind: 'selected' }, sources: [source(9)], includeCurrentPage: true })
    const pending = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<void>()
    const capturedThread = structuredClone(store.thread!)
    api.deferThreadRead(() => {
      started.resolve()
      return pending.promise
    })
    const options: { presetId: AgentPresetId } = { presetId: 'page-summary' }
    const sending = store.send(original, [], 'message', undefined, undefined, options)
    await Promise.race([
      started.promise,
      sending.then(() => {
        throw new Error('Send settled without its admission refresh')
      })
    ])
    options.presetId = 'catch-up'
    store.setCurrentPage(page(3))
    store.updateDraft(id(1), { text: 'A newer custom composition', sources: [source(10)], includeCurrentPage: false })
    expect(await store.send('Duplicate click', [], 'message', undefined, undefined, { presetId: 'wiki-overview' })).toBe(false)
    expect(await store.openSession(id(40))).toBe(false)
    expect(store.thread?.session.id).toBe(id(1))
    expect(api.fetcher.mock.calls.some(([url]) => url === `/_api/agents/sessions/${id(40)}`)).toBe(false)
    expect(api.submissions).toEqual([])
    api.deferThreadRead(undefined)
    pending.resolve(Response.json(capturedThread))
    expect(await sending).toBe(true)
    expect(api.submissions).toHaveLength(1)
    expect(api.submissions[0]).toMatchObject({
      sessionId: id(1),
      endpoint: 'messages',
      body: {
        presetId: 'page-summary',
        content: original,
        expectedSessionVersion: 1,
        currentPage: page(2),
        knowledgeContext: {
          scope: { kind: 'selected' },
          sources: [{ id: 9, locale: 'en', path: 'page-9', title: 'Page 9', visibility: 'public', sourceRevision: '1' }]
        }
      }
    })
    expect(store.drafts[id(1)]?.text).toBe('A newer custom composition')
    expect(store.drafts[id(1)]?.sources.map(item => item.id)).toEqual([10])
    expect(await store.openSession(id(40))).toBe(true)
    expect(await store.openSession(id(1))).toBe(true)
    expect(store.thread?.messages[0]).toMatchObject({ role: 'user', presetId: 'page-summary', content: original })
  })

  it('keeps custom messages untagged even when they resemble starters, and trims custom messages and goal objectives', async () => {
    const api = fixture()
    const store = createStore()
    await initialize(store)
    const original = '  Summarize the current page.\n\nUse my exact custom instructions.  '
    store.setDraft(id(1), original)
    expect(await store.send(original)).toBe(true)
    expect(api.submissions[0]?.body.content).toBe('Summarize the current page.\n\nUse my exact custom instructions.')
    expect(Object.hasOwn(api.submissions[0]!.body, 'presetId')).toBe(false)
    expect(Object.hasOwn(store.thread!.messages[0]!, 'presetId')).toBe(false)
    expect(
      await store.send('  Complete this custom goal.  ', [], 'goal', { attachmentIds: [], generationTools: ['music'] }, undefined, { presetId: 'catch-up' })
    ).toBe(true)
    expect(api.submissions).toHaveLength(2)
    expect(api.submissions[1]?.endpoint).toBe('goals')
    expect(api.submissions[1]?.body.objective).toBe('Complete this custom goal.')
    expect(api.submissions[1]?.body.generationTools).toEqual(['music'])
    expect(Object.hasOwn(api.submissions[1]!.body, 'presetId')).toBe(false)
  })

  it('does not send captured preset content when its workspace or owner is retired during refresh', async () => {
    for (const retirement of ['close', 'owner']) {
      const api = fixture()
      const store = createStore()
      await initialize(store)
      const capturedThread = structuredClone(store.thread!)
      const pending = Promise.withResolvers<Response>()
      const started = Promise.withResolvers<void>()
      api.deferThreadRead(n => {
        if (n !== 1) return Promise.resolve(Response.json(thread(n)))
        started.resolve()
        return pending.promise
      })
      const sending = store.send('Private preset request', [], 'message', undefined, undefined, { presetId: 'wiki-connections' })
      await Promise.race([
        started.promise,
        sending.then(() => {
          throw new Error('Send settled without its admission refresh')
        })
      ])
      if (retirement === 'close') store.closeWorkspace()
      else expect(await initialize(store, page(3), 2)).toBe(true)
      api.deferThreadRead(undefined)
      pending.resolve(Response.json(capturedThread))
      expect(await sending).toBe(false)
      expect(api.submissions).toEqual([])
      if (retirement === 'owner') {
        expect(store.workspaceOwnerId).toBe(2)
        expect(store.thread?.messages).toEqual([])
      }
      store.closeWorkspace()
      vi.restoreAllMocks()
      clearAgentChatRecent()
      fixtureOwnerId = 1
    }
  })
})
