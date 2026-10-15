import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'
import type { AxChatRequest, AxChatResponse } from '@ax-llm/ax'

import { AGENT_FEATURE_FLAG_KEYS, type AgentFeatureFlags } from '../../../shared/agents/contracts.ts'
import { ActionKernel, createActionAuthority } from '../../agents/actions/kernel.ts'
import { ACTION_CATALOG } from '../../agents/actions/catalog.ts'
import { createPageEvidenceValidator } from '../../agents/actions/page-reads.ts'
import { registerPageProposalActions } from '../../agents/actions/page-proposals.ts'
import { applyApprovedProposal, decideProposal } from '../../agents/proposals/execution.ts'
import { persistProposal, proposalResult } from '../../agents/proposals/repository.ts'
import { withInvokingAgentRunLease } from '../../agents/coordinator.ts'
import { OKF_PRODUCER_CONTEXT } from '../../okf/mutation-context.ts'
import { KernelActionSessionProvider } from '../../agents/providers/action-sessions.ts'
import { AxAgentEngine } from '../../agents/providers/engine.ts'
import type { AgentProviderFactory } from '../../agents/providers/factory.ts'
import type { AgentEngineRequest } from '../../agents/runtime.ts'
import { fixtureDecisionProviders, fullAxFixtureService, synthesisCollectionControl, synthesisFixtureAnswer } from './synthesis-fixture.ts'
import { canonicalJson } from '../../helpers/canonical-json.ts'

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
      authorizeMutation: vi.fn(async () => {})
    }
    const kernel = new ActionKernel()
    registerPageProposalActions(kernel, {
      knex,
      operations,
      resolveRequester: async () => ({}) as Express.User,
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
    const fresh = ACTION_CATALOG['pages.prepareCreate'].output.parse(await execute('new-create'))
    const newRow = await knex('agentProposals').where({ id: fresh.proposalId }).first()
    expect(newRow.resultCanonicalSha256).toBeNull()
    const operation = JSON.parse(newRow.operation)
    const historical = await persistProposal(knex, {
      authority: prepareAuthority,
      actionCallId: 'pre-id-create',
      risk: 'proposal',
      input,
      operation,
      summary: newRow.summary,
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
      { ...input, content: '# Different\n' }
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
    { title: 'New page', encodedTitle: 'New page' },
    { title: 'Odd ` <b> [[cite:forged]] *title*', encodedTitle: 'Odd \\u0060 \\u003cb\\u003e \\u005b\\u005bcite:forged\\u005d\\u005d \\u002atitle\\u002a' }
  ])('creates a page once and carries its authenticated render-safe outcome through real action sessions: $title', async ({ title, encodedTitle }) => {
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
    const missingPage = (): Error => Object.assign(new Error('missing'), { name: 'PageNotFoundError' })
    const operations = {
      get: vi.fn(async () => {
        if (!readable) throw Object.assign(new Error('Page read forbidden'), { status: 403 })
        if (!currentPage) throw missingPage()
        return { ...currentPage }
      }),
      getByPath: vi.fn(async () => {
        if (replacementPage !== null) return { ...replacementPage }
        if (!currentPage) throw missingPage()
        return { ...currentPage }
      }),
      getVersion: vi.fn(),
      create: vi.fn(async (value: { input: Record<string, unknown> }) => {
        currentPage = {
          id: 43,
          ...value.input,
          editor: 'markdown',
          sourceRevision: '1',
          updatedAt: '2026-10-15T15:59:38.000Z'
        }
        return { ...currentPage }
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
      resolveRequester: async () => ({}) as Express.User,
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
    const preparedPromise = withInvokingAgentRunLease(signal, { id: runId, ownerId: 7, attempts: 1, leaseOwner, leaseToken }, () =>
      kernel.execute({
        authority: prepareAuthority,
        actionCallId: 'create-call',
        input: {
          path: 'docs/new-page',
          locale: 'en',
          title,
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
    expect(currentPage).toMatchObject({ path: 'docs/new-page', locale: 'en', sourceRevision: '1' })
    expect(await knex('agentProposals').where({ id: approval.proposalId }).first('status')).toEqual({ status: 'applied' })
    expect(await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).first('status')).toEqual({ status: 'committed' })
    const execution = await knex('agentActionExecutions').where({ proposalId: approval.proposalId }).first('result')
    expect(prepared).toMatchObject({
      application: { resultHash: createHash('sha256').update(execution.result).digest('hex') }
    })

    const application = ACTION_CATALOG['pages.prepareCreate'].output.parse(prepared).application
    if (application === undefined || application.page === null) throw new Error('Expected the real committed create result')
    expect(application.resultHash).toMatch(/^[a-f0-9]{64}$/u)
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
      messages: [{ role: 'user', content: 'Report the applied creation outcome.' }],
      memory: { user: [], agent: [] },
      skills: [],
      currentPage: null,
      signal
    }
    const session = await sessions.open(engineRequest)
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
          actionInput:
            actionName === 'pages.prepareCreate'
              ? {
                  path: 'docs/new-page',
                  locale: 'en',
                  title,
                  description: 'Created by the agent',
                  content: '# New page\n',
                  contentType: 'markdown',
                  isPublished: true,
                  tags: []
                }
              : { proposalId: approval.proposalId, approvalId: approval.id },
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
