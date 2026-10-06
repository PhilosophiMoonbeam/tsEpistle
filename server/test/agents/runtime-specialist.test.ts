import { createHash, randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import type { AgentCurrentPageHint, AgentEventData } from '../../../shared/agents/contracts.ts'
import type { RoutingTurnDecision } from '../../../shared/agents/routing.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import { SUBAGENT_READ_ACTIONS } from '../../agents/orchestration.ts'
import { projectAgentThread } from '../../agents/projection.ts'
import { appendAgentEvent } from '../../agents/repository.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import { AgentSpecialistStore } from '../../agents/specialists.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { createRoutingTables, type RoutingFixture, routingFixture } from './runtime-routing.fixture.ts'

const greeting = 'Write a short greeting'
const report = 'Independent draft: Good morning, everyone.'
const synthesis = 'Good morning, everyone!'
const usage = { inputTokens: 5, outputTokens: 3, totalTokens: 8, costMicros: 10 }

describe('retained independent specialist runtime history', () => {
  let db: Knex
  let f: RoutingFixture
  let children: AgentEngineRequest[]
  let roots: AgentEngineRequest[]
  let classifierCalls: number
  let rootBoundary: (() => Promise<void>) | undefined
  let childBoundary: (() => Promise<void>) | undefined
  let incomplete: boolean

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    await createRoutingTables(db)
    f = await routingFixture(db)
    children = []
    roots = []
    classifierCalls = 0
    rootBoundary = undefined
    childBoundary = undefined
    incomplete = false
    f.engine.preflight = async request => ({
      admissible: true,
      inputExposureTokens: request.specialist ? 20 : 20_000,
      outputExposureTokens: 3,
      totalExposureTokens: request.specialist ? 23 : 20_003
    })
    f.router.decisionProviders.decide = async () => {
      classifierCalls += 1
      return f.answer
    }
    f.engine.execute = async (request, sink) => {
      await request.authorizeDispatch?.()
      const child = request.specialist !== undefined
      if (child) children.push(request)
      else roots.push(request)
      if (!child) await rootBoundary?.()
      const turns = child ? 3 : request.specialistHandoff ? 1 : 3
      for (let turn = 0; turn < turns; turn += 1) {
        const reservation = await request.dispatchBudget!.reserve({ tokens: 8, costMicros: 10 })
        await request.dispatchBudget!.reconcile(reservation, usage)
        await sink.event('model.turn', {
          usageVersion: 2,
          ...usage,
          content: child ? report : synthesis,
          contentTruncated: false,
          actionCallIds: [],
          finishReason: 'stop',
          outcome: 'answer_accepted'
        })
      }
      await sink.text(child ? report : synthesis)
      if (child) await childBoundary?.()
      return {
        inputTokens: 5 * turns,
        outputTokens: 3 * turns,
        totalTokens: 8 * turns,
        costMicros: 10 * turns,
        ...(child && !incomplete
          ? { specialistState: { retained: 'private child continuation' }, specialistAuthoritySha256: 'a'.repeat(64), specialistEvidence: [] }
          : {})
      }
    }
  })
  afterEach(async () => {
    await f?.runtime.shutdown()
    await db.destroy()
  })

  const thread = (sessionId: string) => projectAgentThread(db, 7, sessionId, { profileResolutionToken: () => 'fixture-resolution' })
  const enable = () => Object.assign(f.view.policy, { specialistEnabled: true })
  const warmup = async () => {
    const sessionId = await f.session(true)
    f.view.policy.enabled = false
    await f.submit(sessionId)
    await f.runtime.runOnce()
    expect(roots).toHaveLength(1)
    expect(children).toHaveLength(0)
    f.view.policy.enabled = true
    enable()
    return sessionId
  }
  const scopeSha256 = createHash('sha256')
    .update(canonicalJson({ version: 1, actionAllowlist: SUBAGENT_READ_ACTIONS, currentPage: null, knowledgeContext: null }))
    .digest('hex')
  // Load a durable pre-cutover receipt, not a new routing proposal. The current
  // stay/swap writer cannot create NEW/REUSE labels even with saved policy enabled.
  const historical = async (sessionId: string, contextId: string | null = null, currentPage?: AgentCurrentPageHint) => {
    const saved = await db('agentSessions').where({ id: sessionId }).first('version')
    const admitted = await f.runtime.submit({
      ownerId: 7,
      sessionId,
      clientRequestId: randomUUID(),
      expectedSessionVersion: Number(saved.version),
      profileResolutionToken: await f.registry.issueResolutionToken(7, sessionId),
      content: greeting,
      ...(currentPage === undefined ? {} : { currentPage })
    })
    const candidates = await db.transaction(transaction => f.registry.listRoutingCandidates(transaction, { ownerId: 7, sessionId }))
    const root = candidates.find(candidate => candidate.profileVersionId === f.current.versionId)!
    const child = candidates.find(candidate => candidate.profileVersionId === f.alternate.versionId)!
    const context =
      contextId === null
        ? null
        : (await new AgentSpecialistStore(db).list({ ownerId: 7, rootSessionId: sessionId, scopeSha256, maximumContexts: 4 })).find(
            context => context.id === contextId
          )!
    const choice = `${contextId === null ? 'NEW' : `REUSE(${contextId})`}:writing:simple`
    const decision: RoutingTurnDecision = {
      version: 1,
      ownerId: 7,
      sessionId,
      runId: admitted.run.id,
      policyRevision: f.view.policy.revision,
      profileId: root.profileId,
      profileVersionId: root.profileVersionId,
      modelPolicyRevision: f.view.models[0]!.revision,
      switched: false,
      strategy: 'delegate',
      specialist: {
        contextId,
        contextVersion: context?.version ?? null,
        profileId: child.profileId,
        profileVersionId: child.profileVersionId,
        taskClass: 'writing',
        complexity: 'simple'
      },
      reason: 'lower-estimated-cost',
      taskClass: 'writing',
      complexity: 'simple',
      estimatedCurrentCostMicros: 420_000,
      estimatedSelectedCostMicros: 146_156,
      estimatedSavingsMicros: 272_831,
      classifierExpectedCost: null,
      classifierReservation: { tokens: 64_000, costMicros: 2_688, basis: 'documented-native-context', source: 'Historical classifier reservation' },
      unknownExposure: null,
      classifierFailure: null,
      classification: { ...f.answer, choice, probabilities: { [choice]: 1 } }
    }
    const event = await appendAgentEvent(db, {
      id: randomUUID(),
      runId: admitted.run.id,
      ownerId: 7,
      type: 'model.turn',
      attempt: 1,
      data: {
        purpose: 'routing',
        routingAutomatic: false,
        usageVersion: 2,
        ...f.answer.usage,
        costMicros: f.answer.estimatedCostMicros,
        usageSource: 'reported',
        costSource: 'configured-estimate',
        content: '',
        contentTruncated: false,
        actionCallIds: [],
        routingDecision: decision,
        routingSessionVersion: Number((await db('agentSessions').where({ id: sessionId }).first('version')).version),
        routingIncumbent: root.admission,
        routingSelected: root.admission,
        routingSpecialistAdmission: child.admission,
        routingSpecialistScopeSha256: scopeSha256,
        routingSpecialistExpiresAt: context?.expiresAt ?? new Date(Date.now() + 60_000).toISOString()
      } as unknown as AgentEventData
    })
    return { ...admitted, event }
  }
  const requeue = async (runId: string) => {
    await db('agentRuns').where({ id: runId }).update({ status: 'queued', leaseOwner: null, leaseToken: null, leaseExpiresAt: null, availableAt: new Date() })
  }

  it('does not create specialist work from a saved policy or obsolete session preference', async () => {
    const sessionId = await f.session(true)
    for (const enabled of [false, true]) {
      f.view.policy.specialistEnabled = enabled
      await f.submit(sessionId)
      await f.runtime.runOnce()
    }
    expect(children).toHaveLength(0)
    expect(roots.map(root => root.run.model)).toEqual(['alternate', 'alternate'])
    expect((await thread(sessionId)).specialistInvocations).toEqual([])
    expect(await db('agentSpecialistContexts').select('id')).toEqual([])
  })

  it('executes recorded NEW then REUSE without changing the admitted root or publishing the child as the answer', async () => {
    f.engine.routingRequirements = async () => ({ externalMcp: true })
    const sessionId = await warmup()
    const first = await historical(sessionId)
    rootBoundary = async () => {
      const pending = await thread(sessionId)
      expect(pending.messages.some(message => message.content === report)).toBe(false)
      expect(pending.specialistInvocations).toHaveLength(1)
      expect(pending.specialistInvocations[0]).toMatchObject({ status: 'completed', report, reused: false })
      expect(JSON.stringify(pending.specialistInvocations)).not.toContain('private child continuation')
    }
    await f.runtime.runOnce()
    rootBoundary = undefined
    expect(children).toHaveLength(1)
    const second = await historical(sessionId, children[0]!.specialist!.contextId)
    await f.runtime.runOnce()
    expect(children).toHaveLength(2)
    expect(children[0]!.messages).toEqual([{ role: 'user', content: greeting }])
    expect(children[1]!.messages).toEqual([
      { role: 'user', content: greeting },
      { role: 'assistant', content: report },
      { role: 'user', content: greeting }
    ])
    expect(children.map(child => child.run.model)).toEqual(['alternate', 'alternate'])
    expect(children.map(child => child.purpose)).toEqual(['subagent', 'subagent'])
    expect(children[1]!.specialist?.contextId).toBe(children[0]!.specialist?.contextId)
    expect(children[1]!.specialist?.state).toEqual({ retained: 'private child continuation' })
    expect(children.every(child => child.skills.length === 0 && child.priorActivity.length === 0)).toBe(true)
    expect(roots.map(root => root.run.model)).toEqual(['incumbent', 'incumbent', 'incumbent'])
    expect(roots.map(root => root.run.providerProfileVersionId)).toEqual([f.current.versionId, f.current.versionId, f.current.versionId])
    expect(roots[2]!.messages.map(message => ({ role: message.role, content: message.content }))).toEqual([
      { role: 'user', content: greeting },
      { role: 'assistant', content: synthesis },
      { role: 'user', content: greeting },
      { role: 'assistant', content: synthesis },
      { role: 'user', content: greeting }
    ])
    expect(roots[1]!.specialistHandoff?.report).toBe(report)
    const projected = await thread(sessionId)
    expect(projected.specialistInvocations.map(receipt => receipt.reused)).toEqual([false, true])
    expect(projected.messages.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([synthesis, synthesis, synthesis])
    for (const receipt of [first, second]) {
      const runId = receipt.run.id
      expect((await db('agentEvents').where({ id: receipt.event.id }).first('data')).data).toBe(canonicalJson(receipt.event.data))
      expect(await db('agentRuns').where({ id: runId }).first()).toMatchObject({
        status: 'succeeded',
        inputTokens: 143,
        outputTokens: 24,
        totalTokens: 222,
        estimatedCostMicros: 53
      })
      expect(await db('agentQuotaReservations').where({ runId }).first()).toMatchObject({ consumedTokens: 222, consumedCostMicros: 53, status: 'consumed' })
      const events = (await db('agentEvents').where({ runId, type: 'model.turn' }).select('data')).map(row => JSON.parse(row.data))
      expect(events.filter(event => event.purpose === 'routing')).toHaveLength(1)
      expect(events.filter(event => event.specialistInvocationId)).toHaveLength(3)
      const decision = events.find(event => event.purpose === 'routing').routingDecision
      expect(decision.strategy).toBe('delegate')
      expect(decision.classification.choice).toBe(runId === first.run.id ? 'NEW:writing:simple' : `REUSE(${children[0]!.specialist!.contextId}):writing:simple`)
    }
    expect(classifierCalls).toBe(0)
    expect(await f.runtime.runOnce()).toBe(false)
    expect(Number((await db('agentQuotaDaily').where({ ownerId: 7 }).first()).consumedTokens)).toBe(24 + 222 * 2)
  })

  it('replays a completed receipt after root worker replacement without recharging or redispatching the child', async () => {
    const sessionId = await warmup()
    const admitted = await historical(sessionId)
    rootBoundary = async () => {
      rootBoundary = undefined
      await requeue(admitted.run.id)
      throw Object.assign(new Error('Root worker lost before synthesis dispatch'), { code: 'RUN_LEASE_LOST' })
    }
    await f.runtime.runOnce()
    expect(children).toHaveLength(1)
    await f.runtime.runOnce()
    expect(children).toHaveLength(1)
    expect(classifierCalls).toBe(0)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject({ status: 'succeeded', totalTokens: 222, estimatedCostMicros: 53 })
    expect(await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()).toMatchObject({ consumedTokens: 222, consumedCostMicros: 53 })
    expect((await thread(sessionId)).specialistInvocations).toHaveLength(1)
  })

  it('refuses a pending historical child after the retained specialist policy is disabled', async () => {
    const sessionId = await warmup()
    const admitted = await historical(sessionId)
    f.view.policy.specialistEnabled = false
    await f.runtime.runOnce()
    expect(children).toHaveLength(0)
    expect(roots).toHaveLength(1)
    expect(classifierCalls).toBe(0)
    expect((await db('agentRuns').where({ id: admitted.run.id }).first()).status).toBe('failed')
    expect(await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()).toMatchObject({
      consumedTokens: 190,
      consumedCostMicros: 13,
      status: 'consumed'
    })
  })

  for (const outcome of ['ambiguous', 'failed'] as const) {
    it(`fails closed after a ${outcome} child receipt without a second child or root dispatch`, async () => {
      const sessionId = await warmup()
      const admitted = await historical(sessionId)
      if (outcome === 'failed') incomplete = true
      else
        childBoundary = async () => {
          childBoundary = undefined
          await requeue(admitted.run.id)
          throw Object.assign(new Error('Child response lost with worker lease'), { code: 'RUN_LEASE_LOST' })
        }
      await f.runtime.runOnce()
      if (outcome === 'failed')
        expect((await thread(sessionId)).specialistInvocations[0]).toMatchObject({ status: 'failed', report: null, errorCode: 'AGENT_SPECIALIST_INCOMPLETE' })
      await f.runtime.runOnce()
      expect(children).toHaveLength(1)
      expect(roots).toHaveLength(1)
      expect(classifierCalls).toBe(0)
      expect((await db('agentRuns').where({ id: admitted.run.id }).first()).status).toBe('failed')
      expect((await thread(sessionId)).messages.some(message => message.content === report)).toBe(false)
    })
  }

  for (const change of ['scope', 'provider', 'permission'] as const) {
    it(`rejects recorded reuse after current ${change} changes`, async () => {
      const sessionId = await warmup()
      await historical(sessionId)
      await f.runtime.runOnce()
      expect(children).toHaveLength(1)
      const oldId = children[0]!.specialist!.contextId
      const admitted = await historical(
        sessionId,
        oldId,
        change === 'scope' ? { id: 17, locale: 'en', path: 'changed-source', observedUpdatedAt: new Date().toISOString() } : undefined
      )
      if (change === 'provider') {
        await f.registry.setEnabled(f.alternate.profileId, false, 1, f.alternate.versionId)
      } else if (change === 'permission') {
        await db('agentProviderGrants').where({ profileId: f.alternate.profileId, groupId: 1 }).delete()
      }
      await f.runtime.runOnce()
      expect(children).toHaveLength(1)
      expect(roots).toHaveLength(2)
      expect((await db('agentRuns').where({ id: admitted.run.id }).first()).status).toBe('failed')
      expect(classifierCalls).toBe(0)
      expect(roots.at(-1)?.run.model).toBe('incumbent')
    })
  }
})
