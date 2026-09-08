import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import sharp, { type Metadata } from 'sharp'
import {
  AssetBrandingMetadataSchema,
  PageBrandingViewSchema,
  PAGE_BRANDING_VERSION,
  PAGE_BRANDING_MAX_INPUT_DIMENSION,
  PAGE_BRANDING_MAX_INPUT_PIXELS,
  PAGE_BRANDING_MAX_SOURCE_BYTES,
  PAGE_BRANDING_SAMPLE_DIMENSION,
  type AssetBrandingMetadata,
  type PageBrandingView
} from '../../shared/page-branding.ts'
import { deriveAuraColor, type RgbaRaster } from './site-logo-processing.ts'
import { protectedAssetRequiresUnlock } from '../operations/page-protection.ts'
import errors from '../operations/errors.ts'
import type { PagePrincipal } from './page-access.ts'

declare const WIKI: Record<string, unknown>

const { ApplicationError } = errors
const MAX_ACTIVE_BRANDING_ANALYSES = 8
const MAX_FRESHNESS_RETRIES = 3
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

type PageRequester = PagePrincipal

type AssetRow = {
  id: number
  filename?: string
  folderId?: number | null
  metadata?: unknown
  getAssetPath?: () => Promise<string>
}
type AssetQuery = {
  findById(id: number): Promise<AssetRow | undefined>
  where(criteria: Record<string, unknown>): AssetQuery
  first(...columns: string[]): Promise<AssetRow | undefined>
}
type BrandingWiki = {
  auth: { checkAccess(requester: PageRequester, permissions: readonly string[], context?: unknown): boolean }
  models: {
    assets: { query(transaction?: Knex | Knex.Transaction): AssetQuery }
    knex: Knex
  }
}

const runtime = (): BrandingWiki => WIKI as unknown as BrandingWiki

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const parseJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

const metadataRecord = (value: unknown): Record<string, unknown> => {
  const parsed = parseJson(value)
  return record(parsed) ? { ...(parsed as Record<string, unknown>) } : {}
}

const brandingMetadata = (value: unknown): AssetBrandingMetadata | null => {
  const parsed = AssetBrandingMetadataSchema.safeParse(parseJson(value))
  return parsed.success ? parsed.data : null
}

const brandingFromMetadata = (value: unknown): AssetBrandingMetadata | null => {
  const metadata = metadataRecord(value)
  return brandingMetadata(metadata.branding)
}
const hasBrandingMember = (value: unknown): boolean => Object.hasOwn(metadataRecord(value), 'branding')

const unavailable = (sourceSha256: string, reason: 'unsupported' | 'invalid' | 'too-large' | 'processing-failed'): AssetBrandingMetadata => ({
  version: PAGE_BRANDING_VERSION,
  sourceSha256,
  state: 'unavailable',
  reason
})

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

class BrandingInputError extends Error {
  readonly reason: 'unsupported' | 'invalid' | 'too-large'

  constructor(reason: 'unsupported' | 'invalid' | 'too-large') {
    super(reason)
    this.reason = reason
  }
}

const inputFormat = (bytes: Buffer): 'png' | 'jpeg' | 'webp' => {
  if (bytes.length >= PNG_SIGNATURE.length && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    let offset = PNG_SIGNATURE.length
    let sawHeader = false
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset)
      const type = bytes.toString('ascii', offset + 4, offset + 8)
      const end = offset + 12 + length
      if (end > bytes.length || end < offset) throw new BrandingInputError('invalid')
      if (!sawHeader && type !== 'IHDR') throw new BrandingInputError('invalid')
      if (type === 'acTL') throw new BrandingInputError('unsupported')
      if (type === 'IHDR' && length !== 13) throw new BrandingInputError('invalid')
      sawHeader = true
      if (type === 'IEND') {
        if (length !== 0 || end !== bytes.length || !sawHeader) throw new BrandingInputError('invalid')
        return 'png'
      }
      offset = end
    }
    throw new BrandingInputError('invalid')
  }

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes.length < 4 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new BrandingInputError('invalid')
    return 'jpeg'
  }

  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new BrandingInputError('invalid')
    let offset = 12
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString('ascii', offset, offset + 4)
      const length = bytes.readUInt32LE(offset + 4)
      const end = offset + 8 + length + (length & 1)
      if (end > bytes.length || end < offset) throw new BrandingInputError('invalid')
      if (type === 'ANIM' || type === 'ANMF') throw new BrandingInputError('unsupported')
      if (type === 'VP8X' && length >= 1 && (bytes[offset + 8]! & 0x02) !== 0) throw new BrandingInputError('unsupported')
      offset = end
    }
    if (offset !== bytes.length) throw new BrandingInputError('invalid')
    return 'webp'
  }

  throw new BrandingInputError('unsupported')
}

