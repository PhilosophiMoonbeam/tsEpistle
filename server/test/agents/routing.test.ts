import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { type DecisionRequest, type DecisionResult, TYPESAFE_JEV_PRICING } from '../../../shared/agents/decision-providers.ts'
import {
  DEFAULT_ROUTING_POLICY,
  ROUTING_COMPLEXITIES,
  ROUTING_TASK_CLASSES,
  type RoutingAdminView,
  type RoutingCandidate,
  RoutingModelPolicyInputSchema,
  RoutingPolicyInputSchema,
  type RoutingSpecialistCandidate,
  type RoutingTurnDecision,
  type RoutingTurnHooks,
  type RoutingTurnInput
} from '../../../shared/agents/routing.ts'
import { DecisionProviderFailure, type DecisionProviderRuntime } from '../../agents/decision-providers.ts'
import { AgentTurnRouter } from '../../agents/routing.ts'
import { describe, expect, it } from '../bun-test.mts'

const fixture = () => {
  const candidate = (inputPrice: number): RoutingCandidate => ({
    profileId: randomUUID(),
    profileVersionId: randomUUID(),
    model: 'generation-model',
    enabled: true,
    authorized: true,
    credentialReady: true,
    conformed: true,
    modalities: ['text'],
    generationTools: [],
    transcription: false,
    capabilities: {
      streaming: true,
      toolCalling: 'native',
      parallelToolCalls: true,
      structuredOutput: 'native-json-schema',
      usage: 'terminal',
      cancellation: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 8_000
    },
    pricing: { inputPerMillion: inputPrice, outputPerMillion: inputPrice * 2, revision: 'verified-price-1' }
  })
  const current = candidate(10),
    alternate = candidate(1)
  const provider: DecisionProviderRuntime = {
    id: randomUUID(),
    revision: 1,
    config: { kind: 'typesafe', model: 'jev-1.13.0', timeoutMs: 1_000, pricing: TYPESAFE_JEV_PRICING }
  }
  const view: RoutingAdminView = {
    policy: { ...DEFAULT_ROUTING_POLICY, enabled: true, revision: 1, updatedAt: null },
    models: [
      {
        profileId: alternate.profileId,
        profileVersionId: alternate.profileVersionId,
        revision: 1,
        acceptableTasks: [{ taskClass: 'writing', complexities: ['simple'] }],
        estimatedLatencyMs: null,
        updatedAt: new Date().toISOString()
      }
    ]
  }
  const input: RoutingTurnInput = {
    ownerId: 7,
    sessionId: randomUUID(),
    runId: randomUUID(),
    pinned: false,
    current,
    candidates: [current, alternate],
    requirements: { modalities: ['text'], nativeTools: true, nativeExternalMcp: false, nativeSchema: true, minimumOutputTokens: 100 },
    currentInputTokens: 10_000,
    fullHistoryInputTokens: 12_000,
    expectedOutputTokens: 1_000,
    classifierState: { currentMessage: 'Write a brief greeting.', recentSummary: 'A prior greeting.' }
  }
  const answer: DecisionResult = {
    providerId: provider.id,
    providerRevision: provider.revision,
    model: 'jev-1.13.0',
    choice: 'writing:simple',
    probabilities: Object.fromEntries(
      ROUTING_TASK_CLASSES.flatMap(task =>
        ROUTING_COMPLEXITIES.map(complexity => [`${task}:${complexity}`, task === 'writing' && complexity === 'simple' ? 1 : 0])
      )
    ),
    confidence: 1,
    usage: { inputTokens: 300, outputTokens: 20, totalTokens: 320, totalTokensSource: 'derived' },
    latencyMs: 23,
    estimatedCost: { currency: 'USD', amount: 0.000013, pricingRevision: 'price-1', source: 'https://docs.typesafe.ai/models', verifiedAt: '2026-10-04' },
    estimatedCostMicros: 13
  }
  const requests: DecisionRequest[] = [],
    checkpoints: RoutingTurnDecision[] = [],
    reservations: { tokens: number; costMicros: number }[] = [],
    reconciliations: { inputTokens: number; outputTokens: number; totalTokens: number; costMicros: number }[] = []
  let released = 0,
    failure: unknown = null,
    unavailable = false,
    responseChoice: string | null = null,
    denyBudget = false
  const hooks: RoutingTurnHooks = {
    budget: {
      async reserve(maximum) {
        if (denyBudget) throw new Error('budget denied')
        reservations.push(maximum)
        return { id: reservations.length, ...maximum }
      },
      async reconcile(_reservation, usage) {
        reconciliations.push(usage)
      },
      async release() {
        released++
      }
    },
    async checkpoint(decision) {
      checkpoints.push(decision)
    }
  }
  const router = new AgentTurnRouter(
    {
      async getRuntime() {
        return view
      }
    },
    {
      async selectRuntime() {
        if (unavailable) throw new Error('disabled')
        return provider
      },
      async decide(request) {
        requests.push(request)
        if (failure) throw failure
        return responseChoice === null
          ? answer
          : {
              ...answer,
              choice: responseChoice,
              probabilities: Object.fromEntries(Object.keys(request.criteria).map(label => [label, label === responseChoice ? 1 : 0]))
            }
      }
    }
  )
  const liveVersions: Record<string, string> = { [current.profileId]: current.profileVersionId, [alternate.profileId]: alternate.profileVersionId }
  const database = ((table: string) => {
    let binding: { id: string; profileId?: string }
    interface Query {
      where(value: typeof binding): Query
      whereNull(): Query
      forShare(): Query
      first(): Promise<{ currentVersionId: string } | { id: string } | undefined>
    }
    const query: Query = {
      where(value: typeof binding) {
        binding = value
        return query
      },
      whereNull() {
        return query
      },
      forShare() {
        return query
      },
      async first() {
        return table === 'agentProviderProfiles'
          ? liveVersions[binding.id]
            ? { currentVersionId: liveVersions[binding.id] }
            : undefined
          : liveVersions[binding.profileId!] === binding.id
            ? { id: binding.id }
            : undefined
      }
    }
    return query
  }) as unknown as Knex
  return {
    current,
    alternate,
    provider,
    view,
    input,
    answer,
    requests,
    checkpoints,
    reservations,
    reconciliations,
    hooks,
    router,
    database,
    liveVersions,
    choose(label: string) {
      responseChoice = label
    },
    setFailure(value: unknown) {
      failure = value
    },
    setUnavailable() {
      unavailable = true
    },
    denyBudget() {
      denyBudget = true
    },
    getReleased() {
      return released
    }
  }
}

