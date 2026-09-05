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
    parseParticle: vi.fn(() => ({ width: 64, height: 32, count: 1 })),
    ProcessingError
  }
})

vi.mockModule('../../helpers/site-logo-processing.ts', import.meta.url, () => ({
  SITE_LOGO_PIPELINE_VERSION: 5,
  SITE_LOGO_SOURCE_BYTE_LIMIT: 5_242_880,
  SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT: 192_056,
  SITE_LOGO_PARTICLE_GZIP_BYTE_LIMIT: 176 * 1_024,
  SITE_LOGO_PNG_BYTE_LIMIT: 512 * 1_024,
  SITE_LOGO_STATIC_PNG_BYTE_LIMIT: 1_024 * 1_024,
  SiteLogoProcessingError: processingMocks.ProcessingError,
  processSiteLogoSource: processingMocks.defaultProcessor,
  parseParticleV1: processingMocks.parseParticle
}))

// These imports must follow the hoisted helper mock so the handler receives the injected parser.
const { DurableJobStore } = await import('../../core/durable-jobs.ts')
const { cleanupSiteLogoRevisions, createSiteLogoProcessHandler, failExhaustedSiteLogoJobs } = await import('../../jobs/site-logo-process.ts')

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const sourceBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from('source')])

const artifacts = (suffix = ''): SiteLogoArtifacts => ({
  logoPng: Buffer.concat([PNG_SIGNATURE, Buffer.from(`logo${suffix}`)]),
  particleV1: Buffer.from(`particle${suffix}`),
  effectStaticPng: Buffer.concat([PNG_SIGNATURE, Buffer.from(`effect${suffix}`)]),
  normalizedWidth: 64,
  normalizedHeight: 32,
  particleCount: 1,
  medianStroke: 4,
  auraColor: '#123456'
})

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

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
  await knex('siteLogoObjects').insert({
    kind: 'source',
    sha256: hash,
    bytes,
    byteLength: bytes.byteLength,
    contentType: 'image/png',
    createdAt: new Date()
  })
  return hash
}

const insertRevision = async (input: {
  id?: string
  hash: string
  status?: 'pending' | 'running' | 'ready' | 'failed'
  jobId?: string | null
  retrySequence?: number
  pipelineVersion?: number
  completedAt?: Date | null
  retiredAt?: Date | null
  outputs?: SiteLogoArtifacts
}): Promise<string> => {
  const id = input.id ?? randomUUID()
  const now = new Date()
  const output = input.outputs
  await knex('siteLogoRevisions').insert({
    id,
    sourceKind: 'source',
    sourceHash: input.hash,
    pipelineVersion: input.pipelineVersion ?? 5,
    status: input.status ?? 'pending',
    jobId: input.jobId ?? null,
    retrySequence: input.retrySequence ?? 0,
    logoPngKind: output ? 'logo-png' : null,
    logoPngHash: output ? digest(output.logoPng) : null,
    particleV1Kind: output ? 'particle-v1' : null,
    particleV1Hash: output ? digest(output.particleV1) : null,
    effectStaticPngKind: output ? 'effect-static-png' : null,
    effectStaticPngHash: output ? digest(output.effectStaticPng) : null,
    normalizedWidth: output?.normalizedWidth ?? null,
    normalizedHeight: output?.normalizedHeight ?? null,
    particleCount: output?.particleCount ?? null,
    medianStroke: output?.medianStroke ?? null,
    auraColor: output?.auraColor ?? null,
    errorCode: input.status === 'failed' ? 'PROCESSING_FAILED' : null,
    requestedBy: null,
    createdAt: now,
    updatedAt: now,
    startedAt: (input.status ?? 'pending') === 'pending' ? null : now,
    completedAt: input.completedAt ?? (input.status === 'ready' || input.status === 'failed' ? now : null),
    retiredAt: input.retiredAt ?? null
  })
  return id
}

const insertDerivedObjects = async (output: SiteLogoArtifacts): Promise<void> => {
  const now = new Date()
  await knex('siteLogoObjects').insert([
    {
      kind: 'logo-png',
      sha256: digest(output.logoPng),
      bytes: output.logoPng,
      byteLength: output.logoPng.byteLength,
      contentType: 'image/png',
      createdAt: now
    },
    {
      kind: 'particle-v1',
      sha256: digest(output.particleV1),
      bytes: output.particleV1,
      byteLength: output.particleV1.byteLength,
      contentType: 'application/octet-stream',
      createdAt: now
    },
    {
      kind: 'effect-static-png',
      sha256: digest(output.effectStaticPng),
      bytes: output.effectStaticPng,
      byteLength: output.effectStaticPng.byteLength,
      contentType: 'image/png',
      createdAt: now
    }
  ])
}

type SiteLogoJobVersion = 1 | 2 | 3

