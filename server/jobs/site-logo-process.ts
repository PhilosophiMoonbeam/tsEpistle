import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { Knex } from 'knex'

import type { DurableJob, DurableJobHandler } from '../core/durable-jobs.ts'
import { parseParticleV1, processSiteLogoSource, SiteLogoProcessingError, type SiteLogoArtifacts } from '../helpers/site-logo-processing.ts'
import {
  SITE_LOGO_FAVICON_ICO_BYTE_LIMIT,
  SITE_LOGO_ICON_PNG_BYTE_LIMIT,
  SITE_LOGO_ICON_SIZES,
  SITE_LOGO_JOB_VERSION,
  SITE_LOGO_MAX_INPUT_DIMENSION,
  SITE_LOGO_MAX_INPUT_PIXELS,
  SITE_LOGO_MIN_INPUT_DIMENSION,
  SITE_LOGO_PARTICLE_GZIP_BYTE_LIMIT,
  SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT,
  SITE_LOGO_PIPELINE_VERSION,
  SITE_LOGO_PNG_BYTE_LIMIT,
  SITE_LOGO_SOURCE_BYTE_LIMIT,
  SITE_LOGO_STATIC_PNG_BYTE_LIMIT,
  type SiteLogoEnhancementUnavailableReason,
  type SiteLogoErrorCode
} from '../../shared/site-logo.ts'

const RETENTION_MS = 37 * 24 * 60 * 60 * 1_000
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const AURA_COLOR_PATTERN = /^#[0-9a-f]{6}$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICO_HEADER_BYTES = 6
const ICO_ENTRY_BYTES = 16
const SAFE_ERROR_CODES: Readonly<Record<SiteLogoErrorCode, true>> = {
  UNSUPPORTED_IMAGE: true,
  IMAGE_TOO_LARGE: true,
  INVALID_IMAGE: true,
  NO_VISIBLE_PIXELS: true,
  UNSUITABLE_LOGO: true,
  PROCESSING_FAILED: true,
  ARTIFACT_TOO_LARGE: true
}

type IconName = keyof SiteLogoArtifacts['icons']
const ICON_NAMES = Object.keys(SITE_LOGO_ICON_SIZES) as readonly IconName[]
type ObjectKind = 'source' | 'logo-png' | 'icon-png' | 'favicon-ico' | 'particle-v1' | 'effect-static-png'
type SafeErrorCode = SiteLogoErrorCode
type Enhancement = SiteLogoArtifacts['enhancement']
type ReadyEnhancement = Extract<Enhancement, { status: 'ready' }>

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

interface ExhaustedJobCandidate extends DurableJobRow {
  revisionId: string
  revisionRetrySequence: number
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
  iconPngKind: 'icon-png' | null
  favicon16Hash: string | null
  favicon32Hash: string | null
  tile150Hash: string | null
  apple180Hash: string | null
  app192Hash: string | null
  app512Hash: string | null
  maskable512Hash: string | null
  faviconIcoKind: 'favicon-ico' | null
  faviconIcoHash: string | null
  particleV1Kind: 'particle-v1' | null
  particleV1Hash: string | null
  effectStaticPngKind: 'effect-static-png' | null
  effectStaticPngHash: string | null
  normalizedWidth: number | null
  normalizedHeight: number | null
  particleCount: number | null
  medianStroke: number | null
  auraColor: string | null
  enhancementErrorCode: SiteLogoEnhancementUnavailableReason | null
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
  expectedActiveRevisionId?: string
}

type SiteLogoJobVersion = 1 | 2 | 3 | 4 | 5

interface SiteLogoJobProtocol {
  readonly jobVersion: SiteLogoJobVersion
  readonly pipelineVersions: readonly number[]
}

interface ValidatedArtifacts {
  logoPng: Buffer
  logoWidth: number
  logoHeight: number
  icons: Record<IconName, Buffer>
  faviconIco: Buffer
  enhancement: Enhancement
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

const REVISION_ID_PATTERN = /^[0-9a-f-]{36}$/i
const STRICT_REVISION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const parsePayloadValue = (value: unknown): ProcessPayload => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Site logo processing job payload is invalid')
  const payload = value as Record<string, unknown>
  const revisionId = payload.revisionId
  const retrySequence = payload.retrySequence
  const expectedActiveRevisionId = payload.expectedActiveRevisionId
  if (
    typeof revisionId !== 'string' ||
    !REVISION_ID_PATTERN.test(revisionId) ||
    !Number.isSafeInteger(retrySequence) ||
    Number(retrySequence) < 0 ||
    (expectedActiveRevisionId !== undefined && (typeof expectedActiveRevisionId !== 'string' || !STRICT_REVISION_ID_PATTERN.test(expectedActiveRevisionId)))
  ) {
    throw new TypeError('Site logo processing job payload is invalid')
  }
  const parsedRetrySequence = Number(retrySequence)
  if (expectedActiveRevisionId === undefined) return { revisionId, retrySequence: parsedRetrySequence }
  return { revisionId, retrySequence: parsedRetrySequence, expectedActiveRevisionId }
}

