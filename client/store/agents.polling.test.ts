import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from '../../server/test/bun-test.mts'

import type { AgentThreadState } from '../../shared/agents/contracts.ts'
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

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(complete => {
    resolve = complete
  })
  return { promise, resolve }
}

describe('Agent chat refresh fallback', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('polls an active run without SSE events and stops after terminal state appears', async () => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    const store = useAgentsStore()
    store.thread = activeThread()
    store.connection = 'connected'
    const refresh = vi.fn(async () => {
      if (refresh.mock.calls.length === 2 && store.thread) store.thread = { ...store.thread, session: { ...store.thread.session, currentRun: null } }
    })
    const reloadSessions = vi.fn(async () => undefined)
    store.refreshThread = refresh
    store.reloadSessions = reloadSessions

    store.scheduleRefresh(false, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(reloadSessions).not.toHaveBeenCalled()
    expect(store.refreshTimer).not.toBeNull()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(reloadSessions).toHaveBeenCalledTimes(1)
    expect(store.refreshTimer).toBeNull()
    expect(store.connection).toBe('closed')
  })

  it('transfers the stream when a durable goal admits its next run', async () => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    const store = useAgentsStore()
    const thread = activeThread()
    const firstRunId = thread.session.currentRun!.id
    store.thread = {
      ...thread,
      goal: {
        id: '00000000-0000-4000-8000-000000000010',
        sessionId: thread.session.id,
        objective: 'Finish the investigation.',
        status: 'active',
        version: 1,
        currentRunId: firstRunId,
        continuationCount: 0,
        maxContinuations: 3,
        consumedTokens: 0,
        maxTokens: 48_000,
        consumedToolCalls: 0,
        maxToolCalls: 96,
        startedAt: '2026-08-23T00:00:00.000Z',
        deadlineAt: '2026-08-23T01:00:00.000Z',
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        completion: null
      }
    }
    const nextRun = {
      ...thread.session.currentRun!,
      id: '00000000-0000-4000-8000-000000000011',
      eventSequence: 2
    }
    store.refreshThread = vi.fn(async () => {
      if (store.thread)
        store.thread = {
          ...store.thread,
          session: { ...store.thread.session, currentRun: nextRun },
          goal: store.thread.goal ? { ...store.thread.goal, currentRunId: nextRun.id, continuationCount: 1, version: 2 } : null
        }
    })
    const connect = vi.fn(() => {})
    const reloadSessions = vi.fn(async () => undefined)
    store.connect = connect
    store.reloadSessions = reloadSessions

    store.scheduleRefresh(true, 1, firstRunId)
    await vi.advanceTimersByTimeAsync(1)

    expect(connect).toHaveBeenCalledWith(nextRun.id, nextRun.eventSequence)
    expect(reloadSessions).toHaveBeenCalledTimes(1)
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
        return Promise.resolve(new Response(JSON.stringify({ sessions: [summaryForThread(created), summaryForThread(selected)] }), { status: 200, ...json }))
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

  it('lets deletion commit after workspace close, drops the deleted thread, and does not create a stale replacement', async () => {
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
        return Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, ...json }))
      }
      return Promise.reject(new Error(`Unexpected request: ${method} ${path}`))
    })

    const removing = store.removeSession(deleted.session.id)
    store.closeWorkspace()
    pendingDeletion.resolve(new Response(null, { status: 204 }))
    await removing

    expect(store.thread).toBeNull()
    expect(store.sessions).toEqual([])
    expect(fetcher.mock.calls.some(call => call[0] === '/_api/agents/sessions' && call[1]?.method === 'POST')).toBe(false)
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [] }), { status: 200, ...json }))

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
})
