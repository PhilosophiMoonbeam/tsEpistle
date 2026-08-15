import knexFactory, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up } from '../../db/migrations/2.5.135.ts'

const tableName = 'contentExtensions'
let db: Knex

describe('content extension registry migration', () => {
  beforeEach(async () => {
    db = knexFactory({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await db.schema.createTable('users', table => {
      table.integer('id').primary()
    })
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('creates a disabled versioned registry with audit columns', async () => {
    await up(db)

    const columns = await db(tableName).columnInfo()
    expect(Object.keys(columns).sort()).toEqual(['isEnabled', 'key', 'updatedAt', 'updatedBy', 'version'])

    expect(await db(tableName).where({ key: 'qr' }).first()).toMatchObject({ isEnabled: 0, key: 'qr', version: 1 })
  })

  it('is idempotent for restored databases', async () => {
    await up(db)
    await up(db)

    expect(await db.schema.hasTable(tableName)).toBe(true)
  })
})
