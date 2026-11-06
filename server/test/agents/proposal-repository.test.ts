import { createHash, randomUUID } from 'node:crypto'
import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'
import createKnex, { type Knex } from 'knex'
import { AGENT_FEATURE_FLAG_KEYS, AGENT_TOOL_NAMES, type AgentFeatureFlags } from '../../../shared/agents/contracts.ts'
import { ACTION_CATALOG } from '../../agents/actions/catalog.ts'
import { ActionKernel, createActionAuthority } from '../../agents/actions/kernel.ts'
import { registerPageProposalActions } from '../../agents/actions/page-proposals.ts'
import { createPageEvidenceValidator, registerPageReadActions } from '../../agents/actions/page-reads.ts'
import { withInvokingAgentRunLease } from '../../agents/coordinator.ts'
import { applyApprovedProposal, decideProposal } from '../../agents/proposals/execution.ts'
import { persistProposal, proposalResult } from '../../agents/proposals/repository.ts'
import { KernelActionSessionProvider } from '../../agents/providers/action-sessions.ts'
import { AxAgentEngine } from '../../agents/providers/engine.ts'
import type { AgentProviderFactory } from '../../agents/providers/factory.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import { createApiPrincipal } from '../../helpers/api-principal.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'
import { ownsPrivatePage, principalId } from '../../helpers/page-access.ts'
import { OKF_PRODUCER_CONTEXT } from '../../okf/mutation-context.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import {
  fixtureDecisionProviders,
  fullAxFixtureService,
  synthesisCollectionControl,
  synthesisFixtureAnswer,
  synthesisObservationsFromRequest,
  synthesisSourcesFromRequest
} from './synthesis-fixture.ts'

const flags = Object.fromEntries(AGENT_FEATURE_FLAG_KEYS.map(flag => [flag, true])) as AgentFeatureFlags

