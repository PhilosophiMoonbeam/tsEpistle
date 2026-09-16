import { createHash, randomUUID } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import type { DurableJob } from '../../core/durable-jobs.ts'
import { up as createDurableJobs } from '../../db/migrations/2.5.130.ts'
import { up as addDurableJobLeaseToken } from '../../db/migrations/2.5.158.ts'
import type { SiteLogoArtifacts } from '../../helpers/site-logo-processing.ts'
import { retrySiteLogoCandidate } from '../../operations/site-logo.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from '../bun-test.mts'

const processingMocks = vi.hoisted(() => {
  class ProcessingError extends Error {
    readonly code: string

    constructor(code: string) {
      super(code)
      this.code = code
    }
  }
  return {
    defaultProcessor: vi.fn(),
    parseParticle: vi.fn(() => ({ width: 64, height: 32, count: 2 })),
    ProcessingError
  }
})

vi.mockModule('../../helpers/site-logo-processing.ts', import.meta.url, () => ({
  SiteLogoProcessingError: processingMocks.ProcessingError,
  processSiteLogoSource: processingMocks.defaultProcessor,
  parseParticleV1: processingMocks.parseParticle
}))

const { DurableJobStore } = await import('../../core/durable-jobs.ts')
const { cleanupSiteLogoRevisions, createSiteLogoProcessHandler, failExhaustedSiteLogoJobs } = await import('../../jobs/site-logo-process.ts')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const sourceBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('source')])
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const png = (width: number, height: number, payload = ''): Buffer => {
  const chunk = (type: string, data: Buffer): Buffer => {
    const result = Buffer.alloc(12 + data.length)
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
  const idat = Buffer.from(payload || 'pixel')
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const faviconIco = (suffix: string): Buffer => {
  const images = [png(16, 16, `${suffix}-16`), png(32, 32, `${suffix}-32`)]
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
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

const artifacts = (
  suffix = '',
  enhancement: SiteLogoArtifacts['enhancement'] = {
    status: 'ready',
    particleV1: Buffer.from(`particle-${suffix}`),
    effectStaticPng: png(64, 32, `effect-${suffix}`),
    normalizedWidth: 64,
    normalizedHeight: 32,
    particleCount: 2,
    medianStroke: 4,
    auraColor: '#123456'
  }
): SiteLogoArtifacts => ({
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
  faviconIco: faviconIco(suffix),
  enhancement
})

let knex: Knex

const createTables = async (): Promise<void> => {
  await createDurableJobs(knex)
  await addDurableJobLeaseToken(knex)
  await knex.schema.createTable('siteLogoObjects', table => {
    table.string('kind').notNullable()
    table.string('sha256', 64).notNullable()
    table.binary('bytes').notNullable()
    table.integer('byteLength').notNullable()
    table.string('contentType').notNullable()
    table.dateTime('createdAt').notNullable()
    table.primary(['kind', 'sha256'])
  })
  await knex.schema.createTable('siteLogoRevisions', table => {
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
  await knex.schema.createTable('siteLogoState', table => {
    table.integer('id').primary()
    table.integer('generation').notNullable()
    table.uuid('desiredRevisionId').nullable()
    table.uuid('activeRevisionId').nullable()
    table.dateTime('createdAt').notNullable()
    table.dateTime('updatedAt').notNullable()
  })
  await knex.schema.createTable('settings', table => {
    table.string('key').primary()
    table.json('value')
    table.string('updatedAt').notNullable()
  })
  const now = new Date()
  await knex('siteLogoState').insert({ id: 1, generation: 0, desiredRevisionId: null, activeRevisionId: null, createdAt: now, updatedAt: now })
}

const insertSource = async (bytes = sourceBytes): Promise<string> => {
  const hash = digest(bytes)
  await knex('siteLogoObjects')
    .insert({
      kind: 'source',
      sha256: hash,
      bytes,
      byteLength: bytes.length,
      contentType: 'image/png',
      createdAt: new Date()
    })
    .onConflict(['kind', 'sha256'])
    .ignore()
  return hash
}

const insertObjects = async (output: SiteLogoArtifacts): Promise<void> => {
  const now = new Date()
  const rows = [
    ['logo-png', digest(output.logoPng), output.logoPng, 'image/png'],
    ...Object.values(output.icons).map(bytes => ['icon-png', digest(bytes), bytes, 'image/png']),
    ['favicon-ico', digest(output.faviconIco), output.faviconIco, 'image/x-icon']
  ] as Array<[string, string, Buffer, string]>
  if (output.enhancement.status === 'ready') {
    rows.push(
      ['particle-v1', digest(output.enhancement.particleV1), output.enhancement.particleV1, 'application/octet-stream'],
      ['effect-static-png', digest(output.enhancement.effectStaticPng), output.enhancement.effectStaticPng, 'image/png']
    )
  }
  await knex('siteLogoObjects').insert(
    rows.map(([kind, sha256, bytes, contentType]) => ({ kind, sha256, bytes, byteLength: bytes.length, contentType, createdAt: now }))
  )
}

const insertRevision = async (input: {
  hash: string
  id?: string
  pipelineVersion?: number
  status?: 'pending' | 'running' | 'ready' | 'failed'
  retrySequence?: number
  jobId?: string | null
  output?: SiteLogoArtifacts
  completedAt?: Date | null
  retiredAt?: Date | null
}): Promise<string> => {
  const id = input.id ?? randomUUID()
  const now = new Date()
  const output = input.output
  const readyEnhancement = output?.enhancement.status === 'ready' ? output.enhancement : undefined
  const iconHashes = output ? Object.values(output.icons).map(digest) : []
  await knex('siteLogoRevisions').insert({
    id,
    sourceKind: 'source',
    sourceHash: input.hash,
    pipelineVersion: input.pipelineVersion ?? 7,
    status: input.status ?? 'pending',
    jobId: input.jobId ?? null,
    retrySequence: input.retrySequence ?? 0,
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
    errorCode: input.status === 'failed' ? 'PROCESSING_FAILED' : null,
    requestedBy: null,
    createdAt: now,
    updatedAt: now,
    startedAt: input.status === 'pending' || input.status === undefined ? null : now,
    completedAt: input.completedAt ?? (input.status === 'ready' || input.status === 'failed' ? now : null),
    retiredAt: input.retiredAt ?? null
  })
  return id
}

const insertReadyRevision = async (source: Buffer, output: SiteLogoArtifacts, pipelineVersion = 6): Promise<string> => {
  const hash = await insertSource(source)
  await insertObjects(output)
  return await insertRevision({ hash, pipelineVersion, status: 'ready', output })
}

const enqueueCandidate = async (
  input: { pipelineVersion?: number; jobVersion?: number; source?: Buffer; suffix?: string; expectedActiveRevisionId?: string } = {}
): Promise<{ revisionId: string; job: DurableJob }> => {
  const hash = await insertSource(input.source ?? Buffer.concat([sourceBytes, Buffer.from(input.suffix ?? '')]))
  const revisionId = await insertRevision({ hash, pipelineVersion: input.pipelineVersion ?? 7 })
  const pending = await new DurableJobStore(knex).enqueue({
    type: 'process-site-logo',
    version: input.jobVersion ?? 5,
    payload: {
      revisionId,
      retrySequence: 0,
      ...(input.expectedActiveRevisionId === undefined ? {} : { expectedActiveRevisionId: input.expectedActiveRevisionId })
    },
    maxAttempts: 5
  })
  await knex('siteLogoRevisions').where({ id: revisionId }).update({ jobId: pending.id })
  await knex('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: revisionId })
  const [job] = await new DurableJobStore(knex).claim({ workerId: `logo-worker-${revisionId}`, leaseMs: 60_000 })
  if (!job) throw new Error('Site logo test job was not claimed')
  return { revisionId, job }
}

const run = async (job: DurableJob, processor?: (bytes: Buffer | Uint8Array, hash: string) => Promise<SiteLogoArtifacts>): Promise<void> => {
  const version = Number(job.version) as 1 | 2 | 3 | 4 | 5
  await createSiteLogoProcessHandler(version, processor)(job, { knex, signal: new AbortController().signal })
  if (!(await new DurableJobStore(knex).complete(job))) throw new Error('Site logo test job was not completed')
}

beforeEach(async () => {
  vi.clearAllMocks()
  processingMocks.parseParticle.mockReturnValue({ width: 64, height: 32, count: 2 })
  knex = createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, pool: { min: 1, max: 1 }, useNullAsDefault: true })
  await createTables()
})

afterEach(async () => {
  await knex.destroy()
})

describe('managed site logo v7 durable publication', () => {
  it('publishes the ordinary logo, all icons, ICO, and a complete optional enhancement under job v5', async () => {
    const { revisionId, job } = await enqueueCandidate()
    const output = artifacts('ready')
    await run(job, async () => output)

    const readyEnhancement = output.enhancement
    if (readyEnhancement.status !== 'ready') throw new Error('Expected a ready enhancement fixture')
    expect(job.version).toBe(5)
    expect(await knex('siteLogoObjects').whereNot({ kind: 'source' }).count('* as count')).toEqual([{ count: 11 }])
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first()).toMatchObject({
      pipelineVersion: 7,
      status: 'ready',
      logoPngKind: 'logo-png',
      logoPngHash: digest(output.logoPng),
      iconPngKind: 'icon-png',
      favicon16Hash: digest(output.icons.favicon16),
      favicon32Hash: digest(output.icons.favicon32),
      tile150Hash: digest(output.icons.tile150),
      apple180Hash: digest(output.icons.apple180),
      app192Hash: digest(output.icons.app192),
      app512Hash: digest(output.icons.app512),
      maskable512Hash: digest(output.icons.maskable512),
      faviconIcoKind: 'favicon-ico',
      faviconIcoHash: digest(output.faviconIco),
      particleV1Kind: 'particle-v1',
      particleV1Hash: digest(readyEnhancement.particleV1),
      effectStaticPngKind: 'effect-static-png',
      effectStaticPngHash: digest(readyEnhancement.effectStaticPng),
      enhancementErrorCode: null,
      normalizedWidth: 64,
      normalizedHeight: 32,
      particleCount: 2,
      medianStroke: 4,
      auraColor: '#123456'
    })
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: revisionId,
      desiredRevisionId: revisionId,
      generation: 1
    })
  })

  it('publishes mandatory artifacts and activates when enhancement is unavailable', async () => {
    const { revisionId, job } = await enqueueCandidate()
    const output = artifacts('ordinary-only', { status: 'unavailable', reason: 'UNSUITABLE_LOGO' })
    await run(job, async () => output)

    expect(await knex('siteLogoObjects').whereNot({ kind: 'source' }).count('* as count')).toEqual([{ count: 9 }])
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first()).toMatchObject({
      status: 'ready',
      logoPngKind: 'logo-png',
      logoPngHash: digest(output.logoPng),
      iconPngKind: 'icon-png',
      favicon16Hash: digest(output.icons.favicon16),
      favicon32Hash: digest(output.icons.favicon32),
      tile150Hash: digest(output.icons.tile150),
      apple180Hash: digest(output.icons.apple180),
      app192Hash: digest(output.icons.app192),
      app512Hash: digest(output.icons.app512),
      maskable512Hash: digest(output.icons.maskable512),
      faviconIcoKind: 'favicon-ico',
      faviconIcoHash: digest(output.faviconIco),
      particleV1Kind: null,
      particleV1Hash: null,
      effectStaticPngKind: null,
      effectStaticPngHash: null,
      normalizedWidth: null,
      normalizedHeight: null,
      particleCount: null,
      medianStroke: null,
      auraColor: null,
      enhancementErrorCode: 'UNSUITABLE_LOGO'
    })
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'generation')).toEqual({ activeRevisionId: revisionId, generation: 1 })
  })

  it('keeps the v3 pipeline-5 fence and never lets an old writer create v7 artifacts', async () => {
    const { revisionId, job } = await enqueueCandidate({ pipelineVersion: 5, jobVersion: 3 })
    await run(job, async () => artifacts('must-not-run'))
    expect(processingMocks.defaultProcessor).not.toHaveBeenCalled()
    expect(await knex('siteLogoObjects').whereNot({ kind: 'source' })).toHaveLength(0)
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first('pipelineVersion', 'status', 'errorCode')).toEqual({
      pipelineVersion: 5,
      status: 'failed',
      errorCode: 'PROCESSING_FAILED'
    })
  })

  it('terminalizes pipeline-6 work under historical job v4 without running the v7 processor', async () => {
    const { revisionId, job } = await enqueueCandidate({ pipelineVersion: 6, jobVersion: 4 })
    await run(job, async () => artifacts('must-not-run'))
    expect(processingMocks.defaultProcessor).not.toHaveBeenCalled()
    expect(await knex('siteLogoObjects').whereNot({ kind: 'source' })).toHaveLength(0)
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first('pipelineVersion', 'status', 'errorCode')).toEqual({
      pipelineVersion: 6,
      status: 'failed',
      errorCode: 'PROCESSING_FAILED'
    })
  })

  it('rejects a v7 revision presented to historical job v4 before processing', async () => {
    const { revisionId, job } = await enqueueCandidate({ pipelineVersion: 7, jobVersion: 4 })
    await expect(createSiteLogoProcessHandler(4, async () => artifacts('wrong-protocol'))(job, { knex, signal: new AbortController().signal })).rejects.toThrow(
      'does not match its revision'
    )
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first('status')).toEqual({ status: 'pending' })
  })

  it('rolls back all mandatory objects when publication fails', async () => {
    const { revisionId, job } = await enqueueCandidate()
    await knex.raw("CREATE TRIGGER reject_icon BEFORE INSERT ON siteLogoObjects WHEN NEW.kind = 'icon-png' BEGIN SELECT RAISE(ABORT, 'reject icon'); END")
    await expect(run(job, async () => artifacts('rollback'))).rejects.toThrow('reject icon')
    expect(await knex('siteLogoObjects').whereNot({ kind: 'source' })).toHaveLength(0)
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first('status', 'logoPngHash', 'iconPngKind', 'faviconIcoHash')).toEqual({
      status: 'running',
      logoPngHash: null,
      iconPngKind: null,
      faviconIcoHash: null
    })
  })

  it('does not publish after the lease expires and leaves the candidate retryable', async () => {
    const { revisionId, job } = await enqueueCandidate()
    let objectsBeforeLeaseLoss: unknown
    let revisionBeforeLeaseLoss: unknown
    let stateBeforeLeaseLoss: unknown
    await expect(
      run(job, async () => {
        objectsBeforeLeaseLoss = await knex('siteLogoObjects').orderBy(['kind', 'sha256'])
        revisionBeforeLeaseLoss = await knex('siteLogoRevisions').where({ id: revisionId }).first()
        stateBeforeLeaseLoss = await knex('siteLogoState').where({ id: 1 }).first()
        await knex('durableJobs')
          .where({ id: job.id })
          .update({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        return artifacts('expired')
      })
    ).rejects.toThrow()
    expect(await knex('siteLogoObjects').orderBy(['kind', 'sha256'])).toEqual(objectsBeforeLeaseLoss)
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first()).toEqual(revisionBeforeLeaseLoss)
    expect(await knex('siteLogoState').where({ id: 1 }).first()).toEqual(stateBeforeLeaseLoss)
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first('status')).toEqual({ status: 'running' })
  })

  it('fails source corruption without disturbing the active state', async () => {
    const active = artifacts('active')
    const activeHash = await insertSource(Buffer.concat([sourceBytes, Buffer.from('active')]))
    await insertObjects(active)
    const activeId = await insertRevision({ hash: activeHash, status: 'ready', output: active })
    const activeUrl = `/_site-logo/${digest(active.logoPng)}/logo.png`
    await knex('siteLogoState').where({ id: 1 }).update({ generation: 3, activeRevisionId: activeId, desiredRevisionId: activeId })
    await knex('settings').insert({ key: 'logoUrl', value: JSON.stringify({ v: activeUrl }), updatedAt: new Date().toISOString() })
    const candidate = await enqueueCandidate({ suffix: 'corrupt' })
    await knex('siteLogoObjects')
      .where({ kind: 'source', sha256: (await knex('siteLogoRevisions').where({ id: candidate.revisionId }).first('sourceHash'))!.sourceHash })
      .update({ bytes: Buffer.from('corrupt') })

    await run(candidate.job, async () => artifacts('must-not-run'))
    expect(await knex('siteLogoRevisions').where({ id: candidate.revisionId }).first('status', 'errorCode')).toEqual({
      status: 'failed',
      errorCode: 'PROCESSING_FAILED'
    })
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: activeId,
      desiredRevisionId: candidate.revisionId,
      generation: 3
    })
    expect(await knex('settings').where({ key: 'logoUrl' }).first('value')).toEqual({ value: JSON.stringify({ v: activeUrl }) })
  })

  it('processes older desired work without activation, then activates the newest desired revision', async () => {
    const older = await enqueueCandidate({ suffix: 'older' })
    const newer = await enqueueCandidate({ suffix: 'newer' })
    await run(older.job, async () => artifacts('older'))
    expect(await knex('siteLogoRevisions').where({ id: older.revisionId }).first('status', 'retiredAt')).toMatchObject({ status: 'ready' })
    expect((await knex('siteLogoRevisions').where({ id: older.revisionId }).first('retiredAt'))?.retiredAt).not.toBeNull()
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'generation')).toEqual({ activeRevisionId: null, generation: 0 })
    await run(newer.job, async () => artifacts('newer'))
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: newer.revisionId,
      desiredRevisionId: newer.revisionId,
      generation: 1
    })
  })

  it('activates a valid non-desired repair only for the still-active matching pipeline-6 source', async () => {
    const source = Buffer.concat([sourceBytes, Buffer.from('repair-source')])
    const oldId = await insertReadyRevision(source, artifacts('old-active'), 6)
    await knex('siteLogoState').where({ id: 1 }).update({ activeRevisionId: oldId, desiredRevisionId: null })
    const repair = await enqueueCandidate({ source, expectedActiveRevisionId: oldId })
    await knex('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: null })

    await run(repair.job, async () => artifacts('repair'))

    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: repair.revisionId,
      desiredRevisionId: null,
      generation: 1
    })
    expect(await knex('siteLogoRevisions').where({ id: oldId }).first('status', 'retiredAt')).toMatchObject({ status: 'ready' })
    expect((await knex('siteLogoRevisions').where({ id: oldId }).first('retiredAt'))?.retiredAt).not.toBeNull()
    expect(await knex('siteLogoRevisions').where({ id: repair.revisionId }).first('pipelineVersion', 'status', 'retiredAt')).toMatchObject({
      pipelineVersion: 7,
      status: 'ready',
      retiredAt: null
    })
  })

  it('publishes a source-mismatched repair without activating or changing the active pointer', async () => {
    const oldId = await insertReadyRevision(Buffer.concat([sourceBytes, Buffer.from('old-source')]), artifacts('old-active'), 6)
    await knex('siteLogoState').where({ id: 1 }).update({ activeRevisionId: oldId, desiredRevisionId: null })
    const repair = await enqueueCandidate({
      source: Buffer.concat([sourceBytes, Buffer.from('different-source')]),
      expectedActiveRevisionId: oldId
    })
    await knex('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: null })

    await run(repair.job, async () => artifacts('mismatched-repair'))

    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: oldId,
      desiredRevisionId: null,
      generation: 0
    })
    expect(await knex('siteLogoRevisions').where({ id: repair.revisionId }).first('pipelineVersion', 'status', 'retiredAt')).toMatchObject({
      pipelineVersion: 7,
      status: 'ready'
    })
    expect((await knex('siteLogoRevisions').where({ id: repair.revisionId }).first('retiredAt'))?.retiredAt).not.toBeNull()
  })

  it('does not let a desired activation that wins first get overwritten by a repair', async () => {
    const source = Buffer.concat([sourceBytes, Buffer.from('race-source')])
    const oldId = await insertReadyRevision(source, artifacts('old-active'), 6)
    const newerId = await insertReadyRevision(Buffer.concat([sourceBytes, Buffer.from('newer-source')]), artifacts('newer-active'), 7)
    await knex('siteLogoState').where({ id: 1 }).update({ activeRevisionId: oldId, desiredRevisionId: null, generation: 4 })
    const repair = await enqueueCandidate({ source, expectedActiveRevisionId: oldId })
    await knex('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: null })

    await run(repair.job, async () => {
      await knex('siteLogoState').where({ id: 1 }).update({ activeRevisionId: newerId, desiredRevisionId: newerId })
      return artifacts('stale-repair')
    })

    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: newerId,
      desiredRevisionId: newerId,
      generation: 4
    })
    expect((await knex('siteLogoRevisions').where({ id: repair.revisionId }).first('retiredAt'))?.retiredAt).not.toBeNull()
  })

  it('repairs a v6 active logo while preserving a distinct failed desired revision', async () => {
    const source = Buffer.concat([sourceBytes, Buffer.from('failed-desired-source')])
    const oldId = await insertReadyRevision(source, artifacts('old-active'), 6)
    const failedDesiredHash = await insertSource(Buffer.concat([sourceBytes, Buffer.from('failed-desired')]))
    const failedDesiredId = await insertRevision({ hash: failedDesiredHash, pipelineVersion: 7, status: 'failed' })
    await knex('siteLogoState').where({ id: 1 }).update({ generation: 6, activeRevisionId: oldId, desiredRevisionId: failedDesiredId })
    const repair = await enqueueCandidate({ source, expectedActiveRevisionId: oldId })
    await knex('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: failedDesiredId })

    await run(repair.job, async () => artifacts('failed-desired-repair'))

    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: repair.revisionId,
      desiredRevisionId: failedDesiredId,
      generation: 7
    })
    expect(await knex('siteLogoRevisions').where({ id: failedDesiredId }).first('status', 'retiredAt')).toEqual({ status: 'failed', retiredAt: null })
  })

  it('does not publish a repair after its lease is lost', async () => {
    const source = Buffer.concat([sourceBytes, Buffer.from('lost-lease-repair')])
    const oldId = await insertReadyRevision(source, artifacts('old-active'), 6)
    await knex('siteLogoState').where({ id: 1 }).update({ activeRevisionId: oldId, desiredRevisionId: null })
    const repair = await enqueueCandidate({ source, expectedActiveRevisionId: oldId })
    await knex('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: null })

    let objectsBeforeLeaseLoss: unknown
    let revisionBeforeLeaseLoss: unknown
    let stateBeforeLeaseLoss: unknown
    await expect(
      run(repair.job, async () => {
        objectsBeforeLeaseLoss = await knex('siteLogoObjects').orderBy(['kind', 'sha256'])
        revisionBeforeLeaseLoss = await knex('siteLogoRevisions').where({ id: repair.revisionId }).first()
        stateBeforeLeaseLoss = await knex('siteLogoState').where({ id: 1 }).first()
        await knex('durableJobs')
          .where({ id: repair.job.id })
          .update({ leaseExpiresAt: new Date(Date.now() - 1_000) })
        return artifacts('lost-lease')
      })
    ).rejects.toThrow()
    expect(await knex('siteLogoState').where({ id: 1 }).first()).toEqual(stateBeforeLeaseLoss)
    expect(await knex('siteLogoRevisions').where({ id: repair.revisionId }).first()).toEqual(revisionBeforeLeaseLoss)
    expect(await knex('siteLogoObjects').orderBy(['kind', 'sha256'])).toEqual(objectsBeforeLeaseLoss)
    expect(await knex('siteLogoRevisions').where({ id: repair.revisionId }).first('status')).toEqual({ status: 'running' })
  })

  it('replays an already-published repair without a second activation', async () => {
    const source = Buffer.concat([sourceBytes, Buffer.from('replay-repair')])
    const oldId = await insertReadyRevision(source, artifacts('old-active'), 6)
    await knex('siteLogoState').where({ id: 1 }).update({ activeRevisionId: oldId, desiredRevisionId: null })
    const repair = await enqueueCandidate({ source, expectedActiveRevisionId: oldId })
    await knex('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: null })
    await run(repair.job, async () => artifacts('replay'))
    const publishedState = await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')

    await knex('durableJobs').where({ id: repair.job.id }).update({
      state: 'pending',
      attempts: 0,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      completedAt: null
    })
    const [replay] = await new DurableJobStore(knex).claim({ workerId: `replay-${repair.revisionId}`, leaseMs: 60_000 })
    if (!replay) throw new Error('Site logo replay job was not claimed')
    await createSiteLogoProcessHandler(5, async () => artifacts('must-not-run'))(replay, { knex, signal: new AbortController().signal })
    expect(await new DurableJobStore(knex).complete(replay)).toBe(true)
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual(publishedState)
    expect(processingMocks.defaultProcessor).not.toHaveBeenCalled()
  })

  it('fails closed when a repair payload has a malformed or tampered expected active revision', async () => {
    const source = Buffer.concat([sourceBytes, Buffer.from('strict-repair-payload')])
    const oldId = await insertReadyRevision(source, artifacts('old-active'), 6)
    await knex('siteLogoState').where({ id: 1 }).update({ activeRevisionId: oldId, desiredRevisionId: null })
    const repair = await enqueueCandidate({ source, expectedActiveRevisionId: oldId })
    await knex('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: null })

    const malformed = {
      ...repair.job,
      payload: { ...repair.job.payload, expectedActiveRevisionId: 'not-a-revision-id' }
    }
    await expect(
      createSiteLogoProcessHandler(5, async () => artifacts('must-not-run'))(malformed, { knex, signal: new AbortController().signal })
    ).rejects.toThrow('payload is invalid')
    await knex('durableJobs')
      .where({ id: repair.job.id })
      .update({ payload: JSON.stringify({ ...repair.job.payload, expectedActiveRevisionId: randomUUID() }) })
    await expect(
      createSiteLogoProcessHandler(5, async () => artifacts('must-not-run'))(repair.job, { knex, signal: new AbortController().signal })
    ).rejects.toThrow('no longer owns')
    expect(await knex('siteLogoRevisions').where({ id: repair.revisionId }).first('status')).toEqual({ status: 'pending' })
  })

  it('terminalizes an exhausted v5/v7 lease and leaves it retryable', async () => {
    const active = artifacts('exhaustion-active', { status: 'unavailable', reason: 'PROCESSING_FAILED' })
    const activeHash = await insertSource(Buffer.concat([sourceBytes, Buffer.from('exhaustion-active')]))
    await insertObjects(active)
    const activeId = await insertRevision({ hash: activeHash, status: 'ready', output: active })
    await knex('siteLogoState').where({ id: 1 }).update({ generation: 2, activeRevisionId: activeId, desiredRevisionId: activeId })
    const candidate = await enqueueCandidate({ suffix: 'exhaustion' })
    const exhaustedAt = new Date('2026-09-04T12:00:00.000Z')
    await knex('durableJobs')
      .where({ id: candidate.job.id })
      .update({ attempts: 5, leaseExpiresAt: new Date(exhaustedAt.getTime() - 1) })

    expect(await failExhaustedSiteLogoJobs(knex, exhaustedAt)).toBe(1)
    expect(await knex('siteLogoRevisions').where({ id: candidate.revisionId }).first('pipelineVersion', 'status', 'errorCode', 'retiredAt')).toEqual({
      pipelineVersion: 7,
      status: 'failed',
      errorCode: 'PROCESSING_FAILED',
      retiredAt: null
    })
    await retrySiteLogoCandidate(null, knex)
    const state = await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId')
    const retried = await knex('siteLogoRevisions').where({ id: state.desiredRevisionId }).first('pipelineVersion', 'retrySequence', 'jobId')
    expect(state.activeRevisionId).toBe(activeId)
    expect(retried).toMatchObject({ pipelineVersion: 7, retrySequence: 1 })
    expect(await knex('durableJobs').where({ id: retried.jobId }).first('version')).toEqual({ version: 5 })
  })
})

describe('managed site logo v7 cleanup', () => {
  it('deletes every unreachable v7 role while retaining active references', async () => {
    const old = new Date(Date.now() - 38 * 24 * 60 * 60 * 1_000)
    const active = artifacts('active-cleanup')
    const activeHash = await insertSource(Buffer.concat([sourceBytes, Buffer.from('active-cleanup')]))
    await insertObjects(active)
    const activeId = await insertRevision({ hash: activeHash, status: 'ready', output: active })
    const retired = artifacts('retired-cleanup')
    const retiredHash = await insertSource(Buffer.concat([sourceBytes, Buffer.from('retired-cleanup')]))
    await insertObjects(retired)
    const retiredId = await insertRevision({ hash: retiredHash, status: 'ready', output: retired, completedAt: old, retiredAt: old })
    await knex('siteLogoState').where({ id: 1 }).update({ activeRevisionId: activeId, desiredRevisionId: activeId })

    await cleanupSiteLogoRevisions({} as DurableJob, { knex, signal: new AbortController().signal })

    expect(await knex('siteLogoRevisions').where({ id: retiredId })).toHaveLength(0)
    expect(await knex('siteLogoObjects').where({ sha256: retiredHash })).toHaveLength(0)
    expect(await knex('siteLogoObjects').where({ kind: 'icon-png' })).toHaveLength(7)
    expect(await knex('siteLogoObjects').where({ kind: 'favicon-ico' })).toHaveLength(1)
    expect(await knex('siteLogoObjects').where({ kind: 'particle-v1' })).toHaveLength(1)
    expect(await knex('siteLogoRevisions').where({ id: activeId })).toHaveLength(1)
  })
})