const validateMetadata = (metadata: Metadata, format: 'png' | 'jpeg' | 'webp'): void => {
  if (metadata.format !== format) throw new BrandingInputError('invalid')
  const pages = metadata.pages ?? 1
  if (pages !== 1 || (metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height)) throw new BrandingInputError('unsupported')
  if (!metadata.width || !metadata.height || metadata.width < 1 || metadata.height < 1) throw new BrandingInputError('invalid')
  if (
    metadata.width > PAGE_BRANDING_MAX_INPUT_DIMENSION ||
    metadata.height > PAGE_BRANDING_MAX_INPUT_DIMENSION ||
    metadata.width * metadata.height > PAGE_BRANDING_MAX_INPUT_PIXELS
  )
    throw new BrandingInputError('too-large')
  if (metadata.channels !== undefined && (metadata.channels < 1 || metadata.channels > 4)) throw new BrandingInputError('invalid')
}

const sharpOptions = {
  failOn: 'warning' as const,
  limitInputPixels: PAGE_BRANDING_MAX_INPUT_PIXELS,
  limitInputChannels: 4,
  unlimited: false,
  autoOrient: true
}

const sampleRaster = async (bytes: Buffer, format: 'png' | 'jpeg' | 'webp'): Promise<{ raster: RgbaRaster; width: number; height: number }> => {
  let metadata: Metadata
  try {
    metadata = await sharp(bytes, sharpOptions).metadata()
    validateMetadata(metadata, format)
    const decoded = await sharp(bytes, sharpOptions)
      .toColourspace('srgb')
      .ensureAlpha()
      .resize({ width: PAGE_BRANDING_SAMPLE_DIMENSION, height: PAGE_BRANDING_SAMPLE_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true })
    const width = Number(decoded.info.width)
    const height = Number(decoded.info.height)
    if (
      decoded.info.channels !== 4 ||
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > PAGE_BRANDING_SAMPLE_DIMENSION ||
      height > PAGE_BRANDING_SAMPLE_DIMENSION ||
      decoded.data.length !== width * height * 4
    )
      throw new BrandingInputError('invalid')
    return {
      raster: { width, height, data: Buffer.from(decoded.data) },
      width: Number(metadata.autoOrient?.width ?? width),
      height: Number(metadata.autoOrient?.height ?? height)
    }
  } catch (error: unknown) {
    if (error instanceof BrandingInputError) throw error
    if (error instanceof Error && /pixel limit|too large|memory/i.test(error.message)) throw new BrandingInputError('too-large')
    throw new BrandingInputError('invalid')
  }
}

const deterministicMatte = (raster: RgbaRaster): '#FFFFFF' | '#181A1C' | null => {
  let weight = 0
  let luminance = 0
  for (let index = 0; index < raster.width * raster.height; index += 1) {
    const offset = index * 4
    const alpha = raster.data[offset + 3]! / 255
    if (alpha <= 0) continue
    weight += alpha
    luminance += alpha * (0.2126 * raster.data[offset]! + 0.7152 * raster.data[offset + 1]! + 0.0722 * raster.data[offset + 2]!)
  }
  if (weight <= 0) return null
  return luminance / weight >= 128 ? '#181A1C' : '#FFFFFF'
}
const toBufferView = (value: unknown): Buffer | null => {
  if (Buffer.isBuffer(value)) return value
  if (!(value instanceof Uint8Array)) return null
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
}

