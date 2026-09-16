import { createHash, randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import type { DurableJob } from '../../core/durable-jobs.ts'
import { DurableJobStore } from '../../core/durable-jobs.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'
import { encodeParticleV1, SiteLogoProcessingError, type ParticleRecord, type SiteLogoArtifacts } from '../../helpers/site-logo-processing.ts'
import type { SiteLogoMutationResult, SiteLogoStatusResponse } from '../../operations/site-logo.ts'
import { createSiteLogoProcessHandler } from '../../jobs/site-logo-process.ts'
import { getSiteLogoStatus, retrySiteLogoCandidate, uploadSiteLogoCandidate } from '../../operations/site-logo.ts'
import { afterEach, beforeEach, describe, expect, it } from '../bun-test.mts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const sourceBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('ha-source-owned-by-database')])
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const png = (width: number, height: number, payload = 'pixel'): Buffer => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length, 0)
    result.write(type, 4, 4, 'ascii')
    data.copy(result, 8)
    return result
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', Buffer.from(payload)), chunk('IEND', Buffer.alloc(0))])
}

const ico = (suffix: string): Buffer => {
  const images = [png(16, 16, `${suffix}-16`), png(32, 32, `${suffix}-32`)]
  const header = Buffer.alloc(38)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(2, 4)
  let offset = header.length
  for (const [index, image] of images.entries()) {
    const entry = 6 + index * 16
    const size = index === 0 ? 16 : 32
    header.writeUInt8(size, entry)
    header.writeUInt8(size, entry + 1)
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(image.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += image.length
  }
  return Buffer.concat([header, ...images])
}

const records: readonly ParticleRecord[] = [
  {
    sourceIndex: 0,
    x: 12,
    y: 8,
    xEncoded: -12_000,
    yEncoded: 10_000,
    depth: -12,
    rgba: [18, 52, 86, 255] as const,
    size: 7,
    seed: 1_337
  }
]

const artifacts = (suffix: string, ordinaryOnly = false): SiteLogoArtifacts => {
  const particleV1 = encodeParticleV1(64, 32, records)
  return {
    logoPng: png(64, 32, `logo-${suffix}`),
    logoWidth: 64,
    logoHeight: 32,
    icons: {
      favicon16: png(16, 16, `${suffix}-favicon16`),
      favicon32: png(32, 32, `${suffix}-favicon32`),
      tile150: png(150, 150, `${suffix}-tile150`),
      apple180: png(180, 180, `${suffix}-apple180`),
      app192: png(192, 192, `${suffix}-app192`),
      app512: png(512, 512, `${suffix}-app512`),
      maskable512: png(512, 512, `${suffix}-maskable512`)
    },
    faviconIco: ico(suffix),
    enhancement: ordinaryOnly
      ? ({ status: 'unavailable', reason: 'UNSUITABLE_LOGO' } as const)
      : ({
          status: 'ready',
          particleV1,
          effectStaticPng: png(64, 32, `effect-${suffix}`),
          normalizedWidth: 64,
          normalizedHeight: 32,
          particleCount: 1,
          medianStroke: 4,
          auraColor: '#345678'
        } as const)
  }
}

type Artifacts = ReturnType<typeof artifacts>

const createLogoTables = async (db: Knex): Promise<void> => {
  await createDurableJobs(db)
  await addDurableJobLeaseToken(db)
  await db.schema.createTable('siteLogoObjects', table => {
    table.string('kind').notNullable()
    table.string('sha256', 64).notNullable()
    table.binary('bytes').notNullable()
    table.integer('byteLength').notNullable()
    table.string('contentType').notNullable()
    table.dateTime('createdAt').notNullable()
    table.primary(['kind', 'sha256'])
  })
  await db.schema.createTable('siteLogoRevisions', table => {
    table.uuid('id').primary()
    table.string('sourceKind').notNullable()
    table.string('sourceHash', 64).notNullable()
    table.integer('pipelineVersion').notNullable()
    table.string('status').notNullable()
    table.uuid('jobId').nullable()
    table.integer('retrySequence').notNullable()
    table.string('logoPngKind').nullable()
    table.string('logoPngHash', 64).nullable()
    table.string('iconPngKind').nullable()
    table.string('favicon16Hash', 64).nullable()
    table.string('favicon32Hash', 64).nullable()
    table.string('tile150Hash', 64).nullable()
    table.string('apple180Hash', 64).nullable()
    table.string('app192Hash', 64).nullable()
    table.string('app512Hash', 64).nullable()
    table.string('maskable512Hash', 64).nullable()
    table.string('faviconIcoKind').nullable()
    table.string('faviconIcoHash', 64).nullable()
    table.string('particleV1Kind').nullable()
    table.string('particleV1Hash', 64).nullable()
    table.string('effectStaticPngKind').nullable()
    table.string('effectStaticPngHash', 64).nullable()
    table.integer('normalizedWidth').nullable()
    table.integer('normalizedHeight').nullable()
    table.integer('particleCount').nullable()
    table.float('medianStroke').nullable()
    table.string('auraColor').nullable()
    table.string('enhancementErrorCode').nullable()
    table.string('errorCode').nullable()
    table.integer('requestedBy').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
    table.dateTime('startedAt').nullable()
    table.dateTime('completedAt').nullable()
    table.dateTime('retiredAt').nullable()
  })
  await db.schema.createTable('siteLogoState', table => {
    table.integer('id').primary()
    table.integer('generation').notNullable()
    table.uuid('desiredRevisionId').nullable()
    table.uuid('activeRevisionId').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
  })
  await db.schema.createTable('settings', table => {
    table.string('key').primary()
    table.json('value')
    table.string('updatedAt').notNullable()
  })
  const now = new Date()
  await db('siteLogoState').insert({ id: 1, generation: 0, desiredRevisionId: null, activeRevisionId: null, createdAt: now, updatedAt: now })
}

const insertSource = async (db: Knex, bytes: Buffer): Promise<string> => {
  const hash = digest(bytes)
  await db('siteLogoObjects').insert({ kind: 'source', sha256: hash, bytes, byteLength: bytes.length, contentType: 'image/png', createdAt: new Date() })
  return hash
}

const insertBundle = async (db: Knex, output: Artifacts): Promise<void> => {
  const now = new Date()
  const rows = [
    ['logo-png', output.logoPng, 'image/png'],
    ...Object.values(output.icons).map(bytes => ['icon-png', bytes, 'image/png']),
    ['favicon-ico', output.faviconIco, 'image/x-icon']
  ] as Array<[string, Buffer, string]>
  if (output.enhancement.status === 'ready') {
    rows.push(
      ['particle-v1', output.enhancement.particleV1, 'application/octet-stream'],
      ['effect-static-png', output.enhancement.effectStaticPng, 'image/png']
    )
  }
  await db('siteLogoObjects').insert(
    rows.map(([kind, bytes, contentType]) => ({ kind, sha256: digest(bytes), bytes, byteLength: bytes.length, contentType, createdAt: now }))
  )
}

const startAndClaim = async (db: Knex, workerId: string, revisionId: string, sourceHash: string, jobVersion = 5): Promise<DurableJob> => {
  const revision = await db('siteLogoRevisions').where({ id: revisionId }).first('jobId', 'sourceHash')
  if (!revision || revision.jobId === null) throw new Error('Site logo revision job was not found')
  await db('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: revisionId })
  const [claimed] = await new DurableJobStore(db).claim({ workerId, leaseMs: 60_000, supportedIdentities: [`process-site-logo@${jobVersion}`] })
  if (
    !claimed ||
    claimed.id !== revision.jobId ||
    claimed.payload.revisionId !== revisionId ||
    claimed.version !== jobVersion ||
    revision.sourceHash !== sourceHash
  ) {
    throw new Error('Site logo job was not claimed')
  }
  return claimed
}

const insertRevision = async (
  db: Knex,
  sourceHash: string,
  output?: Artifacts,
  status: 'pending' | 'ready' | 'failed' = 'pending',
  pipelineVersion = output ? 7 : 5
): Promise<string> => {
  const id = randomUUID()
  const now = new Date()
  const readyEnhancement = output?.enhancement.status === 'ready' ? output.enhancement : undefined
  const iconHashes = output ? Object.values(output.icons).map(digest) : []
  await db('siteLogoRevisions').insert({
    id,
    sourceKind: 'source',
    sourceHash,
    pipelineVersion,
    status,
    jobId: null,
    retrySequence: 0,
    logoPngKind: output ? 'logo-png' : null,
    logoPngHash: output ? digest(output.logoPng) : null,
    iconPngKind: output ? 'icon-png' : null,
    favicon16Hash: iconHashes[0] ?? null,
    favicon32Hash: iconHashes[1] ?? null,
    tile150Hash: iconHashes[2] ?? null,
    apple180Hash: iconHashes[3] ?? null,
    app192Hash: iconHashes[4] ?? null,
    app512Hash: iconHashes[5] ?? null,
    maskable512Hash: iconHashes[6] ?? null,
    faviconIcoKind: output ? 'favicon-ico' : null,
    faviconIcoHash: output ? digest(output.faviconIco) : null,
    particleV1Kind: readyEnhancement ? 'particle-v1' : null,
    particleV1Hash: readyEnhancement ? digest(readyEnhancement.particleV1) : null,
    effectStaticPngKind: readyEnhancement ? 'effect-static-png' : null,
    effectStaticPngHash: readyEnhancement ? digest(readyEnhancement.effectStaticPng) : null,
    normalizedWidth: readyEnhancement?.normalizedWidth ?? null,
    normalizedHeight: readyEnhancement?.normalizedHeight ?? null,
    particleCount: readyEnhancement?.particleCount ?? null,
    medianStroke: readyEnhancement?.medianStroke ?? null,
    auraColor: readyEnhancement?.auraColor ?? null,
    enhancementErrorCode: output?.enhancement.status === 'unavailable' ? output.enhancement.reason : null,
    errorCode: status === 'failed' ? 'PROCESSING_FAILED' : null,
    requestedBy: null,
    createdAt: now,
    updatedAt: now,
    startedAt: status === 'pending' ? null : now,
    completedAt: status === 'ready' ? now : null,
    retiredAt: null
  })
  return id
}

const processNext = async (db: Knex, job: DurableJob, processor: (bytes: Buffer | Uint8Array, hash: string) => Promise<SiteLogoArtifacts>): Promise<void> => {
  await createSiteLogoProcessHandler(5, processor)(job, { knex: db, signal: new AbortController().signal })
  if (!(await new DurableJobStore(db).complete(job))) throw new Error('Site logo job lease was lost')
}

let db: Knex

beforeEach(async () => {
  db = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, pool: { min: 1, max: 1 }, useNullAsDefault: true })
  await createLogoTables(db)
})

