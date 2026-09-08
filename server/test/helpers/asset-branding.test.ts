import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type * as AssetBranding from '../../helpers/asset-branding.ts'

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
const requester = { id: 7, permissions: ['manage:system', 'read:assets'] }

let db: Knex
let branding: typeof AssetBranding
const assetDataReads = vi.fn()
const checkAccess = vi.fn()

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const encodeRgbaPng = async (width: number, height: number, data: Buffer): Promise<Buffer> =>
  await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer()

const insertAsset = async (input: { bytes?: Buffer; metadata: unknown; filename?: string }): Promise<number> => {
  const [assetId] = await db('assets').insert({
    filename: input.filename ?? 'branding.png',
    metadata: JSON.stringify(input.metadata)
  })
  if (input.bytes) await db('assetData').insert({ id: assetId, data: input.bytes })
  return Number(assetId)
}

const readBranding = async (assetId: number): Promise<Record<string, unknown>> => {
  const row = await db('assets').where({ id: assetId }).first()
  const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
  return metadata.branding as Record<string, unknown>
}

describe('asset branding analysis and cache cutover', () => {
  beforeEach(async () => {
    vi.resetModules()
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    await db.schema.createTable('assets', table => {
      table.increments('id').primary()
      table.string('filename').notNullable()
      table.json('metadata').nullable()
    })
    await db.schema.createTable('assetData', table => {
      table.integer('id').primary().references('id').inTable('assets').onDelete('CASCADE')
      table.binary('data').notNullable()
    })

    assetDataReads.mockReset()
    const trackedKnex = ((table: string) => {
      if (table === 'assetData') assetDataReads()
      return db(table)
    }) as unknown as Knex
    trackedKnex.transaction = db.transaction.bind(db)

    const assetsQuery = {
      findById: vi.fn(async (assetId: number) => {
        const asset = await db('assets').where({ id: assetId }).first()
        return asset
          ? {
              ...asset,
              getAssetPath: async () => String(asset.filename)
            }
          : undefined
      })
    }
    checkAccess.mockReset().mockReturnValue(true)
    wikiGlobal.WIKI = {
      auth: { checkAccess },
      models: {
        assets: { query: vi.fn().mockReturnValue(assetsQuery) },
        knex: trackedKnex
      }
    }
    branding = await vi.importFresh<typeof AssetBranding>('../../helpers/asset-branding.ts', import.meta.url)
  })

  afterEach(async () => {
    await db.destroy()
    if (originalWiki === undefined) delete wikiGlobal.WIKI
    else wikiGlobal.WIKI = originalWiki
  })

  it('preserves transparent PNG digest and dimensions while publishing only an accent', async () => {
    const width = 96
    const height = 48
    const data = Buffer.alloc(width * height * 4)
    for (let y = 4; y < 44; y += 1) {
      for (let x = 8; x < 88; x += 1) {
        const offset = (y * width + x) * 4
        data[offset] = 36
        data[offset + 1] = 100
        data[offset + 2] = 190
        data[offset + 3] = 255
      }
    }
    const source = await encodeRgbaPng(width, height, data)

    const result = await branding.analyzeAssetBranding(source)
    if (result.state !== 'ready') throw new Error('Expected ready branding metadata')
    const accent = result.accent

    expect(result).toMatchObject({
      version: 2,
      sourceSha256: digest(source),
      state: 'ready',
      width,
      height
    })
    expect(typeof accent).toBe('string')
    if (typeof accent !== 'string') throw new Error('Expected a visible blue accent')
    expect(accent).toMatch(/^#[0-9A-F]{6}$/u)
    const red = Number.parseInt(accent.slice(1, 3), 16)
    const green = Number.parseInt(accent.slice(3, 5), 16)
    const blue = Number.parseInt(accent.slice(5, 7), 16)
    expect(blue).toBeGreaterThan(green)
    expect(green).toBeGreaterThan(red)
    expect(blue - red).toBeGreaterThan(64)
    expect(result).not.toHaveProperty('matte')
  })

  it('does not let RGB values in transparent pixels dominate visible neutral content', async () => {
    const width = 64
    const height = 64
    const data = Buffer.alloc(width * height * 4)
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4
      data[offset] = 255
      data[offset + 1] = 0
      data[offset + 2] = 0
    }
    for (let y = 20; y < 44; y += 1) {
      for (let x = 20; x < 44; x += 1) {
        const offset = (y * width + x) * 4
        data[offset] = 128
        data[offset + 1] = 128
        data[offset + 2] = 128
        data[offset + 3] = 255
      }
    }
    const source = await encodeRgbaPng(width, height, data)

    const result = await branding.analyzeAssetBranding(source)

    expect(result).toMatchObject({ version: 2, sourceSha256: digest(source), state: 'ready', width, height, accent: null })
    expect(result).not.toHaveProperty('matte')
  })

  it('publishes ready null accents for neutral and fully transparent PNGs', async () => {
    const neutral = Buffer.alloc(40 * 24 * 4)
    for (let offset = 0; offset < neutral.length; offset += 4) {
      neutral[offset] = 128
      neutral[offset + 1] = 128
      neutral[offset + 2] = 128
      neutral[offset + 3] = 255
    }
    const transparent = Buffer.alloc(40 * 24 * 4)
    for (let offset = 0; offset < transparent.length; offset += 4) {
      transparent[offset] = 20
      transparent[offset + 1] = 220
      transparent[offset + 2] = 80
    }

    const [neutralSource, transparentSource] = await Promise.all([encodeRgbaPng(40, 24, neutral), encodeRgbaPng(40, 24, transparent)])
    const [neutralResult, transparentResult] = await Promise.all([
      branding.analyzeAssetBranding(neutralSource),
      branding.analyzeAssetBranding(transparentSource)
    ])

    expect(neutralResult).toMatchObject({ version: 2, sourceSha256: digest(neutralSource), state: 'ready', width: 40, height: 24, accent: null })
    expect(transparentResult).toMatchObject({ version: 2, sourceSha256: digest(transparentSource), state: 'ready', width: 40, height: 24, accent: null })
    expect(neutralResult).not.toHaveProperty('matte')
    expect(transparentResult).not.toHaveProperty('matte')
  })

  it('lazily rederives an authorized old-v1 cache into the v2 view', async () => {
    const width = 48
    const height = 32
    const data = Buffer.alloc(width * height * 4)
    for (let y = 8; y < 24; y += 1) {
      for (let x = 12; x < 36; x += 1) {
        const offset = (y * width + x) * 4
        data[offset] = 40
        data[offset + 1] = 120
        data[offset + 2] = 200
        data[offset + 3] = 255
      }
    }
    const source = await encodeRgbaPng(width, height, data)
    const sourceSha256 = digest(source)
    const assetId = await insertAsset({
      bytes: source,
      metadata: {
        branding: {
          version: 1,
          sourceSha256,
          state: 'ready',
          width: 1,
          height: 1,
          accent: '#112233',
          matte: '#FFFFFF'
        },
        revision: 4
      }
    })

    const view = await branding.resolveAssetBrandingView({ assetId, requester, sessionId: 'branding-session' })

    expect(view).toEqual({
      assetId,
      imageUrl: `/branding.png?v=${sourceSha256}`,
      sourceSha256,
      width,
      height,
      accent: '#2878C8'
    })
    expect(await readBranding(assetId)).toEqual({
      version: 2,
      sourceSha256,
      state: 'ready',
      width,
      height,
      accent: '#2878C8'
    })
    expect(assetDataReads).toHaveBeenCalledTimes(2)
    expect(view).not.toHaveProperty('matte')
  })

  it('keeps current v2 ready metadata-only without reading the source blob', async () => {
    const sourceSha256 = 'b'.repeat(64)
    const assetId = await insertAsset({
      metadata: {
        branding: {
          version: 2,
          sourceSha256,
          state: 'ready',
          width: 320,
          height: 180,
          accent: '#AABBCC'
        }
      }
    })

    await expect(branding.resolveAssetBrandingView({ assetId, requester, sessionId: 'reader-session' })).resolves.toEqual({
      assetId,
      imageUrl: `/branding.png?v=${sourceSha256}`,
      sourceSha256,
      width: 320,
      height: 180,
      accent: '#AABBCC'
    })
    expect(assetDataReads).not.toHaveBeenCalled()
  })

  it('does not repeatedly analyze a current v2 unavailable cache entry', async () => {
    const sourceSha256 = 'c'.repeat(64)
    const assetId = await insertAsset({
      metadata: {
        branding: {
          version: 2,
          sourceSha256,
          state: 'unavailable',
          reason: 'invalid'
        }
      }
    })

    await expect(branding.resolveAssetBrandingView({ assetId, requester, sessionId: 'reader-session', deriveIfMissing: true })).resolves.toBeNull()
    await expect(branding.resolveAssetBrandingView({ assetId, requester, sessionId: 'reader-session', deriveIfMissing: true })).resolves.toBeNull()

    expect(assetDataReads).not.toHaveBeenCalled()
  })

  it('authorizes stale branding before reading or analyzing its source', async () => {
    const source = await encodeRgbaPng(16, 16, Buffer.alloc(16 * 16 * 4, 255))
    const assetId = await insertAsset({
      bytes: source,
      metadata: {
        branding: {
          version: 1,
          sourceSha256: 'd'.repeat(64),
          state: 'ready',
          width: 1,
          height: 1,
          accent: '#112233',
          matte: '#FFFFFF'
        }
      }
    })
    checkAccess.mockReturnValue(false)

    await expect(branding.resolveAssetBrandingView({ assetId, requester, sessionId: 'denied-session' })).rejects.toMatchObject({
      status: 404,
      name: 'ASSET_NOT_FOUND'
    })
    expect(checkAccess).toHaveBeenCalledWith(requester, ['manage:system', 'read:assets'], { path: 'branding.png' })
    expect(assetDataReads).not.toHaveBeenCalled()
  })
})
