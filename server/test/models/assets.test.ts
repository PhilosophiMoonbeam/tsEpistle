import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import type AssetModel from '../../models/assets.ts'
import type * as AssetBranding from '../../helpers/asset-branding.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addLeaseToken } from '../../db/migrations/2.5.158.ts'

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
let db: Knex
let tempRoot: string
let Asset: typeof AssetModel
let removeAsset: typeof assetOperations.remove
let branding: typeof AssetBranding
let localLookup = vi.fn()

interface AssetResponse {
  req: { method: string; headers: Record<string, string> }
  headersSent: boolean
  statusCode: number
  body?: unknown
  headers: Record<string, string>
  status: (statusCode: number) => AssetResponse
  set: (name: string, value: string) => AssetResponse
  type: (value: string) => AssetResponse
  sendStatus: (statusCode: number) => AssetResponse
  send: (body: unknown) => AssetResponse
  end: (body?: unknown) => AssetResponse
}

const responseForAsset = (method = 'GET', range?: string): AssetResponse => {
  const response = {} as AssetResponse
  response.req = { method, headers: range === undefined ? {} : { range } }
  response.headersSent = false
  response.statusCode = 200
  response.headers = {}
  response.status = vi.fn((statusCode: number) => {
    response.statusCode = statusCode
    return response
  })
  response.set = vi.fn((name: string, value: string) => {
    response.headers[name] = value
    return response
  })
  response.type = vi.fn((value: string) => {
    response.headers['Content-Type'] = value
    return response
  })
  response.sendStatus = vi.fn((statusCode: number) => {
    response.statusCode = statusCode
    response.headersSent = true
    return response
  })
  response.send = vi.fn((body: unknown) => {
    response.body = body
    response.headersSent = true
    return response
  })
  response.end = vi.fn((body?: unknown) => {
    response.body = body
    response.headersSent = true
    return response
  })
  return response
}

const insertAsset = async (assetPath: string, data: Buffer, overrides: Record<string, unknown> = {}): Promise<{ id: number; hash: string }> => {
  const hash = createHash('sha1').update(assetPath).digest('hex')
  await db('assets').insert({
    filename: path.posix.basename(assetPath),
    hash,
    ext: path.posix.extname(assetPath),
    kind: 'binary',
    mime: 'application/octet-stream',
    fileSize: data.byteLength,
    metadata: JSON.stringify({}),
    authorId: 7,
    folderId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides
  })
  const row = await db('assets').where({ hash }).first()
  if (!row || !Number.isSafeInteger(row.id)) throw new Error('Asset fixture was not persisted')
  await db('assetData').insert({ id: row.id, data })
  return { id: row.id, hash }
}

