import { createHash } from 'node:crypto'
import fs from 'node:fs'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

import type { DurableJob } from '../../core/durable-jobs.ts'
import { MigrationPreflightError, preflightMigrations } from '../../db/migration-preflight.ts'
import { MIGRATION_LINEAGE_V1 } from '../../db/migration-contract.ts'
import { up as createSiteLogoAuthority } from '../../db/migrations/tsepistle-000013-site-logo-authority.ts'
import { up as upgradeSiteLogoRenditions } from '../../db/migrations/tsepistle-000040-site-logo-renditions.ts'
import { cleanupSiteLogoRevisions } from '../../jobs/site-logo-process.ts'

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
  const currentMigration = 'tsepistle-000013-site-logo-authority.js'
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

const siteLogoDatabaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const siteLogoPasswordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const siteLogoPassword = siteLogoPasswordFile ? fs.readFileSync(siteLogoPasswordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const siteLogoConnection =
  siteLogoDatabaseName.endsWith('_site_logo_test') && siteLogoPassword
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? 'wiki-postgres',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        password: siteLogoPassword,
        database: siteLogoDatabaseName
      }
    : null
const siteLogoMigrationSuite = siteLogoConnection ? describe : describe.skip

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

siteLogoMigrationSuite('PostgreSQL managed site-logo migration contract', () => {
  let postgres: Knex

  const dropManagedLogoSchema = async (): Promise<void> => {
    await postgres.schema.dropTableIfExists('siteLogoState')
    await postgres.schema.dropTableIfExists('siteLogoRevisions')
    await postgres.schema.dropTableIfExists('siteLogoObjects')
    await postgres.schema.dropTableIfExists('durableJobs')
    await postgres.schema.dropTableIfExists('users')
  }

  beforeEach(async () => {
    postgres = createKnex({ client: 'pg', connection: siteLogoConnection ?? undefined })
    await dropManagedLogoSchema()
    await postgres.schema.createTable('users', table => table.integer('id').primary())
    await postgres.schema.createTable('durableJobs', table => {
      table.uuid('id').primary()
      table.string('type', 128).notNullable()
      table.integer('version').unsigned().notNullable().defaultTo(1)
      table.text('payload').notNullable()
      table.string('state', 16).notNullable().defaultTo('pending')
      table.integer('attempts').unsigned().notNullable().defaultTo(0)
      table.integer('maxAttempts').unsigned().notNullable().defaultTo(5)
      table.dateTime('nextRunAt').notNullable()
      table.string('leaseOwner', 128).nullable()
      table.uuid('leaseToken').nullable()
      table.dateTime('leaseExpiresAt').nullable()
      table.text('lastError').nullable()
      table.string('deduplicationKey', 255).nullable().unique('durable_jobs_deduplication_unique')
      table.dateTime('createdAt').notNullable()
      table.dateTime('updatedAt').notNullable()
      table.dateTime('completedAt').nullable()
    })
  })

  afterEach(async () => {
    if (!postgres) return
    await dropManagedLogoSchema()
    await postgres.destroy()
  })

  it('rolls back every new authority table when schema creation fails', async () => {
    await postgres.schema.createTable('siteLogoRevisions', table => table.uuid('id').primary())

    await expect(Promise.resolve(createSiteLogoAuthority(postgres))).rejects.toThrow()

    expect(await postgres.schema.hasTable('siteLogoObjects')).toBe(false)
    expect(await postgres.schema.hasTable('siteLogoState')).toBe(false)
    expect(await postgres.schema.hasTable('siteLogoRevisions')).toBe(true)
  })

  it('keeps a fresh migration-13 site-logo authority unchanged when cleanup runs with null singleton pointers', async () => {
    await createSiteLogoAuthority(postgres)

    const stateBefore = await postgres('siteLogoState').orderBy('id')
    const revisionsBefore = await postgres('siteLogoRevisions').orderBy('id')
    const objectsBefore = await postgres('siteLogoObjects').orderBy(['kind', 'sha256'])
    const now = new Date('2026-09-08T00:00:00.000Z')
    const cleanupJob: DurableJob = {
      id: '00000000-0000-4000-8000-000000000013',
      type: 'cleanup-site-logo',
      version: 1,
      payload: {},
      state: 'running',
      attempts: 1,
      maxAttempts: 1,
      nextRunAt: now,
      leaseOwner: 'migration-preflight-test',
      leaseToken: 'migration-preflight-test',
      leaseExpiresAt: new Date('2026-09-08T00:01:00.000Z'),
      lastError: null,
      deduplicationKey: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    }

    expect(stateBefore).toEqual([
      expect.objectContaining({
        id: 1,
        generation: 0,
        desiredRevisionId: null,
        activeRevisionId: null
      })
    ])
    await expect(cleanupSiteLogoRevisions(cleanupJob, { knex: postgres, signal: new AbortController().signal })).resolves.toBeUndefined()
    expect(await postgres('siteLogoState').orderBy('id')).toEqual(stateBefore)
    expect(await postgres('siteLogoRevisions').orderBy('id')).toEqual(revisionsBefore)
    expect(await postgres('siteLogoObjects').orderBy(['kind', 'sha256'])).toEqual(objectsBefore)
  })

  it('allows nullable pre-ready metadata and atomically requires one validated ready bundle', async () => {
    await createSiteLogoAuthority(postgres)

    const sourceBytes = Buffer.from('source-image')
    const logoBytes = Buffer.from('normalized-logo')
    const particleBytes = Buffer.alloc(68, 1)
    const staticBytes = Buffer.from('static-effect')
    const sourceHash = digest(sourceBytes)
    const logoHash = digest(logoBytes)
    const particleHash = digest(particleBytes)
    const staticHash = digest(staticBytes)
    const now = new Date('2026-09-04T00:00:00.000Z')
    const revisionId = '00000000-0000-4000-8000-000000000001'

    await postgres('siteLogoObjects').insert({
      kind: 'source',
      sha256: sourceHash,
      bytes: sourceBytes,
      byteLength: sourceBytes.byteLength,
      contentType: 'image/png',
      createdAt: now
    })
    await postgres('siteLogoRevisions').insert({
      id: revisionId,
      sourceKind: 'source',
      sourceHash,
      pipelineVersion: 1,
      status: 'pending',
      retrySequence: 0,
      createdAt: now,
      updatedAt: now
    })

    expect(
      await postgres('siteLogoRevisions')
        .where({ id: revisionId })
        .first(
          'status',
          'logoPngHash',
          'particleV1Hash',
          'effectStaticPngHash',
          'normalizedWidth',
          'normalizedHeight',
          'particleCount',
          'medianStroke',
          'auraColor'
        )
    ).toEqual({
      status: 'pending',
      logoPngHash: null,
      particleV1Hash: null,
      effectStaticPngHash: null,
      normalizedWidth: null,
      normalizedHeight: null,
      particleCount: null,
      medianStroke: null,
      auraColor: null
    })

    await expect(
      Promise.resolve(
        postgres('siteLogoRevisions').where({ id: revisionId }).update({
          status: 'ready',
          startedAt: now,
          completedAt: now
        })
      )
    ).rejects.toMatchObject({ code: '23514' })

    await postgres('siteLogoObjects').insert([
      {
        kind: 'logo-png',
        sha256: logoHash,
        bytes: logoBytes,
        byteLength: logoBytes.byteLength,
        contentType: 'image/png',
        createdAt: now
      },
      {
        kind: 'particle-v1',
        sha256: particleHash,
        bytes: particleBytes,
        byteLength: particleBytes.byteLength,
        contentType: 'application/octet-stream',
        createdAt: now
      },
      {
        kind: 'effect-static-png',
        sha256: staticHash,
        bytes: staticBytes,
        byteLength: staticBytes.byteLength,
        contentType: 'image/png',
        createdAt: now
      }
    ])

    const outputReferences = {
      logoPngKind: 'logo-png',
      logoPngHash: logoHash,
      particleV1Kind: 'particle-v1',
      particleV1Hash: particleHash,
      effectStaticPngKind: 'effect-static-png',
      effectStaticPngHash: staticHash
    }
    await expect(
      Promise.resolve(
        postgres('siteLogoRevisions')
          .where({ id: revisionId })
          .update({
            status: 'ready',
            ...outputReferences,
            startedAt: now,
            completedAt: now
          })
      )
    ).rejects.toMatchObject({ code: '23514' })

    const readyBundle = {
      status: 'ready',
      ...outputReferences,
      normalizedWidth: 640,
      normalizedHeight: 320,
      particleCount: 1,
      medianStroke: 4,
      startedAt: now,
      completedAt: now
    }

    await expect(
      Promise.resolve(
        postgres('siteLogoRevisions')
          .where({ id: revisionId })
          .update({ ...readyBundle, logoPngHash: particleHash })
      )
    ).rejects.toMatchObject({ code: '23503' })

    await expect(
      Promise.resolve(
        postgres('siteLogoRevisions')
          .where({ id: revisionId })
          .update({ ...readyBundle, auraColor: '#12ABCD' })
      )
    ).rejects.toMatchObject({ code: '23514' })

    await expect(
      Promise.resolve(
        postgres.transaction(async transaction => {
          await transaction('siteLogoRevisions').where({ id: revisionId }).update(readyBundle)
          throw new Error('abort publication')
        })
      )
    ).rejects.toThrow('abort publication')

    expect(await postgres('siteLogoRevisions').where({ id: revisionId }).first('status', 'logoPngHash', 'normalizedWidth')).toEqual({
      status: 'pending',
      logoPngHash: null,
      normalizedWidth: null
    })

    await postgres.transaction(async transaction => {
      await transaction('siteLogoRevisions').where({ id: revisionId }).update(readyBundle)
      await transaction('siteLogoState').where({ id: 1 }).update({ activeRevisionId: revisionId, updatedAt: now })
    })

    expect(
      await postgres('siteLogoRevisions')
        .innerJoin('siteLogoState', 'siteLogoState.activeRevisionId', 'siteLogoRevisions.id')
        .where('siteLogoState.id', 1)
        .first(
          'siteLogoRevisions.status',
          'siteLogoRevisions.logoPngHash',
          'siteLogoRevisions.particleV1Hash',
          'siteLogoRevisions.effectStaticPngHash',
          'siteLogoRevisions.normalizedWidth',
          'siteLogoRevisions.normalizedHeight',
          'siteLogoRevisions.particleCount',
          'siteLogoRevisions.medianStroke'
        )
    ).toEqual({
      status: 'ready',
      logoPngHash: logoHash,
      particleV1Hash: particleHash,
      effectStaticPngHash: staticHash,
      normalizedWidth: 640,
      normalizedHeight: 320,
      particleCount: 1,
      medianStroke: 4
    })
  })
  it('backfills one v6 successor, cancels legacy work, and preserves the active v5 bundle', async () => {
    await createSiteLogoAuthority(postgres)

    const now = new Date('2026-09-10T00:00:00.000Z')
    const sourceBytes = Buffer.from('legacy-source')
    const logoBytes = Buffer.from('legacy-logo')
    const particleBytes = Buffer.alloc(68, 1)
    const staticBytes = Buffer.from('legacy-static')
    const sourceHash = digest(sourceBytes)
    const logoHash = digest(logoBytes)
    const particleHash = digest(particleBytes)
    const staticHash = digest(staticBytes)
    const activeRevisionId = '00000000-0000-4000-8000-000000000021'
    const desiredRevisionId = '00000000-0000-4000-8000-000000000022'
    const legacyJobId = '00000000-0000-4000-8000-000000000023'

    await postgres('siteLogoObjects').insert([
      { kind: 'source', sha256: sourceHash, bytes: sourceBytes, byteLength: sourceBytes.byteLength, contentType: 'image/png', createdAt: now },
      { kind: 'logo-png', sha256: logoHash, bytes: logoBytes, byteLength: logoBytes.byteLength, contentType: 'image/png', createdAt: now },
      {
        kind: 'particle-v1',
        sha256: particleHash,
        bytes: particleBytes,
        byteLength: particleBytes.byteLength,
        contentType: 'application/octet-stream',
        createdAt: now
      },
      {
        kind: 'effect-static-png',
        sha256: staticHash,
        bytes: staticBytes,
        byteLength: staticBytes.byteLength,
        contentType: 'image/png',
        createdAt: now
      }
    ])
    await postgres('siteLogoRevisions').insert([
      {
        id: activeRevisionId,
        sourceKind: 'source',
        sourceHash,
        pipelineVersion: 5,
        status: 'ready',
        retrySequence: 0,
        logoPngKind: 'logo-png',
        logoPngHash: logoHash,
        particleV1Kind: 'particle-v1',
        particleV1Hash: particleHash,
        effectStaticPngKind: 'effect-static-png',
        effectStaticPngHash: staticHash,
        normalizedWidth: 640,
        normalizedHeight: 320,
        particleCount: 1,
        medianStroke: 4,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        completedAt: now
      },
      {
        id: desiredRevisionId,
        sourceKind: 'source',
        sourceHash,
        pipelineVersion: 5,
        status: 'pending',
        jobId: legacyJobId,
        retrySequence: 0,
        createdAt: now,
        updatedAt: now
      }
    ])
    await postgres('durableJobs').insert({
      id: legacyJobId,
      type: 'process-site-logo',
      version: 3,
      payload: JSON.stringify({ revisionId: desiredRevisionId, retrySequence: 0 }),
      state: 'pending',
      attempts: 0,
      maxAttempts: 5,
      nextRunAt: now,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      deduplicationKey: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null
    })
    await postgres('siteLogoState').where({ id: 1 }).update({ desiredRevisionId, activeRevisionId, updatedAt: now })

    await upgradeSiteLogoRenditions(postgres)

    const state = await postgres('siteLogoState').where({ id: 1 }).first()
    expect(state?.activeRevisionId).toBe(activeRevisionId)
    expect(state?.desiredRevisionId).not.toBe(desiredRevisionId)
    expect(await postgres('siteLogoObjects').where({ kind: 'logo-png', sha256: logoHash }).first('bytes')).toEqual({ bytes: logoBytes })
    expect(await postgres('siteLogoRevisions').where({ id: activeRevisionId }).first('status', 'pipelineVersion', 'logoPngHash')).toEqual({
      status: 'ready',
      pipelineVersion: 5,
      logoPngHash: logoHash
    })
    expect(await postgres('siteLogoRevisions').where({ id: desiredRevisionId }).first('status', 'errorCode', 'retiredAt')).toEqual(
      expect.objectContaining({ status: 'failed', errorCode: 'PROCESSING_FAILED', retiredAt: expect.anything() })
    )
    expect(await postgres('durableJobs').where({ id: legacyJobId }).first('state', 'version')).toEqual({ state: 'cancelled', version: 3 })

    const successors = await postgres('siteLogoRevisions').where({ pipelineVersion: 6 })
    expect(successors).toHaveLength(1)
    expect(successors[0]).toEqual(
      expect.objectContaining({
        sourceHash,
        pipelineVersion: 6,
        status: 'pending',
        retrySequence: 0
      })
    )
    const successorJob = await postgres('durableJobs').where({ id: successors[0]?.jobId }).first('version', 'type', 'state')
    expect(successorJob).toEqual({ version: 4, type: 'process-site-logo', state: 'pending' })
  })

  it('fences stale v5 writers after migration commit while preserving reads and allowing v6 activation', async () => {
    await createSiteLogoAuthority(postgres)

    const now = new Date('2026-09-12T00:00:00.000Z')
    const sourceBytes = Buffer.from('rolling-deployment-source')
    const logoBytes = Buffer.from('rolling-deployment-logo')
    const particleBytes = Buffer.alloc(68, 3)
    const staticBytes = Buffer.from('rolling-deployment-static')
    const sourceHash = digest(sourceBytes)
    const logoHash = digest(logoBytes)
    const particleHash = digest(particleBytes)
    const staticHash = digest(staticBytes)
    const historicalActiveId = '00000000-0000-4000-8000-000000000041'
    const staleRevisionId = '00000000-0000-4000-8000-000000000042'
    const staleInsertId = '00000000-0000-4000-8000-000000000043'

    await postgres('siteLogoObjects').insert([
      { kind: 'source', sha256: sourceHash, bytes: sourceBytes, byteLength: sourceBytes.byteLength, contentType: 'image/png', createdAt: now },
      { kind: 'logo-png', sha256: logoHash, bytes: logoBytes, byteLength: logoBytes.byteLength, contentType: 'image/png', createdAt: now },
      {
        kind: 'particle-v1',
        sha256: particleHash,
        bytes: particleBytes,
        byteLength: particleBytes.byteLength,
        contentType: 'application/octet-stream',
        createdAt: now
      },
      {
        kind: 'effect-static-png',
        sha256: staticHash,
        bytes: staticBytes,
        byteLength: staticBytes.byteLength,
        contentType: 'image/png',
        createdAt: now
      }
    ])
    await postgres('siteLogoRevisions').insert([
      {
        id: historicalActiveId,
        sourceKind: 'source',
        sourceHash,
        pipelineVersion: 5,
        status: 'ready',
        retrySequence: 0,
        logoPngKind: 'logo-png',
        logoPngHash: logoHash,
        particleV1Kind: 'particle-v1',
        particleV1Hash: particleHash,
        effectStaticPngKind: 'effect-static-png',
        effectStaticPngHash: staticHash,
        normalizedWidth: 640,
        normalizedHeight: 320,
        particleCount: 1,
        medianStroke: 4,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        completedAt: now
      },
      {
        id: staleRevisionId,
        sourceKind: 'source',
        sourceHash,
        pipelineVersion: 5,
        status: 'pending',
        retrySequence: 0,
        createdAt: now,
        updatedAt: now
      }
    ])
    await postgres('siteLogoState').where({ id: 1 }).update({
      desiredRevisionId: staleRevisionId,
      activeRevisionId: historicalActiveId,
      updatedAt: now
    })

    await upgradeSiteLogoRenditions(postgres)

    const migratedState = await postgres('siteLogoState').where({ id: 1 }).first()
    const successorId = migratedState?.desiredRevisionId
    expect(successorId).toEqual(expect.any(String))
    if (typeof successorId !== 'string') throw new Error('migration did not create a v6 successor')
    expect(migratedState?.activeRevisionId).toBe(historicalActiveId)
    expect(await postgres('siteLogoRevisions').where({ id: historicalActiveId }).first('pipelineVersion', 'status', 'logoPngHash')).toEqual({
      pipelineVersion: 5,
      status: 'ready',
      logoPngHash: logoHash
    })
    expect(await postgres('siteLogoRevisions').where({ id: staleRevisionId }).first('pipelineVersion', 'status', 'errorCode')).toEqual({
      pipelineVersion: 5,
      status: 'failed',
      errorCode: 'PROCESSING_FAILED'
    })

    const stateBeforeStaleActions = await postgres('siteLogoState').where({ id: 1 }).first()
    const staleRevisionBeforeReadyAttempt = await postgres('siteLogoRevisions').where({ id: staleRevisionId }).first()

    await expect(
      postgres.transaction(async transaction => {
        await transaction('siteLogoRevisions').insert({
          id: staleInsertId,
          sourceKind: 'source',
          sourceHash,
          pipelineVersion: 5,
          status: 'pending',
          retrySequence: 0,
          createdAt: now,
          updatedAt: now
        })
      })
    ).rejects.toThrow()
    expect(await postgres('siteLogoRevisions').where({ id: staleInsertId }).first()).toBeUndefined()
    expect(await postgres('siteLogoState').where({ id: 1 }).first()).toEqual(stateBeforeStaleActions)

    await expect(
      postgres.transaction(async transaction => {
        await transaction('siteLogoRevisions').where({ id: staleRevisionId }).update({
          status: 'ready',
          logoPngKind: 'logo-png',
          logoPngHash: logoHash,
          particleV1Kind: 'particle-v1',
          particleV1Hash: particleHash,
          effectStaticPngKind: 'effect-static-png',
          effectStaticPngHash: staticHash,
          normalizedWidth: 640,
          normalizedHeight: 320,
          particleCount: 1,
          medianStroke: 4,
          errorCode: null,
          startedAt: now,
          completedAt: now
        })
      })
    ).rejects.toThrow()
    expect(await postgres('siteLogoRevisions').where({ id: staleRevisionId }).first()).toEqual(staleRevisionBeforeReadyAttempt)
    expect(await postgres('siteLogoState').where({ id: 1 }).first()).toEqual(stateBeforeStaleActions)

    await expect(
      postgres.transaction(async transaction => {
        await transaction('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: staleRevisionId, updatedAt: now })
      })
    ).rejects.toThrow()
    expect(await postgres('siteLogoState').where({ id: 1 }).first()).toEqual(stateBeforeStaleActions)

    await expect(
      postgres.transaction(async transaction => {
        await transaction('siteLogoState').where({ id: 1 }).update({ activeRevisionId: staleRevisionId, updatedAt: now })
      })
    ).rejects.toThrow()
    expect(await postgres('siteLogoState').where({ id: 1 }).first()).toEqual(stateBeforeStaleActions)

    expect(
      await postgres('siteLogoRevisions')
        .innerJoin('siteLogoState', 'siteLogoState.activeRevisionId', 'siteLogoRevisions.id')
        .where('siteLogoState.id', 1)
        .first('siteLogoRevisions.pipelineVersion', 'siteLogoRevisions.status', 'siteLogoRevisions.logoPngHash')
    ).toEqual({
      pipelineVersion: 5,
      status: 'ready',
      logoPngHash: logoHash
    })

    const iconBytes = Buffer.from('rolling-deployment-icon')
    const icoBytes = Buffer.from('rolling-deployment-ico')
    const iconHash = digest(iconBytes)
    const icoHash = digest(icoBytes)
    await postgres('siteLogoObjects').insert([
      { kind: 'icon-png', sha256: iconHash, bytes: iconBytes, byteLength: iconBytes.byteLength, contentType: 'image/png', createdAt: now },
      { kind: 'favicon-ico', sha256: icoHash, bytes: icoBytes, byteLength: icoBytes.byteLength, contentType: 'image/x-icon', createdAt: now }
    ])

    await postgres.transaction(async transaction => {
      await transaction('siteLogoRevisions').where({ id: successorId }).update({
        status: 'ready',
        logoPngKind: 'logo-png',
        logoPngHash: logoHash,
        iconPngKind: 'icon-png',
        favicon16Hash: iconHash,
        favicon32Hash: iconHash,
        tile150Hash: iconHash,
        apple180Hash: iconHash,
        app192Hash: iconHash,
        app512Hash: iconHash,
        maskable512Hash: iconHash,
        faviconIcoKind: 'favicon-ico',
        faviconIcoHash: icoHash,
        errorCode: null,
        enhancementErrorCode: 'UNSUITABLE_LOGO',
        startedAt: now,
        completedAt: now
      })
      await transaction('siteLogoState').where({ id: 1 }).update({ activeRevisionId: successorId, updatedAt: now })
    })

    expect(await postgres('siteLogoState').where({ id: 1 }).first('desiredRevisionId', 'activeRevisionId')).toEqual({
      desiredRevisionId: successorId,
      activeRevisionId: successorId
    })
    expect(await postgres('siteLogoRevisions').where({ id: successorId }).first('pipelineVersion', 'status')).toEqual({
      pipelineVersion: 6,
      status: 'ready'
    })
  })

  it('accepts complete v6 ordinary-only and effect bundles while rejecting half bundles', async () => {
    await createSiteLogoAuthority(postgres)
    await upgradeSiteLogoRenditions(postgres)

    const now = new Date('2026-09-11T00:00:00.000Z')
    const sourceBytes = Buffer.from('v6-source')
    const logoBytes = Buffer.from('v6-logo')
    const iconBytes = Buffer.from('v6-icon')
    const icoBytes = Buffer.from('v6-ico')
    const particleBytes = Buffer.alloc(68, 2)
    const staticBytes = Buffer.from('v6-static')
    const sourceHash = digest(sourceBytes)
    const logoHash = digest(logoBytes)
    const iconHash = digest(iconBytes)
    const icoHash = digest(icoBytes)
    const particleHash = digest(particleBytes)
    const staticHash = digest(staticBytes)
    await postgres('siteLogoObjects').insert([
      { kind: 'source', sha256: sourceHash, bytes: sourceBytes, byteLength: sourceBytes.byteLength, contentType: 'image/png', createdAt: now },
      { kind: 'logo-png', sha256: logoHash, bytes: logoBytes, byteLength: logoBytes.byteLength, contentType: 'image/png', createdAt: now },
      { kind: 'icon-png', sha256: iconHash, bytes: iconBytes, byteLength: iconBytes.byteLength, contentType: 'image/png', createdAt: now },
      { kind: 'favicon-ico', sha256: icoHash, bytes: icoBytes, byteLength: icoBytes.byteLength, contentType: 'image/x-icon', createdAt: now },
      {
        kind: 'particle-v1',
        sha256: particleHash,
        bytes: particleBytes,
        byteLength: particleBytes.byteLength,
        contentType: 'application/octet-stream',
        createdAt: now
      },
      {
        kind: 'effect-static-png',
        sha256: staticHash,
        bytes: staticBytes,
        byteLength: staticBytes.byteLength,
        contentType: 'image/png',
        createdAt: now
      }
    ])

    const iconReferences = {
      iconPngKind: 'icon-png',
      favicon16Hash: iconHash,
      favicon32Hash: iconHash,
      tile150Hash: iconHash,
      apple180Hash: iconHash,
      app192Hash: iconHash,
      app512Hash: iconHash,
      maskable512Hash: iconHash,
      faviconIcoKind: 'favicon-ico',
      faviconIcoHash: icoHash
    }
    const ordinaryId = '00000000-0000-4000-8000-000000000031'
    const effectId = '00000000-0000-4000-8000-000000000032'
    const ordinary = {
      id: ordinaryId,
      sourceKind: 'source',
      sourceHash,
      pipelineVersion: 6,
      status: 'ready',
      retrySequence: 0,
      logoPngKind: 'logo-png',
      logoPngHash: logoHash,
      ...iconReferences,
      enhancementErrorCode: 'UNSUITABLE_LOGO',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now
    }
    await postgres('siteLogoRevisions').insert(ordinary)
    await expect(Promise.resolve(postgres('siteLogoRevisions').where({ id: ordinaryId }).update({ favicon32Hash: null }))).rejects.toMatchObject({
      code: '23514'
    })

    await postgres('siteLogoRevisions').insert({
      id: effectId,
      sourceKind: 'source',
      sourceHash,
      pipelineVersion: 6,
      status: 'ready',
      retrySequence: 0,
      logoPngKind: 'logo-png',
      logoPngHash: logoHash,
      ...iconReferences,
      particleV1Kind: 'particle-v1',
      particleV1Hash: particleHash,
      effectStaticPngKind: 'effect-static-png',
      effectStaticPngHash: staticHash,
      normalizedWidth: 640,
      normalizedHeight: 320,
      particleCount: 1,
      medianStroke: 4,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now
    })
    await expect(Promise.resolve(postgres('siteLogoRevisions').where({ id: effectId }).update({ effectStaticPngHash: null }))).rejects.toMatchObject({
      code: '23514'
    })
  })
})
