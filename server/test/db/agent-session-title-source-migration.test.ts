import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'
import { down, up } from '../../db/migrations/2.5.150.ts'

describe('agent session title source migration', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('agentSessions', table => {
      table.string('id').primary()
      table.string('title').notNullable()
    })
    await db('agentSessions').insert([
      { id: 'empty', title: '' },
      { id: 'titled', title: 'Existing title' }
    ])
  })

  afterEach(async () => db.destroy())

  it('tracks empty drafts separately while preserving existing titles as manual', async () => {
    await up(db)
    await up(db)

    expect(await db.schema.hasColumn('agentSessions', 'titleSource')).toBe(true)
    expect(await db('agentSessions').orderBy('id').select('id', 'title', 'titleSource')).toEqual([
      { id: 'empty', title: '', titleSource: 'none' },
      { id: 'titled', title: 'Existing title', titleSource: 'manual' }
    ])
  })

  it('removes only title provenance on rollback', async () => {
    await up(db)
    await down(db)

    expect(await db.schema.hasColumn('agentSessions', 'titleSource')).toBe(false)
    expect(await db('agentSessions').orderBy('id').select('id', 'title')).toEqual([
      { id: 'empty', title: '' },
      { id: 'titled', title: 'Existing title' }
    ])
  })
})
