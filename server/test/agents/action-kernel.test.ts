import { describe, expect, it, vi } from 'vitest'

import { AGENT_ACTION_NAMES, AGENT_FEATURE_FLAG_KEYS, type AgentFeatureFlags } from '../../../shared/agents/contracts.ts'
import { ACTION_CATALOG, actionDefinition } from '../../agents/actions/catalog.ts'
import {
  ActionKernel,
  ActionKernelError,
  createActionAuthority,
  toAxAction,
  toMcpAction,
  verifyActionAuthority,
  type ActionAdmissionSnapshot
} from '../../agents/actions/kernel.ts'

const requestId = '00000000-0000-4000-8000-000000000001'
const auth = { kind: 'user', userId: 7, ownershipUserId: 7, principal: { id: 7 } } as const
const flags = Object.fromEntries(AGENT_FEATURE_FLAG_KEYS.map(flag => [flag, true])) as AgentFeatureFlags

const admission = (overrides: Partial<ActionAdmissionSnapshot> = {}): ActionAdmissionSnapshot => ({
  transport: 'agent',
  executionMode: 'agent',
  supportsTools: true,
  permissions: ['use:agents', 'read:pages', 'write:pages', 'delete:pages', 'use:agent-browser'],
  groupIds: [9, 3],
  featureFlags: flags,
  ...overrides
})

const page = {
  id: 42,
  locale: 'en',
  path: 'docs/start',
  title: 'Start',
  description: '',
  contentType: 'markdown',
  sourceRevision: '8',
  content: '# Start',
  updatedAt: '2026-08-17T00:00:00.000Z',
  citation: {
    evidenceId: 'page:42',
    label: 'Start',
    href: '/en/docs/start'
  },
  citationSections: []
}
const completeKernel = (): ActionKernel => {
  const kernel = new ActionKernel()
  for (const name of AGENT_ACTION_NAMES) kernel.register(name, async () => ({}))
  return kernel
}


describe('shared action catalog admission', () => {
  it('contains every frozen action exactly once', () => {
    expect(Object.keys(ACTION_CATALOG)).toEqual(AGENT_ACTION_NAMES)
    expect(new Set(Object.values(ACTION_CATALOG).map(action => action.descriptor.name)).size).toBe(AGENT_ACTION_NAMES.length)
  })

  it('offers only actions allowed by transport, profile, permissions, flags, and skill narrowing', () => {
    const kernel = completeKernel()
    const offered = kernel.offer(auth, admission({ allowedActions: ['pages.get', 'browser.navigate'] }), requestId)
    expect(offered.map(action => action.definition.descriptor.name)).toEqual(['pages.get', 'browser.navigate'])

    expect(kernel.offer(auth, admission({ executionMode: 'generation-only' }), requestId)).toEqual([])
    expect(kernel.offer(auth, admission({ permissions: ['use:agents'] }), requestId).map(action => action.definition.descriptor.name)).toEqual(['skills.list', 'skills.read', 'memory.manage'])
    expect(kernel.offer(auth, admission({ featureFlags: { ...flags, 'agents.provider.enabled': false } }), requestId)).toEqual([])

    const administratorActions = kernel.offer(auth, admission({ permissions: ['manage:system'] }), requestId).map(action => action.definition.descriptor.name)
    expect(administratorActions).toContain('pages.get')
    expect(administratorActions).not.toContain('browser.navigate')

    const mcpAdministratorActions = kernel.offer(auth, admission({ transport: 'mcp', permissions: ['manage:system'] }), requestId)
    expect(mcpAdministratorActions).toEqual([])
  })

  it('never advertises catalog actions without registered handlers', () => {
    const kernel = new ActionKernel()
    kernel.register('pages.get', async () => page)
    expect(kernel.offer(auth, admission(), requestId).map(action => action.definition.descriptor.name)).toEqual(['pages.get'])
  })

  it('applies MCP exposure and API-key base permission independently of agent permission', () => {
    const kernel = completeKernel()
    const apiKeyAuth = { kind: 'apiKey', apiKeyId: 4, groupId: 6, ownershipUserId: null, principal: { id: 4 } } as const
    const offered = kernel.offer(apiKeyAuth, admission({
      transport: 'mcp',
      permissions: ['use:mcp', 'read:pages'],
      groupIds: [6]
    }), requestId)
    const names = offered.map(action => action.definition.descriptor.name)
    expect(names).toContain('pages.search')
    expect(names).toContain('skills.read')
    expect(names).not.toContain('browser.navigate')
    expect(names).not.toContain('pages.preparePatch')
  })
})

