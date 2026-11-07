import { axGlobals, type AxAIServiceOptions, type AxChatRequest, type AxChatResponse } from '@ax-llm/ax'
import { ProxyTracerProvider } from '@opentelemetry/api'
import { AGENT_TOOL_NAMES } from '../../../shared/agents/contracts.ts'
import { renderSafeMarkdown } from '../../../client/helpers/safe-markdown.ts'
import { AgentChildBudgetReservations, type AgentOrchestrationLimits } from '../../agents/orchestration.ts'

import { type AgentActionSessionProvider, AxAgentEngine } from '../../agents/providers/engine.ts'
import { AgentExecutionFailure } from '../../agents/providers/execution-failure.ts'
import { AgentProviderAttemptError, type AgentProviderFactory, type AgentProviderService } from '../../agents/providers/factory.ts'
import { renderWikiSynthesisAnswer, validateWikiSynthesisShape } from '../../agents/providers/wiki-synthesis.ts'
import { AgentRepositoryError } from '../../agents/repository.ts'
import type {
  AgentDispatchBudget,
  AgentDispatchBudgetReservation,
  AgentDispatchBudgetSequence,
  AgentDispatchUsage,
  AgentEngineRequest,
  AgentRetainedPageRead
} from '../../agents/runtime.ts'
import { describe, expect, it, vi } from '../bun-test.mts'

import {
  fixtureDecisionProviders,
  rejectFixtureStatements,
  fullAxFixtureService,
  synthesisFixtureAnswer,
  synthesisInputFromRequest,
  synthesisReadsFromRequest,
  synthesisSourcesFromRequest,
  synthesisObservationsFromRequest,
  type SynthesisFixtureAnswer
} from './synthesis-fixture.ts'
const pricing = { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } as const

const visibleWikiText = (content: string): string => {
  const container = document.createElement('div')
  container.innerHTML = renderSafeMarkdown(content)
  return container.textContent ?? ''
}

const run = {
  id: '00000000-0000-4000-8000-000000000001',
  sessionId: '00000000-0000-4000-8000-000000000002',
  userMessageId: '00000000-0000-4000-8000-000000000003',
  assistantMessageId: '00000000-0000-4000-8000-000000000004',
  goalId: null,
  goalContinuation: null,
  ownerId: 7,
  clientRequestId: '00000000-0000-4000-8000-000000000005',
  clientRequestSha256: 'a'.repeat(64),
  status: 'running',
  providerProfileVersionId: '00000000-0000-4000-8000-000000000006',
  transportKind: 'openai-responses',
  model: 'gpt-test',
  executionMode: 'agent',
  capabilityRevision: 'cap-1',
  pricingRevision: 'price-1',
  totalTokens: 0,
  promptVersion: 1,
  attempts: 1,
  maxAttempts: 3,
  eventSequence: 0,
  leaseOwner: 'worker',
  leaseToken: '00000000-0000-4000-8000-000000000007',
  leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  cancelRequestedAt: null,
  sideEffectsStarted: false,
  availableAt: new Date().toISOString(),
  queuedAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  completedAt: null,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostMicros: null,
  errorCode: null,
  errorMessage: null
} as const

const baseRequest = (signal: AbortSignal): AgentEngineRequest => ({
  run,
  messages: [{ role: 'user', content: 'Compare alpha and beta.' }],
  memory: { user: ['private preference'], agent: ['private note'] },
  skills: [],
  priorActivity: [],
  signal
})

const factoryFor = (
  chat: AgentProviderService['service']['chat'],
  options: {
    readonly streaming?: boolean
    readonly usage?: 'stream' | 'terminal' | 'estimated'
    readonly maxContextTokens?: number
    readonly maxOutputTokens?: number
    readonly coverage?: AgentProviderService['service']['chat']
    readonly preserveThoughtBlock?: AgentProviderService['preserveThoughtBlock']
  } = {}
): AgentProviderFactory =>
  ({
    create: async () => ({
      service: fullAxFixtureService(
        async (request, chatOptions) => {
          const response = await chat(request, chatOptions)
          if (response instanceof ReadableStream) return response
          return {
            ...response,
            results: response.results.map(result => ({
              ...result,
              ...(result.content === undefined ? {} : { content: synthesisFixtureAnswer(request, result.content) })
            }))
          }
        },
        { model: 'gpt-test', streaming: options.streaming ?? false, ...(options.coverage === undefined ? {} : { coverage: options.coverage }) }
      ),
      capabilities: {
        streaming: options.streaming ?? false,
        toolCalling: 'native',
        parallelToolCalls: true,
        structuredOutput: 'native-json-schema',
        usage: options.usage ?? 'estimated',
        cancellation: true,
        maxContextTokens: options.maxContextTokens ?? 100_000,
        maxOutputTokens: options.maxOutputTokens ?? 4_000
      },
      transportKind: 'openai-responses',
      model: 'gpt-test',
      capabilityRevision: 'cap-1',
      pricingRevision: 'price-1',
      pricing,
      preserveThoughtBlock: options.preserveThoughtBlock
    })
  }) as unknown as AgentProviderFactory
const finishCollectionResponse = {
  results: [{ index: 0, functionCalls: [{ id: 'finish-collection', type: 'function', function: { name: 'wiki_finish_collection', params: '{}' } }] }],
  modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
} satisfies AxChatResponse
const offersCollectionFinish = (request: Readonly<AxChatRequest<unknown>>): boolean =>
  request.functions?.some(fn => fn.name === 'wiki_finish_collection') ?? false

const pageEvidenceActions = (
  validateObservation?: (actionName: string, output: unknown, signal: AbortSignal) => Promise<boolean>
): AgentActionSessionProvider =>
  ({
    open: async () => ({
      functions: [
        {
          name: 'pages.get',
          title: 'Read page',
          description: 'Read canonical page evidence',
          parameters: { type: 'object', properties: {} },
          risk: 'read'
        }
      ],
      invoke: async () => {
        throw new Error('No direct page read was expected')
      },
      snapshot: async () => ({}),
      close: () => undefined,
      authoritySha256: null,
      ...(validateObservation === undefined ? {} : { validateObservation })
    })
  }) as unknown as AgentActionSessionProvider
const utf8Chunks = (value: string, maximumBytes: number): readonly string[] => {
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (current.length > 0 && currentBytes + bytes > maximumBytes) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += character
    currentBytes += bytes
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current)
  return chunks
}

const responseStream = (responses: readonly AxChatResponse[], cancel?: (reason: unknown) => Promise<void> | void): ReadableStream<AxChatResponse> => {
  let index = 0
  return new ReadableStream<AxChatResponse>(
    {
      pull(controller) {
        const response = responses[index]
        if (response === undefined) {
          controller.close()
          return
        }
        index += 1
        controller.enqueue(response)
      },
      cancel
    },
    { highWaterMark: 0 }
  )
}

