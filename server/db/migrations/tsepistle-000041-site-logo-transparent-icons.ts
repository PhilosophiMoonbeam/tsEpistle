import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'

import { SITE_LOGO_SOURCE_BYTE_LIMIT } from '../../../shared/site-logo.ts'

const OBJECTS = 'siteLogoObjects'
const REVISIONS = 'siteLogoRevisions'
const STATE = 'siteLogoState'
const JOBS = 'durableJobs'

const HISTORICAL_PIPELINE_MAX = 6 as const
const CURRENT_PIPELINE_VERSION = 7 as const
const CURRENT_JOB_VERSION = 5 as const
const ICON_PIPELINE_VERSIONS = [6, 7] as const
const ENHANCEMENT_ERROR_CODES = ['UNSUITABLE_LOGO', 'ARTIFACT_TOO_LARGE', 'PROCESSING_FAILED'] as const
const ENHANCEMENT_ERROR_CODE_SQL = ENHANCEMENT_ERROR_CODES.map(code => `'${code}'`).join(', ')
const SUPERSEDED_JOB_ERROR = 'Superseded by site-logo pipeline 7'
const REVISION_WRITER_FENCE_FUNCTION = 'site_logo_revision_writer_fence'
const REVISION_WRITER_FENCE_TRIGGER = 'site_logo_revision_writer_fence_trigger'
const STATE_WRITER_FENCE_FUNCTION = 'site_logo_state_writer_fence'
const STATE_WRITER_FENCE_TRIGGER = 'site_logo_state_writer_fence_trigger'
const SHA256 = /^[0-9a-f]{64}$/
const SOURCE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

type RevisionStatus = 'pending' | 'running' | 'ready' | 'failed'

interface RevisionRow {
  id: string
  sourceKind: string
  sourceHash: string
  pipelineVersion: number
  status: RevisionStatus
  jobId: string | null
  retrySequence: number
  requestedBy: number | null
}

interface StateRow {
  id: number
  generation: number
  desiredRevisionId: string | null
  activeRevisionId: string | null
}

interface SourceObjectRow {
  kind: string
  sha256: string
  bytes: Buffer | Uint8Array
  byteLength: number | string
  contentType: string
}

