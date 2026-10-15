import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

import { down, up } from '../../db/migrations/tsfranki-000008-content-extension-registry.ts'

interface ContentExtensionRow {
  key: string
  isEnabled: boolean | number
  version: number
  updatedAt: string
  updatedBy: number | null
}

const TABLE = 'contentExtensions'

describe('content extension registry migration', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
    })
    await db.schema.createTable(TABLE, table => {
      table.string('key', 64).primary()
      table.boolean('isEnabled').notNullable().defaultTo(false)
      table.integer('version').unsigned().notNullable()
      table.dateTime('updatedAt').notNullable()
      table.integer('updatedBy').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
    })
  })

  afterEach(async () => await db.destroy())

  it('preserves all persisted fields on existing registry rows', async () => {
    await db('users').insert({ id: 42 })
    await db<ContentExtensionRow>(TABLE).insert({
      key: 'qr',
      isEnabled: true,
      version: 7,
      updatedAt: '2026-01-02T03:04:05.000Z',
      updatedBy: 42
    })
    const existing = await db<ContentExtensionRow>(TABLE).where({ key: 'qr' }).first()

    await up(db)

    expect(await db<ContentExtensionRow>(TABLE).where({ key: 'qr' }).first()).toEqual(existing)
  })

  it('is a no-op on a second run', async () => {
    await up(db)
    const rowsAfterFirstRun = await db<ContentExtensionRow>(TABLE).orderBy('key')

    await up(db)

    expect(await db<ContentExtensionRow>(TABLE).orderBy('key')).toEqual(rowsAfterFirstRun)
  })

  it('does not remove registry state on rollback', async () => {
    await up(db)
    const rowsBeforeRollback = await db<ContentExtensionRow>(TABLE).orderBy('key')

    await down()

    expect(await db<ContentExtensionRow>(TABLE).orderBy('key')).toEqual(rowsBeforeRollback)
  })
})
