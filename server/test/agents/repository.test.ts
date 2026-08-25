/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import createKnex, { type Knex } from 'knex'
import {
  appendAgentEvent,
  appendAgentMessage,
  createAgentSession,
  getOwnedAgentArtifact,
  getOwnedAgentSession,
  listOwnedAgentEvents,
  storeAgentScreenshot,
  updateAgentSession
} from '../../agents/repository.ts'
import { projectAgentThread, reduceAgentEvents } from '../../agents/projection.ts'
import {
  AgentRunCoordinator,
  admitAgentRun,
  claimAgentRun,
  heartbeatAgentRun,
  markAgentRunSideEffectsStarted,
  reconcileAgentRunQuota,
  requestAgentRunCancellation,
  reserveAgentRunQuota,
  transitionAgentRun
} from '../../agents/coordinator.ts'
import { AgentProductRuntime, type AgentEngine } from '../../agents/runtime.ts'

const sessionId = '00000000-0000-4000-8000-000000000001'
const runId = '00000000-0000-4000-8000-000000000002'
const userMessageId = '00000000-0000-4000-8000-000000000003'
const assistantMessageId = '00000000-0000-4000-8000-000000000004'

const createTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('agentSessions', table => {
    table.uuid('id').primary()
    table.integer('ownerId').notNullable()
    table.string('title').notNullable()
    table.string('retention').notNullable()
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
  await knex.schema.createTable('agentMessages', table => {
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
    table.integer('estimatedCostMicros').nullable()
    table.string('errorCode').nullable()
    table.text('errorMessage').nullable()
    table.dateTime('queuedAt').notNullable()
    table.dateTime('startedAt').nullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('completedAt').nullable()
  })
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
    estimatedCostMicros: null,
    errorCode: null,
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
    await createAgentSession(knex, { id: sessionId, ownerId: 7, title: 'Thread', retention: 'saved', providerProfileId: null, executionMode: 'agent' })
    await appendAgentMessage(knex, { id: userMessageId, ownerId: 7, sessionId, role: 'user', status: 'complete', content: 'Question' })
    await appendAgentMessage(knex, { id: assistantMessageId, ownerId: 7, sessionId, role: 'assistant', status: 'streaming', content: '' })
    await insertRun(knex)
    await knex('agentMessages').whereIn('id', [userMessageId, assistantMessageId]).update({ runId })
  })

  afterEach(async () => knex.destroy())

  it('isolates owners and enforces optimistic session versions', async () => {
    await expect(getOwnedAgentSession(knex, 8, sessionId)).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND', status: 404 })
    const updated = await updateAgentSession(knex, { ownerId: 7, sessionId, expectedVersion: 1, title: 'Renamed' })
    expect(updated).toMatchObject({ title: 'Renamed', version: 2 })
    await expect(updateAgentSession(knex, { ownerId: 7, sessionId, expectedVersion: 1, title: 'Lost race' })).rejects.toMatchObject({ code: 'SESSION_VERSION_CHANGED', status: 409 })
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
    await expect(knex('agentSessions').where({ id: snapshotSessionId }).first('memorySnapshot')).resolves.toMatchObject({ memorySnapshot })
    await expect(createAgentSession(knex, {
      id: '00000000-0000-4000-8000-000000000006',
      ownerId: 7,
      retention: 'saved',
      providerProfileId: null,
      executionMode: 'agent',
      memorySnapshot: 'x'.repeat(16_385)
    })).rejects.toMatchObject({ code: 'INVALID_AGENT_MEMORY', status: 400 })
  })

  it('appends contiguous hash-verified events and makes exact IDs idempotent', async () => {
    const eventInput = { id: '00000000-0000-4000-8000-000000000010', runId, ownerId: 7, type: 'tool.started' as const, attempt: 1, data: { actionCallId: 'call-1', actionName: 'pages.get', title: 'Read page', risk: 'read' } }
    const first = await appendAgentEvent(knex, eventInput)
    const replay = await appendAgentEvent(knex, eventInput)
    expect(replay).toEqual(first)
    await expect(appendAgentEvent(knex, { ...eventInput, data: { ...eventInput.data, title: 'Changed' } })).rejects.toMatchObject({ code: 'AGENT_EVENT_IDEMPOTENCY_MISMATCH', status: 409 })
    await appendAgentEvent(knex, { id: '00000000-0000-4000-8000-000000000011', runId, ownerId: 7, type: 'tool.completed', attempt: 1, data: { actionCallId: 'call-1', summary: 'Done' } })
    await appendAgentEvent(knex, {
      id: '00000000-0000-4000-8000-000000000012',
      runId,
      ownerId: 7,
      type: 'evidence.provenance',
      attempt: 1,
      data: {
        accepted: true,
        retrievals: [{ actionCallId: 'call-1', actionName: 'pages.get', evidenceIds: ['page:42', 'page:42:section:1'] }],
        claims: [{ claim: 'Install the package.', evidenceId: 'page:42:section:1', pageEvidenceId: 'page:42', sourceActionCallId: 'call-1', sourceActionName: 'pages.get', section: true, supported: true, matchedTerms: ['install', 'package'] }],
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
    await expect(listOwnedAgentEvents(knex, 7, runId)).rejects.toMatchObject({ code: 'AGENT_EVENT_CORRUPT', status: 500 })
  })


  it('integrity-checks owner-scoped artifact payloads', async () => {
    const payload = Buffer.from('89504e470d0a1a0a00', 'hex')
    const id = await storeAgentScreenshot(knex, { ownerId: 7, sessionId, runId, payload, width: 1, height: 1 })
    await expect(getOwnedAgentArtifact(knex, 8, id)).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND' })
    await expect(getOwnedAgentArtifact(knex, 7, id)).resolves.toMatchObject({ id, byteLength: payload.length, mimeType: 'image/png' })
    await knex('agentArtifacts').where({ id }).update({ payload: Buffer.from('89504e470d0a1a0aff', 'hex') })
    await expect(getOwnedAgentArtifact(knex, 7, id)).rejects.toMatchObject({ code: 'AGENT_ARTIFACT_CORRUPT' })
  })

  it('projects the same terminal tool state from durable events', async () => {
    await appendAgentEvent(knex, { id: '00000000-0000-4000-8000-000000000020', runId, ownerId: 7, type: 'tool.started', attempt: 1, data: { actionCallId: 'call-1', actionName: 'pages.get', title: 'Read page', risk: 'read' } })
    await appendAgentEvent(knex, { id: '00000000-0000-4000-8000-000000000021', runId, ownerId: 7, type: 'tool.completed', attempt: 1, data: { actionCallId: 'call-1', summary: 'Read one page' } })
    await appendAgentEvent(knex, { id: '00000000-0000-4000-8000-000000000022', runId, ownerId: 7, type: 'suggestions.updated', attempt: 1, data: { suggestions: [{ id: 'next', label: 'Continue', prompt: 'Continue' }] } })
    const events = await listOwnedAgentEvents(knex, 7, runId)
    const reduced = reduceAgentEvents(events)
    const projected = await projectAgentThread(knex, 7, sessionId, { profileResolutionToken: session => `profile:${session.id}:${session.version}`, now: new Date('2026-08-17T00:00:00.000Z') })
    expect(projected.tools).toEqual(reduced.tools)
    expect(projected.suggestions).toEqual(reduced.suggestions)
    expect(projected.session.currentRun).toMatchObject({ id: runId, eventSequence: 3, canCancel: true })
    expect(projected.messages.map(message => message.content)).toEqual(['Question', ''])
  })

  it('projects durable links for applied page destinations', async () => {
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
      { ...row, id: '00000000-0000-4000-8000-000000000041', actionName: 'pages.prepareCreate', operation: JSON.stringify({ locale: 'en', path: 'example-page' }) },
      { ...row, id: '00000000-0000-4000-8000-000000000042', actionName: 'pages.preparePatch', pageId: 42, baseSourceRevision: 3, operation: JSON.stringify({ locale: 'en', path: 'old-path' }) },
      { ...row, id: '00000000-0000-4000-8000-000000000043', actionName: 'pages.prepareMove', pageId: 42, baseSourceRevision: 3, operation: JSON.stringify({ locale: 'en', path: 'handbook/example-page' }) },
      { ...row, id: '00000000-0000-4000-8000-000000000044', actionName: 'pages.prepareDelete', pageId: 42, baseSourceRevision: 3, operation: JSON.stringify({ locale: 'en', path: 'old-path' }) }
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
  })

  it('reserves and reconciles quota without double-counting retries', async () => {
    const now = new Date('2026-08-17T00:00:00.000Z')
    const expiresAt = new Date('2026-08-17T00:05:00.000Z')
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 200 }, { dailyTokens: 150, dailyCostMicros: 300 }, expiresAt, now)
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 200 }, { dailyTokens: 150, dailyCostMicros: 300 }, expiresAt, now)
    await expect(reserveAgentRunQuota(knex, '00000000-0000-4000-8000-000000000030', 7, { tokens: 51, costMicros: 1 }, { dailyTokens: 150, dailyCostMicros: 300 }, expiresAt, now)).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED', status: 429 })
    await reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 80, consumedCostMicros: 150, status: 'consumed', now })
    await reconcileAgentRunQuota(knex, { runId, ownerId: 7, consumedTokens: 80, consumedCostMicros: 150, status: 'consumed', now })
    await expect(knex('agentQuotaDaily').where({ ownerId: 7 }).first()).resolves.toMatchObject({ reservedTokens: 0, consumedTokens: 80, reservedCostMicros: 0, consumedCostMicros: 150 })
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
    await reserveAgentRunQuota(knex, runId, 7, { tokens: 100, costMicros: 200 }, { dailyTokens: 150, dailyCostMicros: 300 }, new Date('2026-08-17T00:05:00.000Z'), now)
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
    const runtime = new AgentProductRuntime(knex, { async resolve() { throw new Error('not used') } }, engine, {
      workerId: 'worker-approval-shutdown',
      globalConcurrency: 1,
      perUserConcurrency: 1,
      leaseMilliseconds: 60_000,
      heartbeatMilliseconds: 5_000
    })
    const running = runtime.runOnce()
    await entered.promise
    await runtime.shutdown()
    await expect(running).resolves.toBe(true)
    await expect(knex('agentRuns').where({ id: runId }).first('status')).resolves.toEqual({ status: 'awaiting_approval' })
    await expect(knex('agentQuotaReservations').where({ runId }).first('status')).resolves.toEqual({ status: 'reserved' })
    await expect(knex('agentEvents').where({ runId }).orderBy('sequence').pluck('type')).resolves.toEqual(['run.attemptStarted', 'message.started'])
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
    await expect(admitAgentRun(knex, { ...input, content: 'Different' })).rejects.toMatchObject({ code: 'RUN_IDEMPOTENCY_MISMATCH', status: 409 })
    expect(await knex('agentMessages').where({ sessionId: secondSessionId }).orderBy('ordinal').pluck('status')).toEqual(['complete', 'pending'])
    const queuedEvent = await knex('agentEvents').where({ runId: input.id }).first('type', 'data')
    expect(queuedEvent?.type).toBe('run.queued')
    expect(JSON.parse(String(queuedEvent?.data))).toMatchObject({ runId: input.id, status: 'queued', currentPage: input.currentPage })

    const failedSessionId = '00000000-0000-4000-8000-000000000038'
    await createAgentSession(knex, { id: failedSessionId, ownerId: 8, retention: 'temporary', providerProfileId: null, executionMode: 'agent' })
    await expect(admitAgentRun(knex, {
      ...input,
      id: '00000000-0000-4000-8000-000000000039',
      userMessageId: '00000000-0000-4000-8000-000000000041',
      assistantMessageId: '00000000-0000-4000-8000-000000000042',
      queuedEventId: '00000000-0000-4000-8000-000000000043',
      sessionId: failedSessionId,
      ownerId: 8,
      clientRequestId: '00000000-0000-4000-8000-000000000040',
      quotaLimits: { dailyTokens: 0, dailyCostMicros: 0 }
    })).rejects.toMatchObject({ code: 'AGENT_QUOTA_EXHAUSTED' })
    expect(await knex('agentRuns').where({ sessionId: failedSessionId }).count<{ count: number }[]>({ count: '*' }).first()).toMatchObject({ count: 0 })
    expect(await knex('agentMessages').where({ sessionId: failedSessionId }).count<{ count: number }[]>({ count: '*' }).first()).toMatchObject({ count: 0 })
  })

  it('deduplicates preferred and invoked versions by skill identity with preferences taking precedence', async () => {
    const dedupeSessionId = '00000000-0000-4000-8000-000000000080'
    const preferredVersionId = '00000000-0000-4000-8000-000000000081'
    const alternateVersionId = '00000000-0000-4000-8000-000000000082'
    const otherVersionId = '00000000-0000-4000-8000-000000000083'
    const firstSkillId = '00000000-0000-4000-8000-000000000084'
    const secondSkillId = '00000000-0000-4000-8000-000000000085'
    const now = new Date()
    await createAgentSession(knex, { id: dedupeSessionId, ownerId: 7, retention: 'saved', providerProfileId: null, executionMode: 'agent' })
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
    const runtime = new AgentProductRuntime(knex, {
      async resolve() {
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
    }, {
      async execute() {
        return { inputTokens: 0, outputTokens: 0, costMicros: 0 }
      }
    }, { workerId: 'dedupe-test', globalConcurrency: 1, perUserConcurrency: 1 })
    const admitted = await runtime.submit({
      ownerId: 7,
      sessionId: dedupeSessionId,
      profileResolutionToken: 'token',
      clientRequestId: '00000000-0000-4000-8000-000000000087',
      expectedSessionVersion: 1,
      content: 'Use the available skills.',
      invokedSkillVersionIds: [alternateVersionId, otherVersionId]
    })
    expect(await knex('agentRunSkills').where({ runId: admitted.run.id }).orderBy('ordinal').pluck('skillVersionId')).toEqual([preferredVersionId, otherVersionId])
    await runtime.shutdown()
  })

  it('titles the first successful exchange with utility usage included in the run', async () => {
    const titledSessionId = '00000000-0000-4000-8000-000000000090'
    const profileVersionId = '00000000-0000-4000-8000-000000000091'
    await knex('agentRuns').where({ id: runId }).delete()
    await createAgentSession(knex, { id: titledSessionId, ownerId: 9, retention: 'saved', providerProfileId: null, executionMode: 'agent' })
    const generateConversationTitle = async () => ({ title: 'Deployment Pipeline Failures', inputTokens: 2, outputTokens: 3 })
    const runtime = new AgentProductRuntime(knex, {
      async resolve() {
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
    }, {
      async execute(_request, sink) {
        await sink.text('I found a stale runner configuration.')
        return { inputTokens: 10, outputTokens: 5, costMicros: 0 }
      }
    }, {
      workerId: 'title-test',
      globalConcurrency: 4,
      perUserConcurrency: 1,
      utilityModel: { generateConversationTitle }
    })
    const admitted = await runtime.submit({
      ownerId: 9,
      sessionId: titledSessionId,
      profileResolutionToken: 'token',
      clientRequestId: '00000000-0000-4000-8000-000000000092',
      expectedSessionVersion: 1,
      content: 'Investigate intermittent deployment pipeline failures.'
    })

    await expect(runtime.runOnce()).resolves.toBe(true)
    await expect(knex('agentSessions').where({ id: titledSessionId }).first('title', 'version')).resolves.toMatchObject({ title: 'Deployment Pipeline Failures', version: 2 })
    await expect(knex('agentRuns').where({ id: admitted.run.id }).first('status', 'inputTokens', 'outputTokens')).resolves.toMatchObject({ status: 'succeeded', inputTokens: 12, outputTokens: 8 })
    await runtime.shutdown()
  })

  it('claims, fences, heartbeats, cancels, and refuses replay after side effects', async () => {
    const now = new Date('2026-08-17T00:02:00.000Z')
    const claim = await claimAgentRun(knex, { workerId: 'worker-b', globalConcurrency: 4, perUserConcurrency: 1, now })
    expect(claim).toMatchObject({ id: runId, status: 'running', attempts: 2, leaseOwner: 'worker-b' })
    if (!claim) throw new Error('expected claim')
    await expect(heartbeatAgentRun(knex, claim, 60_000, now)).resolves.toBe(true)
    await markAgentRunSideEffectsStarted(knex, claim, now)
    await knex('agentRuns').where({ id: runId }).update({ leaseExpiresAt: new Date('2026-08-17T00:01:00.000Z') })
    await expect(claimAgentRun(knex, { workerId: 'worker-c', globalConcurrency: 4, perUserConcurrency: 1, now })).resolves.toBeNull()
    await expect(knex('agentRuns').where({ id: runId }).first('status', 'errorCode')).resolves.toMatchObject({ status: 'recovery_required', errorCode: 'LEASE_LOST_AFTER_SIDE_EFFECT' })
    await expect(transitionAgentRun(knex, { claim, from: 'running', to: 'succeeded', now })).rejects.toMatchObject({ code: 'RUN_LEASE_LOST' })

    await knex('agentRuns').where({ id: runId }).update({ status: 'queued', attempts: 0, sideEffectsStarted: false, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, cancelRequestedAt: null, completedAt: null })
    const cancelled = await requestAgentRunCancellation(knex, 7, runId, now)
    expect(cancelled.status).toBe('cancelled')
    await expect(requestAgentRunCancellation(knex, 8, runId, now)).rejects.toMatchObject({ code: 'AGENT_RESOURCE_NOT_FOUND' })
  })

  it('runs one fenced coordinator attempt and stops claiming on shutdown', async () => {
    await knex('agentRuns').where({ id: runId }).update({ status: 'queued', attempts: 0, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, availableAt: new Date('2026-08-17T00:00:00.000Z') })
    const coordinator = new AgentRunCoordinator(knex, { workerId: 'worker-loop', globalConcurrency: 4, perUserConcurrency: 1, leaseMilliseconds: 60_000, heartbeatMilliseconds: 5_000, now: new Date('2026-08-17T00:02:00.000Z') })
    await expect(coordinator.runOnce(async (claim, signal) => {
      expect(claim.leaseToken).toBeTruthy()
      expect(signal.aborted).toBe(false)
      return { status: 'succeeded' }
    })).resolves.toBe(true)
    await expect(knex('agentRuns').where({ id: runId }).first('status', 'leaseToken')).resolves.toMatchObject({ status: 'succeeded', leaseToken: null })
    await coordinator.shutdown()
    await expect(coordinator.runOnce(async () => ({ status: 'succeeded' }))).resolves.toBe(false)
  })

  it('aborts an active handler and commits cancellation as the terminal state', async () => {
    await knex('agentRuns').where({ id: runId }).update({
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
    const coordinator = new AgentRunCoordinator(knex, { workerId: 'worker-cancel', globalConcurrency: 1, perUserConcurrency: 1, leaseMilliseconds: 60_000, heartbeatMilliseconds: 5_000, now: new Date('2026-08-17T00:02:00.000Z') })
    const entered = Promise.withResolvers<void>()
    const running = coordinator.runOnce(async (_claim, signal) => {
      entered.resolve()
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return { status: 'failed', errorCode: 'AGENT_ENGINE_FAILED' }
    })
    await entered.promise
    await expect(coordinator.cancel(7, runId)).resolves.toMatchObject({ cancelRequestedAt: expect.any(String) })
    await expect(running).resolves.toBe(true)
    await expect(knex('agentRuns').where({ id: runId }).first('status', 'errorCode', 'completedAt')).resolves.toMatchObject({ status: 'cancelled', errorCode: null, completedAt: expect.anything() })
    await expect(knex('agentMessages').where({ runId, role: 'assistant' }).first('status')).resolves.toEqual({ status: 'cancelled' })
    await expect(knex('agentEvents').where({ runId, type: 'run.cancelled' }).first('sequence', 'data')).resolves.toMatchObject({ sequence: expect.any(Number), data: expect.stringContaining('"status":"cancelled"') })
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
    const coordinator = new AgentRunCoordinator(knex, { workerId: 'worker-approval', globalConcurrency: 1, perUserConcurrency: 1, leaseMilliseconds: 60_000, heartbeatMilliseconds: 5_000, now: new Date('2026-08-17T00:02:00.000Z') })
    await coordinator.runOnce(async claim => {
      await knex('agentRuns').where({ id: claim.id, leaseToken: claim.leaseToken, status: 'running' }).update({ status: 'awaiting_approval' })
      await knex('agentRuns').where({ id: claim.id, leaseToken: claim.leaseToken, status: 'awaiting_approval' }).update({ status: 'running' })
      return { status: 'succeeded' }
    })
    await expect(knex('agentRuns').where({ id: runId }).first('status')).resolves.toEqual({ status: 'succeeded' })

    await knex('agentRuns').where({ id: runId }).update(reset)
    await coordinator.runOnce(async claim => {
      await knex('agentRuns').where({ id: claim.id, leaseToken: claim.leaseToken, status: 'running' }).update({ status: 'awaiting_approval' })
      return { status: 'failed', errorCode: 'PROVIDER_REPLAY_FAILED' }
    })
    await expect(knex('agentRuns').where({ id: runId }).first('status', 'errorCode')).resolves.toEqual({ status: 'recovery_required', errorCode: 'PROVIDER_REPLAY_FAILED' })
    await coordinator.shutdown()
  })

  it('aborts and drains active handlers before shutdown returns', async () => {
    await knex('agentRuns').where({ id: runId }).update({ status: 'queued', attempts: 0, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, availableAt: new Date('2026-08-17T00:00:00.000Z'), completedAt: null })
    const coordinator = new AgentRunCoordinator(knex, { workerId: 'worker-drain', globalConcurrency: 1, perUserConcurrency: 1, leaseMilliseconds: 60_000, heartbeatMilliseconds: 5_000, now: new Date('2026-08-17T00:02:00.000Z') })
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
    await expect(running).resolves.toBe(true)
  })
})
