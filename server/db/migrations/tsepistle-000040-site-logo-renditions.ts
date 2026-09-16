import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'

import {
  SITE_LOGO_FAVICON_ICO_BYTE_LIMIT,
  SITE_LOGO_ICON_PNG_BYTE_LIMIT,
  SITE_LOGO_PNG_BYTE_LIMIT,
  SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT,
  SITE_LOGO_SOURCE_BYTE_LIMIT,
  SITE_LOGO_STATIC_PNG_BYTE_LIMIT
} from '../../../shared/site-logo.ts'

const HISTORICAL_PIPELINE_VERSION = 6 as const
const HISTORICAL_JOB_VERSION = 4 as const

const OBJECTS = 'siteLogoObjects'
const REVISIONS = 'siteLogoRevisions'
const STATE = 'siteLogoState'
const JOBS = 'durableJobs'

const ENHANCEMENT_ERROR_CODES = ['UNSUITABLE_LOGO', 'ARTIFACT_TOO_LARGE', 'PROCESSING_FAILED'] as const
const ENHANCEMENT_ERROR_CODE_SQL = ENHANCEMENT_ERROR_CODES.map(code => `'${code}'`).join(', ')
const LEGACY_PIPELINE_VERSIONS = [1, 2, 3, 4, 5] as const
const PNG_CONTENT_TYPE = 'image/png'
const ICO_CONTENT_TYPE = 'image/x-icon'
const SUPERSEDED_JOB_ERROR = 'Superseded by site-logo pipeline 6'
const REVISION_WRITER_FENCE_FUNCTION = 'site_logo_revision_writer_fence'
const REVISION_WRITER_FENCE_TRIGGER = 'site_logo_revision_writer_fence_trigger'
const STATE_WRITER_FENCE_FUNCTION = 'site_logo_state_writer_fence'
const STATE_WRITER_FENCE_TRIGGER = 'site_logo_state_writer_fence_trigger'

interface RevisionSource {
  id: string
  sourceKind: string
  sourceHash: string
  requestedBy: number | null
}

interface StateRow {
  id: number
  desiredRevisionId: string | null
  activeRevisionId: string | null
}

const dropConstraint = async (transaction: Knex.Transaction, table: string, name: string): Promise<void> => {
  await transaction.raw(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${name}"`)
}

const addCheck = async (transaction: Knex.Transaction, table: string, name: string, expression: string): Promise<void> => {
  await transaction.raw(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK (${expression})`)
}
const addForeignKey = async (transaction: Knex.Transaction, name: string, columns: readonly string[]): Promise<void> => {
  const quotedColumns = columns.map(column => `"${column}"`).join(', ')
  await transaction.raw(
    `ALTER TABLE "${REVISIONS}" ADD CONSTRAINT "${name}" FOREIGN KEY (${quotedColumns}) REFERENCES "${OBJECTS}" ("kind", "sha256") ON DELETE RESTRICT`
  )
}
const installWriterFences = async (transaction: Knex.Transaction): Promise<void> => {
  await transaction.raw(`
    CREATE OR REPLACE FUNCTION "${REVISION_WRITER_FENCE_FUNCTION}"() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF NEW."pipelineVersion" < 6 THEN
          RAISE EXCEPTION 'site-logo revisions below pipeline 6 cannot be inserted after migration 000040'
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        IF NEW."pipelineVersion" < 6 AND OLD."pipelineVersion" >= 6 THEN
          RAISE EXCEPTION 'site-logo revisions cannot be downgraded below pipeline 6 after migration 000040'
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."pipelineVersion" < 6 AND OLD."status" <> 'ready' AND NEW."status" = 'ready' THEN
          RAISE EXCEPTION 'site-logo legacy revisions cannot transition into ready after migration 000040'
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
            WHERE "id" = NEW."desiredRevisionId" AND "pipelineVersion" < 6
          )
        THEN
          RAISE EXCEPTION 'site-logo desired revision cannot point to a legacy pipeline after migration 000040'
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."activeRevisionId" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "${REVISIONS}"
            WHERE "id" = NEW."activeRevisionId" AND "pipelineVersion" < 6
          )
        THEN
          RAISE EXCEPTION 'site-logo active revision cannot point to a legacy pipeline after migration 000040'
            USING ERRCODE = 'check_violation';
        END IF;
      ELSE
        IF NEW."desiredRevisionId" IS DISTINCT FROM OLD."desiredRevisionId"
          AND NEW."desiredRevisionId" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "${REVISIONS}"
            WHERE "id" = NEW."desiredRevisionId" AND "pipelineVersion" < 6
          )
        THEN
          RAISE EXCEPTION 'site-logo desired revision cannot point to a legacy pipeline after migration 000040'
            USING ERRCODE = 'check_violation';
        END IF;
        IF NEW."activeRevisionId" IS DISTINCT FROM OLD."activeRevisionId"
          AND NEW."activeRevisionId" IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM "${REVISIONS}"
            WHERE "id" = NEW."activeRevisionId" AND "pipelineVersion" < 6
          )
        THEN
          RAISE EXCEPTION 'site-logo active revision cannot point to a legacy pipeline after migration 000040'
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

