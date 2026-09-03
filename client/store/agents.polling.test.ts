import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'

import type { AgentConversationFolderView, AgentProviderProfileView, AgentThreadState } from '../../shared/agents/contracts.ts'
import { useAgentsStore } from './agents.ts'

const activeThread = (): AgentThreadState => ({
  session: {
    id: '00000000-0000-4000-8000-000000000001',
    title: '',
    retention: 'saved',
    folderId: null,
    status: 'active',
    executionMode: 'agent',
    version: 1,
    providerProfileId: null,
    profileResolutionToken: 'token',
    skills: [],
    currentRun: {
      id: '00000000-0000-4000-8000-000000000002',
      sessionId: '00000000-0000-4000-8000-000000000001',
      status: 'running',
      attempt: 1,
      eventSequence: 1,
      canCancel: true,
      createdAt: '2026-08-23T00:00:00.000Z',
      startedAt: '2026-08-23T00:00:00.000Z',
      completedAt: null,
      errorCode: null,
      errorMessage: null
    },
    createdAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    lastActivityAt: '2026-08-23T00:00:00.000Z',
    expiresAt: null
  },
  messages: [],
  tools: [],
  tasks: [],
  goal: null,
  proposals: [],
  artifacts: [],
  historyWindow: { messageLimit: 100, hasOlderMessages: false, runLimit: 25, hasOlderRuns: false },
  suggestions: []
})

const threadForSession = (sessionId: string, runId: string): AgentThreadState => {
  const thread = activeThread()
  return {
    ...thread,
    session: {
      ...thread.session,
      id: sessionId,
      currentRun: thread.session.currentRun ? { ...thread.session.currentRun, id: runId, sessionId } : null
    }
  }
}

const summaryForThread = (thread: AgentThreadState) => ({
  id: thread.session.id,
  title: thread.session.title,
  retention: thread.session.retention,
  folderId: thread.session.folderId,
  executionMode: thread.session.executionMode,
  version: thread.session.version,
  providerProfileId: thread.session.providerProfileId,
  createdAt: thread.session.createdAt,
  updatedAt: thread.session.updatedAt,
  lastActivityAt: thread.session.lastActivityAt,
  expiresAt: thread.session.expiresAt,
  deletedAt: null
})

const folderForTest = (id: string, name: string, version = 1): AgentConversationFolderView => ({
  id,
  name,
  version,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z'
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners: Record<string, Array<(event: MessageEvent) => void>> = {}
  readonly close = vi.fn()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = (this.listeners[type] ??= [])
    listeners.push(listener as (event: MessageEvent) => void)
  }

  emit(type: string, lastEventId: string) {
    for (const listener of this.listeners[type] ?? []) listener({ lastEventId } as MessageEvent)
  }
}

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
}

const flushMicrotasks = async () => {
  for (let turn = 0; turn < 16; turn += 1) await Promise.resolve()
}

