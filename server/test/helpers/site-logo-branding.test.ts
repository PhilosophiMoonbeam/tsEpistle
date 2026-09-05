import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import { type ActiveBranding, resolveActiveBranding } from '../../helpers/site-logo-branding.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

const HEADER_BYTES = 56
const BYTES_PER_PARTICLE = 12

const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const crc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

const particleObject = (width: number, height: number, count: number, variant: number): Buffer => {
  const bytes = Buffer.alloc(HEADER_BYTES + BYTES_PER_PARTICLE * count)
  const xyOffset = HEADER_BYTES
  const depthOffset = xyOffset + 4 * count
  const rgbaOffset = depthOffset + count
  const sizeOffset = rgbaOffset + 4 * count
  const seedOffset = sizeOffset + count

  bytes.write('TSEP', 0, 'ascii')
  bytes[4] = 1
  bytes[5] = 0x07
  bytes.writeUInt16LE(HEADER_BYTES, 6)
  bytes.writeUInt32LE(width, 8)
  bytes.writeUInt32LE(height, 12)
  bytes.writeUInt32LE(count, 16)
  bytes.writeUInt32LE(BYTES_PER_PARTICLE * count, 20)
  bytes.writeUInt32LE(xyOffset, 28)
  bytes.writeUInt32LE(depthOffset, 32)
  bytes.writeUInt32LE(rgbaOffset, 36)
  bytes.writeUInt32LE(sizeOffset, 40)
  bytes.writeUInt32LE(seedOffset, 44)
  bytes.writeUInt32LE(bytes.byteLength, 48)

  for (let index = 0; index < count; index += 1) {
    bytes.writeInt16LE(variant + index, xyOffset + 4 * index)
    bytes.writeInt16LE(variant + index + 1, xyOffset + 4 * index + 2)
    bytes.writeInt8(variant, depthOffset + index)
    bytes.set([20 + variant, 40 + variant, 60 + variant, 255], rgbaOffset + 4 * index)
    bytes[sizeOffset + index] = 1 + variant
    bytes.writeUInt16LE(1 + variant + index, seedOffset + 2 * index)
  }
  bytes.writeUInt32LE(crc32(bytes.subarray(HEADER_BYTES)), 24)
  return bytes
}

interface Bundle {
  readonly revisionId: string
  readonly pipelineVersion: number
  readonly logoHash: string
  readonly particleHash: string
  readonly staticHash: string
  readonly width: number
  readonly height: number
  readonly count: number
  readonly medianStroke: number
  readonly auraColor: string | null
}

const expectedBranding = (bundle: Bundle): ActiveBranding => {
  const logoUrl = `/_site-logo/${bundle.logoHash}/logo.png`
  return {
    logoUrl,
    logoEffect: {
      pipelineVersion: bundle.pipelineVersion,
      logoUrl,
      particleUrl: `/_site-logo/${bundle.particleHash}/particle.bin`,
      staticUrl: `/_site-logo/${bundle.staticHash}/effect.png`,
      width: bundle.width,
      height: bundle.height,
      aspect: bundle.width / bundle.height,
      count: bundle.count,
      medianStroke: bundle.medianStroke,
      ...(bundle.auraColor === null ? {} : { auraColor: bundle.auraColor })
    }
  }
}

