import { randomUUID } from 'node:crypto'
import type { lookup } from 'node:dns/promises'
import knexModule, { type Knex } from 'knex'
import { TYPESAFE_DECISION_PROVIDER_ID } from '../../../shared/agents/decision-providers.ts'
import {
  DEFAULT_ROUTING_POLICY,
  type RoutingActor,
  type RoutingCandidate,
  type RoutingModelPolicyInput,
  type RoutingTurnDecision,
  type RoutingTurnHooks,
  type RoutingTurnInput
} from '../../../shared/agents/routing.ts'
import { DecisionProviderRegistry } from '../../agents/decision-providers.ts'
import { DatabaseAgentSecretRegistry } from '../../agents/providers/secrets.ts'
import { AgentRoutingPolicyRegistry, AgentTurnRouter } from '../../agents/routing.ts'
import { up as addSecrets } from '../../db/migrations/2.5.141.ts'
import { up as addDecisionProviders } from '../../db/migrations/tsepistle-000051-agent-decision-providers.ts'
import { up as addRouting, down as removeRouting } from '../../db/migrations/tsepistle-000052-agent-routing.ts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

const connection = getPostgresTestConnection('_agents_test', import.meta.path)
const suite = connection ? describe : describe.skip
const schema = `agent_routing_${randomUUID().replaceAll('-', '')}`
const actor: RoutingActor = { id: 7, authVersion: 3 }
const profileId = randomUUID(),
  versionId = randomUUID(),
  anotherProfileId = randomUUID(),
  anotherVersionId = randomUUID()
const modelInput: RoutingModelPolicyInput = {
  profileVersionId: versionId,
  acceptableTasks: [{ taskClass: 'writing', complexities: ['simple', 'moderate'] }],
  estimatedLatencyMs: null
}
const publicDns = (async () => [{ address: '93.184.216.34', family: 4 }]) as unknown as typeof lookup