const asResponse = (response: AssetResponse): Response => response as unknown as Response

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
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.string('path').notNullable()
      table.string('localeCode').notNullable()
      table.string('contentType').notNullable()
      table.string('visibility').notNullable()
    })

    await createDurableJobs(db)
    await addLeaseToken(db)
    await db.schema.createTable('storage', table => {
      table.string('key').primary()
      table.boolean('isEnabled').notNullable()
      table.string('mode').notNullable()
      table.string('syncInterval').notNullable()
      table.json('config').notNullable()
    })
    await db('storage').insert({ key: 'disk', isEnabled: true, mode: 'push', syncInterval: 'P0D', config: '{}' })
    localLookup = vi.fn().mockResolvedValue([])
    const models: Record<string, unknown> = {
      knex: db,
      assetFolders: { getHierarchy: vi.fn(async (folderId: number) => (folderId === 42 ? [{ slug: '.git' }] : [])) },
      storage: { getLocalLocations: localLookup }
    }
    wikiGlobal.WIKI = {
      ROOTPATH: tempRoot,
      config: { dataPath: 'data', lang: { code: 'en', namespacing: false }, uploads: { maxFileSize: 5 * 1024 * 1024, scanSVG: false, forceDownload: false } },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      scheduler: { registerJob: vi.fn() },
      auth: {
        checkAccess: vi.fn().mockReturnValue(true),
        checkPageAccess: vi.fn().mockReturnValue(true),
        loadPageRuleAuthority: vi.fn(async requester => ({
          requester,
          permissions: ['manage:system', 'manage:assets'],
          groups: [],
          tagAliases: {}
        }))
      },
      Error: {
        AssetInvalid: class extends Error {},
        AssetDeleteForbidden: class extends Error {}
      },
      models
    }
    Asset = (await vi.importFresh('../../models/assets.ts', import.meta.url)).default
    Asset.knex(db)
    models.assets = Asset
    branding = await import('../../helpers/asset-branding.ts')
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

  it('uploads safe and hostile SVGs through the real scheduler worker and serves only sanitized canonical bytes', async () => {
    const coreDirectory = path.join(tempRoot, 'server', 'core')
    await mkdir(coreDirectory, { recursive: true })
    await mkdir(path.join(tempRoot, 'server', 'app'), { recursive: true })
    await writeFile(path.join(tempRoot, 'config.yml'), '{}')
    await writeFile(path.join(tempRoot, 'server', 'app', 'data.yml'), JSON.stringify({
      defaults: { config: { db: { pass: '' }, flags: { ldapdebug: false, sqllog: false }, port: 8080 } }
    }))
    await writeFile(path.join(tempRoot, 'server', '.build-metadata.json'), JSON.stringify({
      revision: 'a'.repeat(40), date: '2026-10-23T00:00:00Z'
    }))
    // Only the entrypoint is local: parsing, dynamic dispatch and sanitization use production modules.
    // Defer importing the worker until its child-only configuration is installed.
    await writeFile(path.join(coreDirectory, 'worker.ts'), `
      process.env.CONFIG_FILE = ${JSON.stringify(path.join(tempRoot, 'config.yml'))}
      delete process.env.dockerdev
      delete process.env.DB_PASS_FILE
      await import(${JSON.stringify(new URL('../../core/worker.ts', import.meta.url).href)})
    `)
    const wiki = wikiGlobal.WIKI as { config: { uploads: { scanSVG: boolean } }; scheduler: unknown }
    wiki.config.uploads.scanSVG = true
    const scheduler = (await vi.importFresh('../../core/scheduler.ts', import.meta.url)).default
    wiki.scheduler = scheduler
    const safe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="currentColor" d="M1 1h20v20H1z"/></svg>'
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" onload="alert(1)"><script>alert(2)</script><foreignObject><iframe src="https://example.invalid/"/></foreignObject><a href="javascript:alert(3)"><path onclick="alert(4)" fill="currentColor" d="M1 1h20v20H1z"/></a></svg>'
    try {
      for (const [filename, contents] of [['safe.svg', safe], ['hostile.svg', hostile]] as const) {
        const source = path.join(tempRoot, filename)
        await writeFile(source, contents)
        await Asset.upload({
          originalname: filename,
          assetPath: filename,
          mimetype: 'image/svg+xml',
          size: Buffer.byteLength(contents),
          folderId: null,
          path: source,
          mode: 'import',
          user: { id: 7, name: 'Test User', email: 'test@example.com' },
          skipStorage: true
        })
        await rm(path.join(tempRoot, 'data', 'cache', `${createHash('sha1').update(filename).digest('hex')}.dat`))
        const response = responseForAsset()
        await Asset.getAsset(filename, asResponse(response))
        expect(response.statusCode).toBe(200)
        const served = Buffer.from(response.body as Uint8Array).toString()
        const dom = new JSDOM(served, { contentType: 'image/svg+xml' })
        try {
          expect(dom.window.document.documentElement.localName).toBe('svg')
          if (filename === 'safe.svg') {
            const shape = dom.window.document.querySelector('path')
            expect(shape?.getAttribute('fill')).toBe('currentColor')
            expect(shape?.getAttribute('d')).toBe('M1 1h20v20H1z')
          }
          expect(dom.window.document.querySelector('script, foreignObject, iframe, [onload], [onclick]')).toBeNull()
          expect(served).not.toContain('javascript:')
        } finally {
          dom.window.close()
        }
        const row = await db('assets').where({ filename }).first('id', 'hash', 'fileSize')
        expect(Buffer.from((await db('assetData').where({ id: row.id }).first('data')).data).toString()).toBe(served)
        expect(row.fileSize).toBe(Buffer.byteLength(served))
        expect(await readFile(source, 'utf8')).toBe(contents)
      }
      expect(wiki.config.uploads.scanSVG).toBe(true)
    } finally {
      await scheduler.stop()
    }
  }, 20_000)

  it('preserves branded asset bytes and metadata when replacement analysis is busy', async () => {
    await upload(path.join(tempRoot, 'initial-upload'), 'old bytes', { skipStorage: true })
    const asset = (await db('assets').first()) as { id: number; hash: string }
    const previousBranding = {
      version: 2,
      sourceSha256: 'a'.repeat(64),
      state: 'ready',
      width: 1,
      height: 1,
      accent: '#112233'
    }
    const previousMetadata = { branding: previousBranding, revision: 4 }
    const reservations = Array.from({ length: 8 }, (_, index) => branding.reserveAssetBrandingAnalysis(asset.id + index + 1))
    try {
      await upload(path.join(tempRoot, 'first-queued-upload'), 'new bytes')
      await db('assets')
        .where({ id: asset.id })
        .update({ metadata: JSON.stringify(previousMetadata) })
      const secondUpload = upload(path.join(tempRoot, 'second-queued-upload'), 'newer bytes', { skipStorage: true })
      await expect(secondUpload).rejects.toMatchObject({
        status: 503,
        name: 'BRANDING_BUSY'
      })
      const currentAsset = await db('assets').where({ id: asset.id }).first()
      const currentMetadata = typeof currentAsset.metadata === 'string' ? JSON.parse(currentAsset.metadata) : currentAsset.metadata
      expect(currentMetadata).toEqual(previousMetadata)
      expect(Buffer.from((await db('assetData').where({ id: asset.id }).first()).data).toString()).toBe('new bytes')
      expect(await readFile(path.join(tempRoot, 'data', 'cache', `${asset.hash}.dat`), 'utf8')).toBe('new bytes')
    } finally {
      reservations.forEach(branding.releaseAssetBrandingAnalysis)
    }
  })

  it('does not let a stale branding merge overwrite a newer asset source', async () => {
    await upload(path.join(tempRoot, 'race-seed'), 'seed', { skipStorage: true })
    const asset = (await db('assets').first()) as { id: number }
    const sourceA = Buffer.from('source A')
    const sourceB = Buffer.from('source B')
    await db('assetData').where({ id: asset.id }).update({ data: sourceA })
    await db('assets')
      .where({ id: asset.id })
      .update({ metadata: JSON.stringify({ revision: 7 }) })

    let replaced = false
    const originalKnex = db
    const racedKnex = Object.assign(
      (table: string) => {
        const query = originalKnex(table)
        if (table === 'assetData' && !replaced) {
          const first = query.first.bind(query)
          Object.assign(query, {
            first: async () => {
              const row = await first()
              if (!replaced) {
                replaced = true
                await originalKnex('assetData').where({ id: asset.id }).update({ data: sourceB })
              }
              return row
            }
          })
        }
        return query
      },
      { transaction: originalKnex.transaction.bind(originalKnex) }
    )
    const wiki = wikiGlobal.WIKI as { models: { knex: unknown } }
    const previousKnex = wiki.models.knex
    wiki.models.knex = racedKnex
    try {
      const result = await branding.refreshAssetBranding(asset.id)
      expect(result).toMatchObject({ sourceSha256: branding.sourceSha256(sourceB), state: 'unavailable' })
      const currentAsset = await db('assets').where({ id: asset.id }).first()
      const currentMetadata = typeof currentAsset.metadata === 'string' ? JSON.parse(currentAsset.metadata) : currentAsset.metadata
      expect(currentMetadata).toMatchObject({ revision: 7, branding: { sourceSha256: branding.sourceSha256(sourceB) } })
      expect(Buffer.from((await db('assetData').where({ id: asset.id }).first()).data)).toEqual(sourceB)
    } finally {
      wiki.models.knex = previousKnex
    }
  })

  it('rejects a blob failure without publishing metadata or cache state', async () => {
    await db.raw("CREATE TRIGGER reject_asset_blob BEFORE INSERT ON assetData BEGIN SELECT RAISE(FAIL, 'blob failure'); END")

    await expect(upload(path.join(tempRoot, 'failed-upload'), 'broken')).rejects.toThrow('blob failure')

    expect(await db('assets')).toEqual([])
    expect(await db('assetData')).toEqual([])
    const hash = createHash('sha1').update('logo.txt').digest('hex')
    await expect(access(path.join(tempRoot, 'data', 'cache', `${hash}.dat`))).rejects.toThrow()
    expect(await db('durableJobs')).toHaveLength(0)
  })

  it('atomically admits deletion while removing metadata and its cascading blob', async () => {
    await upload(path.join(tempRoot, 'delete-upload'), 'delete me', { skipStorage: true })
    const asset = (await db('assets').first()) as { id: number; hash: string }

    await removeAsset({ requester: { id: 7, name: 'Test User', email: 'test@example.com' }, id: asset.id })

    expect(await db('assets')).toEqual([])
    expect(await db('assetData')).toEqual([])
    await expect(access(path.join(tempRoot, 'data', 'cache', `${asset.hash}.dat`))).rejects.toThrow()
    const jobs = await db('durableJobs')
    expect(jobs).toHaveLength(1)
    expect(JSON.parse(jobs[0].payload)).toMatchObject({ entityType: 'asset', entityId: asset.id, paths: ['logo.txt'] })
  })

  it('rolls back a delete and preserves its cache when durable admission fails', async () => {
    await upload(path.join(tempRoot, 'delete-rollback'), 'retained source', { skipStorage: true })
    const asset = await db('assets').first()
    await db.raw("CREATE TRIGGER reject_storage_admission BEFORE INSERT ON durableJobs BEGIN SELECT RAISE(FAIL, 'storage admission failed'); END")
    await expect(removeAsset({ requester: { id: 7, name: 'Test User', email: 'test@example.com' }, id: asset.id })).rejects.toThrow('storage admission failed')
    expect(await db('assets').where({ id: asset.id }).first()).toMatchObject({ hash: asset.hash })
    expect(Buffer.from((await db('assetData').where({ id: asset.id }).first()).data).toString()).toBe('retained source')
    expect(await readFile(path.join(tempRoot, 'data', 'cache', `${asset.hash}.dat`), 'utf8')).toBe('retained source')
    expect(await db('durableJobs')).toHaveLength(0)
  })

  it('requires a persisted identity before consulting stale cache or local storage', async () => {
    const orphanPath = 'orphan.bin'
    const staleCachePath = path.join(tempRoot, 'data', 'cache', `${createHash('sha1').update(orphanPath).digest('hex')}.dat`)
    await mkdir(path.dirname(staleCachePath), { recursive: true })
    await writeFile(staleCachePath, 'stale bytes')

    const orphanResponse = responseForAsset()
    await Asset.getAsset(orphanPath, asResponse(orphanResponse))
    expect(orphanResponse.statusCode).toBe(404)
    expect(localLookup).not.toHaveBeenCalled()
    expect(await readFile(staleCachePath, 'utf8')).toBe('stale bytes')

    const internalResponse = responseForAsset()
    await Asset.getAsset('.git/config', asResponse(internalResponse))
    expect(internalResponse.statusCode).toBe(404)
    expect(localLookup).not.toHaveBeenCalled()
  })

  it('rejects persisted internal paths and canonical path mismatches before local delivery', async () => {
    await insertAsset('.git/config', Buffer.from('private'), { filename: 'config', folderId: 42 })
    const internalResponse = responseForAsset()
    await Asset.getAsset('.git/config', asResponse(internalResponse))
    expect(internalResponse.statusCode).toBe(404)
    expect(localLookup).not.toHaveBeenCalled()

    await insertAsset('registered.txt', Buffer.from('private'), { filename: 'renamed.txt' })
    const mismatchResponse = responseForAsset()
    await Asset.getAsset('registered.txt', asResponse(mismatchResponse))
    expect(mismatchResponse.statusCode).toBe(404)
    expect(localLookup).not.toHaveBeenCalled()
  })

  it('delivers only the registered asset data and preserves HEAD and range semantics', async () => {
    const data = Buffer.from('0123456789')
    const asset = await insertAsset('registered.txt', data)
    const cachePath = path.join(tempRoot, 'data', 'cache', `${asset.hash}.dat`)

    const getResponse = responseForAsset()
    await Asset.getAsset('registered.txt', asResponse(getResponse))
    expect(Buffer.from(getResponse.body as Uint8Array)).toEqual(data)
    expect(localLookup).toHaveBeenCalledWith({
      asset: {
        id: asset.id,
        hash: asset.hash,
        path: 'registered.txt',
        filename: 'registered.txt',
        folderId: null
      }
    })

    await rm(cachePath, { force: true })
    const headResponse = responseForAsset('HEAD')
    await Asset.getAsset('registered.txt', asResponse(headResponse))
    expect(headResponse.statusCode).toBe(200)
    expect(headResponse.end).toHaveBeenCalled()
    expect(headResponse.body).toBeUndefined()

    await rm(cachePath, { force: true })
    const rangeResponse = responseForAsset('GET', 'bytes=2-5')
    await Asset.getAsset('registered.txt', asResponse(rangeResponse))
    expect(rangeResponse.statusCode).toBe(206)
    expect(rangeResponse.headers['Content-Range']).toBe('bytes 2-5/10')
    expect(Buffer.from(rangeResponse.body as Uint8Array)).toEqual(Buffer.from('2345'))

    await rm(cachePath, { force: true })
    const invalidRangeResponse = responseForAsset('GET', 'bytes=50-60')
    await Asset.getAsset('registered.txt', asResponse(invalidRangeResponse))
    expect(invalidRangeResponse.statusCode).toBe(416)
    expect(invalidRangeResponse.end).toHaveBeenCalled()
  })

  it('opens a registered local location with the persisted identity', async () => {
    const asset = await insertAsset('local.txt', Buffer.from('local bytes'))
    await db('assetData').where({ id: asset.id }).del()
    const source = {
      stats: { size: 10 },
      handle: { createReadStream: vi.fn() },
      close: vi.fn().mockResolvedValue(undefined)
    }
    const open = vi.fn().mockResolvedValue(source)
    localLookup.mockResolvedValue([{ key: 'disk', location: { open } }])

    const response = responseForAsset('HEAD')
    await Asset.getAsset('local.txt', asResponse(response))
    expect(open).toHaveBeenCalledOnce()
    expect(response.statusCode).toBe(200)
    expect(response.end).toHaveBeenCalled()
    expect(localLookup).toHaveBeenCalledWith({
      asset: {
        id: asset.id,
        hash: asset.hash,
        path: 'local.txt',
        filename: 'local.txt',
        folderId: null
      }
    })
  })
})
