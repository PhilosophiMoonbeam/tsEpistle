import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

import knexModule, { type Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '../bun-test.mts'
import { AgentProductRuntime, type AgentEngineRequest } from '../../agents/runtime.ts'
import { AgentProviderRegistry, type AgentProviderSettingsInput } from '../../agents/providers/registry.ts'
import { admitAgentRun } from '../../agents/coordinator.ts'
import { createAgentConversationFolder } from '../../agents/repository.ts'

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  databaseName.endsWith('_agents_test') && password
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? '127.0.0.1',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        password,
        database: databaseName
      }
    : null
const directlyInvoked =
  process.env.npm_lifecycle_event !== 'test' && process.argv.some(argument => argument.replaceAll('\\', '/').endsWith('repository.postgres.test.ts'))
const databaseContractRequired = directlyInvoked || process.env.WIKI_TEST_POSTGRES_REQUIRED === '1'

if (databaseContractRequired && !connection) {
  throw new Error('Explicit agent repository PostgreSQL execution requires WIKI_TEST_POSTGRES_DATABASE ending in _agents_test and a PostgreSQL password.')
}

const suite = connection ? describe : describe.skip
const schema = `agent_repository_${randomUUID().replaceAll('-', '')}`
const admissionSchema = `agent_admission_${randomUUID().replaceAll('-', '')}`
const postgresAdmissionSuite = connection ? describe : describe.skip

suite('PostgreSQL agent conversation folder repository', () => {
  let db: Knex

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
    })
    await db.schema.createTable('agentConversationFolders', table => {
      table.uuid('id').primary()
      table.integer('ownerId').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('name', 64).notNullable()
      table.string('normalizedName', 64).notNullable()
      table.integer('version').notNullable()
      table.dateTime('createdAt').notNullable()
      table.dateTime('updatedAt').notNullable()
      table.unique(['ownerId', 'normalizedName'])
    })
  })

  beforeEach(async () => {
    await db('agentConversationFolders').delete()
    await db('users').delete()
    await db('users').insert([{ id: 7 }, { id: 8 }])
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

  it('preserves canonical duplicate behavior across owners and connections', async () => {
    const secondConnection = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 2 } })
    try {
      await createAgentConversationFolder(db, 7, '  Ｆｏｌｄ\u00a0\tName  ')
      await expect(createAgentConversationFolder(secondConnection, 7, 'fold name')).rejects.toMatchObject({
        code: 'CONVERSATION_FOLDER_EXISTS',
        status: 409
      })
      await expect(createAgentConversationFolder(secondConnection, 8, 'fold name')).resolves.toMatchObject({ ownerId: 8, name: 'fold name' })
    } finally {
      await secondConnection.destroy()
    }
  })

  it('serializes same-owner cap checks on the owner row while another owner proceeds independently', async () => {
    const secondConnection = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [schema], pool: { min: 0, max: 2 } })
    try {
      const now = new Date('2026-09-11T00:00:00.000Z')
      await db('agentConversationFolders').insert(
        Array.from({ length: 31 }, (_, index) => {
          const name = `Existing ${String(index + 1).padStart(2, '0')}`
          return {
            id: randomUUID(),
            ownerId: 7,
            name,
            normalizedName: name.toLowerCase(),
            version: 1,
            createdAt: now,
            updatedAt: now
          }
        })
      )

      const results = await Promise.allSettled([
        createAgentConversationFolder(db, 7, 'Race A'),
        createAgentConversationFolder(secondConnection, 7, 'Race B'),
        createAgentConversationFolder(db, 8, 'Independent')
      ])
      const sameOwnerResults = results.slice(0, 2)
      expect(sameOwnerResults.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(sameOwnerResults.filter(result => result.status === 'rejected')).toHaveLength(1)
      const rejected = sameOwnerResults.find(result => result.status === 'rejected')
      expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'CONVERSATION_FOLDER_LIMIT_REACHED', status: 409 } })
      expect(results[2]).toMatchObject({ status: 'fulfilled', value: { ownerId: 8, name: 'Independent' } })
      expect(await db('agentConversationFolders').where({ ownerId: 7 })).toHaveLength(32)
      expect(await db('agentConversationFolders').where({ ownerId: 8 })).toHaveLength(1)
      await expect(createAgentConversationFolder(secondConnection, 7, ' Existing 01 ')).rejects.toMatchObject({
        code: 'CONVERSATION_FOLDER_EXISTS',
        status: 409
      })
    } finally {
      await secondConnection.destroy()
    }
  })
})

