import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

import {
  MigrationPreflightError,
  preflightMigrations
} from '../../db/migration-preflight.ts'

type MigrationSpec = { name: string }

const migrationSource = (names: string[]): Knex.MigrationSource<MigrationSpec> => ({
  async getMigrations() {
    return names.map(name => ({ name }))
  },
  getMigrationName(migration) {
    return migration.name
  },
  async getMigration() {
    return { up: async () => undefined }
  }
})

const createLedger = async (db: Knex, names: string[]): Promise<void> => {
  await db.schema.createTable('migrations', table => {
    table.increments('id').primary()
    table.string('name').notNullable()
    table.integer('batch').notNullable()
    table.timestamp('migration_time').notNullable()
  })
  if (names.length > 0) {
    await db('migrations').insert(names.map((name, index) => ({
      batch: 1,
      migration_time: new Date(Date.UTC(2026, 0, index + 1)),
      name
    })))
  }
}

const createApplicationTable = async (db: Knex): Promise<void> => {
  await db.schema.createTable('pages', table => {
    table.increments('id').primary()
  })
}

describe('database migration preflight', () => {
  let db: Knex
  const available = ['2.0.0.js', '2.5.128.js', '2.5.129.js']

  beforeEach(() => {
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { max: 1, min: 1 },
      useNullAsDefault: true
    })
  })

  afterEach(async () => {
    await db.destroy()
  })

  it('recognizes an empty database as a fresh install', async () => {
    expect(await preflightMigrations(db, migrationSource(available))).toEqual({
      applied: [],
      available,
      state: 'fresh'
    })
  })

  it('accepts an ordered prefix of known migrations', async () => {
    await createApplicationTable(db)
    await createLedger(db, available.slice(0, 2))

    expect(await preflightMigrations(db, migrationSource(available))).toEqual({
      applied: available.slice(0, 2),
      available,
      state: 'ready'
    })
  })
  it('accepts only an ordered legacy beta prefix before normalization', async () => {
    const legacy = ['2.0.0-beta.1.js', '2.0.0-beta.11.js', '2.0.0-rc.2.js']
    await createApplicationTable(db)
    await createLedger(db, legacy.slice(0, 2))

    expect(await preflightMigrations(db, migrationSource(available), {
      legacyMigrationNames: legacy
    })).toEqual({
      applied: legacy.slice(0, 2),
      available,
      state: 'legacy-beta'
    })
  })

  it('refuses mixed or out-of-order legacy beta ledgers before migration writes', async () => {
    const legacy = ['2.0.0-beta.1.js', '2.0.0-beta.11.js', '2.0.0-rc.2.js']
    await createApplicationTable(db)
    await createLedger(db, [legacy[1]])

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available), {
      legacyMigrationNames: legacy
    }))).rejects.toThrow('Legacy beta migration history is incomplete or out of order')

    await db('migrations').delete()
    await db('migrations').insert([
      { batch: 1, migration_time: new Date(), name: legacy[0] },
      { batch: 1, migration_time: new Date(), name: 'custom-beta-patch.js' }
    ])
    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available), {
      legacyMigrationNames: legacy
    }))).rejects.toThrow('Legacy beta migration history contains unsupported records')
  })

  it('refuses application tables without a migration ledger', async () => {
    await createApplicationTable(db)

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toMatchObject({
      code: 'MIGRATION_PREFLIGHT_FAILED',
      message: expect.stringContaining('has no migrations ledger')
    })
  })

  it('refuses an empty ledger beside an existing application schema', async () => {
    await createApplicationTable(db)
    await createLedger(db, [])

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toThrow('migrations ledger is empty')
  })

  it('refuses unknown migrations from a newer or unrelated build', async () => {
    await createApplicationTable(db)
    await createLedger(db, ['2.0.0.js', '3.0.0.js'])

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toThrow('unknown or newer build (3.0.0.js)')
  })

  it('refuses migration gaps and out-of-order history', async () => {
    await createApplicationTable(db)
    await createLedger(db, ['2.0.0.js', '2.5.129.js'])

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toThrow('incomplete or out of order at 2.5.129.js')
  })

  it('refuses a locked migration ledger with actionable recovery guidance', async () => {
    await createApplicationTable(db)
    await createLedger(db, ['2.0.0.js'])
    await db.schema.createTable('migrations_lock', table => {
      table.increments('index').primary()
      table.integer('is_locked').notNullable()
    })
    await db('migrations_lock').insert({ is_locked: 1 })

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toEqual(expect.objectContaining<Partial<MigrationPreflightError>>({
      code: 'MIGRATION_PREFLIGHT_FAILED',
      message: expect.stringContaining('Confirm that no other tsFranki instance is migrating')
    }))
  })

  it('refuses migration records when the application schema is absent', async () => {
    await createLedger(db, ['2.0.0.js'])

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toThrow('none of the expected Wiki application tables')
  })
})