describe('Agent chat refresh fallback', () => {
  let closeWorkspace: (() => void) | null = null
  const createStore = () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    closeWorkspace = () => store.closeWorkspace()
    return store
  }

  afterEach(() => {
    closeWorkspace?.()
    closeWorkspace = null
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    FakeEventSource.instances = []
    setVisibility('visible')
  })

  it('uses the authoritative cursor and does not GET the full thread every second while SSE is healthy', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    const store = createStore()
    const thread = activeThread()
    store.thread = thread
    const fetcher = vi.spyOn(window, 'fetch').mockResolvedValue(Response.json(thread))

    store.connect(thread.session.currentRun!.id, 999)
    expect(FakeEventSource.instances[0]?.url).toContain('after=1')
    FakeEventSource.instances[0]?.emit('run.started', '2')
    await vi.advanceTimersByTimeAsync(50)
    expect(fetcher).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.connection).toBe('connected')
  })

  it('backs transient watchdog failures off and stops visibly on a nonretryable response', async () => {
    vi.useFakeTimers()
    const store = createStore()
    const thread = activeThread()
    store.thread = thread
    store.connection = 'connected'
    const fetcher = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(Response.json({ message: 'Temporarily unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ message: 'Permission revoked' }, { status: 403 }))

    store.scheduleRefresh(false, 1, thread.session.currentRun!.id)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.connection).toBe('reconnecting')

    await vi.advanceTimersByTimeAsync(999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(store.error).toBe('Permission revoked')
    expect(store.connection).toBe('closed')
    expect(store.refreshTimer).toBeNull()
  })

  it('keeps terminal refresh intent when EventSource reports EOF and polls until an active goal has a successor run', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    const store = createStore()
    const thread = activeThread()
    const observedRun = thread.session.currentRun!
    const completedAt = '2026-08-23T00:01:00.000Z'
    const goal = {
      id: '00000000-0000-4000-8000-000000000003',
      sessionId: thread.session.id,
      objective: 'Finish the durable task.',
      status: 'active' as const,
      version: 1,
      currentRunId: observedRun.id,
      continuationCount: 0,
      maxContinuations: 3,
      consumedTokens: 10,
      maxTokens: 48_000,
      consumedToolCalls: 1,
      maxToolCalls: 96,
      startedAt: thread.session.createdAt,
      deadlineAt: '2026-08-23T01:00:00.000Z',
      completedAt: null,
      errorCode: null,
      errorMessage: null,
      completion: null
    }
    const terminalThread: AgentThreadState = {
      ...thread,
      session: {
        ...thread.session,
        currentRun: { ...observedRun, status: 'succeeded', canCancel: false, completedAt }
      },
      goal
    }
    const successorRunId = '00000000-0000-4000-8000-000000000004'
    const successorThread: AgentThreadState = {
      ...terminalThread,
      session: {
        ...terminalThread.session,
        currentRun: {
          ...observedRun,
          id: successorRunId,
          status: 'running',
          eventSequence: 1,
          canCancel: true,
          completedAt: null
        }
      },
      goal: { ...goal, currentRunId: successorRunId, continuationCount: 1 }
    }
    store.thread = thread
    const fetcher = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(Response.json(terminalThread))
      .mockResolvedValueOnce(Response.json({ sessions: [summaryForThread(terminalThread)], nextCursor: null }))
      .mockResolvedValueOnce(Response.json(successorThread))
      .mockResolvedValueOnce(Response.json({ sessions: [summaryForThread(successorThread)], nextCursor: null }))

    store.connectCurrentRun()
    const source = FakeEventSource.instances[0]!
    source.emit('run.completed', '2')
    source.emit('error', '')

    expect(source.close).toHaveBeenCalledTimes(1)
    expect(store.reconnectAttempt).toBe(0)
    vi.advanceTimersByTime(49)
    await flushMicrotasks()
    expect(fetcher).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await flushMicrotasks()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(store.reconnectAttempt).toBe(1)

    vi.advanceTimersByTime(999)
    await flushMicrotasks()
    expect(fetcher).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    await flushMicrotasks()
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(store.thread?.session.currentRun?.id).toBe(successorRunId)
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('pauses the stream and timers while hidden, then performs one authoritative refresh on return', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    const store = createStore()
    const thread = activeThread()
    store.thread = thread
    const fetcher = vi.spyOn(window, 'fetch').mockResolvedValue(Response.json(thread))

    store.connectCurrentRun()
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).not.toHaveBeenCalled()

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await flushMicrotasks()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it('ignores stale SSE callbacks after the workspace closes', () => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    const store = createStore()
    const thread = activeThread()
    store.thread = thread

    store.connectCurrentRun()
    const source = FakeEventSource.instances[0]!
    store.closeWorkspace()
    source.emit('error', '')
    source.emit('run.started', '2')

    expect(store.connection).toBe('closed')
    expect(store.refreshTimer).toBeNull()
    expect(store.watchdogTimer).toBeNull()
  })
})

describe('Agent store initialization', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stores the supplied CSRF token before creating the fallback session', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    const created = threadForSession('00000000-0000-4000-8000-000000000060', '00000000-0000-4000-8000-000000000061')
    let sessionListRequest = 0
    const json = { headers: { 'content-type': 'application/json' } }
    const fetcher = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/_api/agents/sessions' && method === 'GET') {
        sessionListRequest += 1
        const sessions = sessionListRequest === 1 ? [] : [summaryForThread(created)]
        return Promise.resolve(new Response(JSON.stringify({ sessions, nextCursor: null }), { status: 200, ...json }))
      }
      if (path === '/_api/agents/conversation-folders' && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ folders: [] }), { status: 200, ...json }))
      }
      if (path === '/_api/agents/profiles' && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ profiles: [] }), { status: 200, ...json }))
      }
      if (path === '/_api/agents/skills' && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ skills: [] }), { status: 200, ...json }))
      }
      if (path === '/_api/agents/sessions' && method === 'POST') {
        return Promise.resolve(new Response(JSON.stringify(created), { status: 201, ...json }))
      }
      return Promise.reject(new Error(`Unexpected request: ${method} ${path}`))
    })
    store.connectCurrentRun = vi.fn()

    await store.initialize('initialized-csrf', { routeSync: false })

    const createCall = fetcher.mock.calls.find(call => call[0] === '/_api/agents/sessions' && call[1]?.method === 'POST')
    expect(store.csrfToken).toBe('initialized-csrf')
    expect(new Headers(createCall?.[1]?.headers).get('x-wiki-csrf')).toBe('initialized-csrf')
    store.closeWorkspace()
  })

  it('clears stale profiles when a new workspace fails to initialize or closes', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    const staleProfile: AgentProviderProfileView = {
      id: '00000000-0000-4000-8000-000000000064',
      name: 'Stale provider',
      transport: 'openai-responses',
      model: 'gpt-stale',
      utilityModel: null,
      destinationHost: 'api.example.test',
      capabilities: {
        streaming: true,
        toolCalling: 'native',
        parallelToolCalls: false,
        structuredOutput: 'native-json-schema',
        usage: 'terminal',
        cancellation: true,
        maxContextTokens: 32_000,
        maxOutputTokens: 4_000
      },
      capabilityRevision: 'stale-v1',
      policyVersion: 1,
      isGlobalDefault: true
    }
    store.profiles = [staleProfile]
    vi.spyOn(window, 'fetch').mockRejectedValue(new TypeError('Workspace unavailable'))

    const initializing = store.initialize('csrf-token', { routeSync: false })
    expect(store.profiles).toEqual([])
    await initializing
    expect(store.profiles).toEqual([])

    store.profiles = [staleProfile]
    store.closeWorkspace()
    expect(store.profiles).toEqual([])
  })

  it('rejects folder mutations until the initial authoritative folders have loaded', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    const existing = folderForTest('00000000-0000-4000-8000-000000000062', 'Existing')
    const baseline = deferred<Response>()
    const fetcher = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/_api/agents/sessions' && method === 'GET') return Promise.resolve(Response.json({ sessions: [], nextCursor: null }))
      if (path === '/_api/agents/conversation-folders' && method === 'GET') return baseline.promise
      if (path === '/_api/agents/profiles' && method === 'GET') return Promise.resolve(Response.json({ profiles: [] }))
      if (path === '/_api/agents/skills' && method === 'GET') return Promise.resolve(Response.json({ skills: [] }))
      return Promise.reject(new Error(`Unexpected request: ${method} ${path}`))
    })
    store.newSession = vi.fn(async () => {})

    const initializing = store.initialize('csrf-token', { routeSync: false })
    const creating = store.createFolder('New')
    const creatingRejection = expect(creating).rejects.toThrow('Conversation folders are still loading')
    const renaming = store.renameFolder(existing.id, existing.version, 'Renamed')
    const renamingRejection = expect(renaming).rejects.toThrow('Conversation folders are still loading')
    const deleting = store.deleteFolder(existing.id)
    const deletingRejection = expect(deleting).rejects.toThrow('Conversation folders are still loading')

    await Promise.all([creatingRejection, renamingRejection, deletingRejection])
    expect(fetcher.mock.calls.filter(call => (call[1]?.method ?? 'GET') !== 'GET')).toHaveLength(0)

    baseline.resolve(Response.json({ folders: [existing] }))
    await initializing

    expect(store.folders).toEqual([existing])
    store.closeWorkspace()
  })

  it('retains the opaque next cursor from the authoritative session page', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    vi.spyOn(window, 'fetch').mockResolvedValue(Response.json({ sessions: [], nextCursor: 'next-keyset-page' }))

    await store.reloadSessions()

    expect(store.sessions).toEqual([])
    expect(store.sessionsNextCursor).toBe('next-keyset-page')
  })

  it('appends every opaque cursor page in server order while deduplicating page-boundary overlap', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    const newest = summaryForThread(threadForSession('00000000-0000-4000-8000-000000000070', '00000000-0000-4000-8000-000000000071'))
    const overlap = summaryForThread(threadForSession('00000000-0000-4000-8000-000000000072', '00000000-0000-4000-8000-000000000073'))
    const older = summaryForThread(threadForSession('00000000-0000-4000-8000-000000000074', '00000000-0000-4000-8000-000000000075'))
    const oldest = summaryForThread(threadForSession('00000000-0000-4000-8000-000000000076', '00000000-0000-4000-8000-000000000077'))
    store.sessions = [newest, overlap]
    store.sessionsNextCursor = 'opaque-page-2'
    const secondPage = deferred<Response>()
    const thirdPage = deferred<Response>()
    const fetcher = vi
      .spyOn(window, 'fetch')
      .mockImplementationOnce(() => secondPage.promise)
      .mockImplementationOnce(() => thirdPage.promise)

    const firstLoad = store.loadMoreSessions()
    await expect(store.loadMoreSessions()).resolves.toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    secondPage.resolve(Response.json({ sessions: [overlap, older], nextCursor: 'opaque-page-3' }))
    await expect(firstLoad).resolves.toBe(true)
    expect(store.sessions.map(session => session.id)).toEqual([newest.id, overlap.id, older.id])
    expect(store.sessionsNextCursor).toBe('opaque-page-3')

    const secondLoad = store.loadMoreSessions()
    thirdPage.resolve(Response.json({ sessions: [older, oldest], nextCursor: null }))
    await expect(secondLoad).resolves.toBe(true)
    expect(store.sessions.map(session => session.id)).toEqual([newest.id, overlap.id, older.id, oldest.id])
    expect(store.sessionsNextCursor).toBeNull()
    await expect(store.loadMoreSessions()).resolves.toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed page cursor retryable and advances it only after the retry succeeds', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    const current = summaryForThread(threadForSession('00000000-0000-4000-8000-000000000078', '00000000-0000-4000-8000-000000000079'))
    const older = summaryForThread(threadForSession('00000000-0000-4000-8000-000000000086', '00000000-0000-4000-8000-000000000087'))
    store.sessions = [current]
    store.sessionsNextCursor = 'retryable-cursor'
    vi.spyOn(window, 'fetch')
      .mockRejectedValueOnce(new TypeError('Network unavailable'))
      .mockResolvedValueOnce(Response.json({ sessions: [older], nextCursor: null }))

    await expect(store.loadMoreSessions()).resolves.toBe(false)
    expect(store.sessions).toEqual([current])
    expect(store.sessionsNextCursor).toBe('retryable-cursor')
    expect(store.sessionsLoadMoreError).toBe('Network unavailable')

    await expect(store.loadMoreSessions()).resolves.toBe(true)
    expect(store.sessions).toEqual([current, older])
    expect(store.sessionsNextCursor).toBeNull()
    expect(store.sessionsLoadMoreError).toBe('')
  })

  it('lets an authoritative refresh invalidate a deferred older page without replacing refreshed sessions', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    const current = summaryForThread(threadForSession('00000000-0000-4000-8000-000000000080', '00000000-0000-4000-8000-000000000081'))
    const staleOlder = summaryForThread(threadForSession('00000000-0000-4000-8000-000000000082', '00000000-0000-4000-8000-000000000083'))
    const refreshed = summaryForThread(threadForSession('00000000-0000-4000-8000-000000000084', '00000000-0000-4000-8000-000000000085'))
    store.sessions = [current]
    store.sessionsNextCursor = 'stale-cursor'
    const stalePage = deferred<Response>()
    const authoritativePage = deferred<Response>()
    const signals: AbortSignal[] = []
    vi.spyOn(window, 'fetch')
      .mockImplementationOnce((_input, init) => {
        signals.push(init?.signal as AbortSignal)
        return stalePage.promise
      })
      .mockImplementationOnce((_input, init) => {
        signals.push(init?.signal as AbortSignal)
        return authoritativePage.promise
      })

    const staleLoad = store.loadMoreSessions()
    const refresh = store.reloadSessions()
    expect(signals[0]?.aborted).toBe(true)
    authoritativePage.resolve(Response.json({ sessions: [refreshed], nextCursor: 'fresh-cursor' }))
    await refresh
    stalePage.resolve(Response.json({ sessions: [staleOlder], nextCursor: null }))
    await expect(staleLoad).resolves.toBe(false)

    expect(store.sessions).toEqual([refreshed])
    expect(store.sessionsNextCursor).toBe('fresh-cursor')
    expect(store.sessionsLoadingMore).toBe(false)
    expect(store.sessionsLoadMoreError).toBe('')
  })
})

