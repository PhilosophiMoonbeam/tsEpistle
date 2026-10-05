import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { expect } from '../bun-test.mts'
import { up as addAgentTaskLedger } from '../../db/migrations/2.5.156.ts'
import { up as addAgentGoalBudgetTiers } from '../../db/migrations/tsepistle-000042-agent-goal-budget-tiers.ts'
import { up as addAgentMedia } from '../../db/migrations/tsepistle-000044-agent-media.ts'
import { up as addAgentMediaContextState } from '../../db/migrations/tsepistle-000047-agent-media-context-state.ts'
import { AgentProviderRegistry, type AgentProviderSettingsInput } from '../../agents/providers/registry.ts'
import { AgentProductRuntime, type AgentEngineRequest, type AgentEngine } from '../../agents/runtime.ts'
import { DEFAULT_AGENT_ORCHESTRATION_LIMITS } from '../../agents/orchestration.ts'
import { AgentTurnRouter } from '../../agents/routing.ts'
import type { DecisionProviderRuntime } from '../../agents/decision-providers.ts'
import { createAgentSession } from '../../agents/repository.ts'
import type { AgentRunRecord } from '../../agents/coordinator.ts'
import { TYPESAFE_JEV_PRICING, type DecisionResult } from '../../../shared/agents/decision-providers.ts'
import { DEFAULT_ROUTING_POLICY, ROUTING_TASK_CLASSES, ROUTING_COMPLEXITIES, type RoutingAdminView } from '../../../shared/agents/routing.ts'

