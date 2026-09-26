import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import {
  type AgentCompactionCanonicalSource,
  type AgentCompactionReceipt,
  agentCompactionSha256,
  agentCompactionSourceDigest,
  agentCompactionSourcePrefixes
} from '../../agents/compaction.ts'
import { type AgentActionSessionProvider, AxAgentEngine } from '../../agents/providers/engine.ts'
import type { AgentProviderFactory } from '../../agents/providers/factory.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import type { AgentDispatchBudget, AgentDispatchBudgetReservation, AgentEngineMessage, AgentEngineRequest } from '../../agents/runtime.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

const pricing = { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } as const
const profile = {
  capabilities: {
    streaming: false,
    toolCalling: 'native' as const,
    parallelToolCalls: true,
    structuredOutput: 'native-json-schema' as const,
    usage: 'terminal' as const,
    cancellation: true,
    maxContextTokens: 128_000,
    maxOutputTokens: 8_192
  },
  transportKind: 'openai-responses' as const,
  model: 'gpt-test',
  capabilityRevision: 'cap-1',
  pricingRevision: 'price-1',
  pricing
}

const response = (content: string, inputTokens: number, outputTokens: number, finishReason: 'stop' | 'length' = 'stop'): AxChatResponse => ({
  results: [{ index: 0, content, finishReason }],
  modelUsage: {
    ai: 'test',
    model: 'gpt-test',
    tokens: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens }
  }
})

const canonicalMessages = (
  entries: readonly { readonly role: 'user' | 'assistant'; readonly content: string; readonly providerState?: AgentEngineMessage['providerState'] }[]
): { readonly messages: readonly AgentEngineMessage[]; readonly sources: readonly AgentCompactionCanonicalSource[]; readonly prefixes: readonly string[] } => {
  const sources = entries.map((entry, index) => {
    const id = `message-${index + 1}`
    const ordinal = index + 1
    return {
      id,
      ordinal,
      sourceSha256: agentCompactionSourceDigest({ id, ordinal, role: entry.role, content: entry.content }),
      groundedExpiresAt: null
    }
  })
  return {
    messages: entries.map((entry, index) => ({ ...entry, canonicalSource: sources[index] })),
    sources,
    prefixes: agentCompactionSourcePrefixes(sources)
  }
}

const engineRequest = (messages: readonly AgentEngineMessage[], signal = new AbortController().signal): AgentEngineRequest => ({
  googleSearchEnabled: true,
  run: {
    id: '00000000-0000-4000-8000-000000000101',
    sessionId: '00000000-0000-4000-8000-000000000102',
    userMessageId: '00000000-0000-4000-8000-000000000103',
    assistantMessageId: '00000000-0000-4000-8000-000000000104',
    goalId: null,
    goalContinuation: null,
    ownerId: 7,
    clientRequestId: '00000000-0000-4000-8000-000000000105',
    clientRequestSha256: 'a'.repeat(64),
    status: 'running',
    providerProfileVersionId: '00000000-0000-4000-8000-000000000106',
    transportKind: 'openai-responses',
    model: 'gpt-test',
    executionMode: 'generation-only',
    googleSearchEnabled: true,
    capabilityRevision: 'cap-1',
    pricingRevision: 'price-1',
    totalTokens: 0,
    promptVersion: 1,
    attempts: 1,
    maxAttempts: 3,
    eventSequence: 0,
    leaseOwner: 'worker',
    leaseToken: '00000000-0000-4000-8000-000000000107',
    leaseExpiresAt: '2026-09-20T12:00:00.000Z',
    cancelRequestedAt: null,
    sideEffectsStarted: false,
    errorCode: null,
    errorMessage: null,
    queuedAt: '2026-09-20T00:00:00.000Z',
    startedAt: '2026-09-20T00:00:00.000Z',
    completedAt: null
  },
  purpose: 'root',
  messages,
  memory: { user: [], agent: [] },
  skills: [],
  priorActivity: [],
  limits: { maxTurns: 4, maxToolCalls: 4, maxOutputTokens: 8_192 },
  signal
})

