import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'
import { down, up } from '../../db/migrations/tsepistle-000069-page-history-reasons.ts'

describe('nullable revision reason migration', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    for (const tableName of ['pages', 'pageHistory']) {
      await db.schema.createTable(tableName, table => {
        table.integer('id').primary()
        table.text('content').notNullable()
        table.bigInteger('sourceRevision').notNullable()
      })
      await db(tableName).insert({ id: 17, content: '# Unchanged legacy source\r\n', sourceRevision: 8 })
    }
  })

  afterEach(async () => db.destroy())

  it('adds nullable reasons without inventing legacy values or changing source identity', async () => {
    await up(db)
    await up(db)
    for (const tableName of ['pages', 'pageHistory']) {
      expect(await db(tableName)).toEqual([{ id: 17, content: '# Unchanged legacy source\r\n', sourceRevision: 8, changeReason: null }])
    }
    await down(db)
    for (const tableName of ['pages', 'pageHistory']) {
      expect(await db(tableName)).toEqual([{ id: 17, content: '# Unchanged legacy source\r\n', sourceRevision: 8 }])
    }
  })

  it.each(['pages', 'pageHistory'])('refuses lossy rollback when %s retains a saved reason', async tableName => {
    await up(db)
    await db(tableName).where({ id: 17 }).update({ changeReason: 'Keep this actual revision reason' })
    const before = { pages: await db('pages'), history: await db('pageHistory') }
    await expect(down(db)).rejects.toThrow('Cannot roll down page history reasons while saved reasons exist')
    expect(await db('pages')).toEqual(before.pages)
    expect(await db('pageHistory')).toEqual(before.history)
  })
})
