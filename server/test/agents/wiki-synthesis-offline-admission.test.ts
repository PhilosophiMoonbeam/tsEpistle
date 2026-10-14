import createKnex, { type Knex } from 'knex'
import { Agent, MockAgent, type Dispatcher } from 'undici/index.js'
import { AgentProviderRegistry } from '../../agents/providers/registry.ts'
import { createWikiOfflineDispatchAdmission, type WikiOfflineAdmission } from '../../agents/providers/wiki-synthesis-offline-admission.ts'
import type { AgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { createRoutingTables } from './runtime-routing.fixture.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

// A public numeric address needs no DNS service; every HTTP dispatch is intercepted.
const origin = 'https://93.184.216.34'
const secrets: AgentSecretRegistry = {
  has: reference => reference === 'env:OFFLINE_PRICING_FIXTURE',
  get: () => 'unpaid-offline-pricing-fixture',
  store: () => { throw new Error('No managed credentials in this fixture') },
  delete: () => false
}

describe('offline synthesis measured pricing admission', () => {
  let db: Knex
  let mock: MockAgent
  let restoreDispatch: (() => void) | undefined
  let registry: AgentProviderRegistry
  let profileVersionId: string
  let admitted: WikiOfflineAdmission | undefined

  beforeEach(async () => {
    admitted = undefined
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    await createRoutingTables(db)
    registry = new AgentProviderRegistry(db, secrets, { currentKeyId: 'fixture', keys: { fixture: 'offline-pricing-profile-resolution-secret' } })
    const profile = await registry.create({
      displayName: 'Offline measured pricing', exposureMode: 'all_agent_users', actorId: 1,
      transportKind: 'anthropic-messages', model: 'claude-test', utilityModel: null, baseUrl: `${origin}/v1`,
      authMode: 'anthropic-api-key', secretReference: 'env:OFFLINE_PRICING_FIXTURE',
      adapterConfig: { timeoutMs: 10_000, maxRetries: 0, additionalHeaders: {} },
      capabilities: { streaming: false, toolCalling: 'native', parallelToolCalls: false, structuredOutput: 'native-json-schema',
        usage: 'terminal', cancellation: true, maxContextTokens: 32_000, maxOutputTokens: 4_000 },
      capabilityRevision: 'fixture-v1', pricingRevision: 'cache-v2|2000000|5000000|100000|3000000',
      policies: { allowedModes: ['agent'], dailyTokens: 1_000_000, dailyCostMicros: 10_000_000,
        reservationTokens: 10_000, reservationCostMicros: 100_000, reservationMilliseconds: 60_000, promptVersion: 1, maxAttempts: 1 }
    })
    profileVersionId = (await db('agentProviderProfiles').where({ id: profile.id }).first('currentVersionId')).currentVersionId
    await registry.setConformed(profile.id, profileVersionId, true, 1)
    await registry.setEnabled(profile.id, true, 1, profileVersionId)

    const internalAgent = new Agent()
    mock = new MockAgent({ agent: internalAgent })
    mock.disableNetConnect()
    const originalDispatch = Agent.prototype.dispatch
    const intercepted = vi.spyOn(Agent.prototype, 'dispatch').mockImplementation(function (
      this: Agent, options: Agent.DispatchOptions, handler: Dispatcher.DispatchHandler
    ): boolean {
      // MockAgent itself forwards through its encapsulated Agent; do not recurse.
      return this === internalAgent ? originalDispatch.call(this, options, handler) : mock.dispatch(options, handler)
    })
    restoreDispatch = () => intercepted.mockRestore()
  })

  afterEach(async () => {
    try {
      await admitted?.close()
    } finally {
      restoreDispatch?.()
      restoreDispatch = undefined
      await mock?.close()
      await db?.destroy()
    }
  })

  const admit = async (maximumCostMicros = 100_000): Promise<WikiOfflineAdmission> => {
    admitted = await createWikiOfflineDispatchAdmission(db, {
      ownerId: 7, profileVersionId, registry, secrets, label: 'cache accounting fixture',
      maximumCalls: 1, maximumTokens: 10_000, maximumCostMicros, maximumOutputTokens: 8
    })
    return admitted
  }
  const request = { chatPrompt: [{ role: 'user' as const, content: 'Return one synthetic fixture sentence.' }], modelConfig: { maxTokens: 8 } }

  it.each([
    { fresh: 2, creation: 2, expectedCost: 21 },
    { fresh: 4, creation: 0, expectedCost: 19 },
    { fresh: 4, creation: undefined, expectedCost: 23 }
  ])('settles full input once with cache creation $creation and keeps unknown counters conservative', async fixture => {
    mock.get(origin).intercept({ path: '/v1/messages', method: 'POST' }).reply(200, {
      id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-test',
      content: [{ type: 'text', text: 'Synthetic fixture sentence.' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: fixture.fresh, output_tokens: 2, cache_read_input_tokens: 6,
        ...(fixture.creation === undefined ? {} : { cache_creation_input_tokens: fixture.creation }) }
    }, { headers: { 'content-type': 'application/json' } })
    const admission = await admit()
    await admission.service.chat(request, { stream: false })
    expect(admission.summary()).toMatchObject({ calls: 1, dispatchedCalls: 1, failedCalls: 0,
      inputTokens: 10, outputTokens: 2, totalTokens: 12, costMicros: fixture.expectedCost,
      unknownExposureTokens: 0, unknownExposureCostMicros: 0 })
    const quota = await db('agentQuotaReservations').first()
    expect(quota).toMatchObject({ status: 'consumed', consumedTokens: 12, consumedCostMicros: fixture.expectedCost })
    const run = await db('agentRuns').first()
    expect(run).toMatchObject({ status: 'succeeded', totalTokens: 12, estimatedCostMicros: fixture.expectedCost,
      pricingRevision: 'cache-v2|2000000|5000000|100000|3000000' })
    const journal = (await db('agentEvents').where({ type: 'usage.updated' }).orderBy('sequence')).map(row => JSON.parse(row.data))
    expect(journal[0]).toMatchObject({ unknownExposure: true, receiptCostMicros: 0 })
    expect(journal[0].costMicros).toBe(journal[0].totalTokens * 3 + 16)
    expect(journal[1]).toMatchObject({ unknownExposure: false, inputTokens: 10, totalTokens: 12, costMicros: fixture.expectedCost })
    mock.assertNoPendingInterceptors()
  })

  it('retains worst-case paid exposure after failed dispatch instead of discounting unmeasured usage', async () => {
    mock.get(origin).intercept({ path: '/v1/messages', method: 'POST' }).reply(503, {
      type: 'error', error: { type: 'overloaded_error', message: 'Synthetic failure' }
    }, { headers: { 'content-type': 'application/json' } })
    const admission = await admit()
    await expect(admission.service.chat(request, { stream: false })).rejects.toThrow('Offline inference failed')
    const summary = admission.summary()
    expect(summary).toMatchObject({ calls: 1, dispatchedCalls: 1, failedCalls: 1,
      inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 })
    expect(summary.unknownExposureTokens).toBeGreaterThan(8)
    expect(summary.unknownExposureCostMicros).toBe(summary.unknownExposureTokens * 3 + 16)
    expect(await db('agentQuotaReservations').first()).toMatchObject({ status: 'consumed',
      consumedTokens: summary.unknownExposureTokens, consumedCostMicros: summary.unknownExposureCostMicros })
    mock.assertNoPendingInterceptors()
  })

  it('denies worst-case admission before HTTP even when cache reads would be free or cheap', async () => {
    const admission = await admit(1)
    await expect(admission.service.chat(request, { stream: false })).rejects.toThrow('Offline inference failed')
    expect(admission.summary()).toMatchObject({ calls: 0, dispatchedCalls: 0, failedCalls: 0,
      totalTokens: 0, costMicros: 0, unknownExposureTokens: 0, unknownExposureCostMicros: 0 })
    expect(await db('agentRuns').select('id')).toEqual([])
    expect(await db('agentQuotaReservations').select('runId')).toEqual([])
  })
})