describe('Ax orchestration stages', () => {
  it('preserves the private native generator tracer at the actual paid synthesis dispatch', async () => {
    const previousTracer = axGlobals.tracer
    const inheritedTracer = new ProxyTracerProvider().getTracer('inherited-engine-test')
    const paidOptions: Readonly<AxAIServiceOptions>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest>, options?: Readonly<AxAIServiceOptions>): Promise<AxChatResponse> => {
      expect(synthesisInputFromRequest(input)).toBeDefined()
      paidOptions.push(options ?? {})
      return {
        results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }), finishReason: 'stop' }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
      }
    })
    axGlobals.tracer = inheritedTracer
    try {
      await new AxAgentEngine(factoryFor(chat), undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
        { ...baseRequest(new AbortController().signal), limits: { maxTurns: 1, maxToolCalls: 0, maxOutputTokens: 512 } },
        { text: async () => {}, event: async () => {} }
      )
      expect(chat).toHaveBeenCalledOnce()
      expect(paidOptions[0]?.tracer).toBeDefined()
      expect(paidOptions[0]?.tracer).not.toBe(inheritedTracer)
      const span = paidOptions[0]!.tracer!.startSpan('paid-synthesis-privacy')
      expect(span.isRecording()).toBe(false)
      span.end()
      expect(paidOptions[0]).toMatchObject({
        debug: false,
        verbose: false,
        excludeContentFromTrace: true,
        includeRequestBodyInErrors: false
      })
    } finally {
      axGlobals.tracer = previousTracer
    }
  })

  it('honors native generator global cancellation during admission before the next paid synthesis dispatch', async () => {
    const previousSignal = axGlobals.abortSignal
    const globalAbort = new AbortController()
    const hostAbort = new AbortController()
    const authorizeDispatch = vi.fn(async () => {
      globalAbort.abort(new Error('Global synthesis cancellation'))
    })
    const chat = vi.fn(
      async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => ({
        results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }), finishReason: 'stop' }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
      })
    )
    const text = vi.fn(async () => {})
    axGlobals.abortSignal = globalAbort.signal
    try {
      const execution = new AxAgentEngine(factoryFor(chat), undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
        {
          ...baseRequest(hostAbort.signal),
          authorizeDispatch,
          limits: { maxTurns: 1, maxToolCalls: 0, maxOutputTokens: 512 }
        },
        { text, event: async () => {} }
      )
      await expect(execution).rejects.toThrow()
      expect(authorizeDispatch).toHaveBeenCalledOnce()
      expect(hostAbort.signal.aborted).toBe(false)
      expect(chat).not.toHaveBeenCalled()
      expect(text).not.toHaveBeenCalled()
    } finally {
      axGlobals.abortSignal = previousSignal
    }
  })

  it.each(['fresh', 'stale', 'changed content hash', 'expired', 'revoked', 'outside scope'] as const)(
    'reuses a complete prior read without collector acknowledgement only while current authority remains valid: %s',
    async authority => {
      const evidenceId = 'page:42:revision:1'
      const firstFact = 'Falcon dispatch requires a signed manifest.'
      const followupFact = 'Cedar warehouse closes at 18:30 on Fridays.'
      const content = [
        '# Supplier operations',
        '## Falcon dispatch',
        firstFact,
        ...Array.from({ length: 18 }, (_, index) => `## Independent rule ${index + 1}\n\nStorage zone ${index + 1} requires its own receipt.`),
        '## Cedar warehouse',
        followupFact
      ].join('\n\n')
      const page = {
        id: 42,
        locale: 'en',
        path: 'suppliers',
        title: 'Supplier operations',
        contentType: 'markdown',
        sourceRevision: '1',
        content,
        citation: { evidenceId, label: 'Supplier operations', href: '/en/suppliers' },
        citationSections: []
      }
      let followup = false
      let requestedRead = false
      let currentRevision = '1'
      let currentContent = content
      let unexpired = true
      let readable = true
      let allowedPageId = 42
      const synthesisRequests: Readonly<AxChatRequest>[] = []
      const retained: { read?: AgentRetainedPageRead } = {}
      const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
        if (synthesisInputFromRequest(input) !== undefined) {
          synthesisRequests.push(input)
          const fact = followup ? followupFact : firstFact
          const source = synthesisSourcesFromRequest(input).find(unit => unit.text.includes(fact))
          return {
            results: [
              {
                index: 0,
                content: synthesisFixtureAnswer(input, {
                  claims: source === undefined ? [] : [{ ...source, statement: fact }],
                  unresolvedFacets: source === undefined ? [0] : []
                })
              }
            ]
          }
        }
        if (requestedRead || (followup && authority !== 'fresh')) return finishCollectionResponse
        requestedRead = true
        return {
          results: [
            {
              index: 0,
              functionCalls: [
                {
                  id: followup ? 'followup-page-read' : 'initial-page-read',
                  type: 'function',
                  function: { name: 'wiki_get_page', params: { id: 42 } }
                }
              ]
            }
          ]
        }
      })
      const invoke = vi.fn(async () => page)
      const validateObservation = vi.fn(
        async (action: string, output: unknown) =>
          action === 'pages.get' &&
          typeof output === 'object' &&
          output !== null &&
          'sourceRevision' in output &&
          output.sourceRevision === currentRevision &&
          'id' in output &&
          output.id === allowedPageId &&
          readable &&
          unexpired &&
          'content' in output &&
          output.content === currentContent
      )
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [
            {
              name: 'pages.get',
              title: 'Read page',
              description: 'Read authorized page',
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
      const engine = new AxAgentEngine(factoryFor(chat), actions, undefined, { decisionProviders: fixtureDecisionProviders })
      const initialText = vi.fn(async (_delta: string) => {})
      await engine.execute(
        {
          ...baseRequest(new AbortController().signal),
          memory: { user: [], agent: [] },
          currentPage: null,
          messages: [{ role: 'user', content: 'What does Falcon dispatch require?' }]
        },
        {
          text: initialText,
          event: async (type, data) => {
            if (
              type !== 'tool.completed' ||
              typeof data !== 'object' ||
              data === null ||
              !('actionName' in data) ||
              data.actionName !== 'pages.get' ||
              !('actionCallId' in data) ||
              typeof data.actionCallId !== 'string' ||
              !('result' in data) ||
              typeof data.result !== 'string'
            )
              return
            retained.read = { actionCallId: data.actionCallId, actionName: 'pages.get', output: JSON.parse(data.result) }
          }
        }
      )
      expect(visibleWikiText(initialText.mock.calls.flat().join(''))).toContain(firstFact)
      expect(invoke).toHaveBeenCalledTimes(1)
      const retainedRead = retained.read
      if (retainedRead === undefined) throw new Error('The initial run must record its complete canonical page read')
      expect(retainedRead.output.content).toBe(content)
      followup = true
      requestedRead = true
      if (authority === 'stale') currentRevision = '2'
      if (authority === 'changed content hash') currentContent += '\n\nA changed source requirement.'
      if (authority === 'expired') unexpired = false
      if (authority === 'revoked') readable = false
      if (authority === 'outside scope') allowedPageId = 43
      const followupText = vi.fn(async (_delta: string) => {})
      const result = await engine.execute(
        {
          ...baseRequest(new AbortController().signal),
          memory: { user: [], agent: [] },
          currentPage: null,
          messages: [
            { role: 'user', content: 'What does Falcon dispatch require?' },
            { role: 'assistant', content: `${firstFact} [[cite:${evidenceId}]]` },
            { role: 'user', content: 'And when does Cedar warehouse close on Fridays?' }
          ],
          retainedPageReads: [retainedRead]
        },
        { text: followupText, event: async () => {} }
      )
      // Reusing a retained read must not invoke the page action again.
      expect(invoke).toHaveBeenCalledTimes(1)
      expect(validateObservation).toHaveBeenCalledWith('pages.get', page, expect.any(AbortSignal))
      const published = visibleWikiText(followupText.mock.calls.flat().join(''))
      const delivered = synthesisReadsFromRequest(synthesisRequests.at(-1)!)
      if (authority === 'fresh') {
        expect(published).toContain(followupFact)
        expect(published).not.toContain(firstFact)
        expect(result.citations).toEqual([expect.objectContaining({ evidenceId })])
        expect(delivered).toEqual([expect.objectContaining({ readText: content, complete: true })])
      } else {
        expect(published).not.toContain(followupFact)
        expect(result.citations).toBeUndefined()
        expect(delivered).toEqual([])
        expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
      }
    }
  )

  const publicationGateFixture = (
    mode:
      | 'provider changed after semantic'
      | 'coverage token overrun'
      | 'source changed before synthesis'
      | 'provider changed before synthesis'
      | 'native token overrun'
      | 'native receipt mismatch'
      | 'native settlement failure',
    options: { readonly dispatchBudget?: boolean; readonly maxTokens?: number; readonly coverageTokens?: number } = {}
  ) => {
    const fact = 'Falcon dispatch requires a signed manifest.'
    const page = {
      id: 42,
      locale: 'en',
      path: 'suppliers',
      title: 'Supplier operations',
      contentType: 'markdown',
      sourceRevision: '1',
      content: `# Supplier operations\n\n${fact}`,
      citation: { evidenceId: 'page:42:revision:1', label: 'Supplier operations', href: '/en/suppliers' },
      citationSections: []
    }
    let providerRevision = 1
    let sourceAuthorized = true
    const synthesized: Readonly<AxChatRequest>[] = []
    const budget = new PublicationBudgetLedger(2_000_000)
    const reserveSequence = vi.fn(budget.reserveSequence.bind(budget))
    budget.reserveSequence = reserveSequence
    const reconcile = budget.reconcile.bind(budget)
    budget.reconcile = async (reservation, actual) => {
      if (mode === 'native settlement failure' && actual.totalTokens === 9) throw new Error('Native settlement failed')
      await reconcile(reservation, actual)
    }
    const decisions: typeof fixtureDecisionProviders = {
      ...fixtureDecisionProviders,
      async selectRuntime() {
        const runtime = await fixtureDecisionProviders.selectRuntime()
        return { ...runtime, revision: providerRevision }
      },
      async decideBatch(input, dispatchOptions) {
        const result = await fixtureDecisionProviders.decideBatch(input, dispatchOptions)
        if (!mode.startsWith('native ')) return result
        const totalTokens = mode === 'native token overrun' ? (options.maxTokens ?? 2_000_000) + 1 : 9
        return {
          ...result,
          providerRevision: mode === 'native receipt mismatch' ? result.providerRevision + 1 : result.providerRevision,
          usage: { inputTokens: totalTokens - 2, outputTokens: 2, totalTokens, totalTokensSource: 'derived' },
          estimatedCostMicros: 0
        }
      }
    }
    const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
      if (synthesisInputFromRequest(input) === undefined) {
        if (mode === 'source changed before synthesis') sourceAuthorized = false
        if (mode === 'provider changed before synthesis') providerRevision++
        return finishCollectionResponse
      }
      synthesized.push(input)
      const source = synthesisSourcesFromRequest(input).find(source => source.evidenceId === page.citation.evidenceId)!
      return {
        results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [{ ...source, statement: fact }] }) }]
      }
    })
    const coverage = vi.fn(
      async (): Promise<AxChatResponse> => ({
        results: [{ index: 0, content: JSON.stringify({ verdict: 'complete', feedback: '' }), finishReason: 'stop' }],
        modelUsage: {
          ai: 'test',
          model: 'gpt-test',
          tokens: {
            promptTokens: (options.coverageTokens ?? 10) - 3,
            completionTokens: 3,
            totalTokens: options.coverageTokens ?? 10
          }
        }
      })
    )
    const text = vi.fn(async (_delta: string) => {})
    const event = vi.fn(async (type: string, data: unknown) => {
      if (
        type === 'model.turn' &&
        data !== null &&
        typeof data === 'object' &&
        'verification' in data &&
        data.verification !== null &&
        typeof data.verification === 'object' &&
        'phase' in data.verification &&
        data.verification.phase === 'semantic' &&
        mode === 'provider changed after semantic'
      )
        providerRevision++
    })
    const actions = pageEvidenceActions(async (_name, output) => sourceAuthorized && JSON.stringify(page) === JSON.stringify(output))
    const engine = new AxAgentEngine(factoryFor(chat, { maxContextTokens: 1_000_000, coverage }), actions, undefined, { decisionProviders: decisions })
    const execute = () =>
      engine.execute(
        {
          ...baseRequest(new AbortController().signal),
          memory: { user: [], agent: [] },
          currentPage: null,
          messages: [
            { role: 'user', content: 'What does Falcon dispatch require?' },
            { role: 'assistant', content: 'The previous response discussed Falcon dispatch.' },
            { role: 'user', content: 'What does it require?' }
          ],
          retainedPageReads: [{ actionCallId: 'original-falcon-read', actionName: 'pages.get', output: page }],
          ...(options.dispatchBudget === false ? {} : { dispatchBudget: budget }),
          limits: { maxTurns: 5, maxTokens: options.maxTokens ?? 2_000_000 }
        },
        { text, event }
      )
    return { execute, text, event, coverage, synthesized, budget, reserveSequence }
  }

  it.each(['source changed before synthesis', 'provider changed before synthesis'] as const)(
    'fails closed after explicit collection finish when the %s',
    async mode => {
      const fixture = publicationGateFixture(mode)
      await expect(fixture.execute()).rejects.toMatchObject({ code: mode.startsWith('provider') ? 'WIKI_VERIFICATION_FAILED' : 'AGENT_EVIDENCE_INVALID' })
      expect(fixture.synthesized).toHaveLength(0)
      expect(fixture.coverage).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
      expect(fixture.budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
    }
  )

  it('blocks the paid coverage audit and factual publication when the pinned Jev revision changes after semantic verification', async () => {
    const fixture = publicationGateFixture('provider changed after semantic')
    await expect(fixture.execute()).rejects.toMatchObject({ code: 'WIKI_VERIFICATION_FAILED' })
    expect(fixture.synthesized).toHaveLength(1)
    expect(fixture.event.mock.calls).toContainEqual([
      'model.turn',
      expect.objectContaining({
        outcome: 'verification_completed',
        verification: expect.objectContaining({
          phase: 'semantic',
          resultFrame: expect.objectContaining({ status: 'accepted', sourceScopes: ['complete-read'] })
        })
      })
    ])
    expect(fixture.coverage).not.toHaveBeenCalled()
    expect(fixture.text).not.toHaveBeenCalled()
    expect(fixture.event.mock.calls).not.toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted' })])
    expect(fixture.budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
  })

  it('retains the measured coverage receipt but blocks factual publication when aggregate tokens exceed the run limit without a dispatch budget', async () => {
    const maxTokens = 2_000_000
    const fixture = publicationGateFixture('coverage token overrun', {
      dispatchBudget: false,
      maxTokens,
      coverageTokens: maxTokens
    })
    await expect(fixture.execute()).rejects.toMatchObject({ code: 'AGENT_TOKEN_BUDGET_LIMITED' })
    expect(fixture.synthesized).toHaveLength(1)
    expect(fixture.coverage).toHaveBeenCalledOnce()
    expect(fixture.event.mock.calls).toContainEqual([
      'model.turn',
      expect.objectContaining({
        outcome: 'verification_completed',
        inputTokens: maxTokens - 3,
        outputTokens: 3,
        totalTokens: maxTokens,
        verification: expect.objectContaining({ phase: 'coverage_audit', verdict: 'complete' })
      })
    ])
    expect(fixture.text).not.toHaveBeenCalled()
    expect(fixture.event.mock.calls).not.toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted' })])
    expect(fixture.reserveSequence).not.toHaveBeenCalled()
  })

  it.each([
    ['native token overrun', 'execution_failure'],
    ['native receipt mismatch', 'receipt_rejection'],
    ['native settlement failure', 'execution_failure']
  ] as const)('records the final %s outcome rather than a premature accepted proof', async (mode, status) => {
    const fixture = publicationGateFixture(mode, { dispatchBudget: mode === 'native settlement failure' })
    await expect(fixture.execute()).rejects.toThrow()
    expect(fixture.event.mock.calls).toContainEqual([
      'model.turn',
      expect.objectContaining({
        purpose: 'verification',
        outcome: 'verification_failed',
        verification: expect.objectContaining({
          phase: 'semantic',
          resultFrame: expect.objectContaining({
            status,
            questions: [expect.objectContaining({ choice: 'supports', accepted: true })]
          })
        })
      })
    ])
    expect(fixture.coverage).not.toHaveBeenCalled()
    expect(fixture.text).not.toHaveBeenCalled()
    if (mode === 'native settlement failure') expect(fixture.budget.unsettledExposure.tokens).toBe(64_000)
  })

  it.each(['authorized', 'revoked after coverage'] as const)(
    'publishes host-scoped documentary opening and whole labelled marker only while the source remains %s',
    async authority => {
      const opening = 'Falcon dispatch requires a signed manifest. This requirement applies only to the supervised pilot.'
      const marker = 'Review marker: amber-ledger-17.'
      const definition = '[pilot-policy]: /en/pilot-policy "Pilot scope only"'
      const historicalContent = renderWikiSynthesisAnswer({
        claims: [],
        quotations: [
          {
            evidenceId: 'page:42:revision:0',
            sourceRevision: '0',
            unitId: 'read:prior-supplier',
            text: 'Earlier marker: obsolete-ledger.',
            contexts: ['Prior unverified source'],
            definitions: []
          }
        ],
        unresolvedFacets: [],
        observations: []
      })
      const historicalAssistant = Object.freeze({
        role: 'assistant' as const,
        content: historicalContent,
        providerState: { thoughtBlocks: [{ data: 'opaque-prior-reasoning', encrypted: true as const }] }
      })
      const page = {
        id: 42,
        locale: 'en',
        path: 'suppliers',
        title: 'Supplier operations',
        contentType: 'markdown',
        sourceRevision: '1',
        content: `# Pilot [scope][pilot-policy]\n\n${opening}\n\n## Review evidence\n\n- ${marker}\n\n${definition}\n`,
        citation: { evidenceId: 'page:42:revision:1', label: 'Supplier operations', href: '/en/suppliers' },
        citationSections: []
      }
      let sourceAuthorized = true
      const decisionProviders = { ...fixtureDecisionProviders, decideBatch: vi.fn(fixtureDecisionProviders.decideBatch) }
      const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
        if (synthesisInputFromRequest(input) === undefined)
          return {
            results: [
              { index: 0, functionCalls: [{ id: 'read-documentary-page', type: 'function', function: { name: 'wiki_get_page', params: '{"id":42}' } }] }
            ]
          }
        const source = synthesisSourcesFromRequest(input).find(source => source.evidenceId === page.citation.evidenceId)
        if (source === undefined) throw new Error('The quotation producer requires its admitted complete physical read')
        return {
          results: [
            {
              index: 0,
              content: JSON.stringify({
                claims: [],
                quotations: [opening, marker].map(text => ({ sourceRef: source.sourceRef, text })),
                unresolvedFacets: [],
                observations: [],
                recommendations: ''
              })
            }
          ]
        }
      })
      const coverage = vi.fn(
        async (): Promise<AxChatResponse> => ({
          results: [{ index: 0, content: JSON.stringify({ verdict: 'complete', feedback: '' }), finishReason: 'stop' }]
        })
      )
      const invoke = vi.fn(async () => page)
      const validateObservation = vi.fn(
        async (name: string, output: unknown) => name === 'pages.get' && sourceAuthorized && JSON.stringify(output) === JSON.stringify(page)
      )
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [
            { name: 'pages.get', title: 'Read page', description: 'Read canonical page evidence', parameters: { type: 'object', properties: {} }, risk: 'read' }
          ],
          invoke,
          validateObservation,
          snapshot: async () => ({}),
          close: () => {},
          authoritySha256: null
        })
      }
      const text = vi.fn(async (_delta: string) => {})
      const event = vi.fn(async (type: string, data: unknown) => {
        if (
          authority === 'revoked after coverage' &&
          type === 'model.turn' &&
          typeof data === 'object' &&
          data !== null &&
          'verification' in data &&
          typeof data.verification === 'object' &&
          data.verification !== null &&
          'phase' in data.verification &&
          data.verification.phase === 'coverage_audit'
        )
          sourceAuthorized = false
      })
      const execution = new AxAgentEngine(factoryFor(chat, { coverage }), actions, undefined, { decisionProviders }).execute(
        {
          ...baseRequest(new AbortController().signal),
          memory: { user: [], agent: [] },
          messages: [
            { role: 'user', content: 'Quote the earlier marker.' },
            historicalAssistant,
            { role: 'user', content: 'Quote the complete opening paragraph and the whole current review marker from Supplier operations.' }
          ],
          limits: { maxTurns: 3, maxToolCalls: 1, maxTokens: 2_000_000 }
        },
        { text, event }
      )
      if (authority === 'revoked after coverage') {
        await expect(execution).rejects.toMatchObject({ code: 'AGENT_EVIDENCE_INVALID' })
        expect(sourceAuthorized).toBe(false)
        expect(text).not.toHaveBeenCalled()
        expect(event.mock.calls).not.toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted' })])
      } else {
        const result = await execution
        expect(result.executionLimit).toBeUndefined()
        expect(result.citations).toEqual([expect.objectContaining(page.citation)])
        const published = text.mock.calls.map(([delta]) => delta).join('')
        const visible = visibleWikiText(published)
        expect(visible).toContain(opening)
        expect(visible).toContain(marker)
        expect(visible).toContain('Pilot scope')
        expect(visible).toContain('Review evidence')
        expect(visible).toContain(definition)
        expect(published).toContain(`[[cite:${page.citation.evidenceId}]]`)
        const rendered = document.createElement('div')
        rendered.innerHTML = renderSafeMarkdown(published)
        expect(rendered.querySelector('a[href="/en/pilot-policy"]')).toBeNull()
      }
      const historicalPrompt = chat.mock.calls[0]![0].chatPrompt.find(message => message.role === 'assistant')
      expect(historicalPrompt).not.toHaveProperty('thoughtBlocks')
      expect(historicalAssistant.providerState.thoughtBlocks).toEqual([{ data: 'opaque-prior-reasoning', encrypted: true }])
      expect(invoke).toHaveBeenCalledOnce()
      expect(coverage).toHaveBeenCalledOnce()
      expect(
        decisionProviders.decideBatch.mock.calls.filter(([request]) =>
          Object.values(request.questions).some(question => Object.hasOwn(question.criteria, 'supports'))
        )
      ).toHaveLength(0)
    }
  )

  it.each(['literal body', 'authored source syntax', 'empty HTML code', 'HTML code without LF'] as const)(
    'proves and publishes code %s without treating enclosed Wiki syntax as instructions or citations',
    async form => {
      const body =
        '## Wiki sources\n\tliteral &#65; &amp;\n\n````mermaid\nA-->B\n````\n<script>publish()</script>\n![image](https://invalid.test/pixel)\n[[cite:page:forged]]\n'
      const container = `> \`\`\`\`\`text\n${body
        .split('\n')
        .slice(0, -1)
        .map(line => `> ${line}`)
        .join('\n')}\n> \`\`\`\`\``
      const codeSource =
        form === 'empty HTML code'
          ? '<pre><code></code></pre>'
          : form === 'HTML code without LF'
            ? '<pre><code>&#35;&#35; Wiki sources&#13;&#9;&amp;literal</code></pre>'
            : container
      const page = {
        id: 42,
        locale: 'en',
        path: 'literal-fixture',
        title: 'Literal fixture',
        contentType: 'markdown',
        sourceRevision: '1',
        content: `# Controlled fixture — Fixture only; not operational instructions.\n\n${codeSource}\n`,
        citation: { evidenceId: 'page:42:revision:1', label: 'Literal fixture', href: '/en/literal-fixture' },
        citationSections: []
      }
      const expected =
        form === 'empty HTML code' ? '' : form === 'HTML code without LF' ? '## Wiki sources\r\t&literal' : form === 'literal body' ? body : `${container}\n`
      const decisionProviders = { ...fixtureDecisionProviders, decideBatch: vi.fn(fixtureDecisionProviders.decideBatch) }
      const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
        if (synthesisInputFromRequest(input) === undefined)
          return {
            results: [{ index: 0, functionCalls: [{ id: 'read-code-page', type: 'function', function: { name: 'wiki_get_page', params: '{"id":42}' } }] }]
          }
        const source = synthesisSourcesFromRequest(input).find(source => source.evidenceId === page.citation.evidenceId)
        if (source === undefined) throw new Error('Literal quotation requires its complete physical read')
        return {
          results: [
            {
              index: 0,
              content: JSON.stringify({
                claims: [],
                quotations: [{ sourceRef: source.sourceRef, text: expected }],
                unresolvedFacets: [],
                observations: [],
                recommendations: ''
              })
            }
          ]
        }
      })
      const coverage = vi.fn(
        async (): Promise<AxChatResponse> => ({
          results: [{ index: 0, content: JSON.stringify({ verdict: 'complete', feedback: '' }), finishReason: 'stop' }]
        })
      )
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [
            { name: 'pages.get', title: 'Read page', description: 'Read canonical page evidence', parameters: { type: 'object', properties: {} }, risk: 'read' }
          ],
          invoke: vi.fn(async () => page),
          validateObservation: async (name, output) => name === 'pages.get' && JSON.stringify(output) === JSON.stringify(page),
          snapshot: async () => ({}),
          close: () => {},
          authoritySha256: null
        })
      }
      const text = vi.fn(async (_delta: string) => {})
      const result = await new AxAgentEngine(factoryFor(chat, { coverage }), actions, undefined, { decisionProviders }).execute(
        {
          ...baseRequest(new AbortController().signal),
          memory: { user: [], agent: [] },
          messages: [
            {
              role: 'user',
              content: `Quote the complete ${form === 'authored source syntax' ? 'authored Markdown code container' : 'literal code body'} from Literal fixture.`
            }
          ],
          limits: { maxTurns: 3, maxToolCalls: 1, maxTokens: 2_000_000 }
        },
        { text, event: vi.fn(async () => {}) }
      )
      expect(result.executionLimit).toBeUndefined()
      expect(result.citations).toEqual([expect.objectContaining(page.citation)])
      const rendered = document.createElement('div')
      rendered.innerHTML = renderSafeMarkdown(text.mock.calls.map(([delta]) => delta).join(''))
      expect(rendered.querySelector('pre code')?.textContent).toBe(expected)
      expect(rendered.querySelectorAll('pre')).toHaveLength(1)
      expect(rendered.querySelectorAll('script, img, h1, h2, h3, .codeblock-mermaid')).toHaveLength(0)
      expect(rendered.textContent).toContain('Controlled fixture')
      expect(rendered.textContent).toContain('Fixture only; not operational instructions.')
      expect(coverage).toHaveBeenCalledOnce()
      expect(
        decisionProviders.decideBatch.mock.calls.filter(([request]) =>
          Object.values(request.questions).some(question => Object.hasOwn(question.criteria, 'supports'))
        )
      ).toHaveLength(0)
    }
  )

  it('drops a declined recent read atomically and retains only an unchanged omitted quotation group across repair', async () => {
    const userRequest = 'Recap the most recently updated Wiki pages with short source quotations.'
    const alphaQuote = 'Alpha dispatch requires a signed manifest.'
    const betaQuote = 'Beta storage requires a sealed receipt.'
    const gammaQuote = 'Gamma review requires a named approver.'
    const alphaDeclined = 'Alpha dispatch does not require a signed manifest.'
    const gammaDeclined = 'Gamma review does not require a named approver.'
    const pages = [alphaQuote, betaQuote, gammaQuote].map((content, index) => {
      const title = ['Alpha', 'Beta', 'Gamma'][index]!
      return {
        id: index + 1,
        locale: 'en',
        path: title.toLowerCase(),
        title,
        contentType: 'markdown',
        sourceRevision: `rev-${index + 1}`,
        content,
        citation: { evidenceId: `page:${index + 1}:revision:rev-${index + 1}`, label: title, href: `/en/${title.toLowerCase()}` },
        citationSections: [],
        updatedAt: '2026-09-20T09:00:00.000Z',
        contentTruncated: false,
        sourceContentCharacters: content.length
      }
    })
    const semanticVerdicts = rejectFixtureStatements([alphaDeclined, gammaDeclined])
    const decisionProviders = { ...semanticVerdicts, decideBatch: vi.fn(semanticVerdicts.decideBatch) }
    let synthesisAttempts = 0
    const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
      if (synthesisInputFromRequest(input) === undefined)
        return {
          results: [
            {
              index: 0,
              content: `<wiki-request-plan>${JSON.stringify({
                facets: [{ start: 0, end: userRequest.length, quote: userRequest, coverage: 'recent-window' }]
              })}</wiki-request-plan>`,
              functionCalls: [
                {
                  id: 'read-recent-documentary-pages',
                  type: 'function',
                  function: { name: input.functions!.find(fn => fn.name.includes('recent'))!.name, params: '{"limit":10}' }
                }
              ]
            }
          ]
        }
      synthesisAttempts++
      const sources = synthesisSourcesFromRequest(input)
      const sourceRef = (pageId: number): string => {
        const source = sources.find(source => source.evidenceId === pages[pageId - 1]!.citation.evidenceId)
        if (source === undefined) throw new Error('Repair must keep the unchanged complete recent read available')
        return source.sourceRef
      }
      return {
        results: [
          {
            index: 0,
            content: JSON.stringify({
              claims: [
                { sourceRef: sourceRef(1), statement: alphaDeclined },
                ...(synthesisAttempts === 1 ? [] : [{ sourceRef: sourceRef(3), statement: gammaDeclined }])
              ],
              quotations: [
                { sourceRef: sourceRef(1), text: alphaQuote },
                ...(synthesisAttempts === 1
                  ? [
                      { sourceRef: sourceRef(2), text: betaQuote },
                      { sourceRef: sourceRef(3), text: gammaQuote }
                    ]
                  : [])
              ],
              unresolvedFacets: [],
              observations: [],
              recommendations: ''
            })
          }
        ]
      }
    })
    const recentOutput = { kind: 'recent-page-evidence', requestedLimit: 10, exhausted: true, pages }
    const invoke = vi.fn(async () => recentOutput)
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [
          {
            name: 'pages.listRecent',
            title: 'Read recent pages',
            description: 'Read recent pages',
            parameters: { type: 'object', properties: {} },
            risk: 'read'
          }
        ],
        invoke,
        validateObservation: async (name, output) => name === 'pages.listRecent' && JSON.stringify(output) === JSON.stringify(recentOutput),
        snapshot: async () => ({}),
        close: () => {},
        authoritySha256: null
      })
    }
    const text = vi.fn(async (_delta: string) => {})
    const coverage = vi.fn(
      async (): Promise<AxChatResponse> => ({
        results: [
          { index: 0, content: JSON.stringify({ verdict: 'incomplete', feedback: 'Alpha and Gamma have no verified contribution.' }), finishReason: 'stop' }
        ]
      })
    )
    const result = await new AxAgentEngine(factoryFor(chat, { coverage }), actions, undefined, { decisionProviders }).execute(
      {
        ...baseRequest(new AbortController().signal),
        memory: { user: [], agent: [] },
        messages: [{ role: 'user', content: userRequest }],
        limits: { maxTurns: 3, maxToolCalls: 1, maxTokens: 2_000_000 }
      },
      { text, event: async () => {} }
    )
    expect(synthesisAttempts).toBe(2)
    expect(invoke).toHaveBeenCalledOnce()
    expect(coverage).toHaveBeenCalledOnce()
    expect(decisionProviders.decideBatch).toHaveBeenCalled()
    expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'partial' })
    expect(result.citations).toEqual([expect.objectContaining(pages[1]!.citation)])
    const published = visibleWikiText(text.mock.calls.map(([delta]) => delta).join(''))
    expect(published).toContain(betaQuote)
    expect(published).not.toContain(alphaQuote)
    expect(published).not.toContain(alphaDeclined)
    // Gamma was wholly verified in the first draft, but its latest declined
    // mention supersedes that group; only the omitted unchanged Beta may return.
    expect(published).not.toContain(gammaQuote)
    expect(published).not.toContain(gammaDeclined)
  })

  it.each(['entry count', 'content bytes', 'rendered bytes'] as const)('keeps the current honest partial when optional recent restoration exceeds combined %s', async bound => {
    const userRequest = 'Recap the most recently updated Wiki pages with source quotations.'
    const declined = 'Alpha dispatch does not require a signed manifest.'
    const alpha = 'Alpha dispatch requires a signed manifest.'
    const detail = bound === 'entry count' ? '' : ` with ${'documented review detail '.repeat(bound === 'content bytes' ? 45 : 6).trimEnd()}`
    const retainedCount = bound === 'entry count' ? 33 : 32
    const currentCount = 32
    const beta = Array.from({ length: retainedCount }, (_, index) => `Beta storage record ${index + 1} requires a sealed receipt${detail}.`)
    const gamma = Array.from({ length: currentCount }, (_, index) => `Gamma review record ${index + 1} requires a named approver${detail}.`)
    const pages = [alpha, beta.join('\n\n'), gamma.join('\n\n')].map((content, index) => ({
      id: index + 1,
      locale: 'en',
      path: ['alpha', 'beta', 'gamma'][index]!,
      title: ['Alpha', 'Beta', 'Gamma'][index]!,
      contentType: 'markdown',
      sourceRevision: `rev-${index + 1}`,
      content,
      citation: {
        evidenceId: `page:${index + 1}:revision:rev-${index + 1}`,
        label: ['Alpha', 'Beta', 'Gamma'][index]!,
        href: `/en/${['alpha', 'beta', 'gamma'][index]!}`
      },
      citationSections: [],
      updatedAt: '2026-09-20T09:00:00.000Z',
      contentTruncated: false,
      sourceContentCharacters: content.length
    }))
    let synthesisAttempts = 0
    const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse | ReadableStream<AxChatResponse>> => {
      if (synthesisInputFromRequest(input) === undefined)
        return {
          results: [{
            index: 0,
            content: `<wiki-request-plan>${JSON.stringify({
              facets: [{ start: 0, end: userRequest.length, quote: userRequest, coverage: 'recent-window' }]
            })}</wiki-request-plan>`,
            functionCalls: [{
              id: 'read-bounded-restoration',
              type: 'function',
              function: { name: input.functions!.find(fn => fn.name.includes('recent'))!.name, params: '{"limit":10}' }
            }]
          }]
        }
      synthesisAttempts++
      const sources = synthesisSourcesFromRequest(input)
      const sourceRef = (index: number): string => {
        const source = sources.find(source => source.evidenceId === pages[index]!.citation.evidenceId)
        if (source === undefined) throw new Error('The complete recent read must remain available during repair')
        return source.sourceRef
      }
      if (bound === 'content bytes') {
        const canonicalClaims = (index: number, statements: readonly string[]) => {
          const source = sources.find(source => source.evidenceId === pages[index]!.citation.evidenceId)!
          return statements.map(statement => ({ evidenceId: source.evidenceId, sourceRevision: source.sourceRevision, unitId: source.unitId, statement }))
        }
        const retained = canonicalClaims(1, beta)
        const current = canonicalClaims(2, gamma)
        for (const claims of [retained, current]) {
          const answer = { claims: [...canonicalClaims(0, [declined]), ...claims], unresolvedFacets: [], observations: [], recommendations: '' }
          expect(validateWikiSynthesisShape(answer)).toBe(true)
          expect(Buffer.byteLength(JSON.stringify(answer), 'utf8')).toBeLessThanOrEqual(65_536)
          expect(Buffer.byteLength(renderWikiSynthesisAnswer(answer), 'utf8')).toBeLessThanOrEqual(65_536)
        }
        expect(Buffer.byteLength(JSON.stringify({ claims: [...retained, ...current], unresolvedFacets: [0], observations: [], recommendations: '' }), 'utf8'))
          .toBeGreaterThan(65_536)
      }
      const content = JSON.stringify({
        claims: [
          { sourceRef: sourceRef(0), statement: declined },
          ...(bound === 'content bytes'
            ? (synthesisAttempts === 1 ? beta : gamma).map(statement => ({
                sourceRef: sourceRef(synthesisAttempts === 1 ? 1 : 2),
                statement
              }))
            : [])
        ],
        quotations: bound === 'content bytes'
          ? []
          : synthesisAttempts === 1
            ? [{ sourceRef: sourceRef(0), text: alpha }, ...beta.map(text => ({ sourceRef: sourceRef(1), text }))]
            : gamma.map(text => ({ sourceRef: sourceRef(2), text })),
        unresolvedFacets: [],
        observations: [],
        recommendations: ''
      })
      // Fragment independently valid responses without relaxing provider limits.
      return responseStream(utf8Chunks(content, 4_096).map(chunk => ({
        results: [{ index: 0, content: chunk }]
      })))
    })
    const recentOutput = { kind: 'recent-page-evidence', requestedLimit: 10, exhausted: true, pages }
    const invoke = vi.fn(async () => recentOutput)
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{
          name: 'pages.listRecent',
          title: 'Read recent pages',
          description: 'Read recent pages',
          parameters: { type: 'object', properties: {} },
          risk: 'read'
        }],
        invoke,
        validateObservation: async (name, output) => name === 'pages.listRecent' && JSON.stringify(output) === JSON.stringify(recentOutput),
        snapshot: async () => ({}),
        close: () => {},
        authoritySha256: null
      })
    }
    const coverage = vi.fn(async (): Promise<AxChatResponse> => ({
      results: [{ index: 0, content: JSON.stringify({ verdict: 'incomplete', feedback: 'Some recent pages remain unverified.' }), finishReason: 'stop' }]
    }))
    const text = vi.fn(async (_delta: string) => {})
    const result = await new AxAgentEngine(factoryFor(chat, { coverage, streaming: true, maxOutputTokens: 512, maxContextTokens: 1_000_000 }), actions, undefined, {
      decisionProviders: rejectFixtureStatements([declined])
    }).execute({
      ...baseRequest(new AbortController().signal),
      memory: { user: [], agent: [] },
      messages: [{ role: 'user', content: userRequest }],
      limits: { maxTurns: 3, maxToolCalls: 1, maxTokens: 2_000_000, maxOutputTokens: 512 }
    }, { text, event: async () => {} })
    expect(synthesisAttempts).toBe(2)
    expect(invoke).toHaveBeenCalledOnce()
    expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'partial' })
    expect(result.citations).toEqual([expect.objectContaining(pages[2]!.citation)])
    const output = text.mock.calls.map(([delta]) => delta).join('')
    const published = visibleWikiText(output)
    for (const statement of gamma) expect(published).toContain(statement)
    for (const statement of beta) expect(published).not.toContain(statement)
    expect(published).not.toContain(alpha)
    expect(published).not.toContain(declined)
    expect(output.match(/\[\[cite:/gu)).toHaveLength(currentCount)
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(65_536)
  })

  it.each(['unchanged', 'source revoked', 'source changed', 'provider changed'] as const)(
    'publishes only the unchanged verified recent candidate after a numeric-invalid sole repair: %s',
    async authority => {
      const userRequest = 'Recap the most recently updated Wiki pages with their limits, qualifications, and exact code example.'
      const alphaFact = 'Alpha dispatch permits 12 crates after the safety lead signs the manifest.'
      const alphaQualification = 'These limits apply only to the experimental pilot.'
      const betaFact = 'Beta storage permits 24 crates after the custodian seals the receipt.'
      const invalidRepairFact = 'Alpha dispatch permits 13 crates after the safety lead signs the manifest.'
      const code = 'if (crates > 12) {\n\treturn false\n}\n'
      const definition = '[pilot-policy]: /en/pilot-policy "Experimental pilot policy"'
      const alphaContent = `# Pilot [scope][pilot-policy]\n\n${alphaFact}\n\n${alphaQualification}\n\n\`\`\`js\n${code}\`\`\`\n\n${definition}\n`
      const pages = [
        {
          id: 1,
          locale: 'en',
          path: 'alpha',
          title: 'Alpha',
          contentType: 'markdown',
          sourceRevision: 'rev-1',
          content: alphaContent,
          citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
          citationSections: [],
          updatedAt: '2026-09-21T09:00:00.000Z',
          contentTruncated: false,
          sourceContentCharacters: alphaContent.length
        },
        {
          id: 2,
          locale: 'en',
          path: 'beta',
          title: 'Beta',
          contentType: 'markdown',
          sourceRevision: 'rev-2',
          content: betaFact,
          citation: { evidenceId: 'page:2:revision:rev-2', label: 'Beta', href: '/en/beta' },
          citationSections: [],
          updatedAt: '2026-09-20T09:00:00.000Z',
          contentTruncated: false,
          sourceContentCharacters: betaFact.length
        }
      ]
      const recentOutput = { kind: 'recent-page-evidence', requestedLimit: 10, exhausted: true, pages }
      let currentRecentOutput = recentOutput
      let sourceAuthorized = true
      let providerRevision = 1
      let synthesisAttempts = 0
      const decisionProviders = {
        ...fixtureDecisionProviders,
        selectRuntime: async () => ({ ...(await fixtureDecisionProviders.selectRuntime()), revision: providerRevision }),
        decideBatch: vi.fn(fixtureDecisionProviders.decideBatch)
      }
      const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
        if (synthesisInputFromRequest(input) === undefined)
          return {
            results: [
              {
                index: 0,
                content: `<wiki-request-plan>${JSON.stringify({
                  facets: [{ start: 0, end: userRequest.length, quote: userRequest, coverage: 'recent-window' }]
                })}</wiki-request-plan>`,
                functionCalls: [
                  {
                    id: 'read-recent-limits',
                    type: 'function',
                    function: { name: input.functions!.find(fn => fn.name.includes('recent'))!.name, params: '{"limit":10}' }
                  }
                ]
              }
            ]
          }
        synthesisAttempts++
        const sources = synthesisSourcesFromRequest(input)
        const sourceRef = (pageId: number): string => {
          const source = sources.find(source => source.evidenceId === pages[pageId - 1]!.citation.evidenceId)
          if (source === undefined) throw new Error('Repair requires the original recent physical reads')
          return source.sourceRef
        }
        return {
          results: [
            {
              index: 0,
              content: JSON.stringify({
                // Deliberately reverse the recent order; publication must use
                // the host's newest-first order, not the producer's order.
                claims: [
                  { sourceRef: sourceRef(2), statement: betaFact },
                  { sourceRef: sourceRef(1), statement: synthesisAttempts === 1 ? alphaFact : invalidRepairFact },
                  { sourceRef: sourceRef(1), statement: alphaQualification }
                ],
                quotations: [{ sourceRef: sourceRef(1), text: code }],
                unresolvedFacets: [],
                observations: [],
                recommendations: ''
              })
            }
          ]
        }
      })
      const invoke = vi.fn(async () => recentOutput)
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [
            {
              name: 'pages.listRecent',
              title: 'Read recent pages',
              description: 'Read recent pages',
              parameters: { type: 'object', properties: {} },
              risk: 'read'
            }
          ],
          invoke,
          validateObservation: async (name, output) =>
            name === 'pages.listRecent' && sourceAuthorized && JSON.stringify(output) === JSON.stringify(currentRecentOutput),
          snapshot: async () => ({}),
          close: () => {},
          authoritySha256: null
        })
      }
      const coverage = vi.fn(
        async (): Promise<AxChatResponse> => ({
          results: [{ index: 0, content: JSON.stringify({ verdict: 'incomplete', feedback: 'The requested recap is incomplete.' }), finishReason: 'stop' }]
        })
      )
      const text = vi.fn(async (_delta: string) => {})
      const event = vi.fn(async (type: string, _data: unknown) => {
        // Revoke only after the invalid repair's own rejection was published,
        // isolating the retained candidate's terminal publication fence.
        if (synthesisAttempts !== 2 || type !== 'evidence.provenance') return
        if (authority === 'source revoked') sourceAuthorized = false
        if (authority === 'source changed')
          currentRecentOutput = { ...recentOutput, pages: pages.map(page => (page.id === 1 ? { ...page, sourceRevision: 'changed-revision' } : page)) }
        if (authority === 'provider changed') providerRevision++
      })
      const execution = new AxAgentEngine(factoryFor(chat, { coverage }), actions, undefined, { decisionProviders }).execute(
        {
          ...baseRequest(new AbortController().signal),
          memory: { user: [], agent: [] },
          messages: [{ role: 'user', content: userRequest }],
          limits: { maxTurns: 3, maxToolCalls: 1, maxTokens: 2_000_000 }
        },
        { text, event }
      )
      if (authority === 'unchanged') {
        const result = await execution
        expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'partial' })
        expect(result.citations).toEqual(pages.map(page => expect.objectContaining(page.citation)))
        const published = text.mock.calls.map(([delta]) => delta).join('')
        const visible = visibleWikiText(published)
        expect(visible).toContain(alphaFact)
        expect(visible).toContain(alphaQualification)
        expect(visible).toContain(betaFact)
        expect(visible).not.toContain(invalidRepairFact)
        expect(visible.indexOf(alphaFact)).toBeLessThan(visible.indexOf(betaFact))
        expect(visible).toContain('Pilot scope')
        expect(visible).toContain(definition)
        for (const page of pages) expect(published).toContain(`[[cite:${page.citation.evidenceId}]]`)
        const rendered = document.createElement('div')
        rendered.innerHTML = renderSafeMarkdown(published)
        expect(rendered.querySelector('pre code')?.textContent).toBe(code)
        expect(rendered.querySelectorAll('pre')).toHaveLength(1)
        expect(rendered.querySelector('a[href="/en/pilot-policy"]')).toBeNull()
      } else {
        await expect(execution).rejects.toMatchObject({
          code: authority === 'provider changed' ? 'WIKI_VERIFICATION_FAILED' : 'AGENT_EVIDENCE_INVALID'
        })
        expect(text).not.toHaveBeenCalled()
      }
      expect(synthesisAttempts).toBe(2)
      expect(invoke).toHaveBeenCalledOnce()
      expect(coverage).toHaveBeenCalledOnce()
      expect(
        decisionProviders.decideBatch.mock.calls.reduce(
          (count, [request]) => count + Object.values(request.questions).filter(question => Object.hasOwn(question.criteria, 'supports')).length,
          0
        )
      ).toBe(3)
      expect(event.mock.calls).toContainEqual([
        'model.turn',
        expect.objectContaining({
          outcome: 'answer_rejected',
          performance: expect.objectContaining({ rejectedDraftCount: 2, repairAttempts: 1, maxAnswerRepairs: 1 })
        })
      ])
    }
  )

  it('uses the same bounded root output exposure for preflight and actual generation on large provider profiles', async () => {
    const chat = vi.fn(
      async (input: Readonly<AxChatRequest<unknown>>) =>
        ({
          results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }]
        }) satisfies AxChatResponse
    )
    const engine = new AxAgentEngine(factoryFor(chat, { maxOutputTokens: 32_768 }), undefined, undefined, { decisionProviders: fixtureDecisionProviders })
    const request = baseRequest(new AbortController().signal)
    const preflight = await engine.preflight(request)
    const event = vi.fn(async () => {})
    const result = await engine.execute(request, { text: async () => {}, event })

    expect(preflight).toMatchObject({ admissible: true, outputExposureTokens: 16_384 })
    expect(chat.mock.calls[0]?.[0].modelConfig).toMatchObject({ maxTokens: 16_384 })
    expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
    expect(result.citations).toBeUndefined()
    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted' })])
  })

  it('classifies wrapped request, stream, and response failures at their engine boundaries', async () => {
    const wrappedRequest = Object.assign(new Error('provider request secret'), {
      cause: Object.assign(new Error('sdk wrapper secret'), {
        originalError: new AgentProviderAttemptError('provider_secret_code', 429, null, 'api_key')
      }),
      body: 'request body secret',
      headers: 'authorization secret'
    })
    const requestError = await new AxAgentEngine(
      factoryFor(
        vi.fn(async () => {
          throw wrappedRequest
        })
      ),
      undefined,
      undefined,
      { decisionProviders: fixtureDecisionProviders }
    )
      .execute(baseRequest(new AbortController().signal), { text: async () => {}, event: async () => {} })
      .catch(error => error)
    expect(requestError).toBeInstanceOf(AgentExecutionFailure)
    expect(requestError).toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
      stage: 'provider_request',
      providerStatus: 429,
      message: 'Agent inference failed'
    })
    expect(JSON.stringify(requestError)).not.toContain('provider_secret_code')
    expect(JSON.stringify(requestError)).not.toContain('api_key')
    expect(JSON.stringify(requestError)).not.toContain('request body secret')
    expect(JSON.stringify(requestError)).not.toContain('authorization secret')

    const streamFailure = Object.assign(new Error('provider stream secret'), {
      cause: new AgentProviderAttemptError('stream_secret_code', 503, null, 'token')
    })
    const stream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.error(streamFailure)
      }
    })
    const streamError = await new AxAgentEngine(
      factoryFor(async () => stream),
      undefined,
      undefined,
      { decisionProviders: fixtureDecisionProviders }
    )
      .execute(baseRequest(new AbortController().signal), { text: async () => {}, event: async () => {} })
      .catch(error => error)
    expect(streamError).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', stage: 'provider_stream', providerStatus: 503 })
    expect(JSON.stringify(streamError)).not.toContain('stream_secret_code')
    expect(JSON.stringify(streamError)).not.toContain('token')

    const malformedResponse = {
      results: [{ index: 0, functionCalls: [{ id: '', type: 'function', function: { name: 'wiki_get_page', params: '{}' } }] }]
    } satisfies AxChatResponse
    const responseError = await new AxAgentEngine(
      factoryFor(async () => malformedResponse),
      undefined,
      undefined,
      { decisionProviders: fixtureDecisionProviders }
    )
      .execute(baseRequest(new AbortController().signal), { text: async () => {}, event: async () => {} })
      .catch(error => error)
    expect(responseError).toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response', message: 'Agent inference failed' })
  })
  it('awaits one safe cancellation before releasing an incomplete provider stream', async () => {
    const reservation = { id: 'reservation', tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => reservation)
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    let resolveCancelStarted!: () => void
    let resolveCancel!: () => void
    const cancelStarted = new Promise<void>(resolve => {
      resolveCancelStarted = resolve
    })
    let cancelReason: unknown
    let cancelCalls = 0
    const stream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'partial' }],
          modelUsage: null
        } as unknown as AxChatResponse)
      },
      cancel(reason) {
        cancelCalls += 1
        cancelReason = reason
        resolveCancelStarted()
        return new Promise<void>(resolve => {
          resolveCancel = resolve
        })
      }
    })
    const chat = vi.fn(async () => stream)
    const execution = new AxAgentEngine(factoryFor(chat, { streaming: true, usage: 'stream' }), undefined, undefined, {
      decisionProviders: fixtureDecisionProviders
    }).execute(
      {
        ...baseRequest(new AbortController().signal),
        purpose: 'planner',
        dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      },
      { text: async () => {}, event: async () => {} }
    )
    let settled = false
    const observed = execution.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await cancelStarted
    expect(settled).toBe(false)
    expect(stream.locked).toBe(true)
    expect(cancelReason).toBe('provider stream failed')
    expect(cancelCalls).toBe(1)
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()

    resolveCancel()
    await expect(execution).rejects.toMatchObject({ code: 'PROVIDER_USAGE_INVALID', stage: 'provider_response' })
    await observed
    expect(reconcile).not.toHaveBeenCalled()
    expect(stream.locked).toBe(false)
    expect(release).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledOnce()
  })

  it('preserves the primary stream failure when cancellation rejects and releases the reader lock', async () => {
    const rawCancelFailure = new Error('raw cancellation secret')
    let cancelCalls = 0
    let cancelReason: unknown
    const stream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'partial' }],
          modelUsage: null
        } as unknown as AxChatResponse)
      },
      cancel(reason) {
        cancelCalls += 1
        cancelReason = reason
        return Promise.reject(rawCancelFailure)
      }
    })
    const chat = vi.fn(async () => stream)
    const error = await new AxAgentEngine(factoryFor(chat, { streaming: true, usage: 'stream' }), undefined, undefined, {
      decisionProviders: fixtureDecisionProviders
    })
      .execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: async () => {}, event: async () => {} })
      .catch(failure => failure)

    expect(error).toMatchObject({ code: 'PROVIDER_USAGE_INVALID', stage: 'provider_response', message: 'Agent inference failed' })
    expect(JSON.stringify(error)).not.toContain('raw cancellation secret')
    expect(cancelReason).toBe('provider stream failed')
    expect(cancelCalls).toBe(1)
    expect(chat).toHaveBeenCalledOnce()

    const releasedReader = stream.getReader()
    releasedReader.releaseLock()
  })

  it('does not complete collection from a trailing finish after omitted or unexecuted source reads', async () => {
    const calls = Array.from({ length: 10 }, (_, index) => ({
      id: `second-${index}`,
      type: 'function' as const,
      function: { name: 'wiki_get_page', params: JSON.stringify({ id: index + 2 }) }
    }))
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'first', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }] },
      {
        results: [
          { index: 0, functionCalls: [...calls, { id: 'finish-capacity', type: 'function', function: { name: 'wiki_finish_collection', params: '{}' } }] }
        ]
      }
    ]
    const synthesisRequests: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      if (synthesisInputFromRequest(input) !== undefined) {
        synthesisRequests.push(input)
        return {
          results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }]
        } satisfies AxChatResponse
      }
      return responses.shift()!
    })
    const invoke = vi.fn(async (_name: string, input: unknown, _signal: AbortSignal, actionCallId: string) => {
      if (typeof input !== 'object' || input === null || !('id' in input) || typeof input.id !== 'number') throw new Error('Expected an admitted page ID')
      return {
        id: input.id,
        locale: 'en',
        path: `page-${input.id}`,
        title: `Page ${input.id}`,
        sourceRevision: 'rev-1',
        contentType: 'markdown',
        content: actionCallId === calls[0]!.id ? 'x'.repeat(120_000) : 'x'.repeat(3_000),
        citation: { evidenceId: `page:${input.id}:revision:rev-1`, label: `Page ${input.id}`, href: `/en/page-${input.id}` },
        citationSections: []
      }
    })
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const event = vi.fn(async () => {})
    const result = await new AxAgentEngine(factoryFor(chat, { maxOutputTokens: 1_000 }), actions, undefined, {
      decisionProviders: fixtureDecisionProviders
    }).execute(
      {
        ...baseRequest(new AbortController().signal),
        limits: { maxTurns: 4, maxToolCalls: 11, maxOutputTokens: 100 }
      },
      { text: async () => {}, event }
    )

    expect(result.contextLimit).toEqual({ reason: 'tool_result_capacity', omittedActionCallIds: calls.map(call => call.id) })
    expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
    expect(result.citations).toBeUndefined()
    expect(synthesisRequests).toHaveLength(1)
    expect(synthesisRequests.flatMap(input => input.functions ?? []).map(fn => fn.name)).toEqual([])
    expect(synthesisRequests[0]?.modelConfig?.maxTokens).toBeLessThanOrEqual(100)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls.map(call => call[3])).toEqual(['first', calls[0]!.id])
    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted' })])
  })
  it('runs the planner without actions, retries, or unbounded output', async () => {
    const chat = vi.fn(
      async () =>
        ({
          results: [{ index: 0, content: '{"tasks":[]}' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } }
        }) satisfies AxChatResponse
    )
    const open = vi.fn()
    const text = vi.fn(async () => {})
    const engine = new AxAgentEngine(factoryFor(chat), { open } as unknown as AgentActionSessionProvider, undefined, {
      decisionProviders: fixtureDecisionProviders
    })

    expect(
      await engine.execute(
        {
          ...baseRequest(new AbortController().signal),
          purpose: 'planner',
          actionAllowlist: [],
          limits: { maxTurns: 2, maxToolCalls: 0, maxOutputTokens: 1_024 }
        },
        { text, event: async () => {} }
      )
    ).toMatchObject({ inputTokens: 4, outputTokens: 2, totalTokens: 6, costMicros: 8 })

    expect(open).not.toHaveBeenCalled()
    expect(text).toHaveBeenCalledWith('{"tasks":[]}')
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({
        modelConfig: { maxTokens: 1_024 },
        chatPrompt: [expect.objectContaining({ role: 'system', content: expect.stringContaining('task-planning stage') }), expect.any(Object)]
      }),
      expect.objectContaining({ retry: { maxRetries: 0 } })
    )
    expect(chat.mock.calls[0]?.[0]).not.toHaveProperty('functions')
  })

  it('namespaces child action calls and returns the frozen authority hash', async () => {
    const taskId = '00000000-0000-4000-8000-000000000011'
    const subagentRunId = '00000000-0000-4000-8000-000000000012'
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, functionCalls: [{ id: 'provider-call', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }] },
      {
        results: [
          {
            index: 0,
            content: JSON.stringify({
              taskId,
              outcome: 'completed',
              claims: [
                {
                  text: 'Alpha requires review. [[cite:page:1:revision:rev-1]]',
                  evidenceIds: ['page:1:revision:rev-1'],
                  sourceRevisionIds: ['rev-1'],
                  confidence: 'high'
                }
              ],
              conflicts: [],
              unanswered: [],
              recommendedFollowups: []
            })
          }
        ]
      }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const page = {
      id: 1,
      locale: 'en',
      path: 'alpha',
      sourceRevision: 'rev-1',
      title: 'Alpha',
      contentType: 'markdown',
      content: 'Alpha requires review.',
      citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
      citationSections: []
    }
    const invoke = vi.fn(async () => page)
    const authoritySha256 = 'b'.repeat(64)
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        validateObservation: async (actionName, output, signal) =>
          !signal.aborted && actionName === 'pages.get' && JSON.stringify(output) === JSON.stringify(page),
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256
      })
    }
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      purpose: 'subagent',
      task: { id: taskId, kind: 'source_scout', title: 'Review alpha', question: 'What does alpha require?', sourceScope: ['alpha'], requiredEvidenceCount: 1 },
      subagentRunId,
      actionAllowlist: ['pages.get'],
      limits: { maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 2_048 }
    }
    const text = vi.fn(async () => {})

    const result = await new AxAgentEngine(factoryFor(chat), actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(request, {
      text,
      event: async () => {}
    })

    expect(invoke).toHaveBeenCalledWith(
      'pages.get',
      { id: 1 },
      expect.any(AbortSignal),
      expect.stringMatching(new RegExp(`^sa_${subagentRunId}_[a-f0-9]{24}$`, 'u'))
    )
    expect(result.authoritySha256).toBe(authoritySha256)
    expect(text).toHaveBeenCalledWith(expect.stringContaining('"taskId"'))
    const systemPrompt = (chat.mock.calls[0]?.[0] as AxChatRequest<unknown> | undefined)?.chatPrompt?.[0]
    expect(systemPrompt).toEqual(expect.objectContaining({ content: expect.not.stringContaining('private preference') }))
  })

  it('stops a two-turn child before an uncovered third dispatch at the aggregate token ceiling', async () => {
    const responses: AxChatResponse[] = [
      {
        results: [{ index: 0, functionCalls: [{ id: 'first', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
      },
      {
        results: [{ index: 0, functionCalls: [{ id: 'second', type: 'function', function: { name: 'wiki_get_page', params: '{"id":2}' } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 0, totalTokens: 1 } }
      }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const invoke = vi.fn(async () => ({ id: 1, sourceRevision: 'rev-1', title: 'Alpha', content: 'Alpha' }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const taskId = '00000000-0000-4000-8000-000000000031'

    await expect(
      Promise.resolve(
        new AxAgentEngine(factoryFor(chat), actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
          {
            ...baseRequest(new AbortController().signal),
            purpose: 'subagent',
            task: {
              id: taskId,
              kind: 'source_scout',
              title: 'Review alpha',
              question: 'What does alpha require?',
              sourceScope: ['alpha'],
              requiredEvidenceCount: 1
            },
            subagentRunId: '00000000-0000-4000-8000-000000000032',
            actionAllowlist: ['pages.get'],
            limits: { maxTokens: 4, maxTurns: 3, maxToolCalls: 3, maxOutputTokens: 4 }
          },
          { text: async () => {}, event: async () => {} }
        )
      )
    ).rejects.toMatchObject({ code: 'AGENT_CHILD_BUDGET_EXCEEDED' })

    expect(chat).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ modelConfig: { maxTokens: 1 } }))
  })

  it('consumes the 6000-token child allowance at dispatch while retaining the 2048-token output ceiling', async () => {
    const providerRequests: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      providerRequests.push(input)
      if (providerRequests.length !== 1) throw new Error('Exhausted child must not dispatch another provider request.')
      return {
        results: [{ index: 0, functionCalls: [{ id: 'read-alpha', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 5_999, completionTokens: 1, totalTokens: 6_000 } }
      } satisfies AxChatResponse
    })
    const invoke = vi.fn(async () => ({
      id: 1,
      locale: 'en',
      path: 'alpha',
      sourceRevision: 'rev-1',
      title: 'Alpha',
      contentType: 'markdown',
      content: 'Alpha requires review.',
      citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
      citationSections: []
    }))
    const close = vi.fn()
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close,
        authoritySha256: 'b'.repeat(64)
      })
    }
    const text = vi.fn(async () => {})
    await expect(
      new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
        {
          ...baseRequest(new AbortController().signal),
          purpose: 'subagent',
          task: {
            id: '00000000-0000-4000-8000-000000000041',
            kind: 'source_scout',
            title: 'Review alpha',
            question: 'What does alpha require?',
            sourceScope: ['alpha'],
            requiredEvidenceCount: 1
          },
          subagentRunId: '00000000-0000-4000-8000-000000000042',
          actionAllowlist: ['pages.get'],
          limits: { maxTokens: 6_000, maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 2_048 }
        },
        { text, event: async () => {} }
      )
    ).rejects.toMatchObject({ code: 'AGENT_CHILD_BUDGET_EXCEEDED' })

    expect(providerRequests).toHaveLength(1)
    expect(providerRequests[0]!.modelConfig?.maxTokens).toBe(2_048)
    expect(JSON.stringify(providerRequests[0])).not.toContain('private preference')
    expect(JSON.stringify(providerRequests[0])).not.toContain('private note')
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith(
      'pages.get',
      { id: 1 },
      expect.any(AbortSignal),
      expect.stringMatching(/^sa_00000000-0000-4000-8000-000000000042_[a-f0-9]{24}$/u)
    )
    expect(text).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('dispatches only the covered action when the root tool budget is one', async () => {
    const chat = vi.fn(
      async (input: Readonly<AxChatRequest<unknown>>) =>
        ({
          results: [
            synthesisInputFromRequest(input) === undefined
              ? {
                  index: 0,
                  functionCalls: [
                    { id: 'first', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } },
                    { id: 'second', type: 'function', function: { name: 'wiki_get_page', params: '{"id":2}' } }
                  ]
                }
              : { index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }
          ],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        }) satisfies AxChatResponse
    )
    const invoke = vi.fn(async () => ({ id: 1, title: 'Alpha', content: 'Alpha' }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }

    const text = vi.fn(async () => {})
    const response = await new AxAgentEngine(factoryFor(chat), actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
      {
        ...baseRequest(new AbortController().signal),
        limits: { maxTokens: 60_000, maxTurns: 2, maxToolCalls: 1, maxOutputTokens: 10 }
      },
      { text, event: async () => {} }
    )
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('pages.get', { id: 1 }, expect.any(AbortSignal), 'first')
    expect(response.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
  })
  it('settles rejected tool-free synthesis after a read without another action or an unverified publication', async () => {
    const budget = new PublicationBudgetLedger(120_000)
    const unsupported = 'The second page confirms an unsupported conclusion.'
    const chat = vi.fn(
      async (input: Readonly<AxChatRequest<unknown>>) =>
        ({
          results: [
            synthesisInputFromRequest(input) === undefined
              ? { index: 0, functionCalls: [{ id: 'first-read', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }
              : {
                  index: 0,
                  content: synthesisFixtureAnswer(input, {
                    claims: [{ evidenceId: 'page:1:revision:rev-1', statement: unsupported }]
                  })
                }
          ],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        }) satisfies AxChatResponse
    )
    const invoke = vi.fn(async () => ({
      id: 1,
      locale: 'en',
      path: 'alpha',
      title: 'Alpha',
      contentType: 'markdown',
      sourceRevision: 'rev-1',
      content: 'Alpha requires review.',
      citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
      citationSections: []
    }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        validateObservation: async () => true,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const text = vi.fn(async () => {})
    const event = vi.fn(async () => {})
    const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions, undefined, {
      decisionProviders: rejectFixtureStatements([unsupported])
    }).execute(
      {
        ...baseRequest(new AbortController().signal),
        limits: { maxTokens: budget.maximumTokens, maxTurns: 2, maxToolCalls: 1, maxOutputTokens: 10 },
        dispatchBudget: budget
      },
      { text, event }
    )

    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('pages.get', { id: 1 }, expect.any(AbortSignal), 'first-read')
    expect(result).toMatchObject({ totalTokens: 4, costMicros: 6, executionLimit: { reason: 'evidence', publication: 'inability' } })
    expect(result.citations).toBeUndefined()
    expect(budget.tools).toBe(1)
    expect(budget.consumedTokens).toBe(4)
    expect(budget.consumedCostMicros).toBe(6)
    expect(budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
    expect(budget.allocatedTokens).toBe(budget.returnedTokens + budget.consumedTokens)
    expect(text.mock.calls.map(([delta]) => delta).join('')).not.toContain(unsupported)
    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_rejected', turn: 2, totalTokens: 2 })])
    expect(event.mock.calls).toContainEqual([
      'model.turn',
      expect.objectContaining({
        purpose: 'verification',
        outcome: 'verification_declined',
        totalTokens: 0,
        verification: expect.objectContaining({ resultFrame: expect.objectContaining({ status: 'semantic_rejection' }) })
      })
    ])
  })

  it('never publishes an uncited source premise smuggled through recommendations after a Wiki page was read', async () => {
    let turn = 0
    const draft = 'Alpha requires review, so publication can proceed after review.'
    const chat = vi.fn(
      async (input: Readonly<AxChatRequest<unknown>>) =>
        ({
          results: [
            ++turn === 1
              ? { index: 0, functionCalls: [{ id: 'read-alpha', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }
              : {
                  index: 0,
                  content: synthesisFixtureAnswer(input, {
                    claims: [{ evidenceId: 'page:1:revision:rev-1', statement: 'Alpha requires review.' }],
                    recommendations: draft
                  })
                }
          ]
        }) satisfies AxChatResponse
    )
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke: async () => ({
          id: 1,
          locale: 'en',
          path: 'alpha',
          title: 'Alpha',
          contentType: 'markdown',
          sourceRevision: 'rev-1',
          content: 'Alpha requires review.',
          citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
          citationSections: []
        }),
        validateObservation: async () => true,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const text = vi.fn(async () => {})
    const event = vi.fn(async () => {})
    const result = await new AxAgentEngine(factoryFor(chat), actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
      {
        ...baseRequest(new AbortController().signal),
        limits: { maxTurns: 2, maxToolCalls: 1, maxOutputTokens: 512 }
      },
      { text, event }
    )

    expect(result).toMatchObject({ executionLimit: { reason: 'evidence', publication: 'inability' } })
    expect(result.citations).toBeUndefined()
    expect(text.mock.calls.map(([delta]) => delta).join('')).toContain("I couldn't complete a source-verified answer")
    expect(text.mock.calls.map(([delta]) => delta).join('')).not.toContain('publication can proceed')
    expect(event.mock.calls).toContainEqual(['evidence.provenance', expect.objectContaining({ accepted: false })])
  })

  it('does not dispatch actions when the reserved synthesis quota is unavailable', async () => {
    const invoke = vi.fn(async () => ({ id: 1, title: 'Unverified', content: 'Must not be read' }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const budget = new PublicationBudgetLedger(Number.MAX_SAFE_INTEGER)
    const deniedExposure: { tokens: number; costMicros: number }[] = []
    // Neither collection nor a fallback draft may spend without a publication hold.
    budget.reserveSequence = async maximum => {
      deniedExposure.push(maximum)
      throw new AgentRepositoryError('AGENT_QUOTA_EXHAUSTED', 'Daily quota is exhausted', 429)
    }
    const measuredUsage: AgentDispatchUsage[] = []
    const text = vi.fn(async () => {})
    const chat = async (input: Readonly<AxChatRequest<unknown>>) => {
      expect(input.functions ?? []).toEqual([])
      const tokens = { promptTokens: 3, completionTokens: 2, totalTokens: 5 }
      measuredUsage.push({ inputTokens: tokens.promptTokens, outputTokens: tokens.completionTokens, totalTokens: tokens.totalTokens, costMicros: 7 })
      return {
        results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens }
      } satisfies AxChatResponse
    }
    const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions, undefined, {
      decisionProviders: fixtureDecisionProviders
    }).execute(
      {
        ...baseRequest(new AbortController().signal),
        limits: { maxTurns: 3, maxToolCalls: 2, maxOutputTokens: 128 },
        dispatchBudget: budget
      },
      { text, event: async () => {} }
    )
    expect(invoke).not.toHaveBeenCalled()
    expect(measuredUsage).toEqual([])
    expect(result).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 })
    expect(deniedExposure.length).toBeGreaterThan(0)
    for (const exposure of deniedExposure) {
      expect(exposure.tokens).toBeGreaterThan(0)
      expect(exposure.costMicros).toBeGreaterThan(0)
    }
    expect(budget.tools).toBe(0)
    const actualUsage = measuredUsage.reduce(
      (total, usage) => ({
        inputTokens: total.inputTokens + usage.inputTokens,
        outputTokens: total.outputTokens + usage.outputTokens,
        totalTokens: total.totalTokens + usage.totalTokens,
        costMicros: total.costMicros + usage.costMicros
      }),
      { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 }
    )
    expect(result).toMatchObject(actualUsage)
    expect(budget.consumedTokens).toBe(actualUsage.totalTokens)
    expect(budget.consumedCostMicros).toBe(actualUsage.costMicros)
    expect(budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
    expect(budget.allocatedTokens).toBe(budget.returnedTokens + actualUsage.totalTokens)
    const published = text.mock.calls.map(([delta]) => delta).join('')
    expect(published.trim().length).toBeGreaterThan(0)
    expect(published).not.toContain('Must not be read')
    expect(published).not.toContain('Unverified')
    expect(published).not.toContain('[[cite:')
    expect(result.executionLimit).toEqual({ reason: 'quota', publication: 'inability' })
    expect(result.citations).toBeUndefined()
  })

  it('does not dispatch actions from the final available model turn', async () => {
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      expect(synthesisInputFromRequest(input)).toBeDefined()
      return {
        results: [
          {
            index: 0,
            functionCalls: [{ id: 'too-late', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }]
          }
        ],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
      } satisfies AxChatResponse
    })
    const invoke = vi.fn(async () => ({ id: 1, title: 'Alpha', content: 'Alpha' }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const reserve = vi.fn(async (maximum: { tokens: number; costMicros: number }) => ({ id: 1, ...maximum }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const text = vi.fn(async () => {})

    await expect(
      Promise.resolve(
        new AxAgentEngine(factoryFor(chat), actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
          {
            ...baseRequest(new AbortController().signal),
            limits: { maxTokens: 60_000, maxTurns: 1, maxToolCalls: 1, maxOutputTokens: 10 },
            dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
          },
          { text, event: async () => {} }
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(invoke).not.toHaveBeenCalled()
    expect(chat.mock.calls.flatMap(([input]) => input.functions ?? []).map(fn => fn.name)).toEqual([])
    expect(reserve).toHaveBeenCalledOnce()
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
  })

  it('rejects root synthesis until every completed task has cited coverage', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1:revision:rev-1]]' }] },
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1:revision:rev-1]] Beta requires audit. [[cite:page:2:revision:rev-2]]' }] }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      if (offersCollectionFinish(input)) return finishCollectionResponse
      return responses.shift()!
    })
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      research: {
        packets: [
          {
            task: {
              id: '00000000-0000-4000-8000-000000000021',
              kind: 'source_scout',
              title: 'Review alpha',
              question: 'Alpha?',
              sourceScope: ['alpha'],
              requiredEvidenceCount: 1
            },
            packet: {
              taskId: '00000000-0000-4000-8000-000000000021',
              outcome: 'completed',
              claims: [],
              conflicts: [],
              unanswered: [],
              recommendedFollowups: []
            },
            evidenceIds: ['page:1:revision:rev-1'],
            conflictEvidenceGroups: []
          },
          {
            task: {
              id: '00000000-0000-4000-8000-000000000022',
              kind: 'source_scout',
              title: 'Review beta',
              question: 'Beta?',
              sourceScope: ['beta'],
              requiredEvidenceCount: 1
            },
            packet: {
              taskId: '00000000-0000-4000-8000-000000000022',
              outcome: 'completed',
              claims: [],
              conflicts: [],
              unanswered: [],
              recommendedFollowups: []
            },
            evidenceIds: ['page:2:revision:rev-2'],
            conflictEvidenceGroups: []
          }
        ],
        incompleteTasks: [],
        evidenceSeeds: [
          {
            taskId: '00000000-0000-4000-8000-000000000021',
            subagentRunId: '00000000-0000-4000-8000-000000000031',
            actionCallId: 'alpha-read',
            actionName: 'pages.get',
            output: {
              id: 1,
              locale: 'en',
              path: 'alpha',
              title: 'Alpha',
              contentType: 'markdown',
              sourceRevision: 'rev-1',
              content: 'Alpha requires review.',
              citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
              citationSections: []
            }
          },
          {
            taskId: '00000000-0000-4000-8000-000000000022',
            subagentRunId: '00000000-0000-4000-8000-000000000032',
            actionCallId: 'beta-read',
            actionName: 'pages.get',
            output: {
              id: 2,
              locale: 'en',
              path: 'beta',
              title: 'Beta',
              contentType: 'markdown',
              sourceRevision: 'rev-2',
              content: 'Beta requires audit.',
              citation: { evidenceId: 'page:2:revision:rev-2', label: 'Beta', href: '/en/beta' },
              citationSections: []
            }
          }
        ]
      }
    }
    const text = vi.fn(async () => {})
    const validateObservation = vi.fn(async () => true)

    await new AxAgentEngine(factoryFor(chat), pageEvidenceActions(validateObservation), undefined, { decisionProviders: fixtureDecisionProviders }).execute(
      request,
      { text, event }
    )

    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })])
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)).toEqual([
      expect.objectContaining({ accepted: false, issues: expect.arrayContaining([expect.stringContaining('Review beta')]) }),
      expect.objectContaining({ accepted: true, finalCitationIds: ['page:1:revision:rev-1', 'page:2:revision:rev-2'] })
    ])
    const published = text.mock.calls.map(([delta]) => delta).join('')
    expect(visibleWikiText(published)).toContain('Alpha requires review.')
    expect(visibleWikiText(published)).toContain('Beta requires audit.')
    expect(published).toContain('[[cite:page:1:revision:rev-1]]')
    expect(published).toContain('[[cite:page:2:revision:rev-2]]')
  })

  describe('receipt-only synthesis source obligations', () => {
    const preference = 'Prefer concise answers.'
    const operation = 'Remember that I prefer concise answers.'
    const sourceQuestion = 'Explain Alpha publication requirements.'
    const recentQuestion = 'Recap the most recently updated Wiki pages.'
    const receiptLine = 'Memory operation changed user memory.'

    const receiptFixture = async (mode: 'operation-only' | 'source' | 'source-and-recent', disclose: boolean) => {
      const userRequest = [operation, ...(mode === 'operation-only' ? [] : [sourceQuestion]), ...(mode === 'source-and-recent' ? [recentQuestion] : [])].join(
        ' '
      )
      const facets =
        mode === 'operation-only'
          ? []
          : [
              {
                start: userRequest.indexOf(sourceQuestion),
                end: userRequest.indexOf(sourceQuestion) + sourceQuestion.length,
                quote: sourceQuestion,
                coverage: 'source'
              },
              ...(mode === 'source-and-recent'
                ? [
                    {
                      start: userRequest.indexOf(recentQuestion),
                      end: userRequest.indexOf(recentQuestion) + recentQuestion.length,
                      quote: recentQuestion,
                      coverage: 'recent-window'
                    }
                  ]
                : [])
            ]
      const input = { action: 'add', target: 'user', content: preference }
      const output = {
        changed: true,
        message: 'Saved preference.',
        target: 'user',
        entries: [preference],
        characters: preference.length,
        limit: 2_200
      }
      const invoke = vi.fn(async () => output)
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [
            {
              name: 'memory.manage',
              title: 'Manage personal memory',
              description: 'Save a durable user preference',
              parameters: { type: 'object', properties: {} },
              risk: 'reversible-write'
            }
          ],
          invoke,
          snapshot: async () => ({}),
          close: () => {},
          authoritySha256: null
        })
      }
      const drafts: {
        readonly claims: readonly []
        readonly attachmentClaims: readonly []
        readonly observations: readonly string[]
        readonly unresolvedFacets: readonly number[]
      }[] = []
      const chat = vi.fn(async (request: Readonly<AxChatRequest<unknown>>): Promise<AxChatResponse> => {
        if (synthesisInputFromRequest(request) === undefined) {
          const tool = request.functions?.find(fn => fn.name === AGENT_TOOL_NAMES['memory.manage'])
          if (tool === undefined) throw new Error('The memory operation must be available to the collector')
          return {
            results: [
              {
                index: 0,
                ...(facets.length === 0 ? {} : { content: `<wiki-request-plan>${JSON.stringify({ facets })}</wiki-request-plan>` }),
                functionCalls: [{ id: 'save-preference', type: 'function', function: { name: tool.name, params: JSON.stringify(input) } }]
              }
            ]
          }
        }
        // The genuine engine must have projected and delivered the canonical
        // memory result; do not inject a pre-admitted observation into the run.
        const observations = synthesisObservationsFromRequest(request)
        expect(observations).toEqual([receiptLine])
        expect(synthesisSourcesFromRequest(request)).toEqual([])
        const draft = {
          claims: [] as const,
          attachmentClaims: [] as const,
          observations: [receiptLine],
          unresolvedFacets: disclose ? facets.map((_facet, index) => index) : []
        }
        drafts.push(draft)
        return { results: [{ index: 0, content: JSON.stringify(draft), finishReason: 'stop' }] }
      })
      const coverage = vi.fn(async (request: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
        // An exact receipt establishes the memory operation, not either
        // independently requested content facet. Exercise the existing audit.
        expect(mode).not.toBe('operation-only')
        expect(disclose).toBe(false)
        const prompt = JSON.stringify(request.chatPrompt)
        expect(prompt).toContain(receiptLine)
        expect(prompt).toContain(sourceQuestion)
        if (mode === 'source-and-recent') expect(prompt).toContain(recentQuestion)
        return {
          results: [
            {
              index: 0,
              content: JSON.stringify({
                verdict: 'not_established',
                feedback: 'The requested Wiki facts have no content claims and must remain unresolved; the receipt covers only the memory operation.'
              }),
              finishReason: 'stop'
            }
          ]
        }
      })
      const text = vi.fn(async (_delta: string) => {})
      const event = vi.fn(async (_type: string, _data: unknown) => {})
      const result = await new AxAgentEngine(factoryFor(chat, { coverage }), actions, undefined, {
        decisionProviders: fixtureDecisionProviders
      }).execute(
        {
          ...baseRequest(new AbortController().signal),
          memory: { user: [], agent: [] },
          messages: [{ role: 'user', content: userRequest }],
          limits: { maxTurns: 3, maxToolCalls: 1, maxOutputTokens: 512 }
        },
        { text, event }
      )
      expect(invoke).toHaveBeenCalledOnce()
      expect(invoke).toHaveBeenCalledWith('memory.manage', input, expect.any(AbortSignal), 'save-preference')
      expect(drafts.length).toBeGreaterThan(0)
      expect(event.mock.calls.filter(([type]) => type === 'tool.completed')).toHaveLength(1)
      expect(event.mock.calls.filter(([type]) => type === 'tool.failed')).toEqual([])
      expect(coverage).toHaveBeenCalledTimes(mode !== 'operation-only' && !disclose ? drafts.length : 0)
      expect(result.citations).toBeUndefined()
      return { result, drafts, published: visibleWikiText(text.mock.calls.map(([delta]) => delta).join('')).trim() }
    }

    it.each(['source', 'source-and-recent'] as const)('does not let a delivered receipt hide an unanswered explicit %s obligation', async mode => {
      const { result, drafts, published } = await receiptFixture(mode, false)
      for (const draft of drafts)
        expect(draft).toEqual({
          claims: [],
          attachmentClaims: [],
          observations: [receiptLine],
          unresolvedFacets: []
        })
      // A host may reject/repair this draft or conservatively qualify it, but
      // neither the operation receipt nor a generic recent-window notice answers
      // the independently declared source question.
      expect(result.executionLimit?.reason).toBe('evidence')
      expect(published).not.toBe(receiptLine)
      if (published.includes(receiptLine)) {
        expect(published).toContain(sourceQuestion)
        expect(published).toMatch(/not established|unverified|unresolved|not verified|not supported/iu)
      } else {
        expect(published).toMatch(/couldn't complete a source-verified answer|cannot establish|unable/iu)
      }
    })

    it('accepts the trusted receipt for an operation-only request without declaring its fallback source facet unresolved', async () => {
      const { result, published } = await receiptFixture('operation-only', false)
      expect(result.executionLimit).toBeUndefined()
      expect(published).toBe(receiptLine)
    })

    it('retains the trusted receipt and explicit limitations for a truthfully unresolved mixed source and recent request', async () => {
      const { result, drafts, published } = await receiptFixture('source-and-recent', true)
      expect(drafts).toHaveLength(1)
      expect(drafts[0]?.unresolvedFacets).toEqual([0, 1])
      expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'partial' })
      expect(published).toContain(receiptLine)
      expect(published).toContain(sourceQuestion)
      expect(published).toContain(recentQuestion)
      expect(published).toMatch(/not established/iu)
    })
  })

  it('discloses an unresolved comparison side when the first and only turn publishes sourced partial findings', async () => {
    const chat = vi.fn(
      async (input: Readonly<AxChatRequest<unknown>>) =>
        ({
          results: [
            {
              index: 0,
              content: synthesisFixtureAnswer(input, {
                claims: [{ evidenceId: 'page:1:revision:rev-1', statement: 'Alpha requires review.' }],
                unresolvedFacets: [0]
              })
            }
          ]
        }) satisfies AxChatResponse
    )
    const text = vi.fn(async () => {})
    const result = await new AxAgentEngine(
      factoryFor(chat),
      pageEvidenceActions(async () => true),
      undefined,
      { decisionProviders: fixtureDecisionProviders }
    ).execute(
      {
        ...baseRequest(new AbortController().signal),
        messages: [{ role: 'user', content: 'Compare the publication requirements of Alpha and Beta.' }],
        limits: { maxTurns: 1, maxToolCalls: 1, maxOutputTokens: 512 },
        research: {
          packets: [],
          incompleteTasks: [],
          evidenceSeeds: [
            {
              taskId: '00000000-0000-4000-8000-000000000021',
              subagentRunId: '00000000-0000-4000-8000-000000000031',
              actionCallId: 'alpha-read',
              actionName: 'pages.get',
              output: {
                id: 1,
                locale: 'en',
                path: 'alpha',
                title: 'Alpha',
                contentType: 'markdown',
                sourceRevision: 'rev-1',
                content: 'Alpha requires review.',
                citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
                citationSections: []
              }
            }
          ]
        }
      },
      { text, event: async () => {} }
    )

    const published = text.mock.calls.map(([delta]) => delta).join('')
    expect(visibleWikiText(published)).toContain('Alpha requires review.')
    expect(published).toContain('[[cite:page:1:revision:rev-1]]')
    expect(result.citations).toEqual([expect.objectContaining({ evidenceId: 'page:1:revision:rev-1' })])
    expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'partial' })
    const disclosure = published.slice(published.indexOf('[[cite:page:1:revision:rev-1]]') + '[[cite:page:1:revision:rev-1]]'.length)
    expect(disclosure).toMatch(/Beta/iu)
    expect(disclosure).toMatch(/not established|unverified|unresolved|not verified|not supported/iu)
    expect(visibleWikiText(published)).not.toContain('Beta requires audit.')
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
  ] as const)('adaptable child transfer requires a resident complete %s dependency', async (_dependency, template, fact) => {
    const citation = 'page:1:revision:rev-1'
    const answer = `${fact} [[cite:${citation}]]`
    const independentFact = 'The contact office opens at 09:00.'
    const independentAnswer = `${independentFact} [[cite:${citation}]]`
    for (const delivery of ['complete', 'padded', 'missing'] as const) {
      const complete = delivery !== 'missing'
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
      const evidence = {
        id: 1,
        locale: 'en',
        path: 'contacts',
        title: 'Contacts',
        contentType: 'markdown',
        sourceRevision: 'rev-1',
        content,
        citation: { evidenceId: citation, label: 'Contacts', href: '/en/contacts' },
        citationSections: []
      }
      const text = vi.fn(async (_delta: string) => {})
      const event = vi.fn(async (..._args: [string, unknown]) => {})
      let turn = 0
      const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
        if (offersCollectionFinish(input)) return finishCollectionResponse
        const statement = ++turn === 1 ? fact : independentFact
        const sources = synthesisSourcesFromRequest(input)
        const source = sources.find(
          unit => unit.evidenceId === citation && (turn === 1 ? unit.text.includes('Maya Quinn') : unit.text.includes(independentFact))
        )
        return {
          results: [
            {
              index: 0,
              content: synthesisFixtureAnswer(input, {
                claims: [{ evidenceId: citation, sourceRevision: 'rev-1', sourceRef: source?.sourceRef ?? 'sAAAAAAAAAAAAAAAA', statement }],
                unresolvedFacets: turn > 1 ? [0] : []
              })
            }
          ]
        } satisfies AxChatResponse
      })
      const result = await new AxAgentEngine(
        factoryFor(chat),
        pageEvidenceActions(async () => true),
        undefined,
        {
          decisionProviders: delivery === 'missing' ? rejectFixtureStatements([fact]) : fixtureDecisionProviders
        }
      ).execute(
        {
          ...baseRequest(new AbortController().signal),
          messages: [{ role: 'user', content: `Contact office lookup: what does the contact record establish about ${fact}?` }],
          limits: { maxTurns: 3, maxToolCalls: 1, maxOutputTokens: 512 },
          research: {
            packets: [],
            incompleteTasks: [],
            evidenceSeeds: [
              {
                taskId: '00000000-0000-4000-8000-000000000021',
                subagentRunId: '00000000-0000-4000-8000-000000000031',
                actionCallId: 'child-contact-read',
                actionName: 'pages.get',
                output: evidence
              }
            ]
          }
        },
        { text, event }
      )
      const published = text.mock.calls.map(([delta]) => delta).join('')
      if (complete) {
        expect(synthesisReadsFromRequest(chat.mock.calls.at(-1)![0])).toEqual([expect.objectContaining({ readText: content, complete: true })])
        expect(visibleWikiText(published)).toBe(visibleWikiText(answer))
        expect(result.citations?.map(item => item.evidenceId)).toEqual([citation])
        expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').at(-1)?.[1]).toMatchObject({ accepted: true })
      } else {
        expect(visibleWikiText(published)).not.toContain(visibleWikiText(`${fact} [[cite:${citation}]]`))
        expect(visibleWikiText(published)).toContain(visibleWikiText(independentAnswer))
        expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'partial' })
        expect(result.citations?.map(item => item.evidenceId)).toEqual([citation])
        expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').at(0)?.[1]).toMatchObject({ accepted: false })
        expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').at(-1)?.[1]).toMatchObject({ accepted: true })
      }
      expect(published).toContain(`[[cite:${citation}]]`)
    }
  })

  it('delivers adjacent paragraph assertions from the complete child read under canonical physical-read authority', async () => {
    const citation = 'page:42:revision:1'
    const visibleFact = 'Maya Quinn handles northern orders.'
    const unseenFact = 'Noah Bell handles southern orders.'
    const content = `# Contacts\n\n${visibleFact}\n\n${unseenFact} ${'Operational background remains unchanged. '.repeat(900)}`
    const text = vi.fn(async (_delta: string) => {})
    const event = vi.fn(async (..._args: [string, unknown]) => {})
    let turn = 0
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      if (offersCollectionFinish(input)) return finishCollectionResponse
      const statement = ++turn === 1 ? `${visibleFact} ${unseenFact}` : visibleFact
      const sources = synthesisSourcesFromRequest(input)
      expect(synthesisReadsFromRequest(input)).toEqual([expect.objectContaining({ readText: content, complete: true })])
      const source = sources.find(read => read.evidenceId === citation && read.text.includes(unseenFact))
      if (source === undefined) throw new Error('The complete canonical child read must remain selectable')
      return {
        results: [
          {
            index: 0,
            content: synthesisFixtureAnswer(input, {
              claims: [{ ...source, statement }],
              unresolvedFacets: turn > 1 ? [0] : []
            })
          }
        ]
      } satisfies AxChatResponse
    })
    const result = await new AxAgentEngine(
      factoryFor(chat),
      pageEvidenceActions(async () => true),
      undefined,
      { decisionProviders: fixtureDecisionProviders }
    ).execute(
      {
        ...baseRequest(new AbortController().signal),
        currentPage: { id: 42, locale: 'en', path: 'contacts' },
        messages: [{ role: 'user', content: 'Summarize the current page.' }],
        limits: { maxTurns: 3, maxToolCalls: 1, maxOutputTokens: 512 },
        research: {
          packets: [],
          incompleteTasks: [],
          evidenceSeeds: [
            {
              taskId: '00000000-0000-4000-8000-000000000021',
              subagentRunId: '00000000-0000-4000-8000-000000000031',
              actionCallId: 'child-partial-summary',
              actionName: 'pages.get',
              output: {
                id: 42,
                locale: 'en',
                path: 'contacts',
                title: 'Contacts',
                contentType: 'markdown',
                sourceRevision: '1',
                content,
                citation: { evidenceId: 'page:42:revision:1', label: 'Contacts', href: '/en/contacts' },
                citationSections: [{ evidenceId: `${citation}:section:1`, label: 'Contacts', href: '/en/contacts#contacts' }]
              }
            }
          ]
        }
      },
      { text, event }
    )
    const published = text.mock.calls.map(([delta]) => delta).join('')
    expect(visibleWikiText(published)).toContain(unseenFact)
    expect(visibleWikiText(published)).toContain(visibleFact)
    expect(visibleWikiText(published)).not.toContain('Operational background remains unchanged.')
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').at(0)?.[1]).toMatchObject({ accepted: true })
    expect(turn).toBe(1)
    expect(published).toContain(`[[cite:${citation}]]`)
    expect(result.citations?.map(item => item.evidenceId)).toEqual([citation])
  })
  it('does not trust child evidence seeds without a host page validator', async () => {
    const evidence = {
      id: 1,
      locale: 'en',
      path: 'alpha',
      title: 'Alpha',
      contentType: 'markdown',
      sourceRevision: 'rev-1',
      content: 'Alpha requires review.',
      citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
      citationSections: []
    }
    const calls: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      calls.push(input)
      return { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1:revision:rev-1]]' }] }
    })
    const text = vi.fn(async () => {})
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      limits: { maxTurns: 1, maxToolCalls: 1, maxOutputTokens: 256 },
      research: {
        packets: [],
        incompleteTasks: [],
        evidenceSeeds: [
          {
            taskId: '00000000-0000-4000-8000-000000000021',
            subagentRunId: '00000000-0000-4000-8000-000000000031',
            actionCallId: 'alpha-read',
            actionName: 'pages.get',
            output: evidence
          }
        ]
      }
    }

    const response = await new AxAgentEngine(factoryFor(chat), pageEvidenceActions(), undefined, { decisionProviders: fixtureDecisionProviders }).execute(
      request,
      { text, event: async () => {} }
    )
    expect(response).toMatchObject({ executionLimit: { reason: 'evidence', publication: 'inability' } })
    expect(calls[0]?.chatPrompt.some(message => message.role === 'user' && message.content === 'Alpha requires review.')).toBe(false)
    expect(text.mock.calls.map(([delta]) => delta).join('')).not.toContain('Alpha requires review.')
  })

  it('accepts conflict-only specialist packets after two owned page reads', async () => {
    const taskId = '00000000-0000-4000-8000-000000000041'
    const subagentRunId = '00000000-0000-4000-8000-000000000042'
    const packet = JSON.stringify({
      taskId,
      outcome: 'completed',
      claims: [],
      conflicts: [
        {
          claim: 'The alpha and beta runbooks prescribe different review requirements.',
          evidenceIds: ['page:1:revision:rev-1', 'page:2:revision:rev-2'],
          explanation: 'Alpha requires review while beta requires audit.'
        }
      ],
      unanswered: [],
      recommendedFollowups: []
    })
    const responses: AxChatResponse[] = [
      {
        results: [
          {
            index: 0,
            functionCalls: [
              { id: 'alpha-call', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } },
              { id: 'beta-call', type: 'function', function: { name: 'wiki_get_page', params: '{"id":2}' } }
            ]
          }
        ]
      },
      { results: [{ index: 0, content: packet }] }
    ]
    const chat = vi.fn(async () => responses.shift()!)
    const ownedSnapshots = new Set<string>()
    const invoke = vi.fn(async (_action: string, input: unknown) => {
      if (typeof input !== 'object' || input === null || !('id' in input) || typeof input.id !== 'number') throw new Error('Expected a numeric page id')
      const id = input.id
      const page = {
        id,
        locale: 'en',
        path: id === 1 ? 'alpha' : 'beta',
        sourceRevision: `rev-${id}`,
        title: id === 1 ? 'Alpha' : 'Beta',
        contentType: 'markdown',
        content: id === 1 ? 'Alpha requires review.' : 'Beta requires audit.',
        citation: { evidenceId: `page:${id}:revision:rev-${id}`, label: id === 1 ? 'Alpha' : 'Beta', href: `/en/${id === 1 ? 'alpha' : 'beta'}` },
        citationSections: []
      }
      ownedSnapshots.add(JSON.stringify(page))
      return page
    })
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        validateObservation: async (actionName, output, signal) => !signal.aborted && actionName === 'pages.get' && ownedSnapshots.has(JSON.stringify(output)),
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: 'c'.repeat(64)
      })
    }
    const text = vi.fn(async () => {})

    await new AxAgentEngine(factoryFor(chat), actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
      {
        ...baseRequest(new AbortController().signal),
        purpose: 'subagent',
        task: {
          id: taskId,
          kind: 'conflict_check',
          title: 'Compare runbooks',
          question: 'Where do the runbooks disagree?',
          sourceScope: ['alpha', 'beta'],
          requiredEvidenceCount: 2
        },
        subagentRunId,
        actionAllowlist: ['pages.get'],
        limits: { maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 2_048 }
      },
      { text, event: async () => {} }
    )

    expect(invoke).toHaveBeenCalledTimes(2)
    const deltas = text.mock.calls.map(([delta]) => delta)
    expect(deltas.join('')).toBe(packet)
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.length).toBeLessThanOrEqual(64)
  })

  it('rejects root synthesis until validated conflicts are explicitly disclosed', async () => {
    const responses: AxChatResponse[] = [
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1:revision:rev-1]] Beta requires audit. [[cite:page:2:revision:rev-2]]' }] },
      { results: [{ index: 0, content: 'Alpha requires review. [[cite:page:1:revision:rev-1]] However, beta requires audit. [[cite:page:2:revision:rev-2]]' }] }
    ]
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => (offersCollectionFinish(input) ? finishCollectionResponse : responses.shift()!))
    const event = vi.fn(async (...args: [string, unknown]) => {
      void args
    })
    const taskId = '00000000-0000-4000-8000-000000000051'
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      research: {
        packets: [
          {
            task: {
              id: taskId,
              kind: 'conflict_check',
              title: 'Compare runbooks',
              question: 'Where do the runbooks disagree?',
              sourceScope: ['alpha', 'beta'],
              requiredEvidenceCount: 2
            },
            packet: {
              taskId,
              outcome: 'completed',
              claims: [],
              conflicts: [
                {
                  claim: 'The runbooks prescribe different review requirements.',
                  evidenceIds: ['page:1:revision:rev-1', 'page:2:revision:rev-2'],
                  explanation: 'Alpha requires review while beta requires audit.'
                }
              ],
              unanswered: [],
              recommendedFollowups: []
            },
            evidenceIds: ['page:1:revision:rev-1', 'page:2:revision:rev-2'],
            conflictEvidenceGroups: [['page:1:revision:rev-1', 'page:2:revision:rev-2']]
          }
        ],
        incompleteTasks: [],
        evidenceSeeds: [
          {
            taskId,
            subagentRunId: '00000000-0000-4000-8000-000000000052',
            actionCallId: 'alpha-read',
            actionName: 'pages.get',
            output: {
              id: 1,
              locale: 'en',
              path: 'alpha',
              title: 'Alpha',
              contentType: 'markdown',
              sourceRevision: 'rev-1',
              content: 'Alpha requires review.',
              citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
              citationSections: []
            }
          },
          {
            taskId,
            subagentRunId: '00000000-0000-4000-8000-000000000053',
            actionCallId: 'beta-read',
            actionName: 'pages.get',
            output: {
              id: 2,
              locale: 'en',
              path: 'beta',
              title: 'Beta',
              contentType: 'markdown',
              sourceRevision: 'rev-2',
              content: 'Beta requires audit.',
              citation: { evidenceId: 'page:2:revision:rev-2', label: 'Beta', href: '/en/beta' },
              citationSections: []
            }
          }
        ]
      }
    }
    const text = vi.fn(async () => {})

    await new AxAgentEngine(
      factoryFor(chat),
      pageEvidenceActions(async () => true),
      undefined,
      { decisionProviders: fixtureDecisionProviders }
    ).execute(request, { text, event })

    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })])
    expect(event.mock.calls.filter(([type]) => type === 'evidence.provenance').map(([, data]) => data)).toEqual([
      expect.objectContaining({ accepted: false, issues: expect.arrayContaining([expect.stringContaining('explicitly disclosing')]) }),
      expect.objectContaining({ accepted: true, finalCitationIds: ['page:1:revision:rev-1', 'page:2:revision:rev-2'] })
    ])
    const published = text.mock.calls.map(([delta]) => delta).join('')
    expect(visibleWikiText(published)).toContain('Alpha requires review.')
    expect(visibleWikiText(published)).toContain('However, beta requires audit.')
    expect(published).toContain('[[cite:page:1:revision:rev-1]]')
    expect(published).toContain('[[cite:page:2:revision:rev-2]]')
  })
  it('keeps a post-dispatch reservation unsettled when rejecting a post-response capability violation', async () => {
    const response = {
      results: [
        {
          index: 0,
          functionCalls: [
            { id: 'first', type: 'function' as const, function: { name: 'wiki_get_page', params: '{"id":1}' } },
            { id: 'second', type: 'function' as const, function: { name: 'wiki_get_page', params: '{"id":2}' } }
          ]
        }
      ],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 7, completionTokens: 5, totalTokens: 12 } }
    } satisfies AxChatResponse
    const chat = vi.fn<AgentProviderService['service']['chat']>(async (_request, options) => {
      options?.onRequestDispatched?.()
      return response
    })
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: false,
          structuredOutput: 'native-json-schema',
          usage: 'terminal',
          cancellation: true,
          maxContextTokens: 100_000,
          maxOutputTokens: 4_000
        },
        transportKind: 'openai-responses',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const reservation = { id: 'reservation', tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => reservation)
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const consumeTool = vi.fn(async () => {})
    const invoke = vi.fn(async () => ({}))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }

    await expect(
      Promise.resolve(
        new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
          {
            ...baseRequest(new AbortController().signal),
            dispatchBudget: { reserve, reconcile, release, consumeTool, unsettledExposure: { tokens: 0, costMicros: 0 } }
          },
          { text: async () => {}, event: async () => {} }
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })

    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  })
  it('keeps a post-dispatch reservation unsettled when rejecting an invalid response', async () => {
    const response = {
      results: [{ index: 0, content: '<wiki-tool-call>not-json</wiki-tool-call>' }],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 7, completionTokens: 5, totalTokens: 12 } }
    } satisfies AxChatResponse
    const chat = vi.fn<AgentProviderService['service']['chat']>(async (_request, options) => {
      options?.onRequestDispatched?.()
      return response
    })
    const factory = {
      create: async () => ({
        service: { chat },
        capabilities: {
          streaming: false,
          toolCalling: 'prompt',
          parallelToolCalls: false,
          structuredOutput: 'native-json-schema',
          usage: 'terminal',
          cancellation: true,
          maxContextTokens: 100_000,
          maxOutputTokens: 4_000
        },
        transportKind: 'openai-chat',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing
      })
    } as unknown as AgentProviderFactory
    const reservation = { id: 'reservation', tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => reservation)
    const reconcile = vi.fn(async () => {
      throw new Error('accounting unavailable')
    })
    const release = vi.fn(async () => {})
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke: vi.fn(async () => ({})),
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }

    const error = await new AxAgentEngine(factory, actions, undefined, { decisionProviders: fixtureDecisionProviders })
      .execute(
        {
          ...baseRequest(new AbortController().signal),
          dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
        },
        { text: async () => {}, event: async () => {} }
      )
      .catch(value => value)

    expect(error).toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it.each([undefined, 'error', 'content_filter'] as const)(
    'preserves an active dispatch reservation and settlement failure over terminal %s',
    async finishReason => {
      const response = {
        results: [{ index: 0, content: 'Bounded answer.', ...(finishReason === undefined ? {} : { finishReason }) }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 7, completionTokens: 5, totalTokens: 12 } }
      } satisfies AxChatResponse
      const reservation = { id: 1, tokens: 100_000, costMicros: 100_000 }
      const reserve = vi.fn(async () => reservation)
      const reconcile = vi.fn(async () => {
        throw new Error('accounting unavailable')
      })
      const release = vi.fn(async () => {})
      const consumeTool = vi.fn(async () => {})

      await expect(
        Promise.resolve(
          new AxAgentEngine(factoryFor(vi.fn(async () => response)), undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
            {
              ...baseRequest(new AbortController().signal),
              dispatchBudget: { reserve, reconcile, release, consumeTool, unsettledExposure: { tokens: 0, costMicros: 0 } }
            },
            { text: async () => {}, event: async () => {} }
          )
        )
      ).rejects.toMatchObject({ code: 'PROVIDER_REQUEST_FAILED', stage: 'usage_reconciliation', message: 'Agent inference failed' })

      expect(reconcile).toHaveBeenCalledWith(reservation, { inputTokens: 7, outputTokens: 5, totalTokens: 12, costMicros: 17 })
      expect(reconcile).toHaveBeenCalledOnce()
      expect(release).not.toHaveBeenCalled()
    }
  )
  it('uses the admitted request and configured output exposure for estimated usage when the provider omits usage', async () => {
    const chat = vi.fn(async () => ({ results: [{ index: 0, content: 'Estimated answer.' }] }) satisfies AxChatResponse)
    const reserve = vi.fn(async (maximum: { readonly tokens: number; readonly costMicros: number }) => ({ id: 1, ...maximum }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const dispatchBudget = { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
    const result = await new AxAgentEngine(factoryFor(chat, { usage: 'estimated' }), undefined, undefined, {
      decisionProviders: fixtureDecisionProviders
    }).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner', dispatchBudget }, { text: async () => {}, event: async () => {} })
    const admitted = reserve.mock.calls[0]?.[0]
    expect(admitted).toBeDefined()
    const expectedAdmissionCost = admitted!.tokens * 2
    expect(admitted!.costMicros).toBe(expectedAdmissionCost)
    expect(result).toMatchObject({
      inputTokens: admitted!.tokens - 4_000,
      outputTokens: 4_000,
      totalTokens: admitted!.tokens,
      costMicros: expectedAdmissionCost
    })
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ tokens: admitted!.tokens, costMicros: expectedAdmissionCost }), {
      inputTokens: admitted!.tokens - 4_000,
      outputTokens: 4_000,
      totalTokens: admitted!.tokens,
      costMicros: expectedAdmissionCost
    })
    expect(release).not.toHaveBeenCalled()
  })
  it('prices a reported directional receipt below the conservative estimated exposure', async () => {
    const response = {
      results: [{ index: 0, content: 'Measured answer.' }],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1_326, completionTokens: 4_000, totalTokens: 5_326 } }
    } satisfies AxChatResponse
    const chat = vi.fn(async () => response)
    const reserve = vi.fn(async (maximum: { readonly tokens: number; readonly costMicros: number }) => ({ id: 1, ...maximum }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const dispatchBudget = { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
    const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), undefined, undefined, {
      decisionProviders: fixtureDecisionProviders
    }).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner', dispatchBudget }, { text: async () => {}, event: async () => {} })
    const admitted = await reserve.mock.results[0]!.value
    expect(admitted).toBeDefined()
    expect(admitted.costMicros).toBeGreaterThanOrEqual(9_326)
    expect(admitted.costMicros).toBe(admitted.tokens * 2)
    expect(result).toMatchObject({ inputTokens: 1_326, outputTokens: 4_000, totalTokens: 5_326, costMicros: 9_326 })
    expect(reconcile).toHaveBeenCalledWith(admitted, {
      inputTokens: 1_326,
      outputTokens: 4_000,
      totalTokens: 5_326,
      costMicros: 9_326
    })
    expect(admitted.costMicros).toBeGreaterThan(result.costMicros)
    expect(release).not.toHaveBeenCalled()
  })

  it('rejects terminal, mismatched, and malformed provider usage without releasing a post-dispatch reservation', async () => {
    const reservation = { id: 1, tokens: 100_000, costMicros: 100_000 }
    const runCase = async (
      response: AxChatResponse | ReadableStream<AxChatResponse>,
      options: { readonly streaming?: boolean; readonly usage?: 'stream' | 'terminal' | 'estimated' }
    ) => {
      const reserve = vi.fn(async () => reservation)
      const reconcile = vi.fn(async () => {})
      const release = vi.fn(async () => {})
      const dispatchBudget = { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      await expect(
        new AxAgentEngine(
          factoryFor(
            vi.fn(async () => response),
            options
          ),
          undefined,
          undefined,
          { decisionProviders: fixtureDecisionProviders }
        ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner', dispatchBudget }, { text: async () => {}, event: async () => {} })
      ).rejects.toMatchObject({ code: 'PROVIDER_USAGE_INVALID' })
      return { release, reconcile }
    }

    const missing = await runCase({ results: [{ index: 0, content: 'missing' }] }, { usage: 'terminal' })
    const unsafe = await runCase(
      {
        results: [{ index: 0, content: 'unsafe' }],
        modelUsage: {
          ai: 'test',
          model: 'gpt-test',
          tokens: { promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER }
        }
      },
      { usage: 'terminal' }
    )
    expect(unsafe.reconcile).not.toHaveBeenCalled()
    expect(unsafe.release).not.toHaveBeenCalled()
    const underrun = await runCase(
      {
        results: [{ index: 0, content: 'underrun' }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 3, totalTokens: 4 } }
      },
      { usage: 'terminal' }
    )
    expect(underrun.reconcile).not.toHaveBeenCalled()
    expect(underrun.release).not.toHaveBeenCalled()
    expect(missing.reconcile).not.toHaveBeenCalled()
    expect(missing.release).not.toHaveBeenCalled()
    const malformedStream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'malformed' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: Number.NaN, completionTokens: 2, totalTokens: 2 } }
        } as unknown as AxChatResponse)
        controller.close()
      }
    })
    const malformed = await runCase(malformedStream, { streaming: true, usage: 'stream' })
    expect(malformed.reconcile).not.toHaveBeenCalled()
    expect(malformed.release).not.toHaveBeenCalled()
  })
  it('reconciles exactly additive provider usage once', async () => {
    const response = {
      results: [{ index: 0, content: 'Exactly accounted answer.' }],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }
    } satisfies AxChatResponse
    const reservation = { id: 1, tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => reservation)
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const chat = vi.fn(async () => response)
    const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), undefined, undefined, {
      decisionProviders: fixtureDecisionProviders
    }).execute(
      {
        ...baseRequest(new AbortController().signal),
        purpose: 'planner',
        dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      },
      { text: async () => {}, event: async () => {} }
    )

    expect(result).toMatchObject({ inputTokens: 2, outputTokens: 3, totalTokens: 5, costMicros: 8 })
    expect(reconcile).toHaveBeenCalledOnce()
    expect(reconcile).toHaveBeenCalledWith(reservation, { inputTokens: 2, outputTokens: 3, totalTokens: 5, costMicros: 8 })
    expect(release).not.toHaveBeenCalled()
  })

  it('cancels an internally inconsistent stream before releasing its reader and leaves exposure unsettled', async () => {
    const reservation = { id: 1, tokens: 100_000, costMicros: 100_000 }
    const reserve = vi.fn(async () => reservation)
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    let cancelCalls = 0
    let resolveCancelStarted!: () => void
    let resolveCancel!: () => void
    const cancelStarted = new Promise<void>(resolve => {
      resolveCancelStarted = resolve
    })
    let cancelReason: unknown
    const stream = new ReadableStream<AxChatResponse>({
      start(controller) {
        controller.enqueue({
          results: [{ index: 0, content: 'partial' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } }
        })
        controller.enqueue({
          results: [{ index: 0, content: 'remainder' }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 3, totalTokens: 4 } }
        })
      },
      cancel(reason) {
        cancelCalls += 1
        cancelReason = reason
        resolveCancelStarted()
        return new Promise<void>(resolve => {
          resolveCancel = resolve
        })
      }
    })
    const chat = vi.fn(async () => stream)
    const text = vi.fn(async () => {})
    const execution = new AxAgentEngine(factoryFor(chat, { streaming: true, usage: 'stream' }), undefined, undefined, {
      decisionProviders: fixtureDecisionProviders
    }).execute(
      {
        ...baseRequest(new AbortController().signal),
        purpose: 'planner',
        dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      },
      { text, event: async () => {} }
    )
    let settled = false
    const observed = execution.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await cancelStarted
    expect(settled).toBe(false)
    expect(stream.locked).toBe(true)
    expect(cancelReason).toBe('provider stream failed')
    expect(cancelCalls).toBe(1)
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()

    resolveCancel()
    await expect(execution).rejects.toMatchObject({ code: 'PROVIDER_USAGE_INVALID', stage: 'provider_response' })
    await observed
    expect(stream.locked).toBe(false)
    expect(text).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(chat).toHaveBeenCalledOnce()
  })

  it('retains exposure for lost responses, interrupted streams, and reconciliation failures', async () => {
    const reservation = { id: 1, tokens: 100_000, costMicros: 100_000 }
    const runCase = async (chat: AgentProviderService['service']['chat'], factory: AgentProviderFactory = factoryFor(chat)) => {
      const reserve = vi.fn(async () => reservation)
      const reconcile = vi.fn(async () => {
        throw new Error('accounting unavailable')
      })
      const release = vi.fn(async () => {})
      const dispatchBudget = { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
      const text = vi.fn(async (_delta: string) => {})
      const event = vi.fn(async (_type: string, _data: unknown) => {})
      let failure: unknown
      await expect(
        new AxAgentEngine(factory, undefined, undefined, { decisionProviders: fixtureDecisionProviders })
          .execute({ ...baseRequest(new AbortController().signal), purpose: 'planner', dispatchBudget }, { text, event })
          .catch(error => {
            failure = error
            throw error
          })
      ).rejects.toMatchObject({ message: 'Agent inference failed' })
      return { release, reconcile, text, event, failure }
    }

    const lost = await runCase(
      vi.fn(async () => {
        throw new Error('lost response')
      })
    )
    expect(lost.reconcile).not.toHaveBeenCalled()
    expect(lost.release).not.toHaveBeenCalled()

    let pulls = 0
    const stream = new ReadableStream<AxChatResponse>(
      {
        pull(controller) {
          pulls += 1
          if (pulls === 1) {
            controller.enqueue({
              results: [{ index: 0, content: 'partial' }],
              modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
            })
          } else controller.error(new Error('stream lost'))
        }
      },
      { highWaterMark: 0 }
    )
    const interrupted = await runCase(
      vi.fn(async () => stream),
      factoryFor(
        vi.fn(async () => stream),
        { streaming: true, usage: 'stream' }
      )
    )
    expect(interrupted.reconcile).not.toHaveBeenCalled()
    expect(interrupted.release).not.toHaveBeenCalled()
    expect(pulls).toBe(2)
    expect(interrupted.failure).toMatchObject({ stage: 'provider_stream' })
    expect(interrupted.text).not.toHaveBeenCalled()
    expect(interrupted.event).not.toHaveBeenCalled()

    const rejected = await runCase(
      vi.fn(async () => ({
        results: [{ index: 0, content: 'answer' }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
      }))
    )
    expect(rejected.reconcile).toHaveBeenCalledOnce()
    expect(rejected.release).not.toHaveBeenCalled()
  })

  it('rejects an under-covered dispatch before calling the provider and releases only that pre-dispatch reservation', async () => {
    const chat = vi.fn(async () => ({ results: [{ index: 0, content: 'unused' }] }) satisfies AxChatResponse)
    const reserve = vi.fn(async () => ({ id: 1, tokens: 0, costMicros: 0 }))
    const release = vi.fn(async () => {})
    const dispatchBudget = {
      reserve,
      reconcile: vi.fn(async () => {}),
      release,
      consumeTool: vi.fn(async () => {}),
      unsettledExposure: { tokens: 0, costMicros: 0 }
    }
    await expect(
      new AxAgentEngine(factoryFor(chat), undefined, undefined, { decisionProviders: fixtureDecisionProviders }).execute(
        { ...baseRequest(new AbortController().signal), purpose: 'planner', dispatchBudget },
        { text: async () => {}, event: async () => {} }
      )
    ).rejects.toMatchObject({ stage: 'dispatch_admission' })
    expect(chat).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })
  it('accepts an exact multibyte content aggregate and rejects only its next byte', async () => {
    const content = `${'€'.repeat(43_690)}ab`
    expect(Buffer.byteLength(content, 'utf8')).toBe(131_072)
    const chunks = utf8Chunks(content, 32_768)
    expect(chunks.map(chunk => Buffer.byteLength(chunk, 'utf8'))).toEqual([32_766, 32_766, 32_766, 32_766, 8])
    expect(chunks.join('')).toBe(content)
    expect(chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= 32_768)).toBe(true)
    const usage = { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    const exactResponses = chunks.map(chunk => ({ results: [{ index: 0, content: chunk }], modelUsage: usage }) satisfies AxChatResponse)
    const exactText = vi.fn(async () => {})
    const exact = await new AxAgentEngine(
      factoryFor(async () => responseStream(exactResponses), { streaming: true, usage: 'stream', maxOutputTokens: 4_096 }),
      undefined,
      undefined,
      { decisionProviders: fixtureDecisionProviders }
    ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: exactText, event: async () => {} })
    expect(exact).toMatchObject({ inputTokens: 1, outputTokens: 1, totalTokens: 2 })
    expect(exactText.mock.calls.map(([value]) => value).join('')).toBe(content)

    let signal: AbortSignal | undefined
    let cancelCalls = 0
    const overflowStream = responseStream([...exactResponses, { results: [{ index: 0, content: 'x' }], modelUsage: usage } satisfies AxChatResponse], () => {
      cancelCalls += 1
      return Promise.reject(new Error('hostile stream cancellation'))
    })
    const chat: AgentProviderService['service']['chat'] = vi.fn(async (_request, options) => {
      signal = options?.abortSignal
      return overflowStream
    })
    const reserve = vi.fn(async () => ({ id: 1, tokens: 200_000, costMicros: 200_000 }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const event = vi.fn(async () => {})
    const text = vi.fn(async () => {})
    await expect(
      new AxAgentEngine(factoryFor(chat, { streaming: true, usage: 'stream', maxOutputTokens: 4_096 }), undefined, undefined, {
        decisionProviders: fixtureDecisionProviders
      }).execute(
        {
          ...baseRequest(new AbortController().signal),
          purpose: 'planner',
          dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
        },
        { text, event }
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(signal?.aborted).toBe(true)
    expect(cancelCalls).toBe(1)
    expect(text).not.toHaveBeenCalled()
    expect(event).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('retains bounded bytes when repeated argument fragments replace prior values', async () => {
    const argumentLarge = { value: 'x'.repeat(10_000) }
    const argumentSmall = { value: 'ok' }
    const collectionResponse: AxChatResponse = {
      results: [
        {
          index: 0,
          functionCalls: [
            { id: 'replace', type: 'function', function: { name: 'wiki_get_page', params: argumentLarge } },
            { id: 'replace', type: 'function', function: { name: 'wiki_get_page', params: argumentSmall } }
          ]
        }
      ],
      modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    }
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) =>
      synthesisInputFromRequest(input) === undefined
        ? collectionResponse
        : ({
            results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }],
            modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
          } satisfies AxChatResponse)
    )
    const invoke = vi.fn(async (_name: string, _input: unknown) => ({}))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read page', parameters: { type: 'object' }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const event = vi.fn(async () => {})
    const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions, undefined, {
      decisionProviders: fixtureDecisionProviders
    }).execute({ ...baseRequest(new AbortController().signal), purpose: 'root', limits: { maxTurns: 2, maxToolCalls: 1 } }, { text: async () => {}, event })
    expect(result).toMatchObject({ inputTokens: 3, outputTokens: 2, totalTokens: 5, executionLimit: { reason: 'evidence', publication: 'inability' } })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('pages.get', argumentSmall, expect.any(AbortSignal), 'replace')
    expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted', totalTokens: 3 })])
  })
  it('accepts an exact UTF-8 aggregate argument and rejects its next byte before tool execution', async () => {
    const argumentValue = `${'€'.repeat(21_842)}ab`
    const argument = `{"x":"${argumentValue}"}`
    expect(Buffer.byteLength(argument, 'utf8')).toBe(65_536)
    const chunks = utf8Chunks(argument, 32_768)
    expect(chunks.map(chunk => Buffer.byteLength(chunk, 'utf8'))).toEqual([32_766, 32_768, 2])
    expect(chunks.join('')).toBe(argument)
    expect(chunks.every(chunk => Buffer.byteLength(chunk, 'utf8') <= 32_768)).toBe(true)
    const usage = { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    const invoke = vi.fn(async (_name: string, _input: unknown) => ({}))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read page', parameters: { type: 'object' }, risk: 'read' }],
        invoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const firstStreamResponses: AxChatResponse[] = chunks.map(chunk => ({
      results: [{ index: 0, functionCalls: [{ id: 'exact-argument', type: 'function', function: { name: 'wiki_get_page', params: chunk } }] }],
      modelUsage: usage
    }))
    const exactChat: AgentProviderService['service']['chat'] = vi.fn(async input =>
      synthesisInputFromRequest(input) === undefined
        ? responseStream(firstStreamResponses)
        : ({
            results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }],
            modelUsage: { ...usage, tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
          } satisfies AxChatResponse)
    )
    const exactEvent = vi.fn(async () => {})
    const exact = await new AxAgentEngine(
      factoryFor(exactChat, {
        streaming: true,
        usage: 'stream',
        maxOutputTokens: 4_096
      }),
      actions,
      undefined,
      { decisionProviders: fixtureDecisionProviders }
    ).execute(
      { ...baseRequest(new AbortController().signal), purpose: 'root', limits: { maxTurns: 2, maxToolCalls: 1 } },
      { text: async () => {}, event: exactEvent }
    )
    expect(exact).toMatchObject({ totalTokens: 5, executionLimit: { reason: 'evidence', publication: 'inability' } })
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('pages.get', { x: argumentValue }, expect.any(AbortSignal), 'exact-argument')
    expect(exactEvent.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted', totalTokens: 3 })])

    const overflowResponses = chunks.map(chunk => ({
      results: [{ index: 0, functionCalls: [{ id: 'overflow-argument', type: 'function', function: { name: 'wiki_get_page', params: chunk } }] }],
      modelUsage: usage
    }))
    overflowResponses.push({
      results: [{ index: 0, functionCalls: [{ id: 'overflow-argument', type: 'function', function: { name: 'wiki_get_page', params: 'x' } }] }],
      modelUsage: usage
    })
    let cancelCalls = 0
    const overflowStream = responseStream(overflowResponses, () => (cancelCalls += 1))
    const overflowInvoke = vi.fn(async () => ({}))
    const overflowActions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read page', parameters: { type: 'object' }, risk: 'read' }],
        invoke: overflowInvoke,
        snapshot: async () => ({}),
        close: vi.fn(),
        authoritySha256: null
      })
    }
    const overflowText = vi.fn(async () => {})
    const overflowEvent = vi.fn(async () => {})
    await expect(
      new AxAgentEngine(
        factoryFor(async () => overflowStream, { streaming: true, usage: 'stream', maxOutputTokens: 4_096 }),
        overflowActions,
        undefined,
        { decisionProviders: fixtureDecisionProviders }
      ).execute({ ...baseRequest(new AbortController().signal), purpose: 'root' }, { text: overflowText, event: overflowEvent })
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(cancelCalls).toBe(1)
    expect(overflowInvoke).not.toHaveBeenCalled()
    expect(overflowText).not.toHaveBeenCalled()
    expect(overflowEvent).not.toHaveBeenCalled()
  })
  it('accepts exact UTF-8 call IDs and call counts but rejects the next unit', async () => {
    const usage = { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    const exactId = `${'€'.repeat(85)}a`
    expect(Buffer.byteLength(exactId, 'utf8')).toBe(256)
    type FunctionCalls = NonNullable<AxChatResponse['results'][number]['functionCalls']>
    const run = async (functionCalls: FunctionCalls) => {
      const response = { results: [{ index: 0, functionCalls }], modelUsage: usage } as unknown as AxChatResponse
      return new AxAgentEngine(
        factoryFor(async () => response, { maxOutputTokens: 4_096 }),
        undefined,
        undefined,
        { decisionProviders: fixtureDecisionProviders }
      ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: vi.fn(async () => {}), event: vi.fn(async () => {}) })
    }
    await expect(run([{ id: exactId, type: 'function', function: { name: 'wiki_get_page', params: '' } }])).rejects.toMatchObject({
      code: 'UNEXPECTED_PROVIDER_TOOL_CALL'
    })
    await expect(run([{ id: `${exactId}x`, type: 'function', function: { name: 'wiki_get_page', params: '' } }])).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      stage: 'provider_response'
    })
    const exactCalls = Array.from({ length: 32 }, (_, index) => ({
      id: `call-${index}`,
      type: 'function' as const,
      function: { name: 'wiki_get_page', params: '' }
    }))
    await expect(run(exactCalls)).rejects.toMatchObject({ code: 'UNEXPECTED_PROVIDER_TOOL_CALL' })
    await expect(run([...exactCalls, { id: 'call-32', type: 'function' as const, function: { name: 'wiki_get_page', params: '' } }])).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      stage: 'provider_response'
    })
  })

  it('rejects exact next-byte, depth, value, and size breaches before action or sink work', async () => {
    const runInvalid = async (params: object, expectedCode = 'INVALID_PROVIDER_RESPONSE') => {
      const invoke = vi.fn(async () => ({}))
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [{ name: 'pages.get', title: 'Read page', description: 'Read page', parameters: { type: 'object' }, risk: 'read' }],
          invoke,
          snapshot: async () => ({}),
          close: vi.fn(),
          authoritySha256: null
        })
      }
      const response = {
        results: [{ index: 0, functionCalls: [{ id: 'bounded', type: 'function' as const, function: { name: 'wiki_get_page', params } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
      } satisfies AxChatResponse
      const text = vi.fn(async () => {})
      const event = vi.fn(async () => {})
      const reserve = vi.fn(async () => ({ id: 1, tokens: 200_000, costMicros: 200_000 }))
      const reconcile = vi.fn(async () => {})
      const release = vi.fn(async () => {})
      await expect(
        new AxAgentEngine(
          factoryFor(async () => response, { maxOutputTokens: 4_096 }),
          actions,
          undefined,
          { decisionProviders: fixtureDecisionProviders }
        ).execute(
          {
            ...baseRequest(new AbortController().signal),
            dispatchBudget: { reserve, reconcile, release, consumeTool: vi.fn(async () => {}), unsettledExposure: { tokens: 0, costMicros: 0 } }
          },
          { text, event }
        )
      ).rejects.toMatchObject({ code: expectedCode, stage: 'provider_response' })
      expect(invoke).not.toHaveBeenCalled()
      expect(text).not.toHaveBeenCalled()
      expect(event).not.toHaveBeenCalled()
      expect(reconcile).not.toHaveBeenCalled()
      expect(release).not.toHaveBeenCalled()
    }

    const nested = (depth: number): Record<string, unknown> => {
      let value: Record<string, unknown> = { leaf: true }
      for (let index = 0; index < depth; index += 1) value = { next: value }
      return value
    }
    await runInvalid(nested(64))
    await runInvalid(Array.from({ length: 16_384 }, () => ''))
    await runInvalid({ value: 'x'.repeat(65_525) })
    await runInvalid({ value: '"'.repeat(32_762) + 'x' })
  })

  it('keeps exact structured depth/value/size boundaries admissible', async () => {
    const nested = (depth: number): Record<string, unknown> => {
      let value: Record<string, unknown> = { leaf: true }
      for (let index = 0; index < depth; index += 1) value = { next: value }
      return value
    }
    const cases: readonly object[] = [nested(63), Array.from({ length: 16_383 }, () => ''), { value: 'x'.repeat(65_524) }, { value: '"'.repeat(32_762) }]
    for (const params of cases) {
      const collectionResponse: AxChatResponse = {
        results: [{ index: 0, functionCalls: [{ id: 'exact', type: 'function', function: { name: 'wiki_get_page', params } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
      }
      const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) =>
        synthesisInputFromRequest(input) === undefined
          ? collectionResponse
          : ({
              results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }],
              modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 } }
            } satisfies AxChatResponse)
      )
      const invoke = vi.fn(async () => ({}))
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [{ name: 'pages.get', title: 'Read page', description: 'Read page', parameters: { type: 'object' }, risk: 'read' }],
          invoke,
          snapshot: async () => ({}),
          close: vi.fn(),
          authoritySha256: null
        })
      }
      const event = vi.fn(async () => {})
      const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions, undefined, {
        decisionProviders: fixtureDecisionProviders
      }).execute({ ...baseRequest(new AbortController().signal), purpose: 'root', limits: { maxTurns: 2, maxToolCalls: 1 } }, { text: async () => {}, event })
      expect(result).toMatchObject({ totalTokens: 5, executionLimit: { reason: 'evidence', publication: 'inability' } })
      expect(invoke).toHaveBeenCalledOnce()
      expect(invoke).toHaveBeenCalledWith('pages.get', params, expect.any(AbortSignal), 'exact')
      expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted', totalTokens: 3 })])
    }
  })
})

