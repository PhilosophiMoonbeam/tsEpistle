import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentThreadState } from '../../shared/agents/contracts.ts'
import { useAgentsStore } from './agents.ts'

const activeThread = (): AgentThreadState => ({
  session: {
    id: '00000000-0000-4000-8000-000000000001',
    title: '',
    retention: 'saved',
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
    const refresh = vi.spyOn(store, 'refreshThread').mockImplementation(async () => {
      if (refresh.mock.calls.length === 2 && store.thread) store.thread = { ...store.thread, session: { ...store.thread.session, currentRun: null } }
    })
    const reloadSessions = vi.spyOn(store, 'reloadSessions').mockResolvedValue()

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

    await expect(store.resetHistory()).resolves.toBeUndefined()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('/_api/agents/sessions', expect.objectContaining({ method: 'DELETE' }))
    expect(store.thread).toBeNull()
    expect(store.sessions).toEqual([])
    expect(store.error).toBe('')
  })
})
