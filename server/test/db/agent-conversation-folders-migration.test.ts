import createKnex from 'knex'
import { afterEach, describe, expect, it } from 'vitest'

import { down, up } from '../../db/migrations/2.5.155.ts'

describe('agent conversation folders migration', () => {
  const databases: ReturnType<typeof createKnex>[] = []
  afterEach(async () => await Promise.all(databases.splice(0).map(async database => await database.destroy())))

  it('adds durable owner folders and an optional session folder relation', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    databases.push(db)
    await db.schema.createTable('users', table => table.integer('id').primary())
    await db.schema.createTable('agentSessions', table => {
      table.uuid('id').primary()
      table.integer('ownerId').notNullable()
      table.dateTime('lastActivityAt').notNullable()
    })
    await db('users').insert({ id: 7 })
    await db('agentSessions').insert({ id: '00000000-0000-4000-8000-000000000001', ownerId: 7, lastActivityAt: new Date('2026-08-27T00:00:00.000Z') })

    await up(db)

    expect(await db.schema.hasTable('agentConversationFolders')).toBe(true)
    expect(await db.schema.hasColumn('agentSessions', 'folderId')).toBe(true)
    await db('agentConversationFolders').insert({
      id: '00000000-0000-4000-8000-000000000002',
      ownerId: 7,
      name: 'Reference',
      normalizedName: 'reference',
      version: 1,
      createdAt: new Date('2026-08-27T00:00:00.000Z'),
      updatedAt: new Date('2026-08-27T00:00:00.000Z')
    })
    await db('agentSessions').where({ id: '00000000-0000-4000-8000-000000000001' }).update({ folderId: '00000000-0000-4000-8000-000000000002' })
    expect(await db('agentSessions').first('folderId')).toMatchObject({ folderId: '00000000-0000-4000-8000-000000000002' })
    await expect(db('agentConversationFolders').insert({
      id: '00000000-0000-4000-8000-000000000003',
      ownerId: 7,
      name: 'REFERENCE',
      normalizedName: 'reference',
      version: 1,
      createdAt: new Date('2026-08-27T00:00:00.000Z'),
      updatedAt: new Date('2026-08-27T00:00:00.000Z')
    })).rejects.toThrow()

    await down(db)

    expect(await db.schema.hasTable('agentConversationFolders')).toBe(false)
    expect(await db.schema.hasColumn('agentSessions', 'folderId')).toBe(false)
  })
})
