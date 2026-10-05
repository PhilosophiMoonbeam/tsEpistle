import { createHash, randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { AgentProductRuntime } from '../../agents/runtime.ts'
import { DEFAULT_AGENT_ORCHESTRATION_LIMITS } from '../../agents/orchestration.ts'
import { DecisionProviderFailure } from '../../agents/decision-providers.ts'
import { AgentRepositoryError, appendAgentMessage } from '../../agents/repository.ts'
import { admitAgentRunInTransaction, persistAgentApprovalContinuation } from '../../agents/coordinator.ts'
import { agentCompactionSha256, type AgentCompactionReceipt } from '../../agents/compaction.ts'
import { getOwnedAgentGoal, insertAgentGoal } from '../../agents/goals.ts'
import { storeAgentMedia } from '../../agents/media.ts'
import { createRoutingTables, routingFixture, type RoutingFixture } from './runtime-routing.fixture.ts'
import { PdfFixtureDocument } from './pdf-fixture.ts'

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
    const next = await f.submit(sessionId)
    expect(next.run.providerProfileVersionId).toBe(f.alternate.versionId)
    await f.runtime.runOnce()
    expect(f.requests[1]?.run.model).toBe('alternate')
    expect(f.classifications()).toBe(2)
    const nextRouting = (await db('agentEvents').where({ runId: next.run.id, type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.purpose === 'routing')
    expect(nextRouting.routingDecision).toMatchObject({ profileVersionId: f.alternate.versionId, strategy: 'stay', switched: false })
    expect(Number((await db('agentQuotaDaily').where({ ownerId: 7 }).first()).consumedTokens)).toBe(396)
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

  it('upgrades a retained simple-task model to the configured safe model for complex work', async () => {
    const sessionId = await f.session()
    await f.submit(sessionId)
    await f.runtime.runOnce()
    Object.assign(f.answer, {
      choice: 'coding:complex',
      probabilities: Object.fromEntries(Object.keys(f.answer.probabilities).map(choice => [choice, choice === 'coding:complex' ? 1 : 0]))
    })
    const saved = await db('agentSessions').where({ id: sessionId }).first('version')
    const next = await f.runtime.submit({
      ownerId: 7,
      sessionId,
      expectedSessionVersion: Number(saved.version),
      profileResolutionToken: await f.registry.issueResolutionToken(7, sessionId),
      clientRequestId: randomUUID(),
      content: 'Write a short greeting, then implement a distributed transaction coordinator and prove its lease fencing under concurrent failures.'
    })
    expect(next.run.providerProfileVersionId).toBe(f.alternate.versionId)
    await f.runtime.runOnce()
    expect(await db('agentRuns').where({ id: next.run.id }).first('status', 'errorCode', 'errorMessage')).toMatchObject({
      status: 'succeeded',
      errorCode: null
    })
    expect(f.requests[1]?.run.model).toBe('incumbent')
    const event = (await db('agentEvents').where({ runId: next.run.id, type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(value => value.purpose === 'routing')
    expect(event.routingDecision).toMatchObject({ profileVersionId: f.current.versionId, strategy: 'swap', switched: true })
    expect(f.classifications()).toBe(2)
  })

  it('accounts a failed next-task classifier and falls back from a retained model to the safe configured model', async () => {
    const sessionId = await f.session()
    await f.submit(sessionId)
    await f.runtime.runOnce()
    f.failClassifier(new DecisionProviderFailure('DECISION_PROVIDER_FAILED', f.provider, f.answer.usage, 23))
    const next = await f.submit(sessionId)
    expect(next.run.providerProfileVersionId).toBe(f.alternate.versionId)
    await f.runtime.runOnce()
    expect(await db('agentRuns').where({ id: next.run.id }).first('status', 'errorCode', 'errorMessage')).toMatchObject({
      status: 'succeeded',
      errorCode: null
    })
    expect(f.requests[1]?.run.model).toBe('incumbent')
    expect(f.classifications()).toBe(2)
    expect(Number((await db('agentQuotaReservations').where({ runId: next.run.id }).first()).consumedTokens)).toBe(198)
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(2)
  })

  for (const change of ['default', 'grant', 'policy', 'disabled-policy', 'profile-version'] as const) {
    it(`resets trusted incumbent selection when the current ${change} changes`, async () => {
      const sessionId = await f.session()
      await f.submit(sessionId)
      await f.runtime.runOnce()
      const oldToken = await f.registry.issueResolutionToken(7, sessionId)
      if (change === 'default') await f.registry.setDefault(f.current.profileId, 1)
      if (change === 'grant') await f.registry.setGrants(f.alternate.profileId, 'groups', [2], 1)
      if (change === 'profile-version') {
        const settings = await f.registry.getAdmin(f.alternate.profileId)
        await f.registry.update(f.alternate.profileId, { ...settings, secretReference: 'env:TEST_PROVIDER_KEY', actorId: 1 })
      }
      if (change === 'policy' || change === 'disabled-policy') {
        f.view.policy.revision += 1
        if (change === 'disabled-policy') f.view.policy.enabled = false
        const { revision, updatedAt: _updatedAt, ...config } = f.view.policy
        await db('agentRoutingPolicy')
          .where({ id: 1 })
          .update({ revision, config: JSON.stringify(config) })
      }
      await expect(
        Promise.resolve(db.transaction(transaction => f.registry.resolve(transaction, { ownerId: 7, sessionId, profileResolutionToken: oldToken })))
      ).rejects.toMatchObject({ code: 'PROFILE_RESOLUTION_CHANGED' })
      const next = await f.submit(sessionId)
      expect(next.run.providerProfileVersionId).toBe(f.current.versionId)
      if (change === 'disabled-policy') {
        await f.runtime.runOnce()
        expect(f.requests[1]?.run.model).toBe('incumbent')
      }
    })
  }

  it('never borrows an ordinary routed incumbent from another conversation', async () => {
    await f.submit(await f.session())
    await f.runtime.runOnce()
    const next = await f.submit(await f.session())
    expect(next.run.providerProfileVersionId).toBe(f.current.versionId)
  })

  it('fails closed rather than reusing a corrupted prior routing receipt', async () => {
    const sessionId = await f.session()
    const first = await f.submit(sessionId)
    await f.runtime.runOnce()
    const rows = await db('agentEvents').where({ runId: first.run.id, type: 'model.turn' }).select('id', 'data')
    const routing = rows.find(row => JSON.parse(row.data).purpose === 'routing')!
    await db('agentEvents')
      .where({ id: routing.id })
      .update({ dataSha256: 'f'.repeat(64) })
    await expect(f.registry.issueResolutionToken(7, sessionId)).rejects.toMatchObject({ code: 'AGENT_EVENT_CORRUPT' })
    expect(f.requests).toHaveLength(1)
    expect(f.classifications()).toBe(1)
  })

  it('admits media on a compatible authorized configured fallback instead of the retained text-only model', async () => {
    const settings = await f.registry.getAdmin(f.current.profileId)
    const mediaProfile = await f.registry.create({
      ...settings,
      displayName: 'Configured media default',
      transportKind: 'gemini-api',
      model: 'gemini-3.5-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      authMode: 'google-api-key',
      secretReference: 'env:TEST_PROVIDER_KEY',
      adapterConfig: { timeoutMs: 30_000, maxRetries: 0, additionalHeaders: {}, media: { attachments: true } },
      exposureMode: 'all_agent_users',
      groupIds: [],
      actorId: 1
    })
    const version = await db('agentProviderProfiles').where({ id: mediaProfile.id }).first('currentVersionId')
    await f.registry.setConformed(mediaProfile.id, version.currentVersionId, true, 1)
    await f.registry.setEnabled(mediaProfile.id, true, 1, version.currentVersionId)
    await f.registry.setDefault(mediaProfile.id, 1)
    const sessionId = await f.session()
    await f.submit(sessionId)
    await f.runtime.runOnce()
    expect(f.requests[0]?.run.model).toBe('alternate')
    const token = await f.registry.issueResolutionToken(7, sessionId)
    const pdf = new PdfFixtureDocument()
    const catalogId = pdf.reserveObject()
    const pagesId = pdf.reserveObject()
    const pageId = pdf.reserveObject()
    const fontId = pdf.reserveObject()
    const contentId = pdf.addStream('', Buffer.from('BT /F1 12 Tf 72 720 Td (Greeting brief) Tj ET'))
    pdf.setObject(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    pdf.setObject(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`
    )
    pdf.setObject(pagesId, `<< /Type /Pages /Kids [${pageId} 0 R] /Count 1 >>`)
    pdf.setObject(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
    const media = await storeAgentMedia(db, {
      ownerId: 7,
      sessionId,
      payload: pdf.toBuffer(catalogId),
      mimeType: 'application/pdf',
      filename: 'brief.pdf'
    })
    const saved = await db('agentSessions').where({ id: sessionId }).first('version')
    const admitted = await f.runtime.submit({
      ownerId: 7,
      sessionId,
      expectedSessionVersion: Number(saved.version),
      profileResolutionToken: token,
      clientRequestId: randomUUID(),
      content: 'Write a short greeting based on this attachment.',
      attachmentIds: [media.id]
    })
    expect(admitted.run.providerProfileVersionId).toBe(version.currentVersionId)
    await f.runtime.runOnce()
    expect(await db('agentRuns').where({ id: admitted.run.id }).first('status', 'errorCode', 'errorMessage')).toMatchObject({
      status: 'succeeded',
      errorCode: null
    })
    expect(f.requests[1]?.run.model).toBe('gemini-3.5-flash')
    expect(f.requests[1]?.messages.at(-1)?.attachments?.map(attachment => attachment.id)).toEqual([media.id])
  })

  const seedBoundGoal = async (maximumTokens: number, profile = f.alternate) => {
    const sessionId = await f.session()
    await db('agentSessions').where({ id: sessionId }).update({ providerProfileId: profile.profileId })
    return db.transaction(async transaction => {
      const binding = await f.registry.resolveRoutingCandidate(transaction, {
        ownerId: 7,
        sessionId,
        profileId: profile.profileId,
        profileVersionId: profile.versionId
      })
      const goal = await insertAgentGoal(transaction, {
        id: randomUUID(),
        ownerId: 7,
        sessionId,
        objective: 'Write a short greeting',
        limits: { enabled: true, maxContinuations: 2, maxTokens: maximumTokens, maxToolCalls: 32, maxDurationMilliseconds: 60_000 }
      })
      const admitted = await admitAgentRunInTransaction(transaction, {
        ...binding,
        ownerId: 7,
        sessionId,
        clientRequestId: randomUUID(),
        expectedSessionVersion: 1,
        content: goal.objective,
        goalId: goal.id,
        goalContinuation: 0,
        skillVersionIds: [],
        quota: { ...binding.quota, tokens: Math.min(binding.quota.tokens, goal.maxTokens) },
        reservationExpiresAt: new Date(Math.min(Date.now() + binding.reservationMilliseconds, new Date(goal.deadlineAt).valueOf()))
      })
      return { goal, sessionId, ...admitted }
    })
  }

  for (const operation of ['resume', 'renew'] as const) {
    it(`${operation}s the initial goal's actual routed model instead of its original incumbent or current default`, async () => {
      const execute = f.engine.execute
      f.engine.execute = async (request, sink) => ({
        ...(await execute(request, sink)),
        executionLimit: { reason: 'evidence', publication: 'partial' }
      })
      const initial = await seedBoundGoal(100_000, f.current)
      await f.runtime.runOnce()
      expect(f.requests[0]?.run.model).toBe('alternate')
      expect((await db('agentRuns').where({ id: initial.run.id }).first()).providerProfileVersionId).toBe(f.alternate.versionId)
      const firstAssistant = await db('agentMessages').where({ runId: initial.run.id, role: 'assistant' }).first()
      expect(firstAssistant.runId).toBe(initial.run.id)
      let goal = await getOwnedAgentGoal(db, 7, initial.goal.id)
      if (operation === 'renew') {
        const continuation = await f.runtime.resumeGoal({
          ownerId: 7,
          goalId: goal.id,
          expectedVersion: goal.version,
          runId: randomUUID(),
          clientRequestId: randomUUID()
        })
        expect(continuation.run?.providerProfileVersionId).toBe(f.alternate.versionId)
        f.engine.execute = async (request, sink) => {
          await request.authorizeDispatch?.()
          f.requests.push(request)
          let remaining = request.limits!.maxTokens!
          const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 }
          while (remaining > 0) {
            const totalTokens = Math.min(remaining, 32_000)
            const outputTokens = Math.min(totalTokens, 3)
            const turnUsage = { inputTokens: totalTokens - outputTokens, outputTokens, totalTokens, costMicros: 10 }
            const reservation = await request.dispatchBudget!.reserve({ tokens: totalTokens, costMicros: 10 })
            await request.dispatchBudget!.reconcile(reservation, turnUsage)
            usage.inputTokens += turnUsage.inputTokens
            usage.outputTokens += turnUsage.outputTokens
            usage.totalTokens += turnUsage.totalTokens
            usage.costMicros += turnUsage.costMicros
            remaining -= totalTokens
          }
          await sink.text('The evidence still requires confirmation.')
          return { ...usage, executionLimit: { reason: 'evidence', publication: 'partial' } }
        }
        await f.runtime.runOnce()
        goal = await getOwnedAgentGoal(db, 7, goal.id)
        const limited = await f.runtime.resumeGoal({
          ownerId: 7,
          goalId: goal.id,
          expectedVersion: goal.version,
          runId: randomUUID(),
          clientRequestId: randomUUID()
        })
        expect(limited.goal).toMatchObject({ status: 'budget_limited', budgetLimitReason: 'tokens' })
        goal = limited.goal
      }
      const fallback = await db.transaction(transaction => f.registry.resolveConfiguredDefault(transaction, { ownerId: 7, sessionId: initial.sessionId }))
      expect(fallback.providerProfileVersionId).toBe(f.current.versionId)
      expect(fallback.defaultGeneration).toBe(initial.run.defaultGeneration)
      const input = { ownerId: 7, goalId: goal.id, expectedVersion: goal.version, runId: randomUUID(), clientRequestId: randomUUID() }
      const continued = operation === 'renew' ? await f.runtime.renewGoalBudget({ ...input, confirmed: true }) : await f.runtime.resumeGoal(input)
      expect(continued.run?.providerProfileVersionId).toBe(f.alternate.versionId)
      f.engine.execute = execute
      await f.runtime.runOnce()
      expect(f.requests.at(-1)?.run.model).toBe('alternate')
      expect(f.classifications()).toBe(1)
      const ordinary = await f.submit(initial.sessionId)
      expect(ordinary.run.providerProfileVersionId).toBe(f.current.versionId)
      expect(await db('agentMessages').where({ id: firstAssistant.id }).first('runId', 'content')).toEqual({
        runId: initial.run.id,
        content: firstAssistant.content
      })
    })
  }

  for (const operation of ['resume', 'renew'] as const) {
    for (const defaultChanged of [false, true]) {
      it(`${operation}s the exact historical goal binding unless its default generation changes (${defaultChanged})`, async () => {
        const execute = f.engine.execute
        f.engine.execute = async (request, sink) => ({
          ...(await execute(request, sink)),
          executionLimit: { reason: 'evidence', publication: 'partial' }
        })
        const historical = await seedBoundGoal(operation === 'renew' ? 8 : 100_000)
        await f.runtime.runOnce()
        expect(f.requests[0]?.run.model).toBe('alternate')
        let goal = await getOwnedAgentGoal(db, 7, historical.goal.id)
        expect(goal.status).toBe('blocked')
        if (operation === 'renew') {
          const limited = await f.runtime.resumeGoal({
            ownerId: 7,
            goalId: goal.id,
            expectedVersion: goal.version,
            runId: randomUUID(),
            clientRequestId: randomUUID()
          })
          expect(limited.run).toBeNull()
          expect(limited.goal).toMatchObject({ status: 'budget_limited', budgetLimitReason: 'tokens', canRenewTokenBudget: true })
          goal = limited.goal
        }
        if (defaultChanged) await f.registry.setDefault(f.current.profileId, 1)
        const input = { ownerId: 7, goalId: goal.id, expectedVersion: goal.version, runId: randomUUID(), clientRequestId: randomUUID() }
        const resumed = operation === 'renew' ? await f.runtime.renewGoalBudget({ ...input, confirmed: true }) : await f.runtime.resumeGoal(input)
        if (defaultChanged) {
          expect(resumed.run).toBeNull()
          expect(resumed.goal).toMatchObject({ status: 'blocked', errorCode: 'GOAL_CONFIGURATION_CHANGED' })
          expect(f.requests).toHaveLength(1)
          return
        }
        expect(resumed.run?.providerProfileVersionId).toBe(f.alternate.versionId)
        expect(resumed.goal.deadlineAt).toEqual(historical.goal.deadlineAt)
        f.engine.execute = execute
        await f.runtime.runOnce()
        expect(f.requests[1]?.run).toMatchObject({ model: 'alternate', goalContinuation: 1 })
        expect(f.requests[1]?.limits?.maxToolCalls).toBe(32)
        expect(Number((await db('agentQuotaReservations').where({ runId: resumed.run!.id }).first()).consumedTokens)).toBe(8)
        const ordinary = await f.submit(historical.sessionId)
        expect(ordinary.run.providerProfileVersionId).toBe(f.current.versionId)
        expect(await db('agentSessions').where({ id: historical.sessionId }).first('providerProfileId')).toEqual({ providerProfileId: f.alternate.profileId })
      })
    }
  }

  for (const operation of ['resume', 'renew'] as const) {
    for (const change of ['grant', 'profile-version'] as const) {
      it(`rejects a revoked historical-goal ${change} during ${operation} without a new dispatch or reservation`, async () => {
        const execute = f.engine.execute
        f.engine.execute = async (request, sink) => ({
          ...(await execute(request, sink)),
          executionLimit: { reason: 'evidence', publication: 'partial' }
        })
        const historical = await seedBoundGoal(operation === 'renew' ? 8 : 100_000)
        await f.runtime.runOnce()
        let goal = await getOwnedAgentGoal(db, 7, historical.goal.id)
        if (operation === 'renew') {
          goal = (
            await f.runtime.resumeGoal({
              ownerId: 7,
              goalId: goal.id,
              expectedVersion: goal.version,
              runId: randomUUID(),
              clientRequestId: randomUUID()
            })
          ).goal
          expect(goal.status).toBe('budget_limited')
        }
        if (change === 'grant') await f.registry.setGrants(f.alternate.profileId, 'groups', [2], 1)
        else
          await f.registry.update(f.alternate.profileId, {
            ...(await f.registry.getAdmin(f.alternate.profileId)),
            secretReference: 'env:TEST_PROVIDER_KEY',
            actorId: 1
          })
        const input = { ownerId: 7, goalId: goal.id, expectedVersion: goal.version, runId: randomUUID(), clientRequestId: randomUUID() }
        const resumed = operation === 'renew' ? f.runtime.renewGoalBudget({ ...input, confirmed: true }) : f.runtime.resumeGoal(input)
        await expect(resumed).rejects.toBeInstanceOf(AgentRepositoryError)
        expect(f.requests).toHaveLength(1)
        expect(await db('agentRuns').select('id')).toEqual([{ id: historical.run.id }])
        expect(Number((await db('agentQuotaReservations').where({ runId: historical.run.id }).first()).consumedTokens)).toBe(8)
      })
    }
  }

  for (const tool of ['video', 'music'] as const) {
    for (const operation of ['submit', 'create-goal'] as const) {
      it(`rejects unsupported ${tool} generation before ${operation} admission or reservation`, async () => {
        const sessionId = await f.session()
        const input = {
          ownerId: 7,
          sessionId,
          expectedSessionVersion: 1,
          profileResolutionToken: await f.registry.issueResolutionToken(7, sessionId),
          clientRequestId: randomUUID(),
          generationTools: [tool]
        }
        const submitted =
          operation === 'submit'
            ? f.runtime.submit({ ...input, responseMode: tool, content: 'Create media.' })
            : f.runtime.createGoal({ ...input, goalId: randomUUID(), objective: 'Create media.' })
        await expect(submitted).rejects.toMatchObject({ code: 'AGENT_MEDIA_DISABLED', message: 'Video and music generation are unavailable.' })
        expect(await db('agentRuns').select('id')).toEqual([])
        expect(await db('agentGoals').select('id')).toEqual([])
        expect(await db('agentQuotaReservations').select('runId')).toEqual([])
        expect(f.requests).toHaveLength(0)
      })
    }
  }

  it('ignores historical pins for new turns without rewriting same-owner conversations', async () => {
    const automatic = await f.session()
    const historical = await f.session(true)
    await appendAgentMessage(db, { ownerId: 7, sessionId: historical, role: 'user', status: 'complete', content: 'A preserved request' })
    await appendAgentMessage(db, { ownerId: 7, sessionId: historical, role: 'assistant', status: 'complete', content: 'A preserved answer' })
    const history = await db('agentMessages').where({ sessionId: historical }).orderBy('ordinal').select('id', 'role', 'content')
    await f.submit(automatic)
    await f.submit(historical)
    await f.runtime.runOnce()
    await f.runtime.runOnce()
    expect(f.requests.find(request => request.run.sessionId === automatic)?.run.model).toBe('alternate')
    const request = f.requests.find(request => request.run.sessionId === historical)!
    expect(request.run.model).toBe('alternate')
    expect(request.messages.map(message => message.content)).toEqual(['A preserved request', 'A preserved answer', 'Write a short greeting'])
    expect(f.classifications()).toBe(2)
    expect(await db('agentSessions').where({ id: historical }).first('providerProfileId')).toEqual({ providerProfileId: f.current.profileId })
    expect(
      await db('agentMessages')
        .whereIn(
          'id',
          history.map(message => message.id)
        )
        .orderBy('ordinal')
        .select('id', 'role', 'content')
    ).toEqual(history)
  })

  it('admits a historically pinned conversation on the current admin default', async () => {
    f.view.policy.enabled = false
    const sessionId = await f.session(true)
    await f.registry.setGrants(f.alternate.profileId, 'all_agent_users', [], 1)
    await f.registry.setDefault(f.alternate.profileId, 1)
    const admitted = await f.submit(sessionId)
    expect(admitted.run.providerProfileVersionId).toBe(f.alternate.versionId)
    await f.runtime.runOnce()
    expect(f.requests[0]?.run.model).toBe('alternate')
    expect(f.classifications()).toBe(0)
    expect(await db('agentSessions').where({ id: sessionId }).first('providerProfileId')).toEqual({ providerProfileId: f.current.profileId })
  })

  it('uses a deterministic currently granted fallback when no global default is eligible', async () => {
    f.view.policy.enabled = false
    await f.registry.setGrants(f.current.profileId, 'groups', [1], 1)
    const sessionId = await f.session(true)
    const admitted = await f.submit(sessionId)
    expect(admitted.run.providerProfileVersionId).toBe(f.alternate.versionId)
    await f.runtime.runOnce()
    expect(f.requests[0]?.run.model).toBe('alternate')
    const unauthorized = await f.session(true, 8)
    await expect(f.registry.issueResolutionToken(8, unauthorized)).rejects.toMatchObject({ code: 'PROFILE_UNAVAILABLE' })
    expect(await db('agentProviderGrants').where({ profileId: f.current.profileId }).select('groupId')).toEqual([{ groupId: 1 }])
  })

  for (const unavailable of ['disabled', 'incompatible', 'unauthorized'] as const) {
    it(`ignores a ${unavailable} historical pin and never dispatches that candidate`, async () => {
      const ownerId = unavailable === 'unauthorized' ? 8 : 7
      const sessionId = await f.session(false, ownerId)
      await db('agentSessions').where({ id: sessionId }).update({ providerProfileId: f.alternate.profileId })
      if (unavailable === 'disabled') await f.registry.setEnabled(f.alternate.profileId, false, 1, f.alternate.versionId)
      if (unavailable === 'incompatible') {
        const version = await db('agentProviderProfileVersions').where({ id: f.alternate.versionId }).first('policies')
        await db('agentProviderProfileVersions')
          .where({ id: f.alternate.versionId })
          .update({ policies: JSON.stringify({ ...JSON.parse(version.policies), allowedModes: ['generation-only'] }) })
      }
      const admitted = await f.submit(sessionId, ownerId)
      expect(admitted.run.providerProfileVersionId).toBe(f.current.versionId)
      await f.runtime.runOnce()
      expect(f.requests[0]?.run.model).toBe('incumbent')
      expect(f.classifications()).toBe(0)
      expect(await db('agentSessions').where({ id: sessionId }).first('providerProfileId')).toEqual({ providerProfileId: f.alternate.profileId })
    })
  }

  it('does not route to another owners group model', async () => {
    await f.submit(await f.session(false, 8), 8)
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(0)
    expect(f.requests[0]?.run.model).toBe('incumbent')
  })

  it('settles billed classifier failure once and keeps the authorized incumbent despite a historical pin', async () => {
    f.failClassifier(
      new DecisionProviderFailure(
        'DECISION_PROVIDER_FAILED',
        f.provider,
        { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' },
        23
      )
    )
    const admitted = await f.submit(await f.session(true))
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
    const admitted = await f.submit(await f.session(true))
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

  const exerciseApprovalContinuation = async (
    admissionKind: 'routed' | 'historical-pin' | 'historical-grant-revoked' | 'historical-version-revoked' | 'historical-grant-revoked-during-restore'
  ): Promise<void> => {
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
    const historical = admissionKind !== 'routed'
    const activeRuntime = historical
      ? new AgentProductRuntime(db, f.registry, f.engine, {
          workerId: 'historical-approval-run',
          globalConcurrency: 1,
          perUserConcurrency: 1,
          orchestration: { ...DEFAULT_AGENT_ORCHESTRATION_LIMITS, enabled: false }
        })
      : f.runtime
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
      stopping = activeRuntime.shutdown()
      throw request.signal.reason
    }
    const sessionId = await f.session()
    if (historical) await db('agentSessions').where({ id: sessionId }).update({ providerProfileId: f.alternate.profileId })
    // Seed an already-admitted historical binding through the durable host
    // admission boundary; no ordinary request can choose this profile now.
    const admitted = historical
      ? await db.transaction(async transaction => {
          const legacy = await f.registry.resolveRoutingCandidate(transaction, {
            ownerId: 7,
            sessionId,
            profileId: f.alternate.profileId,
            profileVersionId: f.alternate.versionId
          })
          return admitAgentRunInTransaction(transaction, {
            ...legacy,
            ownerId: 7,
            sessionId,
            clientRequestId: randomUUID(),
            expectedSessionVersion: 1,
            content: 'Write a short greeting',
            skillVersionIds: [],
            reservationExpiresAt: new Date(Date.now() + legacy.reservationMilliseconds)
          })
        })
      : await f.submit(sessionId)
    await activeRuntime.runOnce()
    await stopping
    expect(await db('agentRuns').where({ id: admitted.run.id }).first('status')).toEqual({ status: 'awaiting_approval' })
    await db('agentRuns')
      .where({ id: admitted.run.id })
      .update({ leaseExpiresAt: new Date(0) })
    if (admissionKind === 'historical-grant-revoked') {
      const groups = await db('userGroups').where({ userId: 8 }).pluck('groupId')
      await f.registry.setGrants(f.alternate.profileId, 'groups', groups, 1)
    }
    if (admissionKind === 'historical-version-revoked') {
      const settings = await f.registry.getAdmin(f.alternate.profileId)
      await f.registry.update(f.alternate.profileId, { ...settings, secretReference: 'env:TEST_PROVIDER_KEY', actorId: 1 })
    }
    const initialApprovals = await db('agentApprovals').where({ runId: admitted.run.id }).select('id')
    let completedActionEffects = 0
    let resumptions = 0
    f.engine.resumeAction = async (request, checkpoint, sink) => {
      resumptions += 1
      expect(checkpoint.runId).toBe(admitted.run.id)
      expect(request.run.model).toBe('alternate')
      if (admissionKind === 'historical-grant-revoked-during-restore') {
        await f.registry.setGrants(f.alternate.profileId, 'groups', [2], 1)
        await request.beforeExternalTool?.()
        completedActionEffects += 1
      }
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
    expect(f.classifications()).toBe(historical ? 0 : 1)
    if (
      admissionKind === 'historical-grant-revoked' ||
      admissionKind === 'historical-version-revoked' ||
      admissionKind === 'historical-grant-revoked-during-restore'
    ) {
      expect(resumptions).toBe(admissionKind === 'historical-grant-revoked-during-restore' ? 1 : 0)
      expect(completedActionEffects).toBe(0)
      expect(f.requests).toHaveLength(1)
      expect(await db('agentRuns').where({ id: admitted.run.id }).first('status')).toEqual({ status: 'failed' })
      expect(Number((await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()).consumedTokens)).toBe(8)
    } else {
      expect(resumptions).toBe(1)
      expect(Number((await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()).consumedTokens)).toBe(historical ? 16 : 206)
      expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject(
        historical ? { inputTokens: 10, outputTokens: 6, totalTokens: 16 } : { inputTokens: 133, outputTokens: 18, totalTokens: 206 }
      )
    }
    expect(await db('agentApprovals').where({ runId: admitted.run.id }).select('id')).toEqual(initialApprovals)
    expect(await db('agentQuotaReservations').where({ ownerId: 7 }).select('runId')).toEqual([{ runId: admitted.run.id }])
    if (historical) expect(await db('agentSessions').where({ id: sessionId }).first('providerProfileId')).toEqual({ providerProfileId: f.alternate.profileId })
  }
  for (const admissionKind of [
    'routed',
    'historical-pin',
    'historical-grant-revoked',
    'historical-version-revoked',
    'historical-grant-revoked-during-restore'
  ] as const) {
    it(`preserves approval continuation binding and accounting for ${admissionKind} admission`, () => exerciseApprovalContinuation(admissionKind))
  }

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
