import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { Knex } from 'knex'

import type { DurableJob, DurableJobHandler } from '../core/durable-jobs.ts'
import {
  parseParticleV1,
  processSiteLogoSource,
  SITE_LOGO_PARTICLE_GZIP_BYTE_LIMIT,
  SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT,
  SITE_LOGO_PIPELINE_VERSION,
  SITE_LOGO_PNG_BYTE_LIMIT,
  SITE_LOGO_SOURCE_BYTE_LIMIT,
  SITE_LOGO_STATIC_PNG_BYTE_LIMIT,
  SiteLogoProcessingError,
  type SiteLogoArtifacts,
  type SiteLogoProcessingErrorCode
} from '../helpers/site-logo-processing.ts'

const RETENTION_MS = 37 * 24 * 60 * 60 * 1_000
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const AURA_COLOR_PATTERN = /^#[0-9a-f]{6}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const SAFE_ERROR_CODES: Readonly<Record<SiteLogoProcessingErrorCode, true>> = {
  UNSUPPORTED_IMAGE: true,
  IMAGE_TOO_LARGE: true,
  INVALID_IMAGE: true,
  NO_VISIBLE_PIXELS: true,
  UNSUITABLE_LOGO: true,
  PROCESSING_FAILED: true,
  ARTIFACT_TOO_LARGE: true
}

type ObjectKind = 'source' | 'logo-png' | 'particle-v1' | 'effect-static-png'
type SafeErrorCode = SiteLogoProcessingErrorCode

interface DurableJobRow {
  id: string
  type: string
  version: number
  payload: string
  state: string
  attempts: number
  maxAttempts: number
  leaseOwner: string | null
  leaseToken: string | null
  leaseExpiresAt: Date | string | number | null
  lastError: string | null
  updatedAt: Date | string | number
  completedAt: Date | string | number | null
}

interface RevisionRow {
  id: string
  sourceKind: 'source'
  sourceHash: string
  pipelineVersion: number
  status: 'pending' | 'running' | 'ready' | 'failed'
  jobId: string | null
  retrySequence: number
  logoPngKind: 'logo-png' | null
  logoPngHash: string | null
  particleV1Kind: 'particle-v1' | null
  particleV1Hash: string | null
  effectStaticPngKind: 'effect-static-png' | null
  effectStaticPngHash: string | null
  normalizedWidth: number | null
  normalizedHeight: number | null
  particleCount: number | null
  medianStroke: number | null
  auraColor: string | null
  requestedBy: number | null
  createdAt: Date | string
  updatedAt: Date | string
  errorCode: string | null
  startedAt: Date | string | null
  completedAt: Date | string | null
  retiredAt: Date | string | null
}

interface StateRow {
  id: number
  generation: number
  desiredRevisionId: string | null
  activeRevisionId: string | null
  createdAt: Date | string
  updatedAt: Date | string
}

interface ObjectRow {
  kind: ObjectKind
  sha256: string
  bytes: Buffer | Uint8Array
  byteLength: number | string
  contentType: string
  createdAt: Date | string
}

interface ProcessPayload {
  revisionId: string
  retrySequence: number
}
interface ValidatedArtifacts {
  logoPng: Buffer
  particleV1: Buffer
  effectStaticPng: Buffer
}

interface ArtifactObject extends ObjectRow {
  createdAt: Date
}

interface ParsedParticleMetadata {
  width: number
  height: number
  count: number
}

export type SiteLogoProcessor = (bytes: Buffer | Uint8Array, sourceHash: string) => Promise<SiteLogoArtifacts>

class SiteLogoJobError extends Error {
  readonly code: SafeErrorCode

  constructor(code: SafeErrorCode, message: string) {
    super(message)
    this.name = 'SiteLogoJobError'
    this.code = code
  }
}

class SiteLogoLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Site logo durable job ${jobId} no longer owns an unexpired lease`)
    this.name = 'SiteLogoLeaseLostError'
  }
}

let processingTail: Promise<void> = Promise.resolve()

const serializeProcessing = async <T>(task: () => Promise<T>): Promise<T> => {
  const previous = processingTail
  let release!: () => void
  processingTail = new Promise<void>(resolve => {
    release = resolve
  })
  await previous
  try {
    return await task()
  } finally {
    release()
  }
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const asBuffer = (bytes: Buffer | Uint8Array): Buffer => (Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
const asDate = (value: Date | string | number | null): Date | null => (value === null ? null : value instanceof Date ? value : new Date(value))
const publicLogoUrl = (hash: string): string => `/_site-logo/${hash}/logo.png`

const parsePayload = (job: DurableJob): ProcessPayload => {
  const revisionId = job.payload.revisionId
  const retrySequence = job.payload.retrySequence
  if (typeof revisionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(revisionId) || !Number.isSafeInteger(retrySequence) || Number(retrySequence) < 0) {
    throw new TypeError('Site logo processing job payload is invalid')
  }
  return { revisionId, retrySequence: Number(retrySequence) }
}

const storedPayloadMatches = (row: DurableJobRow, payload: ProcessPayload): boolean => {
  try {
    const stored: unknown = JSON.parse(row.payload)
    return (
      stored !== null &&
      typeof stored === 'object' &&
      !Array.isArray(stored) &&
      (stored as Record<string, unknown>).revisionId === payload.revisionId &&
      (stored as Record<string, unknown>).retrySequence === payload.retrySequence
    )
  } catch {
    return false
  }
}

const ownsCurrentLease = (row: DurableJobRow | undefined, job: DurableJob, payload: ProcessPayload, now: Date): boolean => {
  const expiresAt = row ? asDate(row.leaseExpiresAt) : null
  return (
    row !== undefined &&
    row.id === job.id &&
    row.type === 'process-site-logo' &&
    Number(row.version) === 1 &&
    row.state === 'running' &&
    row.leaseOwner !== null &&
    row.leaseOwner === job.leaseOwner &&
    row.leaseToken !== null &&
    row.leaseToken === job.leaseToken &&
    expiresAt !== null &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.getTime() > now.getTime() &&
    storedPayloadMatches(row, payload)
  )
}

const lockJob = async (transaction: Knex.Transaction, jobId: string): Promise<DurableJobRow | undefined> =>
  await transaction<DurableJobRow>('durableJobs').where({ id: jobId }).forUpdate().first()

const lockState = async (transaction: Knex.Transaction): Promise<StateRow> => {
  const state = await transaction<StateRow>('siteLogoState').where({ id: 1 }).forUpdate().first()
  if (!state) throw new Error('Site logo singleton state is missing')
  return state
}

const EXHAUSTED_SITE_LOGO_ERROR = 'Durable job lease expired after its final allowed attempt'
const UPGRADABLE_SITE_LOGO_PIPELINE_VERSION = 1

const exhaustedProcessPayload = (row: DurableJobRow): ProcessPayload | null => {
  try {
    const payload: unknown = JSON.parse(row.payload)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
    const revisionId = (payload as Record<string, unknown>).revisionId
    const retrySequence = (payload as Record<string, unknown>).retrySequence
    if (typeof revisionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(revisionId) || !Number.isSafeInteger(retrySequence) || Number(retrySequence) < 0) {
      return null
    }
    return { revisionId, retrySequence: Number(retrySequence) }
  } catch {
    return null
  }
}

export const failExhaustedSiteLogoJobs = async (knex: Knex, now = new Date()): Promise<number> =>
  await knex.transaction(async transaction => {
    const jobs = await transaction<DurableJobRow>('durableJobs')
      .where({ type: 'process-site-logo', version: 1, state: 'running' })
      .where('leaseExpiresAt', '<=', now)
      .whereRaw('?? >= ??', ['attempts', 'maxAttempts'])
      .orderBy('id', 'asc')
      .forUpdate()
    if (jobs.length === 0) return 0

    const state = await lockState(transaction)
    for (const job of jobs) {
      const updated = await transaction<DurableJobRow>('durableJobs')
        .where({
          id: job.id,
          type: job.type,
          version: job.version,
          state: 'running',
          leaseOwner: job.leaseOwner,
          leaseToken: job.leaseToken
        })
        .where('leaseExpiresAt', '<=', now)
        .whereRaw('?? >= ??', ['attempts', 'maxAttempts'])
        .update({
          state: 'failed',
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: EXHAUSTED_SITE_LOGO_ERROR,
          completedAt: now,
          updatedAt: now
        })
      if (updated !== 1) throw new Error(`Exhausted site logo durable job ${job.id} lost its fence`)

      const payload = exhaustedProcessPayload(job)
      if (!payload) continue
      await transaction<RevisionRow>('siteLogoRevisions')
        .where({
          id: payload.revisionId,
          jobId: job.id,
          retrySequence: payload.retrySequence
        })
        .whereIn('pipelineVersion', [UPGRADABLE_SITE_LOGO_PIPELINE_VERSION, SITE_LOGO_PIPELINE_VERSION])
        .whereIn('status', ['pending', 'running'])
        .update({
          status: 'failed',
          errorCode: 'PROCESSING_FAILED',
          completedAt: now,
          retiredAt: state.desiredRevisionId === payload.revisionId ? null : now,
          updatedAt: now
        })
    }
    return jobs.length
  })

const transitionToRunning = async (knex: Knex, job: DurableJob, payload: ProcessPayload): Promise<RevisionRow | null> =>
  await knex.transaction(async transaction => {
    const now = new Date()
    const durable = await lockJob(transaction, job.id)
    if (!ownsCurrentLease(durable, job, payload, now)) throw new SiteLogoLeaseLostError(job.id)
    let revision = await transaction<RevisionRow>('siteLogoRevisions').where({ id: payload.revisionId }).forUpdate().first()
    if (!revision || revision.jobId !== job.id || Number(revision.retrySequence) !== payload.retrySequence) {
      throw new TypeError('Site logo processing job does not match its revision')
    }
    if (revision.status === 'ready' || revision.status === 'failed') return null
    const storedPipelineVersion = Number(revision.pipelineVersion)
    if (storedPipelineVersion === UPGRADABLE_SITE_LOGO_PIPELINE_VERSION && SITE_LOGO_PIPELINE_VERSION === 2) {
      await transaction<RevisionRow>('siteLogoRevisions').where({ id: revision.id }).update({
        pipelineVersion: SITE_LOGO_PIPELINE_VERSION,
        updatedAt: now
      })
      revision = { ...revision, pipelineVersion: SITE_LOGO_PIPELINE_VERSION, updatedAt: now }
    } else if (storedPipelineVersion !== SITE_LOGO_PIPELINE_VERSION) {
      throw new TypeError('Site logo processing job does not match its revision')
    }
    if (revision.status === 'pending') {
      await transaction<RevisionRow>('siteLogoRevisions').where({ id: revision.id }).update({
        status: 'running',
        startedAt: now,
        updatedAt: now
      })
      return { ...revision, status: 'running' as const, startedAt: now, updatedAt: now }
    }
    return revision
  })

const readVerifiedSource = async (knex: Knex, revision: RevisionRow): Promise<Buffer> => {
  if (revision.sourceKind !== 'source' || !SHA256_PATTERN.test(revision.sourceHash)) {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo revision has an invalid source identity')
  }
  const source = await knex<ObjectRow>('siteLogoObjects').where({ kind: 'source', sha256: revision.sourceHash }).first()
  if (!source || (!Buffer.isBuffer(source.bytes) && !(source.bytes instanceof Uint8Array))) {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo source object is unavailable')
  }
  const bytes = asBuffer(source.bytes)
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > SITE_LOGO_SOURCE_BYTE_LIMIT ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(source.contentType) ||
    Number(source.byteLength) !== bytes.byteLength ||
    digest(bytes) !== revision.sourceHash
  ) {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo source object failed its integrity check')
  }
  return bytes
}

const validateArtifacts = (artifacts: SiteLogoArtifacts): ValidatedArtifacts => {
  const logoPng = asBuffer(artifacts.logoPng)
  const particleV1 = asBuffer(artifacts.particleV1)
  const effectStaticPng = asBuffer(artifacts.effectStaticPng)
  if (
    logoPng.byteLength === 0 ||
    particleV1.byteLength === 0 ||
    effectStaticPng.byteLength === 0 ||
    !logoPng.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE) ||
    !effectStaticPng.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)
  ) {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo processor returned invalid artifacts')
  }
  if (
    logoPng.byteLength > SITE_LOGO_PNG_BYTE_LIMIT ||
    effectStaticPng.byteLength > SITE_LOGO_STATIC_PNG_BYTE_LIMIT ||
    particleV1.byteLength > SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT ||
    gzipSync(particleV1, { level: 9 }).byteLength > SITE_LOGO_PARTICLE_GZIP_BYTE_LIMIT
  ) {
    throw new SiteLogoJobError('ARTIFACT_TOO_LARGE', 'Site logo processor artifacts exceed publication limits')
  }
  if (
    !Number.isSafeInteger(artifacts.normalizedWidth) ||
    artifacts.normalizedWidth < 2 ||
    artifacts.normalizedWidth > 4096 ||
    !Number.isSafeInteger(artifacts.normalizedHeight) ||
    artifacts.normalizedHeight < 2 ||
    artifacts.normalizedHeight > 4096 ||
    !Number.isSafeInteger(artifacts.particleCount) ||
    artifacts.particleCount < 1 ||
    artifacts.particleCount > 16_000 ||
    !Number.isFinite(artifacts.medianStroke) ||
    artifacts.medianStroke <= 0 ||
    (artifacts.auraColor !== undefined && !AURA_COLOR_PATTERN.test(artifacts.auraColor))
  ) {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo processor returned invalid metadata')
  }
  let parsed: ParsedParticleMetadata
  try {
    parsed = parseParticleV1(particleV1)
  } catch {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo processor returned an invalid particle artifact')
  }
  if (parsed.width !== artifacts.normalizedWidth || parsed.height !== artifacts.normalizedHeight || parsed.count !== artifacts.particleCount) {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo particle artifact does not match its revision metadata')
  }
  return { logoPng, particleV1, effectStaticPng }
}

const safeFailureCode = (error: unknown): SafeErrorCode => {
  if (error instanceof SiteLogoJobError) return error.code
  if (error instanceof SiteLogoProcessingError && SAFE_ERROR_CODES[error.code]) return error.code as SafeErrorCode
  return 'PROCESSING_FAILED'
}
const logProcessingFailure = (job: DurableJob, payload: ProcessPayload, error: unknown): void => {
  if (typeof WIKI === 'undefined') return
  const runtime = WIKI as unknown as { logger?: { error: (entry: unknown) => void } }
  runtime.logger?.error({
    message: 'Site logo processing failed',
    jobId: job.id,
    revisionId: payload.revisionId,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error)
  })
}

const markFailed = async (knex: Knex, job: DurableJob, payload: ProcessPayload, code: SafeErrorCode): Promise<void> => {
  await knex.transaction(async transaction => {
    const now = new Date()
    const durable = await lockJob(transaction, job.id)
    if (!ownsCurrentLease(durable, job, payload, now)) throw new SiteLogoLeaseLostError(job.id)
    const state = await lockState(transaction)
    const revision = await transaction<RevisionRow>('siteLogoRevisions').where({ id: payload.revisionId }).forUpdate().first()
    if (!revision || revision.jobId !== job.id || Number(revision.retrySequence) !== payload.retrySequence) {
      throw new TypeError('Site logo processing job does not match its revision')
    }
    if (revision.status === 'ready' || revision.status === 'failed') return
    if (revision.status !== 'running') throw new TypeError('Site logo revision is not running')
    await transaction<RevisionRow>('siteLogoRevisions')
      .where({ id: revision.id })
      .update({
        status: 'failed',
        errorCode: code,
        completedAt: now,
        retiredAt: state.desiredRevisionId === revision.id ? null : now,
        updatedAt: now
      })
  })
}

const artifactIdentity = (kind: Exclude<ObjectKind, 'source'>, bytes: Buffer, contentType: string, now: Date): ArtifactObject => ({
  kind,
  sha256: digest(bytes),
  bytes,
  byteLength: bytes.byteLength,
  contentType,
  createdAt: now
})

const ensureImmutableObject = async (transaction: Knex.Transaction, object: ArtifactObject): Promise<void> => {
  const stored = await transaction<ObjectRow>('siteLogoObjects').where({ kind: object.kind, sha256: object.sha256 }).forUpdate().first()
  if (!stored) {
    await transaction('siteLogoObjects').insert(object)
    return
  }
  const bytes = asBuffer(stored.bytes)
  if (
    stored.kind === object.kind &&
    stored.sha256 === object.sha256 &&
    Number(stored.byteLength) === bytes.byteLength &&
    stored.contentType === object.contentType &&
    digest(bytes) === object.sha256 &&
    bytes.equals(object.bytes)
  )
    return
  const reference = objectReference(object.kind)
  await transaction<RevisionRow>('siteLogoRevisions')
    .where({ [reference.kindColumn]: object.kind, [reference.hashColumn]: object.sha256 })
    .forUpdate()

  await transaction('siteLogoObjects').where({ kind: object.kind, sha256: object.sha256 }).update({
    bytes: object.bytes,
    byteLength: object.byteLength,
    contentType: object.contentType
  })
}

const persistManagedLogoUrl = async (transaction: Knex.Transaction, logoUrl: string, now: Date): Promise<void> => {
  const value = JSON.stringify({ v: logoUrl })
  const updated = await transaction('settings').where({ key: 'logoUrl' }).update({ value, updatedAt: now.toISOString() })
  if (updated === 0) await transaction('settings').insert({ key: 'logoUrl', value, updatedAt: now.toISOString() })
}

const publishArtifacts = async (
  knex: Knex,
  job: DurableJob,
  payload: ProcessPayload,
  artifacts: SiteLogoArtifacts,
  validated: ValidatedArtifacts
): Promise<void> => {
  await knex.transaction(async transaction => {
    const now = new Date()
    const durable = await lockJob(transaction, job.id)
    if (!ownsCurrentLease(durable, job, payload, now)) throw new SiteLogoLeaseLostError(job.id)
    const state = await lockState(transaction)
    const revision = await transaction<RevisionRow>('siteLogoRevisions').where({ id: payload.revisionId }).forUpdate().first()
    if (
      !revision ||
      revision.jobId !== job.id ||
      Number(revision.retrySequence) !== payload.retrySequence ||
      Number(revision.pipelineVersion) !== SITE_LOGO_PIPELINE_VERSION
    ) {
      throw new TypeError('Site logo processing job does not match its revision')
    }
    if (revision.status === 'ready' || revision.status === 'failed') return
    if (revision.status !== 'running') throw new TypeError('Site logo revision is not running')

    const logo = artifactIdentity('logo-png', validated.logoPng, 'image/png', now)
    const particle = artifactIdentity('particle-v1', validated.particleV1, 'application/octet-stream', now)
    const effect = artifactIdentity('effect-static-png', validated.effectStaticPng, 'image/png', now)
    await ensureImmutableObject(transaction, logo)
    await ensureImmutableObject(transaction, particle)
    await ensureImmutableObject(transaction, effect)

    const isDesired = state.desiredRevisionId === revision.id
    await transaction<RevisionRow>('siteLogoRevisions')
      .where({ id: revision.id })
      .update({
        status: 'ready',
        logoPngKind: 'logo-png',
        logoPngHash: logo.sha256,
        particleV1Kind: 'particle-v1',
        particleV1Hash: particle.sha256,
        effectStaticPngKind: 'effect-static-png',
        effectStaticPngHash: effect.sha256,
        normalizedWidth: artifacts.normalizedWidth,
        normalizedHeight: artifacts.normalizedHeight,
        particleCount: artifacts.particleCount,
        medianStroke: artifacts.medianStroke,
        auraColor: artifacts.auraColor ?? null,
        errorCode: null,
        completedAt: now,
        retiredAt: isDesired ? null : now,
        updatedAt: now
      })

    if (!isDesired) return
    if (state.activeRevisionId && state.activeRevisionId !== revision.id) {
      await transaction<RevisionRow>('siteLogoRevisions')
        .where({ id: state.activeRevisionId, status: 'ready' })
        .whereNull('retiredAt')
        .update({ retiredAt: now, updatedAt: now })
    }
    await persistManagedLogoUrl(transaction, publicLogoUrl(logo.sha256), now)
    await transaction<StateRow>('siteLogoState')
      .where({ id: 1 })
      .update({
        generation: Number(state.generation) + 1,
        activeRevisionId: revision.id,
        updatedAt: now
      })
  })
}

export const createSiteLogoProcessHandler =
  (processor: SiteLogoProcessor = processSiteLogoSource): DurableJobHandler =>
  async (job, { knex, signal }) => {
    const payload = parsePayload(job)
    const revision = await transitionToRunning(knex, job, payload)
    if (!revision) return

    let artifacts: SiteLogoArtifacts
    let validated: ValidatedArtifacts
    try {
      const source = await readVerifiedSource(knex, revision)
      signal.throwIfAborted()
      artifacts = await serializeProcessing(async () => {
        signal.throwIfAborted()
        return await processor(source, revision.sourceHash)
      })
      signal.throwIfAborted()
      validated = validateArtifacts(artifacts)
    } catch (error) {
      signal.throwIfAborted()
      logProcessingFailure(job, payload, error)
      await markFailed(knex, job, payload, safeFailureCode(error))
      return
    }

    signal.throwIfAborted()
    await publishArtifacts(knex, job, payload, artifacts, validated)
  }

const objectReference = (kind: ObjectKind): { kindColumn: keyof RevisionRow; hashColumn: keyof RevisionRow } => {
  switch (kind) {
    case 'source':
      return { kindColumn: 'sourceKind', hashColumn: 'sourceHash' }
    case 'logo-png':
      return { kindColumn: 'logoPngKind', hashColumn: 'logoPngHash' }
    case 'particle-v1':
      return { kindColumn: 'particleV1Kind', hashColumn: 'particleV1Hash' }
    case 'effect-static-png':
      return { kindColumn: 'effectStaticPngKind', hashColumn: 'effectStaticPngHash' }
  }
}

export const cleanupSiteLogoRevisions: DurableJobHandler = async (_job, { knex, signal }) => {
  signal.throwIfAborted()
  await knex.transaction(async transaction => {
    const now = new Date()
    const cutoff = new Date(now.getTime() - RETENTION_MS)
    const state = await lockState(transaction)

    const retired = await transaction<RevisionRow>('siteLogoRevisions')
      .whereIn('status', ['ready', 'failed'])
      .whereNotNull('retiredAt')
      .where('retiredAt', '<=', cutoff)
      .whereNot({ id: state.activeRevisionId ?? '' })
      .whereNot({ id: state.desiredRevisionId ?? '' })
      .forUpdate()

    let expiredDesired: RevisionRow | undefined
    if (state.desiredRevisionId && state.desiredRevisionId !== state.activeRevisionId) {
      expiredDesired = await transaction<RevisionRow>('siteLogoRevisions')
        .where({ id: state.desiredRevisionId, status: 'failed' })
        .where('completedAt', '<=', cutoff)
        .forUpdate()
        .first()
    }

    const revisions = expiredDesired ? [...retired, expiredDesired] : retired
    if (revisions.length === 0) return
    if (expiredDesired) {
      await transaction<StateRow>('siteLogoState')
        .where({ id: 1, desiredRevisionId: expiredDesired.id })
        .update({
          generation: Number(state.generation) + 1,
          desiredRevisionId: null,
          updatedAt: now
        })
    }

    const identities = new Map<string, { kind: ObjectKind; hash: string }>()
    for (const revision of revisions) {
      identities.set(`source:${revision.sourceHash}`, { kind: 'source', hash: revision.sourceHash })
      if (revision.logoPngKind && revision.logoPngHash) identities.set(`logo-png:${revision.logoPngHash}`, { kind: 'logo-png', hash: revision.logoPngHash })
      if (revision.particleV1Kind && revision.particleV1Hash)
        identities.set(`particle-v1:${revision.particleV1Hash}`, { kind: 'particle-v1', hash: revision.particleV1Hash })
      if (revision.effectStaticPngKind && revision.effectStaticPngHash)
        identities.set(`effect-static-png:${revision.effectStaticPngHash}`, { kind: 'effect-static-png', hash: revision.effectStaticPngHash })
    }
    await transaction<RevisionRow>('siteLogoRevisions')
      .whereIn(
        'id',
        revisions.map(revision => revision.id)
      )
      .delete()

    for (const { kind, hash } of identities.values()) {
      const reference = objectReference(kind)
      const reachable = await transaction<RevisionRow>('siteLogoRevisions')
        .where({ [reference.kindColumn]: kind, [reference.hashColumn]: hash })
        .first('id')
      if (!reachable) await transaction<ObjectRow>('siteLogoObjects').where({ kind, sha256: hash }).delete()
    }
  })
}
