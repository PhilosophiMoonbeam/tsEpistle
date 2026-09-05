import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'

import { DurableJobStore } from '../core/durable-jobs.ts'

export const SITE_LOGO_SOURCE_LIMIT = 5_242_880
const SITE_LOGO_PIPELINE_VERSION = 5
const SITE_LOGO_JOB_VERSION = 3
const STATUS_URL = '/_api/site/logo'
const SHA256 = /^[a-f0-9]{64}$/

const SAFE_ERROR_CODES: Readonly<Record<string, true>> = {
  UNSUPPORTED_IMAGE: true,
  IMAGE_TOO_LARGE: true,
  INVALID_IMAGE: true,
  NO_VISIBLE_PIXELS: true,
  UNSUITABLE_LOGO: true,
  PROCESSING_FAILED: true,
  ARTIFACT_TOO_LARGE: true
}
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff])
const RIFF_SIGNATURE = Buffer.from('RIFF', 'ascii')
const WEBP_SIGNATURE = Buffer.from('WEBP', 'ascii')

type RevisionStatus = 'pending' | 'running' | 'ready' | 'failed'
type ObjectKind = 'source' | 'logo-png' | 'particle-v1' | 'effect-static-png'
type SourceContentType = 'image/png' | 'image/jpeg' | 'image/webp'

interface SiteLogoObjectRow {
  kind: ObjectKind
  sha256: string
  bytes: Buffer | Uint8Array
  byteLength: number | string
  contentType: string
  createdAt: Date | string
}

interface SiteLogoRevisionRow {
  id: string
  sourceKind: 'source'
  sourceHash: string
  pipelineVersion: number
  status: RevisionStatus
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
  errorCode: string | null
  requestedBy: number | null
  createdAt: Date | string
  updatedAt: Date | string
  startedAt: Date | string | null
  completedAt: Date | string | null
  retiredAt: Date | string | null
}

interface SiteLogoStateRow {
  id: number
  generation: number
  desiredRevisionId: string | null
  activeRevisionId: string | null
  createdAt: Date | string
  updatedAt: Date | string
}

export interface SiteLogoStatusResponse {
  active: { revisionId: string; logoUrl: string } | null
  candidate: { revisionId: string; status: RevisionStatus; errorCode: string | null } | null
}

export interface SiteLogoMutationResult {
  statusCode: 200 | 202
  status: SiteLogoStatusResponse & { statusUrl: string }
}

export class SiteLogoOperationError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'SiteLogoOperationError'
    this.code = code
    this.status = status
  }
}