const enqueueCandidate = async (
  pipelineVersion = 5,
  jobVersion: SiteLogoJobVersion = pipelineVersion === 5 ? 3 : pipelineVersion === 4 ? 2 : 1
): Promise<{ revisionId: string; job: DurableJob }> => {
  const hash = await insertSource()
  const revisionId = await insertRevision({ hash, pipelineVersion })
  const store = new DurableJobStore(knex)
  const pending = await store.enqueue({
    type: 'process-site-logo',
    version: jobVersion,
    payload: { revisionId, retrySequence: 0 },
    maxAttempts: 5
  })
  await knex('siteLogoRevisions').where({ id: revisionId }).update({ jobId: pending.id })
  await knex('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: revisionId })
  const [job] = await store.claim({ workerId: 'logo-worker', leaseMs: 60_000 })
  if (!job) throw new Error('Site logo test job was not claimed')
  return { revisionId, job }
}

const run = async (job: DurableJob, processor: (bytes: Buffer | Uint8Array, hash: string) => Promise<SiteLogoArtifacts>): Promise<void> => {
  const jobVersion = Number(job.version)
  if (jobVersion !== 1 && jobVersion !== 2 && jobVersion !== 3) throw new Error(`Unexpected site logo job version ${jobVersion}`)
  await createSiteLogoProcessHandler(jobVersion, processor)(job, { knex, signal: new AbortController().signal })
}
const runDefault = async (job: DurableJob): Promise<void> => {
  const jobVersion = Number(job.version)
  if (jobVersion !== 1 && jobVersion !== 2 && jobVersion !== 3) throw new Error(`Unexpected site logo job version ${jobVersion}`)
  await createSiteLogoProcessHandler(jobVersion)(job, { knex, signal: new AbortController().signal })
}

beforeEach(async () => {
  vi.clearAllMocks()
  processingMocks.parseParticle.mockReturnValue({ width: 64, height: 32, count: 1 })
  knex = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    pool: { min: 1, max: 1 },
    useNullAsDefault: true
  })
  await createTables()
})

afterEach(async () => {
  await knex.destroy()
})

