import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { up as addAgentGoalBudgetTiers, down as removeAgentGoalBudgetTiers } from '../../db/migrations/tsepistle-000042-agent-goal-budget-tiers.ts'
import { down, up } from '../../db/migrations/2.5.157.ts'
import { updateGoalStatus } from '../../agents/goals.ts'

describe('agent durable goals migration', () => {
  const databases: Knex[] = []
  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  it('adds one durable open goal per session and refuses destructive rollback', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    databases.push(db)
    await db.schema.createTable('users', table => table.integer('id').primary())
    await db.schema.createTable('agentSessions', table => table.uuid('id').primary())
    await db.schema.createTable('agentRuns', table => {
      table.uuid('id').primary()
      table.uuid('sessionId').notNullable()
      table.dateTime('queuedAt').notNullable()
    })
    await db.schema.createTable('agentMessages', table => table.uuid('id').primary())
    const sessionId = '00000000-0000-4000-8000-000000000001'
    await db('users').insert({ id: 7 })
    await db('agentSessions').insert({ id: sessionId })

    await up(db)

    expect(await db.schema.hasTable('agentGoals')).toBe(true)
    expect(await db.schema.hasColumn('agentRuns', 'goalId')).toBe(true)
    expect(await db.schema.hasColumn('agentRuns', 'completionAssessmentSha256')).toBe(true)
    expect(await db.schema.hasColumn('agentMessages', 'isVisible')).toBe(true)
    const now = new Date('2026-09-01T00:00:00.000Z')
    const goal = {
      sessionId,
      ownerId: 7,
      createdByUserId: 7,
      objective: 'Reconcile the incident runbook',
      objectiveSha256: 'a'.repeat(64),
      version: 1,
      continuationCount: 0,
      maxContinuations: 3,
      consumedTokens: 0,
      maxTokens: 48_000,
      consumedToolCalls: 0,
      maxToolCalls: 96,
      startedAt: now,
      deadlineAt: new Date(now.valueOf() + 3_600_000),
      updatedAt: now
    }
    await db('agentGoals').insert({ id: '00000000-0000-4000-8000-000000000002', status: 'active', ...goal })
    await expect(Promise.resolve(db('agentGoals').insert({ id: '00000000-0000-4000-8000-000000000003', status: 'paused', ...goal }))).rejects.toThrow()
    await expect(Promise.resolve(down(db))).rejects.toThrow('refuse destructive rollback')

    await db('agentGoals').delete()
    await down(db)
    expect(await db.schema.hasTable('agentGoals')).toBe(false)
    expect(await db.schema.hasColumn('agentRuns', 'goalId')).toBe(false)
    expect(await db.schema.hasColumn('agentMessages', 'isVisible')).toBe(false)
  })
  it('preserves legacy lifecycle reasons and selected policy data on migration rerun', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    databases.push(db)
    await db.schema.createTable('users', table => table.integer('id').primary())
    await db.schema.createTable('agentSessions', table => table.uuid('id').primary())
    await db.schema.createTable('agentRuns', table => {
      table.uuid('id').primary()
      table.uuid('sessionId').notNullable()
      table.dateTime('queuedAt').notNullable()
    })
    await db.schema.createTable('agentMessages', table => table.uuid('id').primary())
    const legacySessionId = '00000000-0000-4000-8000-000000000101'
    const modernSessionId = '00000000-0000-4000-8000-000000000102'
    await db('users').insert({ id: 7 })
    await db('agentSessions').insert([{ id: legacySessionId }, { id: modernSessionId }])
    await up(db)

    const startedAt = new Date('2026-09-01T00:00:00.000Z')
    const legacyObjective = 'Preserve this historical goal exactly'
    const legacyId = '00000000-0000-4000-8000-000000000111'
    await db('agentGoals').insert({
      id: legacyId,
      sessionId: legacySessionId,
      ownerId: 7,
      createdByUserId: 7,
      objective: legacyObjective,
      objectiveSha256: createHash('sha256').update(legacyObjective).digest('hex'),
      status: 'active',
      version: 4,
      continuationCount: 2,
      maxContinuations: 5,
      consumedTokens: 321,
      maxTokens: 1_234,
      consumedToolCalls: 7,
      maxToolCalls: 19,
      completionOutcome: null,
      completionAssessment: null,
      completionAssessmentSha256: null,
      errorCode: 'HISTORICAL_WARNING',
      errorMessage: 'Historical goal retained for migration coverage',
      startedAt,
      deadlineAt: new Date('2026-09-02T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T01:00:00.000Z'),
      completedAt: null
    })

    const legacyBeforeMigration = await db('agentGoals').where({ id: legacyId }).first()

    await addAgentGoalBudgetTiers(db)
    const migrated = await db('agentGoals').where({ id: legacyId }).first()
    expect(migrated).toMatchObject(legacyBeforeMigration)
    expect(migrated).toMatchObject({
      status: 'active',
      version: 4,
      continuationCount: 2,
      consumedTokens: 321,
      maxTokens: 1_234,
      consumedToolCalls: 7,
      maxToolCalls: 19,
      budgetPolicyVersion: null,
      budgetSelection: 'legacy',
      tokenTier: null,
      tokenAllowance: null,
      budgetCycle: 0,
      budgetLimitReason: null,
      errorCode: 'HISTORICAL_WARNING'
    })

    const modernId = '00000000-0000-4000-8000-000000000112'
    const modernObjective = 'Modern selected goal'
    await db('agentGoals').insert({
      id: modernId,
      sessionId: modernSessionId,
      ownerId: 7,
      createdByUserId: 7,
      objective: modernObjective,
      objectiveSha256: createHash('sha256').update(modernObjective).digest('hex'),
      status: 'budget_limited',
      version: 8,
      continuationCount: 3,
      maxContinuations: 5,
      consumedTokens: 800,
      maxTokens: 900,
      consumedToolCalls: 12,
      maxToolCalls: 20,
      budgetPolicyVersion: 1,
      budgetSelection: 'utility',
      tokenTier: 'standard',
      tokenAllowance: 450,
      budgetCycle: 2,
      budgetLimitReason: 'tokens',
      completionOutcome: null,
      completionAssessment: null,
      completionAssessmentSha256: null,
      errorCode: 'GOAL_BUDGET_LIMITED',
      errorMessage: 'Goal token budget was exhausted',
      startedAt,
      deadlineAt: new Date('2026-09-02T00:00:00.000Z'),
      updatedAt: new Date('2026-09-01T01:00:00.000Z'),
      completedAt: new Date('2026-09-01T01:00:00.000Z')
    })

    const transitioned = await updateGoalStatus(db, {
      ownerId: 7,
      goalId: legacyId,
      expectedVersion: 4,
      from: ['active'],
      to: 'paused',
      budgetLimitReason: 'accounting',
      now: new Date('2026-09-01T02:00:00.000Z')
    })
    expect(transitioned).toMatchObject({
      status: 'paused',
      version: 5,
      continuationCount: 2,
      consumedTokens: 321,
      maxTokens: 1_234,
      consumedToolCalls: 7,
      maxToolCalls: 19,
      budgetPolicyVersion: null,
      budgetSelection: 'legacy',
      tokenTier: null,
      tokenAllowance: null,
      budgetCycle: 0,
      budgetLimitReason: 'accounting',
      canRenewTokenBudget: false
    })

    const transitionedBeforeRerun = await db('agentGoals').where({ id: legacyId }).first()
    const modernBeforeRerun = await db('agentGoals').where({ id: modernId }).first()
    await expect(Promise.resolve(removeAgentGoalBudgetTiers(db))).rejects.toThrow('selected token budget state')

    await addAgentGoalBudgetTiers(db)

    expect(await db('agentGoals').where({ id: legacyId }).first()).toEqual(transitionedBeforeRerun)
    expect(await db('agentGoals').where({ id: modernId }).first()).toEqual(modernBeforeRerun)
  })
})
