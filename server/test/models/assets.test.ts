import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import createKnex, { type Knex } from 'knex'
import express, { type Response } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openStorageRoot } from '../../modules/storage/local-filesystem.ts'
import { PdfFixtureDocument } from '../agents/pdf-fixture.ts'
import sharp from 'sharp'
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
let assetHierarchy = vi.fn(async (folderId: number): Promise<Array<{ slug: string }>> => (folderId === 42 ? [{ slug: '.git' }] : []))
let assetServer: Server | undefined

interface AssetResponse {
  req: { method: string; headers: Record<string, string> }
  headersSent: boolean
  statusCode: number
  body?: unknown
  headers: Record<string, string>
  status: (statusCode: number) => AssetResponse
  set: (name: string, value: string | string[]) => AssetResponse
  getHeader: (name: string) => string | undefined
  removeHeader: (name: string) => void
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
  response.set = vi.fn((name: string, value: string | string[]) => {
    response.headers[name] = Array.isArray(value) ? value.join(', ') : value
    return response
  })
  response.getHeader = vi.fn((name: string) => response.headers[name])
  response.removeHeader = vi.fn((name: string) => { delete response.headers[name] })
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

const startAssetHttp = async (sitePolicy?: string, reportOnly = false): Promise<string> => {
  const app = express()
  app.use((req, res) => {
    if (sitePolicy) res.set(reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy', sitePolicy)
    void Asset.getAsset(decodeURIComponent(req.path.slice(1)), res)
  })
  assetServer = app.listen(0, '127.0.0.1')
  const listening = Promise.withResolvers<void>()
  assetServer.once('listening', listening.resolve)
  assetServer.once('error', listening.reject)
  await listening.promise
  return `http://127.0.0.1:${(assetServer.address() as AddressInfo).port}`
}

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
    assetHierarchy = vi.fn(async (folderId: number): Promise<Array<{ slug: string }>> => (folderId === 42 ? [{ slug: '.git' }] : []))
    const models: Record<string, unknown> = {
      knex: db,
      assetFolders: { getHierarchy: assetHierarchy },
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
    if (assetServer) {
      const server = assetServer
      assetServer = undefined
      server.closeAllConnections()
      const closed = Promise.withResolvers<void>()
      server.close(error => error ? closed.reject(error) : closed.resolve())
      await closed.promise
    }
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

  it.each([
    ['.git/config', 'upload'],
    ['media/.GiT/config', 'import'],
    ['_manual/probe.txt', 'upload'],
    ['_daily/probe.txt', 'import'],
    ['media/.asset.42.12345678-1234-4234-8234-123456789abc.tmp', 'import']
  ])('rejects internal upload destination %s without changing existing canonical data or storage', async (assetPath, mode) => {
    const slugs = assetPath.split('/').slice(0, -1)
    const folderId = slugs.length > 0 ? 42 : null
    assetHierarchy.mockImplementation(async () => slugs.map(slug => ({ slug })))
    const previousBytes = Buffer.from('retained bytes')
    const existing = await insertAsset(assetPath, previousBytes, { folderId })
    const before = await db('assets').first()
    const cachePath = path.join(tempRoot, 'data', 'cache', `${existing.hash}.dat`)
    await mkdir(path.dirname(cachePath), { recursive: true })
    await writeFile(cachePath, previousBytes)
    const source = mode === 'upload' ? path.join(tempRoot, 'data', 'uploads', 'rejected-source') : path.join(tempRoot, 'rejected-source')
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, 'replacement')

    await expect(Asset.upload({
      originalname: path.posix.basename(assetPath),
      assetPath,
      mimetype: 'text/plain',
      size: 11,
      folderId,
      path: source,
      mode,
      user: { id: 7, name: 'Test User', email: 'test@example.com' }
    })).rejects.toMatchObject({ status: 400, name: 'ASSET_PATH_INVALID' })

    expect(await db('assets')).toEqual([before])
    expect(Buffer.from((await db('assetData').first()).data)).toEqual(previousBytes)
    expect(await readFile(cachePath)).toEqual(previousBytes)
    expect(await readFile(source, 'utf8')).toBe('replacement')
    expect(await db('durableJobs')).toEqual([])
    expect(localLookup).not.toHaveBeenCalled()
  })

  it.each([
    { originalname: 'safe.txt', folderId: 42 },
    { originalname: '.git', folderId: null },
    { originalname: 'different.txt', folderId: null }
  ])('rejects a disguised canonical upload destination before opening the source: %j', async ({ originalname, folderId }) => {
    await expect(Asset.upload({
      originalname,
      assetPath: 'safe.txt',
      mimetype: 'text/plain',
      size: 1,
      folderId,
      path: path.join(tempRoot, 'does-not-exist'),
      mode: 'import',
      user: { id: 7, name: 'Test User', email: 'test@example.com' }
    })).rejects.toMatchObject({ status: 400, name: 'ASSET_PATH_INVALID' })

    expect(await db('assets')).toEqual([])
    expect(await db('assetData')).toEqual([])
    expect(await db('durableJobs')).toEqual([])
    await expect(access(path.join(tempRoot, 'data', 'cache'))).rejects.toThrow()
  })

  it('rechecks the canonical folder destination inside the upload transaction before persistence', async () => {
    assetHierarchy
      .mockResolvedValueOnce([{ slug: 'media' }])
      .mockResolvedValueOnce([{ slug: '.GiT' }])
    const source = path.join(tempRoot, 'changed-folder-source')
    await writeFile(source, 'valid asset')

    await expect(Asset.upload({
      originalname: 'file.txt',
      assetPath: 'media/file.txt',
      mimetype: 'text/plain',
      size: 11,
      folderId: 7,
      path: source,
      mode: 'import',
      user: { id: 7, name: 'Test User', email: 'test@example.com' }
    })).rejects.toMatchObject({ status: 400, name: 'ASSET_PATH_INVALID' })

    expect(await db('assets')).toEqual([])
    expect(await db('assetData')).toEqual([])
    expect(await db('durableJobs')).toEqual([])
    expect(await readFile(source, 'utf8')).toBe('valid asset')
    await expect(access(path.join(tempRoot, 'data', 'cache'))).rejects.toThrow()
  })

  it.each([
    '.gitignore',
    'media/.git-backup/config',
    'media/_manual/probe.txt',
    'media/_daily/probe.txt',
    '_MANUAL/probe.txt',
    'media/.asset.42.not-a-uuid.tmp'
  ])('preserves supported asset destination %s', async assetPath => {
    const parts = assetPath.split('/')
    const filename = parts.pop()
    if (!filename) throw new Error('Missing fixture filename')
    assetHierarchy.mockImplementation(async () => parts.map(slug => ({ slug })))
    const source = path.join(tempRoot, 'valid-source')
    await writeFile(source, 'valid asset')

    await Asset.upload({
      originalname: filename,
      assetPath,
      mimetype: 'text/plain',
      size: 11,
      folderId: parts.length > 0 ? 7 : null,
      path: source,
      mode: 'import',
      user: { id: 7, name: 'Test User', email: 'test@example.com' }
    })

    const asset = await db('assets').first()
    expect(asset).toMatchObject({ filename, hash: createHash('sha1').update(assetPath).digest('hex') })
    expect(Buffer.from((await db('assetData').first()).data).toString()).toBe('valid asset')
    expect(await readFile(path.join(tempRoot, 'data', 'cache', `${asset.hash}.dat`), 'utf8')).toBe('valid asset')
    const jobs = await db('durableJobs')
    expect(jobs).toHaveLength(1)
    expect(JSON.parse(jobs[0].payload)).toMatchObject({ entityType: 'asset', entityId: asset.id, paths: [assetPath] })
  })

  it('scans imports without changing originals and contains configured storage copies that differ from canonical bytes', async () => {
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
      const origin = await startAssetHttp()
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
        const root = await openStorageRoot(tempRoot)
        try {
          localLookup.mockResolvedValue([{ key: 'disk', location: { open: () => root.openFile(filename) } }])
          await rm(path.join(tempRoot, 'data', 'cache', `${row.hash}.dat`))
          const originalResponse = await fetch(`${origin}/${filename}`)
          expect(originalResponse.status).toBe(200)
          expect(originalResponse.headers.get('Content-Type')).toContain('image/svg+xml')
          expect(originalResponse.headers.get('Content-Security-Policy')).toContain('sandbox')
          expect(originalResponse.headers.get('X-Content-Type-Options')).toBe('nosniff')
          expect(await originalResponse.text()).toBe(contents)
          expect(await readFile(source, 'utf8')).toBe(contents)
          expect(Buffer.from((await db('assetData').where({ id: row.id }).first('data')).data).toString()).toBe(served)
        } finally {
          localLookup.mockResolvedValue([])
          await root.close()
        }
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

  it.each([
    '.git/config',
    '_manual/probe.txt',
    '.asset.42.12345678-1234-4234-8234-123456789abc.tmp'
  ])('admits removal of legacy internal asset %s and retains its durable cleanup mutation', async assetPath => {
    const parts = assetPath.split('/')
    parts.pop()
    assetHierarchy.mockImplementation(async () => parts.map(slug => ({ slug })))
    const asset = await insertAsset(assetPath, Buffer.from('legacy data'), { folderId: parts.length > 0 ? 42 : null })
    const cachePath = path.join(tempRoot, 'data', 'cache', `${asset.hash}.dat`)
    await mkdir(path.dirname(cachePath), { recursive: true })
    await writeFile(cachePath, 'legacy cache')

    await removeAsset({ requester: { id: 7, name: 'Test User', email: 'test@example.com' }, id: asset.id })

    expect(await db('assets')).toEqual([])
    expect(await db('assetData')).toEqual([])
    await expect(access(cachePath)).rejects.toThrow()
    const jobs = await db('durableJobs')
    expect(jobs).toHaveLength(1)
    expect(JSON.parse(jobs[0].payload)).toMatchObject({ entityType: 'asset', entityId: asset.id, paths: [assetPath] })
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

  it.each(['cache', 'local', 'db'].flatMap(source => ['drawing.svg', 'document.html'].map(filename => ({ source, filename }))))('contains actual active-document responses from %j even when storage differs from canonical bytes', async ({ source, filename }) => {
    const svg = filename.endsWith('.svg')
    const scanned = Buffer.from(svg ? '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>' : '<p>Canonical document</p>')
    const original = Buffer.from(svg ? '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>' : '<!doctype html><script>alert(document.cookie)</script>')
    const asset = await insertAsset(filename, scanned)
    const cachePath = path.join(tempRoot, 'data', 'cache', `${asset.hash}.dat`)
    const root = await openStorageRoot(tempRoot)
    try {
      if (source === 'cache') {
        await mkdir(path.dirname(cachePath), { recursive: true })
        await writeFile(cachePath, original)
      } else if (source === 'local') {
        await writeFile(path.join(tempRoot, filename), original)
        localLookup.mockResolvedValue([{ key: 'disk', location: { open: () => root.openFile(filename) } }])
      }
      const selected = source === 'db' ? scanned : original
      const origin = await startAssetHttp("script-src 'unsafe-inline'", true)
      for (const [method, range, status] of [
        ['GET', undefined, 200], ['HEAD', undefined, 200],
        ['GET', 'bytes=1-7', 206], ['HEAD', 'bytes=1-7', 206],
        ['GET', 'bytes=9999-', 416], ['HEAD', 'bytes=9999-', 416]
      ] as const) {
        if (source === 'db') await rm(cachePath, { force: true })
        const response = await fetch(`${origin}/${filename}`, { method, headers: range ? { Range: range } : {} })
        expect(response.status).toBe(status)
        expect(response.headers.get('Content-Type')).toContain(svg ? 'image/svg+xml' : 'text/html')
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
        expect(response.headers.get('Content-Security-Policy')).toContain("sandbox; default-src 'none'; script-src 'none'")
        expect(response.headers.get('Content-Security-Policy')).not.toContain('allow-same-origin')
        expect(response.headers.get('Content-Security-Policy-Report-Only')).toBe("script-src 'unsafe-inline'")
        expect(response.headers.get('Content-Disposition')).toBeNull()
        const body = Buffer.from(await response.arrayBuffer())
        expect(body).toEqual(method === 'HEAD' || status === 416 ? Buffer.alloc(0) : status === 206 ? selected.subarray(1, 8) : selected)
        if (status === 206) expect(response.headers.get('Content-Range')).toBe(`bytes 1-7/${selected.length}`)
        if (status === 416) expect(response.headers.get('Content-Range')).toBe(`bytes */${selected.length}`)
      }
      expect(Buffer.from((await db('assetData').where({ id: asset.id }).first()).data)).toEqual(scanned)
      if (source === 'local') expect(await readFile(path.join(tempRoot, filename))).toEqual(original)
    } finally {
      await root.close()
    }
  })

  it.each(['cache', 'local', 'db'])('admits a PDF exception only from verified bytes selected from %s', async source => {
    const document = new PdfFixtureDocument()
    const catalog = document.reserveObject()
    const pages = document.reserveObject()
    const page = document.reserveObject()
    const content = document.addStream('', Buffer.from('0 0 20 20 re S'))
    document.setObject(catalog, `<< /Type /Catalog /Pages ${pages} 0 R >>`)
    document.setObject(pages, `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`)
    document.setObject(page, `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 100 100] /Contents ${content} 0 R >>`)
    const pdf = document.toBuffer(catalog)
    const fake = Buffer.from('<!doctype html><script>alert(document.cookie)</script>')
    const valid = await insertAsset('valid.pdf', pdf, { mime: 'text/html' })
    const ambiguous = await insertAsset('legacy.pdf', pdf, { mime: 'application/pdf' })
    const root = await openStorageRoot(tempRoot)
    try {
      if (source === 'cache') {
        const cache = path.join(tempRoot, 'data', 'cache')
        await mkdir(cache, { recursive: true })
        await writeFile(path.join(cache, `${valid.hash}.dat`), pdf)
        await writeFile(path.join(cache, `${ambiguous.hash}.dat`), fake)
      } else if (source === 'local') {
        await writeFile(path.join(tempRoot, 'valid.pdf'), pdf)
        await writeFile(path.join(tempRoot, 'legacy.pdf'), fake)
        localLookup.mockImplementation(async ({ asset }) => [{ key: 'disk', location: { open: () => root.openFile(asset.filename) } }])
      } else {
        await db('assetData').where({ id: ambiguous.id }).update({ data: fake })
      }
      const persistedAssets = await db('assets').orderBy('id')
      const persistedData = await db('assetData').orderBy('id')
      const sitePolicy = "frame-ancestors 'none'; object-src 'none'"
      const origin = await startAssetHttp(sitePolicy)
      for (const [filename, bytes, verified] of [['valid.pdf', pdf, true], ['legacy.pdf', fake, false]] as const) {
        const cachePath = path.join(tempRoot, 'data', 'cache', `${filename === 'valid.pdf' ? valid.hash : ambiguous.hash}.dat`)
        for (const [method, range, status] of [
          ['GET', undefined, 200], ['HEAD', undefined, 200],
          ['GET', 'bytes=0-3', 206], ['HEAD', 'bytes=0-3', 206],
          ['GET', 'bytes=9999-', 416], ['HEAD', 'bytes=9999-', 416]
        ] as const) {
          if (source === 'db') await rm(cachePath, { force: true })
          // Exercise the DB-selected response and its repopulated cache, not just
          // an already cached copy that would hide a driver binary-type mismatch.
          for (let attempt = 0; attempt < (source === 'db' ? 2 : 1); attempt++) {
            const response = await fetch(`${origin}/${filename}`, { method, headers: range ? { Range: range } : {} })
            expect(response.status).toBe(status)
            expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
            expect(response.headers.get('Content-Security-Policy')).toContain(sitePolicy)
            expect(response.headers.get('Content-Type')).toContain(verified ? 'application/pdf' : 'application/octet-stream')
            expect(response.headers.get('X-Wiki-Asset-Type')).toBe(verified && status !== 416 ? 'pdf' : null)
            if (verified && status !== 416) expect(response.headers.get('Content-Security-Policy')).not.toContain('sandbox')
            else expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
            if (!verified) {
              expect(response.headers.get('Content-Disposition')).toBe('attachment; filename=legacy.pdf')
            }
            const body = Buffer.from(await response.arrayBuffer())
            expect(body).toEqual(method === 'HEAD' || status === 416 ? Buffer.alloc(0) : status === 206 ? bytes.subarray(0, 4) : bytes)
            if (status === 206) expect(response.headers.get('Content-Range')).toBe(`bytes 0-3/${bytes.length}`)
            if (status === 416) expect(response.headers.get('Content-Range')).toBe(`bytes */${bytes.length}`)
            if (source === 'db') expect(await readFile(cachePath)).toEqual(bytes)
          }
        }
      }
      expect(await db('assets').orderBy('id')).toEqual(persistedAssets)
      expect(await db('assetData').orderBy('id')).toEqual(persistedData)
      if (source === 'cache') {
        expect(await readFile(path.join(tempRoot, 'data', 'cache', `${valid.hash}.dat`))).toEqual(pdf)
        expect(await readFile(path.join(tempRoot, 'data', 'cache', `${ambiguous.hash}.dat`))).toEqual(fake)
      }
      if (source === 'local') {
        expect(await readFile(path.join(tempRoot, 'valid.pdf'))).toEqual(pdf)
        expect(await readFile(path.join(tempRoot, 'legacy.pdf'))).toEqual(fake)
      }
    } finally {
      await root.close()
    }
  })

  it('retains containment for empty bodies, missing data and storage errors with general CSP absent', async () => {
    await insertAsset('empty.html', Buffer.alloc(0))
    const missing = await insertAsset('missing.html', Buffer.from('removed'))
    await db('assetData').where({ id: missing.id }).del()
    const origin = await startAssetHttp()
    for (const [filename, range, status] of [['empty.html', undefined, 200], ['empty.html', 'bytes=0-', 416], ['missing.html', undefined, 404], ['unknown.html', undefined, 404]] as const) {
      const response = await fetch(`${origin}/${filename}`, { headers: range ? { Range: range } : {} })
      expect(response.status).toBe(status)
      expect(response.headers.get('Content-Security-Policy')).toContain('sandbox')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(response.headers.get('X-Wiki-Asset-Type')).toBeNull()
      await response.arrayBuffer()
    }
    await insertAsset('broken.pdf', Buffer.from('%PDF-1.7\n%%EOF\n'))
    localLookup.mockRejectedValueOnce(new Error('configured storage unavailable'))
    const failed = await fetch(`${origin}/broken.pdf`)
    expect(failed.status).toBe(500)
    expect(failed.headers.get('Content-Security-Policy')).toContain('sandbox')
    expect(failed.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(failed.headers.get('X-Wiki-Asset-Type')).toBeNull()
    expect(failed.headers.get('Content-Type')).toContain('text/plain')
    await failed.arrayBuffer()
  })

  it('preserves forced-download names and raster/SVG inline image use without relaxing an existing sandbox policy for PDFs', async () => {
    const wiki = wikiGlobal.WIKI as { config: { uploads: { forceDownload: boolean } } }
    wiki.config.uploads.forceDownload = true
    await insertAsset('download name.html', Buffer.from('<script>alert(1)</script>'))
    const raster = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer()
    await insertAsset('image.png', raster)
    await insertAsset('image.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    await insertAsset('read.pdf', Buffer.from('%PDF-1.7\n%%EOF\n'))
    const origin = await startAssetHttp("sandbox; default-src 'none'")
    for (const filename of ['download name.html', 'image.png', 'image.svg', 'read.pdf']) {
      const response = await fetch(`${origin}/${encodeURIComponent(filename)}`, { method: 'HEAD' })
      expect(response.status).toBe(200)
      expect(response.headers.get('Content-Security-Policy')).toContain("sandbox; default-src 'none'")
      expect(response.headers.get('Content-Disposition')).toBe(filename === 'read.pdf' ? 'attachment; filename=read.pdf' : filename === 'download name.html' ? 'attachment; filename=download%20name.html' : null)
    }
    const response = responseForAsset('HEAD')
    await Asset.getAsset('download name.html', asResponse(response))
    expect(response.headers['Content-disposition']).toBe('attachment; filename=download%20name.html')
    expect(response.headers['X-Content-Type-Options']).toBe('nosniff')
  })
})