const storedPayloadMatches = (row: DurableJobRow, payload: ProcessPayload): boolean => {
  try {
    const stored: unknown = JSON.parse(row.payload)
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return false
    const storedPayload = stored as Record<string, unknown>
    return (
      storedPayload.revisionId === payload.revisionId &&
      storedPayload.retrySequence === payload.retrySequence &&
      storedPayload.expectedActiveRevisionId === payload.expectedActiveRevisionId
    )
  } catch {
    return false
  }
}

const ownsCurrentLease = (row: DurableJobRow | undefined, job: DurableJob, payload: ProcessPayload, protocol: SiteLogoJobProtocol, now: Date): boolean => {
  const expiresAt = row ? asDate(row.leaseExpiresAt) : null
  return (
    row !== undefined &&
    row.id === job.id &&
    job.type === 'process-site-logo' &&
    Number(job.version) === protocol.jobVersion &&
    row.type === 'process-site-logo' &&
    Number(row.version) === protocol.jobVersion &&
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

const lockJob = async (transaction: Knex.Transaction, jobId: string, protocol: SiteLogoJobProtocol): Promise<DurableJobRow | undefined> =>
  await transaction<DurableJobRow>('durableJobs').where({ id: jobId, type: 'process-site-logo', version: protocol.jobVersion }).forUpdate().first()

const lockState = async (transaction: Knex.Transaction): Promise<StateRow> => {
  const state = await transaction<StateRow>('siteLogoState').where({ id: 1 }).forUpdate().first()
  if (!state) throw new Error('Site logo singleton state is missing')
  return state
}

const EXHAUSTED_SITE_LOGO_ERROR = 'Durable job lease expired after its final allowed attempt'
const LEGACY_SITE_LOGO_PROTOCOL: SiteLogoJobProtocol = Object.freeze({ jobVersion: 1, pipelineVersions: Object.freeze([1, 2, 3]) })
const PIPELINE_V4_SITE_LOGO_PROTOCOL: SiteLogoJobProtocol = Object.freeze({ jobVersion: 2, pipelineVersions: Object.freeze([4]) })
const PIPELINE_V5_SITE_LOGO_PROTOCOL: SiteLogoJobProtocol = Object.freeze({ jobVersion: 3, pipelineVersions: Object.freeze([5]) })
const PIPELINE_V6_SITE_LOGO_PROTOCOL: SiteLogoJobProtocol = Object.freeze({ jobVersion: 4, pipelineVersions: Object.freeze([6]) })
const CURRENT_SITE_LOGO_PROTOCOL: SiteLogoJobProtocol = Object.freeze({
  jobVersion: SITE_LOGO_JOB_VERSION,
  pipelineVersions: Object.freeze([SITE_LOGO_PIPELINE_VERSION])
})

const protocolForJobVersion = (jobVersion: number): SiteLogoJobProtocol | undefined => {
  switch (jobVersion) {
    case LEGACY_SITE_LOGO_PROTOCOL.jobVersion:
      return LEGACY_SITE_LOGO_PROTOCOL
    case PIPELINE_V4_SITE_LOGO_PROTOCOL.jobVersion:
      return PIPELINE_V4_SITE_LOGO_PROTOCOL
    case PIPELINE_V5_SITE_LOGO_PROTOCOL.jobVersion:
      return PIPELINE_V5_SITE_LOGO_PROTOCOL
    case PIPELINE_V6_SITE_LOGO_PROTOCOL.jobVersion:
      return PIPELINE_V6_SITE_LOGO_PROTOCOL
    case CURRENT_SITE_LOGO_PROTOCOL.jobVersion:
      return CURRENT_SITE_LOGO_PROTOCOL
    default:
      return undefined
  }
}

const protocolSupportsPipeline = (protocol: SiteLogoJobProtocol, pipelineVersion: number): boolean => protocol.pipelineVersions.includes(pipelineVersion)

export const failExhaustedSiteLogoJobs = async (knex: Knex, now = new Date()): Promise<number> =>
  await knex.transaction(async transaction => {
    const jobs = (await transaction('durableJobs as job')
      .join('siteLogoRevisions as revision', 'revision.jobId', 'job.id')
      .select('job.*', 'revision.id as revisionId', 'revision.retrySequence as revisionRetrySequence')
      .where('job.type', 'process-site-logo')
      .andWhere(protocols => {
        protocols
          .where(legacy =>
            legacy.where('job.version', LEGACY_SITE_LOGO_PROTOCOL.jobVersion).whereIn('revision.pipelineVersion', LEGACY_SITE_LOGO_PROTOCOL.pipelineVersions)
          )
          .orWhere(v4 =>
            v4
              .where('job.version', PIPELINE_V4_SITE_LOGO_PROTOCOL.jobVersion)
              .whereIn('revision.pipelineVersion', PIPELINE_V4_SITE_LOGO_PROTOCOL.pipelineVersions)
          )
          .orWhere(v5 =>
            v5
              .where('job.version', PIPELINE_V5_SITE_LOGO_PROTOCOL.jobVersion)
              .whereIn('revision.pipelineVersion', PIPELINE_V5_SITE_LOGO_PROTOCOL.pipelineVersions)
          )
          .orWhere(v6 =>
            v6
              .where('job.version', PIPELINE_V6_SITE_LOGO_PROTOCOL.jobVersion)
              .whereIn('revision.pipelineVersion', PIPELINE_V6_SITE_LOGO_PROTOCOL.pipelineVersions)
          )
          .orWhere(current =>
            current.where('job.version', CURRENT_SITE_LOGO_PROTOCOL.jobVersion).whereIn('revision.pipelineVersion', CURRENT_SITE_LOGO_PROTOCOL.pipelineVersions)
          )
      })
      .whereIn('revision.status', ['pending', 'running'])
      .whereRaw('?? >= ??', ['job.attempts', 'job.maxAttempts'])
      .andWhere(builder => {
        builder.where('job.state', 'failed').orWhere(running => {
          running.where('job.state', 'running').where('job.leaseExpiresAt', '<=', now)
        })
      })
      .orderBy('job.id', 'asc')
      .forUpdate('job')) as ExhaustedJobCandidate[]
    if (jobs.length === 0) return 0

    const state = await lockState(transaction)
    for (const job of jobs) {
      const protocol = protocolForJobVersion(Number(job.version))
      const pipelineVersion = Number(
        (
          await transaction<RevisionRow>('siteLogoRevisions')
            .where({ id: job.revisionId, jobId: job.id, retrySequence: Number(job.revisionRetrySequence) })
            .forUpdate()
            .first('pipelineVersion')
        )?.pipelineVersion
      )
      if (!protocol || !protocolSupportsPipeline(protocol, pipelineVersion)) {
        throw new Error(`Exhausted site logo revision ${job.revisionId} lost its protocol fence`)
      }
      let rawPayload: unknown
      try {
        rawPayload = JSON.parse(job.payload)
      } catch {
        throw new TypeError(`Exhausted site logo durable job ${job.id} has an invalid payload`)
      }
      const payload = parsePayloadValue(rawPayload)
      if (
        payload.revisionId !== job.revisionId ||
        payload.retrySequence !== Number(job.revisionRetrySequence) ||
        !storedPayloadMatches(job, payload) ||
        (payload.expectedActiveRevisionId !== undefined && protocol.jobVersion !== CURRENT_SITE_LOGO_PROTOCOL.jobVersion)
      )
        throw new TypeError(`Exhausted site logo durable job ${job.id} does not match its revision`)
      if (job.state === 'running') {
        const updated = await transaction<DurableJobRow>('durableJobs')
          .where({
            id: job.id,
            type: 'process-site-logo',
            version: protocol.jobVersion,
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
      }
      const updatedRevision = await transaction<RevisionRow>('siteLogoRevisions')
        .where({
          id: payload.revisionId,
          jobId: job.id,
          retrySequence: payload.retrySequence,
          pipelineVersion
        })
        .whereIn('status', ['pending', 'running'])
        .update({
          status: 'failed',
          errorCode: 'PROCESSING_FAILED',
          completedAt: now,
          retiredAt: state.desiredRevisionId === payload.revisionId ? null : now,
          updatedAt: now
        })
      if (updatedRevision !== 1) throw new Error(`Exhausted site logo revision ${job.revisionId} lost its fence`)
    }
    return jobs.length
  })

const transitionToRunning = async (knex: Knex, job: DurableJob, payload: ProcessPayload, protocol: SiteLogoJobProtocol): Promise<RevisionRow | null> =>
  await knex.transaction(async transaction => {
    const now = new Date()
    const durable = await lockJob(transaction, job.id, protocol)
    if (!ownsCurrentLease(durable, job, payload, protocol, now)) throw new SiteLogoLeaseLostError(job.id)
    const revision = await transaction<RevisionRow>('siteLogoRevisions').where({ id: payload.revisionId }).forUpdate().first()
    const pipelineVersion = Number(revision?.pipelineVersion)
    if (!revision || revision.jobId !== job.id || Number(revision.retrySequence) !== payload.retrySequence) {
      throw new TypeError('Site logo processing job does not match its revision')
    }
    if (revision.status === 'ready' || revision.status === 'failed') {
      if (protocolSupportsPipeline(protocol, pipelineVersion)) return null
      throw new TypeError('Site logo processing job does not match its revision')
    }
    if (!protocolSupportsPipeline(protocol, pipelineVersion)) {
      throw new TypeError('Site logo processing job does not match its revision')
    }
    if (revision.status === 'pending') {
      const updated = await transaction<RevisionRow>('siteLogoRevisions')
        .where({
          id: revision.id,
          jobId: job.id,
          retrySequence: payload.retrySequence,
          pipelineVersion,
          status: 'pending'
        })
        .update({
          status: 'running',
          startedAt: now,
          updatedAt: now
        })
      if (updated !== 1) throw new SiteLogoLeaseLostError(job.id)
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

const isPng = (bytes: Buffer): boolean => bytes.byteLength >= PNG_SIGNATURE.byteLength && bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)

const pngDimensions = (bytes: Buffer): { width: number; height: number } | null => {
  if (!isPng(bytes)) return null
  let offset = PNG_SIGNATURE.byteLength
  let width = 0
  let height = 0
  let sawHeader = false
  let sawData = false
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) return null
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.byteLength) return null
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (!sawHeader && type !== 'IHDR') return null
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) return null
      width = bytes.readUInt32BE(offset + 8)
      height = bytes.readUInt32BE(offset + 12)
      if (
        width < SITE_LOGO_MIN_INPUT_DIMENSION ||
        width > SITE_LOGO_MAX_INPUT_DIMENSION ||
        height < SITE_LOGO_MIN_INPUT_DIMENSION ||
        height > SITE_LOGO_MAX_INPUT_DIMENSION
      ) {
        return null
      }
      if (width * height > SITE_LOGO_MAX_INPUT_PIXELS) return null
      sawHeader = true
    } else if (type === 'IDAT') {
      sawData = true
    } else if (type === 'IEND') {
      if (length !== 0 || !sawHeader || !sawData || end !== bytes.byteLength) return null
      return { width, height }
    }
    offset = end
  }
  return null
}

const icoDimensions = (bytes: Buffer): boolean => {
  if (bytes.byteLength < ICO_HEADER_BYTES + 2 * ICO_ENTRY_BYTES || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return false
  const count = bytes.readUInt16LE(4)
  if (count !== 2) return false
  const ranges: Array<{ start: number; end: number; width: number; height: number }> = []
  const seen = new Set<number>()
  for (let index = 0; index < count; index += 1) {
    const offset = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES
    const width = bytes.readUInt8(offset)
    const height = bytes.readUInt8(offset + 1)
    const length = bytes.readUInt32LE(offset + 8)
    const dataOffset = bytes.readUInt32LE(offset + 12)
    if ((width !== SITE_LOGO_ICON_SIZES.favicon16 && width !== SITE_LOGO_ICON_SIZES.favicon32) || height !== width || seen.has(width)) return false
    seen.add(width)
    if (length === 0 || dataOffset < ICO_HEADER_BYTES + count * ICO_ENTRY_BYTES || dataOffset + length > bytes.byteLength) return false
    const dimensions = pngDimensions(bytes.subarray(dataOffset, dataOffset + length))
    if (!dimensions || dimensions.width !== width || dimensions.height !== height) return false
    ranges.push({ start: dataOffset, end: dataOffset + length, width, height })
  }
  if (seen.size !== 2) return false
  ranges.sort((left, right) => left.start - right.start)
  return ranges[0]!.end <= ranges[1]!.start && ranges[1]!.end === bytes.byteLength
}

const validateReadyEnhancement = (enhancement: ReadyEnhancement): ReadyEnhancement => {
  const particleV1 = asBuffer(enhancement.particleV1)
  const effectStaticPng = asBuffer(enhancement.effectStaticPng)
  if (
    particleV1.byteLength === 0 ||
    effectStaticPng.byteLength === 0 ||
    !isPng(effectStaticPng) ||
    effectStaticPng.byteLength > SITE_LOGO_STATIC_PNG_BYTE_LIMIT ||
    particleV1.byteLength > SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT ||
    gzipSync(particleV1, { level: 9 }).byteLength > SITE_LOGO_PARTICLE_GZIP_BYTE_LIMIT
  ) {
    throw new SiteLogoJobError('ARTIFACT_TOO_LARGE', 'Site logo enhancement artifacts exceed publication limits')
  }
  if (
    !Number.isSafeInteger(enhancement.normalizedWidth) ||
    enhancement.normalizedWidth < 2 ||
    enhancement.normalizedWidth > SITE_LOGO_MAX_INPUT_DIMENSION ||
    !Number.isSafeInteger(enhancement.normalizedHeight) ||
    enhancement.normalizedHeight < 2 ||
    enhancement.normalizedHeight > SITE_LOGO_MAX_INPUT_DIMENSION ||
    enhancement.normalizedWidth * enhancement.normalizedHeight > SITE_LOGO_MAX_INPUT_PIXELS ||
    !Number.isSafeInteger(enhancement.particleCount) ||
    enhancement.particleCount < 1 ||
    enhancement.particleCount > 16_000 ||
    !Number.isFinite(enhancement.medianStroke) ||
    enhancement.medianStroke <= 0 ||
    (enhancement.auraColor !== undefined && !AURA_COLOR_PATTERN.test(enhancement.auraColor))
  ) {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo processor returned invalid enhancement metadata')
  }
  const dimensions = pngDimensions(effectStaticPng)
  if (!dimensions || dimensions.width !== enhancement.normalizedWidth || dimensions.height !== enhancement.normalizedHeight) {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo static enhancement dimensions do not match its metadata')
  }
  let parsed: ParsedParticleMetadata
  try {
    parsed = parseParticleV1(particleV1)
  } catch {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo processor returned an invalid particle artifact')
  }
  if (parsed.width !== enhancement.normalizedWidth || parsed.height !== enhancement.normalizedHeight || parsed.count !== enhancement.particleCount) {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo particle artifact does not match its enhancement metadata')
  }
  return { ...enhancement, particleV1, effectStaticPng }
}

const validateArtifacts = (artifacts: SiteLogoArtifacts): ValidatedArtifacts => {
  const logoPng = asBuffer(artifacts.logoPng)
  const dimensions = pngDimensions(logoPng)
  if (
    !dimensions ||
    !Number.isSafeInteger(artifacts.logoWidth) ||
    !Number.isSafeInteger(artifacts.logoHeight) ||
    artifacts.logoWidth < SITE_LOGO_MIN_INPUT_DIMENSION ||
    artifacts.logoWidth > SITE_LOGO_MAX_INPUT_DIMENSION ||
    artifacts.logoHeight < SITE_LOGO_MIN_INPUT_DIMENSION ||
    artifacts.logoHeight > SITE_LOGO_MAX_INPUT_DIMENSION ||
    artifacts.logoWidth * artifacts.logoHeight > SITE_LOGO_MAX_INPUT_PIXELS ||
    dimensions.width !== artifacts.logoWidth ||
    dimensions.height !== artifacts.logoHeight
  ) {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo processor returned an invalid canonical PNG')
  }
  if (logoPng.byteLength > SITE_LOGO_PNG_BYTE_LIMIT) {
    throw new SiteLogoJobError('ARTIFACT_TOO_LARGE', 'Site logo canonical PNG exceeds publication limits')
  }

  const icons = {} as Record<IconName, Buffer>
  for (const name of ICON_NAMES) {
    const expectedSize = SITE_LOGO_ICON_SIZES[name]
    const bytes = asBuffer(artifacts.icons[name])
    const iconDimensions = pngDimensions(bytes)
    if (!iconDimensions || iconDimensions.width !== expectedSize || iconDimensions.height !== expectedSize) {
      throw new SiteLogoJobError('PROCESSING_FAILED', `Site logo ${name} icon has invalid dimensions`)
    }
    if (bytes.byteLength > SITE_LOGO_ICON_PNG_BYTE_LIMIT) {
      throw new SiteLogoJobError('ARTIFACT_TOO_LARGE', `Site logo ${name} icon exceeds publication limits`)
    }
    icons[name] = bytes
  }

  const faviconIco = asBuffer(artifacts.faviconIco)
  if (faviconIco.byteLength === 0 || faviconIco.byteLength > SITE_LOGO_FAVICON_ICO_BYTE_LIMIT || !icoDimensions(faviconIco)) {
    throw new SiteLogoJobError(
      faviconIco.byteLength > SITE_LOGO_FAVICON_ICO_BYTE_LIMIT ? 'ARTIFACT_TOO_LARGE' : 'PROCESSING_FAILED',
      'Site logo favicon ICO is invalid'
    )
  }

  const enhancement = artifacts.enhancement
  if (!enhancement || typeof enhancement !== 'object') {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo processor returned no enhancement outcome')
  }
  if (enhancement.status === 'ready') {
    return {
      logoPng,
      logoWidth: dimensions.width,
      logoHeight: dimensions.height,
      icons,
      faviconIco,
      enhancement: validateReadyEnhancement(enhancement)
    }
  }
  if (
    enhancement.status !== 'unavailable' ||
    !(['UNSUITABLE_LOGO', 'ARTIFACT_TOO_LARGE', 'PROCESSING_FAILED'] as readonly SiteLogoEnhancementUnavailableReason[]).includes(enhancement.reason)
  ) {
    throw new SiteLogoJobError('PROCESSING_FAILED', 'Site logo processor returned an invalid enhancement outcome')
  }
  return {
    logoPng,
    logoWidth: dimensions.width,
    logoHeight: dimensions.height,
    icons,
    faviconIco,
    enhancement
  }
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

const markFailed = async (knex: Knex, job: DurableJob, payload: ProcessPayload, protocol: SiteLogoJobProtocol, code: SafeErrorCode): Promise<void> => {
  await knex.transaction(async transaction => {
    const now = new Date()
    const durable = await lockJob(transaction, job.id, protocol)
    if (!ownsCurrentLease(durable, job, payload, protocol, now)) throw new SiteLogoLeaseLostError(job.id)
    const state = await lockState(transaction)
    const revision = await transaction<RevisionRow>('siteLogoRevisions').where({ id: payload.revisionId }).forUpdate().first()
    const pipelineVersion = Number(revision?.pipelineVersion)
    if (
      !revision ||
      revision.jobId !== job.id ||
      Number(revision.retrySequence) !== payload.retrySequence ||
      !protocolSupportsPipeline(protocol, pipelineVersion)
    ) {
      throw new TypeError('Site logo processing job does not match its revision')
    }
    if (revision.status === 'ready' || revision.status === 'failed') return
    if (revision.status !== 'running') throw new TypeError('Site logo revision is not running')
    const updated = await transaction<RevisionRow>('siteLogoRevisions')
      .where({
        id: revision.id,
        jobId: job.id,
        retrySequence: payload.retrySequence,
        pipelineVersion,
        status: 'running'
      })
      .update({
        status: 'failed',
        errorCode: code,
        completedAt: now,
        retiredAt: state.desiredRevisionId === revision.id ? null : now,
        updatedAt: now
      })
    if (updated !== 1) throw new SiteLogoLeaseLostError(job.id)
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
  throw new SiteLogoJobError('PROCESSING_FAILED', `Site logo object ${object.kind}:${object.sha256} is immutable and failed its integrity check`)
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
  protocol: SiteLogoJobProtocol,
  validated: ValidatedArtifacts
): Promise<void> => {
  await knex.transaction(async transaction => {
    const now = new Date()
    const durable = await lockJob(transaction, job.id, protocol)
    if (!ownsCurrentLease(durable, job, payload, protocol, now)) throw new SiteLogoLeaseLostError(job.id)
    const state = await lockState(transaction)
    const revision = await transaction<RevisionRow>('siteLogoRevisions').where({ id: payload.revisionId }).forUpdate().first()
    const pipelineVersion = Number(revision?.pipelineVersion)
    if (
      !revision ||
      revision.jobId !== job.id ||
      Number(revision.retrySequence) !== payload.retrySequence ||
      !protocolSupportsPipeline(protocol, pipelineVersion)
    ) {
      throw new TypeError('Site logo processing job does not match its revision')
    }
    if (revision.status === 'ready' || revision.status === 'failed') return
    if (revision.status !== 'running') throw new TypeError('Site logo revision is not running')

    const logo = artifactIdentity('logo-png', validated.logoPng, 'image/png', now)
    const iconObjects: Record<IconName, ArtifactObject> = {
      favicon16: artifactIdentity('icon-png', validated.icons.favicon16, 'image/png', now),
      favicon32: artifactIdentity('icon-png', validated.icons.favicon32, 'image/png', now),
      tile150: artifactIdentity('icon-png', validated.icons.tile150, 'image/png', now),
      apple180: artifactIdentity('icon-png', validated.icons.apple180, 'image/png', now),
      app192: artifactIdentity('icon-png', validated.icons.app192, 'image/png', now),
      app512: artifactIdentity('icon-png', validated.icons.app512, 'image/png', now),
      maskable512: artifactIdentity('icon-png', validated.icons.maskable512, 'image/png', now)
    }
    const faviconIco = artifactIdentity('favicon-ico', validated.faviconIco, 'image/x-icon', now)
    await ensureImmutableObject(transaction, logo)
    for (const icon of Object.values(iconObjects)) await ensureImmutableObject(transaction, icon)
    await ensureImmutableObject(transaction, faviconIco)
    const enhancement = validated.enhancement
    const readyEnhancement = enhancement.status === 'ready' ? enhancement : null
    const particle = readyEnhancement ? artifactIdentity('particle-v1', readyEnhancement.particleV1, 'application/octet-stream', now) : null
    const effectStaticPng = readyEnhancement ? artifactIdentity('effect-static-png', readyEnhancement.effectStaticPng, 'image/png', now) : null
    if (particle) await ensureImmutableObject(transaction, particle)
    if (effectStaticPng) await ensureImmutableObject(transaction, effectStaticPng)

    const isDesired = state.desiredRevisionId === revision.id
    const isRepair = payload.expectedActiveRevisionId !== undefined
    if (isRepair && isDesired) {
      throw new TypeError('Site logo repair revision must remain separate from the desired revision')
    }
    let repairMayActivate = false
    if (isRepair && state.activeRevisionId === payload.expectedActiveRevisionId) {
      const expectedActive = await transaction<RevisionRow>('siteLogoRevisions').where({ id: payload.expectedActiveRevisionId }).forUpdate().first()
      repairMayActivate =
        expectedActive !== undefined &&
        expectedActive.status === 'ready' &&
        expectedActive.retiredAt === null &&
        expectedActive.sourceHash === revision.sourceHash &&
        Number(expectedActive.pipelineVersion) < SITE_LOGO_PIPELINE_VERSION
    }
    const shouldActivate = isDesired || repairMayActivate
    const updated = await transaction('siteLogoRevisions')
      .where({
        id: revision.id,
        jobId: job.id,
        retrySequence: payload.retrySequence,
        pipelineVersion,
        status: 'running'
      })
      .update({
        pipelineVersion,
        status: 'ready',
        logoPngKind: 'logo-png',
        logoPngHash: logo.sha256,
        iconPngKind: 'icon-png',
        favicon16Hash: iconObjects.favicon16.sha256,
        favicon32Hash: iconObjects.favicon32.sha256,
        tile150Hash: iconObjects.tile150.sha256,
        apple180Hash: iconObjects.apple180.sha256,
        app192Hash: iconObjects.app192.sha256,
        app512Hash: iconObjects.app512.sha256,
        maskable512Hash: iconObjects.maskable512.sha256,
        faviconIcoKind: 'favicon-ico',
        faviconIcoHash: faviconIco.sha256,
        particleV1Kind: particle ? 'particle-v1' : null,
        particleV1Hash: particle?.sha256 ?? null,
        effectStaticPngKind: effectStaticPng ? 'effect-static-png' : null,
        effectStaticPngHash: effectStaticPng?.sha256 ?? null,
        normalizedWidth: readyEnhancement?.normalizedWidth ?? null,
        normalizedHeight: readyEnhancement?.normalizedHeight ?? null,
        particleCount: readyEnhancement?.particleCount ?? null,
        medianStroke: readyEnhancement?.medianStroke ?? null,
        auraColor: readyEnhancement?.auraColor ?? null,
        enhancementErrorCode: readyEnhancement ? null : enhancement.status === 'unavailable' ? enhancement.reason : null,
        errorCode: null,
        completedAt: now,
        retiredAt: shouldActivate ? null : now,
        updatedAt: now
      })
    if (updated !== 1) throw new SiteLogoLeaseLostError(job.id)

    if (!shouldActivate) return
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

export const createSiteLogoProcessHandler = (jobVersion: SiteLogoJobVersion, processor?: SiteLogoProcessor): DurableJobHandler => {
  const protocol = protocolForJobVersion(jobVersion)
  if (!protocol) throw new TypeError(`Unsupported site logo job protocol ${jobVersion}`)
  const isLegacyProtocol = protocol.jobVersion !== CURRENT_SITE_LOGO_PROTOCOL.jobVersion
  const selectedProcessor = processor ?? processSiteLogoSource
  return async (job, { knex, signal }) => {
    const payload = parsePayloadValue(job.payload)
    if (payload.expectedActiveRevisionId !== undefined && protocol.jobVersion !== CURRENT_SITE_LOGO_PROTOCOL.jobVersion) {
      throw new TypeError('Site logo repair payload is only supported by the current protocol')
    }
    const revision = await transitionToRunning(knex, job, payload, protocol)
    if (!revision) return
    if (isLegacyProtocol) {
      await markFailed(knex, job, payload, protocol, 'PROCESSING_FAILED')
      return
    }

    let artifacts: SiteLogoArtifacts
    let validated: ValidatedArtifacts
    try {
      const source = await readVerifiedSource(knex, revision)
      signal.throwIfAborted()
      artifacts = await serializeProcessing(async () => {
        signal.throwIfAborted()
        return await selectedProcessor(source, revision.sourceHash)
      })
      signal.throwIfAborted()
      validated = validateArtifacts(artifacts)
    } catch (error) {
      signal.throwIfAborted()
      logProcessingFailure(job, payload, error)
      await markFailed(knex, job, payload, protocol, safeFailureCode(error))
      return
    }

    signal.throwIfAborted()
    await publishArtifacts(knex, job, payload, protocol, validated)
  }
}

const objectReference = (kind: ObjectKind): { kindColumn: keyof RevisionRow; hashColumn: keyof RevisionRow } => {
  switch (kind) {
    case 'source':
      return { kindColumn: 'sourceKind', hashColumn: 'sourceHash' }
    case 'logo-png':
      return { kindColumn: 'logoPngKind', hashColumn: 'logoPngHash' }
    case 'icon-png':
      return { kindColumn: 'iconPngKind', hashColumn: 'favicon16Hash' }
    case 'favicon-ico':
      return { kindColumn: 'faviconIcoKind', hashColumn: 'faviconIcoHash' }
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

    const retiredQuery = transaction<RevisionRow>('siteLogoRevisions')
      .whereIn('status', ['ready', 'failed'])
      .whereNotNull('retiredAt')
      .where('retiredAt', '<=', cutoff)
    if (state.activeRevisionId !== null) retiredQuery.whereNot({ id: state.activeRevisionId })
    if (state.desiredRevisionId !== null) retiredQuery.whereNot({ id: state.desiredRevisionId })
    const retired = await retiredQuery.forUpdate()

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
      for (const hash of [
        revision.favicon16Hash,
        revision.favicon32Hash,
        revision.tile150Hash,
        revision.apple180Hash,
        revision.app192Hash,
        revision.app512Hash,
        revision.maskable512Hash
      ]) {
        if (revision.iconPngKind && hash) identities.set(`icon-png:${hash}`, { kind: 'icon-png', hash })
      }
      if (revision.faviconIcoKind && revision.faviconIcoHash)
        identities.set(`favicon-ico:${revision.faviconIcoHash}`, { kind: 'favicon-ico', hash: revision.faviconIcoHash })
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
      let reachable: Pick<RevisionRow, 'id'> | undefined
      if (kind === 'icon-png') {
        reachable = await transaction<RevisionRow>('siteLogoRevisions')
          .where('iconPngKind', 'icon-png')
          .andWhere(builder => {
            builder
              .where('favicon16Hash', hash)
              .orWhere('favicon32Hash', hash)
              .orWhere('tile150Hash', hash)
              .orWhere('apple180Hash', hash)
              .orWhere('app192Hash', hash)
              .orWhere('app512Hash', hash)
              .orWhere('maskable512Hash', hash)
          })
          .first('id')
      } else {
        const reference = objectReference(kind)
        reachable = await transaction<RevisionRow>('siteLogoRevisions')
          .where({ [reference.kindColumn]: kind, [reference.hashColumn]: hash })
          .first('id')
      }
      if (!reachable) await transaction<ObjectRow>('siteLogoObjects').where({ kind, sha256: hash }).delete()
    }
  })
}
