import { AxJSRuntime } from '@ax-llm/ax'
import { describe, expect, it, vi } from '../bun-test.mts'
import { actionDefinition } from '../../agents/actions/catalog.ts'
import type { OfferedAction } from '../../agents/actions/kernel.ts'
import { AxSessionHarness } from '../../agents/providers/session-harness.ts'

const offered = (name: 'pages.get' | 'pages.search'): OfferedAction => ({
  definition: actionDefinition(name),
  authority: {
    version: 1,
    actionName: name,
    requestId: '00000000-0000-4000-8000-000000000001',
    transport: 'agent',
    requester: { kind: 'user', userId: 7 },
    groupIds: [3],
    permissions: ['use:agents', 'read:pages'],
    featureFlags: {
      'agents.enabled': true,
      'agents.provider.enabled': true,
      'agents.orchestration.enabled': false,
      'agents.skills.enabled': true,
      'agents.browser.enabled': false,
      'agents.proposals.enabled': false,
      'agents.writes.enabled': false,
      'agents.writes.create.enabled': false,
      'agents.writes.patch.enabled': false,
      'agents.writes.move.enabled': false,
      'agents.writes.restore.enabled': false,
      'agents.writes.delete.enabled': false,
      'agents.mcp.enabled': false
    },
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
      patchGlobals: async () => {
        throw failure
      },
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
      await expect(Promise.resolve(session.invoke('pages.search', { query: 'x' }, new AbortController().signal, 'call-2'))).rejects.toMatchObject({
        code: 'ACTION_NOT_OFFERED'
      })
      expect(session.functions).toEqual([expect.objectContaining({ name: 'pages.get', risk: 'read' })])
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      session.close()
    }
    await expect(Promise.resolve(session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'call-3'))).rejects.toMatchObject({
      code: 'ACTION_SESSION_CLOSED'
    })
  })

  it.each([
    "'use strict'",
    '"use strict"',
    "await import('node:fs'); __wikiActions = {}; // ordinary source example",
    'const __wikiActions = undefined; /* reserved binding example */',
    `\`template \${__wikiActions}\`; \\ escaped "quotes"\nreturn (value)`
  ])('preserves ordinary JSON strings containing %s through the actual runtime', async text => {
    const input = { query: `A document says ${text} in an example.` }
    const execute = vi.fn(async (_action: OfferedAction, _input: unknown) => ({ read: true }))
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 5_000 })
    const session = await harness.open([offered('pages.search')])
    try {
      expect(await session.invoke('pages.search', input, new AbortController().signal, 'directive-data')).toEqual({ read: true })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute.mock.calls[0]?.[1]).toEqual(input)
    } finally {
      session.close()
    }
  })

  it('preserves own __proto__ JSON keys at every input depth through the actual runtime', async () => {
    const input = JSON.parse('{"id":42,"__proto__":{"root":"data"},"nested":{"__proto__":{"child":"data"}}}') as Record<string, unknown>
    const execute = vi.fn(async (_action: OfferedAction, _input: unknown) => ({ read: true }))
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 5_000 })
    const session = await harness.open([offered('pages.get')])
    try {
      expect(await session.invoke('pages.get', input, new AbortController().signal, 'prototype-data')).toEqual({ read: true })
      const received = execute.mock.calls[0]?.[1] as Record<string, unknown>
      expect(received).toEqual(input)
      expect(Object.hasOwn(received, '__proto__')).toBe(true)
      expect(Object.hasOwn(received.nested as object, '__proto__')).toBe(true)
    } finally {
      session.close()
    }
  })

  it('rejects unencodable or oversized JSON input before host dispatch', async () => {
    const execute = vi.fn(async () => ({ read: true }))
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 5_000 })
    const session = await harness.open([offered('pages.get')])
    try {
      for (const input of [undefined, Symbol('not-json'), () => null, { text: 'é'.repeat(32 * 1_024) }]) {
        await expect(session.invoke('pages.get', input, new AbortController().signal, 'invalid-input')).rejects.toMatchObject({
          code: 'INVALID_ACTION_INPUT'
        })
      }
      expect(execute).not.toHaveBeenCalled()
      expect(await session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'valid-input')).toEqual({ read: true })
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      session.close()
    }
  })

  it('rejects unencodable and oversized host results without losing subsequent action calls', async () => {
    let output: unknown
    const execute = vi.fn(async () => output)
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 5_000 })
    const session = await harness.open([offered('pages.get')])
    try {
      await expect(session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'unencodable-result')).rejects.toMatchObject({
        code: 'ACTION_RESULT_TOO_LARGE'
      })
      output = { text: 'é'.repeat(64 * 1_024) }
      await expect(session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'oversized-result')).rejects.toMatchObject({
        code: 'ACTION_RESULT_TOO_LARGE'
      })
      output = { recovered: true }
      expect(await session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'valid-result')).toEqual({ recovered: true })
      expect(execute).toHaveBeenCalledTimes(3)
    } finally {
      session.close()
    }
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

  it('returns host JSON containing error-shaped keys as data through the actual runtime', async () => {
    const output = Object.freeze({ __wikiActionFailure: { code: 'SOURCE_DATA', status: 409 }, content: 'Ordinary page data' })
    const execute = vi.fn(async () => output)
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 5_000 })
    const session = await harness.open([offered('pages.get')])
    try {
      expect(await session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'error-shaped-data')).toBe(output)
      expect(execute).toHaveBeenCalledTimes(1)
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
        input: { id: 99 },
        aborted: false,
        actionCallId: 'next'
      })
      expect(execute).toHaveBeenCalledTimes(2)
      expect(execute.mock.calls.map(call => call[3])).toEqual(['first', 'next'])
    } finally {
      release.resolve()
      session.close()
      await first.catch(() => {})
    }
  })

  it.each(['abort', 'close'] as const)('keeps an active session closed after %s while its host callback completes', async cancellation => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const execute = vi.fn(async (_action: OfferedAction, input: unknown, signal: AbortSignal, actionCallId: string) => {
      entered.resolve()
      await release.promise
      return { input, aborted: signal.aborted, actionCallId }
    })
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 1_000 })
    const session = await harness.open([offered('pages.get')])
    const controller = new AbortController()
    const invocation = session.invoke('pages.get', { id: 42 }, controller.signal, 'cancelled')
    const settled = invocation.then(value => ({ value }), (error: unknown) => ({ error }))
    try {
      await Promise.race([
        entered.promise,
        settled.then(result => {
          throw new Error('Invocation settled before its host callback entered', { cause: result })
        })
      ])
      if (cancellation === 'abort') controller.abort(new Error('Request cancelled'))
      else session.close()
      expect(await settled).toMatchObject({
        error: {
          message: cancellation === 'abort' ? expect.stringContaining('Request cancelled') : 'Worker terminated'
        }
      })
      await expect(session.invoke('pages.get', { id: 99 }, new AbortController().signal, 'next')).rejects.toMatchObject({
        code: 'ACTION_SESSION_CLOSED'
      })
      await expect(session.snapshot(new AbortController().signal)).rejects.toMatchObject({ code: 'ACTION_SESSION_CLOSED' })
      release.resolve()
      await execute.mock.results[0]?.value
      await expect(session.invoke('pages.get', { id: 99 }, new AbortController().signal, 'after-callback')).rejects.toMatchObject({
        code: 'ACTION_SESSION_CLOSED'
      })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute.mock.calls[0]?.[2]).toBe(controller.signal)
      expect(execute.mock.calls[0]?.[3]).toBe('cancelled')
    } finally {
      release.resolve()
      session.close()
      await Promise.allSettled([settled, ...execute.mock.results.map(result => result.value)])
    }
  })

  it('retires a timed-out worker before its late host result can cross into another invocation', async () => {
    const firstEntered = Promise.withResolvers<void>()
    const firstRelease = Promise.withResolvers<void>()
    const secondEntered = Promise.withResolvers<void>()
    const secondRelease = Promise.withResolvers<void>()
    const firstResult = Object.freeze({ owner: 'first' })
    const secondResult = Object.freeze({ owner: 'second' })
    const execute = vi.fn(async (_action: OfferedAction, _input: unknown, _signal: AbortSignal, actionCallId: string) => {
      if (actionCallId === 'first') {
        firstEntered.resolve()
        await firstRelease.promise
        return firstResult
      }
      secondEntered.resolve()
      await secondRelease.promise
      return secondResult
    })
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 1_000 })
    const session = await harness.open([offered('pages.get')])
    const first = session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'first')
    const firstSettled = first.then(value => ({ value }), (error: unknown) => ({ error }))
    let secondSettled: Promise<unknown> | undefined
    try {
      await Promise.race([
        firstEntered.promise,
        firstSettled.then(result => {
          throw new Error('Invocation settled before its host callback entered', { cause: result })
        })
      ])
      expect(await firstSettled).toMatchObject({ error: { message: 'Execution timed out' } })
      secondSettled = session.invoke('pages.get', { id: 99 }, new AbortController().signal, 'second')
        .then(value => ({ value }), (error: unknown) => ({ error }))
      // The unsafe harness restarts its worker and enters this second callback.
      // Releasing only the first callback then delivers the wrong owned result.
      await Promise.race([secondSettled, secondEntered.promise])
      firstRelease.resolve()
      expect(await secondSettled).toMatchObject({ error: { code: 'ACTION_SESSION_CLOSED' } })
      await execute.mock.results[0]?.value
      await expect(session.invoke('pages.get', { id: 99 }, new AbortController().signal, 'after-callback')).rejects.toMatchObject({
        code: 'ACTION_SESSION_CLOSED'
      })
      await expect(session.snapshot(new AbortController().signal)).rejects.toMatchObject({ code: 'ACTION_SESSION_CLOSED' })
      expect(execute).toHaveBeenCalledTimes(1)
      expect(execute.mock.calls[0]?.[3]).toBe('first')
    } finally {
      firstRelease.resolve()
      secondRelease.resolve()
      session.close()
      await Promise.allSettled([firstSettled, secondSettled, ...execute.mock.results.map(result => result.value)])
    }
  })

  it('preserves structured action errors across the worker boundary', async () => {
    const execute = vi.fn(async () => ({ recovered: true })).mockRejectedValueOnce(
      Object.assign(new Error('sensitive detail'), { code: 'INVALID_SNAPSHOT_TOKEN', status: 409 })
    )
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
      expect(await session.invoke('pages.get', { id: 99 }, new AbortController().signal, 'call-2')).toEqual({ recovered: true })
      expect(execute).toHaveBeenCalledTimes(2)
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
    const restored = await harness.open([offered('pages.get')], { ...snapshot, safeValue: { count: 2 }, __wikiActions: { 'pages.get': 'untrusted' } })
    try {
      const restoredSnapshot = await restored.snapshot(new AbortController().signal)
      expect(restoredSnapshot).toMatchObject({ safeValue: { count: 2 } })
      expect(restoredSnapshot).not.toHaveProperty('__wikiActions')
      expect(await restored.invoke('pages.get', { id: 42 }, new AbortController().signal, 'restored-authority')).toEqual({})
    } finally {
      restored.close()
    }
  })
})