export const createRoutingTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('users', table => {
    table.integer('id').primary()
    table.boolean('isActive').notNullable().defaultTo(true)
    table.integer('authVersion').notNullable().defaultTo(0)
  })
  await knex.schema.createTable('agentSessions', table => {
    table.boolean('googleSearchEnabled').notNullable().defaultTo(false)
    table.uuid('id').primary()
    table.integer('ownerId').notNullable()
    table.string('title').notNullable()
    table.string('titleSource').notNullable().defaultTo('none')
    table.string('retention').notNullable()
    table.uuid('folderId').nullable()
    table.uuid('providerProfileId').nullable()
    table.string('executionMode').notNullable()
    table.integer('version').notNullable()
    table.text('summary').nullable()
    table.integer('summaryThroughOrdinal').nullable()
    table.text('memorySnapshot').notNullable().defaultTo('{"agent":[],"user":[]}')
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('lastActivityAt').notNullable()
    table.dateTime('expiresAt').nullable()
    table.dateTime('deletedAt').nullable()
  })
  await knex.schema.createTable('agentGoals', table => {
    table.uuid('id').primary()
    table.uuid('sessionId').notNullable()
    table.integer('ownerId').notNullable()
    table.integer('createdByUserId').notNullable()
    table.text('objective').notNullable()
    table.string('objectiveSha256').notNullable()
    table.string('status').notNullable()
    table.integer('version').notNullable()
    table.integer('continuationCount').notNullable()
    table.integer('maxContinuations').notNullable()
    table.bigInteger('consumedTokens').notNullable()
    table.bigInteger('maxTokens').notNullable()
    table.integer('consumedToolCalls').notNullable()
    table.integer('maxToolCalls').notNullable()
    table.string('completionOutcome').nullable()
    table.text('completionAssessment').nullable()
    table.string('completionAssessmentSha256').nullable()
    table.string('errorCode').nullable()
    table.text('errorMessage').nullable()
    table.dateTime('startedAt').notNullable()
    table.dateTime('deadlineAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('completedAt').nullable()
  })
  await knex.schema.createTable('agentConversationFolders', table => {
    table.uuid('id').primary()
    table.integer('ownerId').notNullable()
    table.string('name').notNullable()
    table.string('normalizedName').notNullable()
    table.integer('version').notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.unique(['ownerId', 'normalizedName'])
  })
  await knex.schema.createTable('agentMessages', table => {
    table.text('googleSearchGrounding').nullable()
    table.uuid('id').primary()
    table.uuid('sessionId').notNullable()
    table.uuid('runId').nullable()
    table.integer('ordinal').notNullable()
    table.string('role').notNullable()
    table.string('status').notNullable()
    table.text('content').notNullable()
    table.boolean('isVisible').notNullable().defaultTo(true)
    table.text('citations').nullable()
    table.binary('providerStateCiphertext').nullable()
    table.string('providerStateSha256').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.unique(['sessionId', 'ordinal'])
  })
  await knex.schema.createTable('agentRuns', table => {
    table.boolean('googleSearchEnabled').notNullable().defaultTo(false)
    table.uuid('id').primary()
    table.uuid('sessionId').notNullable()
    table.uuid('userMessageId').notNullable()
    table.uuid('assistantMessageId').notNullable()
    table.integer('ownerId').notNullable()
    table.uuid('clientRequestId').notNullable()
    table.string('clientRequestSha256').notNullable()
    table.string('profileResolutionSha256').notNullable()
    table.string('status').notNullable()
    table.integer('attempts').notNullable()
    table.integer('maxAttempts').notNullable()
    table.integer('eventSequence').notNullable()
    table.dateTime('availableAt').notNullable()
    table.string('leaseOwner').nullable()
    table.uuid('leaseToken').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.dateTime('cancelRequestedAt').nullable()
    table.boolean('sideEffectsStarted').notNullable()
    table.uuid('providerProfileVersionId').notNullable()
    table.string('transportKind').notNullable()
    table.string('model').notNullable()
    table.string('executionMode').notNullable()
    table.integer('profilePolicyVersion').notNullable()
    table.integer('defaultGeneration').notNullable()
    table.string('capabilityRevision').notNullable()
    table.string('pricingRevision').notNullable()
    table.integer('promptVersion').notNullable()
    table.integer('inputTokens').notNullable()
    table.integer('outputTokens').notNullable()
    table.integer('totalTokens').notNullable().defaultTo(0)
    table.integer('estimatedCostMicros').nullable()
    table.binary('runtimeStateCiphertext').nullable()
    table.string('errorCode').nullable()
    table.text('errorMessage').nullable()
    table.dateTime('queuedAt').notNullable()
    table.dateTime('startedAt').nullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('completedAt').nullable()
    table.uuid('goalId').nullable()
    table.integer('goalContinuation').nullable()
    table.string('completionOutcome').nullable()
    table.text('completionAssessment').nullable()
    table.string('completionAssessmentSha256').nullable()
  })
  await addAgentTaskLedger(knex)
  await knex.schema.createTable('agentEvents', table => {
    table.uuid('id').primary()
    table.uuid('runId').notNullable()
    table.integer('sequence').notNullable()
    table.string('type').notNullable()
    table.integer('attempt').notNullable()
    table.integer('schemaVersion').notNullable()
    table.string('dataSha256').notNullable()
    table.text('data').notNullable()
    table.dateTime('createdAt').notNullable()
    table.unique(['runId', 'sequence'])
  })
  await knex.schema.createTable('agentArtifacts', table => {
    table.uuid('id').primary()
    table.uuid('sessionId').notNullable()
    table.uuid('runId').notNullable()
    table.integer('ownerId').notNullable()
    table.string('kind').notNullable()
    table.string('mimeType').notNullable()
    table.integer('byteLength').notNullable()
    table.string('sha256').notNullable()
    table.binary('payload').notNullable()
    table.integer('width').notNullable()
    table.integer('height').notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('expiresAt').nullable()
    table.text('metadata').nullable()
  })
  await knex.schema.createTable('agentUserSkillPreferences', table => {
    table.integer('ownerId').notNullable()
    table.uuid('skillId').notNullable()
    table.integer('ordinal').notNullable()
  })
  await knex.schema.createTable('agentRunSkills', table => {
    table.uuid('runId').notNullable()
    table.uuid('skillVersionId').notNullable()
    table.integer('ordinal').notNullable()
  })
  await knex.schema.createTable('agentSkillUses', table => {
    table.uuid('id').primary()
    table.uuid('skillVersionId').notNullable()
    table.uuid('runId').nullable()
    table.uuid('sessionId').nullable()
    table.integer('requesterUserId').nullable()
    table.integer('requesterApiKeyId').nullable()
    table.uuid('transportRequestId').notNullable()
    table.string('externalSessionSha256').nullable()
    table.text('resourcePath').nullable()
    table.string('purpose').notNullable()
    table.string('contentHash').notNullable()
    table.dateTime('createdAt').defaultTo(knex.fn.now())
  })
  await knex.schema.createTable('agentSkillVersions', table => {
    table.uuid('id').primary()
    table.uuid('skillId').notNullable()
    table.text('frontmatter').notNullable()
    table.string('contentHash').notNullable()
    table.string('approvalStatus').notNullable().defaultTo('approved')
    table.dateTime('createdAt').notNullable()
    table.text('skillMarkdown').notNullable().defaultTo('')
  })
  await knex.schema.createTable('agentSkills', table => {
    table.uuid('id').primary()
    table.string('name').notNullable()
    table.text('rootPath').notNullable()
    table.string('status').notNullable()
    table.string('exposureMode').notNullable().defaultTo('all_agent_users')
    table.integer('ownerUserId').nullable()
    table.boolean('isAgentDiscoverable').notNullable().defaultTo(true)
    table.uuid('currentVersionId').nullable()
    table.dateTime('deletedAt').nullable()
  })
  await knex.schema.createTable('agentSkillGrants', table => {
    table.uuid('skillId').notNullable()
    table.integer('groupId').notNullable()
  })
  await knex.schema.createTable('groups', table => {
    table.integer('id').primary()
    table.text('permissions').notNullable().defaultTo('["use:agents"]')
  })
  await knex.schema.createTable('userGroups', table => {
    table.integer('userId').notNullable()
    table.integer('groupId').notNullable()
  })
  await knex.schema.createTable('pages', table => {
    table.integer('id').primary()
    table.string('localeCode').notNullable()
    table.text('path').notNullable()
    table.string('title').notNullable()
    table.string('contentType').notNullable()
  })
  await knex.schema.createTable('agentProposals', table => {
    table.uuid('id').primary()
    table.uuid('sessionId').nullable()
    table.uuid('runId').nullable()
    table.string('sourceKind').notNullable()
    table.string('actionName').notNullable()
    table.string('risk').notNullable()
    table.string('status').notNullable()
    table.text('summary').notNullable().defaultTo('')
    table.text('operation').notNullable().defaultTo('{}')
    table.integer('pageId').nullable()
    table.integer('baseSourceRevision').nullable()
    table.string('authoritySha256').notNullable()
    table.string('inputHash').notNullable()
    table.string('patchSha256').nullable()
    table.string('resultCanonicalSha256').nullable()
    table.string('diffSha256').nullable()
    table.text('diff').nullable()
    table.dateTime('contentPurgedAt').nullable()
    table.dateTime('expiresAt').notNullable()
    table.dateTime('createdAt').notNullable()
  })
  await knex.schema.createTable('agentApprovals', table => {
    table.uuid('id').primary()
    table.uuid('proposalId').notNullable()
    table.string('status').notNullable()
    table.dateTime('requestedAt').notNullable()
    table.dateTime('expiresAt').notNullable()
    table.dateTime('decidedAt').nullable()
    table.text('decisionNote').nullable()
  })
  await knex.schema.createTable('agentProviderProfileVersions', table => {
    table.uuid('id').primary()
    table.text('policies').notNullable()
    table.boolean('conformed').notNullable().defaultTo(true)
    table.text('capabilities').nullable()
  })
  await knex.schema.createTable('agentQuotaDaily', table => {
    table.bigInteger('tokenResetCredit').notNullable().defaultTo(0)
    table.integer('ownerId').notNullable()
    table.date('day').notNullable()
    table.integer('reservedTokens').notNullable()
    table.integer('consumedTokens').notNullable()
    table.integer('reservedCostMicros').notNullable()
    table.integer('consumedCostMicros').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.primary(['ownerId', 'day'])
  })
  await knex.schema.createTable('agentQuotaReservations', table => {
    table.uuid('runId').primary()
    table.integer('ownerId').notNullable()
    table.date('day').notNullable()
    table.integer('reservedTokens').notNullable()
    table.integer('reservedCostMicros').notNullable()
    table.integer('consumedTokens').notNullable()
    table.integer('consumedCostMicros').notNullable()
    table.string('status').notNullable()
    table.dateTime('expiresAt').notNullable()
    table.dateTime('heartbeatAt').notNullable()
    table.dateTime('reconciledAt').nullable()
  })

  await knex.schema.alterTable('agentProviderProfileVersions', table => {
    table.uuid('profileId')
    table.integer('version')
    table.string('transportKind')
    table.string('model')
    table.string('utilityModel').nullable()
    table.text('baseUrl')
    table.string('authMode')
    table.string('secretReference').nullable()
    table.text('adapterConfig')
    table.string('capabilityRevision')
    table.string('pricingRevision')
    table.integer('createdBy')
    table.dateTime('createdAt')
  })
  await knex.schema.createTable('agentProviderProfiles', table => {
    table.uuid('id').primary()
    table.string('displayName')
    table.string('status')
    table.boolean('isGlobalDefault')
    table.string('exposureMode')
    table.uuid('currentVersionId').nullable()
    table.integer('policyVersion')
    table.boolean('conformed')
    table.integer('createdBy')
    table.integer('updatedBy')
    table.dateTime('createdAt')
    table.dateTime('updatedAt')
    table.dateTime('deletedAt').nullable()
  })
  await knex.schema.createTable('agentProviderConfiguration', table => {
    table.integer('id').primary()
    table.integer('defaultGeneration')
    table.integer('updatedBy').nullable()
    table.dateTime('updatedAt')
  })
  await knex.schema.createTable('agentProviderGrants', table => {
    table.uuid('profileId')
    table.integer('groupId')
  })
  await addAgentGoalBudgetTiers(knex)
  await addAgentMedia(knex)
  await addAgentMediaContextState(knex)
  await knex('users').insert([{ id: 1 }, { id: 7 }, { id: 8 }])
  await knex('groups').insert([{ id: 1 }, { id: 2 }])
  await knex('userGroups').insert([
    { userId: 7, groupId: 1 },
    { userId: 8, groupId: 2 }
  ])
}