const specialistFixture = () => {
  const f = fixture()
  f.view.policy.specialistEnabled = true
  const reusable: RoutingSpecialistCandidate = {
    contextId: randomUUID(),
    contextVersion: 2,
    candidate: f.alternate,
    taskClass: 'writing',
    complexity: 'simple',
    inputTokens: 100,
    description: 'Completed greeting drafts; continue revising the same greeting.'
  }
  const fresh: RoutingSpecialistCandidate = {
    ...reusable,
    contextId: null,
    contextVersion: null,
    taskClass: null,
    complexity: null,
    inputTokens: 12_000,
    description: 'Independent writing task.'
  }
  const input: RoutingTurnInput = {
    ...f.input,
    fullHistoryInputTokens: 150_000,
    estimatedRootWorkTurns: 3,
    specialists: [reusable, fresh],
    classifierState: { currentMessage: 'Independently revise the prior greeting and report the result.' }
  }
  f.choose(`REUSE(${reusable.contextId}):writing:simple`)
  return { ...f, input, reusable, fresh }
}

describe('optional stay/swap/delegate arbitration', () => {
  it('retains the root identity and chooses relevant bounded reuse over a cold canonical swap', async () => {
    const f = specialistFixture()
    const result = await f.router.routeTurn(f.input, f.hooks)
    expect(result).toMatchObject({
      strategy: 'delegate',
      switched: false,
      profileId: f.current.profileId,
      profileVersionId: f.current.profileVersionId,
      specialist: { contextId: f.reusable.contextId, contextVersion: 2, profileId: f.alternate.profileId, profileVersionId: f.alternate.profileVersionId },
      strategyCosts: {
        basis: 'host-token-estimates-no-cache-discount',
        rootWorkTurns: 3,
        childWorkTurns: 3,
        reportTokens: 1_024,
        handoffInputTokens: 256,
        stayMicros: 420_000,
        coldSwapMicros: 462_000,
        delegateMicros: 146_156,
        classifierMicros: 13,
        handoffMicros: 1_000
      },
      estimatedSelectedCostMicros: 146_156,
      estimatedSavingsMicros: 272_831
    })
    expect(f.requests).toHaveLength(1)
    expect(f.reconciliations).toHaveLength(1)
    expect(await f.router.routeTurn({ ...f.input, recordedDecision: result }, f.hooks)).toBe(result)
    expect(f.checkpoints).toHaveLength(1)
    await f.router.validateDecision(result, f.database)
  })

  it('allows independently separable NEW work but never delegates ordinary or uncertain-independence labels', async () => {
    const independent = specialistFixture()
    independent.choose('NEW:writing:simple')
    expect(await independent.router.routeTurn(independent.input, independent.hooks)).toMatchObject({
      strategy: 'delegate',
      specialist: { contextId: null, contextVersion: null }
    })
    for (const pinned of [false, true]) {
      const f = specialistFixture()
      f.choose('writing:simple')
      // A genuinely cheaper cold swap remains allowed only for an unpinned root.
      const result = await f.router.routeTurn({ ...f.input, pinned, fullHistoryInputTokens: 12_000 }, f.hooks)
      expect(result.strategy).toBe(pinned ? 'stay' : 'swap')
      expect(result.specialist).toBeNull()
    }
  })

  it('permits a pinned root to delegate without swapping and honors the master opt-out', async () => {
    const f = specialistFixture()
    expect(await f.router.routeTurn({ ...f.input, pinned: true }, f.hooks)).toMatchObject({
      strategy: 'delegate',
      switched: false,
      profileId: f.current.profileId,
      strategyCosts: { coldSwapMicros: null }
    })
    for (const flag of ['enabled', 'specialistEnabled'] as const) {
      const disabled = specialistFixture()
      disabled.view.policy[flag] = false
      expect(await disabled.router.routeTurn({ ...disabled.input, pinned: true }, disabled.hooks)).toMatchObject({ strategy: 'stay' })
      expect(disabled.requests).toHaveLength(0)
    }
  })

  it('checks child capacity against independent context rather than an oversized canonical root replay', async () => {
    const f = specialistFixture()
    expect(await f.router.routeTurn({ ...f.input, fullHistoryInputTokens: 300_000 }, f.hooks)).toMatchObject({
      strategy: 'delegate',
      specialist: { contextId: f.reusable.contextId },
      strategyCosts: { coldSwapMicros: null }
    })
    expect(f.requests).toHaveLength(1)
  })

  it('allows same-binding delegation when independent child work avoids repeated root context', async () => {
    const f = specialistFixture()
    f.view.models.push({ ...f.view.models[0]!, profileId: f.current.profileId, profileVersionId: f.current.profileVersionId })
    const specialist = { ...f.reusable, candidate: f.current }
    const result = await f.router.routeTurn({ ...f.input, pinned: true, currentInputTokens: 100_000, specialists: [specialist] }, f.hooks)
    expect(result).toMatchObject({
      strategy: 'delegate',
      switched: false,
      profileId: f.current.profileId,
      specialist: { profileId: f.current.profileId, profileVersionId: f.current.profileVersionId }
    })
    expect(result.estimatedSavingsMicros!).toBeGreaterThan(0)
  })

  it('excludes unknown-priced or incompatible children and does not classify economically unviable work', async () => {
    for (const mode of ['unknown-price', 'unauthorized', 'context-limit', 'no-savings']) {
      const f = specialistFixture()
      const candidate = {
        ...f.alternate,
        ...(mode === 'unknown-price' ? { pricing: null } : {}),
        ...(mode === 'unauthorized' ? { authorized: false } : {}),
        ...(mode === 'context-limit' ? { capabilities: { ...f.alternate.capabilities, maxContextTokens: 2_000 } } : {})
      }
      const result = await f.router.routeTurn(
        { ...f.input, pinned: true, estimatedRootWorkTurns: mode === 'no-savings' ? 1 : 3, specialists: [{ ...f.reusable, candidate }] },
        f.hooks
      )
      expect(result.strategy).toBe('stay')
      expect(f.requests).toHaveLength(0)
      expect(f.reservations).toHaveLength(0)
    }
  })

  it('keeps delegation confidence, billed failures and budget accounting identical to ordinary routing', async () => {
    for (const mode of ['low-confidence', 'billed-failure', 'budget', 'actual-overhead']) {
      const f = specialistFixture()
      if (mode === 'low-confidence') Object.assign(f.answer, { confidence: 0.94 })
      if (mode === 'billed-failure') f.setFailure(new DecisionProviderFailure('DECISION_TIMEOUT', f.provider, f.answer.usage, 100))
      if (mode === 'budget') f.denyBudget()
      if (mode === 'actual-overhead') Object.assign(f.answer, { estimatedCostMicros: 300_000 })
      const result = await f.router.routeTurn(f.input, f.hooks)
      expect(result).toMatchObject({ strategy: 'stay', specialist: null, profileId: f.current.profileId })
      expect(f.reconciliations).toHaveLength(mode === 'budget' ? 0 : 1)
      expect(f.getReleased()).toBe(0)
    }
  })

  it('rejects forged, foreign, stale, irrelevant or rebound specialist receipts without further paid work', async () => {
    const f = specialistFixture()
    const recorded = await f.router.routeTurn(f.input, f.hooks)
    for (const change of [
      { ownerId: f.input.ownerId + 1 },
      { sessionId: randomUUID() },
      { specialist: { ...recorded.specialist!, contextId: randomUUID() } },
      { specialist: { ...recorded.specialist!, contextVersion: 3 } },
      { specialist: { ...recorded.specialist!, profileVersionId: randomUUID() } },
      { profileId: f.alternate.profileId, profileVersionId: f.alternate.profileVersionId },
      { switched: true },
      { classification: { ...recorded.classification!, choice: 'NEW:writing:simple' } }
    ]) {
      await expect(f.router.routeTurn({ ...f.input, recordedDecision: { ...recorded, ...change } }, f.hooks)).rejects.toMatchObject({
        code: 'ROUTING_CHECKPOINT_INVALID'
      })
    }
    for (const specialists of [
      [],
      [{ ...f.reusable, taskClass: 'analysis' as const }],
      [{ ...f.reusable, candidate: { ...f.alternate, authorized: false } }]
    ]) {
      await expect(f.router.routeTurn({ ...f.input, specialists, recordedDecision: recorded }, f.hooks)).rejects.toMatchObject({
        code: 'ROUTING_CHECKPOINT_INVALID'
      })
    }
    f.liveVersions[f.alternate.profileId] = randomUUID()
    await expect(f.router.validateDecision(recorded, f.database)).rejects.toMatchObject({ code: 'ROUTING_REVISION_CHANGED' })
    expect(f.requests).toHaveLength(1)
    expect(f.reconciliations).toHaveLength(1)
  })

  it('never supplies unvalidated context labels and bounds all supplied context summaries without dropping the current request', async () => {
    const f = specialistFixture()
    f.view.policy.specialistMaxContexts = 8
    f.view.policy.classifierMaxStateBytes = 16_384
    const contexts = Array.from({ length: 8 }, (_, index) => ({ ...f.reusable, contextId: randomUUID(), description: `Greeting draft ${index}.` }))
    f.choose(`REUSE(${contexts[0]!.contextId}):writing:simple`)
    await f.router.routeTurn({ ...f.input, specialists: [...contexts, f.fresh] }, f.hooks)
    const request = f.requests[0]!
    expect(Object.keys(request.criteria)).toHaveLength(180)
    expect(request.state).toMatchObject({ currentMessage: f.input.classifierState.currentMessage })
    expect(Buffer.byteLength(JSON.stringify(request.state))).toBeLessThanOrEqual(16_384)
    expect(request.criteria).not.toHaveProperty(`REUSE(${randomUUID()}):writing:simple`)
    const oversized = specialistFixture()
    oversized.view.policy.classifierMaxStateBytes = 256
    expect(await oversized.router.routeTurn(oversized.input, oversized.hooks)).toMatchObject({ reason: 'classifier-state-too-large', strategy: 'stay' })
    expect(oversized.requests).toHaveLength(0)
    const forged = specialistFixture()
    forged.choose(`REUSE(${randomUUID()}):writing:simple`)
    expect(await forged.router.routeTurn(forged.input, forged.hooks)).toMatchObject({ reason: 'classifier-invalid', strategy: 'stay' })
    expect(forged.reconciliations).toHaveLength(1)
  })

  it('decodes historical v1 stay/swap checkpoints without mutating or rewriting their history', async () => {
    for (const enabled of [false, true]) {
      const f = fixture()
      f.view.policy.enabled = enabled
      const result = await f.router.routeTurn(f.input, f.hooks)
      const { strategy: _strategy, specialist: _specialist, strategyCosts: _costs, ...historical } = result
      expect(await f.router.routeTurn({ ...f.input, recordedDecision: historical }, f.hooks)).toBe(historical)
      expect(historical).not.toHaveProperty('strategy')
      expect(f.checkpoints).toHaveLength(1)
    }
  })

  it('defaults historic policies to disabled delegation and validates specialist bounds', () => {
    const {
      specialistEnabled: _enabled,
      specialistMaxContexts: _contexts,
      specialistMaxContextBytes: _bytes,
      specialistMaxReportTokens: _tokens,
      specialistMaxTurns: _turns,
      ...historical
    } = DEFAULT_ROUTING_POLICY
    expect(RoutingPolicyInputSchema.parse(historical)).toEqual(DEFAULT_ROUTING_POLICY)
    for (const invalid of [{ specialistMaxContexts: 9 }, { specialistMaxContextBytes: 4_095 }, { specialistMaxReportTokens: 4_097 }, { specialistMaxTurns: 0 }])
      expect(RoutingPolicyInputSchema.safeParse({ ...DEFAULT_ROUTING_POLICY, ...invalid }).success).toBe(false)
  })
})

