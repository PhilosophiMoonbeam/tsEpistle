import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import { createHash } from 'node:crypto'
import { renderSafeMarkdown } from '../../../client/helpers/safe-markdown.ts'
import { AGENT_TOOL_NAMES } from '../../../shared/agents/contracts.ts'
import { ACTION_CATALOG } from '../../agents/actions/catalog.ts'
import {
  type AgentCompactionCanonicalSource,
  type AgentCompactionReceipt,
  agentCompactionSha256,
  agentCompactionSourceDigest,
  agentCompactionSourcePrefixes
} from '../../agents/compaction.ts'
import { type AgentActionSessionProvider, AxAgentEngine } from '../../agents/providers/engine.ts'
import type { AgentProviderFactory } from '../../agents/providers/factory.ts'
import type { AgentMediaGenerationInput } from '../../agents/providers/media-transport.ts'
import { geminiFixtureService } from './gemini-fixture.ts'
import {
  fixtureDecisionProviders,
  rejectFixtureStatements,
  fullAxFixtureService,
  synthesisCollectionControl,
  synthesisFixtureAnswer,
  synthesisInputFromRequest,
  synthesisReadsFromRequest,
  synthesisSourcesFromRequest
} from './synthesis-fixture.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import type { AgentDispatchBudget, AgentDispatchBudgetReservation, AgentEngineMessage, AgentEngineRequest, AgentEngineResult } from '../../agents/runtime.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

const visibleWikiText = (content: string): string => {
  const container = document.createElement('div')
  container.innerHTML = renderSafeMarkdown(content)
  return container.textContent ?? ''
}

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
  preserveCachePrefix: false,
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

