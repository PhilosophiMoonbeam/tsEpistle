import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

import { MigrationPreflightError, preflightMigrations } from '../../db/migration-preflight.ts'
import { MIGRATION_LINEAGE_V1 } from '../../db/migration-contract.ts'

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
    await db('migrations').insert(
      names.map((name, index) => ({
        batch: 1,
        migration_time: new Date(Date.UTC(2026, 0, index + 1)),
        name
      }))
    )
  }
}

const createApplicationTable = async (db: Knex, tableName = 'pages'): Promise<void> => {
  await db.schema.createTable(tableName, table => {
    table.increments('id').primary()
  })
}

const createLegacyForkSchemaSignature = async (db: Knex): Promise<void> => {
  for (const tableName of ['pages', 'pageHistory', 'pageTree']) {
    await db.schema.createTable(tableName, table => {
      table.increments('id').primary()
      table.string('visibility', 16).notNullable()
      table.integer('ownerId').nullable()
    })
  }
}

const createLineageMarker = async (db: Knex, version = MIGRATION_LINEAGE_V1.version): Promise<void> => {
  await db.schema.createTable(MIGRATION_LINEAGE_V1.tableName, table => {
    table.string('product', 32).primary()
    table.integer('lineageVersion').notNullable()
    table.string('upstreamMigrationCutoff', 64).notNullable()
    table.string('legacyForkMigrationStart', 64).notNullable()
    table.string('legacyForkMigrationEnd', 64).notNullable()
    table.string('namespacedMigrationStart', 128).notNullable()
  })
  await db(MIGRATION_LINEAGE_V1.tableName).insert({
    product: MIGRATION_LINEAGE_V1.product,
    lineageVersion: version,
    upstreamMigrationCutoff: MIGRATION_LINEAGE_V1.upstreamCutoff,
    legacyForkMigrationStart: MIGRATION_LINEAGE_V1.legacyForkStart,
    legacyForkMigrationEnd: MIGRATION_LINEAGE_V1.legacyForkEnd,
    namespacedMigrationStart: MIGRATION_LINEAGE_V1.namespacedStart
  })
}

