import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { down, up } from '../../db/migrations/2.5.151.ts'

describe('page locale relations migration', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('localeCode').notNullable()
    })
  })

  afterEach(async () => db.destroy())

  it('adds idempotent translation grouping with one page per locale', async () => {
    await up(db)
    await up(db)

    expect(await db.schema.hasColumn('pages', 'localeGroupId')).toBe(true)
    await db('pages').insert({ id: 1, localeCode: 'en', localeGroupId: '00000000-0000-4000-8000-000000000001' })
    await expect(db('pages').insert({ id: 2, localeCode: 'en', localeGroupId: '00000000-0000-4000-8000-000000000001' })).rejects.toThrow()
    await expect(db('pages').insert([
      { id: 3, localeCode: 'en', localeGroupId: null },
      { id: 4, localeCode: 'en', localeGroupId: null }
    ])).resolves.toBeDefined()
  })

  it('removes only translation grouping on rollback', async () => {
    await up(db)
    await down(db)

    expect(await db.schema.hasColumn('pages', 'localeGroupId')).toBe(false)
    expect(await db.schema.hasColumn('pages', 'localeCode')).toBe(true)
  })
})