describe('action authority and execution', () => {
  it('canonicalizes authority inputs and rejects any tampering', () => {
    const authority = createActionAuthority('pages.get', requestId, auth, admission())
    expect(authority.groupIds).toEqual([3, 9])
    expect(authority.permissions).toEqual([...admission().permissions].sort())
    expect(verifyActionAuthority(authority)).toEqual(authority)
    expect(() => verifyActionAuthority({ ...authority, permissions: [...authority.permissions, 'manage:system'] })).toThrow('hash does not match')
  })

  it('validates input, reauthorizes live policy, and validates output', async () => {
    const kernel = new ActionKernel()
    const handler = vi.fn(async () => page)
    kernel.register('pages.get', handler)
    const authority = createActionAuthority('pages.get', requestId, auth, admission())
    const controller = new AbortController()
    const refreshAdmission = vi.fn(async () => admission())

    await expect(kernel.execute({ authority, actionCallId: 'call-1', input: { id: 42 }, signal: controller.signal, refreshAdmission })).resolves.toEqual(page)
    expect(refreshAdmission).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledOnce()

    await expect(kernel.execute({ authority, actionCallId: 'call-2', input: { id: 42, unexpected: true }, signal: controller.signal, refreshAdmission })).rejects.toMatchObject({ code: 'INVALID_ACTION_INPUT' })
  })

  it('reauthorizes and persists the run side-effect fence before handler dispatch', async () => {
    const order: string[] = []
    const kernel = new ActionKernel()
    kernel.register('browser.navigate', async (_input, context) => {
      await context.fenceSideEffect()
      order.push('dispatch')
      return { contextId: 'context-value-0001', documentEpoch: requestId, url: 'https://example.com/', title: 'Example', text: 'page', refs: [], observedAt: '2026-08-17T00:00:00.000Z' }
    })
    const authority = createActionAuthority('browser.navigate', requestId, auth, admission())
    const refreshAdmission = vi.fn(async () => admission())
    await expect(kernel.execute({
      authority,
      actionCallId: 'browser-call',
      input: { url: 'https://example.com/' },
      signal: new AbortController().signal,
      refreshAdmission,
      fenceSideEffect: async () => { order.push('fence') }
    })).resolves.toMatchObject({ url: 'https://example.com/' })
    expect(order).toEqual(['fence', 'dispatch'])
    expect(refreshAdmission).toHaveBeenCalledTimes(2)
  })

  it('checks live permission and kill switches before handler dispatch', async () => {
    const kernel = new ActionKernel()
    const handler = vi.fn(async () => page)
    kernel.register('pages.get', handler)
    const authority = createActionAuthority('pages.get', requestId, auth, admission())
    await expect(kernel.execute({
      authority,
      actionCallId: 'call-1',
      input: { id: 42 },
      signal: new AbortController().signal,
      refreshAdmission: async () => admission({ permissions: ['use:agents'] })
    })).rejects.toMatchObject({ code: 'ACTION_FORBIDDEN', status: 403 })
    expect(handler).not.toHaveBeenCalled()
  })

  it('fails closed for cancellation, duplicate handlers, and invalid handler output', async () => {
    const kernel = new ActionKernel()
    kernel.register('pages.get', async () => ({ content: 'missing fields' }))
    expect(() => kernel.register('pages.get', async () => page)).toThrow('already registered')
    const authority = createActionAuthority('pages.get', requestId, auth, admission())
    await expect(kernel.execute({
      authority,
      actionCallId: 'call-1',
      input: { id: 42 },
      signal: new AbortController().signal,
      refreshAdmission: async () => admission()
    })).rejects.toMatchObject({ code: 'INVALID_ACTION_OUTPUT' })

    const aborted = new AbortController()
    aborted.abort()
    await expect(kernel.execute({ authority, actionCallId: 'call-2', input: { id: 42 }, signal: aborted.signal, refreshAdmission: async () => admission() })).rejects.toMatchObject({ code: 'ACTION_CANCELLED' })
  })

  it('rejects oversized attacker-controlled action output', async () => {
    const kernel = new ActionKernel()
    kernel.register('pages.get', async () => ({ ...page, title: 'x'.repeat(256) }))
    const authority = createActionAuthority('pages.get', requestId, auth, admission())
    await expect(kernel.execute({
      authority,
      actionCallId: 'call-1',
      input: { id: 42 },
      signal: new AbortController().signal,
      refreshAdmission: async () => admission()
    })).rejects.toMatchObject({ code: 'INVALID_ACTION_OUTPUT' })
  })

  it('rejects guest authority creation', () => {
    expect(() => createActionAuthority('pages.search', requestId, { kind: 'guest', ownershipUserId: null, principal: {} }, admission())).toThrow(ActionKernelError)
  })
})

describe('Ax and MCP action projections', () => {
  it('projects one catalog definition without changing its admission semantics', () => {
    const definition = actionDefinition('pages.get')
    const ax = toAxAction(definition)
    const mcp = toMcpAction(definition)
    expect(ax).toMatchObject({ name: 'pages.get', inputSchema: definition.input })
    expect(mcp).toMatchObject({
      name: 'wiki_get_page',
      title: definition.descriptor.title,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    })
    expect(mcp.inputSchema).toMatchObject({ anyOf: expect.any(Array) })
  })

  it('does not manufacture an MCP alias for browser-only actions', () => {
    expect(() => toMcpAction(actionDefinition('browser.navigate'))).toThrow('no MCP alias')
  })
})
