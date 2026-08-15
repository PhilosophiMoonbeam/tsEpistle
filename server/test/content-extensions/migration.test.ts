import knexFactory, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as createRegistry } from '../../db/migrations/2.5.135.ts'
import { down as removeRichExtensions, up as installRichExtensions } from '../../db/migrations/2.5.137.ts'
import { down as removeVisibleExtensions, up as installVisibleExtensions } from '../../db/migrations/2.5.138.ts'

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
    await createRegistry(db)
    await installRichExtensions(db)
    await installVisibleExtensions(db)

    const columns = await db(tableName).columnInfo()
    expect(Object.keys(columns).sort()).toEqual(['isEnabled', 'key', 'updatedAt', 'updatedBy', 'version'])

    expect(await db(tableName).orderBy('key')).toEqual([
      ...['diagram', 'gallery', 'index', 'infobox', 'kroki', 'map', 'media', 'pdf', 'plantuml', 'qr', 'spoiler', 'tabs', 'youtube']
        .map(key => expect.objectContaining({ isEnabled: 0, key, version: 1 }))
    ])
  })

  it('is idempotent for restored databases', async () => {
    await createRegistry(db)
    await createRegistry(db)
    await installRichExtensions(db)
    await installRichExtensions(db)
    await installVisibleExtensions(db)
    await installVisibleExtensions(db)

    expect(await db.schema.hasTable(tableName)).toBe(true)
  })

  it('rolls back only the rich extension additions', async () => {
    await createRegistry(db)
    await installRichExtensions(db)
    await removeRichExtensions(db)
    await installVisibleExtensions(db)
    await removeVisibleExtensions(db)

    expect(await db(tableName).select('key')).toEqual([{ key: 'qr' }])
  })
})