describe('managed site logo durable processing', () => {
  it('publishes exactly three derived objects and activates all metadata under the current lease', async () => {
    const { revisionId, job } = await enqueueCandidate()
    expect(job.version).toBe(3)
    const output = artifacts()
    const processor = async (): Promise<SiteLogoArtifacts> => output

    await run(job, processor)
    expect(await knex('siteLogoObjects').whereNot({ kind: 'source' }).select('kind', 'sha256').orderBy('kind')).toEqual([
      { kind: 'effect-static-png', sha256: digest(output.effectStaticPng) },
      { kind: 'logo-png', sha256: digest(output.logoPng) },
      { kind: 'particle-v1', sha256: digest(output.particleV1) }
    ])
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first()).toMatchObject({
      pipelineVersion: 5,
      status: 'ready',
      logoPngKind: 'logo-png',
      logoPngHash: digest(output.logoPng),
      particleV1Kind: 'particle-v1',
      particleV1Hash: digest(output.particleV1),
      effectStaticPngKind: 'effect-static-png',
      effectStaticPngHash: digest(output.effectStaticPng),
      normalizedWidth: 64,
      normalizedHeight: 32,
      particleCount: 1,
      medianStroke: 4,
      auraColor: '#123456',
      retiredAt: null
    })
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: revisionId,
      desiredRevisionId: revisionId,
      generation: 1
    })
    expect(await knex('settings').where({ key: 'logoUrl' }).first('value')).toEqual({
      value: JSON.stringify({ v: `/_site-logo/${digest(output.logoPng)}/logo.png` })
    })
  })
  it.each([
    [1, 'pending'],
    [1, 'running'],
    [2, 'pending'],
    [2, 'running'],
    [3, 'pending'],
    [3, 'running'],
    [4, 'pending'],
    [4, 'running']
  ] as const)('processes protocol-paired pipeline-v%s %s candidate and preserves its fenced pipeline version', async (pipelineVersion, status) => {
    const { revisionId, job } = await enqueueCandidate(pipelineVersion)
    expect(job.version).toBe(pipelineVersion === 4 ? 2 : 1)
    if (status === 'running') await knex('siteLogoRevisions').where({ id: revisionId }).update({ status, startedAt: new Date() })
    const output = artifacts(`upgraded-v${pipelineVersion}-${status}`)

    await run(job, async () => output)

    expect(await knex('durableJobs').where({ id: job.id }).first('state', 'leaseOwner', 'leaseToken')).toEqual({
      state: 'running',
      leaseOwner: job.leaseOwner,
      leaseToken: job.leaseToken
    })
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: revisionId,
      desiredRevisionId: revisionId,
      generation: 1
    })
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first('jobId', 'retrySequence', 'pipelineVersion', 'status', 'logoPngHash')).toEqual({
      jobId: job.id,
      retrySequence: 0,
      pipelineVersion,
      status: 'ready',
      logoPngHash: digest(output.logoPng)
    })
  })
  it.each([
    [1, 1],
    [2, 4]
  ] as const)(
    'default process-site-logo@%s fails a pending pipeline-v%s candidate without replacing the active v4 bundle and retries as @3/v5',
    async (jobVersion, pipelineVersion) => {
      const activeOutput = artifacts(`active-v4-before-default-${jobVersion}`)
      const activeHash = await insertSource(Buffer.concat([PNG_SIGNATURE, Buffer.from(`active-v4-source-${jobVersion}`)]))
      await insertDerivedObjects(activeOutput)
      const activeId = await insertRevision({ hash: activeHash, status: 'ready', pipelineVersion: 4, outputs: activeOutput })
      const activeUrl = `/_site-logo/${digest(activeOutput.logoPng)}/logo.png`
      await knex('siteLogoState').where({ id: 1 }).update({ generation: 4, activeRevisionId: activeId, desiredRevisionId: activeId })
      await knex('settings').insert({ key: 'logoUrl', value: JSON.stringify({ v: activeUrl }), updatedAt: new Date().toISOString() })
      const derivedBefore = await knex('siteLogoObjects').whereNot({ kind: 'source' }).select('kind', 'sha256').orderBy(['kind', 'sha256'])
      const { revisionId, job } = await enqueueCandidate(pipelineVersion, jobVersion)

      await runDefault(job)
      expect(await new DurableJobStore(knex).complete(job)).toBe(true)

      expect(processingMocks.defaultProcessor).not.toHaveBeenCalled()
      expect(processingMocks.parseParticle).not.toHaveBeenCalled()
      expect(await knex('siteLogoObjects').whereNot({ kind: 'source' }).select('kind', 'sha256').orderBy(['kind', 'sha256'])).toEqual(derivedBefore)
      expect(
        await knex('siteLogoRevisions')
          .where({ id: revisionId })
          .first('pipelineVersion', 'status', 'errorCode', 'logoPngHash', 'particleV1Hash', 'effectStaticPngHash')
      ).toEqual({
        pipelineVersion,
        status: 'failed',
        errorCode: 'PROCESSING_FAILED',
        logoPngHash: null,
        particleV1Hash: null,
        effectStaticPngHash: null
      })
      expect(await knex('siteLogoRevisions').where({ id: activeId }).first('pipelineVersion', 'status', 'retiredAt')).toEqual({
        pipelineVersion: 4,
        status: 'ready',
        retiredAt: null
      })
      expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
        activeRevisionId: activeId,
        desiredRevisionId: revisionId,
        generation: 4
      })
      expect(await knex('settings').where({ key: 'logoUrl' }).first('value')).toEqual({ value: JSON.stringify({ v: activeUrl }) })

      await retrySiteLogoCandidate(null, knex)
      const retriedState = await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId')
      const retried = await knex('siteLogoRevisions').where({ id: retriedState.desiredRevisionId }).first('status', 'jobId', 'retrySequence', 'pipelineVersion')
      expect(retriedState.activeRevisionId).toBe(activeId)
      expect(retried).toMatchObject({ status: 'pending', retrySequence: 1, pipelineVersion: 5 })
      expect(await knex('durableJobs').where({ id: retried.jobId }).first('type', 'version')).toEqual({ type: 'process-site-logo', version: 3 })
    }
  )

  it.each([
    [1, 3, 'ready'],
    [1, 3, 'failed'],
    [2, 4, 'ready'],
    [2, 4, 'failed']
  ] as const)('default process-site-logo@%s replays terminal pipeline-v%s %s work as a no-op', async (jobVersion, pipelineVersion, status) => {
    const { revisionId, job } = await enqueueCandidate(pipelineVersion, jobVersion)
    const now = new Date()
    await knex('siteLogoRevisions')
      .where({ id: revisionId })
      .update({ status, startedAt: now, completedAt: now, errorCode: status === 'failed' ? 'PROCESSING_FAILED' : null })
    const revisionBefore = await knex('siteLogoRevisions').where({ id: revisionId }).first()

    await runDefault(job)
    expect(await new DurableJobStore(knex).complete(job)).toBe(true)

    expect(processingMocks.defaultProcessor).not.toHaveBeenCalled()
    expect(processingMocks.parseParticle).not.toHaveBeenCalled()
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first()).toEqual(revisionBefore)
    expect(await knex('siteLogoObjects').whereNot({ kind: 'source' })).toHaveLength(0)
  })

  it.each(
    (
      [
        [1, 4],
        [1, 5],
        [2, 1],
        [2, 2],
        [2, 3],
        [2, 5],
        [3, 1],
        [3, 2],
        [3, 3],
        [3, 4]
      ] as const
    ).flatMap(([jobVersion, pipelineVersion]) =>
      (['pending', 'running', 'ready', 'failed'] as const)
        .filter(status => !(jobVersion === 1 && pipelineVersion === 4 && status === 'ready'))
        .map(status => [jobVersion, pipelineVersion, status] as const)
    )
  )(
    'rejects process-site-logo@%s paired with pipeline v%s in %s state without mutating or publishing the revision',
    async (jobVersion, pipelineVersion, status) => {
      const { revisionId, job } = await enqueueCandidate(pipelineVersion, jobVersion)
      if (status !== 'pending') {
        const now = new Date()
        await knex('siteLogoRevisions')
          .where({ id: revisionId })
          .update({
            status,
            startedAt: now,
            completedAt: status === 'ready' || status === 'failed' ? now : null
          })
      }
      const revisionBefore = await knex('siteLogoRevisions').where({ id: revisionId }).first()
      const processor = vi.fn(async () => artifacts(`wrong-pair-${jobVersion}-${pipelineVersion}-${status}`))

      await expect(run(job, processor)).rejects.toThrow('does not match its revision')

      expect(processor).not.toHaveBeenCalled()
      expect(await knex('siteLogoRevisions').where({ id: revisionId }).first()).toEqual(revisionBefore)
      expect(await knex('siteLogoObjects').whereNot({ kind: 'source' })).toHaveLength(0)
      expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
        activeRevisionId: null,
        desiredRevisionId: revisionId,
        generation: 0
      })
      expect(await knex('settings')).toHaveLength(0)
    }
  )

  it('commits a lease-valid A completion as a terminal retired bundle when B becomes desired', async () => {
    const { revisionId, job } = await enqueueCandidate()
    const staleOutput = artifacts('stale')
    const newerSource = Buffer.concat([PNG_SIGNATURE, Buffer.from('newer')])
    const newerId = await insertRevision({ hash: await insertSource(newerSource) })
    await knex('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: newerId })

    await run(job, async () => staleOutput)
    expect(await new DurableJobStore(knex).complete(job)).toBe(true)

    const stale = await knex('siteLogoRevisions').where({ id: revisionId }).first()
    expect(stale).toMatchObject({
      status: 'ready',
      logoPngHash: digest(staleOutput.logoPng),
      particleV1Hash: digest(staleOutput.particleV1),
      effectStaticPngHash: digest(staleOutput.effectStaticPng)
    })
    expect(stale.completedAt).not.toBeNull()
    expect(stale.retiredAt).not.toBeNull()
    expect(
      await knex('siteLogoObjects').whereIn('sha256', [digest(staleOutput.logoPng), digest(staleOutput.particleV1), digest(staleOutput.effectStaticPng)])
    ).toHaveLength(3)
    expect((await knex('durableJobs').where({ id: job.id }).first('state'))?.state).toBe('succeeded')
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: null,
      desiredRevisionId: newerId,
      generation: 0
    })
    expect(await knex('settings').where({ key: 'logoUrl' })).toHaveLength(0)
  })

  it.each([
    ['before the first derived object', 'logo'],
    ['between the first and second derived objects', 'particle'],
    ['between the second and third derived objects', 'effect'],
    ['after all objects but before revision metadata', 'revision'],
    ['after candidate metadata but before retiring the prior active revision', 'retirement'],
    ['after retirement but before the managed URL', 'setting'],
    ['after the managed URL but before activation', 'state']
  ] as const)('rolls back the complete A state when publication fails %s', async (_description, boundary) => {
    const activeOutput = artifacts('atomic-active')
    const activeHash = await insertSource(Buffer.concat([PNG_SIGNATURE, Buffer.from('atomic-active-source')]))
    await insertDerivedObjects(activeOutput)
    const activeId = await insertRevision({ hash: activeHash, status: 'ready', outputs: activeOutput })
    const activeUrl = `/_site-logo/${digest(activeOutput.logoPng)}/logo.png`
    await knex('siteLogoState').where({ id: 1 }).update({
      generation: 7,
      activeRevisionId: activeId,
      desiredRevisionId: activeId
    })
    await knex('settings').insert({ key: 'logoUrl', value: JSON.stringify({ v: activeUrl }), updatedAt: new Date().toISOString() })
    const { revisionId, job } = await enqueueCandidate()
    const candidateOutput = artifacts(`atomic-${boundary}`)

    switch (boundary) {
      case 'logo':
      case 'particle':
      case 'effect': {
        const kind = boundary === 'logo' ? 'logo-png' : boundary === 'particle' ? 'particle-v1' : 'effect-static-png'
        await knex.raw(`CREATE TRIGGER reject_publication BEFORE INSERT ON siteLogoObjects
          WHEN NEW.kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'injected ${boundary} failure'); END`)
        break
      }
      case 'revision':
        await knex.raw(`CREATE TRIGGER reject_publication BEFORE UPDATE OF status ON siteLogoRevisions
          WHEN NEW.status = 'ready' BEGIN SELECT RAISE(ABORT, 'injected revision failure'); END`)
        break
      case 'retirement':
        await knex.raw(`CREATE TRIGGER reject_publication BEFORE UPDATE OF retiredAt ON siteLogoRevisions
          WHEN OLD.id = '${activeId}' AND NEW.retiredAt IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected retirement failure'); END`)
        break
      case 'setting':
        await knex.raw(`CREATE TRIGGER reject_publication BEFORE UPDATE ON settings
          WHEN OLD.key = 'logoUrl' BEGIN SELECT RAISE(ABORT, 'injected setting failure'); END`)
        break
      case 'state':
        await knex.raw(`CREATE TRIGGER reject_publication BEFORE UPDATE OF activeRevisionId ON siteLogoState
          WHEN NEW.activeRevisionId = '${revisionId}' BEGIN SELECT RAISE(ABORT, 'injected state failure'); END`)
        break
    }

    await expect(run(job, async () => candidateOutput)).rejects.toThrow()

    expect(
      await knex('siteLogoObjects').whereIn('sha256', [
        digest(candidateOutput.logoPng),
        digest(candidateOutput.particleV1),
        digest(candidateOutput.effectStaticPng)
      ])
    ).toHaveLength(0)
    expect(
      await knex('siteLogoRevisions')
        .where({ id: revisionId })
        .first(
          'status',
          'logoPngKind',
          'logoPngHash',
          'particleV1Kind',
          'particleV1Hash',
          'effectStaticPngKind',
          'effectStaticPngHash',
          'normalizedWidth',
          'normalizedHeight',
          'particleCount',
          'medianStroke',
          'auraColor',
          'errorCode',
          'completedAt',
          'retiredAt'
        )
    ).toEqual({
      status: 'running',
      logoPngKind: null,
      logoPngHash: null,
      particleV1Kind: null,
      particleV1Hash: null,
      effectStaticPngKind: null,
      effectStaticPngHash: null,
      normalizedWidth: null,
      normalizedHeight: null,
      particleCount: null,
      medianStroke: null,
      auraColor: null,
      errorCode: null,
      completedAt: null,
      retiredAt: null
    })
    expect(await knex('siteLogoRevisions').where({ id: activeId }).first('status', 'retiredAt')).toEqual({
      status: 'ready',
      retiredAt: null
    })
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: activeId,
      desiredRevisionId: revisionId,
      generation: 7
    })
    expect(await knex('settings').where({ key: 'logoUrl' }).first('value')).toEqual({
      value: JSON.stringify({ v: activeUrl })
    })
  })

  it('refuses publication after the exact durable lease expires', async () => {
    const { revisionId, job } = await enqueueCandidate()
    const processor = vi.fn(async () => {
      await knex('durableJobs')
        .where({ id: job.id })
        .update({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      return artifacts('expired')
    })

    await expect(run(job, processor)).rejects.toThrow()

    expect(await knex('siteLogoObjects').whereNot({ kind: 'source' })).toHaveLength(0)
    expect((await knex('siteLogoRevisions').where({ id: revisionId }).first('status'))?.status).toBe('running')
  })

  it.each([
    [1, 1],
    [1, 2],
    [1, 3],
    [2, 4],
    [3, 5]
  ] as const)(
    'atomically fails an exhausted process-site-logo@%s pipeline-v%s candidate and leaves its active logo retryable',
    async (jobVersion, pipelineVersion) => {
      const activeOutput = artifacts('exhaustion-active')
      const activeHash = await insertSource(Buffer.concat([PNG_SIGNATURE, Buffer.from('exhaustion-active-source')]))
      await insertDerivedObjects(activeOutput)
      const activeId = await insertRevision({ hash: activeHash, status: 'ready', outputs: activeOutput })
      const activeUrl = `/_site-logo/${digest(activeOutput.logoPng)}/logo.png`
      await knex('siteLogoState').where({ id: 1 }).update({ generation: 4, activeRevisionId: activeId, desiredRevisionId: activeId })
      await knex('settings').insert({ key: 'logoUrl', value: JSON.stringify({ v: activeUrl }), updatedAt: new Date().toISOString() })
      const { revisionId, job } = await enqueueCandidate(pipelineVersion, jobVersion)
      const exhaustedAt = new Date('2026-09-04T12:00:00.000Z')
      await knex('durableJobs')
        .where({ id: job.id })
        .update({ attempts: 5, leaseExpiresAt: new Date('2026-09-04T11:59:59.000Z') })

      expect(await failExhaustedSiteLogoJobs(knex, exhaustedAt)).toBe(1)
      const terminalJob = await knex('durableJobs').where({ id: job.id }).first('state', 'attempts', 'leaseOwner', 'leaseToken', 'lastError', 'completedAt')
      expect(terminalJob).toMatchObject({
        state: 'failed',
        attempts: 5,
        leaseOwner: null,
        leaseToken: null,
        lastError: 'Durable job lease expired after its final allowed attempt'
      })
      expect(new Date(terminalJob.completedAt).getTime()).toBe(exhaustedAt.getTime())
      const terminalRevision = await knex('siteLogoRevisions').where({ id: revisionId }).first('status', 'errorCode', 'completedAt', 'retiredAt')
      expect(terminalRevision).toMatchObject({
        status: 'failed',
        errorCode: 'PROCESSING_FAILED',
        retiredAt: null
      })
      expect(new Date(terminalRevision.completedAt).getTime()).toBe(exhaustedAt.getTime())
      expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
        activeRevisionId: activeId,
        desiredRevisionId: revisionId,
        generation: 4
      })
      expect(await knex('settings').where({ key: 'logoUrl' }).first('value')).toEqual({ value: JSON.stringify({ v: activeUrl }) })

      await retrySiteLogoCandidate(null, knex)
      const retriedState = await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId')
      const retried = await knex('siteLogoRevisions').where({ id: retriedState.desiredRevisionId }).first('status', 'jobId', 'retrySequence', 'pipelineVersion')
      expect(retriedState.activeRevisionId).toBe(activeId)
      expect(retried).toMatchObject({ status: 'pending', retrySequence: 1, pipelineVersion: 5 })
      expect(retried.jobId).not.toBe(job.id)
      expect((await knex('siteLogoRevisions').where({ id: revisionId }).first('retiredAt'))?.retiredAt).not.toBeNull()
      expect(await failExhaustedSiteLogoJobs(knex, new Date('2026-09-04T12:00:01.000Z'))).toBe(0)

      await expect(
        run(job, async () => {
          throw new processingMocks.ProcessingError('UNSUITABLE_LOGO')
        })
      ).rejects.toThrow()
      expect(await knex('siteLogoRevisions').where({ id: retriedState.desiredRevisionId }).first('status', 'errorCode')).toEqual({
        status: 'pending',
        errorCode: null
      })
      expect((await knex('siteLogoRevisions').where({ id: activeId }).first('status'))?.status).toBe('ready')
    }
  )

  it.each([
    [1, 1],
    [1, 2],
    [1, 3],
    [2, 4],
    [3, 5]
  ] as const)('reconciles a terminal process-site-logo@%s pipeline-v%s failure and makes its candidate retryable', async (jobVersion, pipelineVersion) => {
    const { revisionId, job } = await enqueueCandidate(pipelineVersion, jobVersion)
    const failedAt = new Date('2026-09-04T11:59:59.000Z')
    const reconciledAt = new Date('2026-09-04T12:00:00.000Z')
    await knex('durableJobs').where({ id: job.id }).update({
      state: 'failed',
      attempts: 5,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: 'older worker rejected the candidate pipeline version',
      completedAt: failedAt,
      updatedAt: failedAt
    })

    expect(await failExhaustedSiteLogoJobs(knex, reconciledAt)).toBe(1)
    const terminalJob = await knex('durableJobs').where({ id: job.id }).first('state', 'attempts', 'lastError', 'completedAt')
    expect(terminalJob).toMatchObject({
      state: 'failed',
      attempts: 5,
      lastError: 'older worker rejected the candidate pipeline version'
    })
    expect(new Date(terminalJob.completedAt).getTime()).toBe(failedAt.getTime())
    const terminalRevision = await knex('siteLogoRevisions').where({ id: revisionId }).first('status', 'errorCode', 'completedAt', 'retiredAt')
    expect(terminalRevision).toMatchObject({
      status: 'failed',
      errorCode: 'PROCESSING_FAILED',
      retiredAt: null
    })
    expect(new Date(terminalRevision.completedAt).getTime()).toBe(reconciledAt.getTime())
    expect(await failExhaustedSiteLogoJobs(knex, new Date('2026-09-04T12:00:01.000Z'))).toBe(0)

    await retrySiteLogoCandidate(null, knex)
    const retriedState = await knex('siteLogoState').where({ id: 1 }).first('desiredRevisionId')
    const retried = await knex('siteLogoRevisions').where({ id: retriedState.desiredRevisionId }).first('status', 'retrySequence', 'pipelineVersion')
    expect(retried).toEqual({ status: 'pending', retrySequence: 1, pipelineVersion: 5 })
  })

  it.each([
    [1, 4],
    [1, 5],
    [2, 1],
    [2, 2],
    [2, 3],
    [2, 5],
    [3, 1],
    [3, 2],
    [3, 3],
    [3, 4]
  ] as const)('does not reconcile exhausted process-site-logo@%s work paired with pipeline v%s', async (jobVersion, pipelineVersion) => {
    const { revisionId, job } = await enqueueCandidate(pipelineVersion, jobVersion)
    const leaseOwner = job.leaseOwner
    const leaseToken = job.leaseToken
    await knex('durableJobs')
      .where({ id: job.id })
      .update({ attempts: 5, leaseExpiresAt: new Date(0) })

    expect(await failExhaustedSiteLogoJobs(knex, new Date('2026-09-04T12:00:00.000Z'))).toBe(0)

    expect(await knex('durableJobs').where({ id: job.id }).first('state', 'attempts', 'leaseOwner', 'leaseToken', 'completedAt')).toEqual({
      state: 'running',
      attempts: 5,
      leaseOwner,
      leaseToken,
      completedAt: null
    })
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first('pipelineVersion', 'status', 'errorCode', 'completedAt')).toEqual({
      pipelineVersion,
      status: 'pending',
      errorCode: null,
      completedAt: null
    })
  })

  it('fails only the fenced older revision when a newer candidate is desired', async () => {
    const { revisionId: olderRevisionId, job: olderJob } = await enqueueCandidate()
    await knex('siteLogoRevisions').where({ id: olderRevisionId }).update({ status: 'running' })
    await knex('durableJobs')
      .where({ id: olderJob.id })
      .update({ attempts: 5, leaseExpiresAt: new Date(0) })

    const newerHash = await insertSource(Buffer.concat([PNG_SIGNATURE, Buffer.from('newer-exhaustion-source')]))
    const newerRevisionId = await insertRevision({ hash: newerHash, retrySequence: 1 })
    const newerJob = await new DurableJobStore(knex).enqueue({
      type: 'process-site-logo',
      version: 3,
      payload: { revisionId: newerRevisionId, retrySequence: 1 },
      maxAttempts: 5
    })
    await knex('siteLogoRevisions').where({ id: newerRevisionId }).update({ jobId: newerJob.id })
    await knex('siteLogoState').where({ id: 1 }).update({ desiredRevisionId: newerRevisionId })

    expect(await failExhaustedSiteLogoJobs(knex, new Date('2026-09-04T12:00:00.000Z'))).toBe(1)

    expect(await knex('siteLogoRevisions').where({ id: olderRevisionId }).first('status', 'errorCode')).toEqual({
      status: 'failed',
      errorCode: 'PROCESSING_FAILED'
    })
    expect((await knex('siteLogoRevisions').where({ id: olderRevisionId }).first('retiredAt'))?.retiredAt).not.toBeNull()
    expect(await knex('siteLogoRevisions').where({ id: newerRevisionId }).first('status', 'errorCode', 'retiredAt')).toEqual({
      status: 'pending',
      errorCode: null,
      retiredAt: null
    })
    expect(await knex('durableJobs').where({ id: newerJob.id }).first('state', 'attempts')).toEqual({ state: 'pending', attempts: 0 })
    expect((await knex('siteLogoState').where({ id: 1 }).first('desiredRevisionId'))?.desiredRevisionId).toBe(newerRevisionId)
  })

  it('rolls back exhausted job terminalization when its matching revision cannot become terminal', async () => {
    const { revisionId, job } = await enqueueCandidate()
    const leaseOwner = job.leaseOwner
    const leaseToken = job.leaseToken
    await knex('siteLogoRevisions').where({ id: revisionId }).update({ status: 'running' })
    await knex('durableJobs')
      .where({ id: job.id })
      .update({ attempts: 5, leaseExpiresAt: new Date(0) })
    await knex.raw(`CREATE TRIGGER reject_exhaustion BEFORE UPDATE OF status ON siteLogoRevisions
      WHEN OLD.id = '${revisionId}' AND NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'injected exhaustion failure'); END`)

    await expect(failExhaustedSiteLogoJobs(knex, new Date('2026-09-04T12:00:00.000Z'))).rejects.toThrow('injected exhaustion failure')

    expect(await knex('durableJobs').where({ id: job.id }).first('state', 'attempts', 'leaseOwner', 'leaseToken', 'completedAt')).toEqual({
      state: 'running',
      attempts: 5,
      leaseOwner,
      leaseToken,
      completedAt: null
    })
    expect(await knex('siteLogoRevisions').where({ id: revisionId }).first('status', 'errorCode', 'completedAt')).toEqual({
      status: 'running',
      errorCode: null,
      completedAt: null
    })
  })

  it.each(['completion', 'failure'] as const)('fences an expired worker %s after reclaim and publishes only the reclaimed lease bundle', async staleOutcome => {
    const { revisionId, job: expiredJob } = await enqueueCandidate()
    let releaseProcessing!: () => void
    let processingStarted!: () => void
    const processingGate = new Promise<void>(resolve => {
      releaseProcessing = resolve
    })
    const started = new Promise<void>(resolve => {
      processingStarted = resolve
    })
    const expiredOutput = artifacts(`expired-worker-${staleOutcome}`)
    const expiredRun = run(expiredJob, async () => {
      processingStarted()
      await processingGate
      if (staleOutcome === 'failure') throw new processingMocks.ProcessingError('UNSUITABLE_LOGO')
      return expiredOutput
    })
    const expiredSettlement = expiredRun.then(
      () => 'resolved' as const,
      () => 'rejected' as const
    )
    await started

    const reclaimAt = new Date()
    await knex('durableJobs')
      .where({ id: expiredJob.id })
      .update({ leaseExpiresAt: new Date(reclaimAt.getTime() - 1) })
    const store = new DurableJobStore(knex)
    const [reclaimedJob] = await store.claim({ workerId: 'reclaimed-logo-worker', leaseMs: 60_000, now: reclaimAt })
    releaseProcessing()
    if (!reclaimedJob) {
      await expiredSettlement
      throw new Error('Expired site logo job was not reclaimed')
    }

    expect(reclaimedJob.id).toBe(expiredJob.id)
    expect(reclaimedJob.attempts).toBe(2)
    expect(reclaimedJob.leaseToken).not.toBe(expiredJob.leaseToken)
    expect(await expiredSettlement).toBe('rejected')
    expect(
      await knex('siteLogoObjects').whereIn('sha256', [digest(expiredOutput.logoPng), digest(expiredOutput.particleV1), digest(expiredOutput.effectStaticPng)])
    ).toHaveLength(0)
    expect((await knex('siteLogoRevisions').where({ id: revisionId }).first('status'))?.status).toBe('running')

    const reclaimedOutput = artifacts('reclaimed-worker')
    await run(reclaimedJob, async () => reclaimedOutput)
    expect(await store.complete(reclaimedJob)).toBe(true)

    expect(
      await knex('siteLogoObjects').whereIn('sha256', [
        digest(reclaimedOutput.logoPng),
        digest(reclaimedOutput.particleV1),
        digest(reclaimedOutput.effectStaticPng)
      ])
    ).toHaveLength(3)
    expect(
      await knex('siteLogoRevisions').where({ id: revisionId }).first('status', 'logoPngHash', 'particleV1Hash', 'effectStaticPngHash', 'retiredAt')
    ).toEqual({
      status: 'ready',
      logoPngHash: digest(reclaimedOutput.logoPng),
      particleV1Hash: digest(reclaimedOutput.particleV1),
      effectStaticPngHash: digest(reclaimedOutput.effectStaticPng),
      retiredAt: null
    })
    expect((await knex('durableJobs').where({ id: expiredJob.id }).first('state'))?.state).toBe('succeeded')
  })

  it.each([
    [1, 3, 3],
    [1, 4, 3],
    [2, 4, 4],
    [3, 5, 5]
  ] as const)(
    'reclaims process-site-logo@%s ready pipeline-v%s after activation without reprocessing or publishing a second state',
    async (jobVersion, replayPipelineVersion, processingPipelineVersion) => {
      const { revisionId, job: crashedJob } = await enqueueCandidate(processingPipelineVersion, jobVersion)
      const output = artifacts(`activated-before-crash-${jobVersion}-v${replayPipelineVersion}`)
      await run(crashedJob, async () => output)
      if (replayPipelineVersion !== processingPipelineVersion) {
        await knex('siteLogoRevisions').where({ id: revisionId }).update({ pipelineVersion: replayPipelineVersion })
      }

      const stateAfterActivation = await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')
      const revisionAfterActivation = await knex('siteLogoRevisions').where({ id: revisionId }).first()
      const settingAfterActivation = await knex('settings').where({ key: 'logoUrl' }).first('value')
      await knex('durableJobs')
        .where({ id: crashedJob.id })
        .update({ leaseExpiresAt: new Date(0) })
      const store = new DurableJobStore(knex)
      const [reclaimedJob] = await store.claim({ workerId: 'post-activation-reclaimer', leaseMs: 60_000, now: new Date() })
      if (!reclaimedJob) throw new Error('Activated site logo job was not reclaimed')
      const replayProcessor = vi.fn(async () => artifacts('must-not-publish'))

      await run(reclaimedJob, replayProcessor)
      expect(await store.complete(reclaimedJob)).toBe(true)

      expect(replayProcessor).not.toHaveBeenCalled()
      expect(await knex('siteLogoObjects').whereNot({ kind: 'source' })).toHaveLength(3)
      expect(await knex('siteLogoRevisions').where({ id: revisionId }).first()).toEqual(revisionAfterActivation)
      expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual(stateAfterActivation)
      expect(await knex('settings').where({ key: 'logoUrl' }).first('value')).toEqual(settingAfterActivation)
      expect(await knex('durableJobs').where({ id: crashedJob.id }).first('state', 'attempts')).toMatchObject({
        state: 'succeeded',
        attempts: 2
      })
    }
  )

  it('marks a safe processing failure without exposing candidate objects or disturbing complete active state', async () => {
    const activeOutput = artifacts('active')
    const activeHash = await insertSource(Buffer.concat([PNG_SIGNATURE, Buffer.from('active-source')]))
    await insertDerivedObjects(activeOutput)
    const activeId = await insertRevision({ hash: activeHash, status: 'ready', outputs: activeOutput })
    const activeUrl = `/_site-logo/${digest(activeOutput.logoPng)}/logo.png`
    await knex('siteLogoState').where({ id: 1 }).update({ generation: 3, activeRevisionId: activeId, desiredRevisionId: activeId })
    await knex('settings').insert({ key: 'logoUrl', value: JSON.stringify({ v: activeUrl }), updatedAt: new Date().toISOString() })
    const { revisionId, job } = await enqueueCandidate()

    await run(job, async () => {
      throw new processingMocks.ProcessingError('UNSUITABLE_LOGO')
    })

    expect(
      await knex('siteLogoRevisions')
        .where({ id: revisionId })
        .first('status', 'errorCode', 'logoPngHash', 'particleV1Hash', 'effectStaticPngHash', 'completedAt', 'retiredAt')
    ).toMatchObject({
      status: 'failed',
      errorCode: 'UNSUITABLE_LOGO',
      logoPngHash: null,
      particleV1Hash: null,
      effectStaticPngHash: null,
      retiredAt: null
    })
    expect((await knex('siteLogoRevisions').where({ id: revisionId }).first('completedAt'))?.completedAt).not.toBeNull()
    expect(await knex('siteLogoObjects').whereNot({ kind: 'source' }).select('kind', 'sha256').orderBy('kind')).toEqual([
      { kind: 'effect-static-png', sha256: digest(activeOutput.effectStaticPng) },
      { kind: 'logo-png', sha256: digest(activeOutput.logoPng) },
      { kind: 'particle-v1', sha256: digest(activeOutput.particleV1) }
    ])
    expect(await knex('siteLogoRevisions').where({ id: activeId }).first('status', 'retiredAt')).toEqual({
      status: 'ready',
      retiredAt: null
    })
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId', 'generation')).toEqual({
      activeRevisionId: activeId,
      desiredRevisionId: revisionId,
      generation: 3
    })
    expect(await knex('settings').where({ key: 'logoUrl' }).first('value')).toEqual({
      value: JSON.stringify({ v: activeUrl })
    })
  })
})