afterEach(async () => {
  await db.destroy()
})

describe('site logo v7 HA authority', () => {
  it('deduplicates the same pending source and publishes an identical active snapshot on another node', async () => {
    const first: SiteLogoMutationResult = await uploadSiteLogoCandidate(sourceBytes, 42, db)
    expect(first.statusCode).toBe(202)
    const candidate = first.status.candidate!
    const revisionId = candidate.revisionId
    expect(await db('siteLogoRevisions')).toHaveLength(1)
    expect(await db('durableJobs').where({ type: 'process-site-logo' })).toHaveLength(1)
    const firstJob = await startAndClaim(db, 'node-a', revisionId, digest(sourceBytes))
    expect(first.status.candidate?.revisionId).toBe(revisionId)

    await processNext(db, firstJob, async (bytes, sourceHash) => {
      expect(Buffer.from(bytes)).toEqual(sourceBytes)
      expect(sourceHash).toBe(digest(sourceBytes))
      return artifacts('shared')
    })
    const status: SiteLogoStatusResponse = await getSiteLogoStatus(db)
    expect(status.active).toMatchObject({
      revisionId,
      logoUrl: `/_site-logo/${digest(artifacts('shared').logoPng)}/logo.png`,
      enhancement: { status: 'ready', reason: null }
    })
    expect(status.active?.logoIcons).toEqual({
      favicon16Url: `/_site-logo/${digest(artifacts('shared').icons.favicon16)}/icon.png`,
      favicon32Url: `/_site-logo/${digest(artifacts('shared').icons.favicon32)}/icon.png`,
      tile150Url: `/_site-logo/${digest(artifacts('shared').icons.tile150)}/icon.png`,
      apple180Url: `/_site-logo/${digest(artifacts('shared').icons.apple180)}/icon.png`,
      app192Url: `/_site-logo/${digest(artifacts('shared').icons.app192)}/icon.png`,
      app512Url: `/_site-logo/${digest(artifacts('shared').icons.app512)}/icon.png`,
      maskable512Url: `/_site-logo/${digest(artifacts('shared').icons.maskable512)}/icon.png`,
      faviconIcoUrl: `/_site-logo/${digest(artifacts('shared').faviconIco)}/favicon.ico`
    })

    const second = await uploadSiteLogoCandidate(sourceBytes, 9, db)
    expect(second.statusCode).toBe(200)
    expect(second.status.active).toEqual(status.active)
    expect(second.status.candidate).toBeNull()
  })

  it('activates ordinary branding when optional enhancement is unavailable', async () => {
    const output = artifacts('ordinary-only', true)
    const upload = await uploadSiteLogoCandidate(sourceBytes, 7, db)
    const candidate = upload.status.candidate!
    expect(await db('durableJobs').where({ type: 'process-site-logo' })).toHaveLength(1)
    const job = await startAndClaim(db, 'ordinary-node', candidate.revisionId, digest(sourceBytes))
    await processNext(db, job, async () => output)

    const status = await getSiteLogoStatus(db)
    expect(status.active).toMatchObject({
      revisionId: candidate.revisionId,
      logoUrl: `/_site-logo/${digest(output.logoPng)}/logo.png`,
      enhancement: { status: 'unavailable', reason: 'UNSUITABLE_LOGO' }
    })
    expect(status.active?.logoIcons).not.toBeNull()
    expect(await db('siteLogoObjects').where({ kind: 'particle-v1' })).toHaveLength(0)
  })
  it('continues serving a complete historical v6 icon bundle while v7 is current', async () => {
    const output = artifacts('historical-v6', true)
    const sourceHash = await insertSource(db, Buffer.concat([sourceBytes, Buffer.from('historical-v6')]))
    await insertBundle(db, output)
    const revisionId = await insertRevision(db, sourceHash, output, 'ready', 6)
    await db('siteLogoState').where({ id: 1 }).update({ activeRevisionId: revisionId, desiredRevisionId: revisionId })

    const status = await getSiteLogoStatus(db)
    expect(status.active).toMatchObject({
      revisionId,
      logoUrl: `/_site-logo/${digest(output.logoPng)}/logo.png`,
      enhancement: { status: 'unavailable', reason: 'UNSUITABLE_LOGO' }
    })
    expect(status.active?.logoIcons).not.toBeNull()
  })

  it('keeps the prior active logo and makes a failed v7 candidate retryable', async () => {
    const activeOutput = artifacts('active', true)
    const activeHash = await insertSource(db, Buffer.concat([sourceBytes, Buffer.from('active')]))
    await insertBundle(db, activeOutput)
    const activeId = await insertRevision(db, activeHash, activeOutput, 'ready')
    await db('siteLogoState').where({ id: 1 }).update({ generation: 4, activeRevisionId: activeId, desiredRevisionId: activeId })
    await db('settings').insert({
      key: 'logoUrl',
      value: JSON.stringify({ v: `/_site-logo/${digest(activeOutput.logoPng)}/logo.png` }),
      updatedAt: new Date().toISOString()
    })

    const upload = await uploadSiteLogoCandidate(sourceBytes, 2, db)
    const candidateId = upload.status.candidate!.revisionId
    const job = await startAndClaim(db, 'failure-node', candidateId, digest(sourceBytes))
    await processNext(db, job, async () => {
      throw new SiteLogoProcessingError('PROCESSING_FAILED')
    })

    expect((await getSiteLogoStatus(db)).active).toMatchObject({ revisionId: activeId })
    expect((await getSiteLogoStatus(db)).candidate).toEqual({ revisionId: candidateId, status: 'failed', errorCode: 'PROCESSING_FAILED' })
    const retry = await retrySiteLogoCandidate(3, db)
    expect(retry.statusCode).toBe(202)
    const retried = await db('siteLogoRevisions').where({ id: retry.status.candidate?.revisionId }).first('pipelineVersion', 'retrySequence', 'jobId')
    expect(retried).toMatchObject({ pipelineVersion: 7, retrySequence: 1 })
    if (!retried) throw new Error('retry did not create a revision')
    expect((await db('durableJobs').where({ id: retried.jobId }).first('version')) as unknown).toEqual({ version: 5 })
    expect((await getSiteLogoStatus(db)).active?.revisionId).toBe(activeId)
  })

  it('retains a historical v5 active ordinary logo while reporting no v6 icon bundle', async () => {
    const legacyParticle = encodeParticleV1(64, 32, records)
    const legacyLogo = png(64, 32, 'legacy-logo')
    const legacyStatic = png(64, 32, 'legacy-static')
    const hash = await insertSource(db, sourceBytes)
    const revisionId = randomUUID()
    const now = new Date()
    await db('siteLogoObjects').insert([
      { kind: 'logo-png', sha256: digest(legacyLogo), bytes: legacyLogo, byteLength: legacyLogo.length, contentType: 'image/png', createdAt: now },
      {
        kind: 'particle-v1',
        sha256: digest(legacyParticle),
        bytes: legacyParticle,
        byteLength: legacyParticle.length,
        contentType: 'application/octet-stream',
        createdAt: now
      },
      {
        kind: 'effect-static-png',
        sha256: digest(legacyStatic),
        bytes: legacyStatic,
        byteLength: legacyStatic.length,
        contentType: 'image/png',
        createdAt: now
      }
    ])
    await db('siteLogoRevisions').insert({
      id: revisionId,
      sourceKind: 'source',
      sourceHash: hash,
      pipelineVersion: 5,
      status: 'ready',
      jobId: null,
      retrySequence: 0,
      logoPngKind: 'logo-png',
      logoPngHash: digest(legacyLogo),
      iconPngKind: null,
      favicon16Hash: null,
      favicon32Hash: null,
      tile150Hash: null,
      apple180Hash: null,
      app192Hash: null,
      app512Hash: null,
      maskable512Hash: null,
      faviconIcoKind: null,
      faviconIcoHash: null,
      particleV1Kind: 'particle-v1',
      particleV1Hash: digest(legacyParticle),
      effectStaticPngKind: 'effect-static-png',
      effectStaticPngHash: digest(legacyStatic),
      normalizedWidth: 64,
      normalizedHeight: 32,
      particleCount: 1,
      medianStroke: 4,
      auraColor: null,
      enhancementErrorCode: null,
      errorCode: null,
      requestedBy: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
      retiredAt: null
    })
    await db('siteLogoState').where({ id: 1 }).update({ activeRevisionId: revisionId, desiredRevisionId: revisionId })

    const status = await getSiteLogoStatus(db)
    expect(status.active).toEqual({
      revisionId,
      logoUrl: `/_site-logo/${digest(legacyLogo)}/logo.png`,
      logoIcons: null,
      enhancement: { status: 'ready', reason: null }
    })
  })
})
