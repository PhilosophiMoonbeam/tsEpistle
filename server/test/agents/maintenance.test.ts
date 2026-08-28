/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import createKnex, { type Knex } from 'knex'
import { requestAgentHistoryReset, runAgentMaintenance } from '../../agents/maintenance.ts'

const now = new Date('2026-08-17T12:00:00.000Z')
const old = new Date('2026-05-01T00:00:00.000Z')
const expired = new Date('2026-08-10T00:00:00.000Z')

const createTables = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('agentSessions', table => { table.string('id').primary(); table.integer('ownerId'); table.string('retention'); table.string('folderId').nullable(); table.dateTime('expiresAt').nullable(); table.dateTime('deletedAt').nullable(); table.dateTime('updatedAt'); table.dateTime('lastActivityAt'); table.integer('version') })
  await knex.schema.createTable('agentRuns', table => { table.string('id').primary(); table.string('sessionId'); table.integer('ownerId'); table.string('status'); table.boolean('sideEffectsStarted'); table.dateTime('cancelRequestedAt').nullable(); table.dateTime('leaseExpiresAt').nullable(); table.string('leaseOwner').nullable(); table.string('leaseToken').nullable(); table.dateTime('availableAt').nullable(); table.dateTime('updatedAt'); table.dateTime('completedAt').nullable(); table.string('errorCode').nullable(); table.string('errorMessage').nullable() })
  await knex.schema.createTable('agentProposals', table => { table.string('id').primary(); table.string('sourceKind'); table.string('sessionId').nullable(); table.string('status'); table.dateTime('expiresAt'); table.dateTime('createdAt'); table.dateTime('contentPurgedAt').nullable(); table.text('input').nullable(); table.text('patch').nullable(); table.text('diff').nullable(); table.text('applyResult').nullable() })
  await knex.schema.createTable('agentApprovals', table => { table.string('id').primary(); table.string('proposalId'); table.string('status'); table.dateTime('decidedAt').nullable(); table.text('decisionNote').nullable() })
  await knex.schema.createTable('agentActionExecutions', table => { table.string('id').primary(); table.string('proposalId'); table.string('status'); table.dateTime('startedAt').nullable(); table.text('result').nullable(); table.text('error').nullable() })
  await knex.schema.createTable('agentArtifacts', table => { table.string('id').primary(); table.binary('payload').nullable(); table.text('metadata').nullable(); table.dateTime('expiresAt').nullable() })
  await knex.schema.createTable('agentSkillUses', table => { table.string('id').primary(); table.string('sessionId').nullable(); table.string('runId').nullable(); table.integer('requesterApiKeyId').nullable(); table.text('resourcePath').nullable(); table.string('externalSessionSha256').nullable(); table.dateTime('createdAt') })
  await knex.schema.createTable('agentEvents', table => { table.string('id').primary(); table.string('runId'); table.string('type'); table.text('data'); table.string('dataSha256'); table.dateTime('createdAt') })
  await knex.schema.createTable('agentQuotaReservations', table => { table.string('runId').primary(); table.integer('ownerId'); table.string('day'); table.integer('reservedTokens'); table.integer('reservedCostMicros'); table.integer('consumedTokens'); table.integer('consumedCostMicros'); table.string('status'); table.dateTime('expiresAt'); table.dateTime('heartbeatAt'); table.dateTime('reconciledAt').nullable() })
  await knex.schema.createTable('agentQuotaDaily', table => { table.integer('ownerId'); table.string('day'); table.integer('reservedTokens'); table.integer('consumedTokens'); table.integer('reservedCostMicros'); table.integer('consumedCostMicros'); table.dateTime('updatedAt') })
  await knex.schema.createTable('agentUsageLedger', table => { table.string('id').primary(); table.dateTime('createdAt') })
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
    const run = (id: string, status: string, sideEffectsStarted: boolean, cancelRequestedAt: Date | null = null) => ({ id, sessionId: 'session-live', ownerId: 7, status, sideEffectsStarted, cancelRequestedAt, leaseExpiresAt: expired, leaseOwner: 'dead-worker', leaseToken: `lease-${id}`, availableAt: old, updatedAt: old, completedAt: null, errorCode: null, errorMessage: null })
    await knex('agentRuns').insert([run('run-safe', 'running', false), run('run-unsafe', 'running', true), run('run-cancel', 'queued', false, expired), { ...run('run-complete', 'succeeded', false), completedAt: old }])
    await knex('agentProposals').insert([
      { id: 'proposal-content', sourceKind: 'mcp', sessionId: null, status: 'denied', expiresAt: expired, createdAt: expired, contentPurgedAt: null, input: '{}', patch: 'secret', diff: 'secret', applyResult: 'secret' },
      { id: 'proposal-audit', sourceKind: 'mcp', sessionId: null, status: 'failed', expiresAt: old, createdAt: old, contentPurgedAt: expired, input: null, patch: null, diff: null, applyResult: null },
      { id: 'proposal-pending', sourceKind: 'agent', sessionId: 'session-live', status: 'pending', expiresAt: expired, createdAt: expired, contentPurgedAt: null, input: '{}', patch: null, diff: null, applyResult: null },
      { id: 'proposal-applying', sourceKind: 'agent', sessionId: 'session-live', status: 'applying', expiresAt: new Date('2026-08-18T00:00:00.000Z'), createdAt: old, contentPurgedAt: null, input: '{}', patch: null, diff: null, applyResult: null }
    ])
    await knex('agentApprovals').insert([{ id: 'approval-content', proposalId: 'proposal-content', status: 'denied', decidedAt: expired, decisionNote: 'secret' }, { id: 'approval-pending', proposalId: 'proposal-pending', status: 'pending', decidedAt: null, decisionNote: null }])
    await knex('agentActionExecutions').insert([
      { id: 'execution-content', proposalId: 'proposal-content', status: 'committed', startedAt: old, result: 'secret', error: 'secret' },
      { id: 'execution-applying', proposalId: 'proposal-applying', status: 'applying', startedAt: old, result: null, error: null }
    ])
    await knex('agentArtifacts').insert({ id: 'artifact', payload: Buffer.from('secret'), metadata: 'secret', expiresAt: expired })
    await knex('agentSkillUses').insert([{ id: 'skill-content', sessionId: null, runId: null, requesterApiKeyId: 3, resourcePath: 'secret.txt', externalSessionSha256: 'a'.repeat(64), createdAt: expired }, { id: 'skill-audit', sessionId: null, runId: null, requesterApiKeyId: 3, resourcePath: null, externalSessionSha256: null, createdAt: old }])
    await knex('agentEvents').insert({ id: 'delta', runId: 'run-complete', type: 'message.delta', data: '{"text":"secret"}', dataSha256: 'x', createdAt: old })
    await knex('agentQuotaDaily').insert({ ownerId: 7, day: '2026-08-17', reservedTokens: 10, consumedTokens: 0, reservedCostMicros: 20, consumedCostMicros: 0, updatedAt: old })
    await knex('agentQuotaReservations').insert({ runId: 'run-safe', ownerId: 7, day: '2026-08-17', reservedTokens: 10, reservedCostMicros: 20, consumedTokens: 0, consumedCostMicros: 0, status: 'reserved', expiresAt: expired, heartbeatAt: old, reconciledAt: null })
    await knex('agentUsageLedger').insert({ id: 'usage-old', createdAt: old })

    const result = await runAgentMaintenance(knex, { batchSize: 100, savedSessionDays: 90, mcpContentDays: 7, auditDays: 90, compactDeltaDays: 1 }, now)

    expect(result).toMatchObject({ cancelledRuns: 1, recoveredRuns: 1, requeuedRuns: 1, recoveredProposalExecutions: 1, expiredApprovals: 1, expiredArtifacts: 1, tombstonedSessions: 1, purgedSessions: 1, scrubbedMcpProposals: 1, purgedMcpProposals: 1, scrubbedSkillUses: 1, purgedSkillUses: 1, purgedUsageRows: 1, compactedEvents: 1, reconciledReservations: 1 })
    expect(await knex('agentRuns').where({ id: 'run-safe' }).first('status')).toMatchObject({ status: 'queued' })
    expect(await knex('agentRuns').where({ id: 'run-unsafe' }).first('status', 'errorCode')).toMatchObject({ status: 'recovery_required', errorCode: 'LEASE_LOST_AFTER_SIDE_EFFECT' })
    expect(await knex('agentRuns').where({ id: 'run-cancel' }).first('status')).toMatchObject({ status: 'cancelled' })
    expect(await knex('agentProposals').where({ id: 'proposal-content' }).first('patch', 'contentPurgedAt')).toMatchObject({ patch: null })
    expect(await knex('agentApprovals').where({ id: 'approval-content' }).first('decisionNote')).toMatchObject({ decisionNote: null })
    expect(await knex('agentActionExecutions').where({ id: 'execution-applying' }).first('status')).toMatchObject({ status: 'recovery_required' })
    expect(await knex('agentProposals').where({ id: 'proposal-applying' }).first('status')).toMatchObject({ status: 'recovery_required' })
    expect(await knex('agentArtifacts').where({ id: 'artifact' }).first('payload', 'metadata')).toMatchObject({ payload: null, metadata: null })
    expect(await knex('agentEvents').where({ id: 'delta' }).first('data')).toMatchObject({ data: '{"compacted":true}' })
    expect(await knex('agentQuotaDaily').where({ ownerId: 7 }).first('reservedTokens', 'reservedCostMicros')).toMatchObject({ reservedTokens: 0, reservedCostMicros: 0 })
    expect(await knex('agentSessions').where({ id: 'session-expired' }).first()).toBeUndefined()
  })

  it('retains an expired temporary session until its active run becomes terminal', async () => {
    await knex('agentSessions').insert({ id: 'session-active', ownerId: 7, retention: 'temporary', expiresAt: expired, deletedAt: null, updatedAt: old, lastActivityAt: old, version: 1 })
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

  it('removes saved conversations after ninety inactive days and preserves recent history', async () => {
    await knex('agentSessions').insert([
      { id: 'saved-stale', ownerId: 7, retention: 'saved', folderId: null, expiresAt: null, deletedAt: null, updatedAt: old, lastActivityAt: old, version: 1 },
      { id: 'saved-foldered', ownerId: 7, retention: 'saved', folderId: 'keep', expiresAt: null, deletedAt: null, updatedAt: old, lastActivityAt: old, version: 1 },
      { id: 'saved-recent', ownerId: 7, retention: 'saved', folderId: null, expiresAt: null, deletedAt: null, updatedAt: now, lastActivityAt: now, version: 1 },
      { id: 'saved-other-user', ownerId: 8, retention: 'saved', folderId: null, expiresAt: null, deletedAt: null, updatedAt: now, lastActivityAt: now, version: 1 }
    ])

    const result = await runAgentMaintenance(knex, { batchSize: 1, savedSessionDays: 90, mcpContentDays: 7, auditDays: 90, compactDeltaDays: 1 }, now)

    expect(result.tombstonedSessions).toBe(1)
    expect(await knex('agentSessions').where({ id: 'saved-stale' }).first()).toBeUndefined()
    expect(await knex('agentSessions').where({ id: 'saved-foldered' }).first()).toBeDefined()
    expect(await knex('agentSessions').where({ id: 'saved-recent' }).first()).toBeDefined()
    expect(await knex('agentSessions').where({ id: 'saved-other-user' }).first()).toBeDefined()
  })

  it('resets every owned conversation while preserving another user history', async () => {
    await knex('agentSessions').insert([
      { id: 'owned-one', ownerId: 7, retention: 'saved', expiresAt: null, deletedAt: null, updatedAt: now, lastActivityAt: now, version: 1 },
      { id: 'owned-two', ownerId: 7, retention: 'saved', expiresAt: null, deletedAt: null, updatedAt: now, lastActivityAt: now, version: 1 },
      { id: 'other-one', ownerId: 8, retention: 'saved', expiresAt: null, deletedAt: null, updatedAt: now, lastActivityAt: now, version: 1 }
    ])
    const run = (id: string, sessionId: string, ownerId: number, status: string) => ({ id, sessionId, ownerId, status, sideEffectsStarted: false, cancelRequestedAt: null, leaseExpiresAt: now, leaseOwner: 'worker', leaseToken: `lease-${id}`, availableAt: now, updatedAt: now, completedAt: null, errorCode: null, errorMessage: null })
    await knex('agentRuns').insert([run('owned-queued', 'owned-one', 7, 'queued'), run('owned-running', 'owned-two', 7, 'running'), run('other-running', 'other-one', 8, 'running')])
    await knex('agentProposals').insert({ id: 'owned-proposal', sourceKind: 'agent', sessionId: 'owned-two', status: 'pending', expiresAt: now, createdAt: now, contentPurgedAt: null, input: '{}', patch: null, diff: null, applyResult: null })
    await knex('agentApprovals').insert({ id: 'owned-approval', proposalId: 'owned-proposal', status: 'pending', decidedAt: null, decisionNote: null })

    expect(await requestAgentHistoryReset(knex, 7, now)).toBe(2)

    expect(await knex('agentSessions').where({ ownerId: 7 }).whereNull('deletedAt')).toHaveLength(0)
    expect(await knex('agentSessions').where({ id: 'other-one' }).whereNull('deletedAt').first()).toBeDefined()
    expect(await knex('agentRuns').where({ id: 'owned-queued' }).first('status')).toMatchObject({ status: 'cancelled' })
    expect((await knex('agentRuns').where({ id: 'owned-running' }).first('cancelRequestedAt'))?.cancelRequestedAt).not.toBeNull()
    expect(await knex('agentRuns').where({ id: 'other-running' }).first('cancelRequestedAt')).toMatchObject({ cancelRequestedAt: null })
    expect(await knex('agentApprovals').where({ id: 'owned-approval' }).first('status')).toMatchObject({ status: 'cancelled' })
  })
})
