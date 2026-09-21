import fs from 'node:fs'
import { createHash } from 'node:crypto'
import knexModule, { type Knex } from 'knex'
import { afterAll, afterEach, beforeAll, describe, expect, it } from '../bun-test.mts'

import { down as downSearchability, up as upSearchability } from '../../db/migrations/tsepistle-000035-page-search-inclusion.ts'
import { down as downAssetRelocation, up as upAssetRelocation } from '../../db/migrations/tsepistle-000037-asset-relocation.ts'
import { down as downAvatarOrigin, up as upAvatarOrigin } from '../../db/migrations/tsepistle-000038-user-avatar-origin.ts'

const databaseName = process.env.WIKI_TEST_POSTGRES_DATABASE ?? ''
const passwordFile = process.env.WIKI_TEST_POSTGRES_PASSWORD_FILE
const password = passwordFile ? fs.readFileSync(passwordFile, 'utf8').trim() : process.env.WIKI_TEST_POSTGRES_PASSWORD
const connection =
  databaseName.endsWith('_rollback_guards_test') && password
    ? {
        host: process.env.WIKI_TEST_POSTGRES_HOST ?? 'wiki-postgres',
        port: Number(process.env.WIKI_TEST_POSTGRES_PORT ?? 5432),
        user: process.env.WIKI_TEST_POSTGRES_USER ?? 'wiki',
        password,
        database: databaseName
      }
    : undefined
const directlyInvoked =
  !String(process.env.npm_lifecycle_event ?? '').startsWith('test') &&
  process.argv.some(argument => argument.replaceAll('\\', '/').endsWith('rollback-guards-migration.postgres.integration.test.ts'))
const databaseContractRequired = directlyInvoked || process.env.WIKI_TEST_POSTGRES_REQUIRED === '1'

if (databaseContractRequired && !connection) {
  throw new Error(
    'Explicit rollback guard PostgreSQL execution requires WIKI_TEST_POSTGRES_DATABASE ending in _rollback_guards_test and a PostgreSQL password.'
  )
}

const suite = connection ? describe : describe.skip
const assetHash = (assetPath: string): string => createHash('sha1').update(assetPath).digest('hex')

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

    const writer = knexModule({ client: 'pg', connection, pool: { min: 0, max: 1 } })
    const blocker = await writer.transaction()
    await blocker('pages').where({ id: 1 }).update({ isSearchable: false })

    let resolveLock!: () => void
    const lockIssued = new Promise<void>(resolve => {
      resolveLock = resolve
    })
    const onQuery = ({ sql }: { sql?: string }) => {
      if (sql?.toLowerCase().includes('lock table "pages"')) resolveLock()
    }
    db.on('query', onQuery)
    const rollback = downSearchability(db)
    try {
      await lockIssued
      await blocker.commit()
      await expect(Promise.resolve(rollback)).rejects.toThrow('Cannot roll down page search inclusion migration')
    } finally {
      db.removeListener('query', onQuery)
      await writer.destroy()
    }

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

    const writer = knexModule({ client: 'pg', connection, pool: { min: 0, max: 1 } })
    const blocker = await writer.transaction()
    await blocker('assets')
      .where({ id: 1 })
      .update({ filename: 'changed.txt', hash: assetHash('changed.txt') })

    let resolveLock!: () => void
    const lockIssued = new Promise<void>(resolve => {
      resolveLock = resolve
    })
    const onQuery = ({ sql }: { sql?: string }) => {
      if (sql?.toLowerCase().includes('lock table "assets"')) resolveLock()
    }
    db.on('query', onQuery)
    const rollback = downAssetRelocation(db)
    try {
      await lockIssued
      await blocker.commit()
      await expect(Promise.resolve(rollback)).rejects.toThrow('Cannot roll down asset relocation migration')
    } finally {
      db.removeListener('query', onQuery)
      await writer.destroy()
    }

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

    const writer = knexModule({ client: 'pg', connection, pool: { min: 0, max: 1 } })
    const blocker = await writer.transaction()
    await blocker('userAvatars').where({ id: 1 }).update({ origin: 'self-service', data: Buffer.from('self-service-avatar') })

    let resolveLock!: () => void
    const lockIssued = new Promise<void>(resolve => {
      resolveLock = resolve
    })
    const onQuery = ({ sql }: { sql?: string }) => {
      if (sql?.toLowerCase().includes('lock table "useravatars"')) resolveLock()
    }
    db.on('query', onQuery)
    const rollback = downAvatarOrigin(db)
    try {
      await lockIssued
      await blocker.commit()
      await expect(Promise.resolve(rollback)).rejects.toThrow('Cannot roll down user avatar origin')
    } finally {
      db.removeListener('query', onQuery)
      await writer.destroy()
    }

    const avatar = await db('userAvatars').where({ id: 1 }).first()
    expect(await db.schema.hasColumn('userAvatars', 'origin')).toBe(true)
    expect(avatar?.origin).toBe('self-service')
    expect(Buffer.from(avatar?.data ?? '')).toEqual(Buffer.from('self-service-avatar'))
  })
})
