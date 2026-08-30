import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

import type { AgentRunClaim } from '../../agents/coordinator.ts'
import { validateChildEvidencePacket, type AgentResearchTask } from '../../agents/orchestration.ts'
import {
  cancelAgentRunTasks,
  createAgentRunTasks,
  failAgentRunTask,
  finishAgentRunTask,
  listAgentRunTasks,
  listAgentTaskViews,
  recoverAgentRunTasks,
  startAgentRunTask
} from '../../agents/tasks.ts'
import { down as removeAgentTaskLedger, up as addAgentTaskLedger } from '../../db/migrations/2.5.156.ts'

const runId = '00000000-0000-4000-8000-000000000001'
const leaseToken = '00000000-0000-4000-8000-000000000002'
const firstTaskId = '00000000-0000-4000-8000-000000000003'
const secondTaskId = '00000000-0000-4000-8000-000000000004'
const firstSubagentId = '00000000-0000-4000-8000-000000000005'
const secondSubagentId = '00000000-0000-4000-8000-000000000006'

const claim = {
  id: runId,
  ownerId: 7,
  leaseOwner: 'task-test-worker',
  leaseToken,
  attempts: 1
} as AgentRunClaim

const tasks: readonly AgentResearchTask[] = [
  {
    id: firstTaskId,
    kind: 'source_scout',
    title: 'Review alpha',
    question: 'What does alpha require?',
    sourceScope: ['alpha'],
    requiredEvidenceCount: 1
  },
  {
    id: secondTaskId,
    kind: 'fact_check',
    title: 'Verify beta',
    question: 'Is the beta date correct?',
    sourceScope: ['beta'],
    requiredEvidenceCount: 1
  }
]

const plannerUsage = { inputTokens: 12, outputTokens: 4, costMicros: 0 }

const completedPacket = validateChildEvidencePacket(
  JSON.stringify({
    taskId: firstTaskId,
    outcome: 'completed',
    claims: [
      {
        text: 'Alpha requires review. [[cite:page:1]]',
        evidenceIds: ['page:1'],
        sourceRevisionIds: ['rev-1'],
        confidence: 'high'
      }
    ],
    conflicts: [],
    unanswered: [],
    recommendedFollowups: []
  }),
  tasks[0]!,
  new Map([['page:1', 'rev-1']])
)

