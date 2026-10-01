import type { Knex } from 'knex'

import { AGENT_FEATURE_FLAG_KEYS, type AgentActionName, type AgentFeatureFlags } from '../../../shared/agents/contracts.ts'
import { ActionKernel, type ActionAdmissionSnapshot } from '../../agents/actions/kernel.ts'
import { pageAuthority, serializeCanonicalOkfPage } from '../../agents/okf.ts'
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
const okfOutput = serializeCanonicalOkfPage({
  pageId: 42,
  versionId: null,
  sourceRevision: '8',
  locale: actionOutput.locale,
  path: actionOutput.path,
  title: actionOutput.title,
  description: actionOutput.description,
  tags: [],
  visibility: 'public',
  content: actionOutput.content,
  authority: pageAuthority({ okf: { type: 'Procedure', status: 'stable' } }),
  knowledge: null
})
const historyOutput = {
  versions: [{ id: 9, sourceRevision: '8', resourceUri: 'wiki://pages/42/versions/9/revisions/8/okf', action: 'updated', versionDate: '2026-08-16T00:00:00.000Z', authorName: 'Author' }]
}
const historicalOutput = {
  ...actionOutput,
  versionId: 9,
  versionDate: '2026-08-16T00:00:00.000Z',
  sourceRevision: '6',
  okfResourceUri: 'wiki://pages/42/versions/9/revisions/6/okf',
  citation: { evidenceId: 'page:42:version:9:revision:6', label: 'Start', href: '/en/docs/start?v=9' }
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
  kernel.register('pages.getOkf', async () => okfOutput)
  kernel.register('pages.getVersion', async () => historicalOutput)
  kernel.register('pages.listHistory', async () => historyOutput)
  kernel.register('skills.list', async () => ({ skills: [] }))
  kernel.register('skills.read', async () => ({}))
  kernel.register('memory.manage', async () => ({ status: 'saved' }))
  return kernel
}

describe('page evidence validation on action sessions', () => {
  it('keeps evidence validation host-only and rechecks live action availability', async () => {
    let liveAdmission = admission(['pages.get', 'skills.list'])
    let hostAcceptsEvidence = true
    const validateObservation = vi.fn(async () => hostAcceptsEvidence)
    const provider = new KernelActionSessionProvider({
      knex: database,
      kernel: kernelWithReadActions(),
      resolveAdmission: async () => admission(['pages.get', 'skills.list']),
      refreshAdmission: async () => liveAdmission,
      validateObservation
    })
    const session = await provider.open(request(new AbortController().signal))

    expect(session?.validateObservation).toBeTypeOf('function')
    expect(session?.functions.map(action => action.name)).not.toContain('validateObservation')
    expect(await session?.validateObservation?.('pages.get', actionOutput, new AbortController().signal)).toBe(true)

    validateObservation.mockClear()
    hostAcceptsEvidence = false
    expect(await session?.validateObservation?.('pages.get', actionOutput, new AbortController().signal)).toBe(false)
    expect(validateObservation).toHaveBeenCalled()
    validateObservation.mockClear()


    liveAdmission = admission(['skills.list'])
    expect(await session?.validateObservation?.('pages.get', actionOutput, new AbortController().signal)).toBe(false)
    expect(validateObservation).not.toHaveBeenCalled()
    session?.close()
  })

  it('admits current OKF and historical sources but rejects history navigation candidates', async () => {
    const validateObservation = vi.fn(async () => true)
    const provider = new KernelActionSessionProvider({
      knex: database,
      kernel: kernelWithReadActions(),
      resolveAdmission: async () => admission(['pages.getOkf', 'pages.getVersion', 'pages.listHistory']),
      refreshAdmission: async () => admission(['pages.getOkf', 'pages.getVersion', 'pages.listHistory']),
      validateObservation
    })
    const session = await provider.open(request(new AbortController().signal))

    expect(session?.functions.map(action => action.name).sort()).toEqual(['pages.getOkf', 'pages.getVersion', 'pages.listHistory'].sort())
    expect(await session?.validateObservation?.('pages.getOkf', okfOutput, new AbortController().signal)).toBe(true)
    expect(await session?.validateObservation?.('pages.getVersion', historicalOutput, new AbortController().signal)).toBe(true)
    validateObservation.mockClear()
    expect(await session?.validateObservation?.('pages.listHistory', historyOutput, new AbortController().signal)).toBe(false)
    expect(validateObservation).not.toHaveBeenCalled()
    expect(await session?.validateObservation?.('pages.listHistory', { versions: [] }, new AbortController().signal)).toBe(false)
    expect(validateObservation).not.toHaveBeenCalled()
    session?.close()
  })

  it('rejects non-Wiki candidate, skill, and receipt observations', async () => {
    const validateObservation = vi.fn(async () => true)
    const provider = new KernelActionSessionProvider({
      knex: database,
      kernel: kernelWithReadActions(),
      resolveAdmission: async () => admission(['skills.list', 'skills.read', 'memory.manage']),
      refreshAdmission: async () => admission(['skills.list', 'skills.read', 'memory.manage']),
      validateObservation
    })
    const session = await provider.open(request(new AbortController().signal))

    expect(session?.functions.map(action => action.name)).toEqual(['skills.list', 'skills.read', 'memory.manage'])
    expect(await session?.validateObservation?.('skills.list', { skills: [{ name: 'guide' }] }, new AbortController().signal)).toBe(false)
    expect(await session?.validateObservation?.('skills.read', { name: 'guide', content: 'page-like text' }, new AbortController().signal)).toBe(false)
    expect(await session?.validateObservation?.('memory.manage', { status: 'saved' }, new AbortController().signal)).toBe(false)
    expect(validateObservation).not.toHaveBeenCalled()
    session?.close()
  })

  it('rejects recovered or child-shaped page receipts for actions absent from that session', async () => {
    const validateObservation = vi.fn(async () => true)
    const provider = new KernelActionSessionProvider({
      knex: database,
      kernel: kernelWithReadActions(),
      resolveAdmission: async () => admission(['skills.list']),
      refreshAdmission: async () => admission(['skills.list']),
      validateObservation
    })
    const session = await provider.open(request(new AbortController().signal, 'subagent', ['skills.list']))

    expect(session?.functions.map(action => action.name)).toEqual(['skills.list'])
    expect(await session?.validateObservation?.('pages.get', actionOutput, new AbortController().signal)).toBe(false)
    expect(validateObservation).not.toHaveBeenCalled()
    session?.close()
  })

})
