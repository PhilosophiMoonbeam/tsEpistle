import type { Knex } from 'knex'

import { AGENT_FEATURE_FLAG_KEYS, type AgentActionName, type AgentFeatureFlags } from '../../../shared/agents/contracts.ts'
import { ActionKernel, type ActionAdmissionSnapshot } from '../../agents/actions/kernel.ts'
import { KernelActionSessionProvider } from '../../agents/providers/action-sessions.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

const requestId = '00000000-0000-4000-8000-000000000001'
const userId = 7
const flags = Object.fromEntries(AGENT_FEATURE_FLAG_KEYS.map(flag => [flag, true])) as AgentFeatureFlags
const actionOutput = {
  id: 42,
  locale: 'en',
  path: 'docs/start',
  title: 'Start',
  description: '',
  contentType: 'markdown',
  sourceRevision: '8',
  authority: { state: 'missing', metadata: null, trust: null },
  okfResourceUri: 'wiki://pages/42/versions/current/revisions/8/okf',
  citation: { evidenceId: 'page:42:revision:8', label: 'Start', href: '/en/docs/start' },
  content: '# Start',
  updatedAt: '2026-08-17T00:00:00.000Z',
  citationSections: [],
  knowledge: null
}
const admission = (allowedActions?: readonly AgentActionName[]): ActionAdmissionSnapshot => ({
  transport: 'agent',
  executionMode: 'agent',
  supportsTools: true,
  permissions: ['use:agents', 'read:pages'],
  groupIds: [],
  featureFlags: flags,
  ...(allowedActions === undefined ? {} : { allowedActions })
})

const request = (signal: AbortSignal, purpose: 'root' | 'subagent' = 'root', actionAllowlist?: readonly AgentActionName[]): AgentEngineRequest => ({
  run: {
    id: requestId,
    sessionId: '00000000-0000-4000-8000-000000000002',
    userMessageId: '00000000-0000-4000-8000-000000000003',
    assistantMessageId: '00000000-0000-4000-8000-000000000004',
    ownerId: userId,
    goalId: null,
    goalContinuation: null,
    clientRequestId: '00000000-0000-4000-8000-000000000005',
    clientRequestSha256: 'a'.repeat(64),
    status: 'running',
    providerProfileVersionId: '00000000-0000-4000-8000-000000000006',
    transportKind: 'openai-responses',
    model: 'gpt-test',
    executionMode: 'agent',
    googleSearchEnabled: false,
    capabilityRevision: 'cap-1',
    pricingRevision: 'price-1',
    promptVersion: 1,
    totalTokens: 0,
    attempts: 1,
    maxAttempts: 3,
    eventSequence: 0,
    leaseOwner: 'worker',
    leaseToken: '00000000-0000-4000-8000-000000000007',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    cancelRequestedAt: null,
    sideEffectsStarted: false,
    errorCode: null,
    errorMessage: null,
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null
  },
  purpose,
  ...(actionAllowlist === undefined ? {} : { actionAllowlist }),
  googleSearchEnabled: false,
  messages: [{ role: 'user', content: 'Read the page' }],
  memory: { user: [], agent: [] },
  skills: [],
  signal
})

const database = (() => {
  const knex = (table: string) => {
    if (table !== 'agentRuns') throw new Error(`Unexpected table ${table}`)
    return { where: () => ({ first: async () => ({ runtimeStateCiphertext: null }) }) }
  }
  return knex as unknown as Knex
})()

const kernelWithReadActions = (): ActionKernel => {
  const kernel = new ActionKernel()
  kernel.register('pages.get', async () => actionOutput)
  kernel.register('skills.list', async () => ({ skills: [] }))
  return kernel
}

describe('page evidence validation on action sessions', () => {
  it('is host-only and rechecks live action availability before validating a receipt', async () => {
    let liveAdmission = admission(['pages.get', 'skills.list'])
    const validatePageEvidence = vi.fn(
      async (_request: AgentEngineRequest, _authority: unknown, _name: AgentActionName, output: unknown) => output === actionOutput
    )
    const provider = new KernelActionSessionProvider({
      knex: database,
      kernel: kernelWithReadActions(),
      resolveAdmission: async () => admission(['pages.get', 'skills.list']),
      refreshAdmission: async () => liveAdmission,
      validatePageEvidence
    })
    const session = await provider.open(request(new AbortController().signal))

    expect(session?.validatePageEvidence).toBeTypeOf('function')
    expect(session?.functions.map(action => action.name)).not.toContain('validatePageEvidence')
    expect(await session?.validatePageEvidence?.('pages.get', actionOutput, new AbortController().signal)).toBe(true)
    expect(validatePageEvidence).toHaveBeenCalledTimes(1)

    liveAdmission = admission(['skills.list'])
    expect(await session?.validatePageEvidence?.('pages.get', actionOutput, new AbortController().signal)).toBe(false)
    expect(validatePageEvidence).toHaveBeenCalledTimes(1)
    session?.close()
  })

  it('rejects recovered or child-shaped page receipts for actions absent from that session', async () => {
    const validatePageEvidence = vi.fn(async () => true)
    const provider = new KernelActionSessionProvider({
      knex: database,
      kernel: kernelWithReadActions(),
      resolveAdmission: async () => admission(['skills.list']),
      refreshAdmission: async () => admission(['skills.list']),
      validatePageEvidence
    })
    const session = await provider.open(request(new AbortController().signal, 'subagent', ['skills.list']))

    expect(session?.functions.map(action => action.name)).toEqual(['skills.list'])
    expect(await session?.validatePageEvidence?.('pages.get', actionOutput, new AbortController().signal)).toBe(false)
    expect(validatePageEvidence).not.toHaveBeenCalled()
    session?.close()
  })

  it('keeps validation optional on custom action sessions without a host page validator', async () => {
    const provider = new KernelActionSessionProvider({
      knex: database,
      kernel: kernelWithReadActions(),
      resolveAdmission: async () => admission(['pages.get']),
      refreshAdmission: async () => admission(['pages.get'])
    })
    const session = await provider.open(request(new AbortController().signal))

    expect(session?.validatePageEvidence).toBeUndefined()
    session?.close()
  })
})