describe('provider fragment boundaries', () => {
  it('enforces response, result, argument, and thought fragment counts at their exact next item', async () => {
    const usage = { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    const lazyStream = (count: number, make: (index: number) => AxChatResponse, onCancel?: () => void): ReadableStream<AxChatResponse> => {
      let index = 0
      return new ReadableStream<AxChatResponse>(
        {
          pull(controller) {
            if (index >= count) {
              controller.close()
              return
            }
            controller.enqueue(make(index))
            index += 1
          },
          cancel() {
            onCancel?.()
          }
        },
        { highWaterMark: 0 }
      )
    }
    const executeStream = async (
      stream: ReadableStream<AxChatResponse>,
      options: { readonly preserveThoughtBlock?: AgentProviderService['preserveThoughtBlock']; readonly maxOutputTokens?: number } = {}
    ) =>
      new AxAgentEngine(
        factoryFor(async () => stream, { streaming: true, usage: 'stream', maxOutputTokens: options.maxOutputTokens ?? 4_096, ...options }),
        undefined,
        undefined,
        { decisionProviders: fixtureDecisionProviders }
      ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: vi.fn(async () => {}), event: vi.fn(async () => {}) })

    const exactResponses = lazyStream(65_536, () => ({ results: [], modelUsage: usage }) satisfies AxChatResponse)
    await executeStream(exactResponses)
    let responseCancelCalls = 0
    await expect(
      executeStream(
        lazyStream(
          65_537,
          () => ({ results: [], modelUsage: usage }) satisfies AxChatResponse,
          () => (responseCancelCalls += 1)
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(responseCancelCalls).toBe(1)

    const exactRecords = Array.from({ length: 65_536 }, () => ({ index: 0 }))
    await executeStream(
      responseStream([
        { results: exactRecords, modelUsage: usage },
        { results: [], modelUsage: usage }
      ] satisfies AxChatResponse[])
    )
    let resultCancelCalls = 0
    await expect(
      executeStream(
        responseStream(
          [
            { results: exactRecords, modelUsage: usage },
            { results: [{ index: 0 }], modelUsage: usage }
          ] satisfies AxChatResponse[],
          () => (resultCancelCalls += 1)
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(resultCancelCalls).toBe(1)
    const exactArguments = Array.from({ length: 65_536 }, () => ({
      id: 'argument',
      type: 'function' as const,
      function: { name: 'wiki_get_page', params: '' }
    }))

    let argumentCancelCalls = 0
    await expect(executeStream(responseStream([{ results: [{ index: 0, functionCalls: exactArguments }], modelUsage: usage }]))).rejects.toMatchObject({
      code: 'UNEXPECTED_PROVIDER_TOOL_CALL'
    })
    await expect(
      executeStream(
        responseStream(
          [
            {
              results: [
                {
                  index: 0,
                  functionCalls: [...exactArguments, { id: 'argument-next', type: 'function' as const, function: { name: 'wiki_get_page', params: '' } }]
                }
              ],
              modelUsage: usage
            }
          ],
          () => (argumentCancelCalls += 1)
        )
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(argumentCancelCalls).toBe(1)

    const thought = { data: 'x', encrypted: true } as const
    await executeStream(
      responseStream([{ results: [{ id: 'thought', index: 0, thoughtBlocks: Array.from({ length: 65_536 }, () => thought) }], modelUsage: usage }]),
      { preserveThoughtBlock: (_resultId, block) => block, maxOutputTokens: 16_384 }
    )
    let thoughtCancelCalls = 0
    await expect(
      executeStream(
        responseStream(
          [
            {
              results: [{ id: 'thought', index: 0, thoughtBlocks: Array.from({ length: 65_537 }, () => thought) }],
              modelUsage: usage
            }
          ],
          () => (thoughtCancelCalls += 1)
        ),
        { preserveThoughtBlock: (_resultId, block) => block, maxOutputTokens: 16_384 }
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(thoughtCancelCalls).toBe(1)
  })
  it('enforces exact thought aggregate bytes, signatures, and capacity-sensitive replacement', async () => {
    const usage = { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    const preserveThoughtBlock: AgentProviderService['preserveThoughtBlock'] = (_resultId, block) => block
    const data = 'x'.repeat(32_700)
    const signature = 's'.repeat(36)
    const fullBlocks = Array.from({ length: 4 }, (_, index) => ({
      id: `shrink_${index}`,
      index: 0,
      thoughtBlocks: [{ data, encrypted: true, signature }]
    }))
    await new AxAgentEngine(
      factoryFor(
        async () =>
          responseStream([
            { results: fullBlocks, modelUsage: usage },
            {
              results: [{ id: 'shrink_3', index: 0, thoughtBlocks: [{ data: 'x', encrypted: true, signature: 'small' }] }],
              modelUsage: usage
            },
            {
              results: [{ id: 'shrink_new', index: 0, thoughtBlocks: [{ data: 'x'.repeat(32_662), encrypted: true, signature }] }],
              modelUsage: usage
            }
          ]),
        { streaming: true, usage: 'stream', maxOutputTokens: 4_096, preserveThoughtBlock }
      ),
      undefined,
      undefined,
      { decisionProviders: fixtureDecisionProviders }
    ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: async () => {}, event: async () => {} })

    const growthBlocks = Array.from({ length: 4 }, (_, index) => ({
      id: `growth_${index}`,
      index: 0,
      thoughtBlocks: [{ data, encrypted: true, signature }]
    }))
    let growthCancelCalls = 0
    await expect(
      new AxAgentEngine(
        factoryFor(
          async () =>
            responseStream(
              [
                { results: growthBlocks, modelUsage: usage },
                {
                  results: [{ id: 'growth_3', index: 0, thoughtBlocks: [{ data, encrypted: true, signature: `${signature}s` }] }],
                  modelUsage: usage
                }
              ],
              () => (growthCancelCalls += 1)
            ),
          { streaming: true, usage: 'stream', maxOutputTokens: 4_096, preserveThoughtBlock }
        ),
        undefined,
        undefined,
        { decisionProviders: fixtureDecisionProviders }
      ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: async () => {}, event: async () => {} })
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(growthCancelCalls).toBe(1)

    await new AxAgentEngine(
      factoryFor(
        async () =>
          responseStream([
            {
              results: [{ id: 'signature-exact', index: 0, thoughtBlocks: [{ data: 'x', encrypted: true, signature: 's'.repeat(131_039) }] }],
              modelUsage: usage
            }
          ]),
        { streaming: true, usage: 'stream', maxOutputTokens: 4_096, preserveThoughtBlock }
      ),
      undefined,
      undefined,
      { decisionProviders: fixtureDecisionProviders }
    ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: async () => {}, event: async () => {} })

    let signatureCancelCalls = 0
    await expect(
      new AxAgentEngine(
        factoryFor(
          async () =>
            responseStream(
              [
                {
                  results: [{ id: 'signature-next', index: 0, thoughtBlocks: [{ data: 'x', encrypted: true, signature: 's'.repeat(131_040) }] }],
                  modelUsage: usage
                }
              ],
              () => (signatureCancelCalls += 1)
            ),
          { streaming: true, usage: 'stream', maxOutputTokens: 4_096, preserveThoughtBlock }
        ),
        undefined,
        undefined,
        { decisionProviders: fixtureDecisionProviders }
      ).execute({ ...baseRequest(new AbortController().signal), purpose: 'planner' }, { text: async () => {}, event: async () => {} })
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE', stage: 'provider_response' })
    expect(signatureCancelCalls).toBe(1)
  })
})

describe('engine preflight', () => {
  it('rejects the frozen oversized child at execution before reserving or dispatching after preflight', async () => {
    const chat = vi.fn(async () => {
      throw new Error('preflight must not call the provider')
    })
    const invoke = vi.fn(async () => {
      throw new Error('preflight must not invoke Wiki actions')
    })
    const close = vi.fn()
    const open = vi.fn(async () => ({
      authoritySha256: null,
      functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object' }, risk: 'read' }],
      invoke,
      snapshot: async () => ({}),
      close
    }))
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      purpose: 'subagent',
      actionAllowlist: ['pages.get'],
      task: {
        id: '00000000-0000-4000-8000-000000000021',
        kind: 'source_scout',
        title: 'Review alpha',
        question: 'What does alpha require?',
        sourceScope: ['alpha'],
        requiredEvidenceCount: 1
      },
      subagentRunId: '00000000-0000-4000-8000-000000000022',
      messages: [{ role: 'user', content: 'x'.repeat(8_000) }],
      limits: { maxTokens: 6_000, maxTurns: 4, maxToolCalls: 8, maxOutputTokens: 2_048 }
    }
    const engine = new AxAgentEngine(factoryFor(chat), { open } as unknown as AgentActionSessionProvider, undefined, {
      decisionProviders: fixtureDecisionProviders
    })

    const result = await engine.preflight(request)

    expect(result.outputExposureTokens).toBe(2_048)
    expect(result.totalExposureTokens).toBe(result.inputExposureTokens + result.outputExposureTokens)
    expect(result.totalExposureTokens).toBeGreaterThan(6_000)
    expect(result.admissible).toBe(false)
    expect(open).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    const reserve = vi.fn(async (maximum: { readonly tokens: number; readonly costMicros: number }) => ({ id: 1, ...maximum }))
    const reconcile = vi.fn(async () => {})
    const release = vi.fn(async () => {})
    const consumeTool = vi.fn(async () => {})
    const text = vi.fn(async () => {})
    await expect(
      engine.execute(
        {
          ...request,
          dispatchBudget: { reserve, reconcile, release, consumeTool, unsettledExposure: { tokens: 0, costMicros: 0 } }
        },
        { text, event: async () => {} }
      )
    ).rejects.toMatchObject({ code: 'AGENT_CHILD_BUDGET_EXCEEDED' })
    expect(reserve).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(consumeTool).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    expect(chat).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(2)
  })
})

describe('child aggregate budget reservations', () => {
  it('admits concurrent children atomically and reconstructs retry headroom from measured usage', () => {
    const limits = {
      enabled: true,
      maxConcurrentChildren: 3,
      maxChildren: 3,
      plannerTurns: 1,
      childTurns: 2,
      childToolCalls: 2,
      plannerTimeoutMilliseconds: 1_000,
      childTimeoutMilliseconds: 1_000,
      plannerMaxOutputTokens: 2,
      childMaxOutputTokens: 4,
      maxAggregateChildTokens: 10,
      maxAggregateChildOutputCharacters: 80_000
    } as const satisfies AgentOrchestrationLimits
    const reservations = new AgentChildBudgetReservations(limits, { totalTokens: 0, outputCharacters: 0 })

    const first = reservations.reserve(3)
    const second = reservations.reserve(2)
    const third = reservations.reserve(1)

    expect(first).toEqual(expect.objectContaining({ totalTokens: 3, maxOutputTokens: 3, outputCharacters: 26_666 }))
    expect(second).toEqual(expect.objectContaining({ totalTokens: 3, maxOutputTokens: 3, outputCharacters: 26_667 }))
    expect(third).toEqual(expect.objectContaining({ totalTokens: 4, maxOutputTokens: 4, outputCharacters: 26_667 }))

    reservations.release(first!, { totalTokens: 3, outputCharacters: 20_000 })
    reservations.release(second!, { totalTokens: 3, outputCharacters: 10_000 })
    reservations.release(third!, { totalTokens: 0, outputCharacters: 0 })

    const recovered = new AgentChildBudgetReservations(limits, reservations.consumed)
    const retry = recovered.reserve()
    expect(retry).toEqual(expect.objectContaining({ totalTokens: 4, outputCharacters: 50_000 }))
    recovered.release(retry!, { totalTokens: 4, outputCharacters: 50_000 })

    expect(recovered.consumed).toEqual({ totalTokens: 10, outputCharacters: 80_000 })
    expect(recovered.reserve()).toBeNull()
  })

  it('shares aggregate output headroom across the concurrent child batch', () => {
    const limits = {
      enabled: true,
      maxConcurrentChildren: 3,
      maxChildren: 3,
      plannerTurns: 1,
      childTurns: 2,
      childToolCalls: 2,
      plannerTimeoutMilliseconds: 1_000,
      childTimeoutMilliseconds: 1_000,
      plannerMaxOutputTokens: 2,
      childMaxOutputTokens: 4,
      maxAggregateChildTokens: 12,
      maxAggregateChildOutputCharacters: 96_000
    } as const satisfies AgentOrchestrationLimits
    const reservations = new AgentChildBudgetReservations(limits, { totalTokens: 0, outputCharacters: 0 })

    expect(reservations.reserve(3)).toEqual(expect.objectContaining({ totalTokens: 4, outputCharacters: 32_000 }))
    expect(reservations.reserve(2)).toEqual(expect.objectContaining({ totalTokens: 4, outputCharacters: 32_000 }))
    expect(reservations.reserve(1)).toEqual(expect.objectContaining({ totalTokens: 4, outputCharacters: 32_000 }))
  })
  it('uses aggregate token headroom smaller than the per-child ceiling', () => {
    const limits = {
      enabled: true,
      maxConcurrentChildren: 3,
      maxChildren: 3,
      plannerTurns: 1,
      childTurns: 2,
      childToolCalls: 2,
      plannerTimeoutMilliseconds: 1_000,
      childTimeoutMilliseconds: 1_000,
      plannerMaxOutputTokens: 2,
      childMaxOutputTokens: 4,
      maxAggregateChildTokens: 10,
      maxAggregateChildOutputCharacters: 200_000
    } as const satisfies AgentOrchestrationLimits
    const reservations = new AgentChildBudgetReservations(limits, { totalTokens: 0, outputCharacters: 0 })
    expect(reservations.reserve(3)).toEqual(expect.objectContaining({ totalTokens: 3, maxOutputTokens: 3 }))
    expect(reservations.reserve(2)).toEqual(expect.objectContaining({ totalTokens: 3, maxOutputTokens: 3 }))
    expect(reservations.reserve(1)).toEqual(expect.objectContaining({ totalTokens: 4, maxOutputTokens: 4 }))
    expect(reservations.reserve(1)).toBeNull()
  })

  it('rejects measured child usage above the held reservation without changing aggregate counters', () => {
    const limits = {
      enabled: true,
      maxConcurrentChildren: 1,
      maxChildren: 1,
      plannerTurns: 1,
      childTurns: 2,
      childToolCalls: 2,
      plannerTimeoutMilliseconds: 1_000,
      childTimeoutMilliseconds: 1_000,
      plannerMaxOutputTokens: 2,
      childMaxOutputTokens: 4,
      maxAggregateChildTokens: 4,
      maxAggregateChildOutputCharacters: 1_000
    } as const satisfies AgentOrchestrationLimits
    const reservations = new AgentChildBudgetReservations(limits, { totalTokens: 0, outputCharacters: 0 })
    const reservation = reservations.reserve()!

    expect(() => reservations.release(reservation, { totalTokens: 5, outputCharacters: 10 })).toThrow(
      expect.objectContaining({ code: 'AGENT_CHILD_BUDGET_EXCEEDED' })
    )
    expect(reservations.consumed).toEqual({ totalTokens: 0, outputCharacters: 0 })
    reservations.release(reservation, { totalTokens: 4, outputCharacters: 10 })
    expect(reservations.consumed).toEqual({ totalTokens: 4, outputCharacters: 10 })
  })
})

class PublicationBudgetLedger implements AgentDispatchBudget {
  readonly active = new Map<number, { tokens: number; costMicros: number }>()
  readonly reconciled: number[] = []
  readonly dispatched: AgentDispatchBudgetReservation[] = []
  readonly unusedAtDispatch: number[] = []
  readonly closedUnused: number[] = []
  consumedTokens = 0
  consumedCostMicros = 0
  allocatedTokens = 0
  returnedTokens = 0
  tools = 0
  #nextId = 1

  constructor(readonly maximumTokens: number) {}

  get unsettledExposure() {
    let tokens = 0
    let costMicros = 0
    for (const held of this.active.values()) {
      tokens += held.tokens
      costMicros += held.costMicros
    }
    return { tokens, costMicros }
  }

  async reserve(maximum: { tokens: number; costMicros: number }): Promise<AgentDispatchBudgetReservation> {
    expect(this.consumedTokens + this.unsettledExposure.tokens + maximum.tokens).toBeLessThanOrEqual(this.maximumTokens)
    const reservation = { id: this.#nextId++, ...maximum }
    this.active.set(reservation.id, maximum)
    this.allocatedTokens += maximum.tokens
    return reservation
  }

  async reconcile(reservation: AgentDispatchBudgetReservation, actual: AgentDispatchUsage) {
    expect(this.active.has(reservation.id)).toBe(true)
    expect(this.reconciled).not.toContain(reservation.id)
    expect(actual.totalTokens).toBeLessThanOrEqual(reservation.tokens)
    expect(actual.costMicros).toBeLessThanOrEqual(reservation.costMicros)
    this.active.delete(reservation.id)
    this.reconciled.push(reservation.id)
    this.consumedTokens += actual.totalTokens
    this.consumedCostMicros += actual.costMicros
    this.returnedTokens += reservation.tokens - actual.totalTokens
  }

  async release(reservation: AgentDispatchBudgetReservation) {
    expect(this.active.delete(reservation.id)).toBe(true)
    this.returnedTokens += reservation.tokens
  }

  async consumeTool() {
    this.tools++
  }

  async reserveSequence(maximum: { tokens: number; costMicros: number }): Promise<AgentDispatchBudgetSequence> {
    const parent = await this.reserve(maximum)
    let closed = false
    const children = new Set<number>()
    const ledger = this
    return {
      reserve: async requested => {
        expect(closed).toBe(false)
        const available = ledger.active.get(parent.id)!
        expect(requested.tokens).toBeLessThanOrEqual(available.tokens)
        expect(requested.costMicros).toBeLessThanOrEqual(available.costMicros)
        const child = { id: ledger.#nextId++, ...requested }
        ledger.active.set(parent.id, { tokens: available.tokens - requested.tokens, costMicros: available.costMicros - requested.costMicros })
        ledger.active.set(child.id, requested)
        children.add(child.id)
        ledger.dispatched.push(child)
        ledger.unusedAtDispatch.push(available.tokens - requested.tokens)
        return child
      },
      reconcile: async (reservation, actual) => {
        expect(children.delete(reservation.id)).toBe(true)
        await ledger.reconcile(reservation, actual)
      },
      release: async reservation => {
        expect(children.delete(reservation.id)).toBe(true)
        await ledger.release(reservation)
      },
      resizeUndispatched: async requested => {
        expect(closed).toBe(false)
        const available = ledger.active.get(parent.id)!
        const targetTokens = ledger.consumedTokens + ledger.unsettledExposure.tokens - available.tokens + requested.tokens
        if (targetTokens > ledger.maximumTokens)
          throw new AgentRepositoryError('AGENT_TOKEN_BUDGET_LIMITED', 'Publication quota cannot cover the requested unused capacity', 409)
        const difference = requested.tokens - available.tokens
        if (difference >= 0) ledger.allocatedTokens += difference
        else ledger.returnedTokens -= difference
        ledger.active.set(parent.id, requested)
      },
      close: async () => {
        expect(closed).toBe(false)
        expect(children.size).toBe(0)
        closed = true
        const unused = ledger.active.get(parent.id)!
        ledger.closedUnused.push(unused.tokens)
        ledger.returnedTokens += unused.tokens
        ledger.active.delete(parent.id)
      },
      consumeTool: () => ledger.consumeTool(),
      get unsettledExposure() {
        return ledger.unsettledExposure
      }
    }
  }
}

describe('bounded root publication accounting', () => {
  for (const refuseSecondRead of [false, true]) {
    it(`settles read-plus-finish usage without charging the control${refuseSecondRead ? ' and retains collection after an unexecuted read' : ''}`, async () => {
      const budget = new PublicationBudgetLedger(120_000)
      const consumeTool = budget.consumeTool.bind(budget)
      let toolAttempts = 0
      budget.consumeTool = async () => {
        if (++toolAttempts === 2 && refuseSecondRead) throw new AgentRepositoryError('AGENT_BUDGET_LIMITED', 'Read reservation unavailable', 409)
        await consumeTool()
      }
      const collectionRequests: Readonly<AxChatRequest<unknown>>[] = []
      const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
        const final = synthesisInputFromRequest(input) !== undefined
        if (!final) collectionRequests.push(input)
        const first = collectionRequests.length === 1
        const functionCalls = [
          { id: first ? 'read-alpha' : 'retry-beta', type: 'function' as const, function: { name: 'wiki_get_page', params: first ? '{"id":1}' : '{"id":2}' } },
          ...(first && refuseSecondRead
            ? [
                {
                  id: 'read-beta',
                  type: 'function' as const,
                  function: { name: 'wiki_get_page', params: '{"id":2}' }
                }
              ]
            : []),
          { id: first ? 'finish-first' : 'finish-retry', type: 'function' as const, function: { name: 'wiki_finish_collection', params: '{}' } }
        ]
        if (!final && !first) {
          expect(input.functions?.some(fn => fn.name === 'wiki_get_page')).toBe(true)
          expect(JSON.stringify(input.chatPrompt)).toContain('collection_not_finished')
        }
        return {
          results: [
            final
              ? {
                  index: 0,
                  content: synthesisFixtureAnswer(input, {
                    claims: [{ evidenceId: 'page:1:revision:rev-1', statement: 'Alpha requires review.' }]
                  })
                }
              : { index: 0, functionCalls }
          ],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
        } satisfies AxChatResponse
      })
      const invoke = vi.fn(async (_name: string, input: unknown) => {
        if (typeof input !== 'object' || input === null || !('id' in input) || typeof input.id !== 'number') throw new Error('Expected an admitted page ID')
        const id = input.id
        return {
          id,
          locale: 'en',
          path: id === 1 ? 'alpha' : 'beta',
          title: id === 1 ? 'Alpha' : 'Beta',
          contentType: 'markdown',
          sourceRevision: `rev-${id}`,
          content: id === 1 ? 'Alpha requires review.' : 'Beta requires approval.',
          citation: { evidenceId: `page:${id}:revision:rev-${id}`, label: id === 1 ? 'Alpha' : 'Beta', href: `/en/${id === 1 ? 'alpha' : 'beta'}` },
          citationSections: []
        }
      })
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
          invoke,
          validateObservation: async () => true,
          snapshot: async () => ({}),
          close: () => {},
          authoritySha256: null
        })
      }
      const text = vi.fn(async (_delta: string) => {})
      const event = vi.fn(async (_type: string, _data: unknown) => {})
      const result = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions, undefined, {
        decisionProviders: fixtureDecisionProviders
      }).execute(
        {
          ...baseRequest(new AbortController().signal),
          messages: [{ role: 'user', content: 'What does Alpha require?' }],
          limits: { maxTurns: 8, maxToolCalls: 3, maxTokens: budget.maximumTokens, maxOutputTokens: 512 },
          dispatchBudget: budget
        },
        { text, event }
      )
      expect(result.executionLimit).toBeUndefined()
      expect(visibleWikiText(text.mock.calls.map(([delta]) => delta).join(''))).toContain('Alpha requires review.')
      expect(result.citations).toEqual([expect.objectContaining({ evidenceId: 'page:1:revision:rev-1' })])
      expect(chat).toHaveBeenCalledTimes(refuseSecondRead ? 3 : 2)
      expect(invoke).toHaveBeenCalledTimes(refuseSecondRead ? 2 : 1)
      expect(budget.tools).toBe(refuseSecondRead ? 2 : 1)
      expect(result.totalTokens).toBe(refuseSecondRead ? 15 : 10)
      expect(budget.consumedTokens).toBe(result.totalTokens)
      expect(budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
      expect(budget.allocatedTokens).toBe(budget.returnedTokens + budget.consumedTokens)
      expect(event.mock.calls.filter(([type]) => type === 'tool.completed')).toHaveLength(refuseSecondRead ? 2 : 1)
      expect(event.mock.calls.filter(([type]) => type === 'tool.failed')).toHaveLength(refuseSecondRead ? 1 : 0)
    })
  }

  it('enforces the actual compact native source request boundary before consuming synthesis quota', async () => {
    const synthesisRequests: Readonly<AxChatRequest<unknown>>[] = []
    const collectionRequests: Readonly<AxChatRequest<unknown>>[] = []
    const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
      const final = synthesisInputFromRequest(input) !== undefined
      if (final) synthesisRequests.push(input)
      else collectionRequests.push(input)
      return {
        results: [
          final
            ? {
                index: 0,
                content: synthesisFixtureAnswer(input, {
                  claims: [{ evidenceId: 'page:1:revision:rev-1', statement: 'Alpha requires review.' }]
                })
              }
            : { index: 0, functionCalls: [{ id: 'read-alpha', type: 'function', function: { name: 'wiki_get_page', params: '{"id":1}' } }] }
        ],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
      } satisfies AxChatResponse
    })
    const invoke = vi.fn(async () => ({
      id: 1,
      locale: 'en',
      path: 'alpha',
      title: 'Alpha',
      contentType: 'markdown',
      sourceRevision: 'rev-1',
      content: [
        'Alpha requires review.',
        'Background details. '.repeat(140),
        ...Array.from({ length: 24 }, (_, index) => `Background item ${index + 1} carries archival routing label BG-${index + 1}.`)
      ].join('\n\n'),
      citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
      citationSections: []
    }))
    const actions: AgentActionSessionProvider = {
      open: async () => ({
        functions: [{ name: 'pages.get', title: 'Read page', description: 'Read one page', parameters: { type: 'object', properties: {} }, risk: 'read' }],
        invoke,
        validateObservation: async () => true,
        snapshot: async () => ({}),
        close: () => {},
        authoritySha256: null
      })
    }
    const request: AgentEngineRequest = {
      ...baseRequest(new AbortController().signal),
      messages: [{ role: 'user', content: 'What does Alpha require?' }],
      limits: { maxTurns: 3, maxToolCalls: 1, maxOutputTokens: 512 }
    }
    const admittedBudget = new PublicationBudgetLedger(120_000)
    const admitted = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), actions, undefined, {
      decisionProviders: fixtureDecisionProviders
    }).execute(
      { ...request, limits: { ...request.limits, maxTokens: admittedBudget.maximumTokens }, dispatchBudget: admittedBudget },
      { text: async () => {}, event: async () => {} }
    )
    expect(admitted.executionLimit).toBeUndefined()
    expect(admitted.citations).toEqual([expect.objectContaining({ evidenceId: 'page:1:revision:rev-1' })])
    expect(synthesisRequests).toHaveLength(1)
    const nativeRequest = synthesisRequests[0]!
    expect(nativeRequest.responseFormat?.schema).toBeDefined()
    const nativeRequestBytes = Buffer.byteLength(JSON.stringify(nativeRequest), 'utf8')
    expect(nativeRequestBytes + 512).toBeLessThanOrEqual(100_000)
    expect(Buffer.byteLength(JSON.stringify(collectionRequests[0]), 'utf8') + 512).toBeLessThan(nativeRequestBytes - 1)
    expect(admittedBudget.dispatched[0]?.tokens).toBe(nativeRequestBytes + 512)
    expect(admittedBudget.consumedTokens).toBe(10)
    expect(admittedBudget.consumedCostMicros).toBe(14)
    expect(admittedBudget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
    expect(admittedBudget.allocatedTokens).toBe(admittedBudget.returnedTokens + admittedBudget.consumedTokens)

    // The overflowing candidate read is omitted before synthesis. Early
    // adaptation must publish an explicit inability without another paid turn.
    const budget = new PublicationBudgetLedger(120_000)
    const text = vi.fn(async () => {})
    const limited = await new AxAgentEngine(factoryFor(chat, { usage: 'terminal', maxContextTokens: nativeRequestBytes - 1 }), actions, undefined, {
      decisionProviders: fixtureDecisionProviders
    }).execute({ ...request, limits: { ...request.limits, maxTokens: budget.maximumTokens }, dispatchBudget: budget }, { text, event: async () => {} })
    expect(limited.contextLimit).toEqual({ reason: 'tool_result_capacity', omittedActionCallIds: ['read-alpha'] })
    expect(limited.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
    expect(limited.citations).toBeUndefined()
    const published = visibleWikiText(text.mock.calls.map(([delta]) => delta).join(''))
    expect(published).toContain("I couldn't complete a source-verified answer")
    expect(published).toContain('provider context capacity was exhausted')
    expect(published).not.toContain('Alpha requires review.')
    expect(limited.totalTokens).toBe(5)
    expect(limited.costMicros).toBe(7)

    expect(invoke).toHaveBeenCalledTimes(2)
    expect(synthesisRequests).toHaveLength(1)
    expect(collectionRequests).toHaveLength(2)
    expect(text).toHaveBeenCalled()
    expect(budget.tools).toBe(1)
    expect(budget.dispatched).toHaveLength(0)
    expect(budget.reconciled).toHaveLength(1)
    expect(budget.consumedTokens).toBe(5)
    expect(budget.consumedCostMicros).toBe(7)
    expect(budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
    expect(budget.allocatedTokens).toBe(budget.returnedTokens + budget.consumedTokens)
  })

  for (const outcome of ['first-accepted', 'repaired', 'exhausted', 'length', 'recent-partial'] as const) {
    it(`conserves draft and correction exposure when publication is ${outcome}`, async () => {
      const budget = new PublicationBudgetLedger(120_000)
      const accepted = { claims: [{ evidenceId: 'page:1:revision:rev-1', statement: 'Alpha requires review.' }] } satisfies SynthesisFixtureAnswer
      const rejected = { claims: [{ evidenceId: 'page:1:revision:rev-1', statement: 'Alpha does not require review.' }] } satisfies SynthesisFixtureAnswer
      const recentPartial = outcome === 'recent-partial'
      const userRequest = recentPartial ? 'Summarize the most recently updated Wiki pages.' : 'What does Alpha require?'
      const partialAnswer: SynthesisFixtureAnswer | undefined = recentPartial
        ? { claims: [...rejected.claims, { evidenceId: 'page:2:revision:rev-2', statement: 'Beta requires approval.' }] }
        : undefined
      const nativeUsage = { inputTokens: 2, outputTokens: 1, totalTokens: 3, totalTokensSource: 'reported' as const }
      const nativeCostMicros = 11
      const nativeRuntime = await fixtureDecisionProviders.selectRuntime()
      nativeRuntime.config.pricing = { ...nativeRuntime.config.pricing!, perRequest: nativeCostMicros / 1_000_000 }
      const semanticVerdicts = rejectFixtureStatements(['Alpha does not require review.'])
      const decisionProviders = {
        selectRuntime: async () => nativeRuntime,
        decideBatch: vi.fn(async (...args: Parameters<typeof semanticVerdicts.decideBatch>) => {
          const decision = await semanticVerdicts.decideBatch(...args)
          return {
            ...decision,
            usage: nativeUsage,
            estimatedCost: { ...decision.estimatedCost!, amount: nativeCostMicros / 1_000_000 },
            estimatedCostMicros: nativeCostMicros
          }
        })
      }
      let attempts = 0
      const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
        expect(input.modelConfig?.maxTokens).toBeLessThanOrEqual(512)
        const final = synthesisInputFromRequest(input) !== undefined
        if (final) {
          attempts++
          // A paid first draft retains the capacity for its possible repair
          // until the consumer accepts, rejects, or observes its length stop.
          if (attempts === 1) expect(budget.unusedAtDispatch[0]).toBeGreaterThan(512)
        }
        const answer = partialAnswer ?? (outcome === 'exhausted' || (outcome === 'repaired' && attempts === 1) ? rejected : accepted)
        return {
          results: [
            final
              ? {
                  index: 0,
                  content: synthesisFixtureAnswer(input, answer),
                  ...(outcome === 'length' ? { finishReason: 'length' as const } : {})
                }
              : {
                  index: 0,
                  content: recentPartial
                    ? `<wiki-request-plan>${JSON.stringify({
                        facets: [{ start: 0, end: userRequest.length, quote: userRequest, coverage: 'recent-window' }]
                      })}</wiki-request-plan>`
                    : '',
                  functionCalls: [
                    {
                      id: 'read-alpha',
                      type: 'function',
                      function: {
                        name: recentPartial ? input.functions!.find(fn => fn.name.includes('recent'))!.name : 'wiki_get_page',
                        params: recentPartial ? '{"limit":10}' : '{"id":1}'
                      }
                    }
                  ]
                }
          ],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
        } satisfies AxChatResponse
      })
      const invoke = vi.fn(async () => {
        const alpha = {
          id: 1,
          locale: 'en',
          path: 'alpha',
          title: 'Alpha',
          contentType: 'markdown',
          sourceRevision: 'rev-1',
          content: 'Alpha requires review.',
          citation: { evidenceId: 'page:1:revision:rev-1', label: 'Alpha', href: '/en/alpha' },
          citationSections: []
        }
        if (!recentPartial) return alpha
        return {
          kind: 'recent-page-evidence',
          requestedLimit: 10,
          exhausted: true,
          pages: [
            alpha,
            {
              ...alpha,
              id: 2,
              path: 'beta',
              title: 'Beta',
              sourceRevision: 'rev-2',
              content: 'Beta requires approval.',
              citation: { evidenceId: 'page:2:revision:rev-2', label: 'Beta', href: '/en/beta' }
            }
          ].map(page => ({ ...page, updatedAt: '2026-09-20T09:00:00.000Z', contentTruncated: false, sourceContentCharacters: page.content.length }))
        }
      })
      const actions: AgentActionSessionProvider = {
        open: async () => ({
          functions: [
            {
              name: recentPartial ? 'pages.listRecent' : 'pages.get',
              title: recentPartial ? 'Read recent pages' : 'Read page',
              description: recentPartial ? 'Read recent pages' : 'Read one page',
              parameters: { type: 'object', properties: {} },
              risk: 'read'
            }
          ],
          invoke,
          validateObservation: async () => true,
          snapshot: async () => ({}),
          close: () => {},
          authoritySha256: null
        })
      }
      const text = vi.fn(async () => {})
      const event = vi.fn(async (_type: string, _data: unknown) => {})
      const result = await new AxAgentEngine(
        factoryFor(chat, {
          usage: 'terminal',
          coverage: async () => ({
            results: [
              {
                index: 0,
                content: JSON.stringify({
                  verdict: recentPartial ? 'incomplete' : 'complete',
                  feedback: recentPartial ? 'Alpha has no verified contribution.' : ''
                }),
                finishReason: 'stop'
              }
            ],
            modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 7, completionTokens: 3, totalTokens: 12 } }
          })
        }),
        actions,
        undefined,
        {
          decisionProviders
        }
      ).execute(
        {
          ...baseRequest(new AbortController().signal),
          messages: [{ role: 'user', content: userRequest }],
          limits: { maxTokens: budget.maximumTokens, maxTurns: 3, maxToolCalls: 1, maxOutputTokens: 512 },
          dispatchBudget: budget
        },
        { text, event }
      )
      const expectedTurns = outcome === 'first-accepted' || outcome === 'length' ? 2 : 3
      expect(attempts).toBe(expectedTurns - 1)
      expect(invoke).toHaveBeenCalledOnce()
      expect(budget.tools).toBe(1)
      const semanticChecks = decisionProviders.decideBatch.mock.calls.length
      const coverageChecks = recentPartial || outcome === 'first-accepted' || outcome === 'repaired' ? 1 : 0
      expect(
        event.mock.calls.filter(
          ([type, data]) =>
            type === 'model.turn' &&
            typeof data === 'object' &&
            data !== null &&
            'verification' in data &&
            typeof data.verification === 'object' &&
            data.verification !== null &&
            'phase' in data.verification &&
            data.verification.phase === 'coverage_audit'
        )
      ).toHaveLength(coverageChecks)
      expect(budget.consumedTokens).toBe(expectedTurns * 5 + semanticChecks * nativeUsage.totalTokens + coverageChecks * 12)
      expect(budget.consumedCostMicros).toBe(expectedTurns * 7 + semanticChecks * nativeCostMicros + coverageChecks * 17)
      expect(result.inputTokens).toBe(expectedTurns * 3 + semanticChecks * nativeUsage.inputTokens + coverageChecks * 7)
      expect(result.outputTokens).toBe(expectedTurns * 2 + semanticChecks * nativeUsage.outputTokens + coverageChecks * 3)
      expect(result.totalTokens).toBe(budget.consumedTokens)
      expect(result.costMicros).toBe(budget.consumedCostMicros)
      let recoveredTokens = 0
      let recoveredCostMicros = 0
      for (const [type, data] of event.mock.calls) {
        if (type !== 'model.turn') continue
        const receipt = data as { totalTokens: number; costMicros: number }
        recoveredTokens += receipt.totalTokens
        recoveredCostMicros += receipt.costMicros
      }
      expect(recoveredTokens).toBe(result.totalTokens)
      expect(recoveredCostMicros).toBe(result.costMicros)
      expect(budget.unsettledExposure).toEqual({ tokens: 0, costMicros: 0 })
      expect(budget.allocatedTokens).toBe(budget.returnedTokens + budget.consumedTokens)
      expect(budget.closedUnused).toHaveLength(1)
      const published = text.mock.calls.map(([delta]) => delta).join('')
      expect(visibleWikiText(published)).not.toContain('does not require review')
      if (outcome === 'length') {
        expect(result.outputLimited).toBe(true)
        expect(result.suggestions).toEqual([expect.objectContaining({ id: 'continue-output-limit' })])
        expect(result.citations).toBeUndefined()
        expect(visibleWikiText(published)).not.toContain('Alpha requires review.')
        expect(budget.closedUnused[0]).toBeGreaterThan(512)
      } else if (outcome === 'exhausted') {
        expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
        expect(result.citations).toBeUndefined()
      } else if (recentPartial) {
        expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'partial' })
        expect(result.citations?.map(citation => citation.evidenceId)).toEqual(['page:2:revision:rev-2'])
        expect(visibleWikiText(published)).toContain('Beta requires approval.')
        expect(visibleWikiText(published)).not.toContain('Alpha requires review.')
      } else {
        expect(result.executionLimit).toBeUndefined()
        expect(result.citations).toEqual([expect.objectContaining({ evidenceId: 'page:1:revision:rev-1' })])
        expect(visibleWikiText(published)).toContain('Alpha requires review.')
      }
    })
  }

  for (const maxTurns of [1, 2]) {
    it(`accepts a valid single-pass answer under a ${maxTurns}-turn cap that cannot fund two full generations`, async () => {
      const synthesisRequests: Readonly<AxChatRequest<unknown>>[] = []
      const chat = vi.fn(async (input: Readonly<AxChatRequest<unknown>>) => {
        expect(synthesisInputFromRequest(input)).toBeDefined()
        synthesisRequests.push(input)
        expect(input.modelConfig?.maxTokens).toBeLessThanOrEqual(128)
        return {
          results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], unresolvedFacets: [0] }) }],
          modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
        } satisfies AxChatResponse
      })
      const engine = new AxAgentEngine(factoryFor(chat, { usage: 'terminal' }), undefined, undefined, { decisionProviders: fixtureDecisionProviders })
      const request = { ...baseRequest(new AbortController().signal), limits: { maxTurns, maxToolCalls: 0, maxOutputTokens: 128 } }
      const preflight = await engine.preflight(request)
      expect(preflight).toMatchObject({ admissible: true, outputExposureTokens: 128 })
      const measured = await engine.execute(request, { text: async () => {}, event: async () => {} })
      expect(measured).toMatchObject({ totalTokens: 5, executionLimit: { reason: 'evidence', publication: 'inability' } })
      expect(synthesisRequests.flatMap(input => input.functions ?? []).map(fn => fn.name)).toEqual([])
      const nativeRequestBytes = Buffer.byteLength(JSON.stringify(synthesisRequests[0]), 'utf8')
      const budget = new PublicationBudgetLedger(nativeRequestBytes + 128)
      expect(budget.maximumTokens).toBeLessThan(nativeRequestBytes * 2)
      const text = vi.fn(async () => {})
      const event = vi.fn(async () => {})
      const result = await engine.execute(
        { ...request, limits: { ...request.limits, maxTokens: budget.maximumTokens }, dispatchBudget: budget },
        { text, event }
      )
      expect(result.executionLimit).toEqual({ reason: 'evidence', publication: 'inability' })
      expect(result.citations).toBeUndefined()
      expect(synthesisRequests.flatMap(input => input.functions ?? []).map(fn => fn.name)).toEqual([])
      expect(event.mock.calls).toContainEqual(['model.turn', expect.objectContaining({ outcome: 'answer_accepted', totalTokens: 5 })])
      expect(budget.dispatched[0]?.tokens).toBe(Buffer.byteLength(JSON.stringify(synthesisRequests[1]), 'utf8') + 128)
      expect(budget.consumedTokens).toBe(5)
      expect(budget.consumedCostMicros).toBe(7)
      expect(budget.reconciled).toHaveLength(1)
      expect(budget.dispatched).toHaveLength(1)
      expect(budget.unsettledExposure.tokens).toBe(0)
      expect(budget.allocatedTokens).toBe(budget.returnedTokens + result.totalTokens)
    })
  }
})
