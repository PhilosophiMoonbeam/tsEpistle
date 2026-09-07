import type { Knex } from 'knex'

export const up = async (db: Knex): Promise<void> => {
  await db.schema.createTable('utilitiesOperations', table => {
    table.uuid('id').primary()
    table.string('kind', 40).notNullable()
    table.string('state', 20).notNullable()
    table.string('phase', 20).notNullable()
    table.integer('actorId').nullable()
    table.integer('apiKeyId').nullable()
    table.text('reason').notNullable()
    table.string('reviewFingerprint', 64).notNullable()
    table.string('requestFingerprint', 64).notNullable()
    table.timestamp('createdAt', { useTz: true }).notNullable()
    table.timestamp('heartbeatAt', { useTz: true }).notNullable()
    table.timestamp('completedAt', { useTz: true }).nullable()
    table.timestamp('acknowledgedAt', { useTz: true }).nullable()
    table.uuid('acknowledgedByOperationId').nullable()
    table.integer('progress').nullable()
    table.text('summary').notNullable()
    table.jsonb('result').nullable()
    table.index(['createdAt', 'id'], 'utilities_operations_history')
    table.check(
      "kind IN ('auth-certificates','auth-guest-reset','cache-pages','cache-temporary-uploads','content-rebuild-tree','content-rerender','content-migrate-locale','content-purge-history','export','import-v1-users','import-v1-content','telemetry-save','telemetry-reset-client-id')",
      [],
      'utilities_operations_kind'
    )
    table.check("state IN ('running','succeeded','failed','uncertain')", [], 'utilities_operations_state')
    table.check("phase IN ('queued','reviewing','working','complete','interrupted')", [], 'utilities_operations_phase')
    table.check('(progress IS NULL OR (progress >= 0 AND progress <= 100))', [], 'utilities_operations_progress')
  })
  await db.raw('CREATE UNIQUE INDEX utilities_operations_single_active ON "utilitiesOperations" ((true)) WHERE state = \'running\'')
}

export const down = async (db: Knex): Promise<void> => {
  await db.transaction(async tx => {
    await tx.raw('LOCK TABLE "utilitiesOperations" IN ACCESS EXCLUSIVE MODE')
    if (await tx('utilitiesOperations').first('id')) throw new Error('Cannot discard recorded Utilities operations. Restore a backup or apply a forward fix.')
    await tx.schema.dropTable('utilitiesOperations')
  })
}
