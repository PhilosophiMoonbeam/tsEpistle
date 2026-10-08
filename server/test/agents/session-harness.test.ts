import { AxJSRuntime } from '@ax-llm/ax'
import { describe, expect, it, vi } from '../bun-test.mts'
import { actionDefinition } from '../../agents/actions/catalog.ts'
import type { OfferedAction } from '../../agents/actions/kernel.ts'
import { AxSessionHarness } from '../../agents/providers/session-harness.ts'

const offered = (name: 'pages.get'): OfferedAction => ({
  definition: actionDefinition(name),
  authority: {
    version: 1,
    actionName: name,
    requestId: '00000000-0000-4000-8000-000000000001',
    transport: 'agent',
    requester: { kind: 'user', userId: 7 },
    groupIds: [3],
    permissions: ['use:agents', 'read:pages'],
    featureFlags: { 'agents.enabled': true, 'agents.provider.enabled': true, 'agents.orchestration.enabled': false, 'agents.skills.enabled': true, 'agents.browser.enabled': false, 'agents.proposals.enabled': false, 'agents.writes.enabled': false, 'agents.writes.create.enabled': false, 'agents.writes.patch.enabled': false, 'agents.writes.move.enabled': false, 'agents.writes.restore.enabled': false, 'agents.writes.delete.enabled': false, 'agents.mcp.enabled': false },
    allowedActions: null,
    authoritySha256: '0'.repeat(64)
  }
})

describe('Ax session harness', () => {
  it('rejects invalid snapshots before acquiring a caller-owned runtime session', async () => {
    const createSession = vi.spyOn(AxJSRuntime.prototype, 'createSession')
    const harness = new AxSessionHarness({ execute: async () => ({}) })
    try {
      await expect(harness.open([], { tooLarge: 'x'.repeat(256 * 1_024) })).rejects.toMatchObject({ code: 'INVALID_RUNTIME_SNAPSHOT' })
      expect(createSession).not.toHaveBeenCalled()
    } finally {
      createSession.mockRestore()
    }
  })

  it('closes a caller-owned runtime session when snapshot restoration fails', async () => {
    const failure = new Error('Snapshot restoration failed')
    const close = vi.fn()
    const createSession = vi.spyOn(AxJSRuntime.prototype, 'createSession').mockReturnValueOnce({
      execute: async () => undefined,
      patchGlobals: async () => { throw failure },
      close
    })
    const harness = new AxSessionHarness({ execute: async () => ({}) })
    try {
      await expect(harness.open([], { safeValue: 1 })).rejects.toBe(failure)
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      createSession.mockRestore()
    }
  })

  it('exposes only offered host callbacks through a locked worker session', async () => {
    const execute = vi.fn(async (_action: OfferedAction, input: unknown) => ({ received: input }))
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 5_000 })
    const session = await harness.open([offered('pages.get')])
    try {
      expect(await session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'call-1')).toEqual({ received: { id: 42 } })
      await expect(Promise.resolve(session.invoke('pages.search', { query: 'x' }, new AbortController().signal, 'call-2'))).rejects.toMatchObject({ code: 'ACTION_NOT_OFFERED' })
      expect(session.functions).toEqual([expect.objectContaining({ name: 'pages.get', risk: 'read' })])
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      session.close()
    }
    await expect(Promise.resolve(session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'call-3'))).rejects.toMatchObject({ code: 'ACTION_SESSION_CLOSED' })
  })

  it('returns the authoritative host result after an approval-length pause', async () => {
    const entered = Promise.withResolvers<void>()
    const approved = Object.freeze({ proposalId: 'proposal-1', status: 'approved' })
    const gate = Promise.withResolvers<void>()
    const execute = vi.fn(async () => {
      entered.resolve()
      await gate.promise
      return approved
    })
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 5_000 })
    const session = await harness.open([offered('pages.get')])
    try {
      const invocation = session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'call-paused')
      await entered.promise
      gate.resolve()
      expect(await invocation).toBe(approved)
    } finally {
      session.close()
    }
  })

  it('rejects overlapping invokes without replacing the active host call identity', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const execute = vi.fn(async (_action: OfferedAction, input: unknown, signal: AbortSignal, actionCallId: string) => {
      entered.resolve()
      await release.promise
      return { input, aborted: signal.aborted, actionCallId }
    })
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 5_000 })
    const session = await harness.open([offered('pages.get')])
    const firstSignal = new AbortController().signal
    const first = session.invoke('pages.get', { id: 42 }, firstSignal, 'first')
    try {
      await entered.promise
      await expect(session.invoke('pages.get', { id: 99 }, new AbortController().signal, 'overlap')).rejects.toMatchObject({
        code: 'ACTION_SESSION_BUSY',
        status: 409
      })
      release.resolve()
      expect(await first).toEqual({ input: { id: 42 }, aborted: false, actionCallId: 'first' })
      expect(await session.invoke('pages.get', { id: 99 }, firstSignal, 'next')).toEqual({
        input: { id: 99 }, aborted: false, actionCallId: 'next'
      })
      expect(execute).toHaveBeenCalledTimes(2)
      expect(execute.mock.calls.map(call => call[3])).toEqual(['first', 'next'])
    } finally {
      release.resolve()
      session.close()
      await first.catch(() => {})
    }
  })

  it('preserves structured action errors across the worker boundary', async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error('sensitive detail'), { code: 'INVALID_SNAPSHOT_TOKEN', status: 409 })
    })
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 5_000 })
    const session = await harness.open([offered('pages.get')])
    try {
      const invocation = Promise.resolve(session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'call-1'))
      await expect(invocation).rejects.toMatchObject({
        code: 'INVALID_SNAPSHOT_TOKEN',
        status: 409
      })
      const error = await invocation.catch((cause: unknown) => cause)
      expect(error).toHaveProperty('message', expect.any(String))
      expect((error as Error).message).not.toContain('sensitive detail')
    } finally {
      session.close()
    }
  })

  it('round-trips bounded snapshots without reserved host capabilities', async () => {
    const harness = new AxSessionHarness({ execute: async () => ({}) })
    const first = await harness.open([])
    const snapshot = await first.snapshot(new AbortController().signal)
    first.close()
    expect(snapshot).not.toHaveProperty('__wikiActions')
    const restored = await harness.open([], { ...snapshot, safeValue: { count: 2 } })
    try {
      const restoredSnapshot = await restored.snapshot(new AbortController().signal)
      expect(restoredSnapshot).toMatchObject({ safeValue: { count: 2 } })
      expect(restoredSnapshot).not.toHaveProperty('__wikiActions')
    } finally {
      restored.close()
    }
  })
})