describe('Agent session mutations', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps a committed rename in history and the active thread when the subsequent refresh fails', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    const base = activeThread()
    const current: AgentThreadState = { ...base, session: { ...base.session, title: 'Original title' } }
    const renamed: AgentThreadState = {
      ...current,
      session: {
        ...current.session,
        title: 'Renamed conversation',
        version: 2,
        updatedAt: '2026-08-23T00:01:00.000Z'
      }
    }
    store.thread = current
    store.sessions = [summaryForThread(current)]
    const refresh = deferred<Response>()
    const fetcher = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === `/_api/agents/sessions/${current.session.id}` && method === 'PATCH') return Promise.resolve(Response.json(renamed))
      if (path === '/_api/agents/sessions' && method === 'GET') return refresh.promise
      return Promise.reject(new Error(`Unexpected request: ${method} ${path}`))
    })

    const renaming = store.renameSession(current.session.id, '  Renamed conversation  ')
    await flushMicrotasks()

    expect(fetcher.mock.calls.map(call => call[1]?.method ?? 'GET')).toEqual(['PATCH', 'GET'])
    expect(store.thread).toEqual(renamed)
    expect(store.sessions).toEqual([summaryForThread(renamed)])

    refresh.reject(new TypeError('History offline'))
    await expect(renaming).resolves.toEqual(renamed)

    expect(store.thread).toEqual(renamed)
    expect(store.sessions).toEqual([summaryForThread(renamed)])
    expect(store.error).toBe('The conversation was renamed, but history could not be refreshed. History offline')
  })
})