describe('eligible, confidence-gated per-turn routing', () => {
  it('compares compacted incumbent and canonical alternate input, output, classifier and switching costs', async () => {
    const f = fixture()
    const result = await f.router.routeTurn(f.input, f.hooks)
    expect(result).toMatchObject({
      switched: true,
      strategy: 'swap',
      specialist: null,
      profileId: f.alternate.profileId,
      estimatedCurrentCostMicros: 120_000,
      estimatedSelectedCostMicros: 14_000,
      estimatedSavingsMicros: 104_987,
      taskClass: 'writing',
      complexity: 'simple'
    })
    expect(result.classification).toMatchObject({
      latencyMs: 23,
      usage: { inputTokens: 300, outputTokens: 20, totalTokens: 320, totalTokensSource: 'derived' }
    })
    expect(f.reservations).toEqual([{ tokens: 64_000, costMicros: 2_688 }])
    expect(f.reconciliations).toEqual([{ inputTokens: 300, outputTokens: 20, totalTokens: 320, costMicros: 13 }])
    expect(f.checkpoints).toEqual([result])
  })

  it('reconciles an independent reported total without inventing directional or reasoning tokens', async () => {
    const f = fixture()
    Object.assign(f.answer, {
      usage: { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' },
      estimatedCostMicros: 8,
      estimatedCost: { ...f.answer.estimatedCost!, amount: 0.000008 }
    })
    const result = await f.router.routeTurn(f.input, f.hooks)
    expect(result).toMatchObject({
      switched: true,
      classification: { usage: { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' }, estimatedCostMicros: 8 },
      unknownExposure: null
    })
    expect(f.reconciliations).toEqual([{ inputTokens: 123, outputTokens: 12, totalTokens: 190, costMicros: 8 }])
    expect(result.classification!.usage).not.toHaveProperty('reasoningTokens')
    expect(f.checkpoints).toEqual([result])
  })

  it('uses each candidate canonical replay estimate for context eligibility and both cost comparisons', async () => {
    const f = fixture()
    const alternate = { ...f.alternate, canonicalReplayInputTokens: 12_000 }
    const result = await f.router.routeTurn({ ...f.input, fullHistoryInputTokens: 300_000, candidates: [f.current, alternate] }, f.hooks)
    expect(result).toMatchObject({ switched: true, estimatedSelectedCostMicros: 14_000, estimatedSavingsMicros: 104_987 })
    for (const invalid of [Number.NaN, -1, 200_000]) {
      const other = fixture()
      const blocked = { ...other.alternate, canonicalReplayInputTokens: invalid }
      expect(await other.router.routeTurn({ ...other.input, candidates: [other.current, blocked] }, other.hooks)).toMatchObject({
        switched: false,
        reason: 'no-eligible-alternative'
      })
      expect(other.requests).toHaveLength(0)
    }
  })

  it('keeps the incumbent when its compaction is cheaper than replay on an alternate', async () => {
    const f = fixture()
    const result = await f.router.routeTurn({ ...f.input, currentInputTokens: 100, fullHistoryInputTokens: 150_000 }, f.hooks)
    expect(result).toMatchObject({ switched: false, reason: 'classifier-overhead', profileId: f.current.profileId })
    expect(f.requests).toHaveLength(0)
  })

  it('does not classify pinned, disabled or same-profile turns, even when a model declaration exists', async () => {
    for (const mode of ['pinned', 'disabled', 'same-profile']) {
      const f = fixture()
      if (mode === 'disabled') f.view.policy.enabled = false
      const input = { ...f.input, pinned: mode === 'pinned', candidates: mode === 'same-profile' ? [f.current] : f.input.candidates }
      const result = await f.router.routeTurn(input, f.hooks)
      expect(result.switched).toBe(false)
      expect(f.requests).toHaveLength(0)
      expect(f.reservations).toHaveLength(0)
    }
  })

  it('excludes inaccessible, unready, mismatched-version, modality, tool, schema and context candidates before inference', async () => {
    const cases: Partial<RoutingCandidate>[] = [
      { authorized: false },
      { enabled: false },
      { credentialReady: false },
      { conformed: false },
      { profileVersionId: randomUUID() },
      { modalities: [] },
      { capabilities: { ...fixture().alternate.capabilities, toolCalling: 'prompt' } },
      { capabilities: { ...fixture().alternate.capabilities, structuredOutput: 'prompt-only' } },
      { capabilities: { ...fixture().alternate.capabilities, maxContextTokens: 12_500 } },
      { capabilities: { ...fixture().alternate.capabilities, maxOutputTokens: 500 } }
    ]
    for (const change of cases) {
      const f = fixture()
      const result = await f.router.routeTurn({ ...f.input, candidates: [f.current, { ...f.alternate, ...change }] }, f.hooks)
      expect(result).toMatchObject({ switched: false, reason: 'no-eligible-alternative' })
      expect(f.requests).toHaveLength(0)
    }
  })

  it('requires conformed generation tools, transcription and native external MCP capability', async () => {
    for (const requirements of [{ generationTools: ['image'] as const }, { transcription: true }, { nativeExternalMcp: true }]) {
      const f = fixture()
      const current = { ...f.current, generationTools: ['image'] as const, transcription: true }
      const alternate = {
        ...f.alternate,
        capabilities: { ...f.alternate.capabilities, toolCalling: ('nativeExternalMcp' in requirements ? 'prompt' : 'native') as 'prompt' | 'native' }
      }
      const result = await f.router.routeTurn(
        { ...f.input, current, candidates: [current, alternate], requirements: { ...f.input.requirements, nativeTools: false, ...requirements } },
        f.hooks
      )
      expect(result.reason).toBe('no-eligible-alternative')
      expect(f.requests).toHaveLength(0)
    }
  })

  it('never falls back to an unauthorized incumbent', async () => {
    const f = fixture()
    await expect(f.router.routeTurn({ ...f.input, current: { ...f.current, authorized: false } }, f.hooks)).rejects.toMatchObject({
      code: 'ROUTING_NO_AUTHORIZED_MODEL'
    })
    expect(f.requests).toHaveLength(0)
    expect(f.checkpoints).toHaveLength(0)
  })

  it('rejects wrong choices, nonmaximal choices and malformed probability distributions after accounting billed usage', async () => {
    const malformed: Partial<DecisionResult>[] = [
      { choice: 'unknown:simple' },
      { probabilities: { 'writing:simple': 1 } },
      { probabilities: { ...fixture().answer.probabilities, 'writing:simple': Number.NaN } },
      { probabilities: { ...fixture().answer.probabilities, 'writing:simple': 0.2 } },
      { probabilities: { ...fixture().answer.probabilities, 'writing:simple': 0.1, 'analysis:complex': 0.9 } },
      { confidence: Number.POSITIVE_INFINITY }
    ]
    for (const change of malformed) {
      const f = fixture()
      Object.assign(f.answer, change)
      const result = await f.router.routeTurn(f.input, f.hooks)
      expect(result).toMatchObject({ switched: false, reason: 'classifier-invalid' })
      expect(f.reconciliations).toHaveLength(1)
      expect(f.getReleased()).toBe(0)
    }
  })

  it('requires BOTH confidence and chosen-label probability to reach the configured threshold', async () => {
    for (const probabilities of [false, true]) {
      const f = fixture()
      if (probabilities) Object.assign(f.answer, { probabilities: { ...f.answer.probabilities, 'writing:simple': 0.94, 'writing:moderate': 0.06 } })
      else Object.assign(f.answer, { confidence: 0.94 })
      const result = await f.router.routeTurn(f.input, f.hooks)
      expect(result.reason).toBe('classifier-low-confidence')
      expect(f.reconciliations).toHaveLength(1)
    }
  })

  it('accepts the exact inclusive configured confidence and probability boundary', async () => {
    const f = fixture()
    Object.assign(f.answer, { confidence: 0.95, probabilities: { ...f.answer.probabilities, 'writing:simple': 0.95, 'writing:moderate': 0.05 } })
    expect(await f.router.routeTurn(f.input, f.hooks)).toMatchObject({ switched: true })
  })

  it('does not route a confidently classified task the alternative was never declared sufficient for', async () => {
    const f = fixture()
    Object.assign(f.answer, { choice: 'analysis:complex', probabilities: { ...f.answer.probabilities, 'writing:simple': 0, 'analysis:complex': 1 } })
    expect(await f.router.routeTurn(f.input, f.hooks)).toMatchObject({ switched: false, reason: 'no-sufficient-alternative' })
  })

  it('avoids overhead when estimated classifier and switching costs exceed potential savings', async () => {
    const f = fixture()
    const result = await f.router.routeTurn({ ...f.input, currentInputTokens: 10, fullHistoryInputTokens: 10, expectedOutputTokens: 10 }, f.hooks)
    expect(result.reason).toBe('classifier-overhead')
    expect(f.reservations).toHaveLength(0)
  })

  it('keeps unknown incumbent, alternative or classifier pricing out of cost-based switching', async () => {
    for (const missing of ['incumbent', 'alternative', 'classifier']) {
      const f = fixture()
      const current = missing === 'incumbent' ? { ...f.current, pricing: null } : f.current
      const alternate = missing === 'alternative' ? { ...f.alternate, pricing: null } : f.alternate
      if (missing === 'classifier') f.provider.config.pricing = null
      expect(await f.router.routeTurn({ ...f.input, current, candidates: [current, alternate] }, f.hooks)).toMatchObject({ switched: false })
      expect(f.requests).toHaveLength(0)
    }
  })

  it('rechecks net savings including ACTUAL reported classifier usage priced as an estimate', async () => {
    const f = fixture()
    Object.assign(f.answer, { estimatedCostMicros: 110_000 })
    expect(await f.router.routeTurn(f.input, f.hooks)).toMatchObject({ switched: false, reason: 'insufficient-net-savings', estimatedSavingsMicros: -5_000 })
  })

  it('keeps the same underlying model sticky when equal pricing cannot pay for replay and switching', async () => {
    const f = fixture()
    const alternate = { ...f.alternate, model: f.current.model, pricing: f.current.pricing }
    expect(await f.router.routeTurn({ ...f.input, candidates: [f.current, alternate] }, f.hooks)).toMatchObject({
      switched: false,
      reason: 'classifier-overhead'
    })
    expect(f.requests).toHaveLength(0)
  })

  it('does not confuse worst-case native reservation with predicted classifier overhead on a simple turn', async () => {
    const f = fixture()
    f.view.policy.switchCostMicros = 0
    f.view.policy.minimumSavingsMicros = 1
    const result = await f.router.routeTurn({ ...f.input, currentInputTokens: 100, fullHistoryInputTokens: 100, expectedOutputTokens: 10 }, f.hooks)
    expect(result.switched).toBe(true)
    expect(result.classifierExpectedCost!.costMicros).toBeLessThan(result.classifierReservation!.costMicros)
    expect(result.classifierExpectedCost!.basis).toBe('serialized-byte-proxy')
  })

  it('uses custom compatible providers with independently labelled expected and worst-case byte proxies', async () => {
    const f = fixture()
    Object.assign(f.provider, {
      config: {
        kind: 'openai-compatible',
        model: 'decision-model',
        baseUrl: 'https://classifier.example/v1',
        dialect: 'chat-completions',
        timeoutMs: 1_000,
        maxOutputTokens: 1_024,
        pricing: TYPESAFE_JEV_PRICING
      }
    })
    Object.assign(f.answer, { model: 'decision-model' })
    const result = await f.router.routeTurn(f.input, f.hooks)
    expect(result).toMatchObject({
      switched: true,
      classifierReservation: { tokens: 132_096, costMicros: 5_549, basis: 'serialized-byte-proxy' },
      classification: { model: 'decision-model' }
    })
    expect(result.classifierExpectedCost!.costMicros).toBeLessThan(5_549)
    expect(f.requests).toHaveLength(1)
    expect(f.reconciliations).toHaveLength(1)
  })

  it('retains the independent total and residual cost estimate on billed malformed, timeout and provider failures', async () => {
    for (const code of ['INVALID_DECISION_RESPONSE', 'DECISION_TIMEOUT', 'DECISION_PROVIDER_FAILED']) {
      const f = fixture()
      f.setFailure(new DecisionProviderFailure(code, f.provider, { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' }, 100))
      const result = await f.router.routeTurn(f.input, f.hooks)
      expect(result).toMatchObject({
        switched: false,
        reason: 'classifier-failed',
        classifierFailure: { code, usage: { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' }, estimatedCostMicros: 8 },
        unknownExposure: null
      })
      expect(f.reconciliations).toEqual([{ inputTokens: 123, outputTokens: 12, totalTokens: 190, costMicros: 8 }])
      expect(f.getReleased()).toBe(0)
    }
  })

  it('holds full paid exposure when successful or failed classifier counters are unusable', async () => {
    const usage = { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' }
    const malformed = [
      { ...usage, totalTokens: -1 },
      { ...usage, totalTokens: 134 },
      { ...usage, totalTokens: Number.NaN },
      { ...usage, totalTokens: 190.5 },
      { ...usage, totalTokens: Number.MAX_SAFE_INTEGER + 1 },
      { ...usage, inputTokens: -1 },
      { ...usage, outputTokens: Number.POSITIVE_INFINITY },
      { ...usage, inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: Number.MAX_SAFE_INTEGER },
      { ...usage, totalTokensSource: 'derived' },
      { ...usage, totalTokensSource: 'unknown' },
      { inputTokens: 123, outputTokens: 12, totalTokens: 190 },
      { inputTokens: 123, outputTokens: 12 }
    ]
    for (const receivedFailure of [false, true])
      for (const invalid of malformed) {
        const f = fixture()
        if (receivedFailure) {
          const failure = new DecisionProviderFailure('DECISION_PROVIDER_FAILED', f.provider, f.answer.usage, 100)
          Object.assign(failure, { usage: invalid })
          f.setFailure(failure)
        } else Object.assign(f.answer, { usage: invalid })
        const result = await f.router.routeTurn(f.input, f.hooks)
        expect(result).toMatchObject({
          switched: false,
          profileId: f.current.profileId,
          classification: null,
          classifierFailure: { usage: null, estimatedCostMicros: null },
          unknownExposure: { tokens: 64_000, costMicros: 2_688 }
        })
        expect(f.reservations).toHaveLength(1)
        expect(f.reconciliations).toHaveLength(0)
        expect(f.getReleased()).toBe(0)
        expect(await f.router.routeTurn({ ...f.input, recordedDecision: result }, f.hooks)).toBe(result)
        expect(f.requests).toHaveLength(1)
        expect(f.checkpoints).toHaveLength(1)
      }
  })

  it('retains unknown paid exposure without inventing observed input/output tokens', async () => {
    const f = fixture()
    f.setFailure(new Error('socket timeout without usage'))
    expect(await f.router.routeTurn(f.input, f.hooks)).toMatchObject({
      reason: 'classifier-failed',
      classifierFailure: { usage: null, latencyMs: null },
      unknownExposure: { tokens: 64_000, costMicros: 2_688 }
    })
    expect(f.reservations).toHaveLength(1)
    expect(f.reconciliations).toHaveLength(0)
    expect(f.getReleased()).toBe(0)
  })

  it('retains only unknown cost exposure when successful or billed-failure total usage is independently observed', async () => {
    for (const billedFailure of [false, true]) {
      const f = fixture()
      const usage: DecisionResult['usage'] = { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' }
      if (billedFailure) {
        const failure = new DecisionProviderFailure('DECISION_PROVIDER_FAILED', f.provider, usage, 100)
        Object.assign(failure, { estimatedCost: null, estimatedCostMicros: null })
        f.setFailure(failure)
      } else Object.assign(f.answer, { usage, estimatedCost: null, estimatedCostMicros: null })
      const result = await f.router.routeTurn(f.input, f.hooks)
      expect(result).toMatchObject({
        switched: false,
        reason: billedFailure ? 'classifier-failed' : 'unknown-classifier-pricing',
        unknownExposure: { tokens: 0, costMicros: 2_688 }
      })
      expect(result.classification?.usage ?? result.classifierFailure?.usage).toEqual(usage)
      expect(f.reconciliations).toEqual([{ inputTokens: 123, outputTokens: 12, totalTokens: 190, costMicros: 2_688 }])
      expect(await f.router.routeTurn({ ...f.input, recordedDecision: result }, f.hooks)).toBe(result)
      expect(f.reconciliations).toHaveLength(1)
      expect(f.getReleased()).toBe(0)
    }
  })

  it('durably checkpoints residual usage before propagating success or billed-failure reconciliation rejection', async () => {
    for (const billedFailure of [false, true]) {
      const f = fixture()
      const usage: DecisionResult['usage'] = { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' }
      if (billedFailure) f.setFailure(new DecisionProviderFailure('DECISION_PROVIDER_FAILED', f.provider, usage, 100))
      else Object.assign(f.answer, { usage, estimatedCostMicros: 8, estimatedCost: { ...f.answer.estimatedCost!, amount: 0.000008 } })
      Object.assign(f.hooks.budget, {
        async reconcile(_reservation: unknown, actual: (typeof f.reconciliations)[number]) {
          f.reconciliations.push(actual)
          throw new Error('dispatch reservation exceeded')
        }
      })
      await expect(f.router.routeTurn(f.input, f.hooks)).rejects.toThrow('dispatch reservation exceeded')
      expect(f.checkpoints).toHaveLength(1)
      const checkpoint = f.checkpoints[0]!
      expect(checkpoint).toMatchObject({ reason: 'classifier-budget-exceeded', switched: false, unknownExposure: null })
      expect(checkpoint.classification?.usage ?? checkpoint.classifierFailure?.usage).toEqual(usage)
      expect(f.reconciliations).toEqual([{ inputTokens: 123, outputTokens: 12, totalTokens: 190, costMicros: 8 }])
      await expect(f.router.routeTurn({ ...f.input, recordedDecision: checkpoint }, f.hooks)).rejects.toMatchObject({ code: 'AGENT_TOKEN_BUDGET_LIMITED' })
      expect(f.requests).toHaveLength(1)
      expect(f.reconciliations).toHaveLength(1)
      expect(f.getReleased()).toBe(0)
    }
  })

  it('replays success, billed failure and unknown exposure without paying or checkpointing twice', async () => {
    for (const mode of ['success', 'billed-failure', 'unknown']) {
      const f = fixture()
      const usage: DecisionResult['usage'] = { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' }
      if (mode === 'unknown') f.setFailure(new Error('unobserved paid failure'))
      else if (mode === 'billed-failure') f.setFailure(new DecisionProviderFailure('DECISION_PROVIDER_FAILED', f.provider, usage, 100))
      else Object.assign(f.answer, { usage, estimatedCostMicros: 8, estimatedCost: { ...f.answer.estimatedCost!, amount: 0.000008 } })
      const first = await f.router.routeTurn(f.input, f.hooks)
      const replay = await f.router.routeTurn({ ...f.input, recordedDecision: first }, f.hooks)
      expect(replay).toBe(first)
      expect(f.requests).toHaveLength(1)
      expect(f.reservations).toHaveLength(1)
      expect(f.checkpoints).toHaveLength(1)
      expect(f.reconciliations).toEqual(mode === 'unknown' ? [] : [{ inputTokens: 123, outputTokens: 12, totalTokens: 190, costMicros: 8 }])
      await expect(f.router.routeTurn({ ...f.input, runId: randomUUID(), recordedDecision: first }, f.hooks)).rejects.toMatchObject({
        code: 'ROUTING_CHECKPOINT_INVALID'
      })
    }
  })

  it('rejects corrupt durable totals, provenance and released unknown exposure before replay or dispatch validation', async () => {
    for (const mode of ['success', 'billed-failure', 'unknown']) {
      const f = fixture()
      const usage: DecisionResult['usage'] = { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' }
      if (mode === 'unknown') f.setFailure(new Error('unobserved paid failure'))
      else if (mode === 'billed-failure') f.setFailure(new DecisionProviderFailure('DECISION_PROVIDER_FAILED', f.provider, usage, 100))
      else Object.assign(f.answer, { usage, estimatedCostMicros: 8, estimatedCost: { ...f.answer.estimatedCost!, amount: 0.000008 } })
      const first = await f.router.routeTurn(f.input, f.hooks)
      const invalid: RoutingTurnDecision[] = []
      if (mode === 'unknown') invalid.push({ ...first, unknownExposure: null }, { ...first, unknownExposure: { tokens: 0, costMicros: 2_688 } })
      else {
        const badUsages: DecisionResult['usage'][] = [-1, 134, Number.NaN, 190.5].map(totalTokens => ({ ...usage, totalTokens }))
        badUsages.push({ ...usage, totalTokensSource: 'derived' })
        for (const badUsage of badUsages)
          invalid.push({
            ...first,
            ...(first.classification
              ? { classification: { ...first.classification, usage: badUsage } }
              : { classifierFailure: { ...first.classifierFailure!, usage: badUsage } })
          })
      }
      for (const recordedDecision of invalid) {
        await expect(f.router.routeTurn({ ...f.input, recordedDecision }, f.hooks)).rejects.toMatchObject({ code: 'ROUTING_CHECKPOINT_INVALID' })
        await expect(f.router.validateDecision(recordedDecision, {} as Knex)).rejects.toMatchObject({ code: 'ROUTING_CHECKPOINT_INVALID' })
      }
      expect(f.requests).toHaveLength(1)
      expect(f.reservations).toHaveLength(1)
      expect(f.checkpoints).toHaveLength(1)
      expect(f.reconciliations).toHaveLength(mode === 'unknown' ? 0 : 1)
    }
  })

  it('bounds classifier state without retransmitting history and refuses a truncated current request', async () => {
    const f = fixture()
    await f.router.routeTurn({ ...f.input, classifierState: { currentMessage: 'Write a greeting.', recentSummary: '\u0000🙂'.repeat(20_000) } }, f.hooks)
    expect(Buffer.byteLength(JSON.stringify(f.requests[0]!.state))).toBeLessThanOrEqual(f.view.policy.classifierMaxStateBytes)
    const other = fixture()
    expect(await other.router.routeTurn({ ...other.input, classifierState: { currentMessage: 'x'.repeat(20_000) } }, other.hooks)).toMatchObject({
      reason: 'classifier-state-too-large'
    })
    expect(other.requests).toHaveLength(0)
  })

  it('handles unavailable providers, budget denial and cancellation without issuing a classification', async () => {
    for (const mode of ['provider', 'budget', 'abort']) {
      const f = fixture()
      if (mode === 'provider') f.setUnavailable()
      if (mode === 'budget') f.denyBudget()
      const result = await f.router.routeTurn({ ...f.input, signal: mode === 'abort' ? AbortSignal.abort() : undefined }, f.hooks)
      expect(result.switched).toBe(false)
      expect(f.requests).toHaveLength(0)
    }
  })

  it('fences retarget and dispatch when policy or selected declaration changes', async () => {
    const f = fixture()
    const decision = await f.router.routeTurn(f.input, f.hooks)
    await f.router.validateDecision(decision, f.database)
    f.view.models[0]!.revision++
    await expect(f.router.validateDecision(decision, f.database)).rejects.toMatchObject({ code: 'ROUTING_REVISION_CHANGED' })
    f.view.models[0]!.revision--
    f.view.policy.revision++
    await expect(f.router.validateDecision(decision, f.database)).rejects.toMatchObject({ code: 'ROUTING_REVISION_CHANGED' })
  })

  it('requires explicit task/version declarations, unique rubrics and conservative persisted thresholds', () => {
    expect(RoutingPolicyInputSchema.safeParse({ ...DEFAULT_ROUTING_POLICY, minimumConfidence: 0.1 }).success).toBe(false)
    expect(RoutingModelPolicyInputSchema.safeParse({ profileVersionId: randomUUID(), acceptableTasks: [], estimatedLatencyMs: null }).success).toBe(false)
    expect(
      RoutingModelPolicyInputSchema.safeParse({
        profileVersionId: randomUUID(),
        acceptableTasks: [{ taskClass: 'writing', complexities: ['simple', 'simple'] }],
        estimatedLatencyMs: null
      }).success
    ).toBe(false)
  })
})