const oversizedHistory = () =>
  canonicalMessages([
    {
      role: 'user',
      content: `OLDEST_USER_CONSTRAINT:${'a'.repeat(40_000)}`,
      providerState: { thoughtBlocks: [{ data: 'encrypted-prefix-state', encrypted: true }] }
    },
    { role: 'assistant', content: `OLDEST_ASSISTANT_DECISION:${'b'.repeat(40_000)}` },
    { role: 'user', content: `TAIL_USER_MUST_SURVIVE:${'c'.repeat(8_000)}` },
    { role: 'assistant', content: `TAIL_ASSISTANT_MUST_SURVIVE:${'d'.repeat(8_000)}` },
    { role: 'user', content: 'LATEST_USER_MUST_SURVIVE' }
  ])

const factoryFor = (chat: (input: Readonly<AxChatRequest<unknown>>, options?: { abortSignal?: AbortSignal }) => Promise<AxChatResponse>) => {
  const create = vi.fn(async () => ({ ...profile, service: { chat } }))
  return { create, factory: { create } as unknown as AgentProviderFactory }
}

const sequencedBudget = (availableTokens: number): AgentDispatchBudget & { readonly consumed: () => number } => {
  let remaining = availableTokens
  let charged = 0
  let nextId = 0
  const active = new Map<number, AgentDispatchBudgetReservation>()
  const reserve = async (maximum: { readonly tokens: number; readonly costMicros: number }): Promise<AgentDispatchBudgetReservation> => {
    if (maximum.tokens > remaining) throw new AgentRepositoryError('AGENT_TOKEN_BUDGET_LIMITED', 'Combined compaction envelope exceeds remaining tokens', 409)
    remaining -= maximum.tokens
    const reservation = { id: ++nextId, ...maximum }
    active.set(reservation.id, reservation)
    return reservation
  }
  const reconcile = async (reservation: AgentDispatchBudgetReservation, actual: { readonly totalTokens: number }): Promise<void> => {
    if (!active.delete(reservation.id)) throw new Error('unknown reservation')
    remaining += reservation.tokens - actual.totalTokens
    charged += actual.totalTokens
  }
  const release = async (reservation: AgentDispatchBudgetReservation): Promise<void> => {
    if (active.delete(reservation.id)) remaining += reservation.tokens
  }
  const makeSequence = (held: AgentDispatchBudgetReservation) => {
    let sequenceRemaining = held.tokens
    let closed = false
    const sequenceActive = new Map<number, AgentDispatchBudgetReservation>()
    return {
      resizeUndispatched: async (maximum: { readonly tokens: number; readonly costMicros: number }) => {
        if (closed) throw new Error('sequence closed')
        const additional = maximum.tokens - sequenceRemaining
        if (additional > remaining) throw new AgentRepositoryError('AGENT_TOKEN_BUDGET_LIMITED', 'Sequence resize exceeds remaining tokens', 409)
        remaining -= additional
        sequenceRemaining = maximum.tokens
        active.set(held.id, { ...held, tokens: held.tokens + additional, costMicros: maximum.costMicros })
      },
      reserve: async (maximum: { readonly tokens: number; readonly costMicros: number }) => {
        if (closed || maximum.tokens > sequenceRemaining) throw new Error('sequence envelope exhausted')
        sequenceRemaining -= maximum.tokens
        const reservation = { id: ++nextId, ...maximum }
        sequenceActive.set(reservation.id, reservation)
        return reservation
      },
      reconcile: async (reservation: AgentDispatchBudgetReservation, actual: { readonly totalTokens: number }) => {
        if (!sequenceActive.delete(reservation.id)) throw new Error('unknown sequence reservation')
        remaining += reservation.tokens - actual.totalTokens
        charged += actual.totalTokens
      },
      release: async (reservation: AgentDispatchBudgetReservation) => {
        if (sequenceActive.delete(reservation.id)) {
          sequenceRemaining += reservation.tokens
        }
      },
      consumeTool: async () => undefined,
      get unsettledExposure() {
        return { tokens: sequenceRemaining + [...sequenceActive.values()].reduce((sum, value) => sum + value.tokens, 0), costMicros: 0 }
      },
      close: async () => {
        if (closed) return
        closed = true
        remaining += sequenceRemaining
        sequenceRemaining = 0
        active.delete(held.id)
      }
    }
  }
  return {
    reserveSequence: async maximum => makeSequence(await reserve(maximum)),
    reserve,
    reconcile,
    release,
    consumeTool: async () => undefined,
    get unsettledExposure() {
      return { tokens: [...active.values()].reduce((sum, value) => sum + value.tokens, 0), costMicros: 0 }
    },
    consumed: () => charged
  }
}

