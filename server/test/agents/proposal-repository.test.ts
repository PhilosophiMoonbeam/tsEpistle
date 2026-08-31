import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'

import { AGENT_FEATURE_FLAG_KEYS, type AgentFeatureFlags } from '../../../shared/agents/contracts.ts'
import { ActionKernel, createActionAuthority } from '../../agents/actions/kernel.ts'
import { registerPageProposalActions } from '../../agents/actions/page-proposals.ts'
import { applyApprovedProposal, decideProposal } from '../../agents/proposals/execution.ts'
import { persistProposal, proposalResult } from '../../agents/proposals/repository.ts'
import { withInvokingAgentRunLease } from '../../agents/coordinator.ts'
import { OKF_PRODUCER_CONTEXT } from '../../okf/mutation-context.ts'

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
    await knex.schema.createTable('pageMutationOutbox', table => {
      table.integer('pageId').notNullable()
      table.bigInteger('sourceRevision').notNullable()
      table.string('desiredState').notNullable()
      table.text('payload').notNullable()
    })
    await knex.schema.createTable('agentRuns', table => {
      table.uuid('id').primary()
      table.uuid('sessionId').notNullable()
      table.integer('ownerId').notNullable()
      table.string('leaseOwner').nullable()
      table.string('status').notNullable()
      table.integer('attempts').notNullable()
      table.uuid('leaseToken').notNullable()
      table.uuid('goalId').nullable()
      table.binary('runtimeStateCiphertext').nullable()
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
    expect(await knex('agentProposals')).toHaveLength(1)
    expect(await knex('agentApprovals')).toHaveLength(1)
  })

  it('rehydrates an immutable proposal when an awaiting run is reclaimed', async () => {
    const runId = '00000000-0000-4000-8000-000000000010'
    const sessionId = '00000000-0000-4000-8000-000000000020'
    await knex('agentRuns').insert({
      id: runId,
      sessionId,
      ownerId: 7,
      status: 'awaiting_approval',
      attempts: 1,
      leaseToken: '00000000-0000-4000-8000-000000000030',
      eventSequence: 0,
      updatedAt: new Date()
    })
    const draft = {
      authority: authority(runId),
      runId,
      sessionId,
      risk: 'proposal' as const,
      actionCallId: 'original-call',
      input: { pageId: 42, sourceRevision: '8', destinationPath: 'docs/next', destinationLocale: 'en' },
      operation: { kind: 'move', operationInput: { id: 42, destinationPath: 'docs/next', destinationLocale: 'en', expectedSourceRevision: '8' } },
      summary: 'Move /en/docs/start to /en/docs/next',
      pageId: 42,
      baseSourceRevision: '8'
    }
    const first = await persistProposal(knex, draft)
    await knex('agentProposals').where({ id: first.proposal.id }).update({ status: 'approved' })
    await knex('agentApprovals').where({ id: first.approval.id }).update({ status: 'approved', approvedByUserId: 7, decidedAt: new Date() })

    const recovered = await persistProposal(knex, { ...draft, actionCallId: 'recovered-provider-call' })

    expect(recovered.replayed).toBe(true)
    expect(recovered.proposal.id).toBe(first.proposal.id)
    expect(recovered.proposal.actionCallId).toBe('original-call')
    expect(recovered.proposal.status).toBe('approved')
    expect(await knex('agentProposals')).toHaveLength(1)
    expect(await knex('agentApprovals')).toHaveLength(1)
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

    await expect(Promise.resolve(persistProposal(knex, { ...base, input: { pageId: 42, destinationPath: 'docs/b' } }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH', status: 409 })
  })

  it('fails closed when an agent proposal omits its durable run scope', async () => {
    await expect(Promise.resolve(persistProposal(knex, {
      authority: authority(),
      risk: 'proposal',
      actionCallId: 'call-1',
      input: { pageId: 42 },
      operation: { kind: 'move' },
      summary: 'Move page'
    }))).rejects.toMatchObject({ code: 'INVALID_PROPOSAL_SCOPE', status: 400 })
  })
  it('persists an execution claim before mutation and applies once', async () => {
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
    const mutate = vi.fn(async () => {
      await knex('appliedPages').insert({ id: 42, path: 'docs/next' })
      return { page: { id: 42, path: 'docs/next' } }
    })
    const request = {
      proposalId: persisted.proposal.id,
      approvalId: persisted.approval.id,
      authority: applyingAuthority(),
      signal: new AbortController().signal,
      reauthorize: vi.fn().mockResolvedValue(undefined),
      mutate,
      reconcile: async () => null
    }

    const first = await applyApprovedProposal(knex, request)
    const replay = await applyApprovedProposal(knex, request)

    expect(first).toEqual(replay)
    expect(first).toMatchObject({ proposalId: persisted.proposal.id, status: 'applied' })
    expect(authorize).toHaveBeenCalledOnce()
    expect(request.reauthorize).toHaveBeenCalledOnce()
    expect(mutate).toHaveBeenCalledOnce()
    expect(await knex('appliedPages')).toEqual([{ id: 42, path: 'docs/next' }])
    expect(await knex('agentActionExecutions').select('status')).toEqual([{ status: 'committed' }])
    expect(await knex('agentProposals').select('status')).toEqual([{ status: 'applied' }])
  })

  it('reconciles a committed domain mutation when execution loses its response', async () => {
    const persisted = await persistProposal(knex, {
      authority: authority(),
      runId: '00000000-0000-4000-8000-000000000010',
      sessionId: '00000000-0000-4000-8000-000000000020',
      risk: 'proposal',
      actionCallId: 'call-recovery',
      input: { pageId: 42, destinationPath: 'docs/next' },
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
    const expected = { page: { id: 42, path: 'docs/next' } }
    const result = await applyApprovedProposal(knex, {
      proposalId: persisted.proposal.id,
      approvalId: persisted.approval.id,
      authority: applyingAuthority(),
      signal: new AbortController().signal,
      reauthorize: async () => {},
      mutate: async () => {
        await knex('appliedPages').insert({ id: 42, path: 'docs/next' })
        throw new Error('connection lost after commit')
      },
      reconcile: async () => await knex('appliedPages').where({ id: 42, path: 'docs/next' }).first() ? expected : null
    })
    expect(result).toMatchObject({ status: 'applied', result: expected })
    expect(await knex('agentActionExecutions').select('status', 'error')).toEqual([{ status: 'committed', error: null }])
  })

  it('records a terminal failed claim when the domain transaction rolls back', async () => {
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

    await expect(Promise.resolve(applyApprovedProposal(knex, {
      proposalId: persisted.proposal.id,
      approvalId: persisted.approval.id,
      authority: applyingAuthority(),
      signal: new AbortController().signal,
      reauthorize: async () => {},
      mutate: async () => knex.transaction(async transaction => {
        await transaction('appliedPages').insert({ id: 42, path: 'docs/next' })
        throw new Error('domain write failed')
      }),
      reconcile: async () => null
    }))).rejects.toThrow('domain write failed')

    expect(await knex('appliedPages')).toHaveLength(0)
    expect(await knex('agentActionExecutions').select('status')).toEqual([{ status: 'failed' }])
    expect(await knex('agentProposals').select('status')).toEqual([{ status: 'failed' }])
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

    await expect(Promise.resolve(decideProposal(knex, {
      proposalId: persisted.proposal.id,
      approvalId: persisted.approval.id,
      userId: 7,
      decision: 'approved',
      authorize: vi.fn()
    }))).rejects.toMatchObject({ code: 'PROPOSAL_EXPIRED', status: 409 })
    expect(await knex('agentProposals').select('status')).toEqual([{ status: 'expired' }])
    expect(await knex('agentApprovals').select('status')).toEqual([{ status: 'expired' }])
  })

  it('creates a page automatically after the user approves its proposal', async () => {
    const runId = '00000000-0000-4000-8000-000000000001'
    const sessionId = '00000000-0000-4000-8000-000000000020'
    const leaseOwner = 'proposal-test-worker'
    const leaseToken = '00000000-0000-4000-8000-000000000030'
    await knex('agentRuns').insert({ id: runId, sessionId, ownerId: 7, status: 'running', attempts: 1, leaseOwner, leaseToken, eventSequence: 0, updatedAt: new Date() })
    let currentPage: Record<string, unknown> | null = null
    const missingPage = (): Error => Object.assign(new Error('missing'), { name: 'PageNotFoundError' })
    const operations = {
      get: vi.fn(async () => {
        if (!currentPage) throw missingPage()
        return { ...currentPage }
      }),
      getByPath: vi.fn(async () => {
        if (!currentPage) throw missingPage()
        return { ...currentPage }
      }),
      getVersion: vi.fn(),
      create: vi.fn(async (value: { input: Record<string, unknown> }) => {
        currentPage = {
          id: 43,
          ...value.input,
          editor: 'markdown',
          sourceRevision: '1'
        }
      }),
      update: vi.fn(),
      move: vi.fn(),
      authorizeMutation: vi.fn(async () => {}),
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
    const admissionSnapshot = {
      transport: 'agent' as const,
      executionMode: 'agent' as const,
      supportsTools: true,
      permissions: ['use:agents', 'write:pages'],
      groupIds: [3],
      featureFlags: flags
    }
    const prepareAuthority = createActionAuthority(
      'pages.prepareCreate',
      runId,
      { kind: 'user', userId: 7, ownershipUserId: 7, principal: null },
      admissionSnapshot
    )
    const signal = new AbortController().signal
    const preparedPromise = withInvokingAgentRunLease(
      signal,
      { id: runId, ownerId: 7, attempts: 1, leaseOwner, leaseToken },
      () => kernel.execute({
        authority: prepareAuthority,
        actionCallId: 'create-call',
        input: {
          path: 'docs/new-page',
          locale: 'en',
          title: 'New page',
          description: 'Created by the agent',
          content: '# New page\n',
          contentType: 'markdown',
          isPublished: true,
          tags: []
        },
        signal,
        refreshAdmission: async () => admissionSnapshot
      })
    )
    let approval: { id: string; proposalId: string } | undefined
    await vi.waitFor(async () => {
      approval = await knex('agentApprovals').first('id', 'proposalId')
      expect(approval).toBeTruthy()
      expect(await knex('agentRuns').where({ id: runId }).first('status')).toEqual({ status: 'awaiting_approval' })
    })
    if (!approval) throw new Error('approval missing')
    expect(operations.create).not.toHaveBeenCalled()

    await decideProposal(knex, { proposalId: approval.proposalId, approvalId: approval.id, userId: 7, decision: 'approved', authorize: async () => {} })

    expect(await preparedPromise).toMatchObject({ proposalId: approval.proposalId, approvalId: approval.id, status: 'applied' })
    expect(operations.create).toHaveBeenCalledOnce()
    expect(currentPage).toMatchObject({ path: 'docs/new-page', locale: 'en', sourceRevision: '1' })
    expect(await knex('agentProposals').where({ id: approval.proposalId }).first('status')).toEqual({ status: 'applied' })
    expect(await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).first('status')).toEqual({ status: 'committed' })
  })


  it('pauses a prepared move for approval and applies only the approved immutable operation', async () => {
    const runId = '00000000-0000-4000-8000-000000000001'
    const sessionId = '00000000-0000-4000-8000-000000000020'
    const leaseOwner = 'proposal-test-worker'
    const leaseToken = '00000000-0000-4000-8000-000000000030'
    await knex('agentRuns').insert({ id: runId, sessionId, ownerId: 7, status: 'running', attempts: 1, leaseOwner, leaseToken, eventSequence: 0, updatedAt: new Date() })
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
      authorizeMutation: vi.fn(async () => {}),
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
    const signal = new AbortController().signal
    const preparedPromise = withInvokingAgentRunLease(
      signal,
      { id: runId, ownerId: 7, attempts: 1, leaseOwner, leaseToken },
      () => kernel.execute({
        authority: prepareAuthority,
        actionCallId: 'move-call',
        input: { pageId: 42, sourceRevision: '8', destinationPath: 'docs/next', destinationLocale: 'en' },
        signal,
        refreshAdmission: async () => admissionSnapshot
      })
    )
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
    expect(await preparedPromise).toMatchObject({ proposalId: approval.proposalId, approvalId: approval.id, status: 'applied' })
    expect(await knex('agentRuns').where({ id: runId }).first('status')).toEqual({ status: 'running' })
    expect(operations.move).toHaveBeenCalledOnce()
    expect(operations.move).toHaveBeenCalledWith(expect.objectContaining({
      [OKF_PRODUCER_CONTEXT]: `agent:${runId}`
    }))
    expect(await knex('agentProposals').where({ id: approval.proposalId }).first('status')).toEqual({ status: 'applied' })
    expect(await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).first('status')).toEqual({ status: 'committed' })
    expect(await knex('agentEvents').orderBy('sequence').pluck('type')).toEqual(['proposal.created', 'approval.requested', 'approval.resolved'])
  })
  it('reconciles a completed delete when missing pages use the application error name', async () => {
    const runId = '00000000-0000-4000-8000-000000000001'
    const sessionId = '00000000-0000-4000-8000-000000000020'
    const leaseOwner = 'proposal-test-worker'
    const leaseToken = '00000000-0000-4000-8000-000000000030'
    await knex('agentRuns').insert({ id: runId, sessionId, ownerId: 7, status: 'running', attempts: 1, leaseOwner, leaseToken, eventSequence: 0, updatedAt: new Date() })
    let currentPage: Record<string, unknown> | null = {
      id: 42,
      path: 'docs/disposable',
      locale: 'en',
      title: 'Disposable',
      description: '',
      content: '# Disposable\n',
      contentType: 'markdown',
      editor: 'markdown',
      sourceRevision: '8',
      isPublished: true,
      tags: []
    }
    const operations = {
      get: vi.fn(async () => {
        if (currentPage === null) {
          const error = new Error('This page does not exist.')
          error.name = 'PAGE_NOT_FOUND'
          throw error
        }
        return { ...currentPage }
      }),
      getByPath: vi.fn(),
      getVersion: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      move: vi.fn(),
      authorizeMutation: vi.fn(async () => {}),
      restore: vi.fn(),
      remove: vi.fn(async () => {
        currentPage = null
        await knex('pageMutationOutbox').insert([
          { pageId: 42, sourceRevision: '9', desiredState: 'absent', payload: JSON.stringify({ action: 'delete' }) },
          { pageId: 42, sourceRevision: '9', desiredState: 'absent', payload: JSON.stringify({ action: 'delete' }) }
        ])
        throw new Error('delete response lost')
      })
    }
    const kernel = new ActionKernel()
    registerPageProposalActions(kernel, {
      knex,
      operations,
      resolveRequester: async () => ({} as Express.User),
      snapshotSigningSecret: Buffer.alloc(32, 7)
    })
    const admissionSnapshot = {
      transport: 'agent' as const,
      executionMode: 'agent' as const,
      supportsTools: true,
      permissions: ['use:agents', 'write:pages', 'delete:pages'],
      groupIds: [3],
      featureFlags: flags
    }
    const prepareAuthority = createActionAuthority(
      'pages.prepareDelete',
      runId,
      { kind: 'user', userId: 7, ownershipUserId: 7, principal: null },
      admissionSnapshot
    )
    const signal = new AbortController().signal
    const preparedPromise = withInvokingAgentRunLease(
      signal,
      { id: runId, ownerId: 7, attempts: 1, leaseOwner, leaseToken },
      () => kernel.execute({
        authority: prepareAuthority,
        actionCallId: 'delete-call',
        input: { pageId: 42, sourceRevision: '8', confirmationPath: 'docs/disposable' },
        signal,
        refreshAdmission: async () => admissionSnapshot
      })
    )
    let approval: { id: string; proposalId: string } | undefined
    await vi.waitFor(async () => {
      approval = await knex('agentApprovals').first('id', 'proposalId')
      expect(approval).toBeTruthy()
    })
    if (!approval) throw new Error('approval missing')
    await decideProposal(knex, { proposalId: approval.proposalId, approvalId: approval.id, userId: 7, decision: 'approved', authorize: async () => {} })
    expect(await preparedPromise).toMatchObject({ proposalId: approval.proposalId, status: 'applied' })
    expect(await knex('agentProposals').where({ id: approval.proposalId }).first('status')).toEqual({ status: 'applied' })
    expect(operations.remove).toHaveBeenCalledOnce()
    expect(await knex('agentActionExecutions').select('status')).toEqual([{ status: 'committed' }])
  })

})
