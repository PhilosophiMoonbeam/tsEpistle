import { createHash, randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { AgentProductRuntime } from '../../agents/runtime.ts'
import { DEFAULT_AGENT_ORCHESTRATION_LIMITS } from '../../agents/orchestration.ts'
import { DecisionProviderFailure } from '../../agents/decision-providers.ts'
import { appendAgentMessage } from '../../agents/repository.ts'
import { persistAgentApprovalContinuation } from '../../agents/coordinator.ts'
import { agentCompactionSha256, type AgentCompactionReceipt } from '../../agents/compaction.ts'
import { createRoutingTables, routingFixture, type RoutingFixture } from './runtime-routing.fixture.ts'

describe('admitted automatic conversation routing', () => {
  let db: Knex
  let f: RoutingFixture
  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    await createRoutingTables(db)
    f = await routingFixture(db)
  })
  afterEach(async () => {
    await f?.runtime.shutdown()
    await db.destroy()
  })

  it('routes the real admitted prompt and rebinds claimed profile/settings while preserving session preference', async () => {
    const sessionId = await f.session()
    const submitted = await f.submit(sessionId)
    expect(await f.runtime.runOnce()).toBe(true)
    expect(f.classifications()).toBe(1)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]!.messages.at(-1)?.content).toBe('Write a short greeting')
    expect(f.requests[0]!.run).toMatchObject({
      providerProfileVersionId: f.alternate.versionId,
      model: 'alternate',
      capabilityRevision: 'alternate-v1',
      pricingRevision: 'cheap-v1|1000000|2000000'
    })
    expect(await db('agentRuns').where({ id: submitted.run.id }).first()).toMatchObject({
      status: 'succeeded',
      providerProfileVersionId: f.alternate.versionId,
      inputTokens: 128,
      outputTokens: 15,
      totalTokens: 198,
      estimatedCostMicros: 23
    })
    expect(await db('agentSessions').where({ id: sessionId }).first()).toMatchObject({ providerProfileId: null })
    expect(await db('agentQuotaReservations').where({ runId: submitted.run.id }).first()).toMatchObject({
      consumedTokens: 198,
      consumedCostMicros: 23,
      status: 'consumed'
    })
    const routing = (await db('agentEvents').where({ runId: submitted.run.id, type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.purpose === 'routing')
    expect(routing).toMatchObject({ inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported', costMicros: 13 })
    expect(routing.totalTokens - routing.inputTokens - routing.outputTokens).toBe(55)
    const usage = (await db('agentEvents').where({ runId: submitted.run.id, type: 'usage.updated' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.purpose === undefined)
    expect(usage).toMatchObject({ inputTokens: 128, outputTokens: 15, totalTokens: 198, costMicros: 23 })
    expect(await f.runtime.runOnce()).toBe(false)
    expect(f.classifications()).toBe(1)
    expect(Number((await db('agentQuotaDaily').where({ ownerId: 7 }).first()).consumedTokens)).toBe(198)
  })

  it('keeps a derived classifier total and its provenance through journal and quota settlement', async () => {
    Object.assign(f.answer, { usage: { inputTokens: 123, outputTokens: 12, totalTokens: 135, totalTokensSource: 'derived' } })
    const admitted = await f.submit(await f.session())
    await f.runtime.runOnce()
    const routing = (await db('agentEvents').where({ runId: admitted.run.id, type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.purpose === 'routing')
    expect(routing).toMatchObject({ inputTokens: 123, outputTokens: 12, totalTokens: 135, totalTokensSource: 'derived' })
    expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject({ inputTokens: 128, outputTokens: 15, totalTokens: 143 })
    expect(Number((await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()).consumedTokens)).toBe(143)
  })

  it('keeps explicit sessions pinned and isolates simultaneous same-owner session choices', async () => {
    const automatic = await f.session()
    const pinned = await f.session(true)
    await f.submit(automatic)
    await f.submit(pinned)
    await f.runtime.runOnce()
    await f.runtime.runOnce()
    expect(f.requests.find(request => request.run.sessionId === automatic)?.run.model).toBe('alternate')
    expect(f.requests.find(request => request.run.sessionId === pinned)?.run.model).toBe('incumbent')
    expect(f.classifications()).toBe(1)
    expect(await db('agentSessions').where({ id: pinned }).first('providerProfileId')).toEqual({ providerProfileId: f.current.profileId })
  })

  it('does not route to another owners group model', async () => {
    await f.submit(await f.session(false, 8), 8)
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(0)
    expect(f.requests[0]?.run.model).toBe('incumbent')
  })

  it('settles billed classifier failure once and keeps the authorized incumbent', async () => {
    f.failClassifier(
      new DecisionProviderFailure(
        'DECISION_PROVIDER_FAILED',
        f.provider,
        { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' },
        23
      )
    )
    const admitted = await f.submit(await f.session())
    await f.runtime.runOnce()
    expect(f.requests[0]?.run.model).toBe('incumbent')
    const reservation = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
    expect(Number(reservation.consumedTokens)).toBe(198)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject({ inputTokens: 128, outputTokens: 15, totalTokens: 198 })
    const routing = (await db('agentEvents').where({ runId: admitted.run.id, type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.purpose === 'routing')
    expect(routing).toMatchObject({ inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' })
    expect(routing.routingDecision.classifierFailure.usage).toEqual({ inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' })
    expect(Number(reservation.consumedCostMicros)).toBeGreaterThan(10)
    const cost = Number(reservation.consumedCostMicros)
    await f.runtime.runOnce()
    expect(Number((await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()).consumedCostMicros)).toBe(cost)
    expect(Number((await db('agentQuotaDaily').where({ ownerId: 7 }).first()).consumedTokens)).toBe(198)
    expect(f.classifications()).toBe(1)
  })

  it('accounts unknown dispatched exposure separately from reported tokens without a duplicate charge', async () => {
    f.failClassifier(new Error('unmeasured network failure'))
    const admitted = await f.submit(await f.session())
    await f.runtime.runOnce()
    const event = (await db('agentEvents').where({ runId: admitted.run.id, type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.purpose === 'routing')
    expect(event).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0, totalTokensSource: null, costMicros: 0 })
    const exposure = event.routingDecision.unknownExposure
    const reservation = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
    expect(Number(reservation.consumedTokens)).toBe(exposure.tokens + 8)
    expect(Number(reservation.consumedCostMicros)).toBe(exposure.costMicros + 10)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject({ inputTokens: 5, outputTokens: 3, totalTokens: 8 })
    const usage = (await db('agentEvents').where({ runId: admitted.run.id, type: 'usage.updated' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.purpose === undefined)
    expect(usage).toMatchObject({ inputTokens: 5, outputTokens: 3, totalTokens: 8, unsettledExposure: exposure })
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(1)
  })

  it('never dispatches a selected profile whose live version is revoked after routing', async () => {
    f.beforeInference(() => f.registry.setEnabled(f.alternate.profileId, false, 1, f.alternate.versionId))
    const admitted = await f.submit(await f.session())
    await f.runtime.runOnce()
    expect(f.requests).toHaveLength(0)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first('status')).toEqual({ status: 'failed' })
    expect(Number((await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()).consumedTokens)).toBe(190)
  })

  it('discards prior-profile opaque continuation while replaying the canonical assistant text', async () => {
    const sessionId = await f.session()
    await appendAgentMessage(db, { ownerId: 7, sessionId, role: 'user', status: 'complete', content: 'Earlier request' })
    await appendAgentMessage(db, { ownerId: 7, sessionId, role: 'assistant', status: 'complete', content: 'A canonical earlier answer' })
    const earlier = await db('agentMessages').where({ sessionId, role: 'assistant' }).first('id')
    await db('agentMessages')
      .where({ id: earlier.id })
      .update({ providerStateCiphertext: Buffer.from('invalid old opaque state'), providerStateSha256: 'a'.repeat(64) })
    const admitted = await f.submit(sessionId)
    const original = await db('agentRuns').where({ id: admitted.run.id }).first()
    const earlierUser = await db('agentMessages').where({ sessionId, content: 'Earlier request' }).first('id')
    const originRunId = randomUUID()
    await db('agentRuns').insert({
      ...original,
      id: originRunId,
      userMessageId: earlierUser.id,
      assistantMessageId: earlier.id,
      clientRequestId: randomUUID(),
      status: 'succeeded',
      availableAt: new Date(0),
      queuedAt: new Date(0),
      completedAt: new Date(1),
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null
    })
    await db('agentMessages').where({ id: earlier.id }).update({ runId: originRunId })
    await f.runtime.runOnce()
    expect(f.requests[0]?.run.model).toBe('alternate')
    expect(f.requests[0]?.messages.find(message => message.content === 'A canonical earlier answer')?.providerState).toBeUndefined()
  })

  it('drops an incumbent history checkpoint on model switch but retains canonical replay', async () => {
    const execute = f.engine.execute
    let first = true
    f.view.policy.enabled = false
    f.engine.execute = async (request, sink) => {
      if (first) {
        first = false
        const summary = 'An incumbent-specific compacted greeting request.'
        const source = request.messages[0]!.canonicalSource!
        const reservation = await request.dispatchBudget!.reserve({ tokens: 14, costMicros: 5 })
        await request.dispatchBudget!.reconcile(reservation, { inputTokens: 11, outputTokens: 3, totalTokens: 14, costMicros: 5 })
        const receipt: AgentCompactionReceipt = {
          turn: 1,
          outcome: 'context_compacted',
          usageVersion: 2,
          inputTokens: 11,
          outputTokens: 3,
          totalTokens: 14,
          costMicros: 5,
          content: summary,
          contentTruncated: false,
          actionCallIds: [],
          finishReason: 'stop',
          groundedExpiresAt: null,
          compaction: {
            version: 1,
            scope: 'history',
            ownerId: request.run.ownerId,
            sessionId: request.run.sessionId,
            sourceRunId: request.run.id,
            providerProfileVersionId: request.run.providerProfileVersionId,
            transportKind: request.run.transportKind,
            model: request.run.model,
            capabilityRevision: request.run.capabilityRevision,
            summarySha256: agentCompactionSha256(summary),
            groundedExpiresAt: null,
            throughMessageId: source.id,
            throughOrdinal: source.ordinal,
            sourceSha256: request.compaction!.sourcePrefixSha256[0]!
          }
        }
        await sink.commitCompaction!(receipt)
      }
      return execute(request, sink)
    }
    const sessionId = await f.session()
    await f.submit(sessionId)
    await f.runtime.runOnce()
    const priorCheckpoint = (await db('agentEvents').where({ type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.outcome === 'context_compacted')
    expect(priorCheckpoint.compaction.providerProfileVersionId).toBe(f.current.versionId)
    f.view.policy.enabled = true
    await f.submit(sessionId)
    await f.runtime.runOnce()
    expect(f.requests[1]?.run.model).toBe('alternate')
    expect(f.requests[1]?.compaction?.checkpoint).toBeUndefined()
    expect(f.requests[1]?.messages.map(message => message.content)).toEqual(['Write a short greeting', 'Hello!', 'Write a short greeting'])
  })

  for (const outcome of ['success', 'billed-failure', 'unmeasured-failure', 'malformed-total'] as const) {
    it(`replays ${outcome} classifier accounting after worker replacement without erasing residual or double charging`, async () => {
      const measured = outcome === 'success' || outcome === 'billed-failure'
      if (outcome === 'billed-failure')
        f.failClassifier(
          new DecisionProviderFailure(
            'DECISION_PROVIDER_FAILED',
            f.provider,
            { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' },
            23
          )
        )
      else if (outcome === 'unmeasured-failure') f.failClassifier(new Error('Submitted classifier response was lost'))
      else if (outcome === 'malformed-total')
        Object.assign(f.answer, { usage: { inputTokens: 123, outputTokens: 12, totalTokens: -1, totalTokensSource: 'reported' } })
      const execute = f.engine.execute
      let attempts = 0
      f.engine.execute = async (request, sink) => {
        const result = await execute(request, sink)
        attempts += 1
        if (attempts === 1) {
          await sink.event('model.turn', {
            usageVersion: 2,
            outcome: 'answer_accepted',
            inputTokens: 5,
            outputTokens: 3,
            totalTokens: 8,
            costMicros: 10,
            content: 'Hello!',
            contentTruncated: false,
            actionCallIds: [],
            finishReason: 'stop'
          })
          await db('agentRuns').where({ id: request.run.id }).update({
            status: 'queued',
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            availableAt: new Date()
          })
          throw Object.assign(new Error('Worker replaced after durable model event'), { code: 'RUN_LEASE_LOST' })
        }
        return result
      }
      const admitted = await f.submit(await f.session())
      await f.runtime.runOnce()
      const replacement = new AgentProductRuntime(db, f.registry, f.engine, {
        router: f.router,
        workerId: `routing-replacement-${randomUUID()}`,
        globalConcurrency: 1,
        perUserConcurrency: 1,
        orchestration: { ...DEFAULT_AGENT_ORCHESTRATION_LIMITS, enabled: false }
      })
      try {
        await replacement.runOnce()
      } finally {
        await replacement.shutdown()
      }
      expect(f.classifications()).toBe(1)
      const selected = outcome === 'success' ? 'alternate' : 'incumbent'
      expect(f.requests.map(request => request.run.model)).toEqual([selected, selected])
      const routingEvents = (await db('agentEvents').where({ runId: admitted.run.id, type: 'model.turn' }).select('data'))
        .map(row => JSON.parse(row.data))
        .filter(event => event.purpose === 'routing')
      expect(routingEvents).toHaveLength(1)
      const routing = routingEvents[0]
      expect(routing).toMatchObject(
        measured
          ? { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' }
          : { inputTokens: 0, outputTokens: 0, totalTokens: 0, totalTokensSource: null, costMicros: 0 }
      )
      if (outcome === 'malformed-total')
        expect(routing.routingDecision).toMatchObject({ reason: 'classifier-invalid', classifierFailure: { code: 'INVALID_DECISION_RESPONSE', usage: null } })
      const exposure = measured ? { tokens: 0, costMicros: 0 } : routing.routingDecision.unknownExposure
      if (!measured) expect(exposure.tokens).toBeGreaterThan(0)
      const reportedTokens = measured ? 206 : 16
      const consumedTokens = reportedTokens + exposure.tokens
      const reservation = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
      expect(Number(reservation.consumedTokens)).toBe(consumedTokens)
      expect(Number(reservation.consumedCostMicros)).toBe(routing.costMicros + exposure.costMicros + 20)
      expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject({
        inputTokens: measured ? 133 : 10,
        outputTokens: measured ? 18 : 6,
        totalTokens: reportedTokens
      })
      expect(Number((await db('agentQuotaDaily').where({ ownerId: 7 }).first()).consumedTokens)).toBe(consumedTokens)
      expect(await f.runtime.runOnce()).toBe(false)
      expect(Number((await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()).consumedTokens)).toBe(consumedTokens)
    })
  }

  it('preserves the recorded routing choice and classifier usage on approval continuation', async () => {
    await db.schema.alterTable('agentProposals', table => {
      table.uuid('requesterRequestId')
      table.integer('requesterUserId')
      table.uuid('actionCallId')
      table.text('input')
      table.integer('authorityVersion')
    })
    await db.schema.alterTable('agentApprovals', table => {
      table.uuid('runId')
      table.integer('requesterUserId')
      table.string('inputHash')
      table.integer('authorityVersion')
      table.string('authoritySha256')
    })
    const execute = f.engine.execute
    let stopping: Promise<void> | undefined
    f.engine.execute = async (request, sink) => {
      await execute(request, sink)
      await sink.event('model.turn', {
        usageVersion: 2,
        outcome: 'approval_required',
        inputTokens: 5,
        outputTokens: 3,
        totalTokens: 8,
        costMicros: 10,
        content: 'Approve this operation.',
        contentTruncated: false,
        actionCallIds: [],
        finishReason: 'stop'
      })
      const proposalId = randomUUID(),
        approvalId = randomUUID(),
        actionCallId = randomUUID()
      const actionInput = { proposalId }
      const encodedInput = JSON.stringify(actionInput)
      const inputHash = createHash('sha256').update(encodedInput).digest('hex')
      const authoritySha256 = 'a'.repeat(64)
      const now = new Date(),
        expiresAt = new Date(Date.now() + 60_000)
      await db('agentProposals').insert({
        id: proposalId,
        sessionId: request.run.sessionId,
        runId: request.run.id,
        sourceKind: 'agent',
        requesterRequestId: request.run.id,
        requesterUserId: 7,
        actionCallId,
        actionName: 'pages.applyProposal',
        input: encodedInput,
        inputHash,
        authorityVersion: 1,
        authoritySha256,
        risk: 'write',
        status: 'applied',
        summary: 'Approved fixture',
        operation: '{}',
        expiresAt,
        createdAt: now
      })
      await db('agentApprovals').insert({
        id: approvalId,
        proposalId,
        runId: request.run.id,
        requesterUserId: 7,
        inputHash,
        authorityVersion: 1,
        authoritySha256,
        status: 'approved',
        requestedAt: now,
        expiresAt,
        decidedAt: now
      })
      await persistAgentApprovalContinuation(db, {
        runId: request.run.id,
        ownerId: 7,
        attempt: request.run.attempts,
        leaseToken: request.run.leaseToken,
        actionCallId,
        actionName: 'pages.applyProposal',
        actionInput,
        proposalId,
        approvalId,
        proposalInputHash: inputHash,
        authorityVersion: 1,
        authoritySha256
      })
      stopping = f.runtime.shutdown()
      throw request.signal.reason
    }
    const admitted = await f.submit(await f.session())
    await f.runtime.runOnce()
    await stopping
    expect(await db('agentRuns').where({ id: admitted.run.id }).first('status')).toEqual({ status: 'awaiting_approval' })
    await db('agentRuns')
      .where({ id: admitted.run.id })
      .update({ leaseExpiresAt: new Date(0) })
    f.engine.resumeAction = async (request, checkpoint, sink) => {
      expect(checkpoint.runId).toBe(admitted.run.id)
      expect(request.run.model).toBe('alternate')
      return execute(request, sink)
    }
    const resumed = new AgentProductRuntime(db, f.registry, f.engine, {
      router: f.router,
      workerId: 'approval-routing-resume',
      globalConcurrency: 1,
      perUserConcurrency: 1,
      orchestration: { ...DEFAULT_AGENT_ORCHESTRATION_LIMITS, enabled: false }
    })
    try {
      await resumed.runOnce()
    } finally {
      await resumed.shutdown()
    }
    expect(f.classifications()).toBe(1)
    expect(Number((await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()).consumedTokens)).toBe(206)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject({ inputTokens: 133, outputTokens: 18, totalTokens: 206 })
  })

  it('keeps classifier dispatch inside the existing goal token limit and preserves root action/deadline limits', async () => {
    const sessionId = await f.session()
    const goal = await f.runtime.createGoal({
      goalId: randomUUID(),
      ownerId: 7,
      sessionId,
      profileResolutionToken: await f.registry.issueResolutionToken(7, sessionId),
      clientRequestId: randomUUID(),
      expectedSessionVersion: 1,
      objective: 'Write a short greeting'
    })
    await db('agentGoals').where({ id: goal.goal.id }).update({ maxTokens: 5_000, maxToolCalls: 2 })
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(0)
    expect(f.requests[0]?.run.model).toBe('incumbent')
    expect(f.requests[0]?.limits).toMatchObject({ maxTokens: 5_000, maxToolCalls: 2 })
    expect(Number((await db('agentQuotaReservations').where({ runId: goal.run.id }).first()).consumedTokens)).toBe(8)
    const decision = (await db('agentEvents').where({ runId: goal.run.id, type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.purpose === 'routing')
    expect(decision.routingDecision.reason).toBe('classifier-budget-unavailable')
  })

  it('settles unknown classifier exposure once even when a concurrent default change prevents commit', async () => {
    await f.registry.setGrants(f.alternate.profileId, 'all_agent_users', [], 1)
    f.failClassifier(new Error('unknown submitted-call usage'))
    f.duringClassification(() => f.registry.setDefault(f.alternate.profileId, 1))
    const admitted = await f.submit(await f.session())
    await f.runtime.runOnce()
    expect(f.requests).toHaveLength(0)
    const decision = (await db('agentEvents').where({ runId: admitted.run.id, type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.purpose === 'routing')
    const reservation = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
    expect(Number(reservation.consumedTokens)).toBe(decision.routingDecision.unknownExposure.tokens)
    expect(Number(reservation.consumedCostMicros)).toBe(decision.routingDecision.unknownExposure.costMicros)
    expect(f.classifications()).toBe(1)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first('status', 'providerProfileVersionId')).toEqual({
      status: 'failed',
      providerProfileVersionId: f.current.versionId
    })
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(1)
    expect(Number((await db('agentQuotaDaily').where({ ownerId: 7 }).first()).consumedTokens)).toBe(decision.routingDecision.unknownExposure.tokens)
    expect(Number((await db('agentQuotaDaily').where({ ownerId: 7 }).first()).consumedCostMicros)).toBe(decision.routingDecision.unknownExposure.costMicros)
  })

  it('preserves billed over-reservation classifier usage and prevents any root dispatch', async () => {
    Object.assign(f.answer, { usage: { inputTokens: 123, outputTokens: 12, totalTokens: 65_020, totalTokensSource: 'reported' }, estimatedCostMicros: 3_000 })
    const admitted = await f.submit(await f.session())
    await f.runtime.runOnce()
    expect(f.requests).toHaveLength(0)
    const decision = (await db('agentEvents').where({ runId: admitted.run.id, type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.purpose === 'routing')
    expect(decision.routingDecision.reason).toBe('classifier-budget-exceeded')
    expect(decision).toMatchObject({ inputTokens: 123, outputTokens: 12, totalTokens: 65_020, totalTokensSource: 'reported' })
    const reservation = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
    expect(Number(reservation.consumedTokens)).toBe(65_020)
    expect(Number(reservation.consumedCostMicros)).toBe(3_000)
  })

  it('rejects stale routing policy authority after a billed classification', async () => {
    f.duringClassification(async () => {
      f.view.policy.revision += 1
    })
    const admitted = await f.submit(await f.session())
    await f.runtime.runOnce()
    expect(f.requests).toHaveLength(0)
    const reservation = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
    expect(Number(reservation.consumedTokens)).toBe(190)
    expect(Number(reservation.consumedCostMicros)).toBe(13)
  })

  it('does not classify or infer after the existing goal deadline expires', async () => {
    const sessionId = await f.session()
    const created = await f.runtime.createGoal({
      goalId: randomUUID(),
      ownerId: 7,
      sessionId,
      profileResolutionToken: await f.registry.issueResolutionToken(7, sessionId),
      clientRequestId: randomUUID(),
      expectedSessionVersion: 1,
      objective: 'Write a short greeting'
    })
    await db('agentGoals')
      .where({ id: created.goal.id })
      .update({ deadlineAt: new Date(0) })
    await f.runtime.runOnce()
    expect(f.requests).toHaveLength(0)
    expect(f.classifications()).toBe(0)
    const reservation = await db('agentQuotaReservations').where({ runId: created.run.id }).first()
    expect(Number(reservation.consumedTokens)).toBe(0)
    expect(reservation.status).toBe('released')
    expect(await db('agentGoals').where({ id: created.goal.id }).first('status', 'budgetSelection', 'budgetLimitReason')).toEqual({
      status: 'budget_limited',
      budgetSelection: 'pending',
      budgetLimitReason: 'duration'
    })
  })

  it('rechecks a shortened goal deadline before root dispatch without erasing the paid classifier receipt', async () => {
    const sessionId = await f.session()
    const created = await f.runtime.createGoal({
      goalId: randomUUID(),
      ownerId: 7,
      sessionId,
      profileResolutionToken: await f.registry.issueResolutionToken(7, sessionId),
      clientRequestId: randomUUID(),
      expectedSessionVersion: 1,
      objective: 'Write a short greeting'
    })
    f.beforeInference(async () => {
      await db('agentGoals')
        .where({ id: created.goal.id })
        .update({ deadlineAt: new Date(0) })
    })
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(1)
    expect(f.requests).toHaveLength(0)
    const reservation = await db('agentQuotaReservations').where({ runId: created.run.id }).first()
    expect(Number(reservation.consumedTokens)).toBe(190)
    expect(Number(reservation.consumedCostMicros)).toBe(13)
    expect(reservation.status).toBe('consumed')
  })

  it('excludes native framing/schema/context-inadmissible alternatives before any classifier dispatch', async () => {
    f.engine.preflight = async request => {
      const fits = request.run.model !== 'alternate'
      return { admissible: fits, inputExposureTokens: fits ? 5 : 50_000, outputExposureTokens: 3, totalExposureTokens: fits ? 8 : 50_003 }
    }
    await f.submit(await f.session())
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(0)
    expect(f.requests[0]?.run.model).toBe('incumbent')
  })
})