describe('Ax agent engine context compaction', () => {
  it('folds old constraints with the same model, commits before follow-on, and preserves canonical originals and the newest tail', async () => {
    const history = oversizedHistory()
    const original = structuredClone(history.messages)
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    let committed = false
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      if (calls.length === 1) return response('OLDEST constraint remains; OLDEST decision remains.', 1_200, 120)
      expect(committed).toBe(true)
      return response('Done.', 900, 10)
    })
    const { create, factory } = factoryFor(chat)
    const commitCompaction = vi.fn(async (_receipt: AgentCompactionReceipt) => {
      committed = true
    })
    const budget = sequencedBudget(300_000)
    const result = await new AxAgentEngine(factory).execute(
      {
        ...engineRequest(history.messages),
        compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null },
        dispatchBudget: budget
      },
      { commitCompaction, text: async () => undefined, event: async () => undefined }
    )

    expect(calls).toHaveLength(2)
    expect(create).toHaveBeenNthCalledWith(2, '00000000-0000-4000-8000-000000000106', expect.objectContaining({ purpose: 'agent', googleSearchEnabled: false }))
    expect(calls[0]).not.toHaveProperty('functions')
    expect(calls[0]?.modelConfig?.maxTokens).toBe(4_000)
    const summaryUser = calls[0]?.chatPrompt.find(message => message.role === 'user')
    const summaryInput = summaryUser && 'content' in summaryUser ? String(summaryUser.content) : ''
    expect(JSON.stringify(calls[0])).toContain('OLDEST_USER_CONSTRAINT')
    expect(summaryInput).toContain('"previousSummary":null')
    expect(summaryInput).toContain('"maximumSummaryBytes":16000')
    expect(JSON.stringify(calls[0])).not.toContain('encrypted-prefix-state')
    expect(JSON.stringify(calls[0])).not.toMatch(/attachments|fileUri|data:image/iu)
    expect(JSON.stringify(calls[1])).toContain('OLDEST constraint remains')
    expect(JSON.stringify(calls[1])).toContain('TAIL_USER_MUST_SURVIVE')
    expect(JSON.stringify(calls[1])).toContain('TAIL_ASSISTANT_MUST_SURVIVE')
    expect(JSON.stringify(calls[1])).toContain('LATEST_USER_MUST_SURVIVE')
    expect(commitCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        usageVersion: 2,
        outcome: 'context_compacted',
        inputTokens: 1_200,
        outputTokens: 120,
        totalTokens: 1_320,
        finishReason: 'stop',
        contentTruncated: false,
        compaction: expect.objectContaining({
          scope: 'history',
          throughMessageId: history.sources[1]!.id,
          throughOrdinal: history.sources[1]!.ordinal,
          sourceSha256: history.prefixes[1]!,
          summarySha256: agentCompactionSha256('OLDEST constraint remains; OLDEST decision remains.')
        })
      })
    )
    expect(history.messages).toEqual(original)
    expect(result).toMatchObject({ inputTokens: 2_100, outputTokens: 130, totalTokens: 2_230 })
    expect(budget.consumed()).toBe(2_230)
  })
  it('delivers only relevant exact child page units instead of oversized background', async () => {
    const history = canonicalMessages([{ role: 'user', content: 'What does Alpha require before release?' }])
    const sourceUnit = 'Alpha release depends on a verified staging receipt.'
    const background = 'Neutral operational background remains unchanged. '.repeat(900)
    const alphaContent = `# Alpha\n\n${sourceUnit}\n\n${background}`
    const betaContent = `# Beta\n\n${'Beta background remains unchanged. '.repeat(850)}`
    const alphaEvidenceId = 'page:1:revision:rev-1'
    const betaEvidenceId = 'page:2:revision:rev-2'
    const evidenceSeeds = [
      {
        taskId: '00000000-0000-4000-8000-000000000021',
        subagentRunId: '00000000-0000-4000-8000-000000000031',
        actionCallId: 'child-alpha-read',
        actionName: 'pages.get' as const,
        output: {
          id: 1,
          locale: 'en',
          path: 'alpha',
          title: 'Alpha',
          contentType: 'markdown',
          sourceRevision: 'rev-1',
          content: alphaContent,
          citation: { evidenceId: alphaEvidenceId, label: 'Alpha', href: '/en/alpha' },
          citationSections: []
        }
      },
      {
        taskId: '00000000-0000-4000-8000-000000000022',
        subagentRunId: '00000000-0000-4000-8000-000000000032',
        actionCallId: 'child-beta-read',
        actionName: 'pages.get' as const,
        output: {
          id: 2,
          locale: 'en',
          path: 'beta',
          title: 'Beta',
          contentType: 'markdown',
          sourceRevision: 'rev-2',
          content: betaContent,
          citation: { evidenceId: betaEvidenceId, label: 'Beta', href: '/en/beta' },
          citationSections: []
        }
      }
    ]
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return calls.length === 1
        ? response(`Alpha release does not require a verified staging receipt. [[cite:${alphaEvidenceId}]]`, 200, 20)
        : response(`${sourceUnit} [[cite:${alphaEvidenceId}]]`, 300, 30)
    })
    const { factory } = factoryFor(chat)
    const validateObservation = vi.fn(async () => true)
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.get',
            title: 'Read page',
            description: 'Read canonical page evidence',
            parameters: { type: 'object', properties: {} },
            risk: 'read',
            group: 'core'
          }
        ],
        invoke: async () => {
          throw new Error('No direct page read was expected')
        },
        snapshot: async () => ({}),
        close: () => undefined,
        authoritySha256: null,
        validateObservation
      })
    }
    const text = vi.fn(async () => undefined)
    const result = await new AxAgentEngine(factory, actions).execute(
      {
        ...engineRequest(history.messages),
        run: { ...engineRequest(history.messages).run, executionMode: 'agent' },
        research: { packets: [], incompleteTasks: [], evidenceSeeds },
        compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null }
      },
      { text, event: async () => undefined }
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]?.chatPrompt.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(sourceUnit))).toBe(
      true
    )
    const deliveredAlpha = calls[0]?.chatPrompt.find(
      message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('"actionCallId":"child-alpha-read"')
    )
    expect(deliveredAlpha?.role === 'user' ? deliveredAlpha.content : '').toContain(sourceUnit)
    expect(deliveredAlpha?.role === 'user' ? deliveredAlpha.content : '').toContain('<wiki-evidence-context>')
    expect(deliveredAlpha?.role === 'user' ? deliveredAlpha.content : '').not.toContain(background)
    expect(calls[1]?.chatPrompt.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(sourceUnit))).toBe(
      true
    )
    expect(JSON.stringify(calls[0]?.chatPrompt)).not.toContain('Beta background remains unchanged.')
    expect(text).toHaveBeenCalledWith(`${sourceUnit} [[cite:${alphaEvidenceId}]]`)
    expect(result.citations).toEqual([{ evidenceId: alphaEvidenceId, kind: 'page', label: 'Alpha', href: '/en/alpha' }])
    expect(validateObservation).toHaveBeenCalledWith('pages.get', evidenceSeeds[0]!.output, expect.any(AbortSignal))
  })

  it('revalidates rejected page evidence before replaying it to the provider', async () => {
    const history = canonicalMessages([{ role: 'user', content: 'What does Alpha require before release?' }])
    const sourceUnit = 'Alpha release depends on a verified staging receipt.'
    const evidenceId = 'page:1:revision:rev-1'
    const seed = {
      taskId: '00000000-0000-4000-8000-000000000021',
      subagentRunId: '00000000-0000-4000-8000-000000000031',
      actionCallId: 'child-alpha-read',
      actionName: 'pages.get' as const,
      output: {
        id: 1,
        locale: 'en',
        path: 'alpha',
        title: 'Alpha',
        contentType: 'markdown',
        sourceRevision: 'rev-1',
        content: `# Alpha

${sourceUnit}`,
        citation: { evidenceId, label: 'Alpha', href: '/en/alpha' },
        citationSections: []
      }
    }
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return calls.length === 1
        ? response(`Alpha release does not require a staging receipt. [[cite:${evidenceId}]]`, 200, 20)
        : response('I cannot verify Alpha’s release requirement now.', 300, 30)
    })
    const { factory } = factoryFor(chat)
    let validationCount = 0
    const validateObservation = vi.fn(async () => ++validationCount === 1)
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.get',
            title: 'Read page',
            description: 'Read canonical page evidence',
            parameters: { type: 'object', properties: {} },
            risk: 'read',
            group: 'core'
          }
        ],
        invoke: async () => {
          throw new Error('No direct page read was expected')
        },
        snapshot: async () => ({}),
        close: () => undefined,
        authoritySha256: null,
        validateObservation
      })
    }
    const text = vi.fn(async () => undefined)
    const result = await new AxAgentEngine(factory, actions).execute(
      {
        ...engineRequest(history.messages),
        run: { ...engineRequest(history.messages).run, executionMode: 'agent' },
        research: { packets: [], incompleteTasks: [], evidenceSeeds: [seed] }
      },
      { text, event: async () => undefined }
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]?.chatPrompt.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(sourceUnit))).toBe(
      true
    )
    expect(calls[1]?.chatPrompt.every(message => typeof message.content !== 'string' || !message.content.includes(sourceUnit))).toBe(true)
    expect(text).toHaveBeenCalledWith('I cannot verify Alpha’s release requirement now.')
    expect(result.citations).toBeUndefined()
    expect(validateObservation).toHaveBeenCalledWith('pages.get', seed.output, expect.any(AbortSignal))
  })

  it('reuses an exact durable checkpoint without another summary call or charge', async () => {
    const history = oversizedHistory()
    const summary = 'Reusable untrusted summary of the oldest exchange.'
    const checkpoint = {
      content: summary,
      metadata: {
        version: 1 as const,
        scope: 'history' as const,
        ownerId: 7,
        sessionId: '00000000-0000-4000-8000-000000000102',
        sourceRunId: '00000000-0000-4000-8000-000000000099',
        providerProfileVersionId: '00000000-0000-4000-8000-000000000106',
        transportKind: 'openai-responses',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        throughMessageId: history.sources[1]!.id,
        throughOrdinal: history.sources[1]!.ordinal,
        sourceSha256: history.prefixes[1]!,
        summarySha256: agentCompactionSha256(summary),
        groundedExpiresAt: null
      }
    }
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const { create, factory } = factoryFor(async input => {
      calls.push(input)
      return response('Done.', 30, 4)
    })
    const commitCompaction = vi.fn(async () => undefined)

    const result = await new AxAgentEngine(factory).execute(
      {
        ...engineRequest(history.messages),
        compaction: { checkpoint, sourcePrefixSha256: history.prefixes, groundedExpiresAt: null }
      },
      { commitCompaction, text: async () => undefined, event: async () => undefined }
    )

    expect(create).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0])).toContain(summary)
    expect(JSON.stringify(calls[0])).not.toContain('OLDEST_USER_CONSTRAINT')
    expect(JSON.stringify(calls[0])).toContain('LATEST_USER_MUST_SURVIVE')
    expect(commitCompaction).not.toHaveBeenCalled()
    expect(result.totalTokens).toBe(34)
  })

  it.each([
    { label: 'length-limited', summary: 'partial summary', finishReason: 'length' },
    { label: 'empty', summary: '   ', finishReason: 'stop' },
    { label: 'nonshrinking', summary: 'z'.repeat(15_000), finishReason: 'stop' }
  ] as const)('rejects a $label fold and sends the unchanged full conversation when it still fits', async ({ summary, finishReason }) => {
    const history = canonicalMessages([
      { role: 'user', content: `ELIGIBLE_PREFIX:${'a'.repeat(6_000)}` },
      { role: 'assistant', content: `ELIGIBLE_REPLY:${'b'.repeat(6_000)}` },
      { role: 'user', content: `PROTECTED_USER_ONE:${'c'.repeat(4_000)}` },
      { role: 'assistant', content: `PROTECTED_REPLY_ONE:${'d'.repeat(2_000)}` },
      { role: 'user', content: `PROTECTED_USER_TWO:${'e'.repeat(4_000)}` },
      { role: 'assistant', content: `PROTECTED_REPLY_TWO:${'f'.repeat(2_000)}` },
      { role: 'user', content: `CURRENT_USER:${'g'.repeat(76_000)}` }
    ])
    const original = structuredClone(history.messages)
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return calls.length === 1 ? response(summary, 200, 20, finishReason) : response('Full-context answer.', 300, 10)
    })
    const { factory } = factoryFor(chat)
    const commitCompaction = vi.fn(async () => undefined)
    const event = vi.fn(async () => undefined)

    const result = await new AxAgentEngine(factory).execute(
      {
        ...engineRequest(history.messages),
        compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null }
      },
      { commitCompaction, text: async () => undefined, event }
    )
    expect(chat).toHaveBeenCalledTimes(2)
    expect(commitCompaction).not.toHaveBeenCalled()
    expect(JSON.stringify(calls[1])).toContain('ELIGIBLE_PREFIX')
    expect(JSON.stringify(calls[1])).toContain('PROTECTED_USER_ONE')
    expect(JSON.stringify(calls[1])).toContain('PROTECTED_USER_TWO')
    expect(JSON.stringify(calls[1])).toContain('CURRENT_USER')
    expect(event).toHaveBeenCalledWith(
      'model.turn',
      expect.objectContaining({
        usageVersion: 2,
        outcome: 'context_compaction_rejected',
        inputTokens: 200,
        outputTokens: 20,
        totalTokens: 220,
        finishReason
      })
    )
    expect(history.messages).toEqual(original)
    expect(result).toMatchObject({ inputTokens: 500, outputTokens: 30, totalTokens: 530 })
  })

  it('does not pay again for an unchanged failed later fold after an evidence correction', async () => {
    const history = canonicalMessages([
      { role: 'user', content: `FIRST_CONSTRAINT:${'a'.repeat(38_000)}` },
      { role: 'assistant', content: `FIRST_DECISION:${'b'.repeat(38_000)}` },
      { role: 'user', content: `SECOND_CONSTRAINT:${'c'.repeat(38_000)}` },
      { role: 'assistant', content: `SECOND_DECISION:${'d'.repeat(38_000)}` },
      { role: 'user', content: 'Finish the request.' }
    ])
    const outputs = [
      response('Preserve the first constraint and decision.', 100, 10),
      response('', 200, 0),
      response(`Unsupported citation [[cite:page:999:revision:1:section:1]]. ${'x'.repeat(20_000)}`, 300, 20),
      response('Done.', 400, 5)
    ]
    const chat = vi.fn(async () => {
      const next = outputs.shift()
      if (next === undefined) throw new Error('An unchanged failed summary was dispatched again')
      return next
    })
    const { factory } = factoryFor(chat)
    const receipts: AgentCompactionReceipt[] = []
    const event = vi.fn(async (_type: string, _data: Record<string, unknown>) => undefined)
    const result = await new AxAgentEngine(factory).execute(
      { ...engineRequest(history.messages), compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null } },
      {
        commitCompaction: async receipt => {
          receipts.push(receipt)
        },
        text: async () => undefined,
        event
      }
    )
    expect(chat).toHaveBeenCalledTimes(4)
    expect(receipts).toHaveLength(1)
    expect(event.mock.calls.filter(call => call[0] === 'model.turn' && call[1]?.outcome === 'context_compaction_rejected')).toHaveLength(1)
    expect(result.totalTokens).toBe(1_035)
  })

  it('rechecks source expiry after admission and releases an undispatched hold', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-20T00:00:00.000Z'))
    try {
      const expiry = '2026-09-20T00:00:01.000Z'
      const budget = sequencedBudget(250_000)
      const chat = vi.fn(async () => response('This must not be requested.', 10, 1))
      const { factory } = factoryFor(chat)
      const reserveSequence = vi.fn(async (maximum: { tokens: number; costMicros: number }) => {
        const held = await budget.reserveSequence!(maximum)
        vi.setSystemTime(new Date(expiry))
        return held
      })
      await expect(
        new AxAgentEngine(factory).execute(
          {
            ...engineRequest([{ role: 'user', content: 'Use the retained source.' }]),
            compaction: { sourcePrefixSha256: [], groundedExpiresAt: expiry },
            dispatchBudget: { ...budget, reserveSequence }
          },
          { text: async () => undefined, event: async () => undefined }
        )
      ).rejects.toMatchObject({ code: 'AGENT_CONTEXT_TOO_LARGE' })
      expect(reserveSequence).toHaveBeenCalledOnce()
      expect(chat).not.toHaveBeenCalled()
      expect(budget.unsettledExposure.tokens).toBe(0)
      expect(budget.consumed()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('records completed usage but never publishes an answer whose source expired in flight', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-20T00:00:00.000Z'))
    try {
      const expiry = '2026-09-20T00:00:01.000Z'
      const budget = sequencedBudget(250_000)
      const chat = vi.fn(async () => {
        vi.setSystemTime(new Date(expiry))
        return response('Expired private source must not be published.', 30, 4)
      })
      const { factory } = factoryFor(chat)
      const text = vi.fn(async () => undefined)
      const event = vi.fn(async () => undefined)
      await expect(
        new AxAgentEngine(factory).execute(
          {
            ...engineRequest([{ role: 'user', content: 'Use the retained source.' }]),
            compaction: { sourcePrefixSha256: [], groundedExpiresAt: expiry },
            dispatchBudget: budget
          },
          { text, event }
        )
      ).rejects.toMatchObject({ code: 'AGENT_CONTEXT_TOO_LARGE' })
      expect(chat).toHaveBeenCalledOnce()
      expect(text).not.toHaveBeenCalled()
      expect(event).toHaveBeenCalledWith(
        'model.turn',
        expect.objectContaining({
          content: '',
          contentPurged: true,
          inputTokens: 30,
          outputTokens: 4,
          totalTokens: 34
        })
      )
      expect(budget.consumed()).toBe(34)
      expect(budget.unsettledExposure.tokens).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['cancelled summary', 'durable commit failure'])('%s never publishes a checkpoint or follow-on answer', async failure => {
    const history = oversizedHistory()
    const controller = new AbortController()
    const text = vi.fn(async () => undefined)
    const event = vi.fn(async () => undefined)
    const chat = vi.fn(async (_input: Readonly<AxChatRequest<unknown>>, options?: { abortSignal?: AbortSignal }) => {
      if (failure === 'cancelled summary') {
        controller.abort(new Error('run cancelled'))
        throw options?.abortSignal?.reason ?? new Error('run cancelled')
      }
      return response('Valid summary that must be durable before use.', 300, 30)
    })
    const { factory } = factoryFor(chat)
    const commitCompaction = vi.fn(async () => {
      throw new Error('durable append failed')
    })

    await expect(
      new AxAgentEngine(factory).execute(
        {
          ...engineRequest(history.messages, controller.signal),
          compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null }
        },
        { commitCompaction, text, event }
      )
    ).rejects.toThrow()
    expect(chat).toHaveBeenCalledOnce()
    expect(text).not.toHaveBeenCalled()
    if (failure === 'cancelled summary') expect(commitCompaction).not.toHaveBeenCalled()
    else expect(commitCompaction).toHaveBeenCalledOnce()
  })

  it('does not spend on a summary when the combined summary and follow-on envelope cannot be funded', async () => {
    const history = oversizedHistory()
    const chat = vi.fn(async () => response('must not run', 1, 1))
    const { factory } = factoryFor(chat)
    const budget = sequencedBudget(10_000)

    const text = vi.fn(async () => undefined)
    const result = await new AxAgentEngine(factory).execute(
      {
        ...engineRequest(history.messages),
        compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null },
        dispatchBudget: budget
      },
      { commitCompaction: async () => undefined, text, event: async () => undefined }
    )
    expect(result).toMatchObject({ executionLimit: { reason: 'tokens', publication: 'inability' } })
    expect(text.mock.calls.map(([delta]) => delta).join('')).toContain('token allowance')
    expect(chat).not.toHaveBeenCalled()
    expect(budget.consumed()).toBe(0)
  })

  it('retains completed same-run tool call/result authority pairs through synthesis', async () => {
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const replies: AxChatResponse[] = [
      {
        results: [
          {
            index: 0,
            content: 'Reading first source.',
            finishReason: 'function_call',
            functionCalls: [{ id: 'tool-1', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }]
          }
        ],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } }
      },
      {
        results: [
          {
            index: 0,
            content: 'Reading second source.',
            finishReason: 'function_call',
            functionCalls: [{ id: 'tool-2', type: 'function', function: { name: 'wiki_get_page', params: '{"id":2}' } }]
          }
        ],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 200, completionTokens: 10, totalTokens: 210 } }
      },
      response('EVIDENCE_TWO [[cite:page:2:revision:2]]', 300, 20)
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)

      return replies.shift()!
    })
    const { factory } = factoryFor(chat)
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke: async (_name, input) => {
          if (typeof input !== 'object' || input === null || !('id' in input) || typeof input.id !== 'number') throw new Error('invalid page id')
          const id = input.id
          return {
            id,
            locale: 'en',
            path: `evidence-${id}`,
            sourceRevision: String(id),
            title: `Evidence ${id}`,
            contentType: 'markdown',
            content: `${id === 1 ? 'EVIDENCE_ONE' : 'EVIDENCE_TWO'} ${String(id).repeat(500)}`,
            citation: { evidenceId: `page:${id}:revision:${id}`, label: `Evidence ${id}`, href: `/en/evidence-${id}` },
            citationSections: []
          }
        },
        snapshot: async () => ({}),
        close: async () => undefined,
        authoritySha256: 'f'.repeat(64)
      })
    }
    const base = engineRequest([{ role: 'user', content: 'Compare both sources.' }])
    const event = vi.fn(async () => undefined)
    const commitCompaction = vi.fn(async () => undefined)
    const result = await new AxAgentEngine(factory, actions).execute(
      {
        ...base,
        run: { ...base.run, executionMode: 'agent' },
        googleSearchEnabled: false,
        limits: { maxTurns: 4, maxToolCalls: 4, maxOutputTokens: 8_192 },
        dispatchBudget: sequencedBudget(400_000)
      },
      { commitCompaction, text: async () => undefined, event }
    )

    expect(calls).toHaveLength(3)
    const synthesisRequest = JSON.stringify(calls[2])
    expect(synthesisRequest).toContain('tool-1')
    expect(synthesisRequest).toContain('EVIDENCE_ONE')
    expect(synthesisRequest).toContain('tool-2')
    expect(synthesisRequest).toContain('EVIDENCE_TWO')
    expect(event).not.toHaveBeenCalledWith('model.turn', expect.objectContaining({ outcome: 'context_compacted' }))
    expect(commitCompaction).not.toHaveBeenCalled()
    expect(result).toMatchObject({ authoritySha256: 'f'.repeat(64), citations: [expect.objectContaining({ evidenceId: 'page:2:revision:2' })] })
  })
})