export const analyzeAssetBranding = async (source: Buffer | Uint8Array): Promise<AssetBrandingMetadata> => {
  const bytes = toBufferView(source)!
  const sourceSha256 = sha256(bytes)
  if (bytes.length > PAGE_BRANDING_MAX_SOURCE_BYTES) return unavailable(sourceSha256, 'too-large')
  if (bytes.length === 0) return unavailable(sourceSha256, 'invalid')

  let format: 'png' | 'jpeg' | 'webp'
  try {
    format = inputFormat(bytes)
  } catch (error: unknown) {
    if (error instanceof BrandingInputError) return unavailable(sourceSha256, error.reason)
    return unavailable(sourceSha256, 'invalid')
  }

  try {
    const decoded = await sampleRaster(bytes, format)
    const accent = deriveAuraColor(decoded.raster)?.toUpperCase() ?? null
    const matte = deterministicMatte(decoded.raster)
    return AssetBrandingMetadataSchema.parse({
      version: PAGE_BRANDING_VERSION,
      sourceSha256,
      state: 'ready',
      width: decoded.width,
      height: decoded.height,
      accent,
      matte
    })
  } catch (error: unknown) {
    if (error instanceof BrandingInputError) return unavailable(sourceSha256, error.reason)
    return unavailable(sourceSha256, 'processing-failed')
  }
}
const readAssetSnapshot = async (assetId: number): Promise<{ bytes: Buffer; metadata: unknown } | null> => {
  const { models } = runtime()
  const [asset, data] = await Promise.all([
    models.assets.query().findById(assetId),
    models.knex<{ id: number; data: Buffer | Uint8Array }>('assetData').where({ id: assetId }).first()
  ])
  const bytes = toBufferView(data?.data)
  if (!asset || !bytes) return null
  return { bytes, metadata: asset.metadata }
}

const mergeBrandingMetadata = async (assetId: number, expected: AssetBrandingMetadata): Promise<AssetBrandingMetadata | null> => {
  const transaction = await runtime().models.knex.transaction()
  try {
    const query = transaction('assets').where({ id: assetId })
    const lockedQuery = typeof query.forUpdate === 'function' ? query.forUpdate() : query
    const asset = (await lockedQuery.first('metadata')) as { metadata?: unknown } | undefined
    const data = await transaction<{ id: number; data: Buffer | Uint8Array }>('assetData').where({ id: assetId }).first()
    const bytes = toBufferView(data?.data)
    if (!asset || !bytes || sha256(bytes) !== expected.sourceSha256) {
      await transaction.rollback()
      return null
    }
    const current = brandingFromMetadata(asset.metadata)
    if (current?.sourceSha256 === expected.sourceSha256) {
      await transaction.commit()
      return current
    }
    const metadata = metadataRecord(asset.metadata)
    metadata.branding = expected
    await transaction('assets')
      .where({ id: assetId })
      .update({ metadata: JSON.stringify(metadata) })
    await transaction.commit()
    return expected
  } catch (error) {
    try {
      await transaction.rollback()
    } catch {
      /* transaction may already be closed */
    }
    throw error
  }
}

const activeAnalyses = new Map<number, Promise<AssetBrandingMetadata | null>>()
const reservedAnalyses = new Set<number>()

export interface AssetBrandingAnalysisReservation {
  readonly assetId: number
  released: boolean
}

const brandingBusy = () => new ApplicationError('Branding processing is busy', { status: 503, code: 'BRANDING_BUSY' })

export const reserveAssetBrandingAnalysis = (assetId: number): AssetBrandingAnalysisReservation => {
  if (
    !Number.isSafeInteger(assetId) ||
    assetId < 1 ||
    activeAnalyses.has(assetId) ||
    reservedAnalyses.has(assetId) ||
    activeAnalyses.size + reservedAnalyses.size >= MAX_ACTIVE_BRANDING_ANALYSES
  )
    throw brandingBusy()
  reservedAnalyses.add(assetId)
  return { assetId, released: false }
}