const profileInput: AgentProviderSettingsInput = {
  transportKind: 'openai-responses',
  model: 'incumbent',
  utilityModel: null,
  baseUrl: 'https://api.example.test/v1/',
  authMode: 'bearer',
  secretReference: 'env:TEST_PROVIDER_KEY',
  adapterConfig: { timeoutMs: 30_000, maxRetries: 0, additionalHeaders: {} },
  capabilities: {
    streaming: true,
    toolCalling: 'native',
    parallelToolCalls: false,
    structuredOutput: 'native-json-schema',
    usage: 'terminal',
    cancellation: true,
    maxContextTokens: 32_000,
    maxOutputTokens: 4_000
  },
  capabilityRevision: 'fixture-v1',
  policies: {
    allowedModes: ['agent'],
    dailyTokens: 1_000_000,
    dailyCostMicros: 10_000_000,
    reservationTokens: 10_000,
    reservationCostMicros: 100_000,
    reservationMilliseconds: 60_000,
    promptVersion: 1,
    maxAttempts: 3
  },
  pricingRevision: 'expensive-v1|10000000|20000000'
}

export interface RoutingFixture {
  readonly db: Knex
  readonly registry: AgentProviderRegistry
  readonly runtime: AgentProductRuntime
  readonly router: AgentTurnRouter
  readonly engine: AgentEngine
  readonly view: RoutingAdminView
  readonly provider: DecisionProviderRuntime
  readonly answer: DecisionResult
  readonly current: { readonly profileId: string; readonly versionId: string }
  readonly alternate: { readonly profileId: string; readonly versionId: string }
  readonly requests: AgentEngineRequest[]
  readonly session: (pinned?: boolean, ownerId?: number) => Promise<string>
  readonly submit: (sessionId: string, ownerId?: number) => Promise<{ readonly run: AgentRunRecord; readonly replayed: boolean }>
  readonly classifications: () => number
  readonly failClassifier: (value: unknown) => void
  readonly duringClassification: (fn: () => Promise<void>) => void
  readonly beforeInference: (fn: () => Promise<void>) => void
}

