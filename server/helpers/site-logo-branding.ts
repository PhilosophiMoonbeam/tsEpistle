import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import {
  SITE_LOGO_FAVICON_ICO_BYTE_LIMIT,
  SITE_LOGO_ICON_PNG_BYTE_LIMIT,
  SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT,
  SITE_LOGO_PNG_BYTE_LIMIT,
  SITE_LOGO_SOURCE_BYTE_LIMIT,
  SITE_LOGO_STATIC_PNG_BYTE_LIMIT,
  type LogoEffectDescriptor,
  type LogoIconDescriptor
} from '../../shared/site-logo.ts'

export const SITE_LOGO_OBJECT_KINDS = ['source', 'logo-png', 'icon-png', 'favicon-ico', 'particle-v1', 'effect-static-png'] as const
export type SiteLogoObjectKind = (typeof SITE_LOGO_OBJECT_KINDS)[number]

export type SiteLogoEffectDescriptor = LogoEffectDescriptor

export interface ActiveBranding {
  readonly logoUrl: string
  readonly logoEffect: SiteLogoEffectDescriptor | null
  readonly logoIcons: LogoIconDescriptor | null
}

interface SiteLogoObjectRecord {
  readonly kind: SiteLogoObjectKind
  readonly sha256: string
  readonly bytes: Buffer | Uint8Array
  readonly byteLength: number | string
  readonly contentType: string
}

interface ActiveRevisionRow {
  readonly pipelineVersion: number | string
  readonly logoPngKind: string | null
  readonly logoPngHash: string | null
  readonly iconPngKind: string | null
  readonly favicon16Hash: string | null
  readonly favicon32Hash: string | null
  readonly tile150Hash: string | null
  readonly apple180Hash: string | null
  readonly app192Hash: string | null
  readonly app512Hash: string | null
  readonly maskable512Hash: string | null
  readonly faviconIcoKind: string | null
  readonly faviconIcoHash: string | null
  readonly particleV1Kind: string | null
  readonly particleV1Hash: string | null
  readonly effectStaticPngKind: string | null
  readonly effectStaticPngHash: string | null
  readonly normalizedWidth: number | string | null
  readonly normalizedHeight: number | string | null
  readonly particleCount: number | string | null
  readonly medianStroke: number | string | null
  readonly auraColor: string | null
  readonly enhancementErrorCode: string | null
}