describe('resolved site-logo branding', () => {
  let db: Knex

  beforeEach(async () => {
    db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      pool: { min: 1, max: 1 },
      useNullAsDefault: true
    })
    await db.schema.createTable('siteLogoObjects', table => {
      table.string('kind').notNullable()
      table.string('sha256', 64).notNullable()
      table.binary('bytes').notNullable()
      table.integer('byteLength').notNullable()
      table.string('contentType').notNullable()
      table.primary(['kind', 'sha256'])
    })
    await db.schema.createTable('siteLogoRevisions', table => {
      table.uuid('id').primary()
      table.string('status').notNullable()
      table.integer('pipelineVersion').notNullable()
      table.string('logoPngKind').nullable()
      table.string('logoPngHash', 64).nullable()
      table.string('particleV1Kind').nullable()
      table.string('particleV1Hash', 64).nullable()
      table.string('effectStaticPngKind').nullable()
      table.string('effectStaticPngHash', 64).nullable()
      table.integer('normalizedWidth').nullable()
      table.integer('normalizedHeight').nullable()
      table.integer('particleCount').nullable()
      table.float('medianStroke').nullable()
      table.string('auraColor').nullable()
      table.string('errorCode').nullable()
    })
    await db.schema.createTable('siteLogoState', table => {
      table.integer('id').primary()
      table.uuid('desiredRevisionId').nullable()
      table.uuid('activeRevisionId').nullable()
    })
    await db('siteLogoState').insert({ id: 1, desiredRevisionId: null, activeRevisionId: null })
  })

  afterEach(async () => {
    await db.destroy()
  })

  const insertReadyBundle = async (input: {
    revisionId: string
    variant: number
    width: number
    height: number
    count: number
    medianStroke: number
    auraColor?: string
    pipelineVersion?: number
  }): Promise<Bundle> => {
    const logoBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`logo-${input.variant}`)])
    const particles = particleObject(input.width, input.height, input.count, input.variant)
    const staticBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`static-${input.variant}`)])
    const bundle: Bundle = {
      revisionId: input.revisionId,
      pipelineVersion: input.pipelineVersion ?? 3,
      logoHash: digest(logoBytes),
      particleHash: digest(particles),
      staticHash: digest(staticBytes),
      width: input.width,
      height: input.height,
      count: input.count,
      medianStroke: input.medianStroke,
      auraColor: input.auraColor ?? null
    }
    await db('siteLogoObjects').insert([
      {
        kind: 'logo-png',
        sha256: bundle.logoHash,
        bytes: logoBytes,
        byteLength: logoBytes.byteLength,
        contentType: 'image/png'
      },
      {
        kind: 'particle-v1',
        sha256: bundle.particleHash,
        bytes: particles,
        byteLength: particles.byteLength,
        contentType: 'application/octet-stream'
      },
      {
        kind: 'effect-static-png',
        sha256: bundle.staticHash,
        bytes: staticBytes,
        byteLength: staticBytes.byteLength,
        contentType: 'image/png'
      }
    ])
    await db('siteLogoRevisions').insert({
      id: bundle.revisionId,
      status: 'ready',
      pipelineVersion: bundle.pipelineVersion,
      logoPngKind: 'logo-png',
      logoPngHash: bundle.logoHash,
      particleV1Kind: 'particle-v1',
      particleV1Hash: bundle.particleHash,
      effectStaticPngKind: 'effect-static-png',
      effectStaticPngHash: bundle.staticHash,
      normalizedWidth: bundle.width,
      normalizedHeight: bundle.height,
      particleCount: bundle.count,
      medianStroke: bundle.medianStroke,
      auraColor: bundle.auraColor
    })
    return bundle
  }

  it('preserves fresh, bundled, legacy, relative, and external configuration as static-only branding', async () => {
    const unmanagedLogoUrls = [
      '',
      '/_assets/svg/icon-tsepistle.svg',
      '/_assets/svg/icon-tsfranki.svg',
      '/assets/company.svg',
      'https://cdn.example.test/brand/company.svg'
    ]

    for (const logoUrl of unmanagedLogoUrls) {
      expect(await resolveActiveBranding(db, logoUrl)).toEqual({ logoUrl, logoEffect: null })
    }
  })
  it.each([1, 2, 3, 4, 5])('exposes supported pipeline v%s in the active descriptor', async pipelineVersion => {
    const active = await insertReadyBundle({
      revisionId: `00000000-0000-4000-8000-00000000000${pipelineVersion}`,
      variant: pipelineVersion,
      width: 640,
      height: 320,
      count: 2,
      medianStroke: 4,
      pipelineVersion
    })
    await db('siteLogoState').where({ id: 1 }).update({ activeRevisionId: active.revisionId, desiredRevisionId: active.revisionId })

    expect(await resolveActiveBranding(db, '/assets/legacy.svg')).toEqual(expectedBranding(active))
  })

  it.each([0, 1.5, 6])('falls back to ordinary legacy branding for unsupported pipeline version %s', async pipelineVersion => {
    const active = await insertReadyBundle({
      revisionId: '00000000-0000-4000-8000-00000000000a',
      variant: 1,
      width: 640,
      height: 320,
      count: 2,
      medianStroke: 4,
      pipelineVersion
    })
    await db('siteLogoState').where({ id: 1 }).update({ activeRevisionId: active.revisionId, desiredRevisionId: active.revisionId })

    expect(await resolveActiveBranding(db, '/assets/legacy.svg')).toEqual({ logoUrl: '/assets/legacy.svg', logoEffect: null })
  })

  it('keeps the complete active A branding while replacement B is pending, processing, or ordinarily failed', async () => {
    const active = await insertReadyBundle({
      revisionId: '00000000-0000-4000-8000-00000000000a',
      variant: 1,
      width: 640,
      height: 320,
      count: 2,
      medianStroke: 4,
      auraColor: '#123abc',
      pipelineVersion: 2
    })
    const replacementId = '00000000-0000-4000-8000-00000000000b'
    await db('siteLogoRevisions').insert({ id: replacementId, pipelineVersion: 3, status: 'pending' })
    await db('siteLogoState').where({ id: 1 }).update({ activeRevisionId: active.revisionId, desiredRevisionId: replacementId })

    for (const candidate of [
      { status: 'pending', errorCode: null },
      { status: 'running', errorCode: null },
      { status: 'failed', errorCode: 'PROCESSING_FAILED' }
    ]) {
      await db('siteLogoRevisions').where({ id: replacementId }).update(candidate)
      const branding = await resolveActiveBranding(db, '/assets/legacy.svg')
      expect(branding).toEqual(expectedBranding(active))
      expect(branding.logoEffect?.logoUrl).toBe(branding.logoUrl)
    }
  })

  it('switches the ordinary logo and effect as one complete bundle and never resolves mixed hashes', async () => {
    const activeA = await insertReadyBundle({
      revisionId: '00000000-0000-4000-8000-00000000000a',
      variant: 1,
      width: 640,
      height: 320,
      count: 2,
      medianStroke: 4,
      auraColor: '#123abc',
      pipelineVersion: 2
    })
    const activeB = await insertReadyBundle({
      revisionId: '00000000-0000-4000-8000-00000000000b',
      variant: 2,
      width: 300,
      height: 600,
      count: 3,
      medianStroke: 7
    })
    await db('siteLogoState').where({ id: 1 }).update({ activeRevisionId: activeA.revisionId, desiredRevisionId: activeB.revisionId })

    const observed = await db.transaction(async transaction => {
      const before = await resolveActiveBranding(transaction, '/assets/legacy.svg')
      await transaction('siteLogoState').where({ id: 1 }).update({ activeRevisionId: activeB.revisionId })
      const after = await resolveActiveBranding(transaction, '/assets/legacy.svg')
      return [before, after]
    })

    expect(observed).toEqual([expectedBranding(activeA), expectedBranding(activeB)])
    for (const branding of observed) {
      expect(branding.logoEffect?.logoUrl).toBe(branding.logoUrl)
      expect([expectedBranding(activeA), expectedBranding(activeB)]).toContainEqual(branding)
    }
    expect(await resolveActiveBranding(db, '/assets/legacy.svg')).toEqual(expectedBranding(activeB))
  })
})