export const routingFixture = async (db: Knex): Promise<RoutingFixture> => {
  const registry = new AgentProviderRegistry(
    db,
    {
      has: reference => reference === 'env:TEST_PROVIDER_KEY',
      get: () => 'fixture-key',
      store: () => {
        throw new Error('unexpected managed credential')
      },
      delete: () => false
    },
    { currentKeyId: 'primary', keys: { primary: 'a-profile-resolution-secret-with-rotation-room' } }
  )
  const ready = async (name: string, groupIds?: readonly number[]) => {
    const profile = await registry.create({
      ...profileInput,
      model: name,
      ...(name === 'alternate' ? { pricingRevision: 'cheap-v1|1000000|2000000', capabilityRevision: 'alternate-v1' } : {}),
      displayName: name,
      exposureMode: groupIds ? 'groups' : 'all_agent_users',
      groupIds,
      actorId: 1
    })
    const version = await db('agentProviderProfiles').where({ id: profile.id }).first('currentVersionId')
    await registry.setConformed(profile.id, version.currentVersionId, true, 1)
    await registry.setEnabled(profile.id, true, 1, version.currentVersionId)
    return { profileId: profile.id, versionId: version.currentVersionId as string }
  }
  const current = await ready('incumbent')
  const alternate = await ready('alternate', [1])
  await registry.setDefault(current.profileId, 1)
  const view: RoutingAdminView = {
    policy: { ...DEFAULT_ROUTING_POLICY, enabled: true, revision: 1, updatedAt: null },
    models: [
      {
        profileId: alternate.profileId,
        profileVersionId: alternate.versionId,
        revision: 1,
        acceptableTasks: [{ taskClass: 'writing', complexities: ['simple'] }],
        estimatedLatencyMs: null,
        updatedAt: new Date().toISOString()
      }
    ]
  }
  const provider: DecisionProviderRuntime = {
    id: randomUUID(),
    revision: 1,
    config: { kind: 'typesafe', model: 'jev-1.13.0', timeoutMs: 1_000, pricing: TYPESAFE_JEV_PRICING }
  }
  const answer: DecisionResult = {
    providerId: provider.id,
    providerRevision: 1,
    model: 'jev-1.13.0',
    choice: 'writing:simple',
    confidence: 1,
    probabilities: Object.fromEntries(
      ROUTING_TASK_CLASSES.flatMap(task =>
        ROUTING_COMPLEXITIES.map(complexity => [`${task}:${complexity}`, task === 'writing' && complexity === 'simple' ? 1 : 0])
      )
    ),
    usage: { inputTokens: 123, outputTokens: 12, totalTokens: 190, totalTokensSource: 'reported' },
    latencyMs: 23,
    estimatedCost: null,
    estimatedCostMicros: 13
  }
  let classifications = 0
  let failure: unknown = null
  let classifierBoundary: (() => Promise<void>) | undefined
  const router = new AgentTurnRouter(
    { getRuntime: async () => view },
    {
      selectRuntime: async () => provider,
      decide: async request => {
        classifications += 1
        expect(JSON.stringify(request.state)).toContain('Write a short greeting')
        await classifierBoundary?.()
        if (failure !== null) throw failure
        return answer
      }
    }
  )
  const requests: AgentEngineRequest[] = []
  let beforeInference: (() => Promise<void>) | undefined
  const engine: AgentEngine = {
    preflight: async () => ({ admissible: true, inputExposureTokens: 5, outputExposureTokens: 3, totalExposureTokens: 8 }),
    execute: async (request, sink) => {
      await beforeInference?.()
      await request.authorizeDispatch?.()
      requests.push(request)
      const reservation = await request.dispatchBudget!.reserve({ tokens: 8, costMicros: 10 })
      await request.dispatchBudget!.reconcile(reservation, { inputTokens: 5, outputTokens: 3, totalTokens: 8, costMicros: 10 })
      await sink.text('Hello!')
      return { inputTokens: 5, outputTokens: 3, totalTokens: 8, costMicros: 10 }
    }
  }
  const runtime = new AgentProductRuntime(db, registry, engine, {
    router,
    workerId: `routing-${randomUUID()}`,
    globalConcurrency: 4,
    perUserConcurrency: 4,
    orchestration: { ...DEFAULT_AGENT_ORCHESTRATION_LIMITS, enabled: false },
    goals: { enabled: true, maxContinuations: 2, maxTokens: 100_000, maxToolCalls: 32, maxDurationMilliseconds: 60_000 }
  })
  const session = async (pinned = false, ownerId = 7) => {
    const id = randomUUID()
    await createAgentSession(db, {
      id,
      ownerId,
      title: 'Routing',
      retention: 'saved',
      providerProfileId: pinned ? current.profileId : null,
      executionMode: 'agent'
    })
    return id
  }
  const submit = async (sessionId: string, ownerId = 7) => {
    const saved = await db('agentSessions').where({ id: sessionId }).first('version')
    return runtime.submit({
      ownerId,
      sessionId,
      profileResolutionToken: await registry.issueResolutionToken(ownerId, sessionId),
      clientRequestId: randomUUID(),
      expectedSessionVersion: Number(saved.version),
      content: 'Write a short greeting'
    })
  }
  return {
    db,
    registry,
    runtime,
    router,
    engine,
    view,
    provider,
    answer,
    current,
    alternate,
    requests,
    session,
    submit,
    classifications: () => classifications,
    failClassifier: (value: unknown) => {
      failure = value
    },
    duringClassification: (fn: () => Promise<void>) => {
      classifierBoundary = fn
    },
    beforeInference: (fn: () => Promise<void>) => {
      beforeInference = fn
    }
  }
}