describe('Agent folder refresh ordering', () => {
  let closeWorkspace: (() => void) | null = null
  const createStore = () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    closeWorkspace = () => store.closeWorkspace()
    return store
  }

  afterEach(() => {
    closeWorkspace?.()
    closeWorkspace = null
    vi.restoreAllMocks()
  })

  it('applies only the latest folder refresh when responses resolve out of order', async () => {
    const store = createStore()
    const stale = folderForTest('00000000-0000-4000-8000-000000000090', 'Stale')
    const fresh = folderForTest('00000000-0000-4000-8000-000000000091', 'Fresh')
    const first = deferred<Response>()
    const second = deferred<Response>()
    const signals: AbortSignal[] = []
    vi.spyOn(window, 'fetch').mockImplementation((_input, init) => {
      signals.push(init?.signal as AbortSignal)
      return signals.length === 1 ? first.promise : second.promise
    })

    const staleRefresh = store.reloadFolders()
    const freshRefresh = store.reloadFolders()
    expect(signals[0]?.aborted).toBe(true)
    second.resolve(Response.json({ folders: [fresh] }))
    await freshRefresh
    first.resolve(Response.json({ folders: [stale] }))
    await staleRefresh

    expect(store.folders).toEqual([fresh])
  })

  it('ignores a stale folder failure after a newer refresh succeeds', async () => {
    const store = createStore()
    const fresh = folderForTest('00000000-0000-4000-8000-000000000092', 'Fresh')
    const first = deferred<Response>()
    const second = deferred<Response>()
    vi.spyOn(window, 'fetch')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)

    const staleRefresh = store.reloadFolders()
    const freshRefresh = store.reloadFolders()
    second.resolve(Response.json({ folders: [fresh] }))
    await freshRefresh
    first.reject(new TypeError('Stale folder request failed'))

    await expect(staleRefresh).resolves.toBeUndefined()
    expect(store.folders).toEqual([fresh])
  })

  it('fences deferred folder reads before applying create, rename, and delete results', async () => {
    const store = createStore()
    const created = folderForTest('00000000-0000-4000-8000-000000000093', 'Created')
    const renamed = { ...created, name: 'Renamed', version: 2, updatedAt: '2026-08-23T00:01:00.000Z' }
    const staleReads = [deferred<Response>(), deferred<Response>(), deferred<Response>()]
    const pendingCreate = deferred<Response>()
    const signals: AbortSignal[] = []
    let folderReadIndex = 0
    vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/_api/agents/conversation-folders' && method === 'GET') {
        signals.push(init?.signal as AbortSignal)
        return staleReads[folderReadIndex++]!.promise
      }
      if (path === '/_api/agents/conversation-folders' && method === 'POST') return pendingCreate.promise
      if (path === `/_api/agents/conversation-folders/${created.id}` && method === 'PATCH') return Promise.resolve(Response.json({ folder: renamed }))
      if (path === `/_api/agents/conversation-folders/${created.id}` && method === 'DELETE')
        return Promise.resolve(Response.json({ deleted: true, movedSessions: 0 }))
      if (path === '/_api/agents/sessions' && method === 'GET') return Promise.resolve(Response.json({ sessions: [], nextCursor: null }))
      return Promise.reject(new Error(`Unexpected request: ${method} ${path}`))
    })

    const creating = store.createFolder(created.name)
    const duringCreate = store.reloadFolders()
    pendingCreate.resolve(Response.json({ folder: created }, { status: 201 }))
    await creating
    expect(signals[0]?.aborted).toBe(true)
    staleReads[0]!.resolve(Response.json({ folders: [] }))
    await duringCreate
    expect(store.folders).toEqual([created])

    const beforeRename = store.reloadFolders()
    await store.renameFolder(created.id, created.version, renamed.name)
    expect(signals[1]?.aborted).toBe(true)
    staleReads[1]!.resolve(Response.json({ folders: [created] }))
    await beforeRename
    expect(store.folders).toEqual([renamed])

    const beforeDelete = store.reloadFolders()
    await store.deleteFolder(created.id)
    expect(signals[2]?.aborted).toBe(true)
    staleReads[2]!.resolve(Response.json({ folders: [renamed] }))
    await beforeDelete
    expect(store.folders).toEqual([])
  })

  it('aborts and fences a pending folder refresh when the workspace closes', async () => {
    const store = createStore()
    const current = folderForTest('00000000-0000-4000-8000-000000000094', 'Current')
    const late = folderForTest('00000000-0000-4000-8000-000000000095', 'Late')
    const pending = deferred<Response>()
    let signal: AbortSignal | undefined
    store.folders = [current]
    vi.spyOn(window, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal
      return pending.promise
    })

    const refresh = store.reloadFolders()
    store.closeWorkspace()
    expect(signal?.aborted).toBe(true)
    pending.resolve(Response.json({ folders: [late] }))
    await refresh

    expect(store.folders).toEqual([current])
  })
})

