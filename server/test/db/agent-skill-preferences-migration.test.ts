/** @vitest-environment node */
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { down, up } from '../../db/migrations/2.5.146.ts'

const userId = 7
const oldSessionId = '00000000-0000-4000-8000-000000000001'
const latestSessionId = '00000000-0000-4000-8000-000000000002'
const skillId = '00000000-0000-4000-8000-000000000003'
const oldVersionId = '00000000-0000-4000-8000-000000000004'
const currentVersionId = '00000000-0000-4000-8000-000000000005'

const createLegacySchema = async (db: Knex): Promise<void> => {
  await db.schema.createTable('users', table => table.integer('id').primary())
  await db.schema.createTable('agentSessions', table => {
    table.uuid('id').primary()
    table.integer('ownerId').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('deletedAt').nullable()
  })
  await db.schema.createTable('agentSkills', table => {
    table.uuid('id').primary()
    table.uuid('currentVersionId').nullable()
  })
  await db.schema.createTable('agentSkillVersions', table => {
    table.uuid('id').primary()
    table.uuid('skillId').notNullable()
  })
  await db.schema.createTable('agentSessionSkills', table => {
    table.uuid('sessionId').notNullable()
    table.uuid('skillVersionId').notNullable()
    table.integer('ordinal').notNullable()
    table.integer('selectedBy').notNullable()
    table.dateTime('selectedAt').notNullable()
  })
}

describe('agent skill preference migration', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createLegacySchema(db)
    await db('users').insert({ id: userId })
    await db('agentSessions').insert([
      { id: oldSessionId, ownerId: userId, updatedAt: new Date('2026-08-16T00:00:00.000Z'), deletedAt: null },
      { id: latestSessionId, ownerId: userId, updatedAt: new Date('2026-08-17T00:00:00.000Z'), deletedAt: null }
    ])
    await db('agentSkills').insert({ id: skillId, currentVersionId })
    await db('agentSkillVersions').insert([
      { id: oldVersionId, skillId },
      { id: currentVersionId, skillId }
    ])
    await db('agentSessionSkills').insert([
      { sessionId: oldSessionId, skillVersionId: currentVersionId, ordinal: 0, selectedBy: userId, selectedAt: new Date('2026-08-16T00:00:00.000Z') },
      { sessionId: latestSessionId, skillVersionId: oldVersionId, ordinal: 0, selectedBy: userId, selectedAt: new Date('2026-08-17T00:00:00.000Z') }
    ])
  })

  afterEach(async () => db.destroy())

  it('migrates the latest conversation selection to a stable skill identity', async () => {
    await up(db)

    await expect(db.schema.hasTable('agentSessionSkills')).resolves.toBe(false)
    expect(await db('agentUserSkillPreferences').select('ownerId', 'skillId', 'ordinal')).toEqual([{ ownerId: userId, skillId, ordinal: 0 }])
    expect(await db('agentSkillVersions').orderBy('id').pluck('id')).toEqual([oldVersionId, currentVersionId])

    await down(db)
    await expect(db.schema.hasTable('agentUserSkillPreferences')).resolves.toBe(false)
    expect(await db('agentSessionSkills').orderBy('sessionId').select('sessionId', 'skillVersionId', 'ordinal')).toEqual([
      { sessionId: oldSessionId, skillVersionId: currentVersionId, ordinal: 0 },
      { sessionId: latestSessionId, skillVersionId: currentVersionId, ordinal: 0 }
    ])
  })
})
