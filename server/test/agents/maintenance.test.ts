import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'
import { requestUnfiledAgentHistoryClear, runAgentMaintenance } from '../../agents/maintenance.ts'

const now = new Date('2026-08-17T12:00:00.000Z')
const old = new Date('2026-05-01T00:00:00.000Z')
const expired = new Date('2026-08-10T00:00:00.000Z')

const createTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('agentSessions', table => {
    table.string('id').primary()
    table.integer('ownerId')
    table.string('retention')
    table.string('folderId').nullable()
    table.dateTime('expiresAt').nullable()
    table.dateTime('deletedAt').nullable()
    table.dateTime('updatedAt')
    table.dateTime('lastActivityAt')
    table.integer('version')
  })
  await knex.schema.createTable('agentConversationFolders', table => {
    table.string('id').primary()
    table.integer('ownerId')
    table.string('name')
    table.string('normalizedName')
    table.integer('version')
    table.dateTime('createdAt')
    table.dateTime('updatedAt')
  })
  await knex.schema.createTable('agentMessages', table => {
    table.string('id').primary()
    table.string('sessionId')
    table.string('runId').nullable()
    table.integer('ordinal')
    table.string('role')
    table.string('status')
    table.text('content')
    table.text('citations').nullable()
    table.binary('providerStateCiphertext').nullable()
    table.string('providerStateSha256').nullable()
    table.dateTime('createdAt')
    table.dateTime('updatedAt')
  })
  await knex.schema.createTable('agentRuns', table => {
    table.string('id').primary()
    table.string('sessionId')
    table.integer('ownerId')
    table.string('userMessageId').nullable()
    table.string('assistantMessageId').nullable()
    table.string('status')
    table.integer('attempts').defaultTo(0)
    table.integer('maxAttempts').defaultTo(3)
    table.integer('eventSequence').defaultTo(0)
    table.boolean('sideEffectsStarted')
    table.dateTime('cancelRequestedAt').nullable()
    table.dateTime('leaseExpiresAt').nullable()
    table.string('leaseOwner').nullable()
    table.string('leaseToken').nullable()
    table.dateTime('availableAt').nullable()
    table.binary('runtimeStateCiphertext').nullable()
    table.dateTime('updatedAt')
    table.dateTime('queuedAt').nullable()
    table.dateTime('startedAt').nullable()
    table.dateTime('completedAt').nullable()
    table.string('errorCode').nullable()
    table.string('errorMessage').nullable()
  })
  await knex.schema.createTable('agentProposals', table => {
    table.string('id').primary()
    table.string('sourceKind')
    table.string('sessionId').nullable()
    table.string('status')
    table.dateTime('expiresAt')
    table.dateTime('createdAt')
    table.dateTime('contentPurgedAt').nullable()
    table.text('input').nullable()
    table.text('patch').nullable()
    table.text('diff').nullable()
    table.text('applyResult').nullable()
  })
  await knex.schema.createTable('agentApprovals', table => {
    table.string('id').primary()
    table.string('proposalId')
    table.string('status')
    table.dateTime('decidedAt').nullable()
    table.text('decisionNote').nullable()
  })
  await knex.schema.createTable('agentActionExecutions', table => {
    table.string('id').primary()
    table.string('proposalId')
    table.string('status')
    table.dateTime('startedAt').nullable()
    table.text('result').nullable()
    table.text('error').nullable()
  })
  await knex.schema.createTable('agentArtifacts', table => {
    table.string('id').primary()
    table.binary('payload').nullable()
    table.text('metadata').nullable()
    table.dateTime('expiresAt').nullable()
  })
  await knex.schema.createTable('agentSkillUses', table => {
    table.string('id').primary()
    table.string('sessionId').nullable()
    table.string('runId').nullable()
    table.integer('requesterApiKeyId').nullable()
    table.text('resourcePath').nullable()
    table.string('externalSessionSha256').nullable()
    table.dateTime('createdAt')
  })
  await knex.schema.createTable('agentEvents', table => {
    table.string('id').primary()
    table.string('runId')
    table.integer('sequence')
    table.string('type')
    table.integer('attempt')
    table.integer('schemaVersion')
    table.text('data')
    table.string('dataSha256')
    table.dateTime('createdAt')
  })
  await knex.schema.createTable('agentQuotaReservations', table => {
    table.string('runId').primary()
    table.integer('ownerId')
    table.string('day')
    table.integer('reservedTokens')
    table.integer('reservedCostMicros')
    table.integer('consumedTokens')
    table.integer('consumedCostMicros')
    table.string('status')
    table.dateTime('expiresAt')
    table.dateTime('heartbeatAt')
    table.dateTime('reconciledAt').nullable()
  })
  await knex.schema.createTable('agentQuotaDaily', table => {
    table.integer('ownerId')
    table.string('day')
    table.integer('reservedTokens')
    table.integer('consumedTokens')
    table.integer('reservedCostMicros')
    table.integer('consumedCostMicros')
    table.dateTime('updatedAt')
  })
  await knex.schema.createTable('agentUsageLedger', table => {
    table.string('id').primary()
    table.dateTime('createdAt')
  })
}