describe('Agent session selection', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('applies only the latest session when deferred responses resolve out of order', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    store.routeSync = false
    store.thread = activeThread()
    store.connection = 'connected'
    const previousSource = { close: vi.fn() } as unknown as EventSource
    store.source = previousSource
    const first = deferred<Response>()
    const second = deferred<Response>()
    const signals: AbortSignal[] = []
    vi.spyOn(window, 'fetch').mockImplementation((_input, init) => {
      signals.push(init?.signal as AbortSignal)
      return signals.length === 1 ? first.promise : second.promise
    })
    const connectCurrentRun = vi.fn()
    store.connectCurrentRun = connectCurrentRun
    const firstThread = threadForSession('00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000020')
    const secondThread = threadForSession('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000021')

    const firstOpen = store.openSession(firstThread.session.id)
    const secondOpen = store.openSession(secondThread.session.id)
    expect(signals[0]?.aborted).toBe(true)
    expect(previousSource.close).not.toHaveBeenCalled()

    second.resolve(
      new Response(JSON.stringify(secondThread), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    expect(await secondOpen).toBe(true)
    expect(store.thread?.session.id).toBe(secondThread.session.id)
    expect(previousSource.close).toHaveBeenCalledTimes(1)
    expect(connectCurrentRun).toHaveBeenCalledTimes(1)

    first.resolve(
      new Response(JSON.stringify(firstThread), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    expect(await firstOpen).toBe(false)
    expect(store.thread?.session.id).toBe(secondThread.session.id)
    expect(connectCurrentRun).toHaveBeenCalledTimes(1)
  })

  it('preserves the displayed active run and its stream when a switch fails', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    store.routeSync = false
    const previousThread = activeThread()
    const previousSource = { close: vi.fn() } as unknown as EventSource
    store.thread = previousThread
    store.source = previousSource
    const displayedThread = store.thread
    const activeSource = store.source
    store.connection = 'connected'
    vi.spyOn(window, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'Unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      })
    )

    await expect(store.openSession('00000000-0000-4000-8000-000000000099')).rejects.toThrow('Unavailable')

    expect(store.thread).toBe(displayedThread)
    expect(store.source).toBe(activeSource)
    expect(store.connection).toBe('connected')
    expect(previousSource.close).not.toHaveBeenCalled()
  })

  it('aborts pending selection on workspace close and rejects its stale response', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    store.routeSync = false
    const previousThread = activeThread()
    const previousSource = { close: vi.fn() } as unknown as EventSource
    store.thread = previousThread
    store.source = previousSource
    const displayedThread = store.thread
    store.connection = 'connected'
    const pending = deferred<Response>()
    const signals: AbortSignal[] = []
    vi.spyOn(window, 'fetch').mockImplementation((_input, init) => {
      signals.push(init?.signal as AbortSignal)
      return pending.promise
    })
    const connectCurrentRun = vi.fn()
    store.connectCurrentRun = connectCurrentRun
    const candidate = threadForSession('00000000-0000-4000-8000-000000000030', '00000000-0000-4000-8000-000000000031')

    const opening = store.openSession(candidate.session.id)
    store.closeWorkspace()
    expect(signals[0]?.aborted).toBe(true)
    expect(previousSource.close).toHaveBeenCalledTimes(1)

    pending.resolve(
      new Response(JSON.stringify(candidate), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    expect(await opening).toBe(false)
    expect(store.thread).toBe(displayedThread)
    expect(store.source).toBeNull()
    expect(connectCurrentRun).not.toHaveBeenCalled()
  })

  it('keeps the latest same-session refresh when responses resolve out of order', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    const initial = activeThread()
    const older = { ...initial, session: { ...initial.session, version: 2, title: 'Older refresh' } }
    const latest = { ...initial, session: { ...initial.session, version: 3, title: 'Latest refresh' } }
    store.thread = initial
    const first = deferred<Response>()
    const second = deferred<Response>()
    const signals: AbortSignal[] = []
    vi.spyOn(window, 'fetch').mockImplementation((_input, init) => {
      signals.push(init?.signal as AbortSignal)
      return signals.length === 1 ? first.promise : second.promise
    })

    const olderRefresh = store.refreshThread()
    const latestRefresh = store.refreshThread()
    expect(signals[0]?.aborted).toBe(true)
    second.resolve(Response.json(latest))
    expect(await latestRefresh).toBe(true)
    first.resolve(Response.json(older))
    expect(await olderRefresh).toBe(false)

    expect(store.thread?.session.title).toBe('Latest refresh')
    expect(store.thread?.session.version).toBe(3)
  })

  it('does not let a deferred refresh commit after workspace disposal', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    const displayed = activeThread()
    const pending = deferred<Response>()
    let signal: AbortSignal | undefined
    store.thread = displayed
    vi.spyOn(window, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal
      return pending.promise
    })

    const refreshing = store.refreshThread()
    store.closeWorkspace()
    expect(signal?.aborted).toBe(true)
    pending.resolve(Response.json({ ...displayed, session: { ...displayed.session, title: 'Late response', version: 2 } }))

    expect(await refreshing).toBe(false)
    expect(store.thread?.session.id).toBe(displayed.session.id)
    expect(store.thread?.session.title).toBe(displayed.session.title)
    expect(store.thread?.session.title).not.toBe('Late response')
    expect(store.thread?.session.version).toBe(displayed.session.version)
    expect(store.thread?.session.currentRun?.id).toBe(displayed.session.currentRun?.id)
    expect(store.thread?.session.currentRun?.eventSequence).toBe(displayed.session.currentRun?.eventSequence)
    expect(store.source).toBeNull()
    expect(store.connection).toBe('closed')
  })
})