interface DurableJobRow {
  id: string
  state: string
  payload: string
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const dropConstraint = async (transaction: Knex.Transaction, table: string, name: string): Promise<void> => {
  await transaction.raw(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`)
}

const addCheck = async (transaction: Knex.Transaction, table: string, name: string, expression: string): Promise<void> => {
  await transaction.raw(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${expression})`)
}

const retainedSource = (row: SourceObjectRow | undefined, hash: string): boolean => {
  if (
    !row ||
    row.kind !== 'source' ||
    row.sha256 !== hash ||
    !SHA256.test(hash) ||
    (!Buffer.isBuffer(row.bytes) && !(row.bytes instanceof Uint8Array)) ||
    Number(row.byteLength) !== row.bytes.byteLength ||
    row.bytes.byteLength < 1 ||
    row.bytes.byteLength > SITE_LOGO_SOURCE_BYTE_LIMIT ||
    !SOURCE_CONTENT_TYPES.includes(row.contentType as (typeof SOURCE_CONTENT_TYPES)[number])
  ) {
    return false
  }
  return digest(row.bytes) === hash
}

const lockRevision = async (transaction: Knex.Transaction, id: string | null): Promise<RevisionRow | undefined> => {
  if (id === null) return undefined
  return await transaction<RevisionRow>(REVISIONS).where({ id }).forUpdate().first()
}

const lockSource = async (transaction: Knex.Transaction, hash: string): Promise<SourceObjectRow | undefined> =>
  await transaction<SourceObjectRow>(OBJECTS).where({ kind: 'source', sha256: hash }).forUpdate().first()

const cancelJob = async (transaction: Knex.Transaction, jobId: string | null, now: Date): Promise<void> => {
  if (jobId === null) return
  await transaction(JOBS).where({ id: jobId }).whereIn('state', ['pending', 'running']).update({
    state: 'cancelled',
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastError: SUPERSEDED_JOB_ERROR,
    completedAt: now,
    updatedAt: now
  })
}

const retireLegacyWork = async (transaction: Knex.Transaction, revision: RevisionRow, now: Date): Promise<void> => {
  await cancelJob(transaction, revision.jobId, now)
  await transaction(REVISIONS).where({ id: revision.id }).whereIn('status', ['pending', 'running']).update({
    status: 'failed',
    errorCode: 'PROCESSING_FAILED',
    completedAt: now,
    retiredAt: now,
    updatedAt: now
  })
}

const retireReadyLegacyRevision = async (transaction: Knex.Transaction, revision: RevisionRow, now: Date): Promise<void> => {
  await transaction(REVISIONS).where({ id: revision.id, status: 'ready' }).whereNull('retiredAt').update({ retiredAt: now, updatedAt: now })
}

const createV7Successor = async (
  transaction: Knex.Transaction,
  sourceRevision: RevisionRow,
  now: Date,
  expectedActiveRevisionId: string | null
): Promise<string> => {
  const revisionId = randomUUID()
  const jobId = randomUUID()
  const payload = {
    revisionId,
    retrySequence: 0,
    ...(expectedActiveRevisionId === null ? {} : { expectedActiveRevisionId })
  }
  await transaction(JOBS).insert({
    id: jobId,
    type: 'process-site-logo',
    version: CURRENT_JOB_VERSION,
    payload: JSON.stringify(payload),
    state: 'pending',
    attempts: 0,
    maxAttempts: 5,
    nextRunAt: now,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    lastError: null,
    deduplicationKey: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  })
  await transaction(REVISIONS).insert({
    id: revisionId,
    sourceKind: 'source',
    sourceHash: sourceRevision.sourceHash,
    pipelineVersion: CURRENT_PIPELINE_VERSION,
    status: 'pending',
    jobId,
    retrySequence: 0,
    logoPngKind: null,
    logoPngHash: null,
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
    particleV1Kind: null,
    particleV1Hash: null,
    effectStaticPngKind: null,
    effectStaticPngHash: null,
    normalizedWidth: null,
    normalizedHeight: null,
    particleCount: null,
    medianStroke: null,
    auraColor: null,
    enhancementErrorCode: null,
    errorCode: null,
    requestedBy: sourceRevision.requestedBy,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    retiredAt: null
  })
  return revisionId
}

const oldOutputBundle = `(
  ("logoPngKind" IS NOT NULL AND "logoPngHash" IS NOT NULL
    AND "particleV1Kind" IS NOT NULL AND "particleV1Hash" IS NOT NULL
    AND "effectStaticPngKind" IS NOT NULL AND "effectStaticPngHash" IS NOT NULL
    AND "logoPngKind" = 'logo-png' AND "logoPngHash" ~ '^[0-9a-f]{64}$'
    AND "particleV1Kind" = 'particle-v1' AND "particleV1Hash" ~ '^[0-9a-f]{64}$'
    AND "effectStaticPngKind" = 'effect-static-png' AND "effectStaticPngHash" ~ '^[0-9a-f]{64}$')
  OR ("logoPngKind" IS NULL AND "logoPngHash" IS NULL
    AND "particleV1Kind" IS NULL AND "particleV1Hash" IS NULL
    AND "effectStaticPngKind" IS NULL AND "effectStaticPngHash" IS NULL)
)`

const iconBundle = `(
  "logoPngKind" IS NOT NULL AND "logoPngHash" IS NOT NULL
  AND "logoPngKind" = 'logo-png' AND "logoPngHash" ~ '^[0-9a-f]{64}$'
  AND "iconPngKind" IS NOT NULL AND "iconPngKind" = 'icon-png'
  AND "favicon16Hash" IS NOT NULL AND "favicon16Hash" ~ '^[0-9a-f]{64}$'
  AND "favicon32Hash" IS NOT NULL AND "favicon32Hash" ~ '^[0-9a-f]{64}$'
  AND "tile150Hash" IS NOT NULL AND "tile150Hash" ~ '^[0-9a-f]{64}$'
  AND "apple180Hash" IS NOT NULL AND "apple180Hash" ~ '^[0-9a-f]{64}$'
  AND "app192Hash" IS NOT NULL AND "app192Hash" ~ '^[0-9a-f]{64}$'
  AND "app512Hash" IS NOT NULL AND "app512Hash" ~ '^[0-9a-f]{64}$'
  AND "maskable512Hash" IS NOT NULL AND "maskable512Hash" ~ '^[0-9a-f]{64}$'
  AND "faviconIcoKind" IS NOT NULL AND "faviconIcoKind" = 'favicon-ico'
  AND "faviconIcoHash" IS NOT NULL AND "faviconIcoHash" ~ '^[0-9a-f]{64}$'
)`

const effectBundle = `(
  "particleV1Kind" IS NOT NULL AND "particleV1Hash" IS NOT NULL
  AND "particleV1Kind" = 'particle-v1' AND "particleV1Hash" ~ '^[0-9a-f]{64}$'
  AND "effectStaticPngKind" IS NOT NULL AND "effectStaticPngHash" IS NOT NULL
  AND "effectStaticPngKind" = 'effect-static-png' AND "effectStaticPngHash" ~ '^[0-9a-f]{64}$'
  AND "normalizedWidth" IS NOT NULL AND "normalizedHeight" IS NOT NULL
  AND "particleCount" IS NOT NULL AND "medianStroke" IS NOT NULL
  AND ("auraColor" IS NULL OR "auraColor" ~ '^#[0-9a-f]{6}$')
)`

const noEffectBundle = `(
  "particleV1Kind" IS NULL AND "particleV1Hash" IS NULL
  AND "effectStaticPngKind" IS NULL AND "effectStaticPngHash" IS NULL
  AND "normalizedWidth" IS NULL AND "normalizedHeight" IS NULL
  AND "particleCount" IS NULL AND "medianStroke" IS NULL
  AND "auraColor" IS NULL
)`

const allDerivedNull = `(
  "logoPngKind" IS NULL AND "logoPngHash" IS NULL
  AND "iconPngKind" IS NULL
  AND "favicon16Hash" IS NULL AND "favicon32Hash" IS NULL
  AND "tile150Hash" IS NULL AND "apple180Hash" IS NULL
  AND "app192Hash" IS NULL AND "app512Hash" IS NULL
  AND "maskable512Hash" IS NULL
  AND "faviconIcoKind" IS NULL AND "faviconIcoHash" IS NULL
  AND "particleV1Kind" IS NULL AND "particleV1Hash" IS NULL
  AND "effectStaticPngKind" IS NULL AND "effectStaticPngHash" IS NULL
  AND "normalizedWidth" IS NULL AND "normalizedHeight" IS NULL
  AND "particleCount" IS NULL AND "medianStroke" IS NULL AND "auraColor" IS NULL
)`

const installWriterFences = async (transaction: Knex.Transaction): Promise<void> => {
  await transaction.raw(`
    CREATE OR REPLACE FUNCTION "${REVISION_WRITER_FENCE_FUNCTION}"() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW."pipelineVersion" < ${CURRENT_PIPELINE_VERSION} THEN
          RAISE EXCEPTION 'site-logo revisions below pipeline ${CURRENT_PIPELINE_VERSION} cannot be inserted after migration 000041'
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        IF NEW."pipelineVersion" < ${CURRENT_PIPELINE_VERSION} AND OLD."pipelineVersion" >= ${CURRENT_PIPELINE_VERSION} THEN
          RAISE EXCEPTION 'site-logo revisions cannot be downgraded below pipeline ${CURRENT_PIPELINE_VERSION} after migration 000041'
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."pipelineVersion" < ${CURRENT_PIPELINE_VERSION} AND OLD."status" <> 'ready' AND NEW."status" = 'ready' THEN
          RAISE EXCEPTION 'site-logo historical revisions cannot transition into ready after migration 000041'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)
  await transaction.raw(`DROP TRIGGER IF EXISTS "${REVISION_WRITER_FENCE_TRIGGER}" ON "${REVISIONS}"`)
  await transaction.raw(
    `CREATE TRIGGER "${REVISION_WRITER_FENCE_TRIGGER}" BEFORE INSERT OR UPDATE ON "${REVISIONS}" FOR EACH ROW EXECUTE FUNCTION "${REVISION_WRITER_FENCE_FUNCTION}"()`
  )

  await transaction.raw(`
    CREATE OR REPLACE FUNCTION "${STATE_WRITER_FENCE_FUNCTION}"() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW."desiredRevisionId" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "${REVISIONS}"
            WHERE "id" = NEW."desiredRevisionId" AND "pipelineVersion" < ${CURRENT_PIPELINE_VERSION}
          )
        THEN
          RAISE EXCEPTION 'site-logo desired revision cannot be newly pointed at a historical pipeline after migration 000041'
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."activeRevisionId" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "${REVISIONS}"
            WHERE "id" = NEW."activeRevisionId" AND "pipelineVersion" < ${CURRENT_PIPELINE_VERSION}
          )
        THEN
          RAISE EXCEPTION 'site-logo active revision cannot be newly pointed at a historical pipeline after migration 000041'
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        IF NEW."desiredRevisionId" IS DISTINCT FROM OLD."desiredRevisionId"
          AND NEW."desiredRevisionId" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "${REVISIONS}"
            WHERE "id" = NEW."desiredRevisionId" AND "pipelineVersion" < ${CURRENT_PIPELINE_VERSION}
          )
        THEN
          RAISE EXCEPTION 'site-logo desired revision cannot be changed to a historical pipeline after migration 000041'
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."activeRevisionId" IS DISTINCT FROM OLD."activeRevisionId"
          AND NEW."activeRevisionId" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "${REVISIONS}"
            WHERE "id" = NEW."activeRevisionId" AND "pipelineVersion" < ${CURRENT_PIPELINE_VERSION}
          )
        THEN
          RAISE EXCEPTION 'site-logo active revision cannot be changed to a historical pipeline after migration 000041'
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)
  await transaction.raw(`DROP TRIGGER IF EXISTS "${STATE_WRITER_FENCE_TRIGGER}" ON "${STATE}"`)
  await transaction.raw(
    `CREATE TRIGGER "${STATE_WRITER_FENCE_TRIGGER}" BEFORE INSERT OR UPDATE ON "${STATE}" FOR EACH ROW EXECUTE FUNCTION "${STATE_WRITER_FENCE_FUNCTION}"()`
  )
}