export const releaseAssetBrandingAnalysis = (reservation: AssetBrandingAnalysisReservation | undefined): void => {
  if (!reservation || reservation.released) return
  reservation.released = true
  reservedAnalyses.delete(reservation.assetId)
}

const runSingleFlight = (
  assetId: number,
  work: () => Promise<AssetBrandingMetadata | null>,
  reservation?: AssetBrandingAnalysisReservation
): Promise<AssetBrandingMetadata | null> => {
  const existing = activeAnalyses.get(assetId)
  if (existing) {
    releaseAssetBrandingAnalysis(reservation)
    return existing
  }
  const token = reservation ?? reserveAssetBrandingAnalysis(assetId)
  if (token.released || token.assetId !== assetId || !reservedAnalyses.has(assetId)) throw brandingBusy()
  token.released = true
  reservedAnalyses.delete(assetId)
  const current = work()
  activeAnalyses.set(assetId, current)
  void current
    .finally(() => {
      if (activeAnalyses.get(assetId) === current) activeAnalyses.delete(assetId)
    })
    .catch(() => undefined)
  return current
}

export const refreshAssetBranding = async (assetId: number, reservation?: AssetBrandingAnalysisReservation): Promise<AssetBrandingMetadata | null> => {
  if (!Number.isSafeInteger(assetId) || assetId < 1) {
    releaseAssetBrandingAnalysis(reservation)
    return null
  }
  return runSingleFlight(
    assetId,
    async () => {
      for (let attempt = 0; attempt < MAX_FRESHNESS_RETRIES; attempt += 1) {
        const snapshot = await readAssetSnapshot(assetId)
        if (!snapshot) return null
        const sourceSha256 = sha256(snapshot.bytes)
        const cached = brandingFromMetadata(snapshot.metadata)
        if (cached?.sourceSha256 === sourceSha256) return cached
        let derived: AssetBrandingMetadata
        try {
          derived = await analyzeAssetBranding(snapshot.bytes)
        } catch {
          derived = unavailable(sourceSha256, 'processing-failed')
        }
        const committed = await mergeBrandingMetadata(assetId, derived)
        if (!committed) continue
        const current = await readAssetSnapshot(assetId)
        if (!current || sha256(current.bytes) !== derived.sourceSha256) continue
        const currentBranding = brandingFromMetadata(current.metadata)
        if (currentBranding?.sourceSha256 === derived.sourceSha256) return currentBranding
      }
      return null
    },
    reservation
  )
}
export const persistAssetBrandingUnavailable = async (
  assetId: number,
  sourceSha256: string,
  reason: 'unsupported' | 'invalid' | 'too-large' | 'processing-failed' = 'processing-failed'
): Promise<AssetBrandingMetadata | null> => {
  if (!/^[0-9a-f]{64}$/.test(sourceSha256)) return null
  return mergeBrandingMetadata(assetId, unavailable(sourceSha256, reason))
}

const assetPathForAuthorization = async (assetId: number): Promise<{ asset: AssetRow; assetPath: string }> => {
  const asset = await runtime().models.assets.query().findById(assetId)
  if (!asset || typeof asset.getAssetPath !== 'function') throw new ApplicationError('Asset not found', { status: 404, code: 'ASSET_NOT_FOUND' })
  const assetPath = await asset.getAssetPath()
  if (typeof assetPath !== 'string' || assetPath.length < 1 || assetPath.length > 512)
    throw new ApplicationError('Asset not found', { status: 404, code: 'ASSET_NOT_FOUND' })
  return { asset, assetPath }
}

