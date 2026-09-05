import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'
import { down, up } from '../../db/migrations/tsepistle-000014-editorial-typeface-default.ts'

describe('editorial typeface default migration', () => {
  let database: Knex | undefined
  afterEach(async () => { await database?.destroy() })

  it('defaults new accounts to blend while preserving saved choices through upgrade and rollback', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    database = db
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
      table.string('fontFamily').notNullable().defaultTo('roboto-flex')
    })
    await db('users').insert([{ id: 1, fontFamily: 'newsreader' }, { id: 2, fontFamily: 'roboto-flex' }])
    await up(db)
    await db('users').insert({ id: 3 })
    expect(await db('users').orderBy('id')).toEqual([
      { id: 1, fontFamily: 'newsreader' },
      { id: 2, fontFamily: 'roboto-flex' },
      { id: 3, fontFamily: 'blend' }
    ])
    await down(db)
    await db('users').insert({ id: 4 })
    expect(await db('users').orderBy('id')).toEqual([
      { id: 1, fontFamily: 'newsreader' },
      { id: 2, fontFamily: 'roboto-flex' },
      { id: 3, fontFamily: 'blend' },
      { id: 4, fontFamily: 'roboto-flex' }
    ])
  })
})
