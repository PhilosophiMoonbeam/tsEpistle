/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import createKnex, { type Knex } from 'knex'

import { AGENT_FEATURE_FLAG_KEYS, type AgentFeatureFlags } from '../../../shared/agents/contracts.ts'
import { ActionKernel, createActionAuthority } from '../../agents/actions/kernel.ts'
import { registerPageProposalActions } from '../../agents/actions/page-proposals.ts'
import { applyApprovedProposal, decideProposal } from '../../agents/proposals/execution.ts'
import { persistProposal, proposalResult } from '../../agents/proposals/repository.ts'

const flags = Object.fromEntries(AGENT_FEATURE_FLAG_KEYS.map(flag => [flag, true])) as AgentFeatureFlags

const authority = (requestId = '00000000-0000-4000-8000-000000000001') => createActionAuthority(
  'pages.prepareMove',
  requestId,
  { kind: 'user', userId: 7, ownershipUserId: 7, principal: null },
  {
    transport: 'agent',
    executionMode: 'agent',
    supportsTools: true,
    permissions: ['use:agents', 'write:pages'],
    groupIds: [3],
    featureFlags: flags
  }
)
const applyingAuthority = (requestId = '00000000-0000-4000-8000-000000000002') => createActionAuthority(
  'pages.applyProposal',
  requestId,
  { kind: 'user', userId: 7, ownershipUserId: 7, principal: null },
  {
    transport: 'agent',
    executionMode: 'agent',
    supportsTools: true,
    permissions: ['use:agents', 'write:pages'],
    groupIds: [3],
    featureFlags: flags
  }
)