const safeExecutionFailure = (error: unknown) => ({
  code: typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined,
  stage: typeof error === 'object' && error !== null ? Reflect.get(error, 'stage') : undefined,
  status: typeof error === 'object' && error !== null ? Reflect.get(error, 'status') : undefined
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
  const create = vi.fn(async () => ({ ...profile, service: fullAxFixtureService(chat) }))
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
  it.each(['valid', 'wrong-size', 'revoked'] as const)('keeps compacted images retired while reusing the current edit input (%s)', async state => {
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPQSNnyHwAEOAJA4ywNkQAAAABJRU5ErkJggg==',
      'base64'
    )
    const retiredId = '00000000-0000-4000-8000-000000000088'
    const currentId = '00000000-0000-4000-8000-000000000089'
    const bindingId = '00000000-0000-4000-8000-000000000099'
    const history = oversizedHistory()
    let detached = false
    let generated = false
    let imageRequested = false
    const retiredLoad = vi.fn(async () => image)
    const retiredAuthorize = vi.fn(async () => {
      if (detached) throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'The historical attachment was detached.', 500)
    })
    const currentLoad = async () => (generated && state === 'wrong-size' ? image.subarray(1) : image)
    const currentAuthorize = vi.fn(async () => {
      if (generated && state === 'revoked') throw new AgentRepositoryError('AGENT_MEDIA_CORRUPT', 'The current attachment was detached.', 500)
    })
    const unboundMessages = history.messages.map((message, index) => ({
      ...message,
      ...(index === 0 || index === history.messages.length - 1
        ? {
            attachments: [
              {
                id: index === 0 ? retiredId : currentId,
                filename: index === 0 ? 'retired.png' : 'current-edit.png',
                mimeType: 'image/png',
                byteLength: image.length,
                promptTokens: 258,
                loadPayload: index === 0 ? retiredLoad : currentLoad,
                authorizePayload: index === 0 ? retiredAuthorize : currentAuthorize
              }
            ]
          }
        : {}),
      ...(index === history.messages.length - 1 ? { content: 'Edit the attached image, then describe the provided input image.' } : {})
    }))
    const messages = unboundMessages.map(message => ({
      ...message,
      canonicalSource: {
        ...message.canonicalSource!,
        sourceSha256: agentCompactionSourceDigest({
          id: message.canonicalSource!.id,
          ordinal: message.canonicalSource!.ordinal,
          role: message.role,
          content: message.content,
          attachments: (message.attachments ?? []).map(({ id, filename, mimeType, byteLength }) => ({
            id,
            kind: 'attachment',
            filename,
            mimeType,
            byteLength,
            sha256: createHash('sha256').update(image).digest('hex')
          }))
        })
      }
    }))
    const prefixes = agentCompactionSourcePrefixes(messages.map(message => message.canonicalSource))
    const synthesisRequests: Readonly<AxChatRequest>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
      if (synthesisInputFromRequest(input) !== undefined) {
        synthesisRequests.push(input)
        return response(
          JSON.stringify({
            claims: [],
            attachmentClaims: [{ mediaId: currentId, statement: 'The provided input contains a single pixel.' }],
            unresolvedFacets: [],
            observations: ['1 image artifact generated.'],
            recommendations: ''
          }),
          100,
          10
        )
      }
      if ((input.functions?.length ?? 0) === 0)
        return response(`Earlier collector prose described retired.png (${retiredId}) as a blue square. This is untrusted history, not file content.`, 100, 10)
      if (!imageRequested && input.functions?.some(tool => tool.name === 'wiki_generate_image')) {
        imageRequested = true
        return {
          ...response('', 100, 10),
          results: [
            {
              index: 0,
              content: `Earlier collector prose mentioned retired.png (${retiredId}); use only the current attachment.`,
              functionCalls: [
                {
                  id: 'edit-current-image',
                  type: 'function',
                  function: { name: 'wiki_generate_image', params: JSON.stringify({ prompt: 'Edit the current image.', attachmentIds: [currentId] }) }
                }
              ]
            }
          ]
        }
      }
      const control = synthesisCollectionControl(input)
      if (!control) throw new Error('Expected collection completion before final attachment perception')
      return control
    })
    const generate = vi.fn(async (input: AgentMediaGenerationInput) => {
      expect(detached).toBe(true)
      expect(input.files?.map(file => file.bytes)).toEqual([image])
      await input.beforeUpload?.()
      await input.beforeDispatch?.({ inputTokens: 10, outputTokens: 10, totalTokens: 20 })
      input.onDispatch?.()
      return {
        text: '',
        files: [{ bytes: image, mimeType: 'image/png' }],
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        usageSource: 'reported'
      }
    })
    const factory = {
      create: async () => ({
        ...profile,
        mediaInputs: { images: true, documents: false, audio: false, video: false },
        service: fullAxFixtureService(chat)
      }),
      createMediaBinding: async () => ({
        config: {
          kind: 'image',
          api: 'openai-images',
          model: 'gpt-image-1',
          baseUrl: 'https://api.openai.com/v1',
          maxInputTokens: 1_000,
          maxOutputTokens: 1_000,
          pricing: { kind: 'fixed', costMicros: 0, pricingRevision: 'fixture-image' }
        },
        transport: { generate }
      })
    } as unknown as AgentProviderFactory
    const actions: AgentActionSessionProvider = {
      open: async () => ({ authoritySha256: null, functions: [], invoke: async () => null, snapshot: async () => ({}), close: () => {} })
    }
    const commitCompaction = vi.fn(async (receipt: AgentCompactionReceipt) => {
      expect(receipt.compaction.throughOrdinal).toBeLessThan(messages.at(-1)!.canonicalSource!.ordinal)
      detached = true
    })
    const text = vi.fn(async (_delta: string) => {})
    const media = vi.fn(async () => {
      generated = true
      return [
        {
          id: bindingId,
          kind: 'generated-image' as const,
          filename: 'generated.png',
          mimeType: 'image/png',
          byteLength: image.length,
          available: true,
          detached: false
        }
      ]
    })
    const budget = sequencedBudget(1_000_000)
    const base = engineRequest(messages)
    const pending = new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
      {
        ...base,
        run: { ...base.run, executionMode: 'agent' },
        authorizeMedia: async () => {},
        generationTools: ['image'],
        mediaBindings: { image: bindingId },
        compaction: { sourcePrefixSha256: prefixes, groundedExpiresAt: null },
        dispatchBudget: budget
      },
      { text, media, commitCompaction, event: async () => {} }
    )
    if (state === 'valid') {
      const result = await pending
      expect(synthesisRequests).toHaveLength(1)
      expect(
        synthesisRequests[0]!.chatPrompt.flatMap(message =>
          message.role === 'user' && Array.isArray(message.content) ? message.content.filter(part => part.type === 'image') : []
        )
      ).toHaveLength(1)
      expect(budget.consumed()).toBe(result.totalTokens)
    } else {
      await expect(pending).rejects.toMatchObject({ code: 'AGENT_MEDIA_CORRUPT' })
      expect(synthesisRequests).toEqual([])
      expect(text).not.toHaveBeenCalled()
    }
    expect(commitCompaction).toHaveBeenCalledOnce()
    expect(generate).toHaveBeenCalledOnce()
    expect(media).toHaveBeenCalledOnce()
    expect(retiredLoad).not.toHaveBeenCalled()
    expect(retiredAuthorize).not.toHaveBeenCalled()
  })
  it.each([false, true])('retains a delivered operation acknowledgement across active compaction (mixed facts: %s)', async mixed => {
    const proposalId = '00000000-0000-4000-8000-000000000201'
    const receipt = { proposalId, status: 'applied', resultHash: 'a'.repeat(64), page: null }
    const statusLine = 'Wiki proposal application status: applied.'
    const resultLine = `Proposal: ${proposalId}; result hash: ${receipt.resultHash}.`
    const operationRequest = 'Report the completed approved operation.'
    const factRequest = 'Report the current incident owner.'
    const userRequest = mixed ? `${operationRequest} ${factRequest}` : operationRequest
    const plan = mixed
      ? `<wiki-request-plan>${JSON.stringify({
          facets: [
            { start: 0, end: operationRequest.length, quote: operationRequest, coverage: 'source' },
            { start: operationRequest.length + 1, end: userRequest.length, quote: factRequest, coverage: 'source' }
          ]
        })}</wiki-request-plan>`
      : ''
    let collectionTurns = 0
    let activeSummaryAccepted = false
    const summaries: Readonly<AxChatRequest>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
      if (synthesisInputFromRequest(input) !== undefined)
        return response(
          synthesisFixtureAnswer(input, {
            claims: [],
            observations: [statusLine, resultLine],
            unresolvedFacets: mixed ? [1] : []
          }),
          100,
          10
        )
      if ((input.functions?.length ?? 0) === 0) {
        summaries.push(input)
        // Deliberately omit all operation identity and status from model memory.
        return response('Earlier planning and discovery steps are summarized.', 100, 10)
      }
      collectionTurns++
      if (!activeSummaryAccepted)
        return {
          ...response('', 100, 900),
          results: [
            {
              index: 0,
              content: `${collectionTurns === 1 ? plan : ''}${'Planning notes remain provisional. '.repeat(120)}`,
              functionCalls: [
                {
                  id: `discovery-${collectionTurns}`,
                  type: 'function',
                  function: { name: AGENT_TOOL_NAMES['pages.search'], params: '{"query":"duplicate check"}' }
                }
              ]
            }
          ]
        }
      return {
        ...response('', 100, 10),
        results: [{ index: 0, functionCalls: [{ id: 'finish', type: 'function', function: { name: 'wiki_finish_collection', params: '{}' } }] }]
      }
    })
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.search',
            title: 'Search',
            description: 'Find candidates',
            parameters: { type: 'object', properties: {} },
            risk: 'read',
            group: 'core'
          },
          {
            name: 'pages.applyProposal',
            title: 'Apply',
            description: 'Apply approved proposal',
            parameters: { type: 'object', properties: {} },
            risk: 'reversible-write',
            group: 'authoring',
            capability: ACTION_CATALOG['pages.applyProposal'].capability
          }
        ],
        invoke: async () => ({ results: [], suggestions: [], totalInWindow: 0, windowLimit: 250, windowTruncated: false, nextOffset: null }),
        snapshot: async () => ({}),
        close: () => undefined
      })
    }
    const { factory } = factoryFor(chat)
    const text = vi.fn(async (_delta: string) => {})
    const event = vi.fn(async (type: string, data: unknown) => {
      if (
        type === 'model.turn' &&
        typeof data === 'object' &&
        data !== null &&
        Reflect.get(data, 'outcome') === 'context_compacted' &&
        Reflect.get(Reflect.get(data, 'compaction') ?? {}, 'scope') === 'active'
      )
        activeSummaryAccepted = true
    })
    // Keep authorized history intact while bounded collector batches fill the
    // remaining space. A huge single response would hit result admission first,
    // testing recovery after omission instead of receipt retention.
    const base = engineRequest([
      { role: 'assistant', content: 'Authorized earlier planning context. '.repeat(2200) },
      { role: 'user', content: userRequest }
    ])
    const result = await new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
      {
        ...base,
        run: { ...base.run, executionMode: 'agent', googleSearchEnabled: false },
        recoveredAction: {
          actionCallId: 'completed-apply',
          actionName: 'pages.applyProposal',
          actionInput: { proposalId, approvalId: '00000000-0000-4000-8000-000000000202' },
          output: receipt
        },
        limits: { maxTurns: 12, maxToolCalls: 12, maxOutputTokens: 1_024, maxTokens: 1_000_000 }
      },
      { text, event }
    )
    expect(summaries.some(input => JSON.stringify(input).includes(proposalId))).toBe(true)
    expect(
      event.mock.calls.some(
        ([type, data]) => type === 'model.turn' && typeof data === 'object' && data !== null && Reflect.get(data, 'outcome') === 'context_compacted'
      )
    ).toBe(true)
    expect(
      event.mock.calls.some(([type, data]) => type === 'tool.completed' && typeof data === 'object' && data !== null && Reflect.has(data, 'contextExclusion'))
    ).toBe(false)
    const published = text.mock.calls.map(([delta]) => delta).join('')
    expect(published).toContain(resultLine)
    expect(published).not.toContain('Earlier planning and discovery')
    expect(result.citations).toBeUndefined()
    if (mixed) {
      expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'partial' })
      expect(published).toContain('current incident owner')
    } else expect(result.executionLimit).toBeUndefined()
  })

  it.each(['collector planning', 'active summary'] as const)('fails closed before reusing receipt-derived %s after page read revocation', async boundary => {
    const proposalId = '00000000-0000-4000-8000-000000000211'
    const page = {
      id: 731,
      locale: 'en',
      path: 'private/revoked-create',
      title: 'Revoked creation identity',
      description: '',
      contentType: 'markdown',
      knowledge: null,
      sourceRevision: '1'
    }
    const receipt = { proposalId, status: 'applied', resultHash: 'a'.repeat(64), page }
    const summary = `The approved operation created ${JSON.stringify(page)}.`
    let readable = true
    let activeSummaryAccepted = false
    let collectorTurns = 0
    const egressAfterRevocation: Readonly<AxChatRequest>[] = []
    const summaries: Readonly<AxChatRequest>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
      if (!readable) egressAfterRevocation.push(input)
      if ((input.functions?.length ?? 0) === 0) {
        summaries.push(input)
        return response(summary, 100, 10)
      }
      collectorTurns++
      if (boundary === 'collector planning') readable = false
      return {
        ...response('', 100, 900),
        results: [
          {
            index: 0,
            content: `${summary}\n${'Provisional planning notes. '.repeat(150)}`,
            functionCalls: [
              {
                id: `discover-${collectorTurns}`,
                type: 'function',
                function: { name: AGENT_TOOL_NAMES['pages.search'], params: '{"query":"duplicate check"}' }
              }
            ]
          }
        ]
      }
    })
    const validateObservation = vi.fn(
      async (actionName: string, output: unknown) =>
        actionName !== 'pages.applyProposal' || readable || (typeof output === 'object' && output !== null && Reflect.get(output, 'page') === null)
    )
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.search',
            title: 'Search',
            description: 'Find candidates',
            parameters: { type: 'object', properties: {} },
            risk: 'read',
            group: 'core'
          },
          {
            name: 'pages.applyProposal',
            title: 'Apply',
            description: 'Apply approved proposal',
            parameters: { type: 'object', properties: {} },
            risk: ACTION_CATALOG['pages.applyProposal'].descriptor.risk,
            group: 'authoring',
            capability: ACTION_CATALOG['pages.applyProposal'].capability
          }
        ],
        invoke: async () => ({ results: [], suggestions: [], totalInWindow: 0, windowLimit: 250, windowTruncated: false, nextOffset: null }),
        validateObservation,
        snapshot: async () => ({}),
        close: () => undefined
      })
    }
    const { factory } = factoryFor(chat)
    const text = vi.fn(async (_delta: string) => {})
    const base = engineRequest([
      { role: 'assistant', content: 'Authorized earlier planning context. '.repeat(2200) },
      { role: 'user', content: 'Report the completed approved operation after checking for duplicates.' }
    ])
    const failure = await new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders })
      .execute(
        {
          ...base,
          run: { ...base.run, executionMode: 'agent', googleSearchEnabled: false },
          recoveredAction: {
            actionCallId: 'completed-apply',
            actionName: 'pages.applyProposal',
            actionInput: { proposalId, approvalId: '00000000-0000-4000-8000-000000000212' },
            output: receipt
          },
          limits: { maxTurns: 12, maxToolCalls: 12, maxOutputTokens: 1_024, maxTokens: 1_000_000 }
        },
        {
          text,
          event: async (type, data) => {
            if (
              type !== 'model.turn' ||
              typeof data !== 'object' ||
              data === null ||
              Reflect.get(data, 'outcome') !== 'context_compacted' ||
              Reflect.get(Reflect.get(data, 'compaction') ?? {}, 'scope') !== 'active'
            )
              return
            expect(Reflect.get(data, 'content')).toBe(summary)
            activeSummaryAccepted = true
            readable = false
          }
        }
      )
      .then(() => null, safeExecutionFailure)
    expect(failure?.code).toBe('AGENT_EVIDENCE_INVALID')
    expect(failure?.status).toBe(409)
    expect(activeSummaryAccepted).toBe(boundary === 'active summary')
    if (boundary === 'active summary') expect(summaries.some(input => JSON.stringify(input).includes(page.path))).toBe(true)
    else expect(summaries).toEqual([])
    expect(validateObservation).toHaveBeenCalledWith('pages.applyProposal', receipt, base.signal)
    expect(egressAfterRevocation).toEqual([])
    expect(text).not.toHaveBeenCalled()
  })

  it('reauthorizes applied page identity before the post-read synthesis native-count preflight', async () => {
    const receipt = {
      proposalId: '00000000-0000-4000-8000-000000000221',
      status: 'applied',
      resultHash: 'b'.repeat(64),
      page: {
        id: 731,
        locale: 'en',
        path: 'private/applied-result',
        title: 'Applied result',
        description: '',
        contentType: 'markdown',
        knowledge: null,
        sourceRevision: '1'
      }
    }
    const source = {
      id: 1,
      locale: 'en',
      path: 'suppliers',
      title: 'Supplier routing',
      sourceRevision: '2',
      contentType: 'markdown',
      content: `# Supplier routing\n\n${'v'.repeat(150_000)}\n\nCedar warehouse closes at 18:30 on Fridays.`,
      citation: { evidenceId: 'page:1:revision:2', label: 'Supplier routing', href: '/en/suppliers' },
      citationSections: []
    }
    let receiptReadable = true
    let sourceReturned = false
    let preflightProviderOpened = false
    let admissionRevokedReceipt = false
    const applicationValidations: boolean[] = []
    const sourceValidations: boolean[] = []
    const validateObservation = vi.fn(async (actionName: string) => {
      if (actionName === 'pages.applyProposal') {
        applicationValidations.push(receiptReadable)
        return receiptReadable
      }
      sourceValidations.push(true)
      return true
    })
    const invoke = vi.fn(async () => {
      sourceReturned = true
      return source
    })
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.get',
            title: 'Read page',
            description: 'Read source',
            parameters: { type: 'object', properties: { id: { type: 'number' } } },
            risk: 'read',
            group: 'core'
          },
          {
            name: 'pages.applyProposal',
            title: 'Apply',
            description: 'Apply approved proposal',
            parameters: { type: 'object', properties: {} },
            risk: 'reversible-write',
            group: 'authoring',
            capability: ACTION_CATALOG['pages.applyProposal'].capability
          }
        ],
        invoke,
        validateObservation,
        snapshot: async () => ({}),
        close: () => undefined
      })
    }
    const generated: Readonly<AxChatRequest>[] = []
    const counted: Readonly<AxChatRequest>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
      generated.push(input)
      return {
        ...response('', 100, 10),
        results: [
          {
            index: 0,
            functionCalls: [
              {
                id: 'supplier-read',
                type: 'function',
                function: { name: AGENT_TOOL_NAMES['pages.get'], params: '{"id":1}' }
              }
            ]
          }
        ]
      }
    })
    const countContextTokens = vi.fn(async (input: Readonly<AxChatRequest>) => {
      counted.push(input)
      return 10_000
    })
    const factory = {
      create: async (_versionId: string, options?: { readonly purpose?: string }) => {
        if (sourceReturned && options?.purpose === 'agent') preflightProviderOpened = true
        return { ...profile, countContextTokens, service: fullAxFixtureService(chat) }
      }
    } as unknown as AgentProviderFactory
    const text = vi.fn(async (_delta: string) => {})
    const base = engineRequest([{ role: 'user', content: 'Report the applied operation and when Cedar warehouse closes on Fridays.' }])
    const failure = await new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders })
      .execute(
        {
          ...base,
          run: { ...base.run, executionMode: 'agent', googleSearchEnabled: false },
          recoveredAction: {
            actionCallId: 'completed-apply',
            actionName: 'pages.applyProposal',
            actionInput: { proposalId: receipt.proposalId, approvalId: '00000000-0000-4000-8000-000000000222' },
            output: receipt
          },
          authorizeDispatch: async () => {
            await Promise.resolve()
            if (preflightProviderOpened) {
              receiptReadable = false
              admissionRevokedReceipt = true
            }
          },
          dispatchBudget: sequencedBudget(1_000_000)
        },
        { text, event: async () => {} }
      )
      .then(() => null, safeExecutionFailure)
    expect(failure?.code).toBe('AGENT_EVIDENCE_INVALID')
    expect(failure?.status).toBe(409)
    expect(preflightProviderOpened).toBe(true)
    expect(admissionRevokedReceipt).toBe(true)
    expect(sourceValidations).toContain(true)
    expect(applicationValidations).toContain(true)
    expect(applicationValidations).toContain(false)
    expect(invoke).toHaveBeenCalledOnce()
    expect(counted.filter(input => synthesisInputFromRequest(input) !== undefined)).toEqual([])
    expect(generated.filter(input => synthesisInputFromRequest(input) !== undefined)).toEqual([])
    expect(text).not.toHaveBeenCalled()
  })

  it.each(['native count', 'typed generation', 'ordinary generation'] as const)(
    'rechecks original page authority after awaited admission before %s egress',
    async boundary => {
      const fact = 'Cedar warehouse closes at 18:30 on Fridays.'
      const content = `# Supplier routing\n\n${boundary === 'ordinary generation' ? '' : 'v'.repeat(150_000)}\n\n${fact}`
      const page = {
        id: 1,
        locale: 'en',
        path: 'suppliers',
        title: 'Supplier routing',
        sourceRevision: '2',
        contentType: 'markdown',
        content,
        citation: { evidenceId: 'page:1:revision:2', label: 'Supplier routing', href: '/en/suppliers' },
        citationSections: []
      }
      let readable = true
      let directReadReturned = false
      const dispatched: { readonly input: Readonly<AxChatRequest>; readonly readable: boolean }[] = []
      const counted: { readonly input: Readonly<AxChatRequest>; readonly readable: boolean }[] = []
      const validations: boolean[] = []
      const validateObservation = vi.fn(async () => {
        validations.push(readable)
        return readable
      })
      const invoke = vi.fn(async () => {
        directReadReturned = true
        return page
      })
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [
            {
              name: 'pages.get',
              title: 'Read page',
              description: 'Read source',
              parameters: { type: 'object', properties: { id: { type: 'number' } } },
              risk: 'read',
              group: 'core'
            }
          ],
          invoke,
          validateObservation,
          snapshot: async () => ({}),
          close: () => undefined
        })
      }
      const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
        dispatched.push({ input, readable })
        if (synthesisInputFromRequest(input) !== undefined) {
          const source = synthesisSourcesFromRequest(input).find(unit => unit.text.includes(fact))!
          return response(synthesisFixtureAnswer(input, { claims: [{ ...source, statement: fact }] }), 100, 10)
        }
        if (boundary === 'ordinary generation' && !directReadReturned)
          return {
            ...response('', 100, 10),
            results: [
              {
                index: 0,
                functionCalls: [
                  {
                    id: 'cedar-read',
                    type: 'function',
                    function: { name: 'wiki_get_page', params: '{"id":1}' }
                  }
                ]
              }
            ]
          }
        return {
          ...response('', 100, 10),
          results: [
            {
              index: 0,
              functionCalls: [
                {
                  id: 'cedar-finish',
                  type: 'function',
                  function: { name: 'wiki_finish_collection', params: '{}' }
                }
              ]
            }
          ]
        }
      })
      const countContextTokens = vi.fn(async (input: Readonly<AxChatRequest>) => {
        counted.push({ input, readable })
        await Promise.resolve()
        if (boundary === 'typed generation' && synthesisInputFromRequest(input) !== undefined) readable = false
        return 10_000
      })
      const factory = {
        create: async () => ({ ...profile, countContextTokens, service: fullAxFixtureService(chat) })
      } as unknown as AgentProviderFactory
      const text = vi.fn(async (_delta: string) => {})
      const base = engineRequest([{ role: 'user', content: 'When does Cedar warehouse close on Fridays?' }])
      await expect(
        new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
          {
            ...base,
            run: { ...base.run, executionMode: 'agent' },
            ...(boundary === 'ordinary generation'
              ? {}
              : {
                  retainedPageReads: [{ actionCallId: 'prior-supplier-read', actionName: 'pages.get' as const, output: page }]
                }),
            // A retained complete read can answer in one turn; do not require a
            // collection loop before its real typed/count admission boundary.
            ...(boundary === 'native count' ? { limits: { ...base.limits, maxTurns: 1 } } : {}),
            authorizeDispatch: async () => {
              await Promise.resolve()
              if (boundary === 'native count' || (boundary === 'ordinary generation' && directReadReturned)) readable = false
            },
            dispatchBudget: sequencedBudget(1_000_000)
          },
          { text, event: async () => {} }
        )
      ).rejects.toMatchObject({ code: 'AGENT_EVIDENCE_INVALID' })
      expect(readable).toBe(false)
      expect(validations).toContain(true)
      expect(validations).toContain(false)
      expect(dispatched.every(dispatch => dispatch.readable)).toBe(true)
      expect(dispatched.filter(dispatch => synthesisInputFromRequest(dispatch.input) !== undefined)).toEqual([])
      if (boundary === 'native count') expect(counted.filter(count => synthesisInputFromRequest(count.input) !== undefined)).toEqual([])
      if (boundary === 'typed generation') expect(counted.some(count => synthesisInputFromRequest(count.input) !== undefined && count.readable)).toBe(true)
      expect(visibleWikiText(text.mock.calls.flat().join(''))).not.toContain(fact)
      expect(invoke).toHaveBeenCalledTimes(boundary === 'ordinary generation' ? 1 : 0)
    }
  )

  it('rechecks a subagent original read after awaited admission before sending its active transcript to the summarizer', async () => {
    const fact = 'Supplier 1 requires its own receipt.'
    const page = {
      id: 1,
      locale: 'en',
      path: 'suppliers-1',
      title: 'Supplier 1',
      sourceRevision: '2',
      contentType: 'markdown',
      content: `# Supplier 1\n\n${fact}\n\n${'Storage rules for supplier 1. '.repeat(1400)}`,
      citation: { evidenceId: 'page:1:revision:2', label: 'Supplier 1', href: '/en/suppliers-1' },
      citationSections: []
    }
    let readable = true
    let readCount = 0
    let collectionTurns = 0
    let collectionFinished = false
    let compactionAdmitted = false
    const validations: boolean[] = []
    const dispatched: { readonly input: Readonly<AxChatRequest>; readonly readable: boolean }[] = []
    const summaryRequests: Readonly<AxChatRequest>[] = []
    const validateObservation = vi.fn(async () => {
      validations.push(readable)
      return readable
    })
    const invoke = vi.fn(async (name: string) => {
      if (name === 'pages.get') {
        readCount++
        return page
      }
      return { results: [] }
    })
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.get',
            title: 'Read page',
            description: 'Read source',
            parameters: { type: 'object', properties: { id: { type: 'number' } } },
            risk: 'read',
            group: 'core'
          },
          {
            name: 'pages.search',
            title: 'Search pages',
            description: 'Check current supplier candidates',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
            risk: 'read',
            group: 'core'
          }
        ],
        invoke,
        validateObservation,
        snapshot: async () => ({}),
        close: () => undefined
      })
    }
    const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
      dispatched.push({ input, readable })
      if (synthesisInputFromRequest(input) !== undefined) {
        const source = synthesisSourcesFromRequest(input).find(unit => unit.evidenceId === page.citation.evidenceId && unit.text.includes(fact))
        return response(
          synthesisFixtureAnswer(input, {
            claims: source === undefined ? [] : [{ ...source, statement: fact }],
            unresolvedFacets: source === undefined ? [0] : []
          }),
          100,
          10
        )
      }
      if ((input.functions?.length ?? 0) === 0 && synthesisInputFromRequest(input) === undefined) {
        summaryRequests.push(input)
        return response('Retain all supplier receipt requirements and their original source restrictions.', 100, 10)
      }
      collectionTurns++
      if (collectionTurns <= 3)
        return {
          ...response('', 100, 10),
          results: [
            {
              index: 0,
              content: 'Inspection planning notes remain provisional. '.repeat(collectionTurns === 1 ? 20 : 800),
              functionCalls: [
                {
                  id: `supplier-collection-${collectionTurns}`,
                  type: 'function',
                  function:
                    collectionTurns === 1
                      ? { name: 'wiki_get_page', params: '{"id":1}' }
                      : { name: AGENT_TOOL_NAMES['pages.search'], params: '{"query":"supplier receipt requirements"}' }
                }
              ]
            }
          ]
        }
      collectionFinished = true
      return {
        ...response('', 100, 10),
        results: [
          {
            index: 0,
            functionCalls: [
              {
                id: 'suppliers-finish',
                type: 'function',
                function: { name: 'wiki_finish_collection', params: '{}' }
              }
            ]
          }
        ]
      }
    })
    const factory = {
      create: async () => ({ ...profile, service: fullAxFixtureService(chat) })
    } as unknown as AgentProviderFactory
    const underlyingBudget = sequencedBudget(1_000_000)
    const budget: AgentDispatchBudget = {
      reserveSequence: async maximum => {
        const sequence = await underlyingBudget.reserveSequence!(maximum)
        // Before finish, this scoped admission funds active-transcript
        // compaction, not the subsequent typed publication sequence.
        if (!collectionFinished && readCount > 0) {
          compactionAdmitted = true
          await Promise.resolve()
          readable = false
        }
        return sequence
      },
      reserve: underlyingBudget.reserve,
      reconcile: underlyingBudget.reconcile,
      release: underlyingBudget.release,
      consumeTool: underlyingBudget.consumeTool,
      get unsettledExposure() {
        return underlyingBudget.unsettledExposure
      }
    }
    const text = vi.fn(async (_delta: string) => {})
    const base = engineRequest([{ role: 'user', content: 'Read supplier page 1, check current supplier candidates, and report its receipt requirement.' }])
    const containsRawRead = (value: unknown): boolean => {
      if (typeof value === 'string') {
        if (value.includes(page.content)) return true
        try {
          return containsRawRead(JSON.parse(value))
        } catch {
          return false
        }
      }
      if (Array.isArray(value)) return value.some(containsRawRead)
      return value !== null && typeof value === 'object' && Object.values(value).some(containsRawRead)
    }
    let result: AgentEngineResult | undefined
    try {
      result = await new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
        {
          ...base,
          purpose: 'subagent',
          run: { ...base.run, executionMode: 'agent' },
          limits: { ...base.limits, maxTurns: 8 },
          dispatchBudget: budget
        },
        { text, event: async () => {} }
      )
    } catch (error) {
      expect(error).toMatchObject({ code: 'AGENT_EVIDENCE_INVALID' })
    }
    expect(compactionAdmitted).toBe(true)
    expect(readCount).toBe(1)
    expect(validations).toContain(true)
    expect(validations).toContain(false)
    expect(dispatched.some(dispatch => dispatch.readable && containsRawRead(dispatch.input.chatPrompt))).toBe(true)
    expect(dispatched.some(dispatch => !dispatch.readable && containsRawRead(dispatch.input.chatPrompt))).toBe(false)
    expect(summaryRequests.some(input => containsRawRead(input.chatPrompt))).toBe(false)
    expect(visibleWikiText(text.mock.calls.flat().join(''))).not.toContain(fact)
    expect(result?.citations).toBeUndefined()
  })

  it.each([
    [40_000, 10_000, 'real soft history compaction'],
    [150_000, 10_000, 'mandatory verification capacity refusal'],
    [150_000, 128_000, 'native capacity refusal']
  ] as const)(
    'retains a complete prior read under ordinary history pressure (%s chars, %s native tokens, %s)',
    async (sourceCharacters, nativeInputTokens, route) => {
      const fact = 'Cedar warehouse closes at 18:30 on Fridays.'
      const unaskedFact = 'Falcon dispatch requires a signed manifest.'
      const content = `# Supplier routing\n\n${unaskedFact}\n\nRequired complete source background: ${'v'.repeat(sourceCharacters)}\n\n## Cedar warehouse\n\n${fact}`
      const page = {
        id: 1,
        locale: 'en',
        path: 'suppliers',
        title: 'Supplier routing',
        sourceRevision: '2',
        contentType: 'markdown',
        content,
        citation: { evidenceId: 'page:1:revision:2', label: 'Supplier routing', href: '/en/suppliers' },
        citationSections: []
      }
      const history = canonicalMessages([
        { role: 'user', content: `OLD_FALCON_LOOKUP:${'a'.repeat(40_000)}` },
        { role: 'assistant', content: `OLD_FALCON_ANSWER:${'b'.repeat(40_000)}` },
        { role: 'user', content: `TAIL_CONSTRAINT:${'c'.repeat(8_000)}` },
        { role: 'assistant', content: `TAIL_DECISION:${'d'.repeat(8_000)}` },
        { role: 'user', content: 'And when does Cedar warehouse close on Fridays?' }
      ])
      let historyCompacted = false
      const summaries: Readonly<AxChatRequest>[] = []
      const typedDeliveries: { readonly input: Readonly<AxChatRequest>; readonly historyCompacted: boolean }[] = []
      const counted: Readonly<AxChatRequest>[] = []
      const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
        if ((input.functions?.length ?? 0) === 0 && synthesisInputFromRequest(input) === undefined) {
          summaries.push(input)
          return response('Retain the Cedar followup and original supplier constraints.', 100, 10)
        }
        if (synthesisInputFromRequest(input) === undefined)
          return {
            ...response('', 100, 10),
            results: [
              {
                index: 0,
                functionCalls: [
                  { id: 'cached-cedar-read', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } },
                  { id: 'cedar-finish', type: 'function', function: { name: 'wiki_finish_collection', params: '{}' } }
                ]
              }
            ]
          }
        typedDeliveries.push({ input, historyCompacted })
        const source = synthesisSourcesFromRequest(input).find(unit => unit.evidenceId === page.citation.evidenceId && unit.text.includes(fact))
        if (source === undefined) throw new Error('The complete retained original must remain eligible for fresh typed delivery')
        return response(synthesisFixtureAnswer(input, { claims: [{ ...source, statement: fact }] }), 100, 10)
      })
      const countContextTokens = vi.fn(async (input: Readonly<AxChatRequest>) => {
        counted.push(input)
        return nativeInputTokens
      })
      const factory = {
        create: async () => ({ ...profile, countContextTokens, service: fullAxFixtureService(chat) })
      } as unknown as AgentProviderFactory
      const invoke = vi.fn(async () => {
        throw new Error('A validated complete prior read must not fetch the page again')
      })
      const validateObservation = vi.fn(async () => true)
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [
            {
              name: 'pages.get',
              title: 'Read page',
              description: 'Read source',
              parameters: { type: 'object', properties: { id: { type: 'number' } } },
              risk: 'read',
              group: 'core'
            }
          ],
          invoke,
          validateObservation,
          snapshot: async () => ({}),
          close: () => undefined
        })
      }
      const text = vi.fn(async (_delta: string) => {})
      const base = engineRequest(history.messages)
      const budget = sequencedBudget(1_000_000)
      const execution = new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
        {
          ...base,
          run: { ...base.run, executionMode: 'agent' },
          retainedPageReads: [{ actionCallId: 'prior-supplier-read', actionName: 'pages.get', output: page }],
          compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null },
          dispatchBudget: budget
        },
        {
          text,
          event: async () => {},
          commitCompaction: async () => {
            historyCompacted = true
          }
        }
      )
      if (route === 'native capacity refusal') {
        await expect(execution).rejects.toMatchObject({ code: 'AGENT_CONTEXT_TOO_LARGE' })
        expect(typedDeliveries).toEqual([])
        expect(counted.some(input => synthesisReadsFromRequest(input).some(read => read.readText === content))).toBe(true)
        expect(invoke).not.toHaveBeenCalled()
        expect(text.mock.calls).toEqual([])
        expect(budget.consumed()).toBe(chat.mock.calls.length * 110)
        expect(budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
        return
      }
      const result = await execution
      expect(invoke).not.toHaveBeenCalled()
      expect(typedDeliveries.length).toBeGreaterThan(0)
      for (const delivery of typedDeliveries)
        expect(synthesisReadsFromRequest(delivery.input)).toEqual([
          expect.objectContaining({ evidenceId: page.citation.evidenceId, complete: true, readText: content })
        ])
      if (route === 'mandatory verification capacity refusal') {
        expect(counted.some(input => synthesisReadsFromRequest(input).some(read => read.readText === content))).toBe(true)
        const published = text.mock.calls.flat().join('')
        expect(visibleWikiText(published)).not.toContain(fact)
        expect(visibleWikiText(published)).not.toContain(unaskedFact)
        expect(published).not.toContain('[[cite:')
        expect(result.citations).toBeUndefined()
        expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
        expect(result.totalTokens).toBe(chat.mock.calls.length * 110)
        expect(budget.consumed()).toBe(result.totalTokens)
        expect(budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
        return
      }
      expect(
        summaries.some(input =>
          input.chatPrompt.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('OLD_FALCON_LOOKUP:'))
        )
      ).toBe(true)
      expect(typedDeliveries.every(delivery => delivery.historyCompacted)).toBe(true)
      const published = text.mock.calls.flat().join('')
      expect(visibleWikiText(published)).toContain(fact)
      expect(visibleWikiText(published)).not.toContain(unaskedFact)
      expect(published).toContain(`[[cite:${page.citation.evidenceId}]]`)
      expect(result.citations).toEqual([expect.objectContaining({ evidenceId: page.citation.evidenceId })])
      expect(result.executionLimit).toBeUndefined()
    }
  )

  it('retains exact source eligibility after old-history compaction and counts changed correction context without fake turns', async () => {
    const history = canonicalMessages([
      { role: 'user', content: `OLDEST_CONTACT_CONSTRAINT:${'a'.repeat(40_000)}` },
      { role: 'assistant', content: `OLDEST_CONTACT_DECISION:${'b'.repeat(40_000)}` },
      { role: 'user', content: `TAIL_CONTACT_CONSTRAINT:${'c'.repeat(8_000)}` },
      { role: 'assistant', content: `TAIL_CONTACT_DECISION:${'d'.repeat(8_000)}` },
      { role: 'user', content: 'Who is our Falcon contact?' }
    ])
    const originals = structuredClone(history.messages)
    const contact = 'Morgan Vale is the Falcon account representative.'
    // Keep the complete read admissible to the mandatory independent proof;
    // the old-history fixture, not an oversized proof request, triggers compaction.
    const background = 'v'.repeat(110_000)
    const content = `# Supplier routing\n\nRequired complete source background: ${background}\n\n## Falcon\n\n${contact}`
    const summaries: Readonly<AxChatRequest>[] = []
    const deliveries: { readonly input: Readonly<AxChatRequest>; readonly historyCompacted: boolean }[] = []
    let historyCompacted = false
    const counted: Readonly<AxChatRequest>[] = []
    const countContextTokens = vi.fn(async (input: Readonly<AxChatRequest>, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      counted.push(input)
      expect(input.responseFormat ?? input.functions).toBeDefined()
      expect(JSON.stringify(input)).toContain(background)
      return 10_000
    })
    const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
      if ((input.functions?.length ?? 0) === 0 && synthesisInputFromRequest(input) === undefined) {
        summaries.push(input)
        return response('Retain the original supplier constraints and the current contact lookup.', 100, 10)
      }
      if (synthesisInputFromRequest(input) === undefined)
        return {
          ...response('', 100, 10),
          results: [
            {
              index: 0,
              functionCalls: [
                { id: 'contact-read', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } },
                { id: 'contact-finish', type: 'function', function: { name: 'wiki_finish_collection', params: '{}' } }
              ]
            }
          ]
        }
      deliveries.push({ input, historyCompacted })
      const source = synthesisSourcesFromRequest(input).find(unit => unit.text.includes(contact))
      if (source === undefined) throw new Error('The complete original contact must remain selectable after history compaction')
      return response(
        synthesisFixtureAnswer(input, {
          claims: [
            {
              evidenceId: source.evidenceId,
              sourceRevision: source.sourceRevision,
              sourceRef: source.sourceRef,
              statement: deliveries.length === 1 ? 'Morgan Vale is the Falcon chief financial officer.' : contact
            }
          ],
          unresolvedFacets: []
        }),
        100,
        10
      )
    })
    const factory = {
      create: async () => ({ ...profile, countContextTokens, service: fullAxFixtureService(chat) })
    } as unknown as AgentProviderFactory
    const invoke = vi.fn(async () => ({
      id: 1,
      locale: 'en',
      path: 'suppliers',
      title: 'Supplier routing',
      sourceRevision: '2',
      contentType: 'markdown',
      content,
      citation: { evidenceId: 'page:1:revision:2', label: 'Supplier routing', href: '/en/suppliers' },
      citationSections: []
    }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          { name: 'pages.get', title: 'Read page', description: 'Read source', parameters: { type: 'object', properties: {} }, risk: 'read', group: 'core' }
        ],
        invoke,
        snapshot: async () => ({}),
        close: () => {},
        validateObservation: async () => true
      })
    }
    const commitCompaction = vi.fn(async (_receipt: AgentCompactionReceipt) => {
      historyCompacted = true
    })
    const text = vi.fn(async (_delta: string) => {})
    const event = vi.fn(async (_type: string, _data: unknown) => {})
    const budget = sequencedBudget(1_000_000)
    const base = engineRequest(history.messages)
    const result = await new AxAgentEngine(factory, actions, undefined, {
      decisionProviders: rejectFixtureStatements(['Morgan Vale is the Falcon chief financial officer.'])
    }).execute(
      {
        ...base,
        run: { ...base.run, executionMode: 'agent' },
        memory: { user: ['Frozen routing preference'], agent: [] },
        skills: [{ id: '00000000-0000-4000-8000-000000000108', name: 'routing', skillMarkdown: 'Retain source record qualifications' }],
        compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null },
        dispatchBudget: budget
      },
      { text, event, commitCompaction }
    )
    expect(history.messages).toEqual(originals)
    expect(
      summaries.some(input =>
        input.chatPrompt.some(
          message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('OLDEST_CONTACT_CONSTRAINT:')
        )
      )
    ).toBe(true)
    expect(deliveries).toHaveLength(2)
    expect(deliveries.every(delivery => delivery.historyCompacted)).toBe(true)
    for (const delivery of deliveries)
      expect(synthesisReadsFromRequest(delivery.input)).toEqual([
        expect.objectContaining({ evidenceId: 'page:1:revision:2', complete: true, readText: content })
      ])
    expect(JSON.stringify(counted[1])).toContain('chief financial officer')
    expect(JSON.stringify(counted[0])).not.toContain('chief financial officer')
    expect(
      event.mock.calls.filter(
        ([type, data]) => type === 'model.turn' && typeof data === 'object' && data !== null && 'outcome' in data && data.outcome === 'answer_rejected'
      )
    ).toHaveLength(1)
    expect(
      event.mock.calls.filter(
        ([type, data]) => type === 'model.turn' && typeof data === 'object' && data !== null && 'outcome' in data && data.outcome === 'answer_accepted'
      )
    ).toHaveLength(1)
    expect(event.mock.calls).toContainEqual([
      'model.turn',
      expect.objectContaining({ purpose: 'verification', outcome: 'verification_completed', totalTokens: 0 })
    ])
    expect(text.mock.calls.map(([delta]) => delta).join('')).toContain('Morgan Vale')
    expect(text.mock.calls.map(([delta]) => delta).join('')).not.toContain('chief financial officer')
    expect(result.totalTokens).toBe(chat.mock.calls.length * 110)
    expect(budget.consumed()).toBe(result.totalTokens)
  })
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
    const { factory } = factoryFor(chat)
    const commitCompaction = vi.fn(async (_receipt: AgentCompactionReceipt) => {
      committed = true
    })
    const budget = sequencedBudget(300_000)
    const result = await new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
      {
        ...engineRequest(history.messages),
        compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null },
        dispatchBudget: budget
      },
      { commitCompaction, text: async () => undefined, event: async () => undefined }
    )

    expect(calls).toHaveLength(2)
    expect(calls[0]).not.toHaveProperty('functions')
    expect(JSON.stringify(calls[0])).toContain('OLDEST_USER_CONSTRAINT')
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
  const preservesPrefix = async (transportKind: 'gemini-api' | 'openai-responses' | 'anthropic-messages') => {
    const history = canonicalMessages([
      { role: 'user', content: `EARLIER_USER:${'a'.repeat(35_000)}` },
      { role: 'assistant', content: `EARLIER_REPLY:${'b'.repeat(35_000)}` },
      { role: 'user', content: `RECENT_USER:${'c'.repeat(7_000)}` },
      { role: 'assistant', content: `RECENT_REPLY:${'d'.repeat(7_000)}` },
      { role: 'user', content: 'Answer the current question.' }
    ])
    const original = structuredClone(history.messages)
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return response('Done.', 100, 10)
    })
    const factory = {
      create: vi.fn(async () => ({
        ...profile,
        transportKind,
        preserveCachePrefix: true,
        service: fullAxFixtureService(chat)
      }))
    } as unknown as AgentProviderFactory
    const engine = new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders })
    const engineInput = {
      ...engineRequest(history.messages),
      compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null }
    }
    const preflight = await engine.preflight(engineInput)
    const commitCompaction = vi.fn(async (_receipt: AgentCompactionReceipt) => {})
    const result = await engine.execute(engineInput, { commitCompaction, text: async () => {}, event: async () => {} })

    expect(preflight.admissible).toBe(true)
    expect(preflight.compactionExposure).toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(JSON.stringify(calls[0])).toContain('EARLIER_USER')
    expect(JSON.stringify(calls[0])).toContain('Answer the current question.')
    expect(commitCompaction).not.toHaveBeenCalled()
    expect(result.totalTokens).toBe(110)
    expect(history.messages).toEqual(original)
  }
  it.each(['gemini-api', 'openai-responses', 'anthropic-messages'] as const)(
    'preserves an eligible %s root prefix until the normal capacity-reserving trigger',
    preservesPrefix
  )
  it('still compacts a Gemini root above the normal trigger with its original safe follow-on', async () => {
    const history = oversizedHistory()
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return calls.length === 1 ? response('Earlier constraint and decision remain.', 100, 10) : response('Done.', 80, 5)
    })
    const factory = {
      create: vi.fn(async () => ({
        ...profile,
        preserveCachePrefix: true,
        continuationDialect: 'gemini-generate-content-v1' as const,
        service: fullAxFixtureService(chat)
      }))
    } as unknown as AgentProviderFactory
    const commitCompaction = vi.fn(async (_receipt: AgentCompactionReceipt) => {})
    const result = await new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
      { ...engineRequest(history.messages), compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null } },
      { commitCompaction, text: async () => {}, event: async () => {} }
    )
    expect(calls).toHaveLength(2)
    expect(JSON.stringify(calls[0])).toContain('OLDEST_USER_CONSTRAINT')
    expect(JSON.stringify(calls[1])).toContain('Earlier constraint and decision remain.')
    expect(commitCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        performance: { cachedInputTokensReported: null, cacheCreationInputTokensReported: null },
        inputTokens: 100,
        totalTokens: 110
      })
    )
    expect(result.totalTokens).toBe(195)
  })
  it('retains reported Gemini cache tokens on a committed summary and its follow-on answer', async () => {
    const history = oversizedHistory()
    let dispatch = 0
    const native = geminiFixtureService({
      apiKey: 'test-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-3.8-flash',
      timeoutMs: 10_000,
      fetch: (async () => {
        const summary = dispatch++ === 0
        return Response.json({
          modelVersion: 'gemini-3.8-flash',
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6, cachedContentTokenCount: summary ? 2 : 3 },
          candidates: [
            { index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text: summary ? 'Earlier constraint and decision remain.' : 'Done.' }] } }
          ]
        })
      }) as typeof fetch
    })
    const factory = {
      create: vi.fn(async () => ({
        ...profile,
        preserveCachePrefix: true,
        model: 'gemini-3.8-flash',
        transportKind: 'gemini-api' as const,
        continuationDialect: 'gemini-generate-content-v1' as const,
        service: native
      }))
    } as unknown as AgentProviderFactory
    const original = engineRequest(history.messages)
    const commitCompaction = vi.fn(async (_receipt: AgentCompactionReceipt) => {})
    const event = vi.fn(async () => {})
    const result = await new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
      {
        ...original,
        run: { ...original.run, model: 'gemini-3.8-flash', transportKind: 'gemini-api' },
        compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null }
      },
      { commitCompaction, text: async () => {}, event }
    )
    expect(dispatch).toBe(2)
    expect(commitCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 4,
        totalTokens: 6,
        performance: { cachedInputTokensReported: 2, cacheCreationInputTokensReported: null }
      })
    )
    expect(event).toHaveBeenCalledWith('model.turn', expect.objectContaining({ performance: expect.objectContaining({ cachedInputTokensReported: 3 }) }))
    expect(result).toMatchObject({ totalTokens: 12, costMicros: 16 })
  })
  it('retains complete child reads through corrected answers without selecting unrelated background for publication', async () => {
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
    let typedDrafts = 0
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      const control = synthesisCollectionControl(input)
      if (control !== undefined) return control
      if (synthesisInputFromRequest(input) === undefined) return response('Retain Alpha’s original release restriction and the bounded source scope.', 100, 10)
      const firstDraft = ++typedDrafts === 1
      return response(
        synthesisFixtureAnswer(
          input,
          firstDraft ? `Alpha release does not require a verified staging receipt. [[cite:${alphaEvidenceId}]]` : `${sourceUnit} [[cite:${alphaEvidenceId}]]`
        ),
        firstDraft ? 200 : 300,
        firstDraft ? 20 : 30
      )
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
    const event = vi.fn(async (_type: string, _data: unknown) => {})
    const result = await new AxAgentEngine(factory, actions, undefined, {
      decisionProviders: rejectFixtureStatements(['Alpha release does not require a verified staging receipt.'])
    }).execute(
      {
        ...engineRequest(history.messages),
        run: { ...engineRequest(history.messages).run, executionMode: 'agent' },
        research: { packets: [], incompleteTasks: [], evidenceSeeds },
        compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null }
      },
      { text, event }
    )

    const sourceDeliveries = calls.filter(input => synthesisInputFromRequest(input) !== undefined).map(synthesisReadsFromRequest)
    expect(sourceDeliveries.length).toBeGreaterThan(0)
    expect(sourceDeliveries.every(reads => reads.some(read => read.evidenceId === alphaEvidenceId && read.readText === alphaContent))).toBe(true)
    expect(sourceDeliveries.every(reads => reads.some(read => read.evidenceId === betaEvidenceId && read.readText === betaContent))).toBe(true)
    const published = text.mock.calls.flat().join('')
    expect(visibleWikiText(published)).not.toContain('Neutral operational background remains unchanged.')
    expect(visibleWikiText(published)).not.toContain('Beta background remains unchanged.')
    expect(visibleWikiText(published)).toContain(sourceUnit)
    expect(visibleWikiText(published)).not.toContain('Alpha release does not require a verified staging receipt.')
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)).toMatchObject([{ accepted: false }, { accepted: true }])
    expect(event.mock.calls).toContainEqual([
      'model.turn',
      expect.objectContaining({ purpose: 'verification', outcome: 'verification_completed', totalTokens: 0 })
    ])
    expect(result.citations).toEqual([{ evidenceId: alphaEvidenceId, kind: 'page', label: 'Alpha', href: '/en/alpha' }])
    expect(validateObservation).toHaveBeenCalledWith('pages.get', evidenceSeeds[0]!.output, expect.any(AbortSignal))
  })

  it.each([
    ['parent identity', '- Name: Maya Quinn{{padding}}\n  - Phone: 555-0100 x42', 'Name: Maya Quinn; Phone: 555-0100 x42'],
    [
      'required condition',
      '- Only after audit before 2026-10-15{{padding}}:\n  - Maya Quinn may approve release.',
      'Maya Quinn may approve release only after audit before 2026-10-15.'
    ],
    [
      'sibling field',
      '- Name: Maya Quinn\n  - Email: [maya@example.test](mailto:maya@example.test){{padding}}\n  - Phone: 555-0100 x42',
      'Name: Maya Quinn; Email: [maya@example.test](mailto:maya@example.test); Phone: 555-0100 x42'
    ],
    ['table header', 'Name{{padding}} | Phone\n--- | ---\nMaya Quinn | 555-0100 x42', 'Name: Maya Quinn; Phone: 555-0100 x42'],
    [
      'reference definition',
      '[maya]: mailto:maya@example.test "{{title}}"\n\n- Name: Maya Quinn\n  - Email: [maya@example.test][maya]',
      'Name: Maya Quinn; Email: [maya@example.test](mailto:maya@example.test)'
    ]
  ] as const)('adaptable compaction reentry preserves complete %s closures without borrowing omitted dependencies', async (_dependency, template, fact) => {
    for (const delivery of ['complete', 'padded', 'missing'] as const) {
      const complete = delivery !== 'missing'
      const history = canonicalMessages([
        { role: 'user', content: `OLD_CONTACT_CONSTRAINT:${'a'.repeat(40_000)}` },
        { role: 'assistant', content: `OLD_CONTACT_DECISION:${'b'.repeat(40_000)}` },
        { role: 'user', content: `TAIL_CONTEXT:${'c'.repeat(8_000)}` },
        { role: 'assistant', content: `TAIL_DECISION:${'d'.repeat(8_000)}` },
        { role: 'user', content: `Contact office lookup: what does the contact record establish about ${fact}?` }
      ])
      const citation = 'page:1:revision:rev-1'
      const answer = `${fact} [[cite:${citation}]]`
      const independentFact = 'The contact office opens at 09:00.'
      const independentAnswer = `${independentFact} [[cite:${citation}]]`
      const missingDependency: Readonly<Record<string, string>> = {
        'parent identity': '- Name: Maya Quinn',
        'required condition': '- Maya Quinn may approve release.',
        'sibling field': '- Name: Maya Quinn\n  - Phone: 555-0100 x42',
        'table header': 'Name | Contact code\n--- | ---\nMaya Quinn | 555-0100 x42',
        'reference definition': '- Name: Maya Quinn\n  - Email: [maya@example.test][maya]'
      }
      const record =
        delivery === 'missing'
          ? missingDependency[_dependency]!
          : template
              .replace('{{padding}}', delivery === 'padded' ? ` <!--${'presentational padding '.repeat(700)}-->` : '')
              .replace('{{title}}', delivery === 'padded' ? 'presentational padding '.repeat(700) : 'Contact')
      const content = `# Contacts\n\n${independentFact}\n\n${record}\n\n${'Neutral office background. '.repeat(900)}`
      const calls: Readonly<AxChatRequest<unknown>>[] = []
      const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
        calls.push(input)
        if (calls.length === 1) return response('Keep the contact lookup and exact source restrictions.', 100, 10)
        if (calls.length === 2) {
          const control = synthesisCollectionControl(input)
          if (control !== undefined) return control
        }
        const units = synthesisSourcesFromRequest(input)
        const draft =
          calls.length === 3
            ? {
                evidenceId: citation,
                sourceRevision: 'rev-1',
                sourceRef: units.find(unit => unit.text.includes('Maya Quinn'))?.sourceRef ?? 'sAAAAAAAAAAAAAAAA',
                statement: fact
              }
            : {
                evidenceId: citation,
                sourceRevision: 'rev-1',
                sourceRef: units.find(unit => unit.text.includes(independentFact))?.sourceRef ?? 'sAAAAAAAAAAAAAAAA',
                statement: independentFact
              }
        return response(synthesisFixtureAnswer(input, { claims: [draft], unresolvedFacets: calls.length === 3 ? [] : [0] }), 100, 10)
      })
      const { factory } = factoryFor(chat)
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [
            {
              name: 'pages.get',
              title: 'Read page',
              description: 'Read canonical page',
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
          validateObservation: async () => true
        })
      }
      const text = vi.fn(async (_delta: string) => {})
      const event = vi.fn(async (..._args: [string, unknown]) => {})
      const commitCompaction = vi.fn(async (_receipt: AgentCompactionReceipt) => {})
      const base = engineRequest(history.messages)
      const result = await new AxAgentEngine(factory, actions, undefined, {
        decisionProviders: delivery === 'missing' ? rejectFixtureStatements([fact]) : fixtureDecisionProviders
      }).execute(
        {
          ...base,
          run: { ...base.run, executionMode: 'agent' },
          compaction: { sourcePrefixSha256: history.prefixes, groundedExpiresAt: null },
          research: {
            packets: [],
            incompleteTasks: [],
            evidenceSeeds: [
              {
                taskId: '00000000-0000-4000-8000-000000000021',
                subagentRunId: '00000000-0000-4000-8000-000000000031',
                actionCallId: 'child-contact-read',
                actionName: 'pages.get',
                output: {
                  id: 1,
                  locale: 'en',
                  path: 'contacts',
                  sourceRevision: 'rev-1',
                  title: 'Contacts',
                  contentType: 'markdown',
                  content,
                  citation: { evidenceId: citation, label: 'Contacts', href: '/en/contacts' },
                  citationSections: []
                }
              }
            ]
          }
        },
        { text, event, commitCompaction }
      )
      expect(commitCompaction).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'context_compacted' }))
      const published = text.mock.calls.map(([delta]) => delta).join('')
      if (complete) {
        expect(synthesisReadsFromRequest(calls.at(-1)!)).toEqual([expect.objectContaining({ readText: content, complete: true })])
        expect(visibleWikiText(published)).toContain(visibleWikiText(answer))
        expect(result.citations?.map(item => item.evidenceId)).toEqual([citation])
        expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').at(-1)?.[1]).toMatchObject({ accepted: true })
      } else {
        expect(visibleWikiText(published)).not.toContain(visibleWikiText(answer))
        expect(visibleWikiText(published)).toContain(visibleWikiText(independentAnswer))
        expect(result.citations?.map(item => item.evidenceId)).toEqual([citation])
        expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').at(0)?.[1]).toMatchObject({ accepted: false })
        expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').at(-1)?.[1]).toMatchObject({ accepted: true })
      }
      expect(published).toContain(`[[cite:${citation}]]`)
    }
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
    let invalidDraftReturned = false
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      if (calls.length === 1) {
        const control = synthesisCollectionControl(input)
        if (control !== undefined) return control
      }
      if (calls.length === 2) {
        invalidDraftReturned = true
        return response(synthesisFixtureAnswer(input, `Alpha release does not require a staging receipt. [[cite:${evidenceId}]]`), 200, 20)
      }
      return response('I cannot verify Alpha’s release requirement now.', 300, 30)
    })
    const { factory } = factoryFor(chat)
    const validateObservation = vi.fn(async () => !invalidDraftReturned)
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
    const result = await new AxAgentEngine(factory, actions, undefined, {
      decisionProviders: rejectFixtureStatements(['Alpha release does not require a staging receipt.'])
    }).execute(
      {
        ...engineRequest(history.messages),
        run: { ...engineRequest(history.messages).run, executionMode: 'agent' },
        research: { packets: [], incompleteTasks: [], evidenceSeeds: [seed] }
      },
      { text, event: async () => undefined }
    )

    expect(synthesisSourcesFromRequest(calls[1]!)).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceId, text: seed.output.content })]))
    expect(calls.at(-1)?.chatPrompt.every(message => typeof message.content !== 'string' || !message.content.includes(sourceUnit))).toBe(true)
    expect(text.mock.calls.flat().join('')).not.toContain('Alpha release does not require a staging receipt.')
    expect(result.citations).toBeUndefined()
    expect(result).toMatchObject({ inputTokens: 503, outputTokens: 52, totalTokens: 555, costMicros: 607 })
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

    const result = await new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
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

    const result = await new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
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
    const result = await new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
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
        new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
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
        new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
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
      new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
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
    const result = await new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
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

  it('preserves both read sources and action authority across tool-free synthesis', async () => {
    const firstFact = 'Alpha release requires a staging receipt.'
    const secondFact = 'Beta release requires an audit receipt.'
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
      response(`${firstFact} [[cite:page:1:revision:1]]\n\n${secondFact} [[cite:page:2:revision:2]]`, 300, 20)
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      if (replies.length === 1) {
        const control = synthesisCollectionControl(input)
        if (control !== undefined) return control
      }
      const next = replies.shift()
      if (next === undefined) throw new Error('Unexpected provider request after the scripted synthesis answer')
      return {
        ...next,
        results: next.results.map(result => (result.content === undefined ? result : { ...result, content: synthesisFixtureAnswer(input, result.content) }))
      }
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
            content: id === 1 ? firstFact : secondFact,
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
    const text = vi.fn(async (_delta: string) => undefined)
    const budget = sequencedBudget(400_000)
    const result = await new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
      {
        ...base,
        run: { ...base.run, executionMode: 'agent' },
        limits: { maxTurns: 6, maxToolCalls: 4, maxOutputTokens: 8_192 },
        dispatchBudget: budget
      },
      { commitCompaction, text, event }
    )

    expect(event).not.toHaveBeenCalledWith('model.turn', expect.objectContaining({ outcome: 'context_compacted' }))
    expect(commitCompaction).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      authoritySha256: 'f'.repeat(64),
      citations: [expect.objectContaining({ evidenceId: 'page:1:revision:1' }), expect.objectContaining({ evidenceId: 'page:2:revision:2' })]
    })
    expect(result.totalTokens).toBe(645)
    expect(budget.consumed()).toBe(645)
  })
})
