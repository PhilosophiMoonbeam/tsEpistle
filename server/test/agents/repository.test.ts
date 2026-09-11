import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'
import {
  appendAgentEvent,
  appendAgentMessage,
  createAgentConversationFolder,
  createAgentSession,
  deleteAgentConversationFolder,
  getOwnedAgentArtifact,
  getOwnedAgentSession,
  listOwnedAgentEvents,
  listOwnedAgentSessions,
  renameAgentConversationFolder,
  storeAgentScreenshot,
  updateAgentSession
} from '../../agents/repository.ts'
import { projectAgentThread, reduceAgentEvents } from '../../agents/projection.ts'
import {
  AgentRunCoordinator,
  AgentQuotaSettlementError,
  admitAgentRun,
  claimAgentRun,
  heartbeatAgentRun,
  markAgentRunSideEffectsStarted,
  ensureAgentRunQuota,
  persistAgentRunQuotaSettlementIntent,
  reconcileAgentRunQuota,
  requestAgentRunCancellation,
  reserveAgentRunQuota,
  terminalizeAgentRun,
  transitionAgentRun
} from '../../agents/coordinator.ts'
import { AgentProductRuntime, type AgentAdmissionResolver, type AgentEngine } from '../../agents/runtime.ts'
import { DEFAULT_AGENT_ORCHESTRATION_LIMITS } from '../../agents/orchestration.ts'
import { up as addAgentTaskLedger } from '../../db/migrations/2.5.156.ts'
import type { AgentEvent } from '../../../shared/agents/contracts.ts'
import { agentConversationFolderNameKey, cleanAgentConversationFolderName } from '../../../shared/agents/conversation-folders.ts'

const sessionId = '00000000-0000-4000-8000-000000000001'
const runId = '00000000-0000-4000-8000-000000000002'
const userMessageId = '00000000-0000-4000-8000-000000000003'
const assistantMessageId = '00000000-0000-4000-8000-000000000004'
type AdmissionResolverInput = Parameters<AgentAdmissionResolver['resolve']>[1]
type CurrentAdmissionResolverInput = Parameters<AgentAdmissionResolver['resolveCurrent']>[1]

const createTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('users', table => {
    table.integer('id').primary()
  })
  await knex.schema.createTable('agentSessions', table => {
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
  })
  await knex.schema.createTable('agentQuotaDaily', table => {
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
}

const insertRun = async (knex: Knex): Promise<void> => {
  const now = new Date('2026-08-17T00:00:00.000Z')
  await knex('agentRuns').insert({
    id: runId,
    sessionId,
    userMessageId,
    assistantMessageId,
    ownerId: 7,
    clientRequestId: '00000000-0000-4000-8000-000000000005',
    clientRequestSha256: 'a'.repeat(64),
    profileResolutionSha256: 'b'.repeat(64),
    status: 'running',
    attempts: 1,
    maxAttempts: 3,
    eventSequence: 0,
    availableAt: now,
    leaseOwner: 'worker-a',
    leaseToken: '00000000-0000-4000-8000-000000000006',
    leaseExpiresAt: new Date('2026-08-17T00:01:00.000Z'),
    cancelRequestedAt: null,
    sideEffectsStarted: false,
    providerProfileVersionId: '00000000-0000-4000-8000-000000000007',
    transportKind: 'openai-responses',
    model: 'test',
    executionMode: 'agent',
    profilePolicyVersion: 1,
    defaultGeneration: 1,
    capabilityRevision: 'v1',
    pricingRevision: 'v1',
    promptVersion: 1,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostMicros: null,
    errorMessage: null,
    queuedAt: now,
    startedAt: now,
    updatedAt: now,
    completedAt: null
  })
}

describe('durable agent repositories', () => {
  let knex: Knex

  beforeEach(async () => {
    knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    await createTables(knex)
    await knex('users').insert([{ id: 7 }, { id: 8 }, { id: 9 }])
    await knex('groups').insert([{ id: 1 }])
    await createAgentSession(knex, { id: sessionId, ownerId: 7, title: 'Thread', retention: 'saved', providerProfileId: null, executionMode: 'agent' })
    await appendAgentMessage(knex, { id: userMessageId, ownerId: 7, sessionId, role: 'user', status: 'complete', content: 'Question' })
    await appendAgentMessage(knex, { id: assistantMessageId, ownerId: 7, sessionId, role: 'assistant', status: 'streaming', content: '' })
    await insertRun(knex)
    await knex('agentProviderProfileVersions').insert({
      id: '00000000-0000-4000-8000-000000000007',
      policies: JSON.stringify({
        allowedModes: ['agent'],
        dailyTokens: 1_000,
        dailyCostMicros: 1_000,
        reservationTokens: 100,
        reservationCostMicros: 100,
        reservationMilliseconds: 60_000,
        promptVersion: 1,
        maxAttempts: 3
      })
    })
    await knex('agentMessages').whereIn('id', [userMessageId, assistantMessageId]).update({ runId })
  })

  afterEach(async () => knex.destroy())

  it('isolates owners and enforces optimistic session versions', async () => {
    await expect(Promise.resolve(getOwnedAgentSession(knex, 8, sessionId))).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND', status: 404 })
    const updated = await updateAgentSession(knex, { ownerId: 7, sessionId, expectedVersion: 1, title: 'Renamed' })
    expect(updated).toMatchObject({ title: 'Renamed', version: 2 })
    expect(await knex('agentSessions').where({ id: sessionId }).first('titleSource')).toEqual({ titleSource: 'manual' })
    await expect(Promise.resolve(updateAgentSession(knex, { ownerId: 7, sessionId, expectedVersion: 1, title: 'Lost race' }))).rejects.toMatchObject({
      code: 'SESSION_VERSION_CHANGED',
      status: 409
    })
  })
  it('canonicalizes conversation folder names before enforcing owner-local uniqueness', async () => {
    const cleanName = cleanAgentConversationFolderName('  Ｆｏｌｄ\u00a0\tName  ')
    expect(cleanName).toBe('Fold Name')
    expect(agentConversationFolderNameKey(cleanName)).toBe('fold name')

    const folder = await createAgentConversationFolder(knex, 7, '  Ｆｏｌｄ\u00a0\tName  ')
    expect(folder).toMatchObject({ name: cleanName })
    expect(await knex('agentConversationFolders').where({ id: folder.id }).first('normalizedName')).toEqual({ normalizedName: 'fold name' })
    await expect(createAgentConversationFolder(knex, 7, 'fold name')).rejects.toMatchObject({ code: 'CONVERSATION_FOLDER_EXISTS', status: 409 })
    await expect(createAgentConversationFolder(knex, 8, 'fold name')).resolves.toMatchObject({ ownerId: 8, name: 'fold name' })
    await expect(createAgentConversationFolder(knex, 99, 'Other')).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND', status: 404 })
  })
  it('deletes conversation folders with optimistic versions and moves contained sessions atomically', async () => {
    const folder = await createAgentConversationFolder(knex, 7, 'Archive')
    await knex('agentSessions')
      .where({ id: sessionId })
      .update({
        folderId: folder.id,
        retention: 'temporary',
        expiresAt: new Date('2099-01-01T00:00:00.000Z')
      })
    await expect(deleteAgentConversationFolder(knex, 8, folder.id, 1)).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND', status: 404 })

    await renameAgentConversationFolder(knex, 7, folder.id, 1, 'Renamed')
    const beforeStaleSession = await knex('agentSessions').where({ id: sessionId }).first('folderId', 'retention', 'expiresAt', 'version')
    await expect(deleteAgentConversationFolder(knex, 7, folder.id, 1)).rejects.toMatchObject({
      code: 'CONVERSATION_FOLDER_VERSION_CHANGED',
      status: 409
    })
    expect(await knex('agentConversationFolders').where({ id: folder.id }).first('name', 'version')).toEqual({ name: 'Renamed', version: 2 })
    expect(await knex('agentSessions').where({ id: sessionId }).first('folderId', 'retention', 'expiresAt', 'version')).toEqual(beforeStaleSession)

    expect(await deleteAgentConversationFolder(knex, 7, folder.id, 2)).toBe(1)
    expect(await knex('agentConversationFolders').where({ id: folder.id }).first()).toBeUndefined()
    expect(await knex('agentSessions').where({ id: sessionId }).first('folderId', 'retention', 'expiresAt', 'version')).toMatchObject({
      folderId: null,
      retention: 'saved',
      expiresAt: null,
      version: 2
    })
  })

  it('rolls back contained session updates when the final folder compare-and-delete misses', async () => {
    const folder = await createAgentConversationFolder(knex, 7, 'Rollback')
    await knex('agentSessions')
      .where({ id: sessionId })
      .update({
        folderId: folder.id,
        retention: 'temporary',
        expiresAt: new Date('2099-01-01T00:00:00.000Z')
      })
    const beforeFolder = await knex('agentConversationFolders').where({ id: folder.id }).first('name', 'version')
    const beforeSession = await knex('agentSessions').where({ id: sessionId }).first('folderId', 'retention', 'expiresAt', 'version')
    await knex.raw(`
      CREATE TRIGGER folder_delete_cas_race
      AFTER UPDATE OF folderId ON agentSessions
      WHEN OLD.folderId = '${folder.id}' AND NEW.folderId IS NULL
      BEGIN
        UPDATE agentConversationFolders SET version = version + 1 WHERE id = '${folder.id}';
      END
    `)

    await expect(deleteAgentConversationFolder(knex, 7, folder.id, 1)).rejects.toMatchObject({
      code: 'CONVERSATION_FOLDER_VERSION_CHANGED',
      status: 409
    })
    expect(await knex('agentConversationFolders').where({ id: folder.id }).first('name', 'version')).toEqual(beforeFolder)
    expect(await knex('agentSessions').where({ id: sessionId }).first('folderId', 'retention', 'expiresAt', 'version')).toEqual(beforeSession)
  })

  it('lists only conversations that contain a completed user message', async () => {
    const emptySessionId = '00000000-0000-4000-8000-000000000098'
    await createAgentSession(knex, { id: emptySessionId, ownerId: 7, retention: 'saved', providerProfileId: null, executionMode: 'agent' })
    expect(await listOwnedAgentSessions(knex, 7)).toMatchObject([{ id: sessionId }])

    await appendAgentMessage(knex, { ownerId: 7, sessionId: emptySessionId, role: 'user', status: 'complete', content: 'Now this is a conversation.' })
    expect(await listOwnedAgentSessions(knex, 7)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: emptySessionId }), expect.objectContaining({ id: sessionId })])
    )
  })

  it('excludes temporary chats before limiting history and lists them after they are kept', async () => {
    const temporaryId = '00000000-0000-4000-8000-000000000099'
    await createAgentSession(knex, {
      id: temporaryId,
      ownerId: 7,
      retention: 'temporary',
      providerProfileId: null,
      executionMode: 'agent',
      expiresAt: new Date('2099-01-01T00:00:00Z')
    })
    await appendAgentMessage(knex, { ownerId: 7, sessionId: temporaryId, role: 'user', status: 'complete', content: 'A temporary question.' })
    await knex('agentSessions')
      .where({ id: temporaryId })
      .update({ lastActivityAt: new Date('2098-01-01T00:00:00Z') })

    expect((await listOwnedAgentSessions(knex, 7, 1)).map(session => session.id)).toEqual([sessionId])
    expect(await getOwnedAgentSession(knex, 7, temporaryId)).toMatchObject({ retention: 'temporary' })
    await expect(getOwnedAgentSession(knex, 8, temporaryId)).rejects.toMatchObject({ status: 404 })

    await updateAgentSession(knex, { ownerId: 7, sessionId: temporaryId, expectedVersion: 1, retention: 'saved', expiresAt: null })
    expect((await listOwnedAgentSessions(knex, 7, 1)).map(session => session.id)).toEqual([temporaryId])
    expect(await getOwnedAgentSession(knex, 7, temporaryId)).toMatchObject({ retention: 'saved', expiresAt: null })
  })

  it('preserves visibility for a legacy temporary conversation explicitly kept in a folder', async () => {
    await knex('agentSessions').where({ id: sessionId }).update({ retention: 'temporary', folderId: '00000000-0000-4000-8000-000000000088' })
    expect((await listOwnedAgentSessions(knex, 7)).map(session => session.id)).toEqual([sessionId])
  })

  it('persists bounded immutable memory snapshots at session creation', async () => {
    const snapshotSessionId = '00000000-0000-4000-8000-000000000005'
    const memorySnapshot = '{"agent":["Use citations."],"user":["Prefers concise answers."]}'
    await createAgentSession(knex, {
      id: snapshotSessionId,
      ownerId: 7,
      retention: 'saved',
      providerProfileId: null,
      executionMode: 'agent',
      memorySnapshot
    })
    expect(await knex('agentSessions').where({ id: snapshotSessionId }).first('memorySnapshot')).toMatchObject({ memorySnapshot })
    await expect(
      Promise.resolve(
        createAgentSession(knex, {
          id: '00000000-0000-4000-8000-000000000006',
          ownerId: 7,
          retention: 'saved',
          providerProfileId: null,
          executionMode: 'agent',
          memorySnapshot: 'x'.repeat(16_385)
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_AGENT_MEMORY', status: 400 })
  })

  it('appends contiguous hash-verified events and makes exact IDs idempotent', async () => {
    const eventInput = {
      id: '00000000-0000-4000-8000-000000000010',
      runId,
      ownerId: 7,
      type: 'tool.started' as const,
      attempt: 1,
      data: { actionCallId: 'call-1', actionName: 'pages.get', title: 'Read page', risk: 'read' }
    }
    const first = await appendAgentEvent(knex, eventInput)
    const replay = await appendAgentEvent(knex, eventInput)
    expect(replay).toEqual(first)
    await expect(Promise.resolve(appendAgentEvent(knex, { ...eventInput, data: { ...eventInput.data, title: 'Changed' } }))).rejects.toMatchObject({
      code: 'AGENT_EVENT_IDEMPOTENCY_MISMATCH',
      status: 409
    })
    await appendAgentEvent(knex, {
      id: '00000000-0000-4000-8000-000000000011',
      runId,
      ownerId: 7,
      type: 'tool.completed',
      attempt: 1,
      data: { actionCallId: 'call-1', summary: 'Done' }
    })
    await appendAgentEvent(knex, {
      id: '00000000-0000-4000-8000-000000000012',
      runId,
      ownerId: 7,
      type: 'evidence.provenance',
      attempt: 1,
      data: {
        accepted: true,
        retrievals: [{ actionCallId: 'call-1', actionName: 'pages.get', evidenceIds: ['page:42', 'page:42:section:1'] }],
        claims: [
          {
            claim: 'Install the package.',
            evidenceId: 'page:42:section:1',
            pageEvidenceId: 'page:42',
            sourceActionCallId: 'call-1',
            sourceActionName: 'pages.get',
            section: true,
            supported: true,
            matchedTerms: ['install', 'package']
          }
        ],
        finalCitationIds: ['page:42:section:1']
      }
    })
    const events = await listOwnedAgentEvents(knex, 7, runId)
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3])
    expect(events[2]).toMatchObject({
      type: 'evidence.provenance',
      data: {
        accepted: true,
        retrievals: [{ actionCallId: 'call-1', actionName: 'pages.get', evidenceIds: ['page:42', 'page:42:section:1'] }],
        claims: [expect.objectContaining({ evidenceId: 'page:42:section:1', sourceActionCallId: 'call-1', section: true, supported: true })],
        finalCitationIds: ['page:42:section:1']
      }
    })
    await knex('agentEvents').where({ id: eventInput.id }).update({ data: '{}' })
    await expect(Promise.resolve(listOwnedAgentEvents(knex, 7, runId))).rejects.toMatchObject({ code: 'AGENT_EVENT_CORRUPT', status: 500 })
  })

  it('integrity-checks owner-scoped artifact payloads', async () => {
    const payload = Buffer.from('89504e470d0a1a0a00', 'hex')
    const id = await storeAgentScreenshot(knex, { ownerId: 7, sessionId, runId, payload, width: 1, height: 1 })
    await expect(Promise.resolve(getOwnedAgentArtifact(knex, 8, id))).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND' })
    expect(await getOwnedAgentArtifact(knex, 7, id)).toMatchObject({ id, byteLength: payload.length, mimeType: 'image/png' })
    await knex('agentArtifacts')
      .where({ id })
      .update({ payload: Buffer.from('89504e470d0a1a0aff', 'hex') })
    await expect(Promise.resolve(getOwnedAgentArtifact(knex, 7, id))).rejects.toMatchObject({ code: 'AGENT_ARTIFACT_CORRUPT' })
  })

  it('projects the same terminal tool state from durable events', async () => {
    await appendAgentEvent(knex, {
      id: '00000000-0000-4000-8000-000000000020',
      runId,
      ownerId: 7,
      type: 'tool.started',
      attempt: 1,
      data: { actionCallId: 'call-1', actionName: 'pages.get', title: 'Read page', risk: 'read' }
    })
    await appendAgentEvent(knex, {
      id: '00000000-0000-4000-8000-000000000021',
      runId,
      ownerId: 7,
      type: 'tool.completed',
      attempt: 1,
      data: { actionCallId: 'call-1', summary: 'Read one page' }
    })
    await appendAgentEvent(knex, {
      id: '00000000-0000-4000-8000-000000000022',
      runId,
      ownerId: 7,
      type: 'suggestions.updated',
      attempt: 1,
      data: { suggestions: [{ id: 'next', label: 'Continue', prompt: 'Continue' }] }
    })
    const events = await listOwnedAgentEvents(knex, 7, runId)
    const reduced = reduceAgentEvents(events, runId)
    const projected = await projectAgentThread(knex, 7, sessionId, {
      profileResolutionToken: session => `profile:${session.id}:${session.version}`,
      now: new Date('2026-08-17T00:00:00.000Z')
    })
    expect(projected.tools).toEqual(reduced.tools)
    expect(projected.suggestions).toEqual(reduced.suggestions)
    expect(projected.session.currentRun).toMatchObject({ id: runId, eventSequence: 3, canCancel: true })
    expect(projected.messages.map(message => message.content)).toEqual(['Question', ''])
  })

  it('reduces each run to its latest attempt while keeping suggestions from the latest run', () => {
    const runA = '00000000-0000-4000-8000-000000000071'
    const runB = '00000000-0000-4000-8000-000000000072'
    const events: AgentEvent[] = [
      {
        id: 'b-1',
        runId: runB,
        sequence: 1,
        type: 'tool.started',
        attempt: 1,
        schemaVersion: 1,
        data: { actionCallId: 'call-b', actionName: 'pages.get', title: 'Latest run read', risk: 'read' },
        createdAt: '2026-08-17T00:02:00.000Z'
      },
      {
        id: 'b-2',
        runId: runB,
        sequence: 2,
        type: 'tool.completed',
        attempt: 1,
        schemaVersion: 1,
        data: { actionCallId: 'call-b', summary: 'Latest run result' },
        createdAt: '2026-08-17T00:02:01.000Z'
      },
      {
        id: 'b-3',
        runId: runB,
        sequence: 3,
        type: 'suggestions.updated',
        attempt: 1,
        schemaVersion: 1,
        data: { suggestions: [{ id: 'run-b-next', label: 'Use latest run', prompt: 'Continue from run B' }] },
        createdAt: '2026-08-17T00:02:02.000Z'
      },
      {
        id: 'a-1',
        runId: runA,
        sequence: 1,
        type: 'tool.started',
        attempt: 1,
        schemaVersion: 1,
        data: { actionCallId: 'call-a-stale', actionName: 'pages.get', title: 'Stale read', risk: 'read' },
        createdAt: '2026-08-17T00:00:00.000Z'
      },
      {
        id: 'a-2',
        runId: runA,
        sequence: 2,
        type: 'tool.completed',
        attempt: 1,
        schemaVersion: 1,
        data: { actionCallId: 'call-a-stale', summary: 'Stale result' },
        createdAt: '2026-08-17T00:00:01.000Z'
      },
      {
        id: 'a-3',
        runId: runA,
        sequence: 3,
        type: 'suggestions.updated',
        attempt: 1,
        schemaVersion: 1,
        data: { suggestions: [{ id: 'stale', label: 'Stale', prompt: 'Ignore attempt one' }] },
        createdAt: '2026-08-17T00:00:02.000Z'
      },
      {
        id: 'a-4',
        runId: runA,
        sequence: 4,
        type: 'tool.started',
        attempt: 2,
        schemaVersion: 1,
        data: { actionCallId: 'call-a-current', actionName: 'pages.search', title: 'Retried search', risk: 'read' },
        createdAt: '2026-08-17T00:01:00.000Z'
      },
      {
        id: 'a-5',
        runId: runA,
        sequence: 5,
        type: 'tool.completed',
        attempt: 2,
        schemaVersion: 1,
        data: { actionCallId: 'call-a-current', summary: 'Retried result' },
        createdAt: '2026-08-17T00:01:01.000Z'
      },
      {
        id: 'a-6',
        runId: runA,
        sequence: 6,
        type: 'suggestions.updated',
        attempt: 2,
        schemaVersion: 1,
        data: { suggestions: [{ id: 'run-a-next', label: 'Older run', prompt: 'Continue from run A' }] },
        createdAt: '2026-08-17T00:01:02.000Z'
      }
    ]

    const reduced = reduceAgentEvents(events, runB)

    expect(reduced.tools.map(tool => ({ id: tool.id, runId: tool.runId, summary: tool.summary }))).toEqual([
      { id: 'call-b', runId: runB, summary: 'Latest run result' },
      { id: 'call-a-current', runId: runA, summary: 'Retried result' }
    ])
    expect(reduced.suggestions).toEqual([{ id: 'run-b-next', label: 'Use latest run', prompt: 'Continue from run B' }])
  })
  it('replays visible action and discovery activity through terminal projection boundaries', () => {
    const projectionRunId = '00000000-0000-4000-8000-000000000073'
    let sequence = 0
    const event = (type: AgentEvent['type'], data: AgentEvent['data']): AgentEvent => ({
      id: `projection-${++sequence}`,
      runId: projectionRunId,
      sequence,
      type,
      attempt: 1,
      schemaVersion: 1,
      data,
      createdAt: `2026-08-17T00:0${Math.floor(sequence / 10)}:${String(sequence % 60).padStart(2, '0')}.000Z`
    })
    const calls = [
      {
        id: 'enable-explore',
        actionName: 'wiki_enable_tools',
        title: 'Enable Wiki tool category',
        start: event('tool.started', {
          actionCallId: 'enable-explore',
          actionName: 'wiki_enable_tools',
          title: 'Enable Wiki tool category',
          risk: 'read',
          input: '{"category":"explore"}'
        }),
        terminal: event('tool.completed', {
          actionCallId: 'enable-explore',
          actionName: 'wiki_enable_tools',
          result: JSON.stringify({ category: 'explore', enabled: true, tools: [{ name: 'pages.searchTags', description: 'Search visible tags' }] }),
          summary: 'Enabled explore tools for the next turn'
        })
      },
      {
        id: 'malformed-input',
        actionName: 'pages.searchTags',
        title: 'Search tags',
        start: event('tool.started', {
          actionCallId: 'malformed-input',
          actionName: 'pages.searchTags',
          title: 'Search tags',
          risk: 'read',
          input: '{"query":'
        }),
        terminal: event('tool.failed', { actionCallId: 'malformed-input', actionName: 'pages.searchTags', errorCode: 'INVALID_ACTION_INPUT' })
      },
      {
        id: 'budget-skipped',
        actionName: 'pages.get',
        title: 'Read page',
        start: event('tool.started', {
          actionCallId: 'budget-skipped',
          actionName: 'pages.get',
          title: 'Read page',
          risk: 'read',
          input: '{"id":42}'
        }),
        terminal: event('tool.failed', { actionCallId: 'budget-skipped', actionName: 'pages.get', errorCode: 'AGENT_BUDGET_LIMITED' })
      },
      {
        id: 'capacity-skipped',
        actionName: 'pages.getVersion',
        title: 'Read page version',
        start: event('tool.started', {
          actionCallId: 'capacity-skipped',
          actionName: 'pages.getVersion',
          title: 'Read page version',
          risk: 'read',
          input: '{"id":42,"version":3}'
        }),
        terminal: event('tool.failed', { actionCallId: 'capacity-skipped', actionName: 'pages.getVersion', errorCode: 'AGENT_CONTEXT_TOO_LARGE' })
      },
      {
        id: 'live-denied',
        actionName: 'pages.search',
        title: 'Search pages',
        start: event('tool.started', {
          actionCallId: 'live-denied',
          actionName: 'pages.search',
          title: 'Search pages',
          risk: 'read',
          input: '{"query":"secret"}'
        }),
        terminal: event('tool.failed', { actionCallId: 'live-denied', actionName: 'pages.search', errorCode: 'ACTION_NOT_OFFERED' })
      },
      {
        id: 'completed-provider-omitted',
        actionName: 'pages.get',
        title: 'Read page',
        start: event('tool.started', {
          actionCallId: 'completed-provider-omitted',
          actionName: 'pages.get',
          title: 'Read page',
          risk: 'read',
          input: '{"id":99}'
        }),
        terminal: event('tool.completed', {
          actionCallId: 'completed-provider-omitted',
          actionName: 'pages.get',
          result: JSON.stringify({ id: 99, title: 'Release notes', content: 'The provider result was omitted from synthesis capacity.' }),
          summary: 'Release notes'
        })
      }
    ]
    const events = calls.flatMap(call => [call.start, call.terminal])
    const reduced = reduceAgentEvents(events, projectionRunId)

    expect(events.filter(event => event.type === 'tool.started')).toHaveLength(calls.length)
    expect(events.filter(event => event.type === 'tool.completed' || event.type === 'tool.failed')).toHaveLength(calls.length)
    expect(reduced.tools).toHaveLength(calls.length)
    expect(reduced.tools.every(tool => tool.startedAt !== null && tool.completedAt !== null && ['complete', 'failed'].includes(tool.state))).toBe(true)
    expect(reduced.tools.map(tool => ({ id: tool.id, actionName: tool.actionName, title: tool.title, state: tool.state, summary: tool.summary }))).toEqual([
      {
        id: 'enable-explore',
        actionName: 'wiki_enable_tools',
        title: 'Enable Wiki tool category',
        state: 'complete',
        summary: 'Enabled explore tools for the next turn'
      },
      { id: 'malformed-input', actionName: 'pages.searchTags', title: 'Search tags', state: 'failed', summary: null },
      { id: 'budget-skipped', actionName: 'pages.get', title: 'Read page', state: 'failed', summary: null },
      { id: 'capacity-skipped', actionName: 'pages.getVersion', title: 'Read page version', state: 'failed', summary: null },
      { id: 'live-denied', actionName: 'pages.search', title: 'Search pages', state: 'failed', summary: null },
      { id: 'completed-provider-omitted', actionName: 'pages.get', title: 'Read page', state: 'complete', summary: 'Release notes' }
    ])
  })

  it('fails closed for unknown or malformed tool activity at the projection boundary', () => {
    const projectionRunId = '00000000-0000-4000-8000-000000000074'
    let sequence = 0
    const event = (type: AgentEvent['type'], data: AgentEvent['data']): AgentEvent => ({
      id: `invalid-projection-${++sequence}`,
      runId: projectionRunId,
      sequence,
      type,
      attempt: 1,
      schemaVersion: 1,
      data,
      createdAt: '2026-08-17T00:00:00.000Z'
    })
    const start = (actionCallId: string, actionName: string, extra: AgentEvent['data'] = {}) =>
      event('tool.started', { actionCallId, actionName, title: 'Activity', risk: 'read', ...extra })

    expect(reduceAgentEvents([event('tool.started', { actionName: 'arbitrary-provider-name', title: 'Hidden', risk: 'read' })], projectionRunId)).toEqual({
      tools: [],
      suggestions: []
    })
    expect(() => reduceAgentEvents([start('unknown', 'arbitrary-provider-name')], projectionRunId)).toThrow(
      expect.objectContaining({ code: 'AGENT_EVENT_CORRUPT', status: 500 })
    )
    expect(() => reduceAgentEvents([start('duplicate', 'pages.get'), start('duplicate', 'pages.get')], projectionRunId)).toThrow(
      expect.objectContaining({ code: 'AGENT_EVENT_CORRUPT', status: 500 })
    )
    expect(() => reduceAgentEvents([event('tool.completed', { actionCallId: 'orphan', actionName: 'pages.get' })], projectionRunId)).toThrow(
      expect.objectContaining({ code: 'AGENT_EVENT_CORRUPT', status: 500 })
    )
    expect(() => reduceAgentEvents([start('control-risk', 'wiki_enable_tools', { risk: 'proposal' })], projectionRunId)).toThrow(
      expect.objectContaining({ code: 'AGENT_EVENT_CORRUPT', status: 500 })
    )
    expect(() =>
      reduceAgentEvents([start('control-proposal', 'wiki_enable_tools', { proposalId: '00000000-0000-4000-8000-000000000075' })], projectionRunId)
    ).toThrow(expect.objectContaining({ code: 'AGENT_EVENT_CORRUPT', status: 500 }))
    expect(() =>
      reduceAgentEvents(
        [
          start('control-created', 'wiki_enable_tools'),
          event('proposal.created', { actionCallId: 'control-created', actionName: 'wiki_enable_tools', proposalId: '00000000-0000-4000-8000-000000000076' })
        ],
        projectionRunId
      )
    ).toThrow(expect.objectContaining({ code: 'AGENT_EVENT_CORRUPT', status: 500 }))
    expect(() =>
      reduceAgentEvents(
        [
          start('control-terminal-proposal', 'wiki_enable_tools'),
          event('tool.completed', {
            actionCallId: 'control-terminal-proposal',
            actionName: 'wiki_enable_tools',
            proposalId: '00000000-0000-4000-8000-000000000077',
            result: '{}'
          })
        ],
        projectionRunId
      )
    ).toThrow(expect.objectContaining({ code: 'AGENT_EVENT_CORRUPT', status: 500 }))
  })

  it('projects recovery-required proposals and durable links for applied page destinations', async () => {
    await knex('pages').insert({ id: 42, localeCode: 'en', path: 'old-path', title: 'Old page', contentType: 'markdown' })
    const createdAt = new Date('2026-08-17T00:00:00.000Z')
    const expiresAt = new Date('2026-08-17T00:10:00.000Z')
    const row = {
      sessionId,
      sourceKind: 'agent',
      risk: 'proposal',
      status: 'applied',
      summary: 'Change a page',
      pageId: null,
      baseSourceRevision: null,
      authoritySha256: 'a'.repeat(64),
      inputHash: 'b'.repeat(64),
      patchSha256: null,
      resultCanonicalSha256: null,
      diffSha256: null,
      diff: null,
      contentPurgedAt: null,
      expiresAt,
      createdAt
    }
    await knex('agentProposals').insert([
      {
        ...row,
        id: '00000000-0000-4000-8000-000000000041',
        actionName: 'pages.prepareCreate',
        operation: JSON.stringify({ locale: 'en', path: 'example-page' })
      },
      {
        ...row,
        id: '00000000-0000-4000-8000-000000000042',
        actionName: 'pages.preparePatch',
        pageId: 42,
        baseSourceRevision: 3,
        operation: JSON.stringify({ locale: 'en', path: 'old-path' })
      },
      {
        ...row,
        id: '00000000-0000-4000-8000-000000000043',
        actionName: 'pages.prepareMove',
        pageId: 42,
        baseSourceRevision: 3,
        operation: JSON.stringify({ locale: 'en', path: 'handbook/example-page' })
      },
      {
        ...row,
        id: '00000000-0000-4000-8000-000000000044',
        actionName: 'pages.prepareDelete',
        status: 'recovery_required',
        pageId: 42,
        baseSourceRevision: 3,
        operation: JSON.stringify({ locale: 'en', path: 'old-path' })
      }
    ])

    const projected = await projectAgentThread(knex, 7, sessionId, {
      profileResolutionToken: session => `profile:${session.id}:${session.version}`,
      now: createdAt
    })

    expect(projected.proposals.map(proposal => proposal.pageLink)).toEqual([
      { label: '/example-page', href: '/en/example-page' },
      { label: '/old-path', href: '/en/old-path' },
      { label: '/handbook/example-page', href: '/en/handbook/example-page' },
      null
    ])
    expect(projected.proposals[3]?.status).toBe('recovery_required')
  })

  it('reserves and reconciles quota without double-counting retries', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    const expiresAt = new Date('2026-08-17T00:05:00.000Z')
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 200 }, { dailyTokens: 150, dailyCostMicros: 300 }, expiresAt, now)
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 200 }, { dailyTokens: 150, dailyCostMicros: 300 }, expiresAt, now)
    await expect(
      Promise.resolve(
        reserveAgentRunQuota(
          knex,
          '00000000-0000-4000-8000-000000000030',
          7,
          { tokens: 51, costMicros: 1 },
          { dailyTokens: 150, dailyCostMicros: 300 },
          expiresAt,
          now
        )
      )
    ).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED', status: 429 })
    await reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 80, consumedCostMicros: 150, status: 'consumed', now })
    await reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 80, consumedCostMicros: 150, status: 'consumed', now })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toMatchObject({
      reservedTokens: 0,
      consumedTokens: 80,
      reservedCostMicros: 0,
      consumedCostMicros: 150
    })
  })

  it('charges full measured token overrun, releases the original hold once, and keeps replay idempotent', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    const expiresAt = new Date('2026-08-17T00:05:00.000Z')
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 200 }, { dailyTokens: 1_000, dailyCostMicros: 1_000 }, expiresAt, now)

    await reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 101, consumedCostMicros: 200, status: 'consumed', now })
    const dailyAfterSettlement = await knex('agentQuotaDaily').where({ ownerId: 7 }).first()
    const reservationAfterSettlement = await knex('agentQuotaReservations').where({ runId }).first()
    expect(dailyAfterSettlement).toMatchObject({
      reservedTokens: 0,
      consumedTokens: 101,
      reservedCostMicros: 0,
      consumedCostMicros: 200
    })
    expect(reservationAfterSettlement).toMatchObject({
      reservedTokens: 100,
      reservedCostMicros: 200,
      consumedTokens: 101,
      consumedCostMicros: 200,
      status: 'consumed'
    })

    await reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 101, consumedCostMicros: 200, status: 'consumed', now })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toEqual(dailyAfterSettlement)
    expect(await knex('agentQuotaReservations').where({ runId }).first()).toEqual(reservationAfterSettlement)
  })

  it('charges a cost-only overrun and rejects a changed replay', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    const expiresAt = new Date('2026-08-17T00:05:00.000Z')
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 200 }, { dailyTokens: 1_000, dailyCostMicros: 1_000 }, expiresAt, now)

    await reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 100, consumedCostMicros: 201, status: 'consumed', now })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toMatchObject({
      reservedTokens: 0,
      consumedTokens: 100,
      reservedCostMicros: 0,
      consumedCostMicros: 201
    })
    expect(await knex('agentQuotaReservations').where({ runId }).first()).toMatchObject({
      reservedTokens: 100,
      reservedCostMicros: 200,
      consumedTokens: 100,
      consumedCostMicros: 201,
      status: 'consumed'
    })
    await expect(
      Promise.resolve(reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 100, consumedCostMicros: 202, status: 'consumed', now }))
    ).rejects.toMatchObject({ code: 'QUOTA_RESERVATION_RECONCILED', status: 409 })
  })
  it('records a fenced monotone pending settlement without changing admission holds', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    const expiresAt = new Date('2026-08-17T00:05:00.000Z')
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 200 }, { dailyTokens: 1_000, dailyCostMicros: 1_000 }, expiresAt, now)
    const dailyBefore = await knex('agentQuotaDaily').where({ ownerId: 7 }).first()
    await persistAgentRunQuotaSettlementIntent(knex, {
      runId,
      ownerId: 7,
      expected: { statuses: ['running'], eventSequence: 0, leaseOwner: 'worker-a', leaseToken: '00000000-0000-4000-8000-000000000006' },
      consumedTokens: 101,
      consumedCostMicros: 201,
      now
    })
    await expect(
      Promise.resolve(
        persistAgentRunQuotaSettlementIntent(knex, {
          runId,
          ownerId: 7,
          expected: { statuses: ['running'], eventSequence: 1, leaseOwner: 'worker-a', leaseToken: '00000000-0000-4000-8000-000000000006' },
          consumedTokens: 1,
          consumedCostMicros: 1,
          now
        })
      )
    ).rejects.toMatchObject({ code: 'RUN_EVENT_FENCE_CHANGED', status: 409 })
    await persistAgentRunQuotaSettlementIntent(knex, {
      runId,
      ownerId: 7,
      expected: { statuses: ['running'], leaseOwner: 'worker-a', leaseToken: '00000000-0000-4000-8000-000000000006' },
      consumedTokens: 90,
      consumedCostMicros: 190,
      now
    })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toEqual(dailyBefore)
    expect(await knex('agentQuotaReservations').where({ runId }).first()).toMatchObject({
      reservedTokens: 100,
      reservedCostMicros: 200,
      consumedTokens: 101,
      consumedCostMicros: 201,
      status: 'reserved',
      reconciledAt: null
    })
    await expect(
      Promise.resolve(reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 0, consumedCostMicros: 0, status: 'released', now }))
    ).rejects.toBeInstanceOf(AgentQuotaSettlementError)
    await reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 102, consumedCostMicros: 202, status: 'consumed', now })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toMatchObject({
      reservedTokens: 0,
      consumedTokens: 102,
      reservedCostMicros: 0,
      consumedCostMicros: 202
    })
  })

  it('rejects released consumption without changing quota rows', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    const expiresAt = new Date('2026-08-17T00:05:00.000Z')
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 200 }, { dailyTokens: 1_000, dailyCostMicros: 1_000 }, expiresAt, now)
    const dailyBefore = await knex('agentQuotaDaily').where({ ownerId: 7 }).first()
    const reservationBefore = await knex('agentQuotaReservations').where({ runId }).first()

    await expect(
      Promise.resolve(
        reconcileAgentRunQuota(knex, {
          runId,
          ownerId: 7,
          consumedTokens: 1,
          consumedCostMicros: 0,
          status: 'released',
          now
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_AGENT_QUOTA', status: 400 })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toEqual(dailyBefore)
    expect(await knex('agentQuotaReservations').where({ runId }).first()).toEqual(reservationBefore)
  })

  it('rolls back inconsistent and overflowing settlement calculations', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    const expiresAt = new Date('2026-08-17T00:05:00.000Z')
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 200 }, { dailyTokens: 1_000, dailyCostMicros: 1_000 }, expiresAt, now)
    await knex('agentQuotaDaily').where({ ownerId: 7 }).update({ reservedTokens: 99 })
    const inconsistentDaily = await knex('agentQuotaDaily').where({ ownerId: 7 }).first()
    const inconsistentReservation = await knex('agentQuotaReservations').where({ runId }).first()

    await expect(
      Promise.resolve(reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 101, consumedCostMicros: 200, status: 'consumed', now }))
    ).rejects.toMatchObject({ code: 'AGENT_QUOTA_CORRUPT', status: 500 })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toEqual(inconsistentDaily)
    expect(await knex('agentQuotaReservations').where({ runId }).first()).toEqual(inconsistentReservation)

    await knex('agentQuotaDaily').where({ ownerId: 7 }).update({ reservedTokens: 100, consumedTokens: Number.MAX_SAFE_INTEGER })
    const overflowingDaily = await knex('agentQuotaDaily').where({ ownerId: 7 }).first()
    const overflowingReservation = await knex('agentQuotaReservations').where({ runId }).first()
    await expect(
      Promise.resolve(reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 1, consumedCostMicros: 0, status: 'consumed', now }))
    ).rejects.toMatchObject({ code: 'AGENT_QUOTA_CORRUPT', status: 500 })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toEqual(overflowingDaily)
    expect(await knex('agentQuotaReservations').where({ runId }).first()).toEqual(overflowingReservation)
  })
  it('rejects daily cost overflow while token usage remains representable', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    const expiresAt = new Date('2026-08-17T00:05:00.000Z')
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 200 }, { dailyTokens: 1_000, dailyCostMicros: 1_000 }, expiresAt, now)
    await knex('agentQuotaDaily').where({ ownerId: 7 }).update({ consumedCostMicros: Number.MAX_SAFE_INTEGER })
    const dailyBefore = await knex('agentQuotaDaily').where({ ownerId: 7 }).first()
    const reservationBefore = await knex('agentQuotaReservations').where({ runId }).first()
    await expect(
      Promise.resolve(reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 1, consumedCostMicros: 1, status: 'consumed', now }))
    ).rejects.toMatchObject({ code: 'AGENT_QUOTA_CORRUPT', status: 500 })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toEqual(dailyBefore)
    expect(await knex('agentQuotaReservations').where({ runId }).first()).toEqual(reservationBefore)
  })

  it('accumulates settled and overrun charges and rejects a fresh admission above the daily limit', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    const expiresAt = new Date('2026-08-17T00:05:00.000Z')
    const limits = { dailyTokens: 1_000, dailyCostMicros: 1_000 }
    const secondRunId = '00000000-0000-4000-8000-000000000030'
    const freshRunId = '00000000-0000-4000-8000-000000000031'
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 100 }, limits, expiresAt, now)
    await reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 80, consumedCostMicros: 100, status: 'consumed', now })
    await reserveAgentRunQuota(knex, secondRunId, 7, { tokens: 100, costMicros: 100 }, limits, expiresAt, now)
    await reconcileAgentRunQuota(knex, { runId: secondRunId, ownerId: 7, consumedTokens: 101, consumedCostMicros: 101, status: 'consumed', now })

    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toMatchObject({
      reservedTokens: 0,
      consumedTokens: 181,
      reservedCostMicros: 0,
      consumedCostMicros: 201
    })
    await expect(
      Promise.resolve(reserveAgentRunQuota(knex, freshRunId, 7, { tokens: 1, costMicros: 0 }, { dailyTokens: 181, dailyCostMicros: 1_000 }, expiresAt, now))
    ).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED', status: 429 })
  })

  it('atomically tops up dispatch exposure and denies a second priced run after daily cost is consumed', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    const expiresAt = new Date('2026-08-17T00:05:00.000Z')
    const limits = { dailyTokens: 1_000, dailyCostMicros: 200 }
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 10, costMicros: 10 }, limits, expiresAt, now)
    await Promise.all([
      ensureAgentRunQuota(knex, runId, 7, { tokens: 80, costMicros: 200 }, limits, expiresAt, now),
      ensureAgentRunQuota(knex, runId, 7, { tokens: 80, costMicros: 200 }, limits, expiresAt, now)
    ])
    await reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 80, consumedCostMicros: 200, status: 'consumed', now })

    await expect(
      Promise.resolve(reserveAgentRunQuota(knex, '00000000-0000-4000-8000-000000000030', 7, { tokens: 1, costMicros: 1 }, limits, expiresAt, now))
    ).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED' })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toMatchObject({
      reservedTokens: 0,
      consumedTokens: 80,
      reservedCostMicros: 0,
      consumedCostMicros: 200
    })
  })

  it('terminalizes a provider overrun with full known usage before finish and restart', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    await knex('agentRuns').where({ id: runId }).update({
      status: 'queued',
      attempts: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: now,
      completedAt: null,
      errorCode: null,
      errorMessage: null
    })
    await reserveAgentRunQuota(
      knex,
      runId,
      7,
      { tokens: 100, costMicros: 100 },
      { dailyTokens: 1_000, dailyCostMicros: 1_000 },
      new Date('2026-08-17T00:05:00.000Z'),
      now
    )
    const engine: AgentEngine = {
      async execute(request) {
        if (!request.dispatchBudget) throw new Error('dispatch budget missing')
        const reservation = await request.dispatchBudget.reserve({ tokens: 100, costMicros: 100 })
        await request.dispatchBudget.reconcile(reservation, { inputTokens: 70, outputTokens: 40, totalTokens: 110, costMicros: 101 })
        throw new Error('unreachable')
      }
    }
    const runtimeOptions = { workerId: 'worker-provider-overrun', globalConcurrency: 1, perUserConcurrency: 1 }
    const runtime = new AgentProductRuntime(
      knex,
      {
        async resolve(_transaction: Knex.Transaction, _input: AdmissionResolverInput) {
          throw new Error('not used')
        },
        async resolveCurrent(_transaction: Knex.Transaction, _input: CurrentAdmissionResolverInput) {
          throw new Error('not used')
        }
      },
      engine,
      runtimeOptions
    )

    expect(await runtime.runOnce()).toBe(true)
    expect(await knex('agentRuns').where({ id: runId }).first('status', 'inputTokens', 'outputTokens', 'totalTokens', 'estimatedCostMicros')).toMatchObject({
      status: 'failed',
      inputTokens: 70,
      outputTokens: 40,
      totalTokens: 110,
      estimatedCostMicros: 101
    })
    expect(
      await knex('agentQuotaReservations').where({ runId }).first('reservedTokens', 'reservedCostMicros', 'consumedTokens', 'consumedCostMicros', 'status')
    ).toEqual({
      reservedTokens: 100,
      reservedCostMicros: 100,
      consumedTokens: 110,
      consumedCostMicros: 101,
      status: 'consumed'
    })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toMatchObject({
      reservedTokens: 0,
      reservedCostMicros: 0,
      consumedTokens: 110,
      consumedCostMicros: 101
    })
    expect(await knex('agentEvents').where({ runId, type: 'usage.updated' }).count<{ count: number | string }[]>({ count: '*' }).first()).toMatchObject({
      count: 0
    })
    const dailyAfterTerminal = await knex('agentQuotaDaily').where({ ownerId: 7 }).first()
    expect(await runtime.runOnce()).toBe(false)
    await runtime.shutdown()

    const restarted = new AgentProductRuntime(
      knex,
      {
        async resolve(_transaction: Knex.Transaction, _input: AdmissionResolverInput) {
          throw new Error('not used')
        },
        async resolveCurrent(_transaction: Knex.Transaction, _input: CurrentAdmissionResolverInput) {
          throw new Error('not used')
        }
      },
      engine,
      { ...runtimeOptions, workerId: 'worker-provider-overrun-restart' }
    )
    expect(await restarted.runOnce()).toBe(false)
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first()).toEqual(dailyAfterTerminal)
    await restarted.shutdown()
  })
  it('persists an overrun intent across failed settlement, restart, and repair', async () => {
    const now = new Date('2026-08-17T00:02:00.000Z')
    const expiresAt = new Date('2026-08-17T00:05:00.000Z')
    await knex('agentRuns').where({ id: runId }).update({
      status: 'queued',
      attempts: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: now,
      completedAt: null,
      errorCode: null,
      errorMessage: null
    })
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 100 }, { dailyTokens: 1_000, dailyCostMicros: 1_000 }, expiresAt, now)
    let executions = 0
    const engine: AgentEngine = {
      async execute(request) {
        executions += 1
        if (!request.dispatchBudget) throw new Error('dispatch budget missing')
        const reservation = await request.dispatchBudget.reserve({ tokens: 100, costMicros: 100 })
        try {
          await request.dispatchBudget.reconcile(reservation, { inputTokens: 70, outputTokens: 40, totalTokens: 110, costMicros: 101 })
        } catch (error) {
          await knex('agentQuotaDaily').where({ ownerId: 7, day: '2026-08-17' }).update({
            consumedTokens: Number.MAX_SAFE_INTEGER,
            consumedCostMicros: Number.MAX_SAFE_INTEGER
          })
          throw error
        }
        throw new Error('unreachable')
      }
    }
    const runtimeOptions = {
      workerId: 'worker-provider-overrun-repair',
      globalConcurrency: 1,
      perUserConcurrency: 1
    }
    const runtime = new AgentProductRuntime(
      knex,
      {
        async resolve(_transaction: Knex.Transaction, _input: AdmissionResolverInput) {
          throw new Error('not used')
        },
        async resolveCurrent(_transaction: Knex.Transaction, _input: CurrentAdmissionResolverInput) {
          throw new Error('not used')
        }
      },
      engine,
      runtimeOptions
    )

    await expect(Promise.resolve(runtime.runOnce())).rejects.toBeInstanceOf(AgentQuotaSettlementError)
    await runtime.shutdown()
    expect(executions).toBe(1)
    expect(await knex('agentRuns').where({ id: runId }).first('status', 'leaseOwner', 'leaseToken')).toMatchObject({
      status: 'running',
      leaseOwner: 'worker-provider-overrun-repair',
      leaseToken: expect.any(String)
    })
    expect(await knex('agentQuotaReservations').where({ runId }).first()).toMatchObject({
      reservedTokens: 100,
      reservedCostMicros: 100,
      consumedTokens: 110,
      consumedCostMicros: 101,
      status: 'reserved',
      reconciledAt: null
    })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7, day: '2026-08-17' }).first()).toMatchObject({
      reservedTokens: 100,
      consumedTokens: Number.MAX_SAFE_INTEGER,
      reservedCostMicros: 100,
      consumedCostMicros: Number.MAX_SAFE_INTEGER
    })

    await knex('agentRuns')
      .where({ id: runId })
      .update({ leaseExpiresAt: new Date('2026-08-16T00:00:00.000Z') })
    const restarted = new AgentProductRuntime(
      knex,
      {
        async resolve(_transaction: Knex.Transaction, _input: AdmissionResolverInput) {
          throw new Error('not used')
        },
        async resolveCurrent(_transaction: Knex.Transaction, _input: CurrentAdmissionResolverInput) {
          throw new Error('not used')
        }
      },
      engine,
      { ...runtimeOptions, workerId: 'worker-provider-overrun-repair-restart' }
    )
    expect(await restarted.runOnce()).toBe(false)
    await restarted.shutdown()
    expect(executions).toBe(1)

    await knex('agentQuotaDaily').where({ ownerId: 7, day: '2026-08-17' }).update({ consumedTokens: 0, consumedCostMicros: 0 })
    const live = await knex('agentRuns').where({ id: runId }).first('leaseOwner', 'leaseToken')
    await terminalizeAgentRun(knex, {
      runId,
      ownerId: 7,
      expected: { statuses: ['running'], leaseOwner: live.leaseOwner, leaseToken: live.leaseToken },
      status: 'failed',
      assistant: { status: 'failed' },
      now: new Date('2026-08-17T00:05:00.000Z')
    })
    const dailyAfterRepair = await knex('agentQuotaDaily').where({ ownerId: 7, day: '2026-08-17' }).first()
    expect(await knex('agentQuotaReservations').where({ runId }).first()).toMatchObject({
      reservedTokens: 100,
      reservedCostMicros: 100,
      consumedTokens: 110,
      consumedCostMicros: 101,
      status: 'consumed'
    })
    expect(dailyAfterRepair).toMatchObject({
      reservedTokens: 0,
      consumedTokens: 110,
      reservedCostMicros: 0,
      consumedCostMicros: 101
    })
    await terminalizeAgentRun(knex, { runId, ownerId: 7, status: 'failed', now: new Date('2026-08-17T00:06:00.000Z') })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7, day: '2026-08-17' }).first()).toEqual(dailyAfterRepair)
  })

  it('reconciles terminal retry usage from every persisted root model turn', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    await appendAgentEvent(knex, {
      id: '00000000-0000-4000-8000-000000000070',
      runId,
      ownerId: 7,
      type: 'task.planCreated',
      attempt: 1,
      data: { taskIds: [], taskCount: 0, inputTokens: 2, outputTokens: 1, costMicros: 4 }
    })
    await appendAgentEvent(knex, {
      id: '00000000-0000-4000-8000-000000000071',
      runId,
      ownerId: 7,
      type: 'model.turn',
      attempt: 1,
      data: {
        turn: 1,
        outcome: 'tool_calls',
        inputTokens: 11,
        outputTokens: 3,
        costMicros: 17,
        content: '',
        contentTruncated: false,
        actionCallIds: ['proposal-call']
      }
    })
    await knex('agentRuns').where({ id: runId }).update({
      status: 'queued',
      attempts: 1,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: now,
      completedAt: null
    })
    await reserveAgentRunQuota(
      knex,
      runId,
      7,
      { tokens: 100, costMicros: 100 },
      { dailyTokens: 1_000, dailyCostMicros: 1_000 },
      new Date('2026-08-17T00:05:00.000Z'),
      now
    )
    let reservedExposure = 0
    const engine: AgentEngine = {
      async execute(request, sink) {
        const reservation = await request.dispatchBudget.reserve({ tokens: 84, costMicros: 30 })
        reservedExposure = Number((await knex('agentQuotaReservations').where({ runId }).first('reservedTokens'))?.reservedTokens)
        await request.dispatchBudget.reconcile(reservation, { inputTokens: 5, outputTokens: 2, totalTokens: 7, costMicros: 9 })
        await sink.text('Recovered answer')
        return { inputTokens: 5, outputTokens: 2, totalTokens: 7, costMicros: 9 }
      }
    }
    const runtime = new AgentProductRuntime(
      knex,
      {
        async resolve(_transaction: Knex.Transaction, _input: AdmissionResolverInput) {
          throw new Error('not used')
        },
        async resolveCurrent(_transaction: Knex.Transaction, _input: CurrentAdmissionResolverInput) {
          throw new Error('not used')
        }
      },
      engine,
      { workerId: 'worker-retry-usage', globalConcurrency: 1, perUserConcurrency: 1 }
    )

    expect(await runtime.runOnce()).toBe(true)
    expect(await knex('agentRuns').where({ id: runId }).first('status', 'inputTokens', 'outputTokens', 'totalTokens', 'estimatedCostMicros')).toMatchObject({
      status: 'succeeded',
      inputTokens: 18,
      outputTokens: 6,
      totalTokens: 24,
      estimatedCostMicros: 30
    })
    expect(await knex('agentQuotaReservations').where({ runId }).first('status', 'consumedTokens', 'consumedCostMicros')).toMatchObject({
      status: 'consumed',
      consumedTokens: 24,
      consumedCostMicros: 30
    })
    const usageEvent = await knex('agentEvents').where({ runId, type: 'usage.updated' }).first('data')
    expect(JSON.parse(String(usageEvent?.data))).toMatchObject({
      inputTokens: 18,
      outputTokens: 6,
      totalTokens: 24,
      costMicros: 30,
      model: { inputTokens: 16, outputTokens: 5, costMicros: 26 },
      orchestration: { inputTokens: 2, outputTokens: 1, costMicros: 4 }
    })
  })

  it('reconciles persisted retry turns when recovered synthesis terminalizes partial', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    await appendAgentEvent(knex, {
      id: '00000000-0000-4000-8000-000000000072',
      runId,
      ownerId: 7,
      type: 'model.turn',
      attempt: 1,
      data: {
        turn: 1,
        outcome: 'tool_calls',
        inputTokens: 7,
        outputTokens: 3,
        costMicros: 13,
        content: '',
        contentTruncated: false,
        actionCallIds: ['proposal-call']
      }
    })
    await knex('agentRuns').where({ id: runId }).update({
      status: 'queued',
      attempts: 1,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: now,
      completedAt: null
    })
    await reserveAgentRunQuota(
      knex,
      runId,
      7,
      { tokens: 100, costMicros: 100 },
      { dailyTokens: 1_000, dailyCostMicros: 1_000 },
      new Date('2026-08-17T00:05:00.000Z'),
      now
    )
    const engine: AgentEngine = {
      async execute(_request, sink) {
        await sink.event('model.turn', {
          turn: 1,
          outcome: 'answer_rejected',
          inputTokens: 4,
          outputTokens: 2,
          costMicros: 8,
          content: '',
          contentTruncated: false,
          actionCallIds: []
        })
        throw Object.assign(new Error('retry synthesis failed'), { code: 'AGENT_ACTION_RECOVERY_REQUIRED' })
      }
    }
    const runtime = new AgentProductRuntime(
      knex,
      {
        async resolve(_transaction: Knex.Transaction, _input: AdmissionResolverInput) {
          throw new Error('not used')
        },
        async resolveCurrent(_transaction: Knex.Transaction, _input: CurrentAdmissionResolverInput) {
          throw new Error('not used')
        }
      },
      engine,
      { workerId: 'worker-retry-failure-usage', globalConcurrency: 1, perUserConcurrency: 1 }
    )

    expect(await runtime.runOnce()).toBe(true)
    expect(await knex('agentRuns').where({ id: runId }).first('status', 'inputTokens', 'outputTokens', 'estimatedCostMicros')).toMatchObject({
      status: 'partial',
      inputTokens: 11,
      outputTokens: 5,
      estimatedCostMicros: 21
    })
    expect(await knex('agentQuotaReservations').where({ runId }).first('status', 'consumedTokens', 'consumedCostMicros')).toMatchObject({
      status: 'consumed',
      consumedTokens: 16,
      consumedCostMicros: 21
    })
    expect(await knex('agentEvents').where({ runId }).orderBy('sequence').pluck('type')).toContain('run.partial')
    expect(await knex('agentMessages').where({ id: assistantMessageId }).first('status', 'content')).toEqual({ status: 'failed', content: '' })
  })

  it('retains quota and durable approval state during worker shutdown', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    await knex('agentRuns').where({ id: runId }).update({
      status: 'queued',
      attempts: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: now,
      completedAt: null
    })
    await reserveAgentRunQuota(
      knex,
      runId,
      7,
      { tokens: 100, costMicros: 200 },
      { dailyTokens: 150, dailyCostMicros: 300 },
      new Date('2026-08-17T00:05:00.000Z'),
      now
    )
    const entered = Promise.withResolvers<void>()
    const engine: AgentEngine = {
      async execute(request) {
        await knex('agentRuns')
          .where({ id: request.run.id, leaseOwner: request.run.leaseOwner, leaseToken: request.run.leaseToken, status: 'running' })
          .update({ status: 'awaiting_approval' })
        entered.resolve()
        await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }))
        throw new Error('unreachable')
      }
    }
    const runtime = new AgentProductRuntime(
      knex,
      {
        async resolve(_transaction: Knex.Transaction, _input: AdmissionResolverInput) {
          throw new Error('not used')
        },
        async resolveCurrent(_transaction: Knex.Transaction, _input: CurrentAdmissionResolverInput) {
          throw new Error('not used')
        }
      },
      engine,
      {
        workerId: 'worker-approval-shutdown',
        globalConcurrency: 1,
        perUserConcurrency: 1,
        leaseMilliseconds: 60_000,
        heartbeatMilliseconds: 5_000
      }
    )
    const running = runtime.runOnce()
    await entered.promise
    await runtime.shutdown()
    expect(await running).toBe(true)
    expect(await knex('agentRuns').where({ id: runId }).first('status')).toEqual({ status: 'awaiting_approval' })
    expect(await knex('agentQuotaReservations').where({ runId }).first('status')).toEqual({ status: 'reserved' })
    expect(await knex('agentEvents').where({ runId }).orderBy('sequence').pluck('type')).toEqual(['run.attemptStarted', 'message.started'])
  })

  it('admits a run atomically and binds exact retries to a canonical input hash', async () => {
    const secondSessionId = '00000000-0000-4000-8000-000000000031'
    await createAgentSession(knex, { id: secondSessionId, ownerId: 7, title: '', retention: 'temporary', providerProfileId: null, executionMode: 'agent' })
    const input = {
      id: '00000000-0000-4000-8000-000000000032',
      userMessageId: '00000000-0000-4000-8000-000000000033',
      assistantMessageId: '00000000-0000-4000-8000-000000000034',
      queuedEventId: '00000000-0000-4000-8000-000000000035',
      ownerId: 7,
      sessionId: secondSessionId,
      clientRequestId: '00000000-0000-4000-8000-000000000036',
      expectedSessionVersion: 1,
      profileResolutionSha256: 'a'.repeat(64),
      content: 'Durable question',
      currentPage: { id: 42, locale: 'en', path: 'guide', observedUpdatedAt: '2026-08-17T00:00:00.000Z' },
      providerProfileVersionId: '00000000-0000-4000-8000-000000000037',
      transportKind: 'openai-responses',
      model: 'test',
      executionMode: 'agent' as const,
      profilePolicyVersion: 1,
      defaultGeneration: 1,
      capabilityRevision: 'v1',
      pricingRevision: 'v1',
      promptVersion: 1,
      skillVersionIds: [],
      quota: { tokens: 100, costMicros: 100 },
      quotaLimits: { dailyTokens: 1_000, dailyCostMicros: 1_000 },
      reservationExpiresAt: new Date('2026-08-17T00:05:00.000Z'),
      now: new Date('2026-08-17T00:00:00.000Z')
    }
    const created = await admitAgentRun(knex, input)
    const replay = await admitAgentRun(knex, input)
    expect(created.replayed).toBe(false)
    expect(replay).toMatchObject({ replayed: true, run: { id: input.id, eventSequence: 1, status: 'queued' } })
    await expect(Promise.resolve(admitAgentRun(knex, { ...input, content: 'Different' }))).rejects.toMatchObject({
      code: 'RUN_IDEMPOTENCY_MISMATCH',
      status: 409
    })
    expect(await knex('agentMessages').where({ sessionId: secondSessionId }).orderBy('ordinal').pluck('status')).toEqual(['complete', 'pending'])
    const queuedEvent = await knex('agentEvents').where({ runId: input.id }).first('type', 'data')
    expect(queuedEvent?.type).toBe('run.queued')
    expect(JSON.parse(String(queuedEvent?.data))).toMatchObject({ runId: input.id, status: 'queued', currentPage: input.currentPage })

    const failedSessionId = '00000000-0000-4000-8000-000000000038'
    await createAgentSession(knex, { id: failedSessionId, ownerId: 8, retention: 'temporary', providerProfileId: null, executionMode: 'agent' })
    await expect(
      Promise.resolve(
        admitAgentRun(knex, {
          ...input,
          id: '00000000-0000-4000-8000-000000000039',
          userMessageId: '00000000-0000-4000-8000-000000000041',
          assistantMessageId: '00000000-0000-4000-8000-000000000042',
          queuedEventId: '00000000-0000-4000-8000-000000000043',
          sessionId: failedSessionId,
          ownerId: 8,
          clientRequestId: '00000000-0000-4000-8000-000000000040',
          quotaLimits: { dailyTokens: 0, dailyCostMicros: 0 }
        })
      )
    ).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED' })
    expect(await knex('agentRuns').where({ sessionId: failedSessionId }).count<{ count: number }[]>({ count: '*' }).first()).toMatchObject({ count: 0 })
    expect(await knex('agentMessages').where({ sessionId: failedSessionId }).count<{ count: number }[]>({ count: '*' }).first()).toMatchObject({ count: 0 })
  })

  it('rejects stale explicit versions before deduplicating current preferred and invoked versions by skill identity', async () => {
    const dedupeSessionId = '00000000-0000-4000-8000-000000000080'
    const staleSessionId = '00000000-0000-4000-8000-000000000094'
    const preferredVersionId = '00000000-0000-4000-8000-000000000081'
    const alternateVersionId = '00000000-0000-4000-8000-000000000082'
    const otherVersionId = '00000000-0000-4000-8000-000000000083'
    const firstSkillId = '00000000-0000-4000-8000-000000000084'
    const secondSkillId = '00000000-0000-4000-8000-000000000085'
    const now = new Date()
    await createAgentSession(knex, { id: dedupeSessionId, ownerId: 7, retention: 'saved', providerProfileId: null, executionMode: 'agent' })
    await createAgentSession(knex, { id: staleSessionId, ownerId: 7, retention: 'saved', providerProfileId: null, executionMode: 'agent' })
    await knex('agentSkills').insert([
      { id: firstSkillId, name: 'preferred-skill', rootPath: 'skills/preferred', status: 'enabled', currentVersionId: preferredVersionId },
      { id: secondSkillId, name: 'other-skill', rootPath: 'skills/other', status: 'enabled', currentVersionId: otherVersionId }
    ])
    await knex('agentSkillVersions').insert([
      { id: preferredVersionId, skillId: firstSkillId, frontmatter: '{}', contentHash: 'preferred', skillMarkdown: 'Preferred', createdAt: now },
      { id: alternateVersionId, skillId: firstSkillId, frontmatter: '{}', contentHash: 'alternate', skillMarkdown: 'Alternate', createdAt: now },
      { id: otherVersionId, skillId: secondSkillId, frontmatter: '{}', contentHash: 'other', skillMarkdown: 'Other', createdAt: now }
    ])
    await knex('agentUserSkillPreferences').insert({ ownerId: 7, skillId: firstSkillId, ordinal: 0 })
    const runtime = new AgentProductRuntime(
      knex,
      {
        async resolve(_transaction: Knex.Transaction, _input: AdmissionResolverInput) {
          return {
            profileResolutionSha256: 'd'.repeat(64),
            providerProfileVersionId: '00000000-0000-4000-8000-000000000086',
            transportKind: 'test',
            model: 'test',
            executionMode: 'agent',
            profilePolicyVersion: 1,
            defaultGeneration: 1,
            capabilityRevision: 'v1',
            pricingRevision: 'v1',
            promptVersion: 1,
            quota: { tokens: 100, costMicros: 100 },
            quotaLimits: { dailyTokens: 1_000, dailyCostMicros: 1_000 },
            reservationMilliseconds: 60_000
          }
        },
        async resolveCurrent(_transaction: Knex.Transaction, _input: CurrentAdmissionResolverInput) {
          return {
            profileResolutionSha256: 'd'.repeat(64),
            providerProfileVersionId: '00000000-0000-4000-8000-000000000086',
            transportKind: 'test',
            model: 'test',
            executionMode: 'agent',
            profilePolicyVersion: 1,
            defaultGeneration: 1,
            capabilityRevision: 'v1',
            pricingRevision: 'v1',
            promptVersion: 1,
            quota: { tokens: 100, costMicros: 100 },
            quotaLimits: { dailyTokens: 1_000, dailyCostMicros: 1_000 },
            reservationMilliseconds: 60_000
          }
        }
      },
      {
        async execute() {
          return { inputTokens: 0, outputTokens: 0, totalTokens: 0, costMicros: 0 }
        }
      },
      { workerId: 'dedupe-test', globalConcurrency: 1, perUserConcurrency: 1 }
    )
    await expect(
      runtime.submit({
        ownerId: 7,
        sessionId: staleSessionId,
        profileResolutionToken: 'token',
        clientRequestId: '00000000-0000-4000-8000-000000000095',
        expectedSessionVersion: 1,
        content: 'Reject stale explicit skill.',
        invokedSkillVersionIds: [alternateVersionId]
      })
    ).rejects.toMatchObject({ code: 'INVALID_SKILL' })
    expect(await knex('agentMessages').where({ sessionId: staleSessionId })).toEqual([])
    expect(await knex('agentRuns').where({ sessionId: staleSessionId })).toEqual([])
    expect(await knex('agentRunSkills')).toEqual([])
    expect(await knex('agentQuotaReservations')).toEqual([])
    expect(await knex('agentEvents')).toEqual([])
    const admitted = await runtime.submit({
      ownerId: 7,
      sessionId: dedupeSessionId,
      profileResolutionToken: 'token',
      clientRequestId: '00000000-0000-4000-8000-000000000087',
      expectedSessionVersion: 1,
      content: 'Use the available skills.',
      invokedSkillVersionIds: [preferredVersionId, otherVersionId]
    })
    expect(await knex('agentRunSkills').where({ runId: admitted.run.id }).orderBy('ordinal').pluck('skillVersionId')).toEqual([
      preferredVersionId,
      otherVersionId
    ])
    await runtime.shutdown()
  })

  it('passes remaining hard goal limits to execution and transitions budget_limited on the host fence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T00:00:00.000Z'))
    const goalSessionId = '00000000-0000-4000-8000-000000000088'
    const goalId = '00000000-0000-4000-8000-000000000089'
    try {
      await knex('agentRuns').where({ id: runId }).delete()
      await createAgentSession(knex, { id: goalSessionId, ownerId: 7, retention: 'saved', providerProfileId: null, executionMode: 'agent' })
      const session = await getOwnedAgentSession(knex, 7, goalSessionId)
      let markExecutionStarted: () => void = () => undefined
      const executionStarted = new Promise<void>(resolve => {
        markExecutionStarted = resolve
      })
      const execute = vi.fn(async (request: Parameters<AgentEngine['execute']>[0]) => {
        expect(request.limits).toEqual({
          maxTokens: 10,
          maxTurns: 12,
          maxToolCalls: 1,
          maxOutputTokens: 10
        })
        markExecutionStarted()
        return new Promise<never>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        })
      })
      const runtime = new AgentProductRuntime(
        knex,
        {
          async resolve(_transaction: Knex.Transaction, _input: AdmissionResolverInput) {
            return {
              profileResolutionSha256: 'f'.repeat(64),
              providerProfileVersionId: '00000000-0000-4000-8000-000000000098',
              transportKind: 'test',
              model: 'test',
              executionMode: 'agent',
              profilePolicyVersion: 1,
              defaultGeneration: 1,
              capabilityRevision: 'v1',
              pricingRevision: 'v1',
              promptVersion: 1,
              quota: { tokens: 100, costMicros: 100 },
              quotaLimits: { dailyTokens: 1_000, dailyCostMicros: 1_000 },
              reservationMilliseconds: 60_000
            }
          },
          async resolveCurrent(_transaction: Knex.Transaction, _input: CurrentAdmissionResolverInput) {
            return {
              profileResolutionSha256: 'f'.repeat(64),
              providerProfileVersionId: '00000000-0000-4000-8000-000000000098',
              transportKind: 'test',
              model: 'test',
              executionMode: 'agent',
              profilePolicyVersion: 1,
              defaultGeneration: 1,
              capabilityRevision: 'v1',
              pricingRevision: 'v1',
              promptVersion: 1,
              quota: { tokens: 100, costMicros: 100 },
              quotaLimits: { dailyTokens: 1_000, dailyCostMicros: 1_000 },
              reservationMilliseconds: 60_000
            }
          }
        },
        { execute } as AgentEngine,
        {
          workerId: 'goal-budget-test',
          globalConcurrency: 1,
          perUserConcurrency: 1,
          goals: { enabled: true, maxContinuations: 2, maxTokens: 10, maxToolCalls: 1, maxDurationMilliseconds: 1_000 }
        }
      )
      const admitted = await runtime.createGoal({
        ownerId: 7,
        sessionId: goalSessionId,
        profileResolutionToken: 'token',
        clientRequestId: '00000000-0000-4000-8000-000000000099',
        expectedSessionVersion: session.version,
        objective: 'Finish one bounded action.',
        goalId
      })
      const reservation = (await knex('agentQuotaReservations').where({ runId: admitted.run.id }).first('reservedTokens', 'expiresAt')) as {
        reservedTokens: number
        expiresAt: Date | string
      }
      expect(reservation.reservedTokens).toBe(10)
      expect(new Date(reservation.expiresAt).toISOString()).toBe('2026-08-17T00:00:01.000Z')

      const running = runtime.runOnce()
      await executionStarted
      await vi.advanceTimersByTimeAsync(1_001)
      expect(await running).toBe(true)
      expect(await knex('agentGoals').where({ id: goalId }).first('status', 'errorCode')).toEqual({
        status: 'budget_limited',
        errorCode: 'GOAL_BUDGET_LIMITED'
      })
      await runtime.shutdown()
    } finally {
      vi.useRealTimers()
    }
  })

  it('titles the first successful exchange with utility usage included in the run', async () => {
    const titledSessionId = '00000000-0000-4000-8000-000000000090'
    const profileVersionId = '00000000-0000-4000-8000-000000000091'
    await knex('agentRuns').where({ id: runId }).delete()
    await createAgentSession(knex, { id: titledSessionId, ownerId: 9, retention: 'saved', providerProfileId: null, executionMode: 'agent' })
    const generateConversationTitle = vi
      .fn()
      .mockResolvedValueOnce({ title: 'Deployment Pipeline Failures', source: 'utility', inputTokens: 2, outputTokens: 3, totalTokens: 5, costMicros: 0 })
      .mockResolvedValueOnce({
        title: 'Runner Rollover Configuration Failures',
        source: 'utility',
        inputTokens: 4,
        outputTokens: 2,
        totalTokens: 6,
        costMicros: 0
      })
    const runtime = new AgentProductRuntime(
      knex,
      {
        async resolve(_transaction: Knex.Transaction, _input: AdmissionResolverInput) {
          return {
            profileResolutionSha256: 'e'.repeat(64),
            providerProfileVersionId: profileVersionId,
            transportKind: 'test',
            model: 'test',
            executionMode: 'agent',
            profilePolicyVersion: 1,
            defaultGeneration: 1,
            capabilityRevision: 'v1',
            pricingRevision: 'v1',
            promptVersion: 1,
            quota: { tokens: 100, costMicros: 100 },
            quotaLimits: { dailyTokens: 1_000, dailyCostMicros: 1_000 },
            reservationMilliseconds: 60_000
          }
        },
        async resolveCurrent(_transaction: Knex.Transaction, _input: CurrentAdmissionResolverInput) {
          return {
            profileResolutionSha256: 'e'.repeat(64),
            providerProfileVersionId: profileVersionId,
            transportKind: 'test',
            model: 'test',
            executionMode: 'agent',
            profilePolicyVersion: 1,
            defaultGeneration: 1,
            capabilityRevision: 'v1',
            pricingRevision: 'v1',
            promptVersion: 1,
            quota: { tokens: 100, costMicros: 100 },
            quotaLimits: { dailyTokens: 1_000, dailyCostMicros: 1_000 },
            reservationMilliseconds: 60_000
          }
        }
      },
      {
        async execute(_request, sink) {
          await sink.event('model.turn', {
            turn: 1,
            outcome: 'answer_accepted',
            inputTokens: 10,
            outputTokens: 5,
            costMicros: 0,
            content: 'I found a stale runner configuration.',
            contentTruncated: false,
            actionCallIds: []
          })
          await sink.text('I found a stale runner configuration.')
          return { inputTokens: 10, outputTokens: 5, totalTokens: 15, costMicros: 0 }
        }
      },
      {
        workerId: 'title-test',
        globalConcurrency: 4,
        perUserConcurrency: 1,
        utilityModel: { generateConversationTitle }
      }
    )
    const admitted = await runtime.submit({
      ownerId: 9,
      sessionId: titledSessionId,
      profileResolutionToken: 'token',
      clientRequestId: '00000000-0000-4000-8000-000000000092',
      expectedSessionVersion: 1,
      content: 'Investigate intermittent deployment pipeline failures.'
    })

    expect(await runtime.runOnce()).toBe(true)
    expect(await knex('agentSessions').where({ id: titledSessionId }).first('title', 'titleSource', 'version')).toMatchObject({
      title: 'Deployment Pipeline Failures',
      titleSource: 'utility',
      version: 2
    })
    expect(await knex('agentRuns').where({ id: admitted.run.id }).first('status', 'inputTokens', 'outputTokens')).toMatchObject({
      status: 'succeeded',
      inputTokens: 12,
      outputTokens: 8
    })
    expect(generateConversationTitle.mock.calls[0]?.[0].messages).toEqual([
      { role: 'user', content: 'Investigate intermittent deployment pipeline failures.' },
      { role: 'assistant', content: 'I found a stale runner configuration.' }
    ])

    const refined = await runtime.submit({
      ownerId: 9,
      sessionId: titledSessionId,
      profileResolutionToken: 'token',
      clientRequestId: '00000000-0000-4000-8000-000000000093',
      expectedSessionVersion: 2,
      content: 'The failures happen during runner rollover.'
    })
    expect(await runtime.runOnce()).toBe(true)
    expect(await knex('agentSessions').where({ id: titledSessionId }).first('title', 'titleSource', 'version')).toMatchObject({
      title: 'Runner Rollover Configuration Failures',
      titleSource: 'utility',
      version: 3
    })
    expect(await knex('agentRuns').where({ id: refined.run.id }).first('status', 'inputTokens', 'outputTokens')).toMatchObject({
      status: 'succeeded',
      inputTokens: 14,
      outputTokens: 7
    })
    expect(generateConversationTitle.mock.calls[1]?.[0].messages).toEqual([
      { role: 'user', content: 'Investigate intermittent deployment pipeline failures.' },
      { role: 'assistant', content: 'I found a stale runner configuration.' },
      { role: 'user', content: 'The failures happen during runner rollover.' },
      { role: 'assistant', content: 'I found a stale runner configuration.' }
    ])
    await runtime.shutdown()
  })

  it('executes a durable specialist plan and gates root completion on every task', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    await knex('agentMessages').where({ id: userMessageId }).update({ content: 'Compare the alpha and beta deployment guides.' })
    await knex('agentRuns').where({ id: runId }).update({
      status: 'queued',
      attempts: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: now,
      completedAt: null
    })
    await reserveAgentRunQuota(
      knex,
      runId,
      7,
      { tokens: 10_000, costMicros: 1_000 },
      { dailyTokens: 20_000, dailyCostMicros: 2_000 },
      new Date('2026-08-17T00:10:00.000Z'),
      now
    )
    const engine: AgentEngine = {
      async execute(request, sink) {
        if (request.purpose === 'planner') {
          await sink.text(
            JSON.stringify({
              tasks: [
                { kind: 'source_scout', title: 'Review alpha', question: 'What does alpha require?', sourceScope: ['alpha'], requiredEvidenceCount: 1 },
                { kind: 'source_scout', title: 'Review beta', question: 'What does beta require?', sourceScope: ['beta'], requiredEvidenceCount: 1 }
              ]
            })
          )
          return { inputTokens: 3, outputTokens: 2, totalTokens: 5, costMicros: 0 }
        }
        if (request.purpose === 'subagent') {
          if (!request.task || !request.subagentRunId) throw new Error('missing child envelope')
          const alpha = request.task.title.includes('alpha')
          const pageId = alpha ? 1 : 2
          const evidenceId = `page:${pageId}`
          const revision = `rev-${pageId}`
          const claim = alpha ? 'Alpha requires review.' : 'Beta requires audit.'
          await sink.event('tool.started', {
            actionCallId: `read-${pageId}`,
            actionName: 'pages.get',
            title: 'Read page',
            risk: 'read',
            turn: 1,
            input: JSON.stringify({ id: pageId })
          })
          await sink.event('tool.completed', {
            actionCallId: `read-${pageId}`,
            actionName: 'pages.get',
            result: JSON.stringify({
              id: pageId,
              sourceRevision: revision,
              content: claim,
              citation: { evidenceId, label: alpha ? 'Alpha' : 'Beta', href: alpha ? '/en/alpha' : '/en/beta' },
              citationSections: []
            })
          })
          await sink.event('model.turn', {
            turn: 1,
            outcome: 'answer_accepted',
            inputTokens: 5,
            outputTokens: 3,
            content: claim,
            contentTruncated: false,
            actionCallIds: []
          })
          await sink.text(
            JSON.stringify({
              taskId: request.task.id,
              outcome: 'completed',
              claims: [{ text: `${claim} [[cite:${evidenceId}]]`, evidenceIds: [evidenceId], sourceRevisionIds: [revision], confidence: 'high' }],
              conflicts: [],
              unanswered: [],
              recommendedFollowups: []
            })
          )
          return { inputTokens: 5, outputTokens: 3, totalTokens: 8, costMicros: 0, authoritySha256: 'c'.repeat(64) }
        }
        expect(request.research).toMatchObject({ packets: [{ packet: { outcome: 'completed' } }, { packet: { outcome: 'completed' } }] })
        expect(request.research?.evidenceSeeds).toHaveLength(2)
        await sink.event('model.turn', {
          turn: 1,
          outcome: 'answer_accepted',
          inputTokens: 10,
          outputTokens: 5,
          content: 'Alpha and beta synthesis',
          contentTruncated: false,
          actionCallIds: []
        })
        await sink.text('Alpha requires review. [[cite:page:1]] Beta requires audit. [[cite:page:2]]')
        return {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          costMicros: 0,
          citations: [
            { evidenceId: 'page:1', kind: 'page', label: 'Alpha', href: '/en/alpha' },
            { evidenceId: 'page:2', kind: 'page', label: 'Beta', href: '/en/beta' }
          ]
        }
      }
    }
    const runtime = new AgentProductRuntime(
      knex,
      {
        async resolve(_transaction: Knex.Transaction, _input: AdmissionResolverInput) {
          throw new Error('not used')
        },
        async resolveCurrent(_transaction: Knex.Transaction, _input: CurrentAdmissionResolverInput) {
          throw new Error('not used')
        }
      },
      engine,
      {
        workerId: 'orchestration-test',
        globalConcurrency: 1,
        perUserConcurrency: 1,
        orchestration: { ...DEFAULT_AGENT_ORCHESTRATION_LIMITS, enabled: true }
      }
    )

    expect(await runtime.runOnce()).toBe(true)
    expect(await knex('agentRuns').where({ id: runId }).first('status', 'inputTokens', 'outputTokens', 'totalTokens')).toEqual({
      status: 'succeeded',
      inputTokens: 23,
      outputTokens: 13,
      totalTokens: 36
    })
    expect(await knex('agentRunTasks').where({ runId }).orderBy('ordinal').select('status', 'outcome', 'evidenceCount', 'authoritySha256')).toEqual([
      { status: 'completed', outcome: 'completed', evidenceCount: 1, authoritySha256: 'c'.repeat(64) },
      { status: 'completed', outcome: 'completed', evidenceCount: 1, authoritySha256: 'c'.repeat(64) }
    ])
    expect(await knex('agentEvents').where({ runId }).orderBy('sequence').pluck('type')).toEqual(
      expect.arrayContaining(['task.planCreated', 'task.created', 'subagent.started', 'subagent.completed', 'run.completed'])
    )
    const thread = await projectAgentThread(knex, 7, sessionId, { profileResolutionToken: () => 'token' })
    expect(thread.tasks).toHaveLength(2)
    await runtime.shutdown()
  })
  it('filters old pending settlements before the claim limit so a later run is not starved', async () => {
    const now = new Date('2026-08-17T00:02:00.000Z')
    const old = new Date('2026-08-17T00:00:00.000Z')
    const pendingRuns = Array.from({ length: 32 }, (_, index) => {
      const id = `00000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`
      return {
        id,
        sessionId,
        userMessageId: `00000000-0000-4000-8000-${String(200 + index).padStart(12, '0')}`,
        assistantMessageId: `00000000-0000-4000-8000-${String(300 + index).padStart(12, '0')}`,
        ownerId: 7,
        clientRequestId: `00000000-0000-4000-8000-${String(400 + index).padStart(12, '0')}`,
        clientRequestSha256: 'a'.repeat(64),
        profileResolutionSha256: 'b'.repeat(64),
        status: 'queued',
        attempts: 0,
        maxAttempts: 3,
        eventSequence: 0,
        availableAt: old,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        cancelRequestedAt: null,
        sideEffectsStarted: false,
        providerProfileVersionId: '00000000-0000-4000-8000-000000000007',
        transportKind: 'openai-responses',
        model: 'test',
        executionMode: 'agent',
        profilePolicyVersion: 1,
        defaultGeneration: 1,
        capabilityRevision: 'v1',
        pricingRevision: 'v1',
        promptVersion: 1,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostMicros: null,
        runtimeStateCiphertext: null,
        errorCode: null,
        errorMessage: null,
        queuedAt: old,
        startedAt: null,
        updatedAt: old,
        completedAt: null,
        goalId: null,
        goalContinuation: null,
        completionOutcome: null,
        completionAssessment: null,
        completionAssessmentSha256: null
      }
    })
    await knex('agentRuns').insert(pendingRuns)
    await knex('agentQuotaReservations').insert(
      pendingRuns.map(run => ({
        runId: run.id,
        ownerId: 7,
        day: '2026-08-17',
        reservedTokens: 1,
        reservedCostMicros: 1,
        consumedTokens: 1,
        consumedCostMicros: 1,
        status: 'reserved',
        expiresAt: old,
        heartbeatAt: old,
        reconciledAt: null
      }))
    )
    await knex('agentRuns').where({ id: runId }).update({
      status: 'queued',
      attempts: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: now,
      queuedAt: now,
      updatedAt: now
    })

    const claim = await claimAgentRun(knex, { workerId: 'worker-starvation', globalConcurrency: 1, perUserConcurrency: 1, now })

    expect(claim).toMatchObject({ id: runId, status: 'running', leaseOwner: 'worker-starvation' })
    expect(
      await knex('agentRuns')
        .whereIn(
          'id',
          pendingRuns.map(run => run.id)
        )
        .whereNot('status', 'queued')
        .count<{ count: number | string }[]>({ count: '*' })
        .first()
    ).toEqual({
      count: 0
    })
  })

  it('claims, fences, heartbeats, cancels, and refuses replay after side effects', async () => {
    const now = new Date('2026-08-17T00:02:00.000Z')
    const claim = await claimAgentRun(knex, { workerId: 'worker-b', globalConcurrency: 4, perUserConcurrency: 1, now })
    expect(claim).toMatchObject({ id: runId, status: 'running', attempts: 2, leaseOwner: 'worker-b' })
    if (!claim) throw new Error('expected claim')
    expect(await heartbeatAgentRun(knex, claim, 60_000, now)).toBe(true)
    await markAgentRunSideEffectsStarted(knex, claim, now)
    await knex('agentRuns')
      .where({ id: runId })
      .update({ leaseExpiresAt: new Date('2026-08-17T00:01:00.000Z') })
    expect(await claimAgentRun(knex, { workerId: 'worker-c', globalConcurrency: 4, perUserConcurrency: 1, now })).toBeNull()
    expect(await knex('agentRuns').where({ id: runId }).first('status', 'errorCode')).toMatchObject({
      status: 'recovery_required',
      errorCode: 'LEASE_LOST_AFTER_SIDE_EFFECT'
    })
    await expect(Promise.resolve(transitionAgentRun(knex, { claim, from: 'running', to: 'succeeded', now }))).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })

    await knex('agentRuns').where({ id: runId }).update({
      status: 'queued',
      attempts: 0,
      sideEffectsStarted: false,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      cancelRequestedAt: null,
      completedAt: null
    })
    const cancelled = await requestAgentRunCancellation(knex, 7, runId, now)
    expect(cancelled.status).toBe('cancelled')
    await expect(Promise.resolve(requestAgentRunCancellation(knex, 8, runId, now))).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND' })
  })

  it('runs one fenced coordinator attempt and stops claiming on shutdown', async () => {
    await knex('agentRuns')
      .where({ id: runId })
      .update({ status: 'queued', attempts: 0, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, availableAt: new Date('2026-08-17T00:00:00.000Z') })
    const coordinator = new AgentRunCoordinator(knex, {
      workerId: 'worker-loop',
      globalConcurrency: 4,
      perUserConcurrency: 1,
      leaseMilliseconds: 60_000,
      heartbeatMilliseconds: 5_000,
      now: new Date('2026-08-17T00:02:00.000Z')
    })
    expect(
      await coordinator.runOnce(async (claim, signal) => {
        expect(claim.leaseToken).toBeTruthy()
        expect(signal.aborted).toBe(false)
        return { status: 'succeeded' }
      })
    ).toBe(true)
    expect(await knex('agentRuns').where({ id: runId }).first('status', 'leaseToken')).toMatchObject({ status: 'succeeded', leaseToken: null })
    await coordinator.shutdown()
    expect(await coordinator.runOnce(async () => ({ status: 'succeeded' }))).toBe(false)
  })

  it('aborts an active handler and commits cancellation as the terminal state', async () => {
    await knex('agentRuns')
      .where({ id: runId })
      .update({
        status: 'queued',
        attempts: 0,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        cancelRequestedAt: null,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        availableAt: new Date('2026-08-17T00:00:00.000Z')
      })
    const coordinator = new AgentRunCoordinator(knex, {
      workerId: 'worker-cancel',
      globalConcurrency: 1,
      perUserConcurrency: 1,
      leaseMilliseconds: 60_000,
      heartbeatMilliseconds: 5_000,
      now: new Date('2026-08-17T00:02:00.000Z')
    })
    const entered = Promise.withResolvers<void>()
    const running = coordinator.runOnce(async (_claim, signal) => {
      entered.resolve()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'failed', errorCode: 'AGENT_ENGINE_FAILED' }
    })
    await entered.promise
    expect(await coordinator.cancel(7, runId)).toMatchObject({ cancelRequestedAt: expect.any(String) })
    expect(await running).toBe(true)
    expect(await knex('agentRuns').where({ id: runId }).first('status', 'errorCode', 'completedAt')).toMatchObject({
      status: 'cancelled',
      errorCode: null,
      completedAt: expect.anything()
    })
    expect(await knex('agentMessages').where({ runId, role: 'assistant' }).first('status')).toEqual({ status: 'cancelled' })
    expect(await knex('agentEvents').where({ runId, type: 'run.cancelled' }).first('sequence', 'data')).toMatchObject({
      sequence: expect.any(Number),
      data: expect.stringContaining('"status":"cancelled"')
    })
    await coordinator.shutdown()
  })

  it('finishes from the live run state after an approval wait', async () => {
    const reset = {
      status: 'queued',
      attempts: 0,
      sideEffectsStarted: false,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      availableAt: new Date('2026-08-17T00:00:00.000Z'),
      cancelRequestedAt: null,
      completedAt: null,
      errorCode: null,
      errorMessage: null
    }
    await knex('agentRuns').where({ id: runId }).update(reset)
    const coordinator = new AgentRunCoordinator(knex, {
      workerId: 'worker-approval',
      globalConcurrency: 1,
      perUserConcurrency: 1,
      leaseMilliseconds: 60_000,
      heartbeatMilliseconds: 5_000,
      now: new Date('2026-08-17T00:02:00.000Z')
    })
    await coordinator.runOnce(async claim => {
      await knex('agentRuns').where({ id: claim.id, leaseToken: claim.leaseToken, status: 'running' }).update({ status: 'awaiting_approval' })
      await knex('agentRuns').where({ id: claim.id, leaseToken: claim.leaseToken, status: 'awaiting_approval' }).update({ status: 'running' })
      return { status: 'succeeded' }
    })
    expect(await knex('agentRuns').where({ id: runId }).first('status')).toEqual({ status: 'succeeded' })

    await knex('agentRuns').where({ id: runId }).update(reset)
    await coordinator.runOnce(async claim => {
      await knex('agentRuns').where({ id: claim.id, leaseToken: claim.leaseToken, status: 'running' }).update({ status: 'awaiting_approval' })
      return { status: 'failed', errorCode: 'PROVIDER_REPLAY_FAILED' }
    })
    expect(await knex('agentRuns').where({ id: runId }).first('status', 'errorCode')).toEqual({
      status: 'recovery_required',
      errorCode: 'PROVIDER_REPLAY_FAILED'
    })
    await coordinator.shutdown()
  })

  it('aborts and drains active handlers before shutdown returns', async () => {
    await knex('agentRuns')
      .where({ id: runId })
      .update({
        status: 'queued',
        attempts: 0,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        availableAt: new Date('2026-08-17T00:00:00.000Z'),
        completedAt: null
      })
    const coordinator = new AgentRunCoordinator(knex, {
      workerId: 'worker-drain',
      globalConcurrency: 1,
      perUserConcurrency: 1,
      leaseMilliseconds: 60_000,
      heartbeatMilliseconds: 5_000,
      now: new Date('2026-08-17T00:02:00.000Z')
    })
    const entered = Promise.withResolvers<void>()
    let drained = false
    const running = coordinator.runOnce(async (_claim, signal) => {
      entered.resolve()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      await Promise.resolve()
      drained = true
      return { status: 'failed' }
    })
    await entered.promise
    await coordinator.shutdown()
    expect(drained).toBe(true)
    expect(await running).toBe(true)
  })
})
