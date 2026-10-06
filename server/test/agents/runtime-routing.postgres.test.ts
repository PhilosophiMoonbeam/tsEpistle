import { randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { appendAgentMessage } from '../../agents/repository.ts'
import { createRoutingTables, type RoutingFixture, routingFixture, routingImageProviderConfig } from './runtime-routing.fixture.ts'

const connection = getPostgresTestConnection('_agents_test', import.meta.path)
const suite = connection ? describe : describe.skip

suite('PostgreSQL claimed-run routing fences', () => {
  let db: Knex
  let secondDb: Knex
  let schema: string
  let f: RoutingFixture
  beforeEach(async () => {
    schema = `agent_routing_runtime_${randomUUID().replaceAll('-', '')}`
    const admin = createKnex({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`CREATE SCHEMA "${schema}"`)
    } finally {
      await admin.destroy()
    }
    db = createKnex({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 4 } })
    secondDb = createKnex({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 2 } })
    await createRoutingTables(db)
    f = await routingFixture(db)
  })
  afterEach(async () => {
    await f?.runtime.shutdown()
    await secondDb?.destroy()
    await db?.destroy()
    const admin = createKnex({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.destroy()
    }
  })

  it('reconciles multi-turn root usage once with PostgreSQL bigint quota reset credits', async () => {
    const usage = { inputTokens: 5, outputTokens: 3, totalTokens: 8, costMicros: 10 }
    f.view.policy.enabled = false
    f.engine.preflight = async () => ({
      admissible: true,
      inputExposureTokens: 20_000,
      outputExposureTokens: 3,
      totalExposureTokens: 20_003
    })
    f.engine.execute = async (request, sink) => {
      await request.authorizeDispatch?.()
      f.requests.push(request)
      for (let turn = 0; turn < 3; turn += 1) {
        const reservation = await request.dispatchBudget!.reserve({ tokens: 8, costMicros: 10 })
        await request.dispatchBudget!.reconcile(reservation, usage)
        await sink.event('model.turn', {
          usageVersion: 2,
          ...usage,
          content: 'Good morning, everyone!',
          contentTruncated: false,
          actionCallIds: [],
          finishReason: 'stop',
          outcome: 'answer_accepted'
        })
      }
      await sink.text('Good morning, everyone!')
      return { inputTokens: 15, outputTokens: 9, totalTokens: 24, costMicros: 30 }
    }
    const sessionId = await f.session()
    const initial = await f.submit(sessionId)
    await f.runtime.runOnce()
    await db('agentQuotaDaily').where({ ownerId: 7 }).update({ tokenResetCredit: '1000' })
    const first = await f.submit(sessionId)
    await f.runtime.runOnce()
    const second = await f.submit(sessionId)
    await f.runtime.runOnce()
    expect(f.requests).toHaveLength(3)
    expect(f.classifications()).toBe(0)
    const runIds = [initial.run.id, first.run.id, second.run.id]
    for (const runId of runIds) {
      expect(await db('agentRuns').where({ id: runId }).first('status', 'providerProfileVersionId', 'totalTokens', 'estimatedCostMicros')).toEqual({
        status: 'succeeded',
        providerProfileVersionId: f.current.versionId,
        totalTokens: 24,
        estimatedCostMicros: 30
      })
      const reservation = await db('agentQuotaReservations').where({ runId }).first()
      expect(Number(reservation.consumedTokens)).toBe(24)
      expect(Number(reservation.consumedCostMicros)).toBe(30)
      expect(reservation.status).toBe('consumed')
    }
    const daily = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
    expect(Number(daily.tokenResetCredit)).toBe(1000)
    expect(Number(daily.consumedTokens)).toBe(72)
    expect(Number(daily.consumedCostMicros)).toBe(90)
    expect(Number(daily.reservedTokens)).toBe(0)
    expect(Number(daily.reservedCostMicros)).toBe(0)
    expect(await f.runtime.runOnce()).toBe(false)
    expect(Number((await db('agentQuotaDaily').where({ ownerId: 7 }).first()).consumedTokens)).toBe(72)
  })

  it('retains billed classifier usage but forbids retarget after concurrent candidate grant revocation', async () => {
    f.duringClassification(async () => {
      await secondDb('agentProviderGrants').where({ profileId: f.alternate.profileId, groupId: 1 }).delete()
      await secondDb('agentProviderProfiles').where({ id: f.alternate.profileId }).increment('policyVersion', 1)
    })
    const admitted = await f.submit(await f.session())
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(1)
    expect(f.requests).toHaveLength(0)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first('status', 'providerProfileVersionId')).toEqual({
      status: 'failed',
      providerProfileVersionId: f.current.versionId
    })
    const reservation = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
    expect(Number(reservation.consumedTokens)).toBe(190)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first()).toMatchObject({ inputTokens: 123, outputTokens: 12, totalTokens: 190 })
    const routing = (await db('agentEvents').where({ runId: admitted.run.id, type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .find(event => event.purpose === 'routing')
    expect(routing).toMatchObject({ inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' })
    expect(Number(reservation.consumedCostMicros)).toBe(13)
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(1)
    expect(Number((await db('agentQuotaDaily').where({ ownerId: 7 }).first()).consumedTokens)).toBe(190)
  })

  it('rejects a concurrently revoked media binding without substituting the newer operation default or duplicating paid routing usage', async () => {
    const provider = await f.readyMedia(routingImageProviderConfig, [1])
    const sessionId = await f.session()
    const admitted = await f.submit(sessionId, 7, { generationTools: ['image'] })
    const newer = await f.readyMedia({ ...routingImageProviderConfig, model: 'gemini-3.1-flash-image' })
    await f.mediaRegistry.setDefault(newer.id, newer.revision, { id: 1, authVersion: 0 })
    f.duringClassification(async () => {
      await secondDb('agentMediaProviderGrants').where({ providerId: provider.id, groupId: 1 }).delete()
    })
    await f.runtime.runOnce()
    expect(f.requests).toEqual([])
    expect(await db('agentRuns').where({ id: admitted.run.id }).first('status', 'errorCode')).toEqual({
      status: 'failed',
      errorCode: 'AGENT_MEDIA_DISABLED'
    })
    const reservation = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
    expect(Number(reservation.consumedTokens)).toBe(190)
    expect(Number(reservation.consumedCostMicros)).toBe(13)
    const routing = (await db('agentEvents').where({ runId: admitted.run.id, type: 'model.turn' }).select('data'))
      .map(row => JSON.parse(row.data))
      .filter(event => event.purpose === 'routing')
    expect(routing).toHaveLength(1)
    expect(routing[0]).toMatchObject({ inputTokens: 123, outputTokens: 12, totalTokens: 190, costMicros: 13, totalTokensSource: 'reported' })
    const daily = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
    expect(Number(daily.consumedTokens)).toBe(190)
    expect(Number(daily.consumedCostMicros)).toBe(13)
    expect(Number(daily.reservedTokens)).toBe(0)
    expect(Number(daily.reservedCostMicros)).toBe(0)
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(1)
    expect(await db('agentQuotaReservations').where({ ownerId: 7 }).select('runId')).toEqual([{ runId: admitted.run.id }])
    const settled = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
    expect(Number(settled.consumedTokens)).toBe(190)
    expect(Number(settled.consumedCostMicros)).toBe(13)
  })

  it.each(['selection', 'unmeasured-fallback'] as const)('rejects a changed default generation at atomic %s without mutating either session', async outcome => {
    const automatic = await f.session()
    const pinned = await f.session(true)
    await f.registry.setGrants(f.alternate.profileId, 'all_agent_users', [], 1)
    if (outcome === 'unmeasured-fallback') f.failClassifier(new Error('Submitted classifier response was lost'))
    f.duringClassification(async () => {
      await secondDb.transaction(async transaction => {
        await transaction('agentProviderConfiguration').where({ id: 1 }).forUpdate().increment('defaultGeneration', 1)
        await transaction('agentProviderProfiles').where({ id: f.current.profileId }).update({ isGlobalDefault: false })
        await transaction('agentProviderProfiles').where({ id: f.alternate.profileId }).update({ isGlobalDefault: true })
      })
    })
    const admitted = await f.submit(automatic)
    await f.runtime.runOnce()
    expect(f.requests).toHaveLength(0)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first('status')).toEqual({ status: 'failed' })
    expect(await db('agentSessions').where({ id: automatic }).first('providerProfileId')).toEqual({ providerProfileId: null })
    expect(await db('agentSessions').where({ id: pinned }).first('providerProfileId')).toEqual({ providerProfileId: f.current.profileId })
    expect(f.classifications()).toBe(1)
    const reservation = await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()
    let consumedTokens = 190
    if (outcome === 'unmeasured-fallback') {
      const routing = (await db('agentEvents').where({ runId: admitted.run.id, type: 'model.turn' }).select('data'))
        .map(row => JSON.parse(row.data))
        .find(event => event.purpose === 'routing')
      expect(routing).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0, totalTokensSource: null })
      consumedTokens = routing.routingDecision.unknownExposure.tokens
      expect(consumedTokens).toBeGreaterThan(0)
      expect(Number(reservation.consumedCostMicros)).toBe(routing.routingDecision.unknownExposure.costMicros)
    } else {
      expect(Number(reservation.consumedCostMicros)).toBe(13)
    }
    expect(Number(reservation.consumedTokens)).toBe(consumedTokens)
    await f.runtime.runOnce()
    expect(f.classifications()).toBe(1)
    expect(Number((await db('agentQuotaDaily').where({ ownerId: 7 }).first()).consumedTokens)).toBe(consumedTokens)
  })

  it('rejects concurrent account generation changes between classification and commit', async () => {
    f.duringClassification(async () => {
      await secondDb('users').where({ id: 7 }).increment('authVersion', 1)
    })
    const admitted = await f.submit(await f.session())
    await f.runtime.runOnce()
    expect(f.requests).toHaveLength(0)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first('status')).toEqual({ status: 'failed' })
    expect(Number((await db('agentQuotaReservations').where({ runId: admitted.run.id }).first()).consumedTokens)).toBe(190)
  })

  it('serializes same-owner quota while isolating conversation histories and paid routing decisions', async () => {
    const automaticA = await f.session()
    const automaticB = await f.session()
    const historical = await f.session(true)
    await appendAgentMessage(db, { ownerId: 7, sessionId: automaticA, role: 'user', status: 'complete', content: 'Conversation A history' })
    await appendAgentMessage(db, { ownerId: 7, sessionId: automaticB, role: 'user', status: 'complete', content: 'Conversation B history' })
    const historicalSession = await db('agentSessions').where({ id: historical }).first('providerProfileId', 'version')
    const admitted = await Promise.all([f.submit(automaticA), f.submit(automaticB)])
    await Promise.all([f.runtime.runOnce(), f.runtime.runOnce()])
    expect(f.classifications()).toBe(2)
    expect(f.requests).toHaveLength(2)
    expect(f.requests.every(request => request.run.model === 'alternate')).toBe(true)
    expect(f.requests.find(request => request.run.sessionId === automaticA)?.messages.map(message => message.content)).toEqual([
      'Conversation A history',
      'Write a short greeting'
    ])
    expect(f.requests.find(request => request.run.sessionId === automaticB)?.messages.map(message => message.content)).toEqual([
      'Conversation B history',
      'Write a short greeting'
    ])
    for (const { run } of admitted) {
      const routing = (await db('agentEvents').where({ runId: run.id, type: 'model.turn' }).select('data'))
        .map(row => JSON.parse(row.data))
        .filter(event => event.purpose === 'routing')
      expect(routing).toHaveLength(1)
      expect(routing[0]).toMatchObject({ inputTokens: 123, outputTokens: 12, totalTokens: 190, costMicros: 13 })
      const reservation = await db('agentQuotaReservations').where({ runId: run.id }).first()
      expect(Number(reservation.consumedTokens)).toBe(198)
      expect(Number(reservation.consumedCostMicros)).toBe(23)
    }
    const daily = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
    expect(Number(daily.consumedTokens)).toBe(396)
    expect(Number(daily.consumedCostMicros)).toBe(46)
    expect(Number(daily.reservedTokens)).toBe(0)
    expect(Number(daily.reservedCostMicros)).toBe(0)
    expect(await db('agentSessions').whereIn('id', [automaticA, automaticB]).whereNotNull('providerProfileId')).toHaveLength(0)
    expect(await db('agentSessions').where({ id: historical }).first('providerProfileId', 'version')).toEqual(historicalSession)
    expect(await f.runtime.runOnce()).toBe(false)
    expect(f.classifications()).toBe(2)
  })
})
