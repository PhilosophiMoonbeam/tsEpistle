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

    store.scheduleRefresh(false, 1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(store.refreshTimer).not.toBeNull()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(store.refreshTimer).toBeNull()
    expect(store.connection).toBe('closed')
  })
})
