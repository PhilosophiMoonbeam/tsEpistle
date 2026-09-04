import type { Knex } from 'knex'

const OBJECTS = 'siteLogoObjects'
const REVISIONS = 'siteLogoRevisions'
const STATE = 'siteLogoState'

export const up = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    await transaction.schema.createTable(OBJECTS, table => {
      table.string('kind', 32).notNullable()
      table.string('sha256', 64).notNullable()
      table.binary('bytes').notNullable()
      table.integer('byteLength').unsigned().notNullable()
      table.string('contentType', 64).notNullable()
      table.dateTime('createdAt').notNullable().defaultTo(transaction.fn.now())
      table.primary(['kind', 'sha256'], { constraintName: 'site_logo_objects_pk' })
      table.check(`"kind" IN ('source', 'logo-png', 'particle-v1', 'effect-static-png')`, undefined, 'site_logo_objects_kind_check')
      table.check(`"sha256" ~ '^[0-9a-f]{64}$'`, undefined, 'site_logo_objects_sha256_check')
      table.check(`"byteLength" = octet_length("bytes")`, undefined, 'site_logo_objects_length_check')
      table.check(
        `("kind" = 'source' AND "contentType" IN ('image/png', 'image/jpeg', 'image/webp') AND "byteLength" BETWEEN 1 AND 5242880)
          OR ("kind" = 'logo-png' AND "contentType" = 'image/png' AND "byteLength" BETWEEN 1 AND 524288)
          OR ("kind" = 'particle-v1' AND "contentType" = 'application/octet-stream' AND "byteLength" BETWEEN 68 AND 192056)
          OR ("kind" = 'effect-static-png' AND "contentType" = 'image/png' AND "byteLength" BETWEEN 1 AND 1048576)`,
        undefined,
        'site_logo_objects_role_check'
      )
    })

    await transaction.schema.createTable(REVISIONS, table => {
      table.uuid('id').notNullable()
      table.primary(['id'], { constraintName: 'site_logo_revisions_pk' })
      table.string('sourceKind', 32).notNullable().defaultTo('source')
      table.string('sourceHash', 64).notNullable()
      table.integer('pipelineVersion').unsigned().notNullable()
      table.string('status', 16).notNullable().defaultTo('pending')
      table.uuid('jobId').nullable().references('id').inTable('durableJobs').onDelete('SET NULL')
      table.integer('retrySequence').unsigned().notNullable().defaultTo(0)
      table.string('logoPngKind', 32).nullable()
      table.string('logoPngHash', 64).nullable()
      table.string('particleV1Kind', 32).nullable()
      table.string('particleV1Hash', 64).nullable()
      table.string('effectStaticPngKind', 32).nullable()
      table.string('effectStaticPngHash', 64).nullable()
      table.integer('normalizedWidth').unsigned().nullable()
      table.integer('normalizedHeight').unsigned().nullable()
      table.integer('particleCount').unsigned().nullable()
      table.double('medianStroke').nullable()
      table.string('auraColor', 7).nullable()
      table.string('errorCode', 64).nullable()
      table.integer('requestedBy').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
      table.dateTime('createdAt').notNullable().defaultTo(transaction.fn.now())
      table.dateTime('updatedAt').notNullable().defaultTo(transaction.fn.now())
      table.dateTime('startedAt').nullable()
      table.dateTime('completedAt').nullable()
      table.dateTime('retiredAt').nullable()

      table.foreign(['sourceKind', 'sourceHash'], 'site_logo_revisions_source_object_fk').references(['kind', 'sha256']).inTable(OBJECTS).onDelete('RESTRICT')
      table
        .foreign(['logoPngKind', 'logoPngHash'], 'site_logo_revisions_logo_png_object_fk')
        .references(['kind', 'sha256'])
        .inTable(OBJECTS)
        .onDelete('RESTRICT')
      table
        .foreign(['particleV1Kind', 'particleV1Hash'], 'site_logo_revisions_particle_v1_object_fk')
        .references(['kind', 'sha256'])
        .inTable(OBJECTS)
        .onDelete('RESTRICT')
      table
        .foreign(['effectStaticPngKind', 'effectStaticPngHash'], 'site_logo_revisions_effect_static_png_object_fk')
        .references(['kind', 'sha256'])
        .inTable(OBJECTS)
        .onDelete('RESTRICT')

      table.index(['sourceKind', 'sourceHash', 'pipelineVersion', 'status'], 'site_logo_revisions_source_lookup_idx')
      table.index(['status', 'createdAt'], 'site_logo_revisions_status_created_idx')
      table.index(['jobId'], 'site_logo_revisions_job_idx')
      table.index(['retiredAt'], 'site_logo_revisions_retired_idx')

      table.check(`"sourceKind" = 'source'`, undefined, 'site_logo_revisions_source_kind_check')
      table.check(`"sourceHash" ~ '^[0-9a-f]{64}$'`, undefined, 'site_logo_revisions_source_hash_check')
      table.check(`"pipelineVersion" > 0`, undefined, 'site_logo_revisions_pipeline_check')
      table.check(`"retrySequence" >= 0`, undefined, 'site_logo_revisions_retry_check')
      table.check(`"status" IN ('pending', 'running', 'ready', 'failed')`, undefined, 'site_logo_revisions_status_check')
      table.check(
        `("logoPngKind" IS NOT NULL AND "logoPngHash" IS NOT NULL
            AND "particleV1Kind" IS NOT NULL AND "particleV1Hash" IS NOT NULL
            AND "effectStaticPngKind" IS NOT NULL AND "effectStaticPngHash" IS NOT NULL
            AND "logoPngKind" = 'logo-png' AND "logoPngHash" ~ '^[0-9a-f]{64}$'
            AND "particleV1Kind" = 'particle-v1' AND "particleV1Hash" ~ '^[0-9a-f]{64}$'
            AND "effectStaticPngKind" = 'effect-static-png' AND "effectStaticPngHash" ~ '^[0-9a-f]{64}$')
          OR ("logoPngKind" IS NULL AND "logoPngHash" IS NULL
            AND "particleV1Kind" IS NULL AND "particleV1Hash" IS NULL
            AND "effectStaticPngKind" IS NULL AND "effectStaticPngHash" IS NULL)`,
        undefined,
        'site_logo_revisions_output_bundle_check'
      )
      table.check(
        `"status" = 'ready'
          OR ("logoPngKind" IS NULL AND "logoPngHash" IS NULL
            AND "particleV1Kind" IS NULL AND "particleV1Hash" IS NULL
            AND "effectStaticPngKind" IS NULL AND "effectStaticPngHash" IS NULL)`,
        undefined,
        'site_logo_revisions_outputs_ready_check'
      )
      table.check(
        `("status" = 'ready'
            AND "logoPngKind" IS NOT NULL AND "logoPngHash" IS NOT NULL
            AND "particleV1Kind" IS NOT NULL AND "particleV1Hash" IS NOT NULL
            AND "effectStaticPngKind" IS NOT NULL AND "effectStaticPngHash" IS NOT NULL
            AND "normalizedWidth" IS NOT NULL AND "normalizedHeight" IS NOT NULL
            AND "particleCount" IS NOT NULL AND "medianStroke" IS NOT NULL
            AND "completedAt" IS NOT NULL AND "errorCode" IS NULL)
          OR ("status" <> 'ready'
            AND "logoPngKind" IS NULL AND "logoPngHash" IS NULL
            AND "particleV1Kind" IS NULL AND "particleV1Hash" IS NULL
            AND "effectStaticPngKind" IS NULL AND "effectStaticPngHash" IS NULL)`,
        undefined,
        'site_logo_revisions_ready_metadata_check'
      )
      table.check(`"normalizedWidth" IS NULL OR "normalizedWidth" BETWEEN 2 AND 4096`, undefined, 'site_logo_revisions_width_check')
      table.check(`"normalizedHeight" IS NULL OR "normalizedHeight" BETWEEN 2 AND 4096`, undefined, 'site_logo_revisions_height_check')
      table.check(`"particleCount" IS NULL OR "particleCount" BETWEEN 1 AND 16000`, undefined, 'site_logo_revisions_particle_count_check')
      table.check(`"medianStroke" IS NULL OR "medianStroke" > 0`, undefined, 'site_logo_revisions_median_stroke_check')
      table.check(`"auraColor" IS NULL OR "auraColor" ~ '^#[0-9a-f]{6}$'`, undefined, 'site_logo_revisions_aura_color_check')
      table.check(
        `"errorCode" IS NULL OR "errorCode" IN ('UNSUPPORTED_IMAGE', 'IMAGE_TOO_LARGE', 'INVALID_IMAGE', 'NO_VISIBLE_PIXELS', 'UNSUITABLE_LOGO', 'PROCESSING_FAILED', 'ARTIFACT_TOO_LARGE')`,
        undefined,
        'site_logo_revisions_error_code_check'
      )
      table.check(
        `("status" = 'failed' AND "errorCode" IS NOT NULL AND "completedAt" IS NOT NULL)
          OR ("status" <> 'failed' AND "errorCode" IS NULL)`,
        undefined,
        'site_logo_revisions_failed_state_check'
      )
      table.check(`"status" = 'pending' OR "startedAt" IS NOT NULL`, undefined, 'site_logo_revisions_started_check')
      table.check(`"completedAt" IS NULL OR "status" IN ('ready', 'failed')`, undefined, 'site_logo_revisions_completed_check')
      table.check(`"retiredAt" IS NULL OR "status" IN ('ready', 'failed')`, undefined, 'site_logo_revisions_retired_check')
    })

    await transaction.schema.createTable(STATE, table => {
      table.integer('id').notNullable().defaultTo(1)
      table.primary(['id'], { constraintName: 'site_logo_state_pk' })
      table.integer('generation').unsigned().notNullable().defaultTo(0)
      table.uuid('desiredRevisionId').nullable().references('id').inTable(REVISIONS).onDelete('RESTRICT')
      table.uuid('activeRevisionId').nullable().references('id').inTable(REVISIONS).onDelete('RESTRICT')
      table.dateTime('createdAt').notNullable().defaultTo(transaction.fn.now())
      table.dateTime('updatedAt').notNullable().defaultTo(transaction.fn.now())
      table.check('"id" = 1', undefined, 'site_logo_state_singleton_check')
      table.check('"generation" >= 0', undefined, 'site_logo_state_generation_check')
    })

    await transaction(STATE).insert({ id: 1 })
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    await transaction.schema.dropTableIfExists(STATE)
    await transaction.schema.dropTableIfExists(REVISIONS)
    await transaction.schema.dropTableIfExists(OBJECTS)
  })
}