describe('managed site logo retention cleanup', () => {
  it('deletes only 37-day unreachable revisions and objects while retaining active and desired data', async () => {
    const old = new Date(Date.now() - 38 * 24 * 60 * 60 * 1_000)
    const activeOutput = artifacts('active-retained')
    const activeHash = await insertSource(Buffer.concat([PNG_SIGNATURE, Buffer.from('active-retained-source')]))
    await insertDerivedObjects(activeOutput)
    const activeId = await insertRevision({ hash: activeHash, status: 'ready', outputs: activeOutput })

    const retiredOutput = artifacts('retired-delete')
    const retiredHash = await insertSource(Buffer.concat([PNG_SIGNATURE, Buffer.from('retired-source')]))
    await insertDerivedObjects(retiredOutput)
    const retiredId = await insertRevision({ hash: retiredHash, status: 'ready', outputs: retiredOutput, completedAt: old, retiredAt: old })

    const failedHash = await insertSource(Buffer.concat([PNG_SIGNATURE, Buffer.from('failed-desired-source')]))
    const failedId = await insertRevision({ hash: failedHash, status: 'failed', completedAt: old })
    await knex('siteLogoState').where({ id: 1 }).update({ activeRevisionId: activeId, desiredRevisionId: failedId })

    const store = new DurableJobStore(knex)
    await store.enqueue({ type: 'cleanup-site-logo', version: 1, payload: {} })
    const [job] = await store.claim({ workerId: 'cleanup-worker', leaseMs: 60_000 })
    if (!job) throw new Error('Site logo cleanup test job was not claimed')
    await cleanupSiteLogoRevisions(job, { knex, signal: new AbortController().signal })

    expect(await knex('siteLogoRevisions').whereIn('id', [retiredId, failedId])).toHaveLength(0)
    expect(await knex('siteLogoObjects').whereIn('sha256', [retiredHash, failedHash])).toHaveLength(0)
    expect(await knex('siteLogoRevisions').where({ id: activeId })).toHaveLength(1)
    expect(await knex('siteLogoObjects').where({ kind: 'logo-png', sha256: digest(activeOutput.logoPng) })).toHaveLength(1)
    expect(await knex('siteLogoState').where({ id: 1 }).first('activeRevisionId', 'desiredRevisionId')).toEqual({
      activeRevisionId: activeId,
      desiredRevisionId: null
    })
  })
})