describe('agent retention maintenance', () => {
  let knex: Knex
  beforeEach(async () => {
    knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createTables(knex)
  })
  afterEach(async () => knex.destroy())

  it('recovers leases and applies bounded content, artifact, audit, and quota retention', async () => {
    await knex('agentSessions').insert([
      { id: 'session-live', ownerId: 7, retention: 'saved', expiresAt: null, deletedAt: null, updatedAt: old, lastActivityAt: now, version: 1 },
      { id: 'session-expired', ownerId: 7, retention: 'temporary', expiresAt: expired, deletedAt: null, updatedAt: old, lastActivityAt: old, version: 1 }
    ])
    const run = (id: string, status: string, sideEffectsStarted: boolean, cancelRequestedAt: Date | null = null) => ({
      id,
      sessionId: 'session-live',
      ownerId: 7,
      assistantMessageId: `assistant-${id}`,
      status,
      attempts: status === 'queued' ? 0 : 1,
      eventSequence: 0,
      sideEffectsStarted,
      cancelRequestedAt,
      leaseExpiresAt: expired,
      leaseOwner: 'dead-worker',
      leaseToken: `lease-${id}`,
      availableAt: old,
      runtimeStateCiphertext: null,
      queuedAt: old,
      startedAt: status === 'queued' ? null : old,
      updatedAt: old,
      completedAt: null,
      errorCode: null,
      errorMessage: null
    })
    await knex('agentRuns').insert([
      run('run-safe', 'running', false),
      run('run-unsafe', 'running', true),
      run('run-cancel', 'queued', false, expired),
      { ...run('run-complete', 'succeeded', false), completedAt: old }
    ])
    await knex('agentMessages').insert([
      {
        id: 'assistant-run-unsafe',
        sessionId: 'session-live',
        runId: 'run-unsafe',
        ordinal: 1,
        role: 'assistant',
        status: 'streaming',
        content: 'Partial provider output',
        citations: null,
        providerStateCiphertext: null,
        providerStateSha256: null,
        createdAt: old,
        updatedAt: old
      },
      {
        id: 'assistant-run-cancel',
        sessionId: 'session-live',
        runId: 'run-cancel',
        ordinal: 2,
        role: 'assistant',
        status: 'pending',
        content: '',
        citations: null,
        providerStateCiphertext: null,
        providerStateSha256: null,
        createdAt: old,
        updatedAt: old
      }
    ])
    await knex('agentProposals').insert([
      {
        id: 'proposal-content',
        sourceKind: 'mcp',
        sessionId: null,
        status: 'denied',
        expiresAt: expired,
        createdAt: expired,
        contentPurgedAt: null,
        input: '{}',
        patch: 'secret',
        diff: 'secret',
        applyResult: 'secret'
      },
      {
        id: 'proposal-audit',
        sourceKind: 'mcp',
        sessionId: null,
        status: 'failed',
        expiresAt: old,
        createdAt: old,
        contentPurgedAt: expired,
        input: null,
        patch: null,
        diff: null,
        applyResult: null
      },
      {
        id: 'proposal-pending',
        sourceKind: 'agent',
        sessionId: 'session-live',
        status: 'pending',
        expiresAt: expired,
        createdAt: expired,
        contentPurgedAt: null,
        input: '{}',
        patch: null,
        diff: null,
        applyResult: null
      },
      {
        id: 'proposal-applying',
        sourceKind: 'agent',
        sessionId: 'session-live',
        status: 'applying',
        expiresAt: new Date('2026-08-18T00:00:00.000Z'),
        createdAt: old,
        contentPurgedAt: null,
        input: '{}',
        patch: null,
        diff: null,
        applyResult: null
      }
    ])
    await knex('agentApprovals').insert([
      { id: 'approval-content', proposalId: 'proposal-content', status: 'denied', decidedAt: expired, decisionNote: 'secret' },
      { id: 'approval-pending', proposalId: 'proposal-pending', status: 'pending', decidedAt: null, decisionNote: null }
    ])
    await knex('agentActionExecutions').insert([
      { id: 'execution-content', proposalId: 'proposal-content', status: 'committed', startedAt: old, result: 'secret', error: 'secret' },
      { id: 'execution-applying', proposalId: 'proposal-applying', status: 'applying', startedAt: old, result: null, error: null }
    ])
    await knex('agentArtifacts').insert({ id: 'artifact', payload: Buffer.from('secret'), metadata: 'secret', expiresAt: expired })
    await knex('agentSkillUses').insert([
      {
        id: 'skill-content',
        sessionId: null,
        runId: null,
        requesterApiKeyId: 3,
        resourcePath: 'secret.txt',
        externalSessionSha256: 'a'.repeat(64),
        createdAt: expired
      },
      { id: 'skill-audit', sessionId: null, runId: null, requesterApiKeyId: 3, resourcePath: null, externalSessionSha256: null, createdAt: old }
    ])
    await knex('agentEvents').insert({
      id: 'delta',
      runId: 'run-complete',
      sequence: 1,
      type: 'message.delta',
      attempt: 1,
      schemaVersion: 1,
      data: '{"text":"secret"}',
      dataSha256: 'x',
      createdAt: old
    })
    await knex('agentQuotaDaily').insert({
      ownerId: 7,
      day: '2026-08-17',
      reservedTokens: 30,
      consumedTokens: 0,
      reservedCostMicros: 60,
      consumedCostMicros: 0,
      updatedAt: old
    })
    await knex('agentQuotaReservations').insert(
      ['run-safe', 'run-unsafe', 'run-cancel'].map(runId => ({
        runId,
        ownerId: 7,
        day: '2026-08-17',
        reservedTokens: 10,
        reservedCostMicros: 20,
        consumedTokens: 0,
        consumedCostMicros: 0,
        status: 'reserved',
        expiresAt: expired,
        heartbeatAt: old,
        reconciledAt: null
      }))
    )
    await knex('agentUsageLedger').insert({ id: 'usage-old', createdAt: old })

    const result = await runAgentMaintenance(knex, { batchSize: 100, savedSessionDays: 90, mcpContentDays: 7, auditDays: 90, compactDeltaDays: 1 }, now)

    expect(result).toMatchObject({
      cancelledRuns: 1,
      recoveredRuns: 1,
      requeuedRuns: 1,
      recoveredProposalExecutions: 1,
      expiredApprovals: 1,
      expiredArtifacts: 1,
      tombstonedSessions: 1,
      purgedSessions: 1,
      scrubbedMcpProposals: 1,
      purgedMcpProposals: 1,
      scrubbedSkillUses: 1,
      purgedSkillUses: 1,
      purgedUsageRows: 1,
      compactedEvents: 1,
      reconciledReservations: 1
    })
    expect(await knex('agentRuns').where({ id: 'run-safe' }).first('status')).toMatchObject({ status: 'queued' })
    expect(await knex('agentRuns').where({ id: 'run-unsafe' }).first('status', 'errorCode')).toMatchObject({
      status: 'recovery_required',
      errorCode: 'LEASE_LOST_AFTER_SIDE_EFFECT'
    })
    expect(await knex('agentRuns').where({ id: 'run-cancel' }).first('status')).toMatchObject({ status: 'cancelled' })
    expect(await knex('agentMessages').where({ id: 'assistant-run-unsafe' }).first('status')).toEqual({ status: 'failed' })
    expect(await knex('agentMessages').where({ id: 'assistant-run-cancel' }).first('status')).toEqual({ status: 'cancelled' })
    expect(
      (await knex('agentEvents').where({ runId: 'run-unsafe' }).orderBy('sequence').select('sequence', 'type', 'data')).map(event => ({
        sequence: event.sequence,
        type: event.type,
        data: JSON.parse(event.data)
      }))
    ).toEqual([
      {
        sequence: 1,
        type: 'message.completed',
        data: { messageId: 'assistant-run-unsafe', status: 'failed' }
      },
      {
        sequence: 2,
        type: 'run.recovery_required',
        data: { runId: 'run-unsafe', status: 'recovery_required' }
      }
    ])
    expect(
      (await knex('agentEvents').where({ runId: 'run-cancel' }).orderBy('sequence').select('sequence', 'type', 'data')).map(event => ({
        sequence: event.sequence,
        type: event.type,
        data: JSON.parse(event.data)
      }))
    ).toEqual([
      {
        sequence: 1,
        type: 'message.completed',
        data: { messageId: 'assistant-run-cancel', status: 'cancelled' }
      },
      {
        sequence: 2,
        type: 'run.cancelled',
        data: { runId: 'run-cancel', status: 'cancelled' }
      }
    ])
    expect(await knex('agentQuotaReservations').whereIn('runId', ['run-unsafe', 'run-cancel']).select('runId', 'status').orderBy('runId')).toEqual([
      { runId: 'run-cancel', status: 'released' },
      { runId: 'run-unsafe', status: 'released' }
    ])
    expect(await knex('agentProposals').where({ id: 'proposal-content' }).first('patch', 'contentPurgedAt')).toMatchObject({ patch: null })
    expect(await knex('agentApprovals').where({ id: 'approval-content' }).first('decisionNote')).toMatchObject({ decisionNote: null })
    expect(await knex('agentActionExecutions').where({ id: 'execution-applying' }).first('status')).toMatchObject({ status: 'recovery_required' })
    expect(await knex('agentProposals').where({ id: 'proposal-applying' }).first('status')).toMatchObject({ status: 'recovery_required' })
    expect(await knex('agentArtifacts').where({ id: 'artifact' }).first('payload', 'metadata')).toMatchObject({ payload: null, metadata: null })
    expect(await knex('agentEvents').where({ id: 'delta' }).first('data')).toMatchObject({ data: '{"compacted":true}' })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first('reservedTokens', 'reservedCostMicros')).toMatchObject({
      reservedTokens: 0,
      reservedCostMicros: 0
    })
    expect(await knex('agentSessions').where({ id: 'session-expired' }).first()).toBeUndefined()
  })

  it('compacts old deltas from partial runs', async () => {
    await knex('agentRuns').insert({
      id: 'run-partial',
      sessionId: 'session-live',
      ownerId: 7,
      status: 'partial',
      sideEffectsStarted: false,
      updatedAt: old,
      completedAt: old
    })
    await knex('agentEvents').insert({
      id: 'partial-delta',
      runId: 'run-partial',
      sequence: 1,
      type: 'message.delta',
      attempt: 1,
      schemaVersion: 1,
      data: '{"text":"secret"}',
      dataSha256: 'x',
      createdAt: old
    })

    const result = await runAgentMaintenance(knex, { batchSize: 100, savedSessionDays: 90, mcpContentDays: 7, auditDays: 90, compactDeltaDays: 1 }, now)

    expect(result.compactedEvents).toBe(1)
    expect(await knex('agentEvents').where({ id: 'partial-delta' }).first('data')).toEqual({ data: '{"compacted":true}' })
  })

  it('retains an expired temporary session until its active run becomes terminal', async () => {
    await knex('agentSessions').insert({
      id: 'session-active',
      ownerId: 7,
      retention: 'temporary',
      expiresAt: expired,
      deletedAt: null,
      updatedAt: old,
      lastActivityAt: old,
      version: 1
    })
    await knex('agentRuns').insert({
      id: 'run-active',
      sessionId: 'session-active',
      ownerId: 7,
      status: 'running',
      sideEffectsStarted: false,
      cancelRequestedAt: null,
      leaseExpiresAt: new Date('2026-08-17T13:00:00.000Z'),
      leaseOwner: 'live-worker',
      leaseToken: 'live-lease',
      availableAt: old,
      updatedAt: old,
      completedAt: null,
      errorCode: null,
      errorMessage: null
    })

    const activeResult = await runAgentMaintenance(knex, { batchSize: 100, savedSessionDays: 90, mcpContentDays: 7, auditDays: 90, compactDeltaDays: 1 }, now)
    expect(activeResult.tombstonedSessions).toBe(0)
    expect(await knex('agentSessions').where({ id: 'session-active' }).first()).toBeDefined()

    await knex('agentRuns').where({ id: 'run-active' }).update({ status: 'succeeded', completedAt: now })
    const terminalResult = await runAgentMaintenance(knex, { batchSize: 100, savedSessionDays: 90, mcpContentDays: 7, auditDays: 90, compactDeltaDays: 1 }, now)
    expect(terminalResult.tombstonedSessions).toBe(1)
    expect(await knex('agentSessions').where({ id: 'session-active' }).first()).toBeUndefined()
  })

  it('removes expired saved conversations and exposes a subsequent zero-change drain batch', async () => {
    await knex('agentSessions').insert([
      { id: 'saved-stale', ownerId: 7, retention: 'saved', folderId: null, expiresAt: null, deletedAt: null, updatedAt: old, lastActivityAt: old, version: 1 },
      {
        id: 'saved-foldered',
        ownerId: 7,
        retention: 'saved',
        folderId: 'keep',
        expiresAt: null,
        deletedAt: null,
        updatedAt: old,
        lastActivityAt: old,
        version: 1
      },
      { id: 'saved-recent', ownerId: 7, retention: 'saved', folderId: null, expiresAt: null, deletedAt: null, updatedAt: now, lastActivityAt: now, version: 1 },
      {
        id: 'saved-other-user',
        ownerId: 8,
        retention: 'saved',
        folderId: null,
        expiresAt: null,
        deletedAt: null,
        updatedAt: now,
        lastActivityAt: now,
        version: 1
      }
    ])

    const result = await runAgentMaintenance(knex, { batchSize: 1, savedSessionDays: 90, mcpContentDays: 7, auditDays: 90, compactDeltaDays: 1 }, now)

    expect(result.tombstonedSessions).toBe(1)
    const drained = await runAgentMaintenance(knex, { batchSize: 1, savedSessionDays: 90, mcpContentDays: 7, auditDays: 90, compactDeltaDays: 1 }, now)
    expect(Object.values(drained).reduce((total, count) => total + count, 0)).toBe(0)
    expect(await knex('agentSessions').where({ id: 'saved-stale' }).first()).toBeUndefined()
    expect(await knex('agentSessions').where({ id: 'saved-foldered' }).first()).toBeDefined()
    expect(await knex('agentSessions').where({ id: 'saved-recent' }).first()).toBeDefined()
    expect(await knex('agentSessions').where({ id: 'saved-other-user' }).first()).toBeDefined()
  })

  it('clears only unfiled owned conversations while preserving folders and other user history', async () => {
    await knex('agentConversationFolders').insert({
      id: 'owned-folder',
      ownerId: 7,
      name: 'Filed work',
      normalizedName: 'filed work',
      version: 1,
      createdAt: now,
      updatedAt: now
    })
    await knex('agentSessions').insert([
      { id: 'owned-unfiled-one', ownerId: 7, retention: 'saved', folderId: null, expiresAt: null, deletedAt: null, updatedAt: now, lastActivityAt: now, version: 1 },
      { id: 'owned-unfiled-two', ownerId: 7, retention: 'saved', folderId: null, expiresAt: null, deletedAt: null, updatedAt: now, lastActivityAt: now, version: 1 },
      {
        id: 'owned-filed',
        ownerId: 7,
        retention: 'saved',
        folderId: 'owned-folder',
        expiresAt: null,
        deletedAt: null,
        updatedAt: now,
        lastActivityAt: now,
        version: 1
      },
      { id: 'other-unfiled', ownerId: 8, retention: 'saved', folderId: null, expiresAt: null, deletedAt: null, updatedAt: now, lastActivityAt: now, version: 1 }
    ])
    const run = (id: string, sessionId: string, ownerId: number, status: string) => ({
      id,
      sessionId,
      ownerId,
      assistantMessageId: `assistant-${id}`,
      status,
      attempts: status === 'queued' ? 0 : 1,
      eventSequence: 0,
      sideEffectsStarted: false,
      cancelRequestedAt: null,
      leaseExpiresAt: now,
      leaseOwner: 'worker',
      leaseToken: `lease-${id}`,
      availableAt: now,
      runtimeStateCiphertext: null,
      queuedAt: now,
      startedAt: status === 'queued' ? null : now,
      updatedAt: now,
      completedAt: null,
      errorCode: null,
      errorMessage: null
    })
    await knex('agentRuns').insert([
      run('owned-queued', 'owned-unfiled-one', 7, 'queued'),
      run('owned-running', 'owned-unfiled-two', 7, 'running'),
      run('filed-queued', 'owned-filed', 7, 'queued'),
      run('other-running', 'other-unfiled', 8, 'running')
    ])
    await knex('agentMessages').insert([
      {
        id: 'assistant-owned-queued',
        sessionId: 'owned-unfiled-one',
        runId: 'owned-queued',
        ordinal: 1,
        role: 'assistant',
        status: 'pending',
        content: '',
        citations: null,
        providerStateCiphertext: null,
        providerStateSha256: null,
        createdAt: now,
        updatedAt: now
      },
      {
        id: 'assistant-filed-queued',
        sessionId: 'owned-filed',
        runId: 'filed-queued',
        ordinal: 1,
        role: 'assistant',
        status: 'pending',
        content: 'Preserved filed response',
        citations: null,
        providerStateCiphertext: null,
        providerStateSha256: null,
        createdAt: now,
        updatedAt: now
      }
    ])
    await knex('agentProposals').insert([
      {
        id: 'owned-proposal',
        sourceKind: 'agent',
        sessionId: 'owned-unfiled-two',
        status: 'pending',
        expiresAt: now,
        createdAt: now,
        contentPurgedAt: null,
        input: '{}',
        patch: null,
        diff: null,
        applyResult: null
      },
      {
        id: 'filed-proposal',
        sourceKind: 'agent',
        sessionId: 'owned-filed',
        status: 'pending',
        expiresAt: now,
        createdAt: now,
        contentPurgedAt: null,
        input: '{}',
        patch: null,
        diff: null,
        applyResult: null
      }
    ])
    await knex('agentApprovals').insert([
      { id: 'owned-approval', proposalId: 'owned-proposal', status: 'pending', decidedAt: null, decisionNote: null },
      { id: 'filed-approval', proposalId: 'filed-proposal', status: 'pending', decidedAt: null, decisionNote: null }
    ])

    expect(await requestUnfiledAgentHistoryClear(knex, 7, now)).toBe(2)

    expect(await knex('agentSessions').whereIn('id', ['owned-unfiled-one', 'owned-unfiled-two']).whereNotNull('deletedAt')).toHaveLength(2)
    expect(await knex('agentSessions').where({ id: 'owned-filed' }).first('folderId', 'deletedAt')).toMatchObject({
      folderId: 'owned-folder',
      deletedAt: null
    })
    expect(await knex('agentConversationFolders').where({ id: 'owned-folder' }).first('ownerId', 'name')).toEqual({ ownerId: 7, name: 'Filed work' })
    expect(await knex('agentSessions').where({ id: 'other-unfiled' }).whereNull('deletedAt').first()).toBeDefined()
    expect(await knex('agentRuns').where({ id: 'owned-queued' }).first('status')).toMatchObject({ status: 'cancelled' })
    expect(await knex('agentMessages').where({ id: 'assistant-owned-queued' }).first('status')).toEqual({ status: 'cancelled' })
    expect(
      (await knex('agentEvents').where({ runId: 'owned-queued' }).orderBy('sequence').select('sequence', 'type', 'data')).map(event => ({
        sequence: event.sequence,
        type: event.type,
        data: JSON.parse(event.data)
      }))
    ).toEqual([
      {
        sequence: 1,
        type: 'message.completed',
        data: { messageId: 'assistant-owned-queued', status: 'cancelled' }
      },
      {
        sequence: 2,
        type: 'run.cancelled',
        data: { runId: 'owned-queued', status: 'cancelled' }
      }
    ])
    expect((await knex('agentRuns').where({ id: 'owned-running' }).first('cancelRequestedAt'))?.cancelRequestedAt).not.toBeNull()
    expect(await knex('agentRuns').where({ id: 'filed-queued' }).first('status', 'cancelRequestedAt')).toEqual({ status: 'queued', cancelRequestedAt: null })
    expect(await knex('agentMessages').where({ id: 'assistant-filed-queued' }).first('status', 'content')).toEqual({
      status: 'pending',
      content: 'Preserved filed response'
    })
    expect(await knex('agentRuns').where({ id: 'other-running' }).first('cancelRequestedAt')).toMatchObject({ cancelRequestedAt: null })
    expect(await knex('agentProposals').where({ id: 'owned-proposal' }).first('status')).toEqual({ status: 'cancelled' })
    expect(await knex('agentApprovals').where({ id: 'owned-approval' }).first('status')).toEqual({ status: 'cancelled' })
    expect(await knex('agentProposals').where({ id: 'filed-proposal' }).first('status')).toEqual({ status: 'pending' })
    expect(await knex('agentApprovals').where({ id: 'filed-approval' }).first('status')).toEqual({ status: 'pending' })
  })
})