describe('Agent session mutation transitions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('lets a session creation commit after a newer selection and reconciles it without replacing the selection', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    store.routeSync = false
    store.thread = activeThread()
    const created = threadForSession('00000000-0000-4000-8000-000000000040', '00000000-0000-4000-8000-000000000041')
    const selected = threadForSession('00000000-0000-4000-8000-000000000050', '00000000-0000-4000-8000-000000000051')
    const pendingCreation = deferred<Response>()
    const json = { headers: { 'content-type': 'application/json' } }
    const fetcher = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === '/_api/agents/sessions' && method === 'POST') return pendingCreation.promise
      if (path === `/_api/agents/sessions/${selected.session.id}` && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify(selected), { status: 200, ...json }))
      }
      if (path === '/_api/agents/sessions' && method === 'GET') {
        return Promise.resolve(
          new Response(JSON.stringify({ sessions: [summaryForThread(created), summaryForThread(selected)], nextCursor: null }), { status: 200, ...json })
        )
      }
      return Promise.reject(new Error(`Unexpected request: ${method} ${path}`))
    })
    store.connectCurrentRun = vi.fn()

    const creating = store.newSession('saved')
    const createCall = fetcher.mock.calls.find(call => call[0] === '/_api/agents/sessions' && call[1]?.method === 'POST')
    expect(createCall?.[1]?.signal).toBeUndefined()

    expect(await store.openSession(selected.session.id)).toBe(true)
    pendingCreation.resolve(new Response(JSON.stringify(created), { status: 201, ...json }))
    await creating

    expect(store.thread?.session.id).toBe(selected.session.id)
    expect(store.sessions.map(session => session.id)).toEqual([created.session.id, selected.session.id])
  })

  it('allows a deletion to commit after workspace close without mutating the disposed client', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    store.routeSync = false
    const deleted = activeThread()
    store.thread = deleted
    store.sessions = [summaryForThread(deleted)]
    const pendingDeletion = deferred<Response>()
    const json = { headers: { 'content-type': 'application/json' } }
    const fetcher = vi.spyOn(window, 'fetch').mockImplementation((input, init) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      if (path === `/_api/agents/sessions/${deleted.session.id}` && method === 'DELETE') return pendingDeletion.promise
      if (path === '/_api/agents/sessions' && method === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ sessions: [], nextCursor: null }), { status: 200, ...json }))
      }
      return Promise.reject(new Error(`Unexpected request: ${method} ${path}`))
    })

    const removing = store.removeSession(deleted.session.id)
    store.closeWorkspace()
    pendingDeletion.resolve(new Response(null, { status: 204 }))
    await removing

    expect(store.thread?.session.id).toBe(deleted.session.id)
    expect(store.thread?.session.title).toBe(deleted.session.title)
    expect(store.thread?.session.version).toBe(deleted.session.version)
    expect(store.thread?.session.currentRun?.id).toBe(deleted.session.currentRun?.id)
    expect(store.thread?.session.currentRun?.eventSequence).toBe(deleted.session.currentRun?.eventSequence)
    expect(store.sessions).toEqual([summaryForThread(deleted)])
    expect(fetcher.mock.calls.some(call => call[0] === '/_api/agents/sessions' && call[1]?.method === 'POST')).toBe(false)
  })

  it('does not apply or refresh a mutation response after switching sessions', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    const active = activeThread()
    const submittedRun = active.session.currentRun!
    const origin = { ...active, session: { ...active.session, currentRun: null } }
    const selected = threadForSession('00000000-0000-4000-8000-000000000070', '00000000-0000-4000-8000-000000000071')
    const pending = deferred<Response>()
    store.thread = origin
    const fetcher = vi.spyOn(window, 'fetch').mockImplementation(() => pending.promise)

    const sending = store.send('Keep this in the original conversation')
    store.thread = selected
    pending.resolve(Response.json({ run: submittedRun, replayed: false }))

    expect(await sending).toBe(true)
    expect(store.thread?.session.id).toBe(selected.session.id)
    expect(store.thread?.session.title).toBe(selected.session.title)
    expect(store.thread?.session.version).toBe(selected.session.version)
    expect(store.thread?.session.currentRun?.id).toBe(selected.session.currentRun?.id)
    expect(store.thread?.session.currentRun?.eventSequence).toBe(selected.session.currentRun?.eventSequence)
    expect(store.error).toBe('')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('returns a committed send separately from its authoritative refresh failure', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    const active = activeThread()
    const submittedRun = active.session.currentRun!
    store.thread = { ...active, session: { ...active.session, currentRun: null } }
    const fetcher = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(Response.json({ run: submittedRun, replayed: false }))
      .mockResolvedValueOnce(Response.json({ message: 'Refresh unavailable' }, { status: 503 }))

    expect(await store.send('Committed once')).toBe(true)
    expect(store.error).toBe('The message was sent, but the conversation could not be refreshed. Refresh unavailable')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('coalesces repeated stop requests until the committed cancellation is refreshed', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    const active = activeThread()
    const run = active.session.currentRun!
    const terminal = { ...active, session: { ...active.session, version: 2, currentRun: null } }
    const cancellation = deferred<Response>()
    store.thread = active
    const fetcher = vi
      .spyOn(window, 'fetch')
      .mockImplementationOnce(() => cancellation.promise)
      .mockResolvedValueOnce(Response.json(terminal))

    const firstStop = store.stop()
    const repeatedStop = store.stop()
    expect(fetcher).toHaveBeenCalledTimes(1)
    cancellation.resolve(Response.json({ run: { id: run.id, status: 'cancelled' } }))
    await Promise.all([firstStop, repeatedStop])

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(store.thread?.session.currentRun).toBeNull()
    expect(store.stoppingRunId).toBeNull()
  })
})