const v6OrdinaryBundle = `(
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
const v6EffectBundle = `(
  "particleV1Kind" IS NOT NULL AND "particleV1Hash" IS NOT NULL
  AND "particleV1Kind" = 'particle-v1' AND "particleV1Hash" ~ '^[0-9a-f]{64}$'
  AND "effectStaticPngKind" IS NOT NULL AND "effectStaticPngHash" IS NOT NULL
  AND "effectStaticPngKind" = 'effect-static-png' AND "effectStaticPngHash" ~ '^[0-9a-f]{64}$'
  AND "normalizedWidth" IS NOT NULL AND "normalizedHeight" IS NOT NULL
  AND "particleCount" IS NOT NULL AND "medianStroke" IS NOT NULL
  AND ("auraColor" IS NULL OR "auraColor" ~ '^#[0-9a-f]{6}$')
)`
const v6NoEffectBundle = `(
  "particleV1Kind" IS NULL AND "particleV1Hash" IS NULL
  AND "effectStaticPngKind" IS NULL AND "effectStaticPngHash" IS NULL
  AND "normalizedWidth" IS NULL AND "normalizedHeight" IS NULL
  AND "particleCount" IS NULL AND "medianStroke" IS NULL
  AND "auraColor" IS NULL
)`

const v6AllDerivedNull = `(
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

export const up = async (knex: Knex): Promise<void> => {
  if (!(await knex.schema.hasTable(OBJECTS)) || !(await knex.schema.hasTable(REVISIONS)) || !(await knex.schema.hasTable(STATE))) return

  await knex.transaction(async transaction => {
    const revisionColumns: ReadonlyArray<[string, (table: Knex.CreateTableBuilder) => void]> = [
      ['iconPngKind', table => table.string('iconPngKind', 32).nullable()],
      ['favicon16Hash', table => table.string('favicon16Hash', 64).nullable()],
      ['favicon32Hash', table => table.string('favicon32Hash', 64).nullable()],
      ['tile150Hash', table => table.string('tile150Hash', 64).nullable()],
      ['apple180Hash', table => table.string('apple180Hash', 64).nullable()],
      ['app192Hash', table => table.string('app192Hash', 64).nullable()],
      ['app512Hash', table => table.string('app512Hash', 64).nullable()],
      ['maskable512Hash', table => table.string('maskable512Hash', 64).nullable()],
      ['faviconIcoKind', table => table.string('faviconIcoKind', 32).nullable()],
      ['faviconIcoHash', table => table.string('faviconIcoHash', 64).nullable()],
      ['enhancementErrorCode', table => table.string('enhancementErrorCode', 64).nullable()]
    ]
    for (const [column, definition] of revisionColumns) {
      if (!(await transaction.schema.hasColumn(REVISIONS, column))) await transaction.schema.alterTable(REVISIONS, definition)
    }

    await dropConstraint(transaction, OBJECTS, 'site_logo_objects_kind_check')
    await dropConstraint(transaction, OBJECTS, 'site_logo_objects_role_check')
    await addCheck(
      transaction,
      OBJECTS,
      'site_logo_objects_kind_check',
      `"kind" IN ('source', 'logo-png', 'particle-v1', 'effect-static-png', 'icon-png', 'favicon-ico')`
    )
    await addCheck(
      transaction,
      OBJECTS,
      'site_logo_objects_role_check',
      `("kind" = 'source' AND "contentType" IN ('image/png', 'image/jpeg', 'image/webp') AND "byteLength" BETWEEN 1 AND ${SITE_LOGO_SOURCE_BYTE_LIMIT})
        OR ("kind" = 'logo-png' AND "contentType" = '${PNG_CONTENT_TYPE}' AND "byteLength" BETWEEN 1 AND ${SITE_LOGO_PNG_BYTE_LIMIT})
        OR ("kind" = 'icon-png' AND "contentType" = '${PNG_CONTENT_TYPE}' AND "byteLength" BETWEEN 1 AND ${SITE_LOGO_ICON_PNG_BYTE_LIMIT})
        OR ("kind" = 'favicon-ico' AND "contentType" = '${ICO_CONTENT_TYPE}' AND "byteLength" BETWEEN 1 AND ${SITE_LOGO_FAVICON_ICO_BYTE_LIMIT})
        OR ("kind" = 'particle-v1' AND "contentType" = 'application/octet-stream' AND "byteLength" BETWEEN 68 AND ${SITE_LOGO_PARTICLE_RAW_BYTE_LIMIT})
        OR ("kind" = 'effect-static-png' AND "contentType" = '${PNG_CONTENT_TYPE}' AND "byteLength" BETWEEN 1 AND ${SITE_LOGO_STATIC_PNG_BYTE_LIMIT})`
    )

    for (const constraint of [
      'site_logo_revisions_pipeline_check',
      'site_logo_revisions_output_bundle_check',
      'site_logo_revisions_outputs_ready_check',
      'site_logo_revisions_ready_metadata_check'
    ]) {
      await dropConstraint(transaction, REVISIONS, constraint)
    }

    await addCheck(transaction, REVISIONS, 'site_logo_revisions_pipeline_check', '"pipelineVersion" BETWEEN 1 AND 6')
    await addCheck(
      transaction,
      REVISIONS,
      'site_logo_revisions_legacy_bundle_check',
      `("pipelineVersion" BETWEEN 1 AND 5 AND ${oldOutputBundle}) OR ("pipelineVersion" = 6 AND (("status" = 'ready' AND ${v6OrdinaryBundle}) OR ("status" <> 'ready' AND ${v6AllDerivedNull})))`
    )
    await addCheck(
      transaction,
      REVISIONS,
      'site_logo_revisions_v6_effect_bundle_check',
      `"pipelineVersion" <> 6 OR "status" <> 'ready' OR ((${v6EffectBundle}) OR (${v6NoEffectBundle}))`
    )
    await addCheck(
      transaction,
      REVISIONS,
      'site_logo_revisions_ready_metadata_check',
      `("pipelineVersion" BETWEEN 1 AND 5 AND (("status" = 'ready' AND "logoPngKind" IS NOT NULL AND "logoPngHash" IS NOT NULL AND "particleV1Kind" IS NOT NULL AND "particleV1Hash" IS NOT NULL AND "effectStaticPngKind" IS NOT NULL AND "effectStaticPngHash" IS NOT NULL AND "normalizedWidth" IS NOT NULL AND "normalizedHeight" IS NOT NULL AND "particleCount" IS NOT NULL AND "medianStroke" IS NOT NULL AND "completedAt" IS NOT NULL AND "errorCode" IS NULL) OR "status" <> 'ready'))\n        OR ("pipelineVersion" = 6 AND (("status" = 'ready' AND ${v6OrdinaryBundle} AND "completedAt" IS NOT NULL AND "errorCode" IS NULL AND (((${v6EffectBundle}) AND "enhancementErrorCode" IS NULL) OR ((${v6NoEffectBundle}) AND "enhancementErrorCode" IN (${ENHANCEMENT_ERROR_CODE_SQL})))) OR "status" <> 'ready'))`
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
      `"pipelineVersion" <> 6 OR ("status" <> 'ready' AND "enhancementErrorCode" IS NULL) OR ("status" = 'ready' AND (((${v6EffectBundle}) AND "enhancementErrorCode" IS NULL) OR ((${v6NoEffectBundle}) AND "enhancementErrorCode" IN (${ENHANCEMENT_ERROR_CODE_SQL}))))`
    )

    for (const [name, columns] of [
      ['site_logo_revisions_icon_favicon16_object_fk', ['iconPngKind', 'favicon16Hash']],
      ['site_logo_revisions_icon_favicon32_object_fk', ['iconPngKind', 'favicon32Hash']],
      ['site_logo_revisions_icon_tile150_object_fk', ['iconPngKind', 'tile150Hash']],
      ['site_logo_revisions_icon_apple180_object_fk', ['iconPngKind', 'apple180Hash']],
      ['site_logo_revisions_icon_app192_object_fk', ['iconPngKind', 'app192Hash']],
      ['site_logo_revisions_icon_app512_object_fk', ['iconPngKind', 'app512Hash']],
      ['site_logo_revisions_icon_maskable512_object_fk', ['iconPngKind', 'maskable512Hash']],
      ['site_logo_revisions_favicon_ico_object_fk', ['faviconIcoKind', 'faviconIcoHash']]
    ] as const) {
      await dropConstraint(transaction, REVISIONS, name)
      await addForeignKey(transaction, name, columns)
    }

    const now = new Date()
    const state = (await transaction<StateRow>(STATE).where({ id: 1 }).forUpdate().first()) ?? null
    if (state) {
      const sourceRevisionIds = [state.desiredRevisionId, state.activeRevisionId].filter((id): id is string => id !== null)
      const sourceRevisions = sourceRevisionIds.length ? await transaction<RevisionSource>(REVISIONS).whereIn('id', sourceRevisionIds).forUpdate() : []
      const sourceHashes = sourceRevisions.map(revision => revision.sourceHash)
      const sourceObjects: Array<{ sha256: string }> = sourceHashes.length
        ? ((await transaction(OBJECTS).where('kind', 'source').whereIn('sha256', sourceHashes).select('sha256')) as Array<{ sha256: string }>)
        : []
      const retainedHashes = new Set(sourceObjects.map(object => String(object.sha256)))
      const byId = new Map(sourceRevisions.map(revision => [revision.id, revision]))
      const desired = state.desiredRevisionId ? byId.get(state.desiredRevisionId) : undefined
      const active = state.activeRevisionId ? byId.get(state.activeRevisionId) : undefined
      const selected = desired && retainedHashes.has(desired.sourceHash) ? desired : active && retainedHashes.has(active.sourceHash) ? active : undefined

      const legacyWork = (await transaction(REVISIONS)
        .whereIn('pipelineVersion', LEGACY_PIPELINE_VERSIONS)
        .whereIn('status', ['pending', 'running'])
        .modify(query => {
          if (state.activeRevisionId !== null) query.whereNot('id', state.activeRevisionId)
        })
        .forUpdate()
        .select('id', 'jobId')) as Array<{ id: string; jobId: string | null }>
      const legacyJobIds = legacyWork.map(row => row.jobId).filter((jobId): jobId is string => typeof jobId === 'string')
      if (legacyJobIds.length > 0) {
        await transaction(JOBS).whereIn('id', legacyJobIds).whereIn('state', ['pending', 'running']).update({
          state: 'cancelled',
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          lastError: SUPERSEDED_JOB_ERROR,
          completedAt: now,
          updatedAt: now
        })
      }
      const legacyRevisionIds = legacyWork.map(row => row.id)
      if (legacyRevisionIds.length > 0) {
        await transaction(REVISIONS).whereIn('id', legacyRevisionIds).update({
          status: 'failed',
          errorCode: 'PROCESSING_FAILED',
          completedAt: now,
          retiredAt: now,
          updatedAt: now
        })
      }

      if (selected) {
        const revisionId = randomUUID()
        const jobId = randomUUID()
        await transaction(JOBS).insert({
          id: jobId,
          type: 'process-site-logo',
          version: HISTORICAL_JOB_VERSION,
          payload: JSON.stringify({ revisionId, retrySequence: 0 }),
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
          sourceKind: selected.sourceKind,
          sourceHash: selected.sourceHash,
          pipelineVersion: HISTORICAL_PIPELINE_VERSION,
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
          errorCode: null,
          enhancementErrorCode: null,
          requestedBy: selected.requestedBy,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          completedAt: null,
          retiredAt: null
        })
        await transaction(STATE).where({ id: 1 }).update({ desiredRevisionId: revisionId, updatedAt: now })
      }
    }
    await installWriterFences(transaction)
  })
}

export const down = async (): Promise<void> => {
  throw new Error('site-logo pipeline 6 migration is intentionally forward-only')
}
