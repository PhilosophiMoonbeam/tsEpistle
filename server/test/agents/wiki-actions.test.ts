import type { Knex } from 'knex'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEngineRequest } from '../../agents/runtime.ts'

const request = (signal: AbortSignal): AgentEngineRequest => ({
  run: {
    id: '00000000-0000-4000-8000-000000000001', sessionId: '00000000-0000-4000-8000-000000000002', userMessageId: '00000000-0000-4000-8000-000000000003', assistantMessageId: '00000000-0000-4000-8000-000000000004', ownerId: 7, clientRequestId: '00000000-0000-4000-8000-000000000005', clientRequestSha256: 'a'.repeat(64), status: 'running', providerProfileVersionId: '00000000-0000-4000-8000-000000000006', transportKind: 'openai-responses', model: 'gpt-test', executionMode: 'agent', capabilityRevision: 'cap-1', pricingRevision: 'price-1', promptVersion: 1, attempts: 1, maxAttempts: 3, eventSequence: 0, leaseOwner: 'worker', leaseToken: '00000000-0000-4000-8000-000000000007', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequestedAt: null, sideEffectsStarted: false, errorCode: null, errorMessage: null, queuedAt: '2026-08-17T00:00:00.000Z', startedAt: '2026-08-17T00:00:00.000Z', completedAt: null
  },
  messages: [{ role: 'user', content: 'Find Amber Falcon in the Wiki' }],
  memory: { user: [], agent: [] },
  skills: [],
  signal
})

const config = {
  enabled: true,
  providerEnabled: true,
  skillsEnabled: true,
  browserEnabled: false,
  proposalsEnabled: true,
  writesEnabled: true,
  writeCreateEnabled: true,
  writePatchEnabled: true,
  writeMoveEnabled: true,
  writeRestoreEnabled: true,
  writeDeleteEnabled: true,
  snapshotSigningSecret: Buffer.alloc(32, 7)
} as const

const originalWiki = Reflect.get(globalThis, 'WIKI')
afterEach(() => {
  if (originalWiki === undefined) Reflect.deleteProperty(globalThis, 'WIKI')
  else Reflect.set(globalThis, 'WIKI', originalWiki)
})

describe('Wiki action sessions', () => {
  it.each(['native', 'prompt'] as const)('offers page tools for current %s tool-calling capabilities', async toolCalling => {
    const user = { id: 7, isActive: true, groups: [], getGlobalPermissions: async () => ['use:agents', 'read:pages'] }
    const modifyGraph = vi.fn(async () => user)
    Reflect.set(globalThis, 'WIKI', {
      models: {
        users: {
          query: () => ({ findById: () => ({ withGraphFetched: () => ({ modifyGraph }) }) })
        }
      }
    })
    const { createWikiActionSessionProvider } = await import('../../agents/providers/wiki-actions.ts')
    const capabilities = {
      streaming: true,
      toolCalling,
      parallelToolCalls: toolCalling === 'native',
      structuredOutput: 'native-json-schema',
      usage: 'stream',
      cancellation: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192
    }
    const knex = ((table: string) => {
      if (table === 'agentProviderProfileVersions') return { where: () => ({ first: async () => ({ capabilities: JSON.stringify(capabilities) }) }) }
      if (table === 'agentRunSkills') return { join: () => ({ where: () => ({ select: async () => [] }) }) }
      if (table === 'agentRuns') return { where: () => ({ first: async () => ({ runtimeStateCiphertext: null }) }) }
      throw new Error(`Unexpected table: ${table}`)
    }) as unknown as Knex

    const session = await createWikiActionSessionProvider(knex, config).open(request(new AbortController().signal))

    expect(session?.functions).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'pages.search', risk: 'read' }),
      expect.objectContaining({ name: 'pages.searchTags', risk: 'read' }),
      expect.objectContaining({ name: 'pages.listTags', risk: 'read' }),
      expect.objectContaining({ name: 'pages.discover', risk: 'read' }),
      expect.objectContaining({ name: 'pages.get', risk: 'read' }),
      expect.objectContaining({ name: 'pages.getOkf', risk: 'read' }),
      expect.objectContaining({ name: 'pages.related', risk: 'read' })
    ]))
    session?.close()
  })
})