describe('Agent empty conversation lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('deletes an unused draft before creating its replacement', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    const running = activeThread()
    const empty = { ...running, session: { ...running.session, currentRun: null } }
    store.thread = empty
    const replacement = {
      ...empty,
      session: {
        ...empty.session,
        id: '00000000-0000-4000-8000-000000000099',
        profileResolutionToken: 'replacement-token'
      },
      launchPage: null
    }
    const json = { headers: { 'content-type': 'application/json' } }
    const fetcher = vi
      .spyOn(window, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(replacement), { status: 201, ...json }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [], nextCursor: null }), { status: 200, ...json }))

    expect(await store.newSession('saved')).toBeUndefined()

    expect(fetcher.mock.calls.map(call => [call[0], (call[1] as RequestInit | undefined)?.method ?? 'GET'])).toEqual([
      ['/_api/agents/sessions/00000000-0000-4000-8000-000000000001', 'DELETE'],
      ['/_api/agents/sessions', 'POST'],
      ['/_api/agents/sessions', 'GET']
    ])
    expect(store.thread?.session.id).toBe('00000000-0000-4000-8000-000000000099')
    expect(store.sessions).toEqual([])
  })
})

describe('Agent history reset', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    FakeEventSource.instances = []
  })

  it('completes without creating a replacement session when no provider profile is available', async () => {
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    store.thread = activeThread()
    store.sessions = [
      {
        id: '00000000-0000-4000-8000-000000000001',
        title: 'Reset verification',
        retention: 'saved',
        folderId: null,
        executionMode: 'agent',
        version: 1,
        providerProfileId: null,
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
        lastActivityAt: '2026-08-23T00:00:00.000Z',
        expiresAt: null,
        deletedAt: null
      }
    ]
    store.error = 'No default provider profile is configured for your groups.'
    const fetcher = vi.spyOn(window, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    expect(await store.resetHistory()).toBeUndefined()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('/_api/agents/sessions', expect.objectContaining({ method: 'DELETE' }))
    expect(store.thread).toBeNull()
    expect(store.sessions).toEqual([])
    expect(store.error).toBe('')
  })

  it('reconnects the preserved authoritative run when reset fails', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.csrfToken = 'csrf-token'
    const thread = activeThread()
    store.thread = thread
    vi.spyOn(window, 'fetch').mockResolvedValue(Response.json({ message: 'Reset unavailable' }, { status: 503 }))

    await expect(store.resetHistory()).rejects.toThrow('Reset unavailable')

    expect(store.thread?.session.id).toBe(thread.session.id)
    expect(store.thread?.session.title).toBe(thread.session.title)
    expect(store.thread?.session.version).toBe(thread.session.version)
    expect(store.thread?.session.currentRun?.id).toBe(thread.session.currentRun?.id)
    expect(store.thread?.session.currentRun?.eventSequence).toBe(thread.session.currentRun?.eventSequence)
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(FakeEventSource.instances[0]?.url).toContain(`runs/${thread.session.currentRun!.id}/events?after=1`)
    store.closeWorkspace()
  })
})
