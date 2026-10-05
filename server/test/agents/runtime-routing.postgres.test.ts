import { randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'
import { createRoutingTables, routingFixture, type RoutingFixture } from './runtime-routing.fixture.ts'

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

  it('serializes same-owner quota without sharing session pins or classifier decisions', async () => {
    const automaticA = await f.session()
    const automaticB = await f.session()
    const pinned = await f.session(true)
    await Promise.all([f.submit(automaticA), f.submit(automaticB), f.submit(pinned)])
    await Promise.all([f.runtime.runOnce(), f.runtime.runOnce(), f.runtime.runOnce()])
    expect(f.classifications()).toBe(2)
    expect(f.requests.filter(request => request.run.model === 'alternate')).toHaveLength(2)
    expect(f.requests.find(request => request.run.sessionId === pinned)?.run.model).toBe('incumbent')
    const daily = await db('agentQuotaDaily').where({ ownerId: 7 }).first()
    expect(Number(daily.consumedTokens)).toBe(404)
    expect(Number(daily.reservedTokens)).toBe(0)
    expect(await db('agentSessions').whereIn('id', [automaticA, automaticB]).whereNotNull('providerProfileId')).toHaveLength(0)
  })
})
