import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

import { down as downSearchability, up as upSearchability } from '../../db/migrations/tsepistle-000035-page-search-inclusion.ts'
import { down as downAssetRelocation, up as upAssetRelocation } from '../../db/migrations/tsepistle-000037-asset-relocation.ts'
import { down as downAvatarOrigin, up as upAvatarOrigin } from '../../db/migrations/tsepistle-000038-user-avatar-origin.ts'

const assetHash = (assetPath: string): string => createHash('sha1').update(assetPath).digest('hex')

const relocationOperation = {
  id: '00000000-0000-4000-8000-000000000001',
  assetId: 1,
  actorId: null,
  sourcePath: 'source.txt',
  destinationPath: 'destination.txt',
  sourceHash: assetHash('source.txt'),
  destinationHash: assetHash('destination.txt'),
  contentSha256: 'a'.repeat(64),
  status: 'succeeded',
  lastError: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:00.000Z'
}

const createSearchabilityFixture = async (db: Knex): Promise<void> => {
  await db.schema.createTable('pages', table => table.integer('id').primary())
  await db.schema.createTable('pageHistory', table => table.integer('id').primary())
  await upSearchability(db)
}

const createAssetRelocationFixture = async (db: Knex): Promise<void> => {
  await db.schema.createTable('assets', table => {
    table.integer('id').primary()
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
  await db('assets').insert({ id: 1, filename: 'asset.txt', hash: assetHash('asset.txt'), folderId: null })
  await db('pageProtectedAssets').insert({ pageId: 1, assetPath: 'asset.txt' })
  await upAssetRelocation(db)
}

describe('page search inclusion rollback guard', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createSearchabilityFixture(db)
  })

  afterEach(async () => db.destroy())

  it('refuses a live-page opt-out without changing either searchability column', async () => {
    await db('pages').insert({ id: 1, isSearchable: false })

    await expect(Promise.resolve(downSearchability(db))).rejects.toThrow('Cannot roll down page search inclusion migration')

    expect(await db.schema.hasColumn('pages', 'isSearchable')).toBe(true)
    expect(await db.schema.hasColumn('pageHistory', 'isSearchable')).toBe(true)
    expect(Boolean((await db('pages').where({ id: 1 }).first('isSearchable'))?.isSearchable)).toBe(false)
  })

  it('refuses a historical opt-out without changing the historical preference', async () => {
    await db('pageHistory').insert({ id: 1, isSearchable: false })

    await expect(Promise.resolve(downSearchability(db))).rejects.toThrow('Cannot roll down page search inclusion migration')

    expect(await db.schema.hasColumn('pageHistory', 'isSearchable')).toBe(true)
    expect(Boolean((await db('pageHistory').where({ id: 1 }).first('isSearchable'))?.isSearchable)).toBe(false)
  })

  it('rolls down a fixture containing only lossless default preferences', async () => {
    await db('pages').insert({ id: 1, isSearchable: true })
    await db('pageHistory').insert({ id: 1, isSearchable: true })

    await downSearchability(db)

    expect(await db.schema.hasColumn('pages', 'isSearchable')).toBe(false)
    expect(await db.schema.hasColumn('pageHistory', 'isSearchable')).toBe(false)
  })
})

describe('asset relocation rollback guard', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createAssetRelocationFixture(db)
  })

  afterEach(async () => db.destroy())

  it('refuses retained relocation operations, including completed receipts', async () => {
    await db('assetRelocationOperations').insert(relocationOperation)

    await expect(Promise.resolve(downAssetRelocation(db))).rejects.toThrow('Cannot roll down asset relocation migration')

    expect(await db.schema.hasTable('assetRelocationOperations')).toBe(true)
    expect(await db.schema.hasColumn('pageProtectedAssets', 'assetId')).toBe(true)
  })

  it('refuses retained asset-relocation durable jobs', async () => {
    await db('durableJobs').insert({ id: '00000000-0000-4000-8000-000000000002', type: 'asset-relocation' })

    await expect(Promise.resolve(downAssetRelocation(db))).rejects.toThrow('Cannot roll down asset relocation migration')

    expect(await db.schema.hasTable('assetRelocationEffects')).toBe(true)
    expect(await db.schema.hasTable('assetRelocationOperations')).toBe(true)
  })

  it('refuses a protected asset identity whose retained path no longer resolves to the bound asset', async () => {
    await db('pageProtectedAssets').update({ assetPath: 'missing.txt' })

    await expect(Promise.resolve(downAssetRelocation(db))).rejects.toThrow('Cannot roll down asset relocation migration')

    expect(await db.schema.hasColumn('pageProtectedAssets', 'assetId')).toBe(true)
    expect((await db('pageProtectedAssets').first())?.assetId).toBe(1)
  })

  it('rolls down when ledgers are empty and every protected identity is lossless', async () => {
    expect((await db('pageProtectedAssets').first())?.assetId).toBe(1)

    await downAssetRelocation(db)

    expect(await db.schema.hasTable('assetRelocationEffects')).toBe(false)
    expect(await db.schema.hasTable('assetRelocationOperations')).toBe(false)
    expect(await db.schema.hasColumn('pageProtectedAssets', 'assetId')).toBe(false)
    const indexes = (await db.raw('PRAGMA index_list("assets")')) as Array<{ name: string }>
    expect(indexes.some(index => index.name === 'assets_folder_filename_unique')).toBe(false)
  })
})

const createAvatarOriginFixture = async (db: Knex): Promise<void> => {
  await db.schema.createTable('userAvatars', table => {
    table.integer('id').primary()
    table.binary('data').notNullable()
  })
  await db('userAvatars').insert({ id: 1, data: Buffer.from('provider-avatar') })
  await upAvatarOrigin(db)
  await db('userAvatars').update({ origin: 'provider' })
}

describe('user avatar origin rollback guard', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
    await createAvatarOriginFixture(db)
  })

  afterEach(async () => db.destroy())

  it('refuses self-service provenance without changing the origin column or avatar data', async () => {
    await db('userAvatars').where({ id: 1 }).update({ origin: 'self-service', data: Buffer.from('self-service-avatar') })

    await expect(Promise.resolve(downAvatarOrigin(db))).rejects.toThrow('Cannot roll down user avatar origin')

    const avatar = await db('userAvatars').where({ id: 1 }).first()
    expect(await db.schema.hasColumn('userAvatars', 'origin')).toBe(true)
    expect(avatar?.origin).toBe('self-service')
    expect(Buffer.from(avatar?.data ?? '')).toEqual(Buffer.from('self-service-avatar'))
  })

  it('rolls down provider-only provenance while preserving avatar data', async () => {
    await downAvatarOrigin(db)

    const avatar = await db('userAvatars').where({ id: 1 }).first()
    expect(await db.schema.hasColumn('userAvatars', 'origin')).toBe(false)
    expect(Buffer.from(avatar?.data ?? '')).toEqual(Buffer.from('provider-avatar'))
  })
})
