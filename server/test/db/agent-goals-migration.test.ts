import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { down, up } from '../../db/migrations/2.5.157.ts'

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
})
