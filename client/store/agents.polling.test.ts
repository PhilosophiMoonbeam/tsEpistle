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
      if (store.thread) store.thread = {
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
    const fetcher = vi.spyOn(window, 'fetch')
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
    store.sessions = [{
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
    }]
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