interface ParticleHeader {
  readonly width: number
  readonly height: number
  readonly count: number
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const AURA_COLOR_PATTERN = /^#[0-9a-f]{6}$/
const PARTICLE_HEADER_BYTES = 56
const MAX_PARTICLE_COUNT = 16_000
const PARTICLE_BYTES_PER_RECORD = 12
const MAX_PARTICLE_PAYLOAD_BYTES = PARTICLE_BYTES_PER_RECORD * MAX_PARTICLE_COUNT
const MAX_PARTICLE_FILE_BYTES = PARTICLE_HEADER_BYTES + MAX_PARTICLE_PAYLOAD_BYTES
const MANAGED_LOGO_URL_PATTERN = /^\/_site-logo\/[^/]+\/logo\.png(?:[?#].*)?$/

const expectedContentType = (kind: SiteLogoObjectKind): string | null => {
  switch (kind) {
    case 'logo-png':
    case 'icon-png':
    case 'effect-static-png':
      return 'image/png'
    case 'favicon-ico':
      return 'image/x-icon'
    case 'particle-v1':
      return 'application/octet-stream'
    case 'source':
      return null
  }
}

const maximumByteLength = (kind: SiteLogoObjectKind): number => {
  switch (kind) {
    case 'logo-png':
      return SITE_LOGO_PNG_BYTE_LIMIT
    case 'icon-png':
      return SITE_LOGO_ICON_PNG_BYTE_LIMIT
    case 'favicon-ico':
      return SITE_LOGO_FAVICON_ICO_BYTE_LIMIT
    case 'particle-v1':
      return SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT
    case 'effect-static-png':
      return SITE_LOGO_STATIC_PNG_BYTE_LIMIT
    case 'source':
      return SITE_LOGO_SOURCE_BYTE_LIMIT
  }
}

const isSiteLogoObjectKind = (kind: string): kind is SiteLogoObjectKind => (SITE_LOGO_OBJECT_KINDS as readonly string[]).includes(kind)

export const readSiteLogoObject = async (knex: Knex | Knex.Transaction, kind: SiteLogoObjectKind, sha256: string): Promise<Buffer | null> => {
  if (!isSiteLogoObjectKind(kind) || !SHA256_PATTERN.test(sha256)) return null
  const row = await knex<SiteLogoObjectRecord>('siteLogoObjects').where({ kind, sha256 }).first('bytes', 'byteLength', 'contentType')
  if (!row || (!Buffer.isBuffer(row.bytes) && !(row.bytes instanceof Uint8Array))) return null

  const bytes = Buffer.isBuffer(row.bytes) ? row.bytes : Buffer.from(row.bytes)
  if (bytes.byteLength < 1 || bytes.byteLength > maximumByteLength(kind) || Number(row.byteLength) !== bytes.byteLength) return null
  const requiredContentType = expectedContentType(kind)
  if (requiredContentType !== null && row.contentType !== requiredContentType) return null
  return bytes
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const readVerifiedObject = async (knex: Knex | Knex.Transaction, kind: SiteLogoObjectKind, hash: string): Promise<Buffer | null> => {
  try {
    const bytes = await readSiteLogoObject(knex, kind, hash)
    return bytes && sha256(bytes) === hash ? bytes : null
  } catch {
    return null
  }
}

const crc32Table = new Uint32Array(256)
for (let index = 0; index < crc32Table.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crc32Table[index] = value >>> 0
}

const payloadCrc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff
  for (let index = PARTICLE_HEADER_BYTES; index < bytes.byteLength; index += 1) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ bytes[index]!) & 0xff]!
  }
  return (crc ^ 0xffffffff) >>> 0
}

const parseParticleHeader = (bytes: Buffer): ParticleHeader | null => {
  if (bytes.byteLength < PARTICLE_HEADER_BYTES || bytes.byteLength > MAX_PARTICLE_FILE_BYTES) return null
  if (bytes.toString('ascii', 0, 4) !== 'TSEP' || bytes[4] !== 1 || bytes[5] !== 0x07 || bytes.readUInt16LE(6) !== PARTICLE_HEADER_BYTES) return null

  const width = bytes.readUInt32LE(8)
  const height = bytes.readUInt32LE(12)
  const count = bytes.readUInt32LE(16)
  if (width < 2 || width > 4096 || height < 2 || height > 4096 || count < 1 || count > MAX_PARTICLE_COUNT) return null

  const payloadLength = PARTICLE_BYTES_PER_RECORD * count
  const fileLength = PARTICLE_HEADER_BYTES + payloadLength
  const xyOffset = PARTICLE_HEADER_BYTES
  const depthOffset = xyOffset + 4 * count
  const rgbaOffset = depthOffset + count
  const sizeOffset = rgbaOffset + 4 * count
  const seedOffset = sizeOffset + count
  if (
    bytes.readUInt32LE(20) !== payloadLength ||
    payloadLength > MAX_PARTICLE_PAYLOAD_BYTES ||
    bytes.readUInt32LE(28) !== xyOffset ||
    bytes.readUInt32LE(32) !== depthOffset ||
    bytes.readUInt32LE(36) !== rgbaOffset ||
    bytes.readUInt32LE(40) !== sizeOffset ||
    bytes.readUInt32LE(44) !== seedOffset ||
    bytes.readUInt32LE(48) !== fileLength ||
    bytes.readUInt32LE(52) !== 0 ||
    bytes.byteLength !== fileLength ||
    bytes.readUInt32LE(24) !== payloadCrc32(bytes)
  )
    return null

  for (let offset = xyOffset; offset < depthOffset; offset += 2) if (bytes.readInt16LE(offset) === -32_768) return null
  for (let offset = depthOffset; offset < rgbaOffset; offset += 1) if (bytes.readInt8(offset) === -128) return null
  for (let offset = rgbaOffset + 3; offset < sizeOffset; offset += 4) if (bytes[offset] === 0) return null
  for (let offset = sizeOffset; offset < seedOffset; offset += 1) if (bytes[offset] === 0) return null
  for (let offset = seedOffset; offset < fileLength; offset += 2) if (bytes.readUInt16LE(offset) === 0) return null

  return { width, height, count }
}