suite('PostgreSQL routing configuration and native Jev decision path', () => {
  let db: Knex, policies: AgentRoutingPolicyRegistry, decisions: DecisionProviderRegistry
  let decisionResponse: 'valid' | 'malformed' | 'unknown-failure'
  let compatibleUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
  let nativeCalls: number
  beforeAll(async () => {
    const admin = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`CREATE SCHEMA "${schema}"`)
    } finally {
      await admin.destroy()
    }
    db = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 4 } })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.boolean('isActive').notNullable()
      table.integer('authVersion').notNullable()
    })
    await db.schema.createTable('groups', table => {
      table.integer('id').primary()
      table.specificType('permissions', 'text[]').notNullable()
    })
    await db.schema.createTable('userGroups', table => {
      table.integer('userId').references('id').inTable('users')
      table.integer('groupId').references('id').inTable('groups')
      table.primary(['userId', 'groupId'])
    })
    await db.schema.createTable('agentProviderProfiles', table => {
      table.uuid('id').primary()
      table.uuid('currentVersionId').nullable()
      table.timestamp('deletedAt').nullable()
    })
    await db.schema.createTable('agentProviderProfileVersions', table => {
      table.uuid('id').primary()
      table.uuid('profileId').notNullable().references('id').inTable('agentProviderProfiles')
    })
    await addSecrets(db)
    await addDecisionProviders(db)
    await addRouting(db)
  })
  beforeEach(async () => {
    await db('agentRoutingModelPolicies').delete()
    await db('agentRoutingPolicy')
      .where({ id: 1 })
      .update({ revision: 1, config: JSON.stringify(DEFAULT_ROUTING_POLICY), updatedBy: null, updatedAt: null })
    await db('agentProviderProfileVersions').delete()
    await db('agentProviderProfiles').delete()
    await db('agentDecisionProviders').update({ createdBy: null, updatedBy: null })
    await db('agentDecisionProviders').whereNot({ id: TYPESAFE_DECISION_PROVIDER_ID }).delete()
    await db('agentProviderSecrets').delete()
    await db('userGroups').delete()
    await db('groups').delete()
    await db('users').delete()
    await db('users').insert([
      { id: 7, isActive: true, authVersion: 3 },
      { id: 8, isActive: true, authVersion: 1 },
      { id: 9, isActive: false, authVersion: 1 }
    ])
    await db('groups').insert([
      { id: 1, permissions: ['manage:system'] },
      { id: 2, permissions: ['use:agents'] }
    ])
    await db('userGroups').insert([
      { userId: 7, groupId: 1 },
      { userId: 8, groupId: 2 },
      { userId: 9, groupId: 1 }
    ])
    await db('agentProviderProfiles').insert([
      { id: profileId, currentVersionId: versionId },
      { id: anotherProfileId, currentVersionId: anotherVersionId }
    ])
    await db('agentProviderProfileVersions').insert([
      { id: versionId, profileId },
      { id: anotherVersionId, profileId: anotherProfileId }
    ])
    await db('agentDecisionProviders').where({ id: TYPESAFE_DECISION_PROVIDER_ID }).update({ enabled: true, isDefault: true, revision: 1 })
    policies = new AgentRoutingPolicyRegistry(db)
    nativeCalls = 0
    decisionResponse = 'valid'
    compatibleUsage = { prompt_tokens: 338, completion_tokens: 31, total_tokens: 369 }
    decisions = new DecisionProviderRegistry(
      db,
      new DatabaseAgentSecretRegistry(db, { currentKeyId: 'fixture', keys: { fixture: new Uint8Array(32).fill(7) } }),
      {
        resolve: publicDns,
        environmentKey: () => 'fixture-native-key',
        fetch: Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            nativeCalls++
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-native-key')
            if (decisionResponse === 'unknown-failure') throw new Error('socket interrupted')
            const url = new URL(String(input))
            const native = url.hostname === 'api.typesafe.ai'
            if (url.pathname.endsWith('/models'))
              return Response.json(
                native ? { models: [{ name: 'jev-latest', description: 'Stable', release_date: '2026-09-10' }] } : { data: [{ id: 'decision-model' }] }
              )
            const body = JSON.parse(String(init?.body))
            const legacy = typeof body.prompt === 'string'
            const request = native
              ? body.questions.decision
              : JSON.parse(legacy ? body.prompt.slice(body.prompt.lastIndexOf('\n\nuser: ') + 8) : body.messages[1].content)
            if (native) expect(request.type).toBe('choice')
            const labels = Object.keys(request.criteria)
            if (labels.includes('writing:simple')) {
              expect(labels.every(label => /^[a-z_]+:(simple|moderate|complex)$/.test(label))).toBe(true)
              expect(request.instructions).toContain('# Goal')
            }
            const choice = labels.includes('writing:simple') ? 'writing:simple' : labels[0]
            const probabilities = Object.fromEntries(labels.map(label => [label, label === choice ? 1 : 0]))
            const answer = { choice: decisionResponse === 'malformed' ? 'not-an-allowed-task' : choice, probabilities, confidence: 1 }
            return Response.json(
              native
                ? { model: 'jev-1.13.0', answers: { decision: { type: 'choice', ...answer } }, usage: { input_tokens: 338, output_tokens: 31 } }
                : {
                    id: 'fixture',
                    created: 0,
                    object: legacy ? 'text_completion' : 'chat.completion',
                    model: 'decision-model',
                    choices: [
                      {
                        index: 0,
                        finish_reason: 'stop',
                        ...(legacy ? { text: JSON.stringify(answer) } : { message: { role: 'assistant', content: JSON.stringify(answer) } })
                      }
                    ],
                    usage: compatibleUsage
                  }
            )
          },
          { preconnect() {} }
        ) as typeof fetch
      }
    )
  })
  afterAll(async () => {
    if (db) await db.destroy()
    const admin = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.destroy()
    }
  })

  it('bootstraps disabled conservative policy and persists declarations without inventing model intelligence or latency', async () => {
    expect(await policies.getAdmin(actor)).toEqual({ policy: { ...DEFAULT_ROUTING_POLICY, revision: 1, updatedAt: null }, models: [] })
    const declaration = await policies.setModelPolicy(profileId, modelInput, 0, actor)
    expect(declaration).toMatchObject({ profileId, profileVersionId: versionId, acceptableTasks: modelInput.acceptableTasks, estimatedLatencyMs: null })
    const current = await policies.getAdmin(actor)
    const policy = await policies.updateAdmin(
      { ...DEFAULT_ROUTING_POLICY, enabled: true, decisionProviderId: TYPESAFE_DECISION_PROVIDER_ID },
      current.policy.revision,
      actor
    )
    const reopened = await new AgentRoutingPolicyRegistry(db).getAdmin(actor)
    expect(reopened).toEqual({ policy, models: [declaration] })
    expect(reopened.models[0]).not.toHaveProperty('intelligence')
  })
  it('defaults missing historical specialist fields without rewriting persisted configuration', async () => {
    const {
      specialistEnabled: _enabled,
      specialistMaxContexts: _contexts,
      specialistMaxContextBytes: _bytes,
      specialistMaxReportTokens: _tokens,
      specialistMaxTurns: _turns,
      ...historical
    } = DEFAULT_ROUTING_POLICY
    const config = JSON.stringify(historical)
    await db('agentRoutingPolicy').where({ id: 1 }).update({ config })
    expect((await policies.getRuntime()).policy).toMatchObject(DEFAULT_ROUTING_POLICY)
    expect((await db('agentRoutingPolicy').where({ id: 1 }).first('config')).config).toBe(config)
    for (const invalid of [{ specialistMaxContexts: 9 }, { specialistMaxContextBytes: 4_095 }, { specialistMaxReportTokens: 4_097 }, { specialistMaxTurns: 0 }])
      await expect(policies.updateAdmin({ ...DEFAULT_ROUTING_POLICY, ...invalid }, 1, actor)).rejects.toMatchObject({ code: 'INVALID_ROUTING_POLICY' })
  })

  it('requires current active account and live manage:system on reads and every write boundary', async () => {
    for (const denied of [{ id: 8, authVersion: 1 }, { id: 9, authVersion: 1 }, { id: 7, authVersion: 2 }, { id: 7 }]) {
      await expect(policies.getAdmin(denied)).rejects.toMatchObject({ code: 'ROUTING_ADMIN_REQUIRED' })
      await expect(policies.updateAdmin(DEFAULT_ROUTING_POLICY, 1, denied)).rejects.toMatchObject({ code: 'ROUTING_ADMIN_REQUIRED' })
      await expect(policies.setModelPolicy(profileId, modelInput, 0, denied)).rejects.toMatchObject({ code: 'ROUTING_ADMIN_REQUIRED' })
      await expect(policies.removeModelPolicy(profileId, 1, denied)).rejects.toMatchObject({ code: 'ROUTING_ADMIN_REQUIRED' })
    }
    await expect(policies.getAdmin(undefined as unknown as RoutingActor)).rejects.toMatchObject({ code: 'ROUTING_ADMIN_REQUIRED' })
    await db('userGroups').where({ userId: 7 }).delete()
    await expect(policies.getAdmin(actor)).rejects.toMatchObject({ code: 'ROUTING_ADMIN_REQUIRED' })
    expect((await policies.getRuntime()).policy.revision).toBe(1)
  })

  it('serializes optimistic updates and invalidates stale policy revisions on model mutations', async () => {
    const updates = await Promise.allSettled([
      policies.updateAdmin({ ...DEFAULT_ROUTING_POLICY, minimumConfidence: 0.97 }, 1, actor),
      policies.updateAdmin({ ...DEFAULT_ROUTING_POLICY, minimumConfidence: 0.98 }, 1, actor)
    ])
    expect(updates.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(updates.filter(result => result.status === 'rejected')).toHaveLength(1)
    const declared = await policies.setModelPolicy(profileId, modelInput, 0, actor)
    await expect(policies.updateAdmin(DEFAULT_ROUTING_POLICY, 2, actor)).rejects.toMatchObject({ code: 'ROUTING_REVISION_CHANGED' })
    await expect(policies.setModelPolicy(profileId, modelInput, 0, actor)).rejects.toMatchObject({ code: 'ROUTING_REVISION_CHANGED' })
    await expect(policies.removeModelPolicy(profileId, declared.revision + 1, actor)).rejects.toMatchObject({ code: 'ROUTING_REVISION_CHANGED' })
    await policies.removeModelPolicy(profileId, declared.revision, actor)
    expect((await policies.getAdmin(actor)).models).toHaveLength(0)
    const recreated = await policies.setModelPolicy(profileId, modelInput, 0, actor)
    expect(recreated.revision).toBeGreaterThan(declared.revision)
    await expect(policies.setModelPolicy(profileId, modelInput, declared.revision, actor)).rejects.toMatchObject({ code: 'ROUTING_REVISION_CHANGED' })
  })

  it('refuses mismatched, superseded and deleted profile versions and missing task declarations', async () => {
    await expect(policies.setModelPolicy(profileId, { ...modelInput, profileVersionId: anotherVersionId }, 0, actor)).rejects.toMatchObject({
      code: 'ROUTING_MODEL_NOT_FOUND'
    })
    const oldVersion = randomUUID()
    await db('agentProviderProfileVersions').insert({ id: oldVersion, profileId })
    await expect(policies.setModelPolicy(profileId, { ...modelInput, profileVersionId: oldVersion }, 0, actor)).rejects.toMatchObject({
      code: 'ROUTING_MODEL_VERSION_CHANGED'
    })
    await expect(policies.setModelPolicy(profileId, { ...modelInput, acceptableTasks: [] }, 0, actor)).rejects.toMatchObject({ code: 'INVALID_ROUTING_POLICY' })
    await db('agentProviderProfiles').where({ id: profileId }).update({ deletedAt: new Date() })
    await expect(policies.setModelPolicy(profileId, modelInput, 0, actor)).rejects.toMatchObject({ code: 'ROUTING_MODEL_NOT_FOUND' })
  })

  it('validates named decision provider persistence independently of enable/readiness', async () => {
    await expect(policies.updateAdmin({ ...DEFAULT_ROUTING_POLICY, decisionProviderId: randomUUID() }, 1, actor)).rejects.toMatchObject({
      code: 'DECISION_PROVIDER_NOT_FOUND'
    })
    await db('agentDecisionProviders').where({ id: TYPESAFE_DECISION_PROVIDER_ID }).update({ enabled: false, isDefault: false })
    expect(await policies.updateAdmin({ ...DEFAULT_ROUTING_POLICY, enabled: true, decisionProviderId: TYPESAFE_DECISION_PROVIDER_ID }, 1, actor)).toMatchObject(
      { enabled: true }
    )
  })

  const routingFixture = async () => {
    await policies.setModelPolicy(profileId, modelInput, 0, actor)
    await policies.updateAdmin({ ...DEFAULT_ROUTING_POLICY, enabled: true }, (await policies.getRuntime()).policy.revision, actor)
    const capabilities: RoutingCandidate['capabilities'] = {
      streaming: true,
      toolCalling: 'native',
      parallelToolCalls: true,
      structuredOutput: 'native-json-schema',
      usage: 'terminal',
      cancellation: true,
      maxContextTokens: 200_000,
      maxOutputTokens: 8_000
    }
    const current: RoutingCandidate = {
      profileId: anotherProfileId,
      profileVersionId: anotherVersionId,
      model: 'incumbent',
      enabled: true,
      authorized: true,
      credentialReady: true,
      conformed: true,
      modalities: ['text'],
      capabilities,
      pricing: { inputPerMillion: 10, outputPerMillion: 20, revision: 'current-price' }
    }
    const alternate: RoutingCandidate = {
      ...current,
      profileId,
      profileVersionId: versionId,
      model: 'alternative',
      pricing: { inputPerMillion: 1, outputPerMillion: 2, revision: 'alternate-price' }
    }
    const input: RoutingTurnInput = {
      ownerId: 7,
      sessionId: randomUUID(),
      runId: randomUUID(),
      current,
      candidates: [current, alternate],
      requirements: { modalities: ['text'], nativeTools: true, nativeExternalMcp: false, nativeSchema: true, minimumOutputTokens: 100 },
      currentInputTokens: 10_000,
      fullHistoryInputTokens: 12_000,
      expectedOutputTokens: 1_000,
      classifierState: { currentMessage: 'Write a short greeting.' }
    }
    const measured: unknown[] = [],
      checkpoints: RoutingTurnDecision[] = []
    const hooks: RoutingTurnHooks = {
      budget: {
        async reserve(maximum) {
          return { id: 1, ...maximum }
        },
        async reconcile(_reservation, usage) {
          measured.push(usage)
        },
        async release() {
          throw new Error('Paid exposure must not be released')
        }
      },
      async checkpoint(decision) {
        checkpoints.push(decision)
      }
    }
    return { input, hooks, measured, checkpoints, router: new AgentTurnRouter(policies, decisions) }
  }

  const enableCompatible = async (dialect: 'chat-completions' | 'completions' = 'chat-completions') => {
    let provider = await decisions.create(
      {
        displayName: 'Configured custom decisions',
        secretValue: 'fixture-native-key',
        config: {
          kind: 'openai-compatible',
          model: 'decision-model',
          baseUrl: 'https://classifier.example/v1',
          dialect,
          timeoutMs: 1_000,
          maxOutputTokens: 512,
          pricing: {
            currency: 'USD',
            inputPerMillion: 0.042,
            outputPerMillion: 0,
            perRequest: 0,
            revision: 'custom-price-1',
            source: 'https://classifier.example/pricing',
            verifiedAt: '2026-10-04'
          }
        }
      },
      actor
    )
    await decisions.check(provider.id, provider.revision, actor)
    provider = await decisions.setEnabled(provider.id, true, provider.revision, actor)
    await policies.updateAdmin(
      { ...DEFAULT_ROUTING_POLICY, enabled: true, decisionProviderId: provider.id },
      (await policies.getRuntime()).policy.revision,
      actor
    )
    nativeCalls = 0
    return provider
  }

  it('routes using the real DecisionProviderRegistry and Ax native Choice path with measured usage and exactly-once replay', async () => {
    const f = await routingFixture()
    const decision = await f.router.routeTurn(f.input, f.hooks)
    expect(decision).toMatchObject({
      switched: true,
      profileId,
      profileVersionId: versionId,
      classification: {
        model: 'jev-1.13.0',
        usage: { inputTokens: 338, outputTokens: 31, totalTokens: 369, totalTokensSource: 'derived' },
        estimatedCostMicros: 15
      }
    })
    expect(f.measured).toEqual([{ inputTokens: 338, outputTokens: 31, totalTokens: 369, costMicros: 15 }])
    await db.transaction(tx => f.router.validateDecision(decision, tx))
    expect(await f.router.routeTurn({ ...f.input, recordedDecision: decision }, f.hooks)).toEqual(decision)
    expect(nativeCalls).toBe(1)
    expect(f.checkpoints).toHaveLength(1)
    await policies.setModelPolicy(profileId, { ...modelInput, estimatedLatencyMs: 500 }, (await policies.getRuntime()).models[0]!.revision, actor)
    await expect(Promise.resolve(db.transaction(tx => f.router.validateDecision(decision, tx)))).rejects.toMatchObject({ code: 'ROUTING_REVISION_CHANGED' })
  })
  for (const { fullHistoryInputTokens, strategy } of [
    { fullHistoryInputTokens: 12_000, strategy: 'swap' },
    { fullHistoryInputTokens: 150_000, strategy: 'stay' }
  ] as const)
    it(`uses direct ${strategy} routing for saved specialist-enabled policy ${strategy === 'swap' ? 'with exactly-once native usage' : 'without paid classification when cold replay cannot save cost'}`, async () => {
      const f = await routingFixture()
      await policies.updateAdmin({ ...DEFAULT_ROUTING_POLICY, enabled: true, specialistEnabled: true }, (await policies.getRuntime()).policy.revision, actor)
      const savedConfig = (await db('agentRoutingPolicy').where({ id: 1 }).first('config')).config
      const input: RoutingTurnInput = {
        ...f.input,
        estimatedRootWorkTurns: 3,
        fullHistoryInputTokens,
        specialists: [
          {
            contextId: randomUUID(),
            contextVersion: 4,
            candidate: f.input.candidates[1]!,
            taskClass: 'writing',
            complexity: 'simple',
            inputTokens: 100,
            description: 'Historical independently assigned greeting revision.'
          }
        ]
      }
      const decision = await f.router.routeTurn(input, f.hooks)
      expect(decision).toMatchObject({
        strategy,
        switched: strategy === 'swap',
        profileId: strategy === 'swap' ? profileId : anotherProfileId,
        profileVersionId: strategy === 'swap' ? versionId : anotherVersionId,
        specialist: null,
        strategyCosts: {
          basis: 'host-token-estimates-no-cache-discount',
          rootWorkTurns: 3,
          childWorkTurns: 0,
          reportTokens: 0,
          handoffInputTokens: 0,
          delegateMicros: null
        }
      })
      if (strategy === 'swap')
        expect(decision.classification).toMatchObject({
          choice: 'writing:simple',
          model: 'jev-1.13.0',
          usage: { totalTokens: 369, totalTokensSource: 'derived' }
        })
      else
        expect(decision).toMatchObject({
          reason: 'classifier-overhead',
          classification: null,
          classifierReservation: null,
          classifierFailure: null,
          unknownExposure: null
        })
      await db.transaction(tx => f.router.validateDecision(decision, tx))
      expect(await f.router.routeTurn({ ...input, recordedDecision: JSON.parse(JSON.stringify(decision)) }, f.hooks)).toEqual(decision)
      expect(nativeCalls).toBe(strategy === 'swap' ? 1 : 0)
      expect(f.checkpoints).toHaveLength(1)
      expect(f.measured).toEqual(strategy === 'swap' ? [{ inputTokens: 338, outputTokens: 31, totalTokens: 369, costMicros: 15 }] : [])
      expect((await db('agentRoutingPolicy').where({ id: 1 }).first('config')).config).toBe(savedConfig)
      if (strategy === 'swap') {
        const replacement = randomUUID()
        await db('agentProviderProfileVersions').insert({ id: replacement, profileId })
        await db('agentProviderProfiles').where({ id: profileId }).update({ currentVersionId: replacement })
        await expect(Promise.resolve(db.transaction(tx => f.router.validateDecision(decision, tx)))).rejects.toMatchObject({ code: 'ROUTING_REVISION_CHANGED' })
      } else {
        await policies.updateAdmin(
          { ...DEFAULT_ROUTING_POLICY, enabled: true, specialistEnabled: true, minimumConfidence: 0.98 },
          (await policies.getRuntime()).policy.revision,
          actor
        )
        await expect(Promise.resolve(db.transaction(tx => f.router.validateDecision(decision, tx)))).rejects.toMatchObject({ code: 'ROUTING_REVISION_CHANGED' })
      }
    })

  it('accounts billed malformed native responses before retaining the authorized incumbent', async () => {
    const f = await routingFixture()
    decisionResponse = 'malformed'
    const decision = await f.router.routeTurn(f.input, f.hooks)
    expect(decision).toMatchObject({
      switched: false,
      profileId: anotherProfileId,
      classifierFailure: { usage: { inputTokens: 338, outputTokens: 31, totalTokens: 369, totalTokensSource: 'derived' } },
      unknownExposure: null
    })
    expect(f.measured).toEqual([{ inputTokens: 338, outputTokens: 31, totalTokens: 369, costMicros: 15 }])
    expect(await f.router.routeTurn({ ...f.input, recordedDecision: JSON.parse(JSON.stringify(decision)) }, f.hooks)).toEqual(decision)
    expect(f.checkpoints).toHaveLength(1)
    expect(nativeCalls).toBe(1)
  })

  it('does not invent usage for unobserved native failures, and does not reclassify or re-account on replay', async () => {
    const f = await routingFixture()
    decisionResponse = 'unknown-failure'
    const first = await f.router.routeTurn(f.input, f.hooks)
    expect(first).toMatchObject({ switched: false, classifierFailure: { usage: null }, unknownExposure: { tokens: 64_000, costMicros: 2_688 } })
    expect(f.measured).toHaveLength(0)
    await f.router.routeTurn({ ...f.input, recordedDecision: first }, f.hooks)
    expect(nativeCalls).toBe(1)
    expect(f.checkpoints).toHaveLength(1)
  })

  it('keeps disabled decision-provider fallback safe without any network dispatch', async () => {
    const f = await routingFixture()
    await db('agentDecisionProviders').where({ id: TYPESAFE_DECISION_PROVIDER_ID }).update({ enabled: false, isDefault: false })
    expect(await f.router.routeTurn(f.input, f.hooks)).toMatchObject({ switched: false, reason: 'decision-provider-unavailable', profileId: anotherProfileId })
    expect(nativeCalls).toBe(0)
  })

  for (const dialect of ['chat-completions', 'completions'] as const)
    it(`retains residual usage and exactly-once replay through configured ${dialect} credential/check/enable persistence`, async () => {
      const f = await routingFixture()
      const provider = await enableCompatible(dialect)
      compatibleUsage = { prompt_tokens: 123, completion_tokens: 12, total_tokens: 190 }
      const decision = await f.router.routeTurn(f.input, f.hooks)
      expect(decision).toMatchObject({
        switched: true,
        classifierReservation: { tokens: 131_584, costMicros: 5_527, basis: 'serialized-byte-proxy' },
        classification: {
          providerId: provider.id,
          model: 'decision-model',
          usage: { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' },
          estimatedCostMicros: 8
        }
      })
      expect(decision.classifierExpectedCost!.costMicros).toBeLessThan(decision.classifierReservation!.costMicros)
      expect(f.measured).toEqual([{ inputTokens: 123, outputTokens: 12, totalTokens: 190, costMicros: 8 }])
      expect(await f.router.routeTurn({ ...f.input, recordedDecision: JSON.parse(JSON.stringify(decision)) }, f.hooks)).toEqual(decision)
      expect(f.measured).toHaveLength(1)
      expect(f.checkpoints).toHaveLength(1)
      expect(nativeCalls).toBe(1)
    })

  for (const mode of ['billed-malformed', 'negative-total', 'underflow-total'] as const)
    it(`retains paid exposure once for a compatible ${mode} response from the real registry`, async () => {
      const f = await routingFixture()
      await enableCompatible()
      compatibleUsage = { prompt_tokens: 123, completion_tokens: 12, total_tokens: mode === 'negative-total' ? -1 : mode === 'underflow-total' ? 134 : 190 }
      if (mode === 'billed-malformed') decisionResponse = 'malformed'
      const decision = await f.router.routeTurn(f.input, f.hooks)
      if (mode === 'billed-malformed') {
        expect(decision).toMatchObject({
          switched: false,
          classifierFailure: { usage: { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' }, estimatedCostMicros: 8 },
          unknownExposure: null
        })
        expect(f.measured).toEqual([{ inputTokens: 123, outputTokens: 12, totalTokens: 190, costMicros: 8 }])
      } else {
        expect(decision).toMatchObject({
          switched: false,
          classification: null,
          classifierFailure: { usage: null, estimatedCostMicros: null },
          unknownExposure: { tokens: 131_584, costMicros: 5_527 }
        })
        expect(f.measured).toHaveLength(0)
      }
      expect(await f.router.routeTurn({ ...f.input, recordedDecision: JSON.parse(JSON.stringify(decision)) }, f.hooks)).toEqual(decision)
      expect(f.measured).toHaveLength(mode === 'billed-malformed' ? 1 : 0)
      expect(nativeCalls).toBe(1)
      expect(f.checkpoints).toHaveLength(1)
    })

  it('refuses destructive rollback of administrator configuration', async () => {
    await policies.setModelPolicy(profileId, modelInput, 0, actor)
    await expect(removeRouting(db)).rejects.toThrow('administrator configuration')
    expect(await db.schema.hasTable('agentRoutingModelPolicies')).toBe(true)
  })
})