const migrateDesiredRevision = async (
  transaction: Knex.Transaction,
  desired: RevisionRow,
  now: Date
): Promise<{ revisionId: string | null; migrated: boolean }> => {
  if (desired.pipelineVersion >= CURRENT_PIPELINE_VERSION || desired.status === 'failed') return { revisionId: desired.id, migrated: false }
  const source = await lockSource(transaction, desired.sourceHash)
  if (!retainedSource(source, desired.sourceHash)) return { revisionId: desired.id, migrated: false }

  if (desired.status === 'pending' || desired.status === 'running') await retireLegacyWork(transaction, desired, now)
  else if (desired.status === 'ready') await retireReadyLegacyRevision(transaction, desired, now)

  const successorId = await createV7Successor(transaction, desired, now, null)
  return { revisionId: successorId, migrated: true }
}

const hasActiveRepair = async (transaction: Knex.Transaction, sourceHash: string, expectedActiveRevisionId: string): Promise<boolean> => {
  const candidates = (await transaction<RevisionRow>(REVISIONS)
    .where({ sourceHash, pipelineVersion: CURRENT_PIPELINE_VERSION })
    .whereIn('status', ['pending', 'running', 'ready'])
    .whereNull('retiredAt')
    .select('id', 'jobId')) as Array<RevisionRow & { jobId: string | null }>
  for (const candidate of candidates) {
    if (candidate.jobId === null) continue
    const job = await transaction<DurableJobRow>(JOBS).where({ id: candidate.jobId }).first('id', 'state', 'payload')
    if (!job || (job.state !== 'pending' && job.state !== 'running')) continue
    try {
      const payload: unknown = JSON.parse(job.payload)
      if (
        payload &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        (payload as Record<string, unknown>).revisionId === candidate.id &&
        (payload as Record<string, unknown>).retrySequence === 0 &&
        (payload as Record<string, unknown>).expectedActiveRevisionId === expectedActiveRevisionId
      ) {
        return true
      }
    } catch {
      // A malformed old job is not a valid repair candidate.
    }
  }
  return false
}

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(OBJECTS)) || !(await knex.schema.hasTable(REVISIONS)) || !(await knex.schema.hasTable(STATE))) return

  await knex.transaction(async transaction => {
    for (const constraint of [
      'site_logo_revisions_pipeline_check',
      'site_logo_revisions_output_bundle_check',
      'site_logo_revisions_legacy_bundle_check',
      'site_logo_revisions_outputs_ready_check',
      'site_logo_revisions_ready_metadata_check',
      'site_logo_revisions_v6_effect_bundle_check',
      'site_logo_revisions_enhancement_error_code_check',
      'site_logo_revisions_v6_enhancement_state_check'
    ]) {
      await dropConstraint(transaction, REVISIONS, constraint)
    }

    await addCheck(transaction, REVISIONS, 'site_logo_revisions_pipeline_check', `"pipelineVersion" BETWEEN 1 AND ${CURRENT_PIPELINE_VERSION}`)
    await addCheck(
      transaction,
      REVISIONS,
      'site_logo_revisions_legacy_bundle_check',
      `("pipelineVersion" BETWEEN 1 AND ${HISTORICAL_PIPELINE_MAX - 1} AND ${oldOutputBundle}) OR ("pipelineVersion" IN (${ICON_PIPELINE_VERSIONS.join(', ')}) AND (("status" = 'ready' AND ${iconBundle}) OR ("status" <> 'ready' AND ${allDerivedNull})))`
    )
    await addCheck(
      transaction,
      REVISIONS,
      'site_logo_revisions_v6_effect_bundle_check',
      `"pipelineVersion" NOT IN (${ICON_PIPELINE_VERSIONS.join(', ')}) OR "status" <> 'ready' OR ((${effectBundle}) OR (${noEffectBundle}))`
    )
    await addCheck(
      transaction,
      REVISIONS,
      'site_logo_revisions_ready_metadata_check',
      `("pipelineVersion" BETWEEN 1 AND ${HISTORICAL_PIPELINE_MAX - 1} AND (("status" = 'ready' AND "logoPngKind" IS NOT NULL AND "logoPngHash" IS NOT NULL AND "particleV1Kind" IS NOT NULL AND "particleV1Hash" IS NOT NULL AND "effectStaticPngKind" IS NOT NULL AND "effectStaticPngHash" IS NOT NULL AND "normalizedWidth" IS NOT NULL AND "normalizedHeight" IS NOT NULL AND "particleCount" IS NOT NULL AND "medianStroke" IS NOT NULL AND "completedAt" IS NOT NULL AND "errorCode" IS NULL) OR "status" <> 'ready'))
        OR ("pipelineVersion" IN (${ICON_PIPELINE_VERSIONS.join(', ')}) AND (("status" = 'ready' AND ${iconBundle} AND "completedAt" IS NOT NULL AND "errorCode" IS NULL AND (((${effectBundle}) AND "enhancementErrorCode" IS NULL) OR ((${noEffectBundle}) AND "enhancementErrorCode" IN (${ENHANCEMENT_ERROR_CODE_SQL})))) OR "status" <> 'ready'))`
    )
    await addCheck(
      transaction,
      REVISIONS,
      'site_logo_revisions_enhancement_error_code_check',
      `"enhancementErrorCode" IS NULL OR "enhancementErrorCode" IN (${ENHANCEMENT_ERROR_CODE_SQL})`
    )
    await addCheck(
      transaction,
      REVISIONS,
      'site_logo_revisions_v6_enhancement_state_check',
      `"pipelineVersion" NOT IN (${ICON_PIPELINE_VERSIONS.join(', ')}) OR ("status" <> 'ready' AND "enhancementErrorCode" IS NULL) OR ("status" = 'ready' AND (((${effectBundle}) AND "enhancementErrorCode" IS NULL) OR ((${noEffectBundle}) AND "enhancementErrorCode" IN (${ENHANCEMENT_ERROR_CODE_SQL}))))`
    )

    const state = await transaction<StateRow>(STATE).where({ id: 1 }).forUpdate().first()
    if (!state) {
      await installWriterFences(transaction)
      return
    }

    const active = await lockRevision(transaction, state.activeRevisionId)
    let desired = state.desiredRevisionId === state.activeRevisionId ? active : await lockRevision(transaction, state.desiredRevisionId)
    let desiredRevisionId = state.desiredRevisionId

    if (desired && desired.id !== state.activeRevisionId && desired.pipelineVersion < CURRENT_PIPELINE_VERSION && desired.status !== 'failed') {
      const migrated = await migrateDesiredRevision(transaction, desired, new Date())
      if (migrated.migrated && migrated.revisionId !== null) {
        desiredRevisionId = migrated.revisionId
        await transaction(STATE)
          .where({ id: 1 })
          .update({ generation: Number(state.generation) + 1, desiredRevisionId, updatedAt: new Date() })
        desired = await lockRevision(transaction, desiredRevisionId)
      }
    }

    const activeSource = active && active.pipelineVersion < CURRENT_PIPELINE_VERSION ? await lockSource(transaction, active.sourceHash) : undefined
    const activeCanBeRepaired =
      active !== undefined && active.pipelineVersion < CURRENT_PIPELINE_VERSION && retainedSource(activeSource, active.sourceHash) && active.status !== 'failed'

    if (activeCanBeRepaired && active) {
      const repairIsDesired =
        desiredRevisionId === null ||
        desiredRevisionId === active.id ||
        (desired !== undefined && desired.id !== active.id && desired.sourceHash === active.sourceHash && desired.status !== 'failed')
      const desiredIsTerminalCurrent = desired && desired.id !== active.id && desired.pipelineVersion >= CURRENT_PIPELINE_VERSION && desired.status === 'ready'
      const desiredAlreadyRepresentsRepair =
        repairIsDesired &&
        desired !== undefined &&
        desired.id !== active.id &&
        desired.sourceHash === active.sourceHash &&
        desired.pipelineVersion >= CURRENT_PIPELINE_VERSION &&
        (desired.status === 'pending' || desired.status === 'running')
      if (!desiredIsTerminalCurrent && !desiredAlreadyRepresentsRepair) {
        const expectedActiveRevisionId = repairIsDesired ? null : active.id
        if (!(await hasActiveRepair(transaction, active.sourceHash, active.id))) {
          const repairId = await createV7Successor(transaction, active, new Date(), expectedActiveRevisionId)
          if (repairIsDesired) {
            const latestState = await transaction<StateRow>(STATE).where({ id: 1 }).forUpdate().first()
            if (!latestState) throw new Error('Site logo singleton state is missing')
            await transaction(STATE)
              .where({ id: 1 })
              .update({ generation: Number(latestState.generation) + 1, desiredRevisionId: repairId, updatedAt: new Date() })
            desiredRevisionId = repairId
          }
        }
      }
    }

    await installWriterFences(transaction)
  })
}

export const down = async (): Promise<void> => {
  throw new Error('site-logo pipeline 7 migration is intentionally forward-only')
}