const createAdmissionTables = async (db: Knex): Promise<void> => {
  await db.schema.createTable('users', table => {
    table.integer('id').primary()
  })
  await db.schema.createTable('groups', table => {
    table.integer('id').primary()
  })
  await db.schema.createTable('agentProviderProfiles', table => {
    table.uuid('id').primary()
    table.string('displayName').notNullable()
    table.string('status').notNullable()
    table.boolean('isGlobalDefault').notNullable()
    table.string('exposureMode').notNullable()
    table.uuid('currentVersionId').nullable()
    table.integer('policyVersion').notNullable()
    table.boolean('conformed').notNullable()
    table.integer('createdBy').notNullable()
    table.integer('updatedBy').notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('deletedAt').nullable()
  })
  await db.schema.createTable('agentProviderProfileVersions', table => {
    table.uuid('id').primary()
    table.uuid('profileId').notNullable()
    table.integer('version').notNullable()
    table.string('transportKind').notNullable()
    table.string('model').notNullable()
    table.string('utilityModel').nullable()
    table.text('baseUrl').notNullable()
    table.string('authMode').notNullable()
    table.string('secretReference').nullable()
    table.text('adapterConfig').notNullable()
    table.text('capabilities').notNullable()
    table.string('capabilityRevision').notNullable()
    table.text('policies').notNullable()
    table.string('pricingRevision').notNullable()
    table.boolean('conformed').notNullable()
    table.integer('createdBy').notNullable()
    table.dateTime('createdAt').notNullable()
  })
  await db.schema.createTable('agentProviderConfiguration', table => {
    table.integer('id').primary()
    table.bigInteger('defaultGeneration').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.integer('updatedBy').nullable()
  })
  await db.schema.createTable('agentProviderGrants', table => {
    table.uuid('profileId').notNullable()
    table.integer('groupId').notNullable()
  })
  await db.schema.createTable('userGroups', table => {
    table.integer('userId').notNullable()
    table.integer('groupId').notNullable()
  })
  await db.schema.createTable('agentSessions', table => {
    table.uuid('id').primary()
    table.integer('ownerId').notNullable()
    table.string('title').notNullable()
    table.string('titleSource', 16).notNullable().defaultTo('none')
    table.string('retention').notNullable()
    table.uuid('providerProfileId').nullable()
    table.string('executionMode').notNullable()
    table.integer('version').notNullable()
    table.text('summary').nullable()
    table.integer('summaryThroughOrdinal').nullable()
    table.text('memorySnapshot').notNullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('lastActivityAt').notNullable()
    table.dateTime('expiresAt').nullable()
    table.dateTime('deletedAt').nullable()
  })
  await db.schema.createTable('agentMessages', table => {
    table.uuid('id').primary()
    table.uuid('sessionId').notNullable()
    table.uuid('runId').nullable()
    table.integer('ordinal').notNullable()
    table.string('role').notNullable()
    table.string('status').notNullable()
    table.text('content').notNullable()
    table.text('citations').nullable()
    table.binary('providerStateCiphertext').nullable()
    table.string('providerStateSha256').nullable()
    table.boolean('isVisible').notNullable().defaultTo(true)
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
  })
  await db.schema.createTable('agentRuns', table => {
    table.uuid('id').primary()
    table.uuid('sessionId').notNullable()
    table.uuid('userMessageId').notNullable()
    table.uuid('assistantMessageId').notNullable()
    table.integer('ownerId').notNullable()
    table.uuid('clientRequestId').notNullable()
    table.string('clientRequestSha256').notNullable()
    table.string('profileResolutionSha256').notNullable()
    table.uuid('goalId').nullable()
    table.integer('goalContinuation').nullable()
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
    table.integer('totalTokens').notNullable()
    table.integer('estimatedCostMicros').nullable()
    table.binary('runtimeStateCiphertext').nullable()
    table.string('completionOutcome').nullable()
    table.text('completionAssessment').nullable()
    table.string('completionAssessmentSha256').nullable()
    table.string('errorCode').nullable()
    table.text('errorMessage').nullable()
    table.dateTime('queuedAt').notNullable()
    table.dateTime('startedAt').nullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('completedAt').nullable()
    table.unique(['sessionId', 'clientRequestId'])
  })
  await db.schema.createTable('agentEvents', table => {
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
  await db.schema.createTable('agentProposals', table => {
    table.uuid('id').primary()
    table.uuid('runId').notNullable()
    table.string('status').notNullable()
  })
  await db.schema.createTable('agentRunSkills', table => {
    table.uuid('runId').notNullable()
    table.uuid('skillVersionId').notNullable()
    table.integer('ordinal').notNullable()
    table.primary(['runId', 'skillVersionId'])
  })
  await db.schema.createTable('agentQuotaDaily', table => {
    table.integer('ownerId').notNullable()
    table.date('day').notNullable()
    table.bigInteger('reservedTokens').notNullable()
    table.bigInteger('consumedTokens').notNullable()
    table.bigInteger('reservedCostMicros').notNullable()
    table.bigInteger('consumedCostMicros').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.primary(['ownerId', 'day'])
  })
  await db.schema.createTable('agentQuotaReservations', table => {
    table.uuid('runId').primary()
    table.integer('ownerId').notNullable()
    table.date('day').notNullable()
    table.bigInteger('reservedTokens').notNullable()
    table.bigInteger('reservedCostMicros').notNullable()
    table.bigInteger('consumedTokens').notNullable()
    table.bigInteger('consumedCostMicros').notNullable()
    table.string('status').notNullable()
    table.dateTime('expiresAt').notNullable()
    table.dateTime('heartbeatAt').notNullable()
    table.dateTime('reconciledAt').nullable()
  })
  await db.schema.createTable('agentSkills', table => {
    table.uuid('id').primary()
    table.string('name').notNullable()
    table.integer('rootPageId').nullable()
    table.string('rootPath').nullable()
    table.integer('assetFolderId').nullable()
    table.string('status').notNullable()
    table.string('exposureMode').notNullable()
    table.uuid('currentVersionId').nullable()
    table.boolean('isAgentDiscoverable').notNullable()
    table.integer('ownerUserId').nullable()
    table.dateTime('deletedAt').nullable()
    table.integer('createdBy').nullable()
    table.integer('updatedBy').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
  })
  await db.schema.createTable('agentSkillVersions', table => {
    table.uuid('id').primary()
    table.uuid('skillId').notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.dateTime('sourceUpdatedAt').notNullable()
    table.integer('sourceHistoryId').nullable()
    table.text('frontmatter').notNullable()
    table.text('skillMarkdown').notNullable()
    table.binary('resourceBundle').notNullable()
    table.text('resourceManifest').notNullable()
    table.string('contentHash').notNullable()
    table.string('approvalStatus').notNullable()
    table.integer('approvedBy').nullable()
    table.dateTime('approvedAt').nullable()
    table.dateTime('createdAt').notNullable()
  })
  await db.schema.createTable('agentSkillGrants', table => {
    table.uuid('skillId').notNullable()
    table.integer('groupId').notNullable()
  })
  await db.schema.createTable('agentUserSkillPreferences', table => {
    table.integer('ownerId').notNullable()
    table.uuid('skillId').notNullable()
    table.integer('ordinal').notNullable()
    table.dateTime('selectedAt').notNullable()
  })
  await db.schema.createTable('agentRunTasks', table => {
    table.uuid('id').primary()
    table.uuid('runId').notNullable()
    table.uuid('parentTaskId').nullable()
    table.uuid('subagentRunId').nullable()
    table.integer('ordinal').notNullable()
    table.integer('depth').notNullable()
    table.string('kind').notNullable()
    table.string('title').notNullable()
    table.text('question').notNullable()
    table.text('sourceScope').notNullable()
    table.integer('requiredEvidenceCount').notNullable()
    table.boolean('required').notNullable()
    table.string('status').notNullable()
    table.string('outcome').nullable()
    table.integer('attempt').notNullable()
    table.integer('evidenceCount').notNullable()
    table.string('authoritySha256').nullable()
    table.string('resultSha256').nullable()
    table.text('result').nullable()
    table.string('errorCode').nullable()
    table.text('errorMessage').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('startedAt').nullable()
    table.dateTime('completedAt').nullable()
  })
}

const providerProfileInput: AgentProviderSettingsInput = {
  transportKind: 'openai-responses',
  model: 'gpt-test',
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
    dailyCostMicros: 1_000_000,
    reservationTokens: 100,
    reservationCostMicros: 100,
    reservationMilliseconds: 60_000,
    promptVersion: 1,
    maxAttempts: 3
  },
  pricingRevision: 'price-v1|1000000|2000000'
}

postgresAdmissionSuite('PostgreSQL agent admission authority', () => {
  let db: Knex
  let secondDb: Knex
  let registry: AgentProviderRegistry
  const secretRegistry = {
    has(reference: string): boolean {
      return reference === 'env:TEST_PROVIDER_KEY'
    },
    get(): null {
      return null
    },
    store(): never {
      throw new Error('managed secret is not used by this fixture')
    },
    delete(): boolean {
      return false
    }
  }
  const tokenKeys = { currentKeyId: 'primary', keys: { primary: 'postgres-admission-resolution-secret-012345678901234567890123' } }

  beforeAll(async () => {
    const admin = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`CREATE SCHEMA "${admissionSchema}"`)
    } finally {
      await admin.destroy()
    }
    db = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [admissionSchema], pool: { min: 0, max: 8 } })
    secondDb = knexModule({ client: 'pg', connection: connection ?? undefined, searchPath: [admissionSchema], pool: { min: 0, max: 4 } })
    await createAdmissionTables(db)
  })

  beforeEach(async () => {
    for (const table of [
      'agentRunTasks',
      'agentQuotaReservations',
      'agentQuotaDaily',
      'agentProposals',
      'agentRunSkills',
      'agentMessages',
      'agentEvents',
      'agentRuns',
      'agentUserSkillPreferences',
      'agentSkillGrants',
      'agentSkillVersions',
      'agentSkills',
      'agentSessions',
      'agentProviderGrants',
      'agentProviderProfileVersions',
      'agentProviderProfiles',
      'agentProviderConfiguration',
      'userGroups',
      'groups',
      'users'
    ])
      await db(table).delete()
    await db('users').insert([{ id: 7 }, { id: 8 }])
    await db('groups').insert([{ id: 1 }, { id: 2 }])
    await db('userGroups').insert({ userId: 7, groupId: 1 })
    await db('userGroups').insert({ userId: 8, groupId: 1 })
    registry = new AgentProviderRegistry(db, secretRegistry, tokenKeys)
  })

  afterAll(async () => {
    if (secondDb) await secondDb.destroy()
    if (db) await db.destroy()
    const admin = knexModule({ client: 'pg', connection: connection ?? undefined, pool: { min: 0, max: 1 } })
    try {
      await admin.raw(`DROP SCHEMA IF EXISTS "${admissionSchema}" CASCADE`)
    } finally {
      await admin.destroy()
    }
  })

  const createProvider = async (displayName: string, exposureMode: 'all_agent_users' | 'groups' = 'all_agent_users', groupIds: readonly number[] = []) => {
    const profile = await registry.create({ ...providerProfileInput, displayName, exposureMode, groupIds, actorId: 1 })
    const row = (await db('agentProviderProfiles').where({ id: profile.id }).first('currentVersionId')) as { currentVersionId: string }
    await registry.setConformed(profile.id, row.currentVersionId, true, 1)
    await registry.setEnabled(profile.id, true, 1, row.currentVersionId)
    return { profileId: profile.id, versionId: row.currentVersionId }
  }

  const createSkill = async (options: {
    readonly name: string
    readonly ownerUserId?: number | null
    readonly exposureMode?: 'all_agent_users' | 'groups'
    readonly grantGroups?: readonly number[]
    readonly status?: 'enabled' | 'disabled'
    readonly approvalStatus?: 'approved' | 'rejected'
    readonly staleCurrent?: boolean
  }): Promise<{ readonly skillId: string; readonly selectedVersionId: string; readonly currentVersionId: string }> => {
    const skillId = randomUUID()
    const selectedVersionId = randomUUID()
    const currentVersionId = options.staleCurrent ? randomUUID() : selectedVersionId
    const now = new Date()
    const ownerUserId = options.ownerUserId === undefined ? null : options.ownerUserId
    const exposureMode = options.exposureMode ?? 'all_agent_users'
    await db('agentSkills').insert({
      id: skillId,
      name: options.name,
      rootPageId: null,
      rootPath: `system/${options.name}`,
      assetFolderId: null,
      status: options.status ?? 'enabled',
      exposureMode,
      currentVersionId,
      isAgentDiscoverable: true,
      ownerUserId,
      deletedAt: null,
      createdBy: ownerUserId ?? 1,
      updatedBy: ownerUserId ?? 1,
      createdAt: now,
      updatedAt: now
    })
    const version = (id: string, versionNumber: number, contentHash: string) => ({
      id,
      skillId,
      sourceRevision: versionNumber,
      sourceUpdatedAt: now,
      sourceHistoryId: null,
      frontmatter: '{}',
      skillMarkdown: `# ${options.name} ${versionNumber}`,
      resourceBundle: Buffer.alloc(0),
      resourceManifest: '{}',
      contentHash,
      approvalStatus: options.approvalStatus ?? 'approved',
      approvedBy: 1,
      approvedAt: now,
      createdAt: now
    })
    await db('agentSkillVersions').insert([
      version(selectedVersionId, 1, 'a'.repeat(64)),
      ...(options.staleCurrent ? [version(currentVersionId, 2, 'b'.repeat(64))] : [])
    ])
    const grantGroups = options.grantGroups ?? []
    if (grantGroups.length > 0) await db('agentSkillGrants').insert(grantGroups.map(groupId => ({ skillId, groupId })))
    return { skillId, selectedVersionId, currentVersionId }
  }
  const createSession = async (providerProfileId: string | null, ownerId = 7): Promise<string> => {
    const id = randomUUID()
    const now = new Date()
    await db('agentSessions').insert({
      id,
      ownerId,
      title: 'Admission race',
      retention: 'saved',
      providerProfileId,
      executionMode: 'agent',
      version: 1,
      summary: null,
      summaryThroughOrdinal: null,
      memorySnapshot: '{"agent":[],"user":[]}',
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      expiresAt: null,
      deletedAt: null
    })
    return id
  }

  const createRuntime = (
    resolver: AgentProviderRegistry | { resolve: AgentProviderRegistry['resolve']; resolveCurrent: AgentProviderRegistry['resolveCurrent'] },
    observe?: (request: AgentEngineRequest) => void
  ) =>
    new AgentProductRuntime(
      db,
      resolver,
      {
        async execute(request, sink) {
          if (observe) observe(request)
          await sink.text('admitted')
          return { inputTokens: 1, outputTokens: 1, totalTokens: 2, costMicros: 2 }
        }
      },
      {
        workerId: `postgres-admission-${randomUUID()}`,
        globalConcurrency: 1,
        perUserConcurrency: 1,
        goals: { enabled: false, maxContinuations: 1, maxTokens: 1_000_000, maxToolCalls: 1_000, maxDurationMilliseconds: 60_000 }
      }
    )

  const durableCounts = async (): Promise<Record<string, number>> => {
    const names = ['agentMessages', 'agentRuns', 'agentRunSkills', 'agentQuotaReservations', 'agentEvents'] as const
    const values = await Promise.all(
      names.map(async name => {
        const row = (await db(name).count<{ count: number | string }[]>({ count: '*' }).first()) as { count: number | string }
        return [name, Number(row.count)] as const
      })
    )
    return Object.fromEntries(values)
  }

  const expectSubmitRejectedAfterProviderMutation = async (
    profileId: string | null,
    lockProfileIds: readonly string[],
    mutate: (transaction: Knex.Transaction) => Promise<void>
  ): Promise<void> => {
    const sessionId = await createSession(profileId)
    const token = await registry.issueResolutionToken(7, sessionId)
    const mutationReady = Promise.withResolvers<void>()
    const mutationRelease = Promise.withResolvers<void>()
    const mutation = secondDb.transaction(async transaction => {
      await transaction('agentProviderConfiguration').where({ id: 1 }).forUpdate().first()
      if (lockProfileIds.length > 0)
        await transaction('agentProviderProfiles')
          .whereIn('id', [...lockProfileIds].sort())
          .orderBy('id')
          .forUpdate()
          .select('id')
      await mutate(transaction)
      mutationReady.resolve()
      await mutationRelease.promise
    })
    await mutationReady.promise
    const runtime = createRuntime(registry)
    const rejected = runtime.submit({
      ownerId: 7,
      sessionId,
      profileResolutionToken: token,
      clientRequestId: randomUUID(),
      expectedSessionVersion: 1,
      content: 'provider mutation wins'
    })
    mutationRelease.resolve()
    await mutation
    await expect(rejected).rejects.toMatchObject({ code: 'PROFILE_RESOLUTION_CHANGED', status: 409 })
    expect(await durableCounts()).toEqual({ agentMessages: 0, agentRuns: 0, agentRunSkills: 0, agentQuotaReservations: 0, agentEvents: 0 })
    await runtime.shutdown()
  }
  it('linearizes provider disable against submit with admission-wins and revocation-wins outcomes', async () => {
    const provider = await createProvider('Disable race')
    const sessionId = await createSession(provider.profileId)
    const token = await registry.issueResolutionToken(7, sessionId)

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const resolver = {
      async resolve(transaction: Knex.Transaction, input: Parameters<AgentProviderRegistry['resolve']>[1]) {
        const resolved = await registry.resolve(transaction, input)
        entered.resolve()
        await release.promise
        return resolved
      },
      resolveCurrent: (transaction: Knex.Transaction, input: Parameters<AgentProviderRegistry['resolveCurrent']>[1]) =>
        registry.resolveCurrent(transaction, input)
    }
    const admissionRuntime = createRuntime(resolver)
    const admittedPromise = admissionRuntime.submit({
      ownerId: 7,
      sessionId,
      profileResolutionToken: token,
      clientRequestId: randomUUID(),
      expectedSessionVersion: 1,
      content: 'admission wins'
    })
    await entered.promise
    const revocation = secondDb.transaction(async transaction => {
      await transaction('agentProviderConfiguration').where({ id: 1 }).forUpdate().first()
      await transaction('agentProviderProfiles').where({ id: provider.profileId }).forUpdate().first()
      await transaction('agentProviderProfiles').where({ id: provider.profileId }).update({ status: 'disabled', isGlobalDefault: false, policyVersion: 3 })
    })
    release.resolve()
    const admitted = await admittedPromise
    await revocation
    expect(admitted.replayed).toBe(false)
    expect(await db('agentRuns').where({ id: admitted.run.id }).first('status', 'providerProfileVersionId')).toEqual({
      status: 'queued',
      providerProfileVersionId: provider.versionId
    })
    expect(await durableCounts()).toEqual({ agentMessages: 2, agentRuns: 1, agentRunSkills: 0, agentQuotaReservations: 1, agentEvents: 1 })
    await admissionRuntime.shutdown()

    const revocationProvider = await createProvider('Disable rejection')
    const revocationSessionId = await createSession(revocationProvider.profileId)
    const revocationToken = await registry.issueResolutionToken(7, revocationSessionId)
    const mutationReady = Promise.withResolvers<void>()
    const mutationRelease = Promise.withResolvers<void>()
    const heldRevocation = secondDb.transaction(async transaction => {
      await transaction('agentProviderConfiguration').where({ id: 1 }).forUpdate().first()
      await transaction('agentProviderProfiles').where({ id: revocationProvider.profileId }).forUpdate().first()
      await transaction('agentProviderProfiles')
        .where({ id: revocationProvider.profileId })
        .update({ status: 'disabled', isGlobalDefault: false, policyVersion: 3 })
      mutationReady.resolve()
      await mutationRelease.promise
    })
    await mutationReady.promise
    const rejectionRuntime = createRuntime(registry)
    const rejectedSubmission = rejectionRuntime.submit({
      ownerId: 7,
      sessionId: revocationSessionId,
      profileResolutionToken: revocationToken,
      clientRequestId: randomUUID(),
      expectedSessionVersion: 1,
      content: 'revocation wins'
    })
    mutationRelease.resolve()
    await heldRevocation
    await expect(rejectedSubmission).rejects.toMatchObject({ code: 'PROFILE_RESOLUTION_CHANGED', status: 409 })
    expect(await durableCounts()).toEqual({ agentMessages: 2, agentRuns: 1, agentRunSkills: 0, agentQuotaReservations: 1, agentEvents: 1 })
    await rejectionRuntime.shutdown()
  })

  it('rejects a submit when the implicit provider default changes before admission commits', async () => {
    const first = await createProvider('Default first')
    const second = await createProvider('Default second')
    const sessionId = await createSession(null)
    const token = await registry.issueResolutionToken(7, sessionId)
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const mutation = secondDb.transaction(async transaction => {
      await transaction('agentProviderConfiguration').where({ id: 1 }).forUpdate().first()
      await transaction('agentProviderProfiles').whereIn('id', [first.profileId, second.profileId].sort()).orderBy('id').forUpdate().select('id')
      await transaction('agentProviderProfiles').where({ id: first.profileId }).update({ isGlobalDefault: false, policyVersion: 3 })
      await transaction('agentProviderProfiles').where({ id: second.profileId }).update({ isGlobalDefault: true, policyVersion: 2 })
      await transaction('agentProviderConfiguration')
        .where({ id: 1 })
        .update({ defaultGeneration: transaction.raw('?? + 1', ['defaultGeneration']) })
      ready.resolve()
      await release.promise
    })
    await ready.promise
    const runtime = createRuntime(registry)
    const rejected = runtime.submit({
      ownerId: 7,
      sessionId,
      profileResolutionToken: token,
      clientRequestId: randomUUID(),
      expectedSessionVersion: 1,
      content: 'default mutation wins'
    })
    release.resolve()
    await mutation
    await expect(rejected).rejects.toMatchObject({ code: 'PROFILE_RESOLUTION_CHANGED', status: 409 })
    expect(await durableCounts()).toEqual({ agentMessages: 0, agentRuns: 0, agentRunSkills: 0, agentQuotaReservations: 0, agentEvents: 0 })
    await runtime.shutdown()
  })

  it('rejects a submit when the provider current version changes before admission commits', async () => {
    const provider = await createProvider('Current version race')
    const sessionId = await createSession(provider.profileId)
    const token = await registry.issueResolutionToken(7, sessionId)
    const current = await db('agentProviderProfileVersions').where({ id: provider.versionId }).first()
    if (!current) throw new Error('provider fixture version missing')
    const replacementVersionId = randomUUID()
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const mutation = secondDb.transaction(async transaction => {
      await transaction('agentProviderConfiguration').where({ id: 1 }).forUpdate().first()
      await transaction('agentProviderProfiles').where({ id: provider.profileId }).forUpdate().first()
      await transaction('agentProviderProfileVersions').insert({
        ...current,
        id: replacementVersionId,
        version: Number(current.version) + 1,
        model: 'gpt-replaced'
      })
      await transaction('agentProviderProfiles')
        .where({ id: provider.profileId })
        .update({ currentVersionId: replacementVersionId, status: 'disabled', conformed: false, policyVersion: 3 })
      ready.resolve()
      await release.promise
    })
    await ready.promise
    const runtime = createRuntime(registry)
    const rejected = runtime.submit({
      ownerId: 7,
      sessionId,
      profileResolutionToken: token,
      clientRequestId: randomUUID(),
      expectedSessionVersion: 1,
      content: 'current version mutation wins'
    })
    release.resolve()
    await mutation
    await expect(rejected).rejects.toMatchObject({ code: 'PROFILE_RESOLUTION_CHANGED', status: 409 })
    expect(await durableCounts()).toEqual({ agentMessages: 0, agentRuns: 0, agentRunSkills: 0, agentQuotaReservations: 0, agentEvents: 0 })
    await runtime.shutdown()
  })

  it('rejects a submit when provider grants are revoked before admission commits', async () => {
    const provider = await createProvider('Grant race', 'groups', [1])
    await expectSubmitRejectedAfterProviderMutation(provider.profileId, [provider.profileId], async transaction => {
      await transaction('agentProviderGrants').where({ profileId: provider.profileId }).delete()
      await transaction('agentProviderProfiles').where({ id: provider.profileId }).update({ exposureMode: 'groups', policyVersion: 4 })
    })
  })

  it('rejects foreign, disabled, deleted, rejected, and stale selected skills before durable admission', async () => {
    const provider = await createProvider('Skill admission provider')
    const cases: readonly {
      readonly name: string
      readonly options: Parameters<typeof createSkill>[0]
      readonly deleteCurrent?: boolean
      readonly preferred?: boolean
    }[] = [
      { name: 'foreign owner', options: { name: 'foreign-owner', ownerUserId: 8 }, preferred: true },
      { name: 'foreign group', options: { name: 'foreign-group', exposureMode: 'groups', grantGroups: [2] } },
      { name: 'disabled', options: { name: 'disabled-skill', status: 'disabled' } },
      { name: 'deleted', options: { name: 'deleted-skill' }, deleteCurrent: true },
      { name: 'rejected current version', options: { name: 'rejected-skill', approvalStatus: 'rejected' } },
      { name: 'stale current version', options: { name: 'stale-current', staleCurrent: true } }
    ]
    for (const testCase of cases) {
      const skill = await createSkill(testCase.options)
      if (testCase.deleteCurrent) await db('agentSkills').where({ id: skill.skillId }).update({ deletedAt: new Date() })
      if (testCase.preferred) await db('agentUserSkillPreferences').insert({ ownerId: 7, skillId: skill.skillId, ordinal: 0, selectedAt: new Date() })
      const sessionId = await createSession(provider.profileId)
      const token = await registry.issueResolutionToken(7, sessionId)
      const runtime = createRuntime(registry)
      await expect(
        runtime.submit({
          ownerId: 7,
          sessionId,
          profileResolutionToken: token,
          clientRequestId: randomUUID(),
          expectedSessionVersion: 1,
          content: `direct runtime ${testCase.name}`,
          invokedSkillVersionIds: [skill.selectedVersionId]
        })
      ).rejects.toMatchObject({ code: 'INVALID_SKILL' })
      expect(await durableCounts()).toEqual({ agentMessages: 0, agentRuns: 0, agentRunSkills: 0, agentQuotaReservations: 0, agentEvents: 0 })
      await runtime.shutdown()
    }
  })

  it('omits unavailable preferences while admitting a direct runtime request', async () => {
    const provider = await createProvider('Preference omission provider')
    const unavailable = await createSkill({ name: 'unavailable-preference', ownerUserId: 8 })
    await db('agentUserSkillPreferences').insert({ ownerId: 7, skillId: unavailable.skillId, ordinal: 0, selectedAt: new Date() })
    const sessionId = await createSession(provider.profileId)
    const token = await registry.issueResolutionToken(7, sessionId)
    let observedSkillIds: readonly string[] = []
    const runtime = createRuntime(registry, request => {
      observedSkillIds = request.skills.map(skill => skill.id)
    })
    const admitted = await runtime.submit({
      ownerId: 7,
      sessionId,
      profileResolutionToken: token,
      clientRequestId: randomUUID(),
      expectedSessionVersion: 1,
      content: 'omit unavailable preferences'
    })
    expect(await runtime.runOnce()).toBe(true)
    expect(admitted.replayed).toBe(false)
    expect(observedSkillIds).toEqual([])
    expect(await db('agentRunSkills').where({ runId: admitted.run.id })).toEqual([])
    await runtime.shutdown()
  })

  it('validates explicit skills before preferred-skill deduplication inside the transaction', async () => {
    const provider = await createProvider('Skill validation order provider')
    const inaccessible = await createSkill({ name: 'inaccessible-explicit', ownerUserId: 8 })
    await db('agentUserSkillPreferences').insert({ ownerId: 7, skillId: inaccessible.skillId, ordinal: 0, selectedAt: new Date() })
    const sessionId = await createSession(provider.profileId)
    const token = await registry.issueResolutionToken(7, sessionId)
    const runtime = createRuntime(registry)
    await expect(
      runtime.submit({
        ownerId: 7,
        sessionId,
        profileResolutionToken: token,
        clientRequestId: randomUUID(),
        expectedSessionVersion: 1,
        content: 'explicit inaccessible skill',
        invokedSkillVersionIds: [inaccessible.selectedVersionId]
      })
    ).rejects.toMatchObject({ code: 'INVALID_SKILL' })
    expect(await durableCounts()).toEqual({ agentMessages: 0, agentRuns: 0, agentRunSkills: 0, agentQuotaReservations: 0, agentEvents: 0 })
    await runtime.shutdown()
  })
})
