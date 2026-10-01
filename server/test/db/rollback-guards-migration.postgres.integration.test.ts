import { createHash } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import { afterAll, afterEach, beforeAll, describe, expect, it } from '../bun-test.mts'
import { getPostgresTestConnection } from '../postgres-test-connection.mts'

import { down as downSearchability, up as upSearchability } from '../../db/migrations/tsepistle-000035-page-search-inclusion.ts'
import { down as downAssetRelocation, up as upAssetRelocation } from '../../db/migrations/tsepistle-000037-asset-relocation.ts'
import { down as downAvatarOrigin, up as upAvatarOrigin } from '../../db/migrations/tsepistle-000038-user-avatar-origin.ts'

const connection = getPostgresTestConnection('_rollback_guards_test', import.meta.path)

const suite = connection ? describe : describe.skip
const assetHash = (assetPath: string): string => createHash('sha1').update(assetPath).digest('hex')

const expectWriterBlockedRollback = async (
  tableName: string,
  write: (transaction: Knex.Transaction) => PromiseLike<unknown>,
  migrateDown: (database: Knex) => Promise<void>,
  refusal: string
): Promise<void> => {
  const writer = knexModule({ client: 'pg', connection, pool: { min: 0, max: 1 } })
  const rollbackDatabase = knexModule({ client: 'pg', connection, pool: { min: 0, max: 1 } })
  const observer = knexModule({ client: 'pg', connection, pool: { min: 0, max: 1 } })
  let blocker: Knex.Transaction | undefined
  let rollbackSettled: Promise<void> | undefined
  try {
    blocker = await writer.transaction()
    await write(blocker)
    const writerPid = (await blocker.raw<{ rows: Array<{ pid: number }> }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    await rollbackDatabase.raw(`SET statement_timeout = '3s'`)
    await observer.raw(`SET statement_timeout = '1s'`)
    // A single-connection pool keeps the observed PID attached to the migration.
    const rollbackPid = (await rollbackDatabase.raw<{ rows: Array<{ pid: number }> }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
    let finished = false
    const rollback = migrateDown(rollbackDatabase)
    rollbackSettled = rollback.then(
      () => { finished = true },
      () => { finished = true }
    )
    const deadline = performance.now() + 2_000
    let waiting = false
    while (performance.now() < deadline && !finished) {
      const result = await observer.raw<{ rows: Array<{ waiting: boolean }> }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE pid = ?
            AND locktype = 'relation'
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND relation = ?::regclass
            AND NOT granted
            AND ? = ANY(pg_blocking_pids(pid))
        ) AS waiting
      `, [rollbackPid, `"${tableName}"`, writerPid])
      if (result.rows[0]?.waiting) {
        waiting = true
        break
      }
      // PostgreSQL lock state advances outside Bun's clock; poll the observed condition, not a guessed completion delay.
      await Bun.sleep(20)
    }
    expect(waiting).toBe(true)
    await blocker.commit()
    await expect(Promise.resolve(rollback)).rejects.toThrow(refusal)
  } finally {
    try {
      if (blocker && !blocker.isCompleted()) await blocker.rollback()
    } finally {
      try {
        await rollbackSettled
      } finally {
        await Promise.all([observer.destroy(), rollbackDatabase.destroy(), writer.destroy()])
      }
    }
  }
}

suite('PostgreSQL rollback guards', () => {
  let db: Knex

  beforeAll(() => {
    db = knexModule({ client: 'pg', connection, pool: { min: 0, max: 4 } })
  })

  afterEach(async () => {
    for (const tableName of [
      'assetRelocationEffects',
      'assetRelocationOperations',
      'pageProtectedAssets',
      'durableJobs',
      'assets',
      'pageHistory',
      'pages',
      'userAvatars'
    ]) {
      await db.schema.dropTableIfExists(tableName)
    }
  })

  afterAll(async () => {
    if (db) await db.destroy()
  })

  it('waits for a concurrent page writer and then refuses its lossy preference', async () => {
    await db.schema.createTable('pages', table => table.increments('id').primary())
    await db.schema.createTable('pageHistory', table => table.increments('id').primary())
    await upSearchability(db)
    await db('pages').insert({ isSearchable: true })

    await expectWriterBlockedRollback(
      'pages',
      transaction => transaction('pages').where({ id: 1 }).update({ isSearchable: false }),
      downSearchability,
      'Cannot roll down page search inclusion migration'
    )

    expect(await db.schema.hasColumn('pages', 'isSearchable')).toBe(true)
    expect(Boolean((await db('pages').first('isSearchable'))?.isSearchable)).toBe(false)
  })

  it('waits for a concurrent asset writer and then refuses the mismatched protection binding', async () => {
    await db.schema.createTable('assets', table => {
      table.increments('id').primary()
      table.string('filename').notNullable()
      table.string('hash').notNullable()
      table.integer('folderId').nullable()
    })
    await db.schema.createTable('durableJobs', table => {
      table.uuid('id').primary()
      table.string('type').notNullable()
    })
    await db.schema.createTable('pageProtectedAssets', table => {
      table.integer('pageId').notNullable()
      table.string('assetPath').notNullable()
    })
    await db('assets').insert({ filename: 'asset.txt', hash: assetHash('asset.txt'), folderId: null })
    await db('pageProtectedAssets').insert({ pageId: 1, assetPath: 'asset.txt' })
    await upAssetRelocation(db)

    await expectWriterBlockedRollback(
      'assets',
      transaction => transaction('assets').where({ id: 1 }).update({ filename: 'changed.txt', hash: assetHash('changed.txt') }),
      downAssetRelocation,
      'Cannot roll down asset relocation migration'
    )

    expect(await db.schema.hasColumn('pageProtectedAssets', 'assetId')).toBe(true)
    expect(await db.schema.hasTable('assetRelocationOperations')).toBe(true)
  })

  it('waits for a concurrent avatar writer and then refuses its unsafe provenance', async () => {
    await db.schema.createTable('userAvatars', table => {
      table.integer('id').primary()
      table.binary('data').notNullable()
    })
    await db('userAvatars').insert({ id: 1, data: Buffer.from('provider-avatar') })
    await upAvatarOrigin(db)
    await db('userAvatars').update({ origin: 'provider' })

    await expectWriterBlockedRollback(
      'userAvatars',
      transaction => transaction('userAvatars').where({ id: 1 }).update({ origin: 'self-service', data: Buffer.from('self-service-avatar') }),
      downAvatarOrigin,
      'Cannot roll down user avatar origin'
    )

    const avatar = await db('userAvatars').where({ id: 1 }).first()
    expect(await db.schema.hasColumn('userAvatars', 'origin')).toBe(true)
    expect(avatar?.origin).toBe('self-service')
    expect(Buffer.from(avatar?.data ?? '')).toEqual(Buffer.from('self-service-avatar'))
  })
})