const runtimeKnex = (): Knex => {
  const runtime = WIKI as unknown as { models?: { knex?: Knex } }
  const knex = runtime.models?.knex
  if (!knex) throw new Error('Site logo database is unavailable')
  return knex
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const publicUrl = (hash: string): string => `/_site-logo/${hash}/logo.png`
const safeErrorCode = (code: string | null): string | null => (code !== null && SAFE_ERROR_CODES[code] ? code : code === null ? null : 'PROCESSING_FAILED')
const isBytes = (value: unknown): value is Uint8Array => Buffer.isBuffer(value) || value instanceof Uint8Array
const sourceContentType = (bytes: Buffer): SourceContentType | null => {
  if (bytes.byteLength >= PNG_SIGNATURE.byteLength && bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) return 'image/png'
  if (bytes.byteLength >= JPEG_SIGNATURE.byteLength && bytes.subarray(0, JPEG_SIGNATURE.byteLength).equals(JPEG_SIGNATURE)) return 'image/jpeg'
  if (bytes.byteLength >= 12 && bytes.subarray(0, 4).equals(RIFF_SIGNATURE) && bytes.subarray(8, 12).equals(WEBP_SIGNATURE)) return 'image/webp'
  return null
}

const verifiedObject = (row: SiteLogoObjectRow | undefined, kind: ObjectKind, hash: string): boolean =>
  row !== undefined &&
  row.kind === kind &&
  row.sha256 === hash &&
  isBytes(row.bytes) &&
  Number(row.byteLength) === row.bytes.byteLength &&
  digest(row.bytes) === hash

const stateForUpdate = async (transaction: Knex.Transaction): Promise<SiteLogoStateRow> => {
  const state = await transaction<SiteLogoStateRow>('siteLogoState').where({ id: 1 }).forUpdate().first()
  if (!state) throw new Error('Site logo singleton state is missing')
  return state
}

const revisionById = async (knex: Knex | Knex.Transaction, id: string | null, lock = false): Promise<SiteLogoRevisionRow | undefined> => {
  if (id === null) return undefined
  let query = knex<SiteLogoRevisionRow>('siteLogoRevisions').where({ id })
  if (lock) query = query.forUpdate()
  return await query.first()
}

const objectByIdentity = async (knex: Knex | Knex.Transaction, kind: ObjectKind, hash: string, lock = false): Promise<SiteLogoObjectRow | undefined> => {
  let query = knex<SiteLogoObjectRow>('siteLogoObjects').where({ kind, sha256: hash })
  if (lock) query = query.forUpdate()
  return await query.first()
}

const readyRevisionIsIntact = async (transaction: Knex.Transaction, revision: SiteLogoRevisionRow): Promise<boolean> => {
  if (
    revision.status !== 'ready' ||
    revision.sourceKind !== 'source' ||
    revision.logoPngKind !== 'logo-png' ||
    revision.particleV1Kind !== 'particle-v1' ||
    revision.effectStaticPngKind !== 'effect-static-png' ||
    !SHA256.test(revision.sourceHash) ||
    !revision.logoPngHash ||
    !SHA256.test(revision.logoPngHash) ||
    !revision.particleV1Hash ||
    !SHA256.test(revision.particleV1Hash) ||
    !revision.effectStaticPngHash ||
    !SHA256.test(revision.effectStaticPngHash)
  )
    return false

  const identities: Array<[ObjectKind, string]> = [
    ['source', revision.sourceHash],
    ['logo-png', revision.logoPngHash],
    ['particle-v1', revision.particleV1Hash],
    ['effect-static-png', revision.effectStaticPngHash]
  ]
  for (const [kind, hash] of identities) {
    const object = await objectByIdentity(transaction, kind, hash, true)
    if (!verifiedObject(object, kind, hash)) return false
  }
  return true
}

const retireTerminalRevision = async (transaction: Knex.Transaction, revisionId: string | null, exceptId: string, now: Date): Promise<void> => {
  if (!revisionId || revisionId === exceptId) return
  await transaction<SiteLogoRevisionRow>('siteLogoRevisions')
    .where({ id: revisionId })
    .whereIn('status', ['ready', 'failed'])
    .whereNull('retiredAt')
    .update({ retiredAt: now, updatedAt: now })
}

const ensureSourceObject = async (
  transaction: Knex.Transaction,
  sourceHash: string,
  bytes: Buffer,
  contentType: SourceContentType,
  activeRevisionId: string | null,
  now: Date
): Promise<void> => {
  const stored = await objectByIdentity(transaction, 'source', sourceHash, true)
  if (verifiedObject(stored, 'source', sourceHash)) return

  if (stored) {
    let terminalReferencesQuery = transaction<SiteLogoRevisionRow>('siteLogoRevisions').where({ sourceKind: 'source', sourceHash })
    if (activeRevisionId !== null) terminalReferencesQuery = terminalReferencesQuery.whereNot({ id: activeRevisionId })
    const terminalReferences = await terminalReferencesQuery.whereIn('status', ['ready', 'failed']).forUpdate()
    const ids = terminalReferences.map(revision => revision.id)
    if (ids.length > 0) {
      await transaction<SiteLogoRevisionRow>('siteLogoRevisions').whereIn('id', ids).update({ retiredAt: now, updatedAt: now })
    }
    await transaction<SiteLogoObjectRow>('siteLogoObjects')
      .where({ kind: 'source', sha256: sourceHash })
      .update({ bytes, byteLength: bytes.byteLength, contentType })
    return
  }

  await transaction<SiteLogoObjectRow>('siteLogoObjects').insert({
    kind: 'source',
    sha256: sourceHash,
    bytes,
    byteLength: bytes.byteLength,
    contentType,
    createdAt: now
  })
}

const statusFrom = async (knex: Knex | Knex.Transaction, state: SiteLogoStateRow): Promise<SiteLogoStatusResponse> => {
  const [activeRevision, desiredRevision] = await Promise.all([
    revisionById(knex, state.activeRevisionId),
    state.desiredRevisionId === state.activeRevisionId ? Promise.resolve(undefined) : revisionById(knex, state.desiredRevisionId)
  ])
  const active =
    activeRevision?.status === 'ready' &&
    activeRevision.logoPngKind === 'logo-png' &&
    typeof activeRevision.logoPngHash === 'string' &&
    SHA256.test(activeRevision.logoPngHash)
      ? { revisionId: activeRevision.id, logoUrl: publicUrl(activeRevision.logoPngHash) }
      : null
  const candidate =
    desiredRevision && desiredRevision.retiredAt === null
      ? {
          revisionId: desiredRevision.id,
          status: desiredRevision.status,
          errorCode: desiredRevision.status === 'failed' ? safeErrorCode(desiredRevision.errorCode) : null
        }
      : null
  return { active, candidate }
}

const statusWithUrl = async (knex: Knex | Knex.Transaction, state: SiteLogoStateRow): Promise<SiteLogoStatusResponse & { statusUrl: string }> => ({
  ...(await statusFrom(knex, state)),
  statusUrl: STATUS_URL
})

const enqueueCandidate = async (
  transaction: Knex.Transaction,
  sourceHash: string,
  requestedBy: number | null,
  retrySequence: number,
  now: Date
): Promise<SiteLogoRevisionRow> => {
  const revisionId = randomUUID()
  const revision: SiteLogoRevisionRow = {
    id: revisionId,
    sourceKind: 'source',
    sourceHash,
    pipelineVersion: SITE_LOGO_PIPELINE_VERSION,
    status: 'pending',
    jobId: null,
    retrySequence,
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
    requestedBy,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    retiredAt: null
  }
  await transaction<SiteLogoRevisionRow>('siteLogoRevisions').insert(revision)
  const job = await new DurableJobStore(transaction).enqueue({
    type: 'process-site-logo',
    version: SITE_LOGO_JOB_VERSION,
    payload: { revisionId, retrySequence },
    maxAttempts: 5
  })
  revision.jobId = job.id
  await transaction<SiteLogoRevisionRow>('siteLogoRevisions').where({ id: revisionId }).update({ jobId: job.id, updatedAt: now })
  return revision
}

const persistManagedLogoUrl = async (transaction: Knex.Transaction, logoUrl: string, now: Date): Promise<void> => {
  const value = JSON.stringify({ v: logoUrl })
  const updated = await transaction('settings').where({ key: 'logoUrl' }).update({ value, updatedAt: now.toISOString() })
  if (updated === 0) await transaction('settings').insert({ key: 'logoUrl', value, updatedAt: now.toISOString() })
}

export const getSiteLogoStatus = async (knex: Knex = runtimeKnex()): Promise<SiteLogoStatusResponse> => {
  const state = await knex<SiteLogoStateRow>('siteLogoState').where({ id: 1 }).first()
  if (!state) throw new Error('Site logo singleton state is missing')
  return await statusFrom(knex, state)
}

export const uploadSiteLogoCandidate = async (bytes: Buffer, requestedBy: number | null, knex: Knex = runtimeKnex()): Promise<SiteLogoMutationResult> => {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0) {
    throw new SiteLogoOperationError('INVALID_IMAGE', 'A non-empty image file is required.', 400)
  }
  if (bytes.byteLength > SITE_LOGO_SOURCE_LIMIT) {
    throw new SiteLogoOperationError('IMAGE_TOO_LARGE', 'Logo image exceeds 5,242,880 bytes.', 413)
  }
  const contentType = sourceContentType(bytes)
  if (contentType === null) {
    throw new SiteLogoOperationError('UNSUPPORTED_IMAGE', 'Only static PNG, JPEG, and WebP images are supported.', 400)
  }
  const sourceHash = digest(bytes)
  let activatedLogoUrl: string | null = null

  const result = await knex.transaction(async transaction => {
    const now = new Date()
    const state = await stateForUpdate(transaction)
    await ensureSourceObject(transaction, sourceHash, bytes, contentType, state.activeRevisionId, now)

    const activeRevision = await revisionById(transaction, state.activeRevisionId, true)
    if (
      activeRevision?.sourceHash === sourceHash &&
      activeRevision.pipelineVersion === SITE_LOGO_PIPELINE_VERSION &&
      (await readyRevisionIsIntact(transaction, activeRevision))
    ) {
      if (state.desiredRevisionId !== activeRevision.id) {
        await retireTerminalRevision(transaction, state.desiredRevisionId, activeRevision.id, now)
        await transaction<SiteLogoStateRow>('siteLogoState')
          .where({ id: 1 })
          .update({
            generation: Number(state.generation) + 1,
            desiredRevisionId: activeRevision.id,
            updatedAt: now
          })
        const restoredState = {
          ...state,
          generation: Number(state.generation) + 1,
          desiredRevisionId: activeRevision.id,
          updatedAt: now
        }
        return { statusCode: 200 as const, status: await statusWithUrl(transaction, restoredState) }
      }
      return { statusCode: 200 as const, status: await statusWithUrl(transaction, state) }
    }

    const desiredRevision = await revisionById(transaction, state.desiredRevisionId, true)
    if (
      desiredRevision &&
      desiredRevision.id !== state.activeRevisionId &&
      desiredRevision.retiredAt === null &&
      desiredRevision.sourceHash === sourceHash &&
      desiredRevision.pipelineVersion === SITE_LOGO_PIPELINE_VERSION &&
      (desiredRevision.status === 'pending' || desiredRevision.status === 'running')
    ) {
      return { statusCode: 202 as const, status: await statusWithUrl(transaction, state) }
    }

    let readyCandidatesQuery = transaction<SiteLogoRevisionRow>('siteLogoRevisions')
      .where({ sourceKind: 'source', sourceHash, pipelineVersion: SITE_LOGO_PIPELINE_VERSION, status: 'ready' })
      .whereNull('retiredAt')
    if (state.activeRevisionId !== null) readyCandidatesQuery = readyCandidatesQuery.whereNot({ id: state.activeRevisionId })
    const readyCandidates = await readyCandidatesQuery.orderBy('completedAt', 'desc').forUpdate()
    for (const candidate of readyCandidates) {
      if (!(await readyRevisionIsIntact(transaction, candidate))) {
        await transaction<SiteLogoRevisionRow>('siteLogoRevisions').where({ id: candidate.id }).update({ retiredAt: now, updatedAt: now })
        continue
      }
      if (!candidate.logoPngHash) throw new Error('Ready site logo revision is missing its logo hash')
      const logoUrl = publicUrl(candidate.logoPngHash)
      await persistManagedLogoUrl(transaction, logoUrl, now)
      await retireTerminalRevision(transaction, state.desiredRevisionId, candidate.id, now)
      await retireTerminalRevision(transaction, state.activeRevisionId, candidate.id, now)
      await transaction<SiteLogoStateRow>('siteLogoState')
        .where({ id: 1 })
        .update({
          generation: Number(state.generation) + 1,
          desiredRevisionId: candidate.id,
          activeRevisionId: candidate.id,
          updatedAt: now
        })
      activatedLogoUrl = logoUrl
      const activatedState = {
        ...state,
        generation: Number(state.generation) + 1,
        desiredRevisionId: candidate.id,
        activeRevisionId: candidate.id,
        updatedAt: now
      }
      return { statusCode: 200 as const, status: await statusWithUrl(transaction, activatedState) }
    }

    await retireTerminalRevision(transaction, state.desiredRevisionId, state.activeRevisionId ?? '', now)
    const retrySequence = desiredRevision?.sourceHash === sourceHash ? Number(desiredRevision.retrySequence) + 1 : 0
    const revision = await enqueueCandidate(transaction, sourceHash, requestedBy, retrySequence, now)
    await transaction<SiteLogoStateRow>('siteLogoState')
      .where({ id: 1 })
      .update({
        generation: Number(state.generation) + 1,
        desiredRevisionId: revision.id,
        updatedAt: now
      })
    const pendingState = { ...state, generation: Number(state.generation) + 1, desiredRevisionId: revision.id, updatedAt: now }
    return { statusCode: 202 as const, status: await statusWithUrl(transaction, pendingState) }
  })

  if (activatedLogoUrl !== null) {
    const runtime = WIKI as unknown as { config?: { logoUrl?: string } }
    const config = runtime.config
    if (config) config.logoUrl = activatedLogoUrl
  }
  return result
}