const authorizeAssetPath = async (input: { assetPath: string; requester: PageRequester; sessionId: string }): Promise<void> => {
  const wiki = runtime()
  if (!wiki.auth.checkAccess(input.requester, ['manage:system', 'read:assets'], { path: input.assetPath }))
    throw new ApplicationError('Asset not found', { status: 404, code: 'ASSET_NOT_FOUND' })
  if (await protectedAssetRequiresUnlock({ requester: input.requester, assetPath: input.assetPath, sessionId: input.sessionId }))
    throw new ApplicationError('Access denied', { status: 403, code: 'ASSET_LOCKED' })
}

const encodedAssetUrl = (assetPath: string, sourceSha256: string): string => {
  const segments = assetPath.split('/')
  if (segments.length === 0 || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..'))
    throw new ApplicationError('Asset not found', { status: 404, code: 'ASSET_NOT_FOUND' })
  return `/${segments.map(segment => encodeURIComponent(segment)).join('/')}?v=${sourceSha256}`
}

const currentReadyBranding = (asset: AssetRow): AssetBrandingMetadata | null => {
  const branding = brandingFromMetadata(asset.metadata)
  return branding?.state === 'ready' ? branding : null
}

export const resolveAssetBrandingView = async (input: {
  assetId: number
  requester: PageRequester
  sessionId: string
  deriveIfMissing?: boolean
}): Promise<PageBrandingView | null> => {
  if (!Number.isSafeInteger(input.assetId) || input.assetId < 1) throw new ApplicationError('Asset not found', { status: 404, code: 'ASSET_NOT_FOUND' })
  const { asset, assetPath } = await assetPathForAuthorization(input.assetId)
  await authorizeAssetPath({ assetPath, requester: input.requester, sessionId: input.sessionId })
  let branding = currentReadyBranding(asset)
  if (!branding && input.deriveIfMissing === true) {
    const refreshed = await refreshAssetBranding(input.assetId)
    branding = refreshed?.state === 'ready' ? refreshed : null
  }
  if (!branding || branding.state !== 'ready') return null

  const view = PageBrandingViewSchema.safeParse({
    assetId: input.assetId,
    imageUrl: encodedAssetUrl(assetPath, branding.sourceSha256),
    sourceSha256: branding.sourceSha256,
    width: branding.width,
    height: branding.height,
    accent: branding.accent,
    matte: branding.matte
  })
  return view.success ? view.data : null
}

export const authorizePageBrandingAssignment = async (input: { assetId: number; requester: PageRequester; sessionId: string }): Promise<void> => {
  if (!Number.isSafeInteger(input.assetId) || input.assetId < 1) throw new ApplicationError('Asset not found', { status: 404, code: 'ASSET_NOT_FOUND' })
  const { asset, assetPath } = await assetPathForAuthorization(input.assetId)
  await authorizeAssetPath({ assetPath, requester: input.requester, sessionId: input.sessionId })
  if (!currentReadyBranding(asset)) throw new ApplicationError('Asset branding is unavailable', { status: 422, code: 'BRANDING_UNAVAILABLE' })
}

export const stripAssetBrandingMetadataRecord = (value: unknown): Record<string, unknown> => {
  const metadata = metadataRecord(value)
  delete metadata.branding
  return metadata
}

export const stripAssetBrandingMetadata = (value: unknown): unknown => {
  if (typeof value === 'string') {
    const parsed = parseJson(value)
    return record(parsed) ? JSON.stringify(stripAssetBrandingMetadataRecord(parsed)) : value
  }
  return record(value) ? stripAssetBrandingMetadataRecord(value) : value
}

export const getAssetBrandingMetadata = (value: unknown): AssetBrandingMetadata | null => brandingFromMetadata(value)
export const hasAssetBrandingMetadata = hasBrandingMember

export const sourceSha256 = sha256

export default {
  analyzeAssetBranding,
  authorizePageBrandingAssignment,
  getAssetBrandingMetadata,
  hasAssetBrandingMetadata,
  persistAssetBrandingUnavailable,
  refreshAssetBranding,
  releaseAssetBrandingAnalysis,
  reserveAssetBrandingAnalysis,
  resolveAssetBrandingView,
  sourceSha256,
  stripAssetBrandingMetadata,
  stripAssetBrandingMetadataRecord
}