const authority = (requestId = '00000000-0000-4000-8000-000000000001') =>
  createActionAuthority(
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
const applyingAuthority = (requestId = '00000000-0000-4000-8000-000000000002') =>
  createActionAuthority(
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
      table.boolean('googleSearchEnabled').notNullable().defaultTo(false)
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
      table.boolean('sideEffectsStarted').notNullable().defaultTo(false)
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

    await expect(Promise.resolve(persistProposal(knex, { ...base, input: { pageId: 42, destinationPath: 'docs/b' } }))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_MISMATCH',
      status: 409
    })
  })

  it('fails closed when an agent proposal omits its durable run scope', async () => {
    await expect(
      Promise.resolve(
        persistProposal(knex, {
          authority: authority(),
          risk: 'proposal',
          actionCallId: 'call-1',
          input: { pageId: 42 },
          operation: { kind: 'move' },
          summary: 'Move page'
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_PROPOSAL_SCOPE', status: 400 })
  })
  it('persists one execution claim and replays only its owned, approval-bound durable outcome', async () => {
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
      expect(await knex('agentActionExecutions').where({ proposalId: persisted.proposal.id }).select('proposalId', 'runId', 'inputHash', 'status')).toEqual([
        { proposalId: persisted.proposal.id, runId: draft.runId, inputHash: persisted.proposal.inputHash, status: 'applying' }
      ])
      expect(await knex('agentProposals').where({ id: persisted.proposal.id }).first('status')).toEqual({ status: 'applying' })
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

    await expect(applyApprovedProposal(knex, { ...request, authority: authority() })).rejects.toMatchObject({
      code: 'INVALID_APPLY_AUTHORITY',
      status: 400
    })
    await expect(
      applyApprovedProposal(knex, {
        ...request,
        authority: {
          ...request.authority,
          requester: { kind: 'user', userId: 8 }
        }
      })
    ).rejects.toMatchObject({ code: 'INVALID_APPLY_AUTHORITY', status: 403 })
    await expect(applyApprovedProposal(knex, { ...request, approvalId: '00000000-0000-4000-8000-000000000099' })).rejects.toMatchObject({
      code: 'PROPOSAL_NOT_FOUND',
      status: 404
    })

    // A receipt does not dispatch again or require retained mutation content.
    await knex('agentProposals').where({ id: persisted.proposal.id }).update({
      input: null,
      contentPurgedAt: new Date().toISOString(),
      expiresAt: '2020-01-01T00:00:00.000Z'
    })
    expect(await applyApprovedProposal(knex, request)).toEqual(first)
    expect(request.reauthorize).toHaveBeenCalledOnce()
    expect(mutate).toHaveBeenCalledOnce()

    await knex('agentActionExecutions').where({ proposalId: persisted.proposal.id }).update({ result: '{"page":{"id":99,"path":"docs/foreign"}}' })
    await expect(applyApprovedProposal(knex, request)).rejects.toMatchObject({ code: 'PROPOSAL_LEDGER_CORRUPT', status: 500 })
    expect(await knex('appliedPages')).toEqual([{ id: 42, path: 'docs/next' }])
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
      reconcile: async () => ((await knex('appliedPages').where({ id: 42, path: 'docs/next' }).first()) ? expected : null)
    })
    expect(result).toMatchObject({ status: 'applied', result: expected })
    expect(await knex('agentActionExecutions').select('status', 'error')).toEqual([{ status: 'committed', error: null }])
  })

  it.each(['pages.prepareMove', 'pages.prepareCreate'] as const)('records a safe terminal state after an unproved %s mutation', async actionName => {
    const persisted = await persistProposal(knex, {
      authority: createActionAuthority(
        actionName,
        '00000000-0000-4000-8000-000000000001',
        { kind: 'user', userId: 7, ownershipUserId: 7, principal: null },
        {
          transport: 'agent',
          executionMode: 'agent',
          supportsTools: true,
          permissions: ['use:agents', 'write:pages'],
          groupIds: [3],
          featureFlags: flags
        }
      ),
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

    await expect(
      Promise.resolve(
        applyApprovedProposal(knex, {
          proposalId: persisted.proposal.id,
          approvalId: persisted.approval.id,
          authority: applyingAuthority(),
          signal: new AbortController().signal,
          reauthorize: async () => {},
          mutate: async () =>
            knex.transaction(async transaction => {
              await transaction('appliedPages').insert({ id: 42, path: 'docs/next' })
              throw new Error('domain write failed')
            }),
          reconcile: async () => null
        })
      )
    ).rejects.toThrow(actionName === 'pages.prepareCreate' ? 'Creation may have committed' : 'domain write failed')

    expect(await knex('appliedPages')).toHaveLength(0)
    const status = actionName === 'pages.prepareCreate' ? 'recovery_required' : 'failed'
    expect(await knex('agentActionExecutions').select('status')).toEqual([{ status }])
    expect(await knex('agentProposals').select('status')).toEqual([{ status }])
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

    await expect(
      Promise.resolve(
        decideProposal(knex, {
          proposalId: persisted.proposal.id,
          approvalId: persisted.approval.id,
          userId: 7,
          decision: 'approved',
          authorize: vi.fn()
        })
      )
    ).rejects.toMatchObject({ code: 'PROPOSAL_EXPIRED', status: 409 })
    expect(await knex('agentProposals').select('status')).toEqual([{ status: 'expired' }])
    expect(await knex('agentApprovals').select('status')).toEqual([{ status: 'expired' }])
  })

  it('bounds a personal admin key by read-only scope and attributes approved writes to its owner, not its approver', async () => {
    const admission = {
      transport: 'mcp' as const,
      executionMode: 'agent' as const,
      supportsTools: true,
      permissions: ['manage:system', 'use:mcp', 'write:pages'],
      groupIds: [3],
      featureFlags: flags
    }
    const auth = { kind: 'apiKey' as const, apiKeyId: 9, groupId: 1 }
    const requestId = '00000000-0000-4000-8000-000000000701'
    const owner = { id: 42, name: 'Key owner' } as Express.User
    const approver = { id: 8, name: 'Independent approver' } as Express.User
    let access: 'read-only' | 'read-write' = 'read-only'
    let currentPage: Record<string, unknown> | null = null
    const operations = {
      get: vi.fn(async () => currentPage),
      getByPath: vi.fn(async () => {
        if (!currentPage) throw Object.assign(new Error('missing'), { name: 'PageNotFoundError' })
        return currentPage
      }),
      getVersion: vi.fn(),
      create: vi.fn(async (value: { input: Record<string, unknown>; requester: Express.User }) => {
        currentPage = { ...value.input, id: 43, authorId: value.requester.id, sourceRevision: '1', editor: 'markdown' }
        return currentPage
      }),
      update: vi.fn(),
      move: vi.fn(),
      restore: vi.fn(),
      remove: vi.fn(),
      authorizeMutation: vi.fn(async () => {})
    }
    const kernel = new ActionKernel()
    registerPageProposalActions(kernel, {
      knex,
      operations,
      resolveRequester: async () => ({
        ...createApiPrincipal(9, 1, ['manage:system']),
        ownershipUserId: 42,
        personalMcpAccess: access,
        groups: [3]
      }),
      resolveApprover: async id => (id === 42 ? owner : approver),
      snapshotSigningSecret: Buffer.alloc(32, 7)
    })
    const input = {
      path: 'docs/personal',
      locale: 'en',
      title: 'Personal edit',
      description: '',
      content: '# Personal edit\n',
      contentType: 'markdown',
      isPublished: true,
      tags: []
    }
    const execute = (actionName: 'pages.prepareCreate' | 'pages.applyProposal', value: unknown) =>
      kernel.execute({
        authority: createActionAuthority(actionName, requestId, auth, admission),
        actionCallId: actionName,
        input: value,
        signal: new AbortController().signal,
        refreshAdmission: async () => admission
      })
    await expect(execute('pages.prepareCreate', input)).rejects.toMatchObject({ code: 'MCP_READ_ONLY', status: 403 })
    expect(await knex('agentProposals')).toHaveLength(0)
    access = 'read-write'
    const prepared = ACTION_CATALOG['pages.prepareCreate'].output.parse(await execute('pages.prepareCreate', input))
    await decideProposal(knex, { proposalId: prepared.proposalId, approvalId: prepared.approvalId, userId: 8, decision: 'approved', authorize: async () => {} })
    access = 'read-only'
    await expect(execute('pages.applyProposal', { proposalId: prepared.proposalId, approvalId: prepared.approvalId })).rejects.toMatchObject({
      code: 'MCP_READ_ONLY'
    })
    expect(operations.create).not.toHaveBeenCalled()
    access = 'read-write'
    await execute('pages.applyProposal', { proposalId: prepared.proposalId, approvalId: prepared.approvalId })
    expect(operations.create).toHaveBeenCalledWith(expect.objectContaining({ requester: owner }))
    expect(currentPage).toMatchObject({ authorId: 42 })
    expect(operations.authorizeMutation).toHaveBeenCalledWith(expect.objectContaining({ requester: expect.objectContaining({ api: 9, ownershipUserId: 42 }) }))
    expect(operations.authorizeMutation).toHaveBeenCalledWith(expect.objectContaining({ requester: approver }))
    expect(await knex('agentProposals').where({ id: prepared.proposalId }).first('requesterApiKeyId', 'requesterUserId')).toEqual({
      requesterApiKeyId: 9,
      requesterUserId: null
    })
  })

  it('replays a pre-ID pending create through the real action kernel without changing its immutable envelope', async () => {
    const admission = {
      transport: 'mcp' as const,
      executionMode: 'agent' as const,
      supportsTools: true,
      permissions: ['use:mcp', 'write:pages'],
      groupIds: [3],
      featureFlags: flags
    }
    const auth = { kind: 'apiKey' as const, apiKeyId: 9, groupId: 3 }
    const requestId = '00000000-0000-4000-8000-000000000701'
    const prepareAuthority = createActionAuthority('pages.prepareCreate', requestId, auth, admission)
    const input = {
      path: 'docs/pre-id-create',
      locale: 'en',
      title: 'Pre-ID create',
      description: '',
      content: '# Pending creation\n',
      contentType: 'markdown',
      isPublished: true,
      tags: []
    }
    const operations = {
      get: vi.fn(),
      getByPath: vi.fn(async () => {
        throw Object.assign(new Error('missing'), { name: 'PageNotFoundError' })
      }),
      getVersion: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      move: vi.fn(),
      restore: vi.fn(),
      remove: vi.fn(),
      authorizeMutation: vi.fn(async ({ input, requester }: { input: Record<string, unknown>; requester: Express.User }) => {
        if (input.visibility === 'private' && principalId(requester) === null) {
          throw Object.assign(new Error('An owned principal is required'), { code: 'PAGE_CREATE_FORBIDDEN', status: 403 })
        }
      })
    }
    const kernel = new ActionKernel()
    let requesterPrincipal = createApiPrincipal(9, 3, ['write:pages']) as Express.User
    registerPageProposalActions(kernel, {
      knex,
      operations,
      resolveRequester: async () => requesterPrincipal,
      snapshotSigningSecret: Buffer.alloc(32, 7)
    })
    const execute = (actionCallId: string, value = input, actionAuthority = prepareAuthority, snapshot = admission) =>
      kernel.execute({
        authority: actionAuthority,
        actionCallId,
        input: value,
        signal: new AbortController().signal,
        refreshAdmission: async () => snapshot
      })
    const privateInput = { ...input, visibility: 'private', isPublished: false }
    for (const unowned of [createApiPrincipal(9, 3, ['write:pages']), { id: 2 }, { id: 7, ownershipUserId: null }, { id: 7, ownershipUserId: 0 }]) {
      requesterPrincipal = unowned as Express.User
      await expect(execute('unowned-private-create', privateInput)).rejects.toMatchObject({ code: 'PAGE_CREATE_FORBIDDEN', status: 403 })
    }
    requesterPrincipal = createApiPrincipal(9, 3, ['write:pages']) as Express.User
    const impersonatedInput = { ...privateInput, ownerId: 7 }
    await expect(execute('impersonated-private-create', impersonatedInput)).rejects.toMatchObject({ code: 'INVALID_ACTION_INPUT', status: 400 })
    expect(await knex('agentProposals')).toHaveLength(0)
    expect(operations.create).not.toHaveBeenCalled()
    const fresh = ACTION_CATALOG['pages.prepareCreate'].output.parse(await execute('new-create'))
    const newRow = await knex('agentProposals').where({ id: fresh.proposalId }).first()
    expect(newRow.resultCanonicalSha256).toBeNull()
    const operation = JSON.parse(newRow.operation)
    expect(JSON.parse(newRow.input)).not.toHaveProperty('visibility')
    expect(operation.operationInput).toMatchObject({ visibility: 'public', isPublished: true, content: input.content })
    const historical = await persistProposal(knex, {
      authority: prepareAuthority,
      actionCallId: 'pre-id-create',
      risk: 'proposal',
      input,
      operation,
      summary: `Create ${input.locale}/${input.path}`,
      diff: newRow.diff,
      diffSha256: newRow.diffSha256,
      diffRendererVersion: 1,
      resultCanonicalSha256: createHash('sha256').update(canonicalJson(operation.resultIdentity)).digest('hex')
    })
    const beforeProposal = await knex('agentProposals').where({ id: historical.proposal.id }).first()
    const beforeApproval = await knex('agentApprovals').where({ id: historical.approval.id }).first()
    const replay = ACTION_CATALOG['pages.prepareCreate'].output.parse(await execute('pre-id-create'))
    expect(replay).toMatchObject({
      proposalId: historical.proposal.id,
      approvalId: historical.approval.id,
      status: 'pending',
      inputHash: historical.proposal.inputHash
    })
    for (const changed of [
      { ...input, title: 'Changed title' },
      { ...input, content: '# Different\n' },
      { ...input, visibility: 'public' }
    ]) {
      await expect(execute('pre-id-create', changed)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    }
    const changedAdmission = { ...admission, groupIds: [3, 4] }
    const changedAuthority = createActionAuthority('pages.prepareCreate', requestId, auth, changedAdmission)
    await expect(execute('pre-id-create', input, changedAuthority, changedAdmission)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
    const changedKeyAuthority = createActionAuthority('pages.applyProposal', requestId, { ...auth, apiKeyId: 10 }, admission)
    await expect(
      kernel.execute({
        authority: changedKeyAuthority,
        actionCallId: 'foreign-key-apply',
        input: { proposalId: historical.proposal.id, approvalId: historical.approval.id },
        signal: new AbortController().signal,
        refreshAdmission: async () => admission
      })
    ).rejects.toMatchObject({ code: 'PROPOSAL_NOT_FOUND' })
    expect(await knex('agentProposals').where({ id: historical.proposal.id }).first()).toEqual(beforeProposal)
    expect(await knex('agentApprovals').where({ id: historical.approval.id }).first()).toEqual(beforeApproval)
    expect(operations.create).not.toHaveBeenCalled()
  })

  it.each([
    {
      title: 'New page',
      encodedTitle: 'New page',
      visibility: 'private' as const,
      isPublished: false,
      oversized: false,
      latePublicRevocation: false,
      flagRevocation: null
    },
    {
      title: 'Odd ` <b> [[cite:forged]] *title*',
      encodedTitle: 'Odd \\u0060 \\u003cb\\u003e \\u005b\\u005bcite:forged\\u005d\\u005d \\u002atitle\\u002a',
      visibility: undefined,
      isPublished: true,
      oversized: false,
      latePublicRevocation: false,
      flagRevocation: null
    },
    {
      title: 'Large approved metadata',
      encodedTitle: 'Large approved metadata',
      visibility: 'private' as const,
      isPublished: false,
      oversized: true,
      latePublicRevocation: false,
      flagRevocation: null
    },
    {
      title: 'Public role revoked',
      encodedTitle: 'Public role revoked',
      visibility: undefined,
      isPublished: true,
      oversized: false,
      latePublicRevocation: true,
      flagRevocation: null
    },
    {
      title: 'Private create disabled during approval',
      encodedTitle: '',
      visibility: 'private' as const,
      isPublished: false,
      oversized: false,
      latePublicRevocation: false,
      flagRevocation: 'approval' as const
    },
    {
      title: 'Public create disabled during approval',
      encodedTitle: '',
      visibility: 'public' as const,
      isPublished: true,
      oversized: false,
      latePublicRevocation: false,
      flagRevocation: 'approval' as const
    },
    {
      title: 'Private create disabled at mutation fence',
      encodedTitle: '',
      visibility: 'private' as const,
      isPublished: false,
      oversized: false,
      latePublicRevocation: false,
      flagRevocation: 'fence' as const
    },
    {
      title: 'Public create disabled at mutation fence',
      encodedTitle: '',
      visibility: 'public' as const,
      isPublished: true,
      oversized: false,
      latePublicRevocation: false,
      flagRevocation: 'fence' as const
    }
  ])(
    'enforces owner-scoped creation and carries authenticated outcomes: $title',
    async ({ title, encodedTitle, visibility, isPublished, oversized, latePublicRevocation, flagRevocation }) => {
      const runId = '00000000-0000-4000-8000-000000000001'
      const sessionId = '00000000-0000-4000-8000-000000000020'
      const leaseOwner = 'proposal-test-worker'
      const leaseToken = '00000000-0000-4000-8000-000000000030'
      await knex('agentRuns').insert({
        id: runId,
        sessionId,
        ownerId: 7,
        status: 'running',
        attempts: 1,
        leaseOwner,
        leaseToken,
        eventSequence: 0,
        updatedAt: new Date()
      })
      let currentPage: Record<string, unknown> | null = null
      let replacementPage: Record<string, unknown> | null = null
      let readable = true
      const content = visibility === 'private' ? '# Private creation\nPRIVATE_CREATE_BODY_CANARY_c1f43e\n' : '# New page\n'
      const creationInput = {
        path: 'docs/new-page',
        locale: 'en',
        title,
        description: 'Created by the agent',
        content,
        contentType: 'markdown',
        ...(visibility === undefined ? {} : { visibility }),
        isPublished,
        tags: oversized ? Array.from({ length: 30 }, (_, index) => `${index}-${'漢'.repeat(100)}`) : []
      }
      const missingPage = (): Error => Object.assign(new Error('missing'), { name: 'PageNotFoundError' })
      const operations = {
        get: vi.fn(async (value?: { requester?: Express.User }) => {
          if (!readable) throw Object.assign(new Error('Page read forbidden'), { status: 403 })
          if (!currentPage) throw missingPage()
          if (
            currentPage.visibility === 'private' &&
            value?.requester !== undefined &&
            !ownsPrivatePage(value.requester, { visibility: 'private', ownerId: Number(currentPage.ownerId) })
          )
            throw missingPage()
          return { ...currentPage }
        }),
        getByPath: vi.fn(async () => {
          if (replacementPage !== null) return { ...replacementPage }
          if (!currentPage) throw missingPage()
          return { ...currentPage }
        }),
        getVersion: vi.fn(),
        create: vi.fn(async (value: { input: Record<string, unknown>; requester: Express.User }) => {
          currentPage = {
            id: 43,
            ...value.input,
            ownerId: value.input.visibility === 'private' ? principalId(value.requester) : null,
            editor: 'markdown',
            sourceRevision: '1',
            updatedAt: '2026-10-15T15:59:38.000Z'
          }
          return { ...currentPage }
        }),
        update: vi.fn(),
        move: vi.fn(),
        authorizeMutation: vi.fn(async ({ input, requester }: { input: Record<string, unknown>; requester: Express.User }) => {
          if (input.visibility === 'private' && principalId(requester) === null) {
            throw Object.assign(new Error('An owned principal is required'), { code: 'PAGE_CREATE_FORBIDDEN', status: 403 })
          }
        }),
        restore: vi.fn(),
        remove: vi.fn()
      }
      const kernel = new ActionKernel()
      registerPageProposalActions(kernel, {
        knex,
        operations,
        resolveRequester: async authority => ({ id: authority.requester.kind === 'user' ? authority.requester.userId : undefined }) as Express.User,
        snapshotSigningSecret: Buffer.alloc(32, 7)
      })
      const admissionSnapshot = {
        transport: 'agent' as const,
        executionMode: 'agent' as const,
        supportsTools: true,
        permissions: visibility === 'private' ? ['use:agents'] : ['use:agents', 'write:pages'],
        groupIds: [3],
        featureFlags: flags
      }
      const ownerAuth = { kind: 'user' as const, userId: 7, ownershipUserId: 7, principal: null }
      const ownerOnly = { ...admissionSnapshot, permissions: ['use:agents'] }
      const offered = kernel.offer(ownerAuth, ownerOnly, runId).map(action => action.definition.descriptor.name)
      expect(offered).toContain('pages.prepareCreate')
      expect(offered).toContain('pages.applyProposal')
      expect(offered).not.toContain('pages.preparePatch')
      for (const publicInput of [
        { ...creationInput, visibility: 'public' },
        Object.fromEntries(Object.entries(creationInput).filter(([name]) => name !== 'visibility'))
      ]) {
        await expect(
          kernel.execute({
            authority: createActionAuthority('pages.prepareCreate', runId, ownerAuth, ownerOnly),
            actionCallId: 'forbidden-public-create',
            input: publicInput,
            signal: new AbortController().signal,
            refreshAdmission: async () => ownerOnly
          })
        ).rejects.toMatchObject({ code: 'ACTION_FORBIDDEN' })
      }
      for (const unownedAuth of [
        { kind: 'user' as const, userId: 2, ownershipUserId: 2, principal: null },
        { kind: 'apiKey' as const, apiKeyId: 9, groupId: 3, ownershipUserId: null, principal: null }
      ]) {
        await expect(
          kernel.execute({
            authority: createActionAuthority('pages.prepareCreate', runId, unownedAuth, ownerOnly),
            actionCallId: 'unowned-private-admission',
            input: { ...creationInput, visibility: 'private' },
            signal: new AbortController().signal,
            refreshAdmission: async () => ownerOnly
          })
        ).rejects.toMatchObject({ code: 'ACTION_FORBIDDEN' })
      }
      const disabledCreate = { ...ownerOnly, featureFlags: { ...flags, 'agents.writes.create.enabled': false } }
      expect(kernel.offer(ownerAuth, disabledCreate, runId).map(action => action.definition.descriptor.name)).not.toContain('pages.prepareCreate')
      await expect(
        kernel.execute({
          authority: createActionAuthority('pages.prepareCreate', runId, ownerAuth, ownerOnly),
          actionCallId: 'disabled-private-create',
          input: { ...creationInput, visibility: 'private' },
          signal: new AbortController().signal,
          refreshAdmission: async () => disabledCreate
        })
      ).rejects.toMatchObject({ code: 'ACTION_DISABLED' })
      expect(await knex('agentProposals')).toHaveLength(0)
      expect(operations.create).not.toHaveBeenCalled()
      const prepareAuthority = createActionAuthority(
        'pages.prepareCreate',
        runId,
        { kind: 'user', userId: 7, ownershipUserId: 7, principal: null },
        admissionSnapshot
      )
      const signal = new AbortController().signal
      let applyAdmissionReads = 0
      const hostMutationFence = vi.fn(async () => {})
      const preparedPromise = withInvokingAgentRunLease(signal, { id: runId, ownerId: 7, attempts: 1, leaseOwner, leaseToken }, () =>
        kernel.execute({
          authority: prepareAuthority,
          actionCallId: 'create-call',
          input: creationInput,
          signal,
          refreshAdmission: async authority => {
            if (flagRevocation === 'fence' && authority.actionName === 'pages.applyProposal') {
              applyAdmissionReads += 1
              if (applyAdmissionReads === 3) {
                admissionSnapshot.featureFlags = { ...flags, 'agents.writes.create.enabled': false }
              }
            }
            return admissionSnapshot
          },
          fenceSideEffect: hostMutationFence
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
      const pending = await knex('agentProposals').where({ id: approval.proposalId }).first()
      expect(JSON.parse(pending.input)).toEqual(creationInput)
      expect(JSON.parse(pending.operation).operationInput).toMatchObject({
        visibility: visibility ?? 'public',
        isPublished,
        content
      })
      if (visibility !== undefined) {
        expect(pending.summary).toContain(visibility)
        expect(pending.summary).toContain(isPublished ? 'published' : 'unpublished')
      } else {
        expect(pending.summary).toBe(`Create ${creationInput.locale}/${creationInput.path}`)
      }
      expect(pending.summary).not.toContain(content)
      expect(operations.authorizeMutation).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'create',
          input: expect.objectContaining({ visibility: visibility ?? 'public', isPublished }),
          requester: expect.objectContaining({ id: 7 })
        })
      )
      if (visibility === 'private') {
        const replaySignal = new AbortController().signal
        await expect(
          withInvokingAgentRunLease(replaySignal, { id: runId, ownerId: 7, attempts: 1, leaseOwner, leaseToken }, () =>
            kernel.execute({
              authority: prepareAuthority,
              actionCallId: 'create-call',
              input: { ...creationInput, visibility: 'public' },
              signal: replaySignal,
              refreshAdmission: async () => ({ ...admissionSnapshot, permissions: ['use:agents', 'write:pages'] })
            })
          )
        ).rejects.toMatchObject({ code: 'AGENT_ACTION_CONTINUATION_MISMATCH' })
        expect(await knex('agentProposals').where({ id: approval.proposalId }).first()).toEqual(pending)
      }

      if (flagRevocation !== null) {
        if (flagRevocation === 'approval') {
          admissionSnapshot.featureFlags = { ...flags, 'agents.writes.create.enabled': false }
        }
        const outcome = preparedPromise.then(
          () => ({ status: 'fulfilled' }),
          error => ({ status: 'rejected', error })
        )
        await decideProposal(knex, { proposalId: approval.proposalId, approvalId: approval.id, userId: 7, decision: 'approved', authorize: async () => {} })
        expect(await outcome).toMatchObject({
          status: 'rejected',
          error: { code: flagRevocation === 'approval' ? 'ACTION_DISABLED' : 'PROPOSAL_RECOVERY_REQUIRED' }
        })
        expect(operations.create).not.toHaveBeenCalled()
        expect(hostMutationFence).not.toHaveBeenCalled()
        expect(currentPage).toBeNull()
        expect(await knex('agentActionExecutions').where({ status: 'committed' })).toHaveLength(0)
        if (flagRevocation === 'approval') expect(await knex('agentActionExecutions')).toHaveLength(0)
        else expect(applyAdmissionReads).toBe(3)
        return
      }
      if (latePublicRevocation) {
        admissionSnapshot.permissions = ['use:agents']
        const outcome = preparedPromise.then(
          () => ({ status: 'fulfilled' }),
          error => ({ status: 'rejected', error })
        )
        await decideProposal(knex, { proposalId: approval.proposalId, approvalId: approval.id, userId: 7, decision: 'approved', authorize: async () => {} })
        expect(await outcome).toMatchObject({ status: 'rejected', error: { code: 'ACTION_FORBIDDEN' } })
        expect(operations.create).not.toHaveBeenCalled()
        expect(await knex('agentActionExecutions')).toHaveLength(0)
        return
      }
      await decideProposal(knex, { proposalId: approval.proposalId, approvalId: approval.id, userId: 7, decision: 'approved', authorize: async () => {} })

      const prepared = await preparedPromise
      expect(prepared).toMatchObject({
        proposalId: approval.proposalId,
        approvalId: approval.id,
        status: 'applied',
        application: {
          proposalId: approval.proposalId,
          status: 'applied',
          page: { id: 43, locale: 'en', path: 'docs/new-page', title, sourceRevision: '1' }
        }
      })
      expect(operations.create).toHaveBeenCalledOnce()
      expect(currentPage).toMatchObject({
        path: 'docs/new-page',
        locale: 'en',
        sourceRevision: '1',
        visibility: visibility ?? 'public',
        ownerId: visibility === 'private' ? 7 : null,
        isPublished,
        content
      })
      expect(await knex('agentProposals').where({ id: approval.proposalId }).first('status')).toEqual({ status: 'applied' })
      expect(await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).first('status')).toEqual({ status: 'committed' })
      const execution = await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).first('result')
      expect(prepared).toMatchObject({
        application: { resultHash: createHash('sha256').update(execution.result).digest('hex') }
      })

      const application = ACTION_CATALOG['pages.prepareCreate'].output.parse(prepared).application
      if (application === undefined || application.page === null) throw new Error('Expected the real committed create result')
      expect(application.resultHash).toMatch(/^[a-f0-9]{64}$/u)
      expect(JSON.stringify(prepared)).not.toContain('PRIVATE_CREATE_BODY_CANARY_c1f43e')
      expect(JSON.stringify(await knex('agentEvents').select('data'))).not.toContain('PRIVATE_CREATE_BODY_CANARY_c1f43e')
      if (visibility === 'private') {
        for (const actor of [{ id: 8 }, { id: 2 }, createApiPrincipal(9, 3, ['manage:system'])]) {
          await expect(operations.get({ requester: actor as Express.User })).rejects.toMatchObject({ name: 'PageNotFoundError' })
        }
        await expect(
          kernel.execute({
            authority: createActionAuthority('pages.applyProposal', runId, { kind: 'user', userId: 8, ownershipUserId: 8, principal: null }, admissionSnapshot),
            actionCallId: 'foreign-private-create',
            input: { proposalId: approval.proposalId, approvalId: approval.id },
            signal,
            refreshAdmission: async () => admissionSnapshot
          })
        ).rejects.toMatchObject({ code: 'PROPOSAL_NOT_FOUND' })
        expect(() =>
          createActionAuthority('pages.applyProposal', runId, { kind: 'guest', ownershipUserId: null, principal: null }, admissionSnapshot)
        ).toThrow()
      }
      const validatePageEvidence = createPageEvidenceValidator({
        operations: {
          ...operations,
          search: vi.fn(),
          searchTags: vi.fn(),
          listTags: vi.fn(),
          discover: vi.fn(),
          listRecent: vi.fn(),
          getHistory: vi.fn(),
          listLinks: vi.fn(),
          listRelated: vi.fn()
        },
        resolveRequester: async () => ({ id: 7 }) as Express.User,
        snapshotSigningSecret: Buffer.alloc(32, 7)
      })
      const sessions = new KernelActionSessionProvider({
        knex,
        kernel,
        resolveAdmission: async () => admissionSnapshot,
        refreshAdmission: async () => admissionSnapshot,
        validateObservation: (request, authority, actionName, output, signal) =>
          validatePageEvidence(authority, request.knowledgeContext, actionName, output, signal)
      })
      const engineRequest: AgentEngineRequest = {
        run: {
          id: runId,
          sessionId,
          userMessageId: '00000000-0000-4000-8000-000000000003',
          assistantMessageId: '00000000-0000-4000-8000-000000000004',
          ownerId: 7,
          goalId: null,
          goalContinuation: null,
          clientRequestId: '00000000-0000-4000-8000-000000000005',
          clientRequestSha256: 'a'.repeat(64),
          status: 'running',
          providerProfileVersionId: '00000000-0000-4000-8000-000000000006',
          transportKind: 'openai-responses',
          model: 'gpt-test',
          executionMode: 'agent',
          googleSearchEnabled: false,
          capabilityRevision: 'cap-1',
          pricingRevision: 'price-1',
          promptVersion: 1,
          totalTokens: 0,
          attempts: 1,
          maxAttempts: 3,
          eventSequence: 0,
          leaseOwner,
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          cancelRequestedAt: null,
          sideEffectsStarted: true,
          errorCode: null,
          errorMessage: null,
          queuedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null
        },
        messages: [
          {
            role: 'user',
            content:
              visibility === 'private'
                ? 'Create exactly one private, unpublished Markdown page at en/docs/new-page with the approved body, title, description and tags, then acknowledge its creation.'
                : 'Report the applied creation outcome.'
          }
        ],
        memory: { user: [], agent: [] },
        skills: [],
        currentPage: null,
        signal
      }
      const session = await sessions.open(engineRequest)
      const operationEvidence = await session?.operationEvidence?.(application, signal)
      if (oversized) {
        expect(Buffer.byteLength(canonicalJson(creationInput.tags), 'utf8')).toBeGreaterThan(8_192)
        expect(operationEvidence).toBeUndefined()
      } else {
        if (operationEvidence === undefined) throw new Error('Expected authenticated host-only creation evidence')
        const group = JSON.parse(operationEvidence)
        const approvedOperation = JSON.parse(pending.operation)
        const committedIdentity = JSON.parse(execution.result)
        expect(committedIdentity).toEqual({
          actionName: 'pages.prepareCreate',
          pageId: 43,
          path: creationInput.path,
          locale: creationInput.locale,
          contentSha256: createHash('sha256')
            .update(canonicalJson({ source: content }))
            .digest('hex')
        })
        expect(group.reviewedChange.creationMetadata).toMatchObject({ visibility: visibility ?? 'public', isPublished })
        expect(group.reviewedChange.currentRunReview).toBe(true)
        const laterRunId = randomUUID()
        await knex('agentRuns').insert({
          id: laterRunId,
          sessionId,
          ownerId: 7,
          status: 'running',
          attempts: 1,
          leaseOwner,
          leaseToken,
          eventSequence: 0,
          updatedAt: new Date()
        })
        const laterSession = await sessions.open({ ...engineRequest, run: { ...engineRequest.run, id: laterRunId } })
        const historicalEvidence = await laterSession?.operationEvidence?.(application, signal)
        if (historicalEvidence === undefined) throw new Error('Expected historical operation support to remain available')
        expect(JSON.parse(historicalEvidence).reviewedChange).not.toHaveProperty('currentRunReview')
        await laterSession?.close()
        expect(group.reviewedChange.diff).toContain(content.trimEnd().split('\n').at(-1))
        expect(createHash('sha256').update(group.reviewedChange.diff).digest('hex')).toBe(pending.diffSha256)
        expect(group.reviewedChange).not.toHaveProperty('content')
        expect(group.reviewedChange.creationMetadata).not.toHaveProperty('content')
        expect(operationEvidence).not.toContain('snapshotToken')
        expect(operationEvidence).not.toContain('"requester"')
        expect(Buffer.byteLength(operationEvidence, 'utf8')).toBeLessThanOrEqual(8_192)
        expect(await session?.operationEvidence?.(prepared, signal)).toBe(operationEvidence)
        for (const altered of [
          { ...application, resultHash: 'f'.repeat(64) },
          { ...application, page: { ...application.page, id: 999 } },
          { ...application, page: null },
          { ...application, reviewedChange: group.reviewedChange },
          { ...prepared, application, actionName: 'pages.preparePatch' }
        ]) {
          expect(await session?.operationEvidence?.(altered, signal)).toBeUndefined()
        }
        for (const change of [
          { input: null },
          { input: '{unreadable' },
          { diff: null },
          { diff: `${pending.diff}\n` },
          { contentPurgedAt: new Date().toISOString() }
        ]) {
          await knex('agentProposals').where({ id: approval.proposalId }).update(change)
          expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
          await knex('agentProposals').where({ id: approval.proposalId }).update({
            input: pending.input,
            diff: pending.diff,
            contentPurgedAt: null
          })
        }
        const forgedOperation = {
          ...approvedOperation,
          operationInput: { ...approvedOperation.operationInput, visibility: visibility === 'private' ? 'public' : 'private' }
        }
        const forgedText = canonicalJson(forgedOperation)
        await knex('agentProposals')
          .where({ id: approval.proposalId })
          .update({
            operation: forgedText,
            operationSha256: createHash('sha256').update(forgedText).digest('hex')
          })
        expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
        await knex('agentProposals').where({ id: approval.proposalId }).update({
          operation: pending.operation,
          operationSha256: pending.operationSha256
        })
        await knex('agentApprovals')
          .where({ id: approval.id })
          .update({ operationSha256: 'f'.repeat(64) })
        expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
        await knex('agentApprovals').where({ id: approval.id }).update({ operationSha256: pending.operationSha256 })
        const wrongBodyOperation = canonicalJson({
          ...approvedOperation,
          operationInput: { ...approvedOperation.operationInput, content: '# Different unapproved body\n' }
        })
        const wrongBodyHash = createHash('sha256').update(wrongBodyOperation).digest('hex')
        await knex('agentProposals').where({ id: approval.proposalId }).update({ operation: wrongBodyOperation, operationSha256: wrongBodyHash })
        await knex('agentApprovals').where({ id: approval.id }).update({ operationSha256: wrongBodyHash })
        expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
        await knex('agentProposals').where({ id: approval.proposalId }).update({
          operation: pending.operation,
          operationSha256: pending.operationSha256
        })
        await knex('agentApprovals').where({ id: approval.id }).update({ operationSha256: pending.operationSha256 })
        await knex('agentActionExecutions')
          .where({ proposalId: approval.proposalId })
          .update({
            result: canonicalJson({ ...committedIdentity, contentSha256: 'f'.repeat(64) })
          })
        expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
        await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).update({ result: execution.result })
        await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).update({ status: 'applying' })
        expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
        await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).update({ status: 'committed' })
        readable = false
        expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
        readable = true
        expect(await session?.operationEvidence?.(application, signal)).toBe(operationEvidence)
      }
      const originalPermissions = admissionSnapshot.permissions
      admissionSnapshot.permissions = ['use:agents']
      expect(await session?.validateObservation?.('pages.applyProposal', application, signal)).toBe(visibility === 'private')
      expect(await session?.operationEvidence?.(application, signal)).toBe(visibility === 'private' ? operationEvidence : undefined)
      admissionSnapshot.permissions = originalPermissions
      const originalFeatureFlags = admissionSnapshot.featureFlags
      admissionSnapshot.featureFlags = { ...originalFeatureFlags, 'agents.writes.create.enabled': false }
      expect(await session?.validateObservation?.('pages.applyProposal', application, signal)).toBe(false)
      expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
      admissionSnapshot.featureFlags = originalFeatureFlags
      expect(await session?.validateObservation?.('pages.applyProposal', application, signal)).toBe(true)
      expect(await session?.validateObservation?.('pages.applyProposal', { ...application, resultHash: 'f'.repeat(64) }, signal)).toBe(false)
      expect(
        await session?.validateObservation?.(
          'pages.applyProposal',
          {
            ...application,
            page: { ...application.page, id: 999, path: 'docs/another-page' }
          },
          signal
        )
      ).toBe(false)
      const originalPage = await operations.get()
      currentPage = { ...originalPage, path: 'docs/moved-later', title: 'Later approved title', sourceRevision: '2' }
      expect(await session?.validateObservation?.('pages.applyProposal', application, signal)).toBe(true)
      replacementPage = { ...originalPage, id: 44 }
      const replay = await kernel.execute({
        authority: applyingAuthority(runId),
        actionCallId: 'replay-created-id',
        input: { proposalId: approval.proposalId, approvalId: approval.id },
        signal,
        refreshAdmission: async () => admissionSnapshot
      })
      expect(replay).toMatchObject({ resultHash: application.resultHash, page: { id: 43, path: 'docs/moved-later' } })
      expect(await session?.operationEvidence?.(replay, signal)).toBe(operationEvidence)
      expect(
        await session?.validateObservation?.(
          'pages.applyProposal',
          {
            ...application,
            page: { ...application.page, id: 44 }
          },
          signal
        )
      ).toBe(false)
      expect(JSON.parse(execution.result)).toMatchObject({ pageId: 43 })
      replacementPage = null
      currentPage = originalPage
      session?.close()
      if (visibility === 'private' && !oversized) {
        const move = await persistProposal(knex, {
          authority: createActionAuthority('pages.prepareMove', runId, ownerAuth, admissionSnapshot),
          runId,
          sessionId,
          actionCallId: 'noncreate-admission-boundary',
          risk: 'proposal',
          input: { pageId: 43, destinationPath: 'docs/elsewhere', destinationLocale: 'en' },
          operation: {
            kind: 'move',
            pageId: 43,
            path: creationInput.path,
            locale: 'en',
            operationInput: { id: 43, destinationPath: 'docs/elsewhere', destinationLocale: 'en' },
            resultIdentity: { actionName: 'pages.prepareMove', pageId: 43, sourceRevision: '2', destinationPath: 'docs/elsewhere', destinationLocale: 'en' }
          },
          summary: 'Move en/docs/new-page'
        })
        await decideProposal(knex, { proposalId: move.proposal.id, approvalId: move.approval.id, userId: 7, decision: 'approved', authorize: async () => {} })
        await expect(
          kernel.execute({
            authority: createActionAuthority('pages.applyProposal', runId, ownerAuth, ownerOnly),
            actionCallId: 'noncreate-private-bypass',
            input: { proposalId: move.proposal.id, approvalId: move.approval.id },
            signal,
            refreshAdmission: async () => ownerOnly
          })
        ).rejects.toMatchObject({ code: 'ACTION_FORBIDDEN' })
        expect(operations.move).not.toHaveBeenCalled()
      }

      const pageJson = `{"id":43,"locale":"en","path":"docs/new-page","title":"${encodedTitle}","sourceRevision":"1"}`
      for (const actionName of ['pages.prepareCreate', 'pages.applyProposal'] as const) {
        let expectedObservations = [
          'Wiki proposal application status: applied.',
          `Proposal: ${approval.proposalId}; result hash: ${application.resultHash}.`,
          `Applied page: ${pageJson}`
        ]
        let revokeAtPublication = false
        const chat = vi.fn(async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
          const control = synthesisCollectionControl(input)
          if (control !== undefined) return control
          const content = synthesisFixtureAnswer(input, { claims: [], observations: expectedObservations, unresolvedFacets: [] })
          if (revokeAtPublication) readable = false
          return {
            results: [{ index: 0, content }],
            modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
          }
        })
        const factory = {
          create: async () => ({
            service: fullAxFixtureService(chat),
            capabilities: {
              streaming: false,
              toolCalling: 'native',
              parallelToolCalls: true,
              structuredOutput: 'native-json-schema',
              usage: 'estimated',
              cancellation: true,
              maxContextTokens: 100_000,
              maxOutputTokens: 4_000
            },
            transportKind: 'openai-responses',
            model: 'gpt-test',
            capabilityRevision: 'cap-1',
            pricingRevision: 'price-1',
            pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
          })
        } as unknown as AgentProviderFactory
        const resumed: AgentEngineRequest = {
          ...engineRequest,
          recoveredAction: {
            actionCallId: 'create-call',
            actionName,
            actionInput: actionName === 'pages.prepareCreate' ? creationInput : { proposalId: approval.proposalId, approvalId: approval.id },
            output: actionName === 'pages.prepareCreate' ? prepared : application
          }
        }
        const engine = new AxAgentEngine(factory, sessions, undefined, { decisionProviders: fixtureDecisionProviders })
        const text = vi.fn(async (_delta: string) => {})
        const event = vi.fn(async (_type: string, _data: unknown) => {})
        const completed = await engine.execute(resumed, { text, event })
        expect(completed.executionLimit).toBeUndefined()
        expect(completed.citations).toBeUndefined()
        const published = text.mock.calls.map(([delta]) => delta).join('')
        expect(published).toContain(expectedObservations.at(-1)!)
        expect(published).not.toContain('Evidence limits')
        expect(published).not.toContain('PRIVATE_CREATE_BODY_CANARY_c1f43e')
        expect(published).not.toContain('reviewedChange')
        expect(JSON.stringify(event.mock.calls)).not.toContain('PRIVATE_CREATE_BODY_CANARY_c1f43e')
        expect(operations.create).toHaveBeenCalledOnce()
        text.mockClear()
        readable = true
        revokeAtPublication = true
        await expect(engine.execute(resumed, { text, event })).rejects.toMatchObject({ code: 'AGENT_EVIDENCE_INVALID' })
        expect(text).not.toHaveBeenCalled()
        readable = true
        revokeAtPublication = false
        const visiblePage = currentPage
        currentPage = null
        expectedObservations = [
          'Wiki proposal application status: applied.',
          `Proposal: ${approval.proposalId}; result hash: ${application.resultHash}.`,
          'Result page identity is not disclosed by this receipt.'
        ]
        const statusOnly = await engine.execute(resumed, { text, event })
        expect(statusOnly.executionLimit).toBeUndefined()
        const redacted = text.mock.calls.map(([delta]) => delta).join('')
        expect(redacted).toContain('Result page identity is not disclosed by this receipt.')
        expect(redacted).not.toContain('docs/new-page')
        expect(redacted).not.toContain(encodedTitle)
        expect(redacted).not.toContain('deleted')
        expect(application.page?.id).toBe(43)
        expect(application.resultHash).toBe(createHash('sha256').update(execution.result).digest('hex'))
        currentPage = visiblePage
      }
      const stored = await knex('agentProposals').where({ id: approval.proposalId }).first()
      const metadata = JSON.parse(stored.operation)
      const legacy = await persistProposal(knex, {
        authority: prepareAuthority,
        runId,
        sessionId,
        actionCallId: 'historical-create',
        risk: 'proposal',
        input: JSON.parse(stored.input),
        operation: metadata,
        summary: 'Historical creation',
        resultCanonicalSha256: createHash('sha256').update(canonicalJson(metadata.resultIdentity)).digest('hex')
      })
      await decideProposal(knex, {
        proposalId: legacy.proposal.id,
        approvalId: legacy.approval.id,
        userId: 7,
        decision: 'approved',
        authorize: async () => {}
      })
      const historical = await applyApprovedProposal(knex, {
        proposalId: legacy.proposal.id,
        approvalId: legacy.approval.id,
        authority: applyingAuthority(runId),
        signal,
        reauthorize: async () => {},
        mutate: async () => metadata.resultIdentity,
        reconcile: async () => null
      })
      replacementPage = { ...originalPage, id: 44 }
      operations.getByPath.mockClear()
      expect(
        await kernel.execute({
          authority: applyingAuthority(runId),
          actionCallId: 'historical-receipt',
          input: { proposalId: legacy.proposal.id, approvalId: legacy.approval.id },
          signal,
          refreshAdmission: async () => admissionSnapshot
        })
      ).toMatchObject({ status: 'applied', resultHash: historical.resultHash, page: null })
      expect(operations.getByPath).not.toHaveBeenCalled()
      expect(await knex('agentActionExecutions').where({ proposalId: legacy.proposal.id }).first('result')).toEqual({
        result: canonicalJson(metadata.resultIdentity)
      })
      // Model an interrupted historical execution: path equality must not turn
      // the replacement into proof of the first creation.
      await knex('agentActionExecutions').where({ proposalId: legacy.proposal.id }).update({ status: 'recovery_required', result: null })
      await knex('agentProposals').where({ id: legacy.proposal.id }).update({ status: 'recovery_required', applyResult: null })
      await expect(
        kernel.execute({
          authority: applyingAuthority(runId),
          actionCallId: 'ambiguous-create-recovery',
          input: { proposalId: legacy.proposal.id, approvalId: legacy.approval.id },
          signal,
          refreshAdmission: async () => admissionSnapshot
        })
      ).rejects.toMatchObject({ code: 'PROPOSAL_RECOVERY_REQUIRED' })
      expect(operations.getByPath).not.toHaveBeenCalled()
      expect(await knex('agentActionExecutions').where({ proposalId: legacy.proposal.id }).first('status')).toEqual({ status: 'recovery_required' })
      replacementPage = null
    }
  )

  it.each([
    'complete',
    'read revoked before publication',
    'remaining read and write',
    'remaining work without plan',
    'proposal purged during private audit',
    'read revoked during private audit'
  ] as const)('resumes a human-approved private patch without its superseded native source: %s', async outcome => {
    const runId = '00000000-0000-4000-8000-000000000001'
    const sessionId = '00000000-0000-4000-8000-000000000020'
    const leaseOwner = 'patch-test-worker'
    const leaseToken = '00000000-0000-4000-8000-000000000030'
    const patchRequest = 'Change only the review marker to approved-once, wait for human approval, then report the applied outcome.'
    const remainingWork = 'Read the current incident owner from page 44, then update its review marker.'
    const hasRemainingWork = outcome === 'remaining read and write' || outcome === 'remaining work without plan'
    const losesPrivateEvidence = outcome === 'proposal purged during private audit' || outcome === 'read revoked during private audit'
    const privateFeedbackCanary = 'PRIVATE_APPROVED_PATCH_AUDIT_FEEDBACK_CANARY_7f0c91'
    let privateAuditRequests = 0
    const userRequest = hasRemainingWork ? `${patchRequest} ${remainingWork}` : patchRequest
    const requestPlan =
      outcome === 'remaining read and write'
        ? `<wiki-request-plan>${JSON.stringify({
            facets: [
              { start: 0, end: patchRequest.length, quote: patchRequest, coverage: 'source' },
              { start: patchRequest.length + 1, end: userRequest.length, quote: remainingWork, coverage: 'source' }
            ]
          })}</wiki-request-plan>`
        : undefined
    await knex('agentRuns').insert({
      id: runId,
      sessionId,
      ownerId: 7,
      status: 'running',
      attempts: 1,
      leaseOwner,
      leaseToken,
      eventSequence: 0,
      updatedAt: new Date()
    })
    let readable = true
    let page = {
      id: 43,
      locale: 'en',
      path: 'private/approved-patch',
      title: 'Private patch fixture',
      description: 'Controlled private fixture',
      contentType: 'markdown',
      editor: 'markdown',
      content: 'Keep this disclaimer.\nReview marker: before-approval.\n',
      sourceRevision: '2',
      updatedAt: '2026-10-15T15:59:38.000Z',
      isPublished: false,
      isPrivate: true,
      authorId: 7,
      tags: ['controlled-fixture']
    }
    const operations = {
      get: vi.fn(async (input: Record<string, unknown>) => {
        expect(input.requester).toMatchObject({ id: 7 })
        if (!readable) throw Object.assign(new Error('Private page read forbidden'), { status: 403 })
        return { ...page }
      }),
      getByPath: vi.fn(),
      getVersion: vi.fn(),
      create: vi.fn(),
      update: vi.fn(async ({ input }: { input: Record<string, unknown> }) => {
        expect(input.expectedSourceRevision).toBe('2')
        page = { ...page, content: String(input.content), sourceRevision: '3' }
        return { ...page }
      }),
      move: vi.fn(),
      restore: vi.fn(),
      remove: vi.fn(),
      authorizeMutation: vi.fn(async () => {}),
      search: vi.fn(),
      searchTags: vi.fn(),
      listTags: vi.fn(),
      discover: vi.fn(),
      listRecent: vi.fn(),
      getHistory: vi.fn(),
      listLinks: vi.fn(),
      listRelated: vi.fn()
    }
    const signingSecret = Buffer.alloc(32, 7)
    const dependencies = {
      operations,
      resolveRequester: async () => ({ id: 7 }) as Express.User,
      snapshotSigningSecret: signingSecret
    }
    const kernel = new ActionKernel()
    registerPageReadActions(kernel, dependencies)
    registerPageProposalActions(kernel, { ...dependencies, knex })
    const admission = {
      transport: 'agent' as const,
      executionMode: 'agent' as const,
      supportsTools: true,
      permissions: ['use:agents', 'read:pages', 'write:pages'],
      groupIds: [3],
      featureFlags: flags
    }
    const validate = createPageEvidenceValidator(dependencies)
    const sessions = new KernelActionSessionProvider({
      knex,
      kernel,
      resolveAdmission: async () => admission,
      refreshAdmission: async () => admission,
      validateObservation: (request, authority, actionName, output, signal, input) =>
        validate(authority, request.knowledgeContext, actionName, output, signal, input)
    })
    let collectorTurns = 0
    const providerRequests: Readonly<AxChatRequest>[] = []
    const fixtureErrors: unknown[] = []
    const respond = async (input: Readonly<AxChatRequest>): Promise<AxChatResponse> => {
      providerRequests.push(input)
      const call = (id: string, name: string, params: unknown): AxChatResponse => ({
        results: [{ index: 0, functionCalls: [{ id, type: 'function', function: { name, params: JSON.stringify(params) } }] }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
      })
      if (collectorTurns++ === 0) {
        const response = call('enable-authoring', 'wiki_enable_tools', { category: 'authoring' })
        if (requestPlan !== undefined) response.results[0]!.content = requestPlan
        return response
      }
      if (collectorTurns === 2) return call('read-patch', AGENT_TOOL_NAMES['pages.readForPatch'], { pageId: 43, previousSnapshotToken: null })
      if (collectorTurns === 3) {
        const result = input.chatPrompt.find(message => message.role === 'function' && message.functionId === 'read-patch')
        if (result?.role !== 'function') throw new Error('Missing real patch snapshot')
        const snapshot = ACTION_CATALOG['pages.readForPatch'].output.parse(JSON.parse(result.result))
        const line = snapshot.disclosed[0]!.lines[1]!
        return call('prepare-patch', AGENT_TOOL_NAMES['pages.preparePatch'], {
          patch: {
            version: 'wiki-line-patch-v1',
            snapshotToken: snapshot.snapshotToken,
            baseDocumentTag: snapshot.documentTag,
            resultFinalNewline: true,
            operations: [
              {
                kind: 'replace',
                range: { start: { line: line.number, tag: line.tag }, end: { line: line.number, tag: line.tag } },
                lines: ['Review marker: approved-once.']
              }
            ]
          }
        })
      }
      const control = synthesisCollectionControl(input)
      if (control !== undefined) throw new Error('Superseded native collector exchange must not be resumed')
      expect(synthesisSourcesFromRequest(input)).toEqual([])
      expect(JSON.stringify(input)).not.toContain('snapshotToken')
      const observations = synthesisObservationsFromRequest(input)
      expect(observations).toContain('Wiki proposal application status: applied.')
      expect(observations).toContain(
        'Applied page: {"id":43,"locale":"en","path":"private/approved-patch","title":"Private patch fixture","sourceRevision":"3"}'
      )
      if (outcome === 'read revoked before publication') readable = false
      return {
        results: [{ index: 0, content: synthesisFixtureAnswer(input, { claims: [], observations, unresolvedFacets: [] }) }],
        modelUsage: { ai: 'test', model: 'gpt-test', tokens: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }
      }
    }
    const chat = vi.fn((input: Readonly<AxChatRequest>) =>
      respond(input).catch(error => {
        fixtureErrors.push(error)
        throw error
      })
    )
    const factory = {
      create: async () => ({
        service: fullAxFixtureService(
          chat,
          hasRemainingWork || losesPrivateEvidence
            ? {
                coverage: async input => {
                  try {
                    if (losesPrivateEvidence) {
                      privateAuditRequests += 1
                      expect(privateAuditRequests).toBe(1)
                      const approved = await knex('agentProposals').first('id', 'status', 'diff', 'operationSha256', 'diffSha256')
                      expect(approved.status).toBe('applied')
                      const admitted = JSON.stringify(input)
                      expect(admitted).toContain(approved.operationSha256)
                      expect(admitted).toContain(approved.diffSha256)
                      expect(admitted).toContain('-Review marker: before-approval.')
                      expect(admitted).toContain('+Review marker: approved-once.')
                      if (outcome === 'proposal purged during private audit') {
                        expect(
                          await knex('agentProposals').where({ id: approved.id }).update({
                            input: null,
                            diff: null,
                            contentPurgedAt: new Date().toISOString()
                          })
                        ).toBe(1)
                      } else readable = false
                    }
                    return {
                      results: [
                        {
                          index: 0,
                          content: JSON.stringify({
                            verdict: losesPrivateEvidence ? 'incomplete' : 'not_established',
                            feedback: losesPrivateEvidence
                              ? privateFeedbackCanary
                              : 'Only the first patch is committed. The incident-owner read and second update remain unfulfilled.'
                          })
                        }
                      ]
                    }
                  } catch (error) {
                    fixtureErrors.push(error)
                    throw error
                  }
                }
              }
            : {}
        ),
        capabilities: {
          streaming: false,
          toolCalling: 'native',
          parallelToolCalls: true,
          structuredOutput: 'native-json-schema',
          usage: 'estimated',
          cancellation: true,
          maxContextTokens: 100_000,
          maxOutputTokens: 4_000
        },
        transportKind: 'openai-responses',
        model: 'gpt-test',
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        pricing: { revision: 'price-1', inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 }
      })
    } as unknown as AgentProviderFactory
    const engineRequest: AgentEngineRequest = {
      run: {
        id: runId,
        sessionId,
        userMessageId: '00000000-0000-4000-8000-000000000003',
        assistantMessageId: '00000000-0000-4000-8000-000000000004',
        ownerId: 7,
        goalId: null,
        goalContinuation: null,
        clientRequestId: '00000000-0000-4000-8000-000000000005',
        clientRequestSha256: 'a'.repeat(64),
        status: 'running',
        providerProfileVersionId: '00000000-0000-4000-8000-000000000006',
        transportKind: 'openai-responses',
        model: 'gpt-test',
        executionMode: 'agent',
        googleSearchEnabled: false,
        capabilityRevision: 'cap-1',
        pricingRevision: 'price-1',
        promptVersion: 1,
        totalTokens: 0,
        attempts: 1,
        maxAttempts: 3,
        eventSequence: 0,
        leaseOwner,
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        cancelRequestedAt: null,
        sideEffectsStarted: false,
        errorCode: null,
        errorMessage: null,
        queuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null
      },
      messages: [{ role: 'user', content: userRequest }],
      memory: { user: [], agent: [] },
      skills: [],
      currentPage: null,
      signal: new AbortController().signal
    }
    const engine = new AxAgentEngine(factory, sessions, undefined, { decisionProviders: fixtureDecisionProviders })
    const text = vi.fn(async (_delta: string) => {})
    const event = vi.fn(async (_type: string, _data: unknown) => {})
    // The production engine intentionally sanitizes provider failures. Keep
    // assertions from this owned fixture visible to the test runner instead.
    const execution = engine.execute(engineRequest, { text, event }).catch(error => {
      throw fixtureErrors.at(-1) ?? error
    })
    void execution.catch(() => {})
    await vi.waitFor(async () => {
      expect(await knex('agentRuns').where({ id: runId }).first('status')).toEqual({ status: 'awaiting_approval' })
    })
    expect(operations.update).not.toHaveBeenCalled()
    const approval = await knex('agentApprovals').first('id', 'proposalId')
    await decideProposal(knex, {
      proposalId: approval.proposalId,
      approvalId: approval.id,
      userId: 7,
      decision: 'approved',
      authorize: async () => {}
    })
    if (outcome !== 'read revoked before publication' && !losesPrivateEvidence) {
      const completed = await execution
      expect(completed.executionLimit).toEqual(hasRemainingWork ? { reason: 'evidence', publication: 'partial' } : undefined)
      expect(completed.citations).toBeUndefined()
      const published = text.mock.calls.map(([delta]) => delta).join('')
      expect(published).toContain('Wiki proposal application status: applied.')
      if (hasRemainingWork) expect(published).toContain(remainingWork.replace('.', '\\.'))
      expect(providerRequests).toHaveLength(hasRemainingWork ? 5 : 4)
      expect(completed.totalTokens).toBeGreaterThan(0)
    } else {
      await expect(execution).rejects.toMatchObject({ code: 'AGENT_EVIDENCE_INVALID' })
      expect(text).not.toHaveBeenCalled()
    }
    if (losesPrivateEvidence) {
      expect(privateAuditRequests).toBe(1)
      expect(providerRequests).toHaveLength(4)
      expect(JSON.stringify(providerRequests)).not.toContain(privateFeedbackCanary)
      const publicEvents = JSON.stringify(event.mock.calls)
      expect(publicEvents).not.toContain(privateFeedbackCanary)
      expect(publicEvents).not.toContain('-Review marker: before-approval.')
      expect(publicEvents).not.toContain('+Review marker: approved-once.')
      expect(publicEvents).not.toContain('reviewedChange')
    }
    expect(operations.update).toHaveBeenCalledOnce()
    expect(await knex('agentRuns').where({ id: runId }).first('sideEffectsStarted')).toEqual({ sideEffectsStarted: 1 })
    expect(page).toMatchObject({
      content: 'Keep this disclaimer.\nReview marker: approved-once.\n',
      sourceRevision: '3',
      isPrivate: true,
      isPublished: false,
      authorId: 7,
      title: 'Private patch fixture',
      tags: ['controlled-fixture']
    })
    expect(await knex('agentProposals').select('status')).toEqual([{ status: 'applied' }])
    expect(await knex('agentActionExecutions').select('status')).toEqual([{ status: 'committed' }])
    const completedPatches = event.mock.calls.filter(
      ([type, data]) =>
        type === 'tool.completed' && typeof data === 'object' && data !== null && 'actionName' in data && data.actionName === 'pages.preparePatch'
    )
    expect(completedPatches).toHaveLength(1)
    if (outcome === 'complete') {
      const completedData = completedPatches[0]![1] as { result: string }
      const application = ACTION_CATALOG['pages.preparePatch'].output.parse(JSON.parse(completedData.result)).application
      if (application === undefined || application.page === null) throw new Error('Expected applied patch receipt')
      const stored = await knex('agentProposals').where({ id: approval.proposalId }).first()
      const committed = await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).first('result')
      expect(application).not.toHaveProperty('reviewedChange')
      expect(completedData.result).not.toContain('before-approval')
      expect(completedData.result).not.toContain('approved-once')
      expect(application.resultHash).toBe(createHash('sha256').update(committed.result).digest('hex'))
      const signal = engineRequest.signal
      const session = await sessions.open(engineRequest)
      const evidence = await session?.operationEvidence?.(application, signal)
      if (evidence === undefined) throw new Error('Expected host-only authenticated patch evidence')
      expect(await session?.operationEvidence?.(JSON.parse(completedData.result), signal)).toBe(evidence)
      const group = JSON.parse(evidence)
      expect(group.reviewedChange).toMatchObject({
        baseSourceRevision: '2',
        resultSourceRevision: '3',
        currentRunReview: true,
        inputFields: ['content', 'expectedSourceRevision', 'id']
      })
      expect(group.reviewedChange.diff).toContain('-Review marker: before-approval.')
      expect(group.reviewedChange.diff).toContain('+Review marker: approved-once.')
      expect(createHash('sha256').update(group.reviewedChange.diff).digest('hex')).toBe(stored.diffSha256)
      expect(evidence).not.toContain('snapshotToken')
      expect(await session?.validateObservation?.('pages.applyProposal', application, signal)).toBe(true)
      for (const altered of [
        { ...application, resultHash: 'f'.repeat(64) },
        { ...application, page: { ...application.page, id: 999 } },
        { ...application, page: null },
        { ...application, reviewedChange: group.reviewedChange }
      ]) {
        expect(await session?.operationEvidence?.(altered, signal)).toBeUndefined()
      }
      await knex('agentProposals')
        .where({ id: approval.proposalId })
        .update({ diff: `${stored.diff}\n` })
      expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
      await knex('agentProposals').where({ id: approval.proposalId }).update({ diff: stored.diff, baseSourceRevision: '1' })
      expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
      await knex('agentProposals').where({ id: approval.proposalId }).update({ baseSourceRevision: '2' })
      const forgedOperation = JSON.parse(stored.operation)
      forgedOperation.operationInput.title = 'Unapproved metadata mutation'
      const forgedOperationText = canonicalJson(forgedOperation)
      await knex('agentProposals')
        .where({ id: approval.proposalId })
        .update({
          operation: forgedOperationText,
          operationSha256: createHash('sha256').update(forgedOperationText).digest('hex')
        })
      expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
      await knex('agentProposals').where({ id: approval.proposalId }).update({ operation: stored.operation, operationSha256: stored.operationSha256 })
      await knex('agentApprovals')
        .where({ id: approval.id })
        .update({ diffSha256: 'f'.repeat(64) })
      expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
      await knex('agentApprovals').where({ id: approval.id }).update({ diffSha256: stored.diffSha256 })
      const committedValue = JSON.parse(committed.result)
      await knex('agentActionExecutions')
        .where({ proposalId: approval.proposalId })
        .update({ result: canonicalJson({ ...committedValue, sourceRevision: '4' }) })
      expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
      await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).update({ result: committed.result })
      expect(await session?.operationEvidence?.(application, signal)).toBe(evidence)
      const appliedPage = page
      page = { ...page, content: 'A subsequent independent revision.\n', sourceRevision: '4' }
      const replayed = ACTION_CATALOG['pages.applyProposal'].output.parse(
        await kernel.execute({
          authority: applyingAuthority(runId),
          actionCallId: 'historical-patch-receipt',
          input: { proposalId: approval.proposalId, approvalId: approval.id },
          signal,
          refreshAdmission: async () => admission
        })
      )
      expect(replayed).toMatchObject({ resultHash: application.resultHash, page: { sourceRevision: '4' } })
      expect(replayed).not.toHaveProperty('reviewedChange')
      expect(await session?.operationEvidence?.(replayed, signal)).toBe(evidence)
      expect(operations.update).toHaveBeenCalledOnce()
      readable = false
      expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
      readable = true
      const originalPermissions = admission.permissions
      admission.permissions = ['use:agents', 'read:pages']
      expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
      expect(await session?.validateObservation?.('pages.applyProposal', application, signal)).toBe(false)
      admission.permissions = originalPermissions
      const originalFeatureFlags = admission.featureFlags
      admission.featureFlags = { ...originalFeatureFlags, 'agents.writes.patch.enabled': false }
      expect(await session?.validateObservation?.('pages.applyProposal', application, signal)).toBe(false)
      expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
      admission.featureFlags = originalFeatureFlags
      page = appliedPage
      await knex('agentProposals').where({ id: approval.proposalId }).update({ diff: null })
      expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
      await knex('agentProposals').where({ id: approval.proposalId }).update({
        diff: stored.diff,
        input: null,
        contentPurgedAt: new Date().toISOString()
      })
      expect(await session?.operationEvidence?.(application, signal)).toBeUndefined()
      expect(await session?.validateObservation?.('pages.applyProposal', application, signal)).toBe(true)
      expect(JSON.parse((await knex('agentProposals').where({ id: approval.proposalId }).first('operation')).operation).operationInput.content).toContain(
        'Review marker: approved-once.'
      )

      // A complete multibyte diff that exceeds the presentation budget is
      // omitted, not shortened or recovered from the retained operation body.
      const snapshot = ACTION_CATALOG['pages.readForPatch'].output.parse(
        await kernel.execute({
          authority: createActionAuthority('pages.readForPatch', runId, { kind: 'user', userId: 7, ownershipUserId: 7, principal: null }, admission),
          actionCallId: 'oversize-snapshot',
          input: { pageId: 43, previousSnapshotToken: null },
          signal,
          refreshAdmission: async () => admission
        })
      )
      const line = snapshot.disclosed[0]!.lines[1]!
      operations.update.mockImplementationOnce(async ({ input }: { input: Record<string, unknown> }) => {
        expect(input.expectedSourceRevision).toBe('3')
        page = { ...page, content: String(input.content), sourceRevision: '4' }
        return { ...page }
      })
      const oversizedPromise = withInvokingAgentRunLease(signal, { id: runId, ownerId: 7, attempts: 1, leaseOwner, leaseToken }, () =>
        kernel.execute({
          authority: createActionAuthority('pages.preparePatch', runId, { kind: 'user', userId: 7, ownershipUserId: 7, principal: null }, admission),
          actionCallId: 'oversize-reviewed-patch',
          input: {
            patch: {
              version: 'wiki-line-patch-v1',
              snapshotToken: snapshot.snapshotToken,
              baseDocumentTag: snapshot.documentTag,
              resultFinalNewline: true,
              operations: [
                {
                  kind: 'replace',
                  range: { start: { line: line.number, tag: line.tag }, end: { line: line.number, tag: line.tag } },
                  lines: ['漢'.repeat(3_000)]
                }
              ]
            }
          },
          signal,
          refreshAdmission: async () => admission
        })
      )
      let oversizedApproval: { id: string; proposalId: string } | undefined
      await vi.waitFor(async () => {
        oversizedApproval = await knex('agentApprovals').whereNot({ id: approval.id }).first('id', 'proposalId')
        expect(oversizedApproval).toBeDefined()
      })
      if (!oversizedApproval) throw new Error('Expected oversized patch approval')
      await decideProposal(knex, {
        proposalId: oversizedApproval.proposalId,
        approvalId: oversizedApproval.id,
        userId: 7,
        decision: 'approved',
        authorize: async () => {}
      })
      const oversized = ACTION_CATALOG['pages.preparePatch'].output.parse(await oversizedPromise)
      const oversizedStored = await knex('agentProposals').where({ id: oversizedApproval.proposalId }).first('diff', 'diffSha256')
      expect(oversizedStored.diff.length).toBeLessThan(8_192)
      expect(Buffer.byteLength(oversizedStored.diff, 'utf8')).toBeGreaterThan(8_192)
      expect(createHash('sha256').update(oversizedStored.diff).digest('hex')).toBe(oversizedStored.diffSha256)
      expect(oversized.application?.status).toBe('applied')
      expect(oversized.application).not.toHaveProperty('reviewedChange')
      expect(await session?.operationEvidence?.(oversized.application, signal)).toBeUndefined()
      session?.close()
    }
    expect(event.mock.calls.filter(([type]) => type === 'tool.failed')).toHaveLength(0)
  })

  it('pauses a prepared move for approval and applies only the approved immutable operation', async () => {
    const runId = '00000000-0000-4000-8000-000000000001'
    const sessionId = '00000000-0000-4000-8000-000000000020'
    const leaseOwner = 'proposal-test-worker'
    const leaseToken = '00000000-0000-4000-8000-000000000030'
    await knex('agentRuns').insert({
      id: runId,
      sessionId,
      ownerId: 7,
      status: 'running',
      attempts: 1,
      leaseOwner,
      leaseToken,
      eventSequence: 0,
      updatedAt: new Date()
    })
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
      resolveRequester: async () => ({}) as Express.User,
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
    const preparedPromise = withInvokingAgentRunLease(signal, { id: runId, ownerId: 7, attempts: 1, leaseOwner, leaseToken }, () =>
      kernel.execute({
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
    expect(operations.move).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { id: 42, destinationPath: 'docs/next', destinationLocale: 'en', expectedSourceRevision: '8' },
        [OKF_PRODUCER_CONTEXT]: `agent:${runId}`
      })
    )
    expect({ path: currentPage.path, locale: currentPage.locale, sourceRevision: currentPage.sourceRevision }).toEqual({
      path: 'docs/next',
      locale: 'en',
      sourceRevision: '9'
    })
    expect(await knex('agentProposals').where({ id: approval.proposalId }).first('status')).toEqual({ status: 'applied' })
    expect(await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).first('status')).toEqual({ status: 'committed' })
    expect(await knex('agentEvents').orderBy('sequence').pluck('type')).toEqual(['proposal.created', 'approval.requested', 'approval.resolved'])
  })
  it('reconciles a completed delete when missing pages use the application error name', async () => {
    const runId = '00000000-0000-4000-8000-000000000001'
    const sessionId = '00000000-0000-4000-8000-000000000020'
    const leaseOwner = 'proposal-test-worker'
    const leaseToken = '00000000-0000-4000-8000-000000000030'
    await knex('agentRuns').insert({
      id: runId,
      sessionId,
      ownerId: 7,
      status: 'running',
      attempts: 1,
      leaseOwner,
      leaseToken,
      eventSequence: 0,
      updatedAt: new Date()
    })
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
      resolveRequester: async () => ({}) as Express.User,
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
    const preparedPromise = withInvokingAgentRunLease(signal, { id: runId, ownerId: 7, attempts: 1, leaseOwner, leaseToken }, () =>
      kernel.execute({
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