const integerInRange = (value: number | string | null | undefined, minimum: number, maximum: number): number | null => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}

const validMedianStroke = (value: number | string | null | undefined, maximum: number): number | null => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum ? parsed : null
}

const freezeBranding = (logoUrl: string, logoEffect: SiteLogoEffectDescriptor | null, logoIcons: LogoIconDescriptor | null): ActiveBranding => {
  const branding: ActiveBranding = { logoUrl, logoEffect, logoIcons }
  return Object.freeze(branding)
}

const legacyBranding = (legacyLogoUrl: string): ActiveBranding => {
  const logoUrl = MANAGED_LOGO_URL_PATTERN.test(legacyLogoUrl.trim()) ? '' : legacyLogoUrl
  return freezeBranding(logoUrl, null, null)
}

const resolveIconDescriptor = async (knex: Knex | Knex.Transaction, row: ActiveRevisionRow): Promise<LogoIconDescriptor | null> => {
  if (
    row.iconPngKind !== 'icon-png' ||
    row.faviconIcoKind !== 'favicon-ico' ||
    !row.favicon16Hash ||
    !row.favicon32Hash ||
    !row.tile150Hash ||
    !row.apple180Hash ||
    !row.app192Hash ||
    !row.app512Hash ||
    !row.maskable512Hash ||
    !row.faviconIcoHash
  )
    return null

  const iconHashes = [row.favicon16Hash, row.favicon32Hash, row.tile150Hash, row.apple180Hash, row.app192Hash, row.app512Hash, row.maskable512Hash]
  if (iconHashes.some(hash => !SHA256_PATTERN.test(hash)) || !SHA256_PATTERN.test(row.faviconIcoHash ?? '')) return null

  const iconReads = new Map<string, Promise<Buffer | null>>()
  const readIcon = (hash: string): Promise<Buffer | null> => {
    const existing = iconReads.get(hash)
    if (existing) return existing
    const pending = readVerifiedObject(knex, 'icon-png', hash)
    iconReads.set(hash, pending)
    return pending
  }
  const [favicon16, favicon32, tile150, apple180, app192, app512, maskable512, faviconIco] = await Promise.all([
    ...iconHashes.map(readIcon),
    readVerifiedObject(knex, 'favicon-ico', row.faviconIcoHash)
  ])
  if ([favicon16, favicon32, tile150, apple180, app192, app512, maskable512, faviconIco].some(bytes => bytes === null)) return null

  return Object.freeze({
    favicon16Url: `/_site-logo/${row.favicon16Hash}/icon.png`,
    favicon32Url: `/_site-logo/${row.favicon32Hash}/icon.png`,
    tile150Url: `/_site-logo/${row.tile150Hash}/icon.png`,
    apple180Url: `/_site-logo/${row.apple180Hash}/icon.png`,
    app192Url: `/_site-logo/${row.app192Hash}/icon.png`,
    app512Url: `/_site-logo/${row.app512Hash}/icon.png`,
    maskable512Url: `/_site-logo/${row.maskable512Hash}/icon.png`,
    faviconIcoUrl: `/_site-logo/${row.faviconIcoHash}/favicon.ico`
  })
}