describe('database migration preflight', () => {
  let db: Knex
  const currentMigration = 'tsepistle-000013-product-rename.js'
  const available = ['2.0.0.js', '2.5.128.js', '2.5.129.js', MIGRATION_LINEAGE_V1.namespacedStart, currentMigration]

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

    expect(
      await preflightMigrations(db, migrationSource(available), {
        legacyMigrationNames: legacy
      })
    ).toEqual({
      applied: legacy.slice(0, 2),
      available,
      state: 'legacy-beta'
    })
  })

  it('refuses mixed or out-of-order legacy beta ledgers before migration writes', async () => {
    const legacy = ['2.0.0-beta.1.js', '2.0.0-beta.11.js', '2.0.0-rc.2.js']
    await createApplicationTable(db)
    await createLedger(db, [legacy[1]])

    await expect(
      Promise.resolve(
        preflightMigrations(db, migrationSource(available), {
          legacyMigrationNames: legacy
        })
      )
    ).rejects.toThrow('Legacy beta migration history is incomplete or out of order')

    await db('migrations').delete()
    await db('migrations').insert([
      { batch: 1, migration_time: new Date(), name: legacy[0] },
      { batch: 1, migration_time: new Date(), name: 'custom-beta-patch.js' }
    ])
    await expect(
      Promise.resolve(
        preflightMigrations(db, migrationSource(available), {
          legacyMigrationNames: legacy
        })
      )
    ).rejects.toThrow('Legacy beta migration history contains unsupported records')
  })

  it('refuses an early application table without a migration ledger', async () => {
    await createApplicationTable(db, 'assets')

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toMatchObject({
      code: 'MIGRATION_PREFLIGHT_FAILED',
      message: expect.stringContaining('has no migrations ledger')
    })
  })

  it('refuses a recent durable application table without a migration ledger', async () => {
    await createApplicationTable(db, 'durableJobs')

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toMatchObject({
      code: 'MIGRATION_PREFLIGHT_FAILED',
      message: expect.stringContaining('has no migrations ledger')
    })
  })

  it('recognizes a database containing only an unrelated extension table as fresh', async () => {
    await db.schema.createTable('spatial_ref_sys', table => {
      table.integer('srid').primary()
    })

    expect(await preflightMigrations(db, migrationSource(available))).toEqual({
      applied: [],
      available,
      state: 'fresh'
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

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toThrow('unknown or newer build (3.0.0.js). Upgrade tsEpistle')
  })

  it('refuses migration gaps and out-of-order history', async () => {
    await createApplicationTable(db)
    await createLedger(db, ['2.0.0.js', '2.5.129.js'])

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toThrow('incomplete or out of order at 2.5.129.js')
  })

  it('accepts an existing deployed tsfranki ledger only when its schema carries the fork signature', async () => {
    await createLegacyForkSchemaSignature(db)
    await createLedger(db, available.slice(0, 3))

    expect(await preflightMigrations(db, migrationSource(available))).toEqual({
      applied: available.slice(0, 3),
      available,
      state: 'ready'
    })
  })

  it('refuses a same-name upstream migration that lacks the deployed tsfranki schema signature', async () => {
    await createApplicationTable(db)
    await createLedger(db, available.slice(0, 3))

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toThrow('Database migration lineage is ambiguous')
  })

  it('accepts a deployed namespaced ledger without rewriting its historical names', async () => {
    const deployedLedger = available.slice(0, -1)
    await createApplicationTable(db)
    await createLineageMarker(db)
    await createLedger(db, deployedLedger)

    expect(await preflightMigrations(db, migrationSource(available))).toEqual({
      applied: deployedLedger,
      available,
      state: 'ready'
    })
  })

  it('accepts current tsepistle history with the exact durable lineage marker', async () => {
    await createApplicationTable(db)
    await createLineageMarker(db)
    await createLedger(db, available)

    expect(await preflightMigrations(db, migrationSource(available))).toEqual({
      applied: available,
      available,
      state: 'ready'
    })
  })

  it('refuses missing, premature, or mismatched lineage markers', async () => {
    await createApplicationTable(db)
    await createLedger(db, available)
    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toThrow(
      'namespaced tsEpistle migrations exist without the schemaLineage marker'
    )

    await db('migrations').delete()
    await db('migrations').insert(
      available.slice(0, 2).map((name, index) => ({
        batch: 1,
        migration_time: new Date(Date.UTC(2026, 1, index + 1)),
        name
      }))
    )
    await createLineageMarker(db)
    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toThrow(
      'schemaLineage marker exists before tsfranki-000001-schema-lineage.js'
    )

    await db('migrations').delete()
    await db('migrations').insert(
      available.map((name, index) => ({
        batch: 1,
        migration_time: new Date(Date.UTC(2026, 2, index + 1)),
        name
      }))
    )
    await db(MIGRATION_LINEAGE_V1.tableName).update({ lineageVersion: 99 })
    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toThrow(
      'schemaLineage marker is missing or does not match this tsEpistle migration lineage'
    )
  })

  it('refuses a locked migration ledger with actionable recovery guidance', async () => {
    await createApplicationTable(db)
    await createLedger(db, ['2.0.0.js'])
    await db.schema.createTable('migrations_lock', table => {
      table.increments('index').primary()
      table.integer('is_locked').notNullable()
    })
    await db('migrations_lock').insert({ is_locked: 1 })

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toEqual(
      expect.objectContaining<Partial<MigrationPreflightError>>({
        code: 'MIGRATION_PREFLIGHT_FAILED',
        message: expect.stringContaining('Confirm that no other tsEpistle instance is migrating')
      })
    )
  })

  it('refuses migration records when the application schema is absent', async () => {
    await createLedger(db, ['2.0.0.js'])

    await expect(Promise.resolve(preflightMigrations(db, migrationSource(available)))).rejects.toThrow('none of the expected Wiki application tables')
  })
})
