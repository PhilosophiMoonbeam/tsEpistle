import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'
import type * as AssetBranding from '../../helpers/asset-branding.ts'

const wikiGlobal = globalThis as unknown as { WIKI?: Record<string, unknown> }
const originalWiki = wikiGlobal.WIKI
type TestRequester = { id: number; permissions: string[] }
type TestAuthority = { requester: TestRequester; permissions: string[]; groups: never[]; tagAliases: Record<string, string | null> }
const requester: TestRequester = { id: 7, permissions: ['manage:system', 'read:assets'] }
const authorityFor = (suppliedRequester: TestRequester): TestAuthority => ({
  requester: suppliedRequester,
  permissions: [...suppliedRequester.permissions],
  groups: [],
  tagAliases: {}
})
const permissionAllowed = (user: TestRequester | undefined, permissions: readonly string[]): boolean => {
  const granted = user?.permissions ?? []
  return granted.includes('manage:system') || permissions.some(permission => granted.includes(permission))
}

let db: Knex
let branding: typeof AssetBranding
const assetDataReads = vi.fn()
const checkAccess = vi.fn(permissionAllowed)
const checkPageAccess = vi.fn(
  (
    user: TestRequester | undefined,
    permissions: readonly string[],
    _context: unknown,
    authority: TestAuthority
  ): boolean => authority?.requester === user && permissionAllowed(user, permissions)
)
const loadPageRuleAuthority = vi.fn(async (suppliedRequester: TestRequester, _transaction?: Knex.Transaction) => authorityFor(suppliedRequester))

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
      table.string('hash').nullable()
    })
    await db.schema.createTable('assetData', table => {
      table.integer('id').primary().references('id').inTable('assets').onDelete('CASCADE')
      table.binary('data').notNullable()
    })
    await db.schema.createTable('pageProtectedAssets', table => {
      table.integer('pageId')
      table.string('assetPath')
      table.integer('assetId')
    })
    await db.schema.createTable('pages', table => {
      table.integer('id').primary()
      table.json('extra')
    })
    await db.schema.createTable('pageAccessPasswords', table => {
      table.integer('pageId')
    })
    await db.schema.createTable('brandingTestAuthority', table => {
      table.integer('userId').primary()
      table.boolean('allowed')
    })

    assetDataReads.mockReset()
    const trackedKnex = ((table: string) => {
      if (table === 'assetData') assetDataReads()
      return db(table)
    }) as unknown as Knex
    trackedKnex.transaction = db.transaction.bind(db)

    const assetsQuery = (transaction?: Knex.Transaction) => ({
      findById: vi.fn(async (assetId: number) => {
        const asset = await (transaction ?? db)('assets').where({ id: assetId }).first()
        return asset
          ? {
              ...asset,
              getAssetPath: async () => String(asset.filename)
            }
          : undefined
      })
    })
    checkAccess.mockReset().mockImplementation(permissionAllowed)
    checkPageAccess.mockReset().mockImplementation((user, permissions, _context, authority) => authority?.requester === user && permissionAllowed(user, permissions))
    loadPageRuleAuthority.mockReset().mockImplementation(async suppliedRequester => authorityFor(suppliedRequester))
    wikiGlobal.WIKI = {
      auth: { checkAccess, checkPageAccess, loadPageRuleAuthority },
      models: {
        assets: { query: vi.fn(assetsQuery) },
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
    checkPageAccess.mockReturnValue(false)

    await expect(branding.resolveAssetBrandingView({ assetId, requester, sessionId: 'denied-session' })).rejects.toMatchObject({
      status: 404,
      name: 'ASSET_NOT_FOUND'
    })
    expect(assetDataReads).not.toHaveBeenCalled()
  })

  it('admits legacy branding from caller-only bytes on a single connection without persisting derived metadata', async () => {
    const source = await encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4, 255))
    const legacy = { branding: { version: 1, state: 'ready' }, revision: 9 }
    const assetId = await insertAsset({ bytes: Buffer.from('invalid'), metadata: legacy })
    const rollback = new Error('caller rollback')
    await expect(Promise.resolve(db.transaction(async transaction => {
      await transaction('assetData').where({ id: assetId }).update({ data: source })
      await branding.authorizePageBrandingAssignment({ assetId, requester, sessionId: 'caller', transaction })
      const asset = await transaction('assets').where({ id: assetId }).first()
      expect(JSON.parse(asset.metadata)).toEqual(legacy)
      throw rollback
    }))).rejects.toBe(rollback)
    expect(await readBranding(assetId)).toEqual(legacy.branding)
    const data = await db('assetData').where({ id: assetId }).first()
    expect(Buffer.from(data.data)).toEqual(Buffer.from('invalid'))
    await db.transaction(async transaction => {
      await expect(branding.authorizePageBrandingAssignment({ assetId, requester, sessionId: 'caller', transaction }))
        .rejects.toMatchObject({ name: 'BRANDING_UNAVAILABLE', status: 422 })
    })
  })

  it('uses current caller-transaction authority rather than stale requester permissions', async () => {
    const reader = { id: 8, permissions: ['read:assets'] }
    const assetId = await insertAsset({
      metadata: { branding: { version: 2, state: 'ready', sourceSha256: 'a'.repeat(64), width: 8, height: 8, accent: null } }
    })
    await db('brandingTestAuthority').insert({ userId: reader.id, allowed: true })
    loadPageRuleAuthority.mockImplementation(async (user, transaction) => {
      const row = await (transaction ?? db)('brandingTestAuthority').where({ userId: user.id }).first()
      return { ...authorityFor(user), permissions: row?.allowed ? ['read:assets'] : [] }
    })
    checkPageAccess.mockImplementation((_user, permissions, _context, authority) => permissions.some(permission => authority.permissions.includes(permission)))
    await db.transaction(async transaction => {
      await branding.authorizePageBrandingAssignment({ assetId, requester: reader, sessionId: 'caller', transaction })
      await transaction('brandingTestAuthority').where({ userId: reader.id }).update({ allowed: false })
      await expect(branding.authorizePageBrandingAssignment({ assetId, requester: reader, sessionId: 'caller', transaction }))
        .rejects.toMatchObject({ name: 'ASSET_NOT_FOUND', status: 404 })
    })
  })

  it('observes caller-only protected asset links without cleanup writes or a second connection', async () => {
    const reader = { id: 8, permissions: ['read:assets'] }
    const assetId = await insertAsset({
      metadata: { branding: { version: 2, state: 'ready', sourceSha256: 'a'.repeat(64), width: 8, height: 8, accent: null } }
    })
    const rollback = new Error('caller rollback')
    await expect(Promise.resolve(db.transaction(async transaction => {
      await transaction('pageProtectedAssets').insert({ pageId: 42, assetId, assetPath: 'branding.png' })
      await expect(branding.authorizePageBrandingAssignment({ assetId, requester: reader, sessionId: '', transaction }))
        .rejects.toMatchObject({ name: 'ASSET_LOCKED', status: 403 })
      throw rollback
    }))).rejects.toBe(rollback)
    await db.transaction(async transaction => {
      await expect(branding.authorizePageBrandingAssignment({ assetId, requester: reader, sessionId: '', transaction })).resolves.toBeUndefined()
    })
  })

  it('does not join independently reserved legacy analysis while holding the caller connection', async () => {
    const source = await encodeRgbaPng(8, 8, Buffer.alloc(8 * 8 * 4, 255))
    const assetId = await insertAsset({ bytes: source, metadata: { branding: { version: 1 } } })
    const reservation = branding.reserveAssetBrandingAnalysis(assetId)
    try {
      await db.transaction(async transaction => {
        await expect(branding.authorizePageBrandingAssignment({ assetId, requester, sessionId: 'caller', transaction }))
          .rejects.toMatchObject({ name: 'BRANDING_BUSY', status: 503 })
      })
    } finally {
      branding.releaseAssetBrandingAnalysis(reservation)
    }
    await db.transaction(async transaction => {
      await expect(branding.authorizePageBrandingAssignment({ assetId, requester, sessionId: 'caller', transaction })).resolves.toBeUndefined()
    })
  })
})