const resolveEffectDescriptor = async (
  knex: Knex | Knex.Transaction,
  row: ActiveRevisionRow,
  pipelineVersion: number,
  logoUrl: string
): Promise<SiteLogoEffectDescriptor | null> => {
  const effectValues = [
    row.particleV1Kind,
    row.particleV1Hash,
    row.effectStaticPngKind,
    row.effectStaticPngHash,
    row.normalizedWidth,
    row.normalizedHeight,
    row.particleCount,
    row.medianStroke,
    row.auraColor
  ]
  if (!effectValues.some(value => value !== null && value !== undefined)) return null
  if ((pipelineVersion === 6 || pipelineVersion === 7) && row.enhancementErrorCode !== null && row.enhancementErrorCode !== undefined) return null
  if (
    row.particleV1Kind !== 'particle-v1' ||
    row.effectStaticPngKind !== 'effect-static-png' ||
    !row.particleV1Hash ||
    !SHA256_PATTERN.test(row.particleV1Hash) ||
    !row.effectStaticPngHash ||
    !SHA256_PATTERN.test(row.effectStaticPngHash)
  )
    return null

  const width = integerInRange(row.normalizedWidth, 2, 4096)
  const height = integerInRange(row.normalizedHeight, 2, 4096)
  const count = integerInRange(row.particleCount, 1, MAX_PARTICLE_COUNT)
  if (width === null || height === null || count === null) return null
  const medianStroke = validMedianStroke(row.medianStroke, Math.max(width, height))
  if (medianStroke === null || (row.auraColor !== null && row.auraColor !== undefined && !AURA_COLOR_PATTERN.test(row.auraColor))) return null

  const [particleBytes, staticBytes] = await Promise.all([
    readVerifiedObject(knex, 'particle-v1', row.particleV1Hash),
    readVerifiedObject(knex, 'effect-static-png', row.effectStaticPngHash)
  ])
  if (!particleBytes || !staticBytes) return null
  const particleHeader = parseParticleHeader(particleBytes)
  if (!particleHeader || particleHeader.width !== width || particleHeader.height !== height || particleHeader.count !== count) return null

  return Object.freeze({
    pipelineVersion,
    logoUrl,
    particleUrl: `/_site-logo/${row.particleV1Hash}/particle.bin`,
    staticUrl: `/_site-logo/${row.effectStaticPngHash}/effect.png`,
    width,
    height,
    aspect: width / height,
    count,
    medianStroke,
    ...(row.auraColor === null || row.auraColor === undefined ? {} : { auraColor: row.auraColor })
  })
}

export const resolveActiveBranding = async (knex: Knex | Knex.Transaction, legacyLogoUrl: string): Promise<ActiveBranding> => {
  const row = (await knex('siteLogoState as state')
    .innerJoin('siteLogoRevisions as revision', 'revision.id', 'state.activeRevisionId')
    .where('state.id', 1)
    .andWhere('revision.status', 'ready')
    .first(
      'revision.pipelineVersion',
      'revision.logoPngKind',
      'revision.logoPngHash',
      'revision.iconPngKind',
      'revision.favicon16Hash',
      'revision.favicon32Hash',
      'revision.tile150Hash',
      'revision.apple180Hash',
      'revision.app192Hash',
      'revision.app512Hash',
      'revision.maskable512Hash',
      'revision.faviconIcoKind',
      'revision.faviconIcoHash',
      'revision.particleV1Kind',
      'revision.particleV1Hash',
      'revision.effectStaticPngKind',
      'revision.effectStaticPngHash',
      'revision.normalizedWidth',
      'revision.normalizedHeight',
      'revision.particleCount',
      'revision.medianStroke',
      'revision.auraColor',
      'revision.enhancementErrorCode'
    )) as ActiveRevisionRow | undefined

  if (!row || row.logoPngKind !== 'logo-png' || !row.logoPngHash || !SHA256_PATTERN.test(row.logoPngHash)) return legacyBranding(legacyLogoUrl)
  const pipelineVersion = integerInRange(row.pipelineVersion, 1, 7)
  if (pipelineVersion === null) return legacyBranding(legacyLogoUrl)

  const logoBytes = await readVerifiedObject(knex, 'logo-png', row.logoPngHash)
  if (!logoBytes) return legacyBranding(legacyLogoUrl)

  const logoUrl = `/_site-logo/${row.logoPngHash}/logo.png`
  const [logoIcons, logoEffect] = await Promise.all([
    pipelineVersion === 6 || pipelineVersion === 7 ? resolveIconDescriptor(knex, row) : Promise.resolve(null),
    resolveEffectDescriptor(knex, row, pipelineVersion, logoUrl)
  ])
  return freezeBranding(logoUrl, logoEffect, logoIcons)
}
