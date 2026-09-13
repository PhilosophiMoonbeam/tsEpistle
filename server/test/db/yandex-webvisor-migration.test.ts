import createKnex, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from '../bun-test.mts'
import { down, up } from '../../db/migrations/tsepistle-000032-yandex-webvisor.ts'

const config = (value: unknown): Record<string, unknown> =>
  typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : (value as Record<string, unknown>)

describe('Yandex session replay migration', () => {
  let database: Knex | undefined
  afterEach(async () => { await database?.destroy() })

  it('makes legacy replay explicit without changing enablement, opt-outs, or unrelated configuration', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    database = db
    await db.schema.createTable('analytics', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.json('config')
    })
    await db('analytics').insert([
      { key: 'yandex', isEnabled: true, config: JSON.stringify({ tagNumber: '42', opaque: 'preserved' }) },
      { key: 'other', isEnabled: true, config: JSON.stringify({ untouched: true }) }
    ])

    await up(db)
    await up(db)

    const yandex = await db('analytics').where({ key: 'yandex' }).first()
    expect(yandex.isEnabled).toBe(1)
    expect(config(yandex.config)).toEqual({ tagNumber: '42', opaque: 'preserved', webvisor: 'true' })
    expect(config((await db('analytics').where({ key: 'other' }).first()).config)).toEqual({ untouched: true })

    await expect(Promise.resolve(down(db))).rejects.toThrow('Cannot discard the explicit Yandex session replay setting')
  })

  it('defaults disabled legacy rows off and preserves an explicit privacy choice', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    database = db
    await db.schema.createTable('analytics', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.json('config')
    })
    await db('analytics').insert({ key: 'yandex', isEnabled: false, config: JSON.stringify({ tagNumber: '42' }) })

    await up(db)
    expect(config((await db('analytics').where({ key: 'yandex' }).first()).config).webvisor).toBe('false')

    await db('analytics').where({ key: 'yandex' }).update({ isEnabled: true, config: JSON.stringify({ tagNumber: '42', webvisor: 'false' }) })
    await up(db)
    expect(config((await db('analytics').where({ key: 'yandex' }).first()).config)).toEqual({ tagNumber: '42', webvisor: 'false' })
  })

  it('does not replace malformed configuration', async () => {
    const db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    database = db
    await db.schema.createTable('analytics', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.text('config')
    })
    await db('analytics').insert({ key: 'yandex', isEnabled: true, config: 'not-json' })

    await up(db)
    expect((await db('analytics').where({ key: 'yandex' }).first()).config).toBe('not-json')
  })
})
