import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'

import { up as createCollaborationRooms } from '../../db/migrations/2.5.136.ts'
import { up as addDiscardFencing } from '../../db/migrations/tsfranki-000012-collaboration-discard-fencing.ts'

const ROOM_TABLE = 'pageCollaborationRooms'
const CONTRIBUTOR_TABLE = 'pageCollaborationContributors'
const CONNECTION_TABLE = 'pageCollaborationConnections'

describe('collaboration discard fencing migration', () => {
  const databases: Knex[] = []

  afterEach(async () => {
    await Promise.all(databases.splice(0).map(database => database.destroy()))
  })

  it('upgrades an already-migrated collaboration room with conservative contributor history', async () => {
    const database = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    databases.push(database)
    await database.schema.createTable('users', table => table.integer('id').primary())
    await database.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.bigInteger('sourceRevision').notNullable()
    })
    await database('users').insert({ id: 7 })
    await database('pages').insert({ id: 42, sourceRevision: 9 })
    await createCollaborationRooms(database)
    await database(ROOM_TABLE).insert({
      pageId: 42,
      format: 'markdown',
      protocolVersion: 1,
      updateVersion: 1,
      revision: 3,
      state: 'legacy-state',
      baseUpdatedAt: '2026-08-15T12:00:00.000Z',
      updatedAt: '2026-08-15T12:01:00.000Z',
      updatedBy: 7
    })

    await addDiscardFencing(database)

    const room = await database(ROOM_TABLE).where({ pageId: 42 }).first()
    expect(room).toMatchObject({ generation: 1, baseSourceRevision: '9' })
    expect(await database(CONTRIBUTOR_TABLE).where({ pageId: 42 }).select('generation', 'userId')).toEqual([
      { generation: 1, userId: 0 }
    ])
    expect(await database.schema.hasTable(CONNECTION_TABLE)).toBe(true)
  })
})