export const retrySiteLogoCandidate = async (requestedBy: number | null, knex: Knex = runtimeKnex()): Promise<SiteLogoMutationResult> =>
  await knex.transaction(async transaction => {
    const now = new Date()
    const state = await stateForUpdate(transaction)
    if (!state.desiredRevisionId || state.desiredRevisionId === state.activeRevisionId) {
      throw new SiteLogoOperationError('NO_FAILED_CANDIDATE', 'There is no failed logo candidate to retry.', 409)
    }
    const failed = await revisionById(transaction, state.desiredRevisionId, true)
    if (!failed || failed.status !== 'failed' || failed.retiredAt !== null) {
      throw new SiteLogoOperationError('NO_FAILED_CANDIDATE', 'There is no failed logo candidate to retry.', 409)
    }
    const source = await objectByIdentity(transaction, 'source', failed.sourceHash, true)
    if (!verifiedObject(source, 'source', failed.sourceHash)) {
      throw new SiteLogoOperationError('PROCESSING_FAILED', 'The failed logo source is unavailable; upload the image again.', 409)
    }

    await transaction<SiteLogoRevisionRow>('siteLogoRevisions').where({ id: failed.id }).update({ retiredAt: now, updatedAt: now })
    const revision = await enqueueCandidate(transaction, failed.sourceHash, requestedBy, Number(failed.retrySequence) + 1, now)
    await transaction<SiteLogoStateRow>('siteLogoState')
      .where({ id: 1 })
      .update({
        generation: Number(state.generation) + 1,
        desiredRevisionId: revision.id,
        updatedAt: now
      })
    const pendingState = { ...state, generation: Number(state.generation) + 1, desiredRevisionId: revision.id, updatedAt: now }
    return { statusCode: 202, status: await statusWithUrl(transaction, pendingState) }
  })