describe('agent proposal repository', () => {
  let knex: Knex

  beforeEach(async () => {
    knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await knex.schema.createTable('agentProposals', table => {
      table.uuid('id').primary()
      table.string('sourceKind').notNullable()
      table.uuid('runId').nullable()
      table.uuid('sessionId').nullable()
      table.integer('requesterUserId').nullable()
      table.integer('requesterApiKeyId').nullable()
      table.uuid('requesterRequestId').notNullable()
      table.string('actionCallId').notNullable()
      table.string('actionName').notNullable()
      table.string('risk').notNullable()
      table.text('summary').notNullable()
      table.string('status').notNullable()
      table.text('input').nullable()
      table.string('inputHash').notNullable()
      table.integer('authorityVersion').notNullable()
      table.string('authoritySha256').notNullable()
      table.integer('pageId').nullable()
      table.bigInteger('baseSourceRevision').nullable()
      table.string('baseLineEnding').nullable()
      table.boolean('baseFinalNewline').nullable()
      table.string('baseRawSha256').nullable()
      table.string('baseCanonicalSha256').nullable()
      table.string('disclosedRangesSha256').nullable()
      table.string('patchFormat').nullable()
      table.integer('patchEngineVersion').nullable()
      table.string('patchSha256').nullable()
      table.text('patch').nullable()
      table.text('operation').notNullable()
      table.string('operationSha256').notNullable()
      table.string('resultRawSha256').nullable()
      table.string('resultCanonicalSha256').nullable()
      table.integer('diffRendererVersion').nullable()
      table.string('diffSha256').nullable()
      table.text('diff').nullable()
      table.dateTime('expiresAt').notNullable()
      table.dateTime('createdAt').notNullable()
      table.dateTime('appliedAt').nullable()
      table.dateTime('contentPurgedAt').nullable()
      table.text('applyResult').nullable()
      table.unique(['runId', 'actionCallId'])
    })
    await knex.schema.createTable('agentApprovals', table => {
      table.uuid('id').primary()
      table.uuid('proposalId').notNullable().unique()
      table.uuid('runId').nullable()
      table.integer('requesterUserId').nullable()
      table.integer('requesterApiKeyId').nullable()
      table.string('status').notNullable()
      table.string('inputHash').notNullable()
      table.integer('authorityVersion').notNullable()
      table.string('authoritySha256').notNullable()
      table.string('patchSha256').nullable()
      table.string('resultCanonicalSha256').nullable()
      table.string('diffSha256').nullable()
      table.string('operationSha256').notNullable()
      table.dateTime('requestedAt').notNullable()
      table.dateTime('expiresAt').notNullable()
      table.dateTime('decidedAt').nullable()
      table.integer('approvedByUserId').nullable()
      table.text('decisionNote').nullable()
    })
    await knex.schema.createTable('agentActionExecutions', table => {
      table.uuid('id').primary()
      table.uuid('proposalId').notNullable().unique()
      table.uuid('runId').nullable()
      table.string('actionName').notNullable()
      table.integer('requesterUserId').nullable()
      table.integer('requesterApiKeyId').nullable()
      table.integer('approvedByUserId').notNullable()
      table.string('idempotencyKey').notNullable().unique()
      table.uuid('leaseToken').nullable()
      table.string('status').notNullable()
      table.string('inputHash').notNullable()
      table.dateTime('startedAt').notNullable()
      table.dateTime('completedAt').nullable()
      table.text('result').nullable()
      table.text('error').nullable()
    })
    await knex.schema.createTable('appliedPages', table => {
      table.integer('id').primary()
      table.string('path').notNullable()
    })
    await knex.schema.createTable('agentRuns', table => {
      table.uuid('id').primary()
      table.uuid('sessionId').notNullable()
      table.integer('ownerId').notNullable()
      table.string('status').notNullable()
      table.integer('attempts').notNullable()
      table.uuid('leaseToken').notNullable()
      table.integer('eventSequence').notNullable().defaultTo(0)
      table.dateTime('cancelRequestedAt').nullable()
      table.dateTime('updatedAt').notNullable()
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
  })

  afterEach(async () => knex.destroy())

  it('persists one immutable proposal and approval and returns exact retries', async () => {
    const draft = {
      authority: authority(),
      runId: '00000000-0000-4000-8000-000000000010',
      sessionId: '00000000-0000-4000-8000-000000000020',
      risk: 'proposal' as const,
      actionCallId: 'call-1',
      input: { sourceRevision: '8', pageId: 42, destinationPath: 'docs/next', destinationLocale: 'en' },
      operation: { kind: 'move' },
      summary: 'Move /en/docs/start to /en/docs/next',
      pageId: 42,
      baseSourceRevision: '8'
    }

    const first = await persistProposal(knex, draft)
    const replay = await persistProposal(knex, draft)

    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(replay.proposal.id).toBe(first.proposal.id)
    expect(proposalResult(first)).toMatchObject({ proposalId: first.proposal.id, status: 'pending', diffHash: null })
    await expect(knex('agentProposals')).resolves.toHaveLength(1)
    await expect(knex('agentApprovals')).resolves.toHaveLength(1)
  })

  it('rejects request ID reuse with different immutable arguments', async () => {
    const base = {
      authority: authority(),
      runId: '00000000-0000-4000-8000-000000000010',
      sessionId: '00000000-0000-4000-8000-000000000020',
      risk: 'proposal' as const,
      actionCallId: 'call-1',
      operation: { kind: 'move' },
      summary: 'Move page',
      pageId: 42,
      baseSourceRevision: '8'
    }
    await persistProposal(knex, { ...base, input: { pageId: 42, destinationPath: 'docs/a' } })

    await expect(persistProposal(knex, { ...base, input: { pageId: 42, destinationPath: 'docs/b' } }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH', status: 409 })
  })

  it('fails closed when an agent proposal omits its durable run scope', async () => {
    await expect(persistProposal(knex, {
      authority: authority(),
      risk: 'proposal',
      actionCallId: 'call-1',
      input: { pageId: 42 },
      operation: { kind: 'move' },
      summary: 'Move page'
    })).rejects.toMatchObject({ code: 'INVALID_PROPOSAL_SCOPE', status: 400 })
  })
  it('decides and applies once through one transaction-fenced execution claim', async () => {
    const draft = {
      authority: authority(),
      runId: '00000000-0000-4000-8000-000000000010',
      sessionId: '00000000-0000-4000-8000-000000000020',
      risk: 'proposal' as const,
      actionCallId: 'call-1',
      input: { pageId: 42, destinationPath: 'docs/next' },
      operation: { kind: 'move' },
      summary: 'Move page',
      pageId: 42,
      baseSourceRevision: '8'
    }
    const persisted = await persistProposal(knex, draft)
    const authorize = vi.fn().mockResolvedValue(undefined)
    await decideProposal(knex, {
      proposalId: persisted.proposal.id,
      approvalId: persisted.approval.id,
      userId: 7,
      decision: 'approved',
      authorize
    })
    const mutate = vi.fn(async ({ transaction }) => {
      await transaction('appliedPages').insert({ id: 42, path: 'docs/next' })
      return { page: { id: 42, path: 'docs/next' } }
    })
    const request = {
      proposalId: persisted.proposal.id,
      approvalId: persisted.approval.id,
      authority: applyingAuthority(),
      signal: new AbortController().signal,
      reauthorize: vi.fn().mockResolvedValue(undefined),
      mutate
    }

    const first = await applyApprovedProposal(knex, request)
    const replay = await applyApprovedProposal(knex, request)

    expect(first).toEqual(replay)
    expect(first).toMatchObject({ proposalId: persisted.proposal.id, status: 'applied' })
    expect(authorize).toHaveBeenCalledOnce()
    expect(request.reauthorize).toHaveBeenCalledOnce()
    expect(mutate).toHaveBeenCalledOnce()
    await expect(knex('appliedPages')).resolves.toEqual([{ id: 42, path: 'docs/next' }])
    await expect(knex('agentActionExecutions').select('status')).resolves.toEqual([{ status: 'committed' }])
    await expect(knex('agentProposals').select('status')).resolves.toEqual([{ status: 'applied' }])
  })

  it('rolls back the execution claim and domain mutation on apply failure', async () => {
    const persisted = await persistProposal(knex, {
      authority: authority(),
      runId: '00000000-0000-4000-8000-000000000010',
      sessionId: '00000000-0000-4000-8000-000000000020',
      risk: 'proposal',
      actionCallId: 'call-1',
      input: { pageId: 42 },
      operation: { kind: 'move' },
      summary: 'Move page',
      pageId: 42,
      baseSourceRevision: '8'
    })
    await decideProposal(knex, {
      proposalId: persisted.proposal.id,
      approvalId: persisted.approval.id,
      userId: 7,
      decision: 'approved',
      authorize: async () => {}
    })

    await expect(applyApprovedProposal(knex, {
      proposalId: persisted.proposal.id,
      approvalId: persisted.approval.id,
      authority: applyingAuthority(),
      signal: new AbortController().signal,
      reauthorize: async () => {},
      mutate: async ({ transaction }) => {
        await transaction('appliedPages').insert({ id: 42, path: 'docs/next' })
        throw new Error('domain write failed')
      }
    })).rejects.toThrow('domain write failed')

    await expect(knex('appliedPages')).resolves.toHaveLength(0)
    await expect(knex('agentActionExecutions')).resolves.toHaveLength(0)
    await expect(knex('agentProposals').select('status')).resolves.toEqual([{ status: 'approved' }])
  })

  it('commits expiry before returning an expired decision error', async () => {
    const persisted = await persistProposal(knex, {
      authority: authority(),
      runId: '00000000-0000-4000-8000-000000000010',
      sessionId: '00000000-0000-4000-8000-000000000020',
      risk: 'proposal',
      actionCallId: 'call-1',
      input: { pageId: 42 },
      operation: { kind: 'move' },
      summary: 'Move page'
    })
    const expiredAt = '2000-01-01T00:00:00.000Z'
    await knex('agentProposals').where({ id: persisted.proposal.id }).update({ expiresAt: expiredAt })
    await knex('agentApprovals').where({ id: persisted.approval.id }).update({ expiresAt: expiredAt })

    await expect(decideProposal(knex, {
      proposalId: persisted.proposal.id,
      approvalId: persisted.approval.id,
      userId: 7,
      decision: 'approved',
      authorize: vi.fn()
    })).rejects.toMatchObject({ code: 'PROPOSAL_EXPIRED', status: 409 })
    await expect(knex('agentProposals').select('status')).resolves.toEqual([{ status: 'expired' }])
    await expect(knex('agentApprovals').select('status')).resolves.toEqual([{ status: 'expired' }])
  })

  it('pauses a prepared move for approval and applies only the approved immutable operation', async () => {
    const runId = '00000000-0000-4000-8000-000000000001'
    const sessionId = '00000000-0000-4000-8000-000000000020'
    const leaseToken = '00000000-0000-4000-8000-000000000030'
    await knex('agentRuns').insert({ id: runId, sessionId, ownerId: 7, status: 'running', attempts: 1, leaseToken, eventSequence: 0, updatedAt: new Date() })
    let currentPage = {
      id: 42,
      path: 'docs/start',
      locale: 'en',
      title: 'Start',
      description: '',
      content: '# Start\n',
      contentType: 'markdown',
      editor: 'markdown',
      sourceRevision: '8',
      isPublished: true,
      tags: []
    }
    const operations = {
      get: vi.fn(async () => ({ ...currentPage })),
      getByPath: vi.fn(async () => ({ ...currentPage })),
      getVersion: vi.fn(async () => ({ content: currentPage.content })),
      create: vi.fn(),
      update: vi.fn(),
      move: vi.fn(async (value: Record<string, unknown>) => {
        const input = value.input as { destinationPath: string; destinationLocale: string }
        currentPage = { ...currentPage, path: input.destinationPath, locale: input.destinationLocale, sourceRevision: '9' }
      }),
      restore: vi.fn(),
      remove: vi.fn()
    }
    const kernel = new ActionKernel()
    registerPageProposalActions(kernel, {
      knex,
      operations,
      resolveRequester: async () => ({} as Express.User),
      snapshotSigningSecret: Buffer.alloc(32, 7)
    })
    const prepareAuthority = authority(runId)
    const admissionSnapshot = {
      transport: 'agent' as const,
      executionMode: 'agent' as const,
      supportsTools: true,
      permissions: ['use:agents', 'write:pages'],
      groupIds: [3],
      featureFlags: flags
    }
    const preparedPromise = kernel.execute({
      authority: prepareAuthority,
      actionCallId: 'move-call',
      input: { pageId: 42, sourceRevision: '8', destinationPath: 'docs/next', destinationLocale: 'en' },
      signal: new AbortController().signal,
      refreshAdmission: async () => admissionSnapshot
    })
    let approval: { id: string; proposalId: string } | undefined
    await vi.waitFor(async () => {
      approval = await knex('agentApprovals').first('id', 'proposalId')
      const run = await knex('agentRuns').where({ id: runId }).first('status')
      expect(approval).toBeTruthy()
      expect(run?.status).toBe('awaiting_approval')
    })
    if (!approval) throw new Error('approval missing')
    expect(operations.move).not.toHaveBeenCalled()
    await decideProposal(knex, { proposalId: approval.proposalId, approvalId: approval.id, userId: 7, decision: 'approved', authorize: async () => {} })
    await expect(preparedPromise).resolves.toMatchObject({ proposalId: approval.proposalId, approvalId: approval.id, status: 'approved' })
    expect(operations.move).not.toHaveBeenCalled()

    const applyAuthority = createActionAuthority('pages.applyProposal', runId, { kind: 'user', userId: 7, ownershipUserId: 7, principal: null }, admissionSnapshot)
    await expect(kernel.execute({
      authority: applyAuthority,
      actionCallId: 'apply-call',
      input: { proposalId: approval.proposalId, approvalId: approval.id },
      signal: new AbortController().signal,
      refreshAdmission: async () => admissionSnapshot
    })).resolves.toMatchObject({ proposalId: approval.proposalId, status: 'applied', page: { id: 42, path: 'docs/next', sourceRevision: '9' } })
    expect(operations.move).toHaveBeenCalledOnce()
    await expect(knex('agentEvents').orderBy('sequence').pluck('type')).resolves.toEqual(['proposal.created', 'approval.requested', 'approval.resolved'])
  })
})
