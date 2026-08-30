import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type AssetModel from '../../models/assets.ts'
import type assetOperations from '../../operations/assets.ts'

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
let db: Knex
let tempRoot: string
let Asset: typeof AssetModel
let removeAsset: typeof assetOperations.remove
let storageEvent = vi.fn()

const upload = async (source: string, contents: string, options: { skipStorage?: boolean } = {}): Promise<void> => {
  await writeFile(source, contents)
  await Asset.upload({
    originalname: 'logo.txt',
    assetPath: 'logo.txt',
    mimetype: 'text/plain',
    size: Buffer.byteLength(contents),
    folderId: null,
    path: source,
    mode: 'import',
    user: { id: 7, name: 'Test User', email: 'test@example.com' },
    skipStorage: options.skipStorage
  })
}

describe('asset aggregate persistence', () => {
  beforeEach(async () => {
    vi.resetModules()
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wiki-assets-'))
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    await db.raw('PRAGMA foreign_keys = ON')
    await db.schema.createTable('assets', table => {
      table.increments('id').primary()
      table.string('filename').notNullable()
      table.string('hash').notNullable().unique()
      table.string('ext').notNullable()
      table.string('kind').notNullable()
      table.string('mime').notNullable()
      table.integer('fileSize').notNullable()
      table.json('metadata').nullable()
      table.integer('authorId').notNullable()
      table.integer('folderId').nullable()
      table.string('createdAt').notNullable()
      table.string('updatedAt').notNullable()
    })
    await db.schema.createTable('assetData', table => {
      table.integer('id').primary().references('id').inTable('assets').onDelete('CASCADE')
      table.binary('data').notNullable()
    })

    storageEvent = vi.fn().mockResolvedValue(undefined)
    const models: Record<string, unknown> = {
      knex: db,
      assetFolders: { getHierarchy: vi.fn().mockResolvedValue([]) },
      storage: { assetEvent: storageEvent, getLocalLocations: vi.fn().mockResolvedValue([]) }
    }
    wikiGlobal.WIKI = {
      ROOTPATH: tempRoot,
      config: { dataPath: 'data', uploads: { scanSVG: false, forceDownload: false } },
      logger: { warn: vi.fn(), error: vi.fn() },
      scheduler: { registerJob: vi.fn() },
      auth: { checkAccess: vi.fn().mockReturnValue(true) },
      Error: {
        AssetInvalid: class extends Error {},
        AssetDeleteForbidden: class extends Error {}
      },
      models
    }
    Asset = (await vi.importFresh('../../models/assets.ts', import.meta.url)).default
    Asset.knex(db)
    models.assets = Asset
    removeAsset = (await vi.importFresh('../../operations/assets.ts', import.meta.url)).default.remove
  })

  afterEach(async () => {
    await db.destroy()
    await rm(tempRoot, { force: true, recursive: true })
    if (originalWiki === undefined) delete wikiGlobal.WIKI
    else wikiGlobal.WIKI = originalWiki
  })

  it('upserts concurrent uploads to one metadata row and one blob', async () => {
    await Promise.all([
      upload(path.join(tempRoot, 'first-upload'), 'first', { skipStorage: true }),
      upload(path.join(tempRoot, 'second-upload'), 'second', { skipStorage: true })
    ])

    const assets = await db('assets')
    const blobs = await db('assetData')
    expect(assets).toHaveLength(1)
    expect(blobs).toHaveLength(1)
    expect(blobs[0].id).toBe(assets[0].id)
    expect(['first', 'second']).toContain(Buffer.from(blobs[0].data).toString())
  })

  it('rejects a blob failure without publishing metadata or cache state', async () => {
    await db.raw("CREATE TRIGGER reject_asset_blob BEFORE INSERT ON assetData BEGIN SELECT RAISE(FAIL, 'blob failure'); END")

    await expect(upload(path.join(tempRoot, 'failed-upload'), 'broken')).rejects.toThrow('blob failure')

    expect(await db('assets')).toEqual([])
    expect(await db('assetData')).toEqual([])
    const hash = createHash('sha1').update('logo.txt').digest('hex')
    await expect(access(path.join(tempRoot, 'data', 'cache', `${hash}.dat`))).rejects.toThrow()
    expect(storageEvent).not.toHaveBeenCalled()
  })

  it('deletes metadata and its cascading blob before publishing cache and storage effects', async () => {
    await upload(path.join(tempRoot, 'delete-upload'), 'delete me', { skipStorage: true })
    const asset = (await db('assets').first()) as { id: number; hash: string }
    storageEvent.mockImplementation(async () => {
      expect(await db('assets')).toEqual([])
      expect(await db('assetData')).toEqual([])
    })

    await removeAsset({ requester: { id: 7, name: 'Test User', email: 'test@example.com' }, id: asset.id })

    expect(await db('assets')).toEqual([])
    expect(await db('assetData')).toEqual([])
    await expect(access(path.join(tempRoot, 'data', 'cache', `${asset.hash}.dat`))).rejects.toThrow()
    expect(storageEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'deleted' }))
  })
})