describe('durable agent task ledger', () => {
  let knex: Knex

  beforeEach(async () => {
    knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await knex.schema.createTable('agentRuns', table => {
      table.uuid('id').primary()
      table.uuid('sessionId').notNullable()
      table.integer('ownerId').notNullable()
      table.string('status').notNullable()
      table.string('leaseOwner').nullable()
      table.uuid('leaseToken').nullable()
      table.dateTime('cancelRequestedAt').nullable()
      table.integer('eventSequence').notNullable().defaultTo(0)
      table.dateTime('updatedAt').notNullable()
      table.dateTime('queuedAt').notNullable()
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
    await addAgentTaskLedger(knex)
    await knex('agentRuns').insert({
      id: runId,
      sessionId: 'session-1',
      ownerId: 7,
      status: 'running',
      leaseOwner: claim.leaseOwner,
      leaseToken,
      cancelRequestedAt: null,
      eventSequence: 0,
      updatedAt: new Date(),
      queuedAt: '2026-08-30T00:00:01.000Z'
    })
  })

  afterEach(async () => {
    await knex.destroy()
  })

  it('persists an atomic plan and fenced child lifecycle with idempotent completion', async () => {
    const created = await createAgentRunTasks(knex, claim, tasks, plannerUsage)
    expect(created.map(task => task.status)).toEqual(['pending', 'pending'])
    expect(await knex('agentEvents').orderBy('sequence').pluck('type')).toEqual(['task.planCreated', 'task.created', 'task.created'])

    const active = await startAgentRunTask(knex, claim, firstTaskId, firstSubagentId)
    expect(active).toMatchObject({ status: 'running', attempt: 1, subagentRunId: firstSubagentId })
    const finished = await finishAgentRunTask(knex, claim, firstTaskId, firstSubagentId, completedPacket, 'a'.repeat(64))
    expect(finished).toMatchObject({ status: 'completed', outcome: 'completed', evidenceCount: 1, authoritySha256: 'a'.repeat(64) })

    const sequenceAfterCompletion = ((await knex('agentRuns').where({ id: runId }).first('eventSequence')) as { eventSequence: number }).eventSequence
    expect(await finishAgentRunTask(knex, claim, firstTaskId, firstSubagentId, completedPacket, 'a'.repeat(64))).toMatchObject({ status: 'completed' })
    expect(await knex('agentRuns').where({ id: runId }).first('eventSequence')).toEqual({ eventSequence: sequenceAfterCompletion })

    await startAgentRunTask(knex, claim, secondTaskId, secondSubagentId)
    await failAgentRunTask(knex, claim, secondTaskId, secondSubagentId, 'SOURCE_UNAVAILABLE')
    expect((await listAgentRunTasks(knex, runId)).map(task => ({ status: task.status, outcome: task.outcome }))).toEqual([
      { status: 'completed', outcome: 'completed' },
      { status: 'failed', outcome: 'failed' }
    ])
  })

  it('projects only authorized selected-run tasks in deterministic order and rejects overflow', async () => {
    const earlierRunId = '00000000-0000-4000-8000-000000000010'
    const omittedRunId = '00000000-0000-4000-8000-000000000011'
    const foreignRunId = '00000000-0000-4000-8000-000000000012'
    const otherSessionRunId = '00000000-0000-4000-8000-000000000013'
    await knex('agentRuns').insert([
      {
        id: earlierRunId,
        ownerId: 7,
        sessionId: 'session-1',
        status: 'succeeded',
        eventSequence: 0,
        updatedAt: new Date(),
        queuedAt: '2026-08-30T00:00:00.000Z'
      },
      {
        id: omittedRunId,
        ownerId: 7,
        sessionId: 'session-1',
        status: 'succeeded',
        eventSequence: 0,
        updatedAt: new Date(),
        queuedAt: '2026-08-30T00:00:02.000Z'
      },
      {
        id: foreignRunId,
        ownerId: 8,
        sessionId: 'session-1',
        status: 'succeeded',
        eventSequence: 0,
        updatedAt: new Date(),
        queuedAt: '2026-08-30T00:00:03.000Z'
      },
      {
        id: otherSessionRunId,
        ownerId: 7,
        sessionId: 'session-2',
        status: 'succeeded',
        eventSequence: 0,
        updatedAt: new Date(),
        queuedAt: '2026-08-30T00:00:04.000Z'
      }
    ])
    const taskRow = (id: string, selectedRunId: string, ordinal: number, title: string) => ({
      id,
      runId: selectedRunId,
      ordinal,
      kind: 'source_scout',
      title,
      question: `${title}?`,
      sourceScope: '["alpha"]',
      requiredEvidenceCount: 1
    })
    await knex('agentRunTasks').insert([
      taskRow('00000000-0000-4000-8000-000000000020', runId, 1, 'Selected second'),
      taskRow('00000000-0000-4000-8000-000000000021', runId, 0, 'Selected first'),
      taskRow('00000000-0000-4000-8000-000000000022', earlierRunId, 0, 'Earlier selected'),
      taskRow('00000000-0000-4000-8000-000000000023', omittedRunId, 0, 'Omitted'),
      taskRow('00000000-0000-4000-8000-000000000024', foreignRunId, 0, 'Foreign'),
      taskRow('00000000-0000-4000-8000-000000000025', otherSessionRunId, 0, 'Other session')
    ])

    const projected = await listAgentTaskViews(knex, 7, 'session-1', [runId, earlierRunId, foreignRunId, otherSessionRunId], 3)
    expect(projected.map(task => task.title)).toEqual(['Earlier selected', 'Selected first', 'Selected second'])
    await expect(listAgentTaskViews(knex, 7, 'session-1', [runId, earlierRunId], 2)).rejects.toMatchObject({
      code: 'AGENT_TASK_PROJECTION_OVERFLOW',
      status: 500
    })
  })

  it('recovers abandoned child attempts and cancels the whole pending work tree', async () => {
    await createAgentRunTasks(knex, claim, tasks, plannerUsage)
    await startAgentRunTask(knex, claim, firstTaskId, firstSubagentId)
    await recoverAgentRunTasks(knex, claim)
    expect(await listAgentRunTasks(knex, runId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: firstTaskId, status: 'pending', subagentRunId: null, errorCode: 'SUBAGENT_ATTEMPT_SUPERSEDED' })])
    )

    await startAgentRunTask(knex, claim, firstTaskId, secondSubagentId)
    await cancelAgentRunTasks(knex, claim)
    expect((await listAgentRunTasks(knex, runId)).map(task => task.status)).toEqual(['cancelled', 'cancelled'])
    expect(await knex('agentEvents').where({ type: 'task.cancelled' }).count<{ count: number | string }[]>({ count: '*' }).first()).toMatchObject({ count: 2 })
  })

  it('refuses a destructive rollback while durable research tasks exist', async () => {
    await createAgentRunTasks(knex, claim, tasks, plannerUsage)
    await expect(Promise.resolve(removeAgentTaskLedger(knex))).rejects.toThrow('agentRunTasks contains durable research state')
    await knex('agentRunTasks').delete()
    await removeAgentTaskLedger(knex)
    expect(await knex.schema.hasTable('agentRunTasks')).toBe(false)
  })
})
