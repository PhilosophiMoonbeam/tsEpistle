import { describe, expect, it, vi } from 'vitest'
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
    featureFlags: { 'agents.enabled': true, 'agents.provider.enabled': true, 'agents.skills.enabled': true, 'agents.browser.enabled': false, 'agents.proposals.enabled': false, 'agents.writes.enabled': false, 'agents.writes.create.enabled': false, 'agents.writes.patch.enabled': false, 'agents.writes.move.enabled': false, 'agents.writes.restore.enabled': false, 'agents.writes.delete.enabled': false, 'agents.mcp.enabled': false },
    allowedActions: null,
    authoritySha256: '0'.repeat(64)
  }
})

describe('Ax session harness', () => {
  it('exposes only offered host callbacks through a locked worker session', async () => {
    const execute = vi.fn(async (_action: OfferedAction, input: unknown) => ({ received: input }))
    const harness = new AxSessionHarness({ execute, timeoutMilliseconds: 5_000 })
    const session = await harness.open([offered('pages.get')])
    try {
      await expect(session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'call-1')).resolves.toEqual({ received: { id: 42 } })
      await expect(session.invoke('pages.search', { query: 'x' }, new AbortController().signal, 'call-2')).rejects.toMatchObject({ code: 'ACTION_NOT_OFFERED' })
      expect(session.functions).toEqual([expect.objectContaining({ name: 'pages.get', risk: 'read' })])
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      session.close()
    }
    await expect(session.invoke('pages.get', { id: 42 }, new AbortController().signal, 'call-3')).rejects.toMatchObject({ code: 'ACTION_SESSION_CLOSED' })
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
