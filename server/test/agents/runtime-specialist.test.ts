import { randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { projectAgentThread } from '../../agents/projection.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { createRoutingTables, type RoutingFixture, routingFixture } from './runtime-routing.fixture.ts'

const greeting = 'Write a short greeting'
const report = 'Independent draft: Good morning, everyone.'
const synthesis = 'Good morning, everyone!'
const usage = { inputTokens: 5, outputTokens: 3, totalTokens: 8, costMicros: 10 }

describe('optional independent specialist runtime', () => {
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
    f.router.decisionProviders.decide = async request => {
      classifierCalls += 1
      const choice = Object.keys(request.criteria).find(label => label.startsWith('REUSE(') && label.endsWith(':writing:simple')) ?? 'NEW:writing:simple'
      return { ...f.answer, choice, probabilities: Object.fromEntries(Object.keys(request.criteria).map(label => [label, label === choice ? 1 : 0])) }
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
    await f.submit(sessionId)
    await f.runtime.runOnce()
    expect(roots).toHaveLength(1)
    expect(children).toHaveLength(0)
    enable()
    return sessionId
  }
  const requeue = async (runId: string) => {
    await db('agentRuns').where({ id: runId }).update({ status: 'queued', leaseOwner: null, leaseToken: null, leaseExpiresAt: null, availableAt: new Date() })
  }

  it('leaves specialist execution disabled by default, including a pinned root', async () => {
    expect(f.view.policy.specialistEnabled).toBe(false)
    const sessionId = await f.session(true)
    await f.submit(sessionId)
    await f.runtime.runOnce()
    expect(classifierCalls).toBe(0)
    expect(children).toHaveLength(0)
    expect(roots[0]?.run.model).toBe('incumbent')
    expect((await thread(sessionId)).specialistInvocations).toEqual([])
    expect(await db('agentSpecialistContexts').select('id')).toEqual([])
  })

  it('selects NEW then REUSE without changing the pinned provider or publishing the child as the answer', async () => {
    const sessionId = await warmup()
    const first = await f.submit(sessionId)
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
    const second = await f.submit(sessionId)
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
    for (const runId of [first.run.id, second.run.id]) {
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
      expect(decision.strategyCosts.rootWorkTurns).toBe(runId === first.run.id ? 3 : 4)
      expect(decision.classification.choice).toBe(runId === first.run.id ? 'NEW:writing:simple' : `REUSE(${children[0]!.specialist!.contextId}):writing:simple`)
    }
    expect(classifierCalls).toBe(2)
    expect(await f.runtime.runOnce()).toBe(false)
    expect(Number((await db('agentQuotaDaily').where({ ownerId: 7 }).first()).consumedTokens)).toBe(24 + 222 * 2)
  })

  it('replays a completed receipt after root worker replacement without recharging or redispatching the child', async () => {
    const sessionId = await warmup()
    const admitted = await f.submit(sessionId)
    rootBoundary = async () => {
      rootBoundary = undefined
      await requeue(admitted.run.id)
      throw Object.assign(new Error('Root worker lost before synthesis dispatch'), { code: 'RUN_LEASE_LOST' })
    }
    await f.runtime.runOnce()
    expect(children).toHaveLength(1)
    await f.runtime.runOnce()
    expect(children).toHaveLength(1)
    expect(classifierCalls).toBe(1)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject({ status: 'succeeded', totalTokens: 222, estimatedCostMicros: 53 })
    expect(await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()).toMatchObject({ consumedTokens: 222, consumedCostMicros: 53 })
    expect((await thread(sessionId)).specialistInvocations).toHaveLength(1)
  })

  for (const outcome of ['ambiguous', 'failed'] as const) {
    it(`fails closed after a ${outcome} child receipt without a second child or root dispatch`, async () => {
      const sessionId = await warmup()
      const admitted = await f.submit(sessionId)
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
      expect(classifierCalls).toBe(1)
      expect((await db('agentRuns').where({ id: admitted.run.id }).first()).status).toBe('failed')
      expect((await thread(sessionId)).messages.some(message => message.content === report)).toBe(false)
    })
  }

  for (const change of ['scope', 'provider', 'permission'] as const) {
    it(`does not offer unsafe reuse after current ${change} changes`, async () => {
      const sessionId = await warmup()
      await f.submit(sessionId)
      await f.runtime.runOnce()
      expect(children).toHaveLength(1)
      const oldId = children[0]!.specialist!.contextId
      if (change === 'provider') {
        await f.registry.setEnabled(f.alternate.profileId, false, 1, f.alternate.versionId)
      } else if (change === 'permission') {
        await db('userGroups').where({ userId: 7, groupId: 1 }).delete()
        await db('users').where({ id: 7 }).increment('authVersion', 1)
      }
      if (change === 'scope') {
        const saved = await db('agentSessions').where({ id: sessionId }).first('version')
        await f.runtime.submit({
          ownerId: 7,
          sessionId,
          clientRequestId: randomUUID(),
          expectedSessionVersion: Number(saved.version),
          profileResolutionToken: await f.registry.issueResolutionToken(7, sessionId),
          content: greeting,
          currentPage: { id: 17, locale: 'en', path: 'changed-source', observedUpdatedAt: new Date().toISOString() }
        })
      } else await f.submit(sessionId)
      await f.runtime.runOnce()
      expect(children.slice(1).some(child => child.specialist?.contextId === oldId)).toBe(false)
      if (change !== 'scope') expect(children).toHaveLength(1)
      expect(roots.at(-1)?.run.model).toBe('incumbent')
    })
  }
})
