import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('pageLifecycleClocks', table => {
    table.integer('pageId').unsigned().primary().references('id').inTable('pages').onDelete('CASCADE')
    table.uuid('bodyEpoch').notNullable(); table.timestamp('bodyAnchorAt', { useTz: true }).nullable(); table.string('bodyAnchorKind', 24).notNullable()
    table.string('bodyDigest', 64).notNullable(); table.bigInteger('bodyObservedSourceRevision').notNullable()
    table.uuid('commentEpoch').notNullable(); table.timestamp('commentAnchorAt', { useTz: true }).nullable(); table.string('commentAnchorKind', 24).notNullable()
    table.string('lastCommentEvent', 128).nullable()
    table.check("?? IN ('known-change','observed-baseline','unknown')", ['bodyAnchorKind'])
    table.check("?? IN ('known-change','observed-baseline','unknown')", ['commentAnchorKind'])
  })
  // Historical exact activity cannot be inferred from updatedAt or a previous history row.
  // Keyset batches preserve source/history/ownership; the migration never backdates anchors.
  let afterId = 0
  for (;;) {
    const pages = await knex<{ id: number; content: string; contentType: string; sourceRevision: string | number }>('pages').where('id', '>', afterId).select('id', 'content', 'contentType', 'sourceRevision').orderBy('id').limit(100)
    if (pages.length === 0) break
    await knex('pageLifecycleClocks').insert(pages.map(page => {
      const contentType = Buffer.from(page.contentType, 'utf8')
      const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(contentType.length))
      return { pageId: page.id, bodyEpoch: randomUUID(), bodyAnchorAt: null, bodyAnchorKind: 'unknown', bodyDigest: createHash('sha256').update(length).update(contentType).update(page.content, 'utf8').digest('hex'), bodyObservedSourceRevision: page.sourceRevision, commentEpoch: randomUUID(), commentAnchorAt: null, commentAnchorKind: 'unknown', lastCommentEvent: null }
    }))
    afterId = pages.at(-1)!.id
  }
  await knex.schema.createTable('pageLifecycleCommentEvents', table => {
    table.integer('pageId').unsigned().notNullable().references('id').inTable('pages').onDelete('CASCADE')
    table.string('eventId', 128).notNullable()
    table.primary(['pageId', 'eventId'])
  })
  await knex.schema.createTable('pageLifecycleRules', table => {
    table.uuid('id').primary(); table.integer('version').notNullable(); table.integer('revision').notNullable()
    table.integer('humanOwnerId').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
    table.integer('authVersion').notNullable(); table.boolean('unattendedConsent').notNullable().defaultTo(false)
    table.jsonb('definition').notNullable(); table.string('status', 24).notNullable(); table.string('reason', 80).nullable()
    table.string('selectorFingerprint', 64).notNullable(); table.jsonb('selectedPages').notNullable()
    table.uuid('executionId').nullable(); table.uuid('currentBatchId').nullable()
    table.timestamp('createdAt', { useTz: true }).notNullable(); table.timestamp('updatedAt', { useTz: true }).notNullable()
    table.timestamp('retiredAt', { useTz: true }).nullable(); table.timestamp('lastScannedAt', { useTz: true }).nullable()
    table.index(['status', 'lastScannedAt', 'id']); table.index(['humanOwnerId', 'status'])
    table.check('?? = 1 AND ?? > 0', ['version', 'revision'])
  })
  await knex.schema.createTable('pageLifecyclePreviews', table => {
    table.uuid('id').primary(); table.integer('actorId').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
    table.uuid('ruleId').nullable(); table.integer('ruleRevision').nullable(); table.integer('authVersion').notNullable()
    table.string('fingerprint', 64).notNullable(); table.jsonb('request').notNullable(); table.jsonb('pages').notNullable()
    table.timestamp('createdAt', { useTz: true }).notNullable(); table.timestamp('expiresAt', { useTz: true }).notNullable()
    table.timestamp('consumedAt', { useTz: true }).nullable(); table.index(['expiresAt'])
  })
  await knex.schema.createTable('pageLifecycleRulePages', table => {
    table.uuid('ruleId').notNullable().references('id').inTable('pageLifecycleRules').onDelete('RESTRICT')
    // Audit identity remains after native page deletion; no FK may erase consumption/origin.
    table.integer('pageId').unsigned().notNullable(); table.text('originalRelativePath').notNullable(); table.string('originalLocale', 32).notNullable()
    table.uuid('consumedBodyEpoch').nullable(); table.uuid('consumedCommentEpoch').nullable(); table.bigInteger('intervalHighWater').notNullable().defaultTo(-1)
    table.integer('attemptedRevision').notNullable().defaultTo(0)
    table.uuid('attemptedBodyEpoch').nullable(); table.uuid('attemptedCommentEpoch').nullable()
    table.bigInteger('attemptedIntervalHighWater').notNullable().defaultTo(-1)
    table.uuid('lastExecutionId').nullable(); table.timestamp('updatedAt', { useTz: true }).notNullable()
    table.primary(['ruleId', 'pageId'])
  })
  await knex.schema.createTable('pageLifecycleBatches', table => {
    table.uuid('id').primary(); table.uuid('ruleId').notNullable().references('id').inTable('pageLifecycleRules').onDelete('RESTRICT')
    table.integer('ruleRevision').notNullable(); table.jsonb('pages').notNullable(); table.integer('scheduledCount').notNullable().defaultTo(0)
    table.string('status', 24).notNullable(); table.timestamp('createdAt', { useTz: true }).notNullable(); table.timestamp('completedAt', { useTz: true }).nullable()
    table.index(['ruleId', 'status'])
  })
  await knex.schema.createTable('pageLifecycleCycles', table => {
    table.uuid('id').primary(); table.uuid('ruleId').notNullable().references('id').inTable('pageLifecycleRules').onDelete('RESTRICT')
    table.uuid('batchId').notNullable().references('id').inTable('pageLifecycleBatches').onDelete('RESTRICT')
    table.integer('ruleRevision').notNullable(); table.integer('pageId').unsigned().notNullable(); table.string('conditionKey', 100).notNullable()
    table.uuid('executionKey').notNullable(); table.uuid('conditionEpoch').nullable(); table.bigInteger('cycleNo').nullable(); table.bigInteger('coalescedFrom').nullable(); table.bigInteger('coalescedThrough').nullable()
    table.timestamp('dueAt', { useTz: true }).notNullable(); table.bigInteger('selectedSourceRevision').notNullable(); table.bigInteger('nextExpectedSourceRevision').notNullable()
    table.string('selectorFingerprint', 64).notNullable(); table.string('status', 24).notNullable(); table.string('reason', 80).nullable(); table.uuid('jobId').nullable()
    table.timestamp('createdAt', { useTz: true }).notNullable(); table.timestamp('updatedAt', { useTz: true }).notNullable(); table.timestamp('completedAt', { useTz: true }).nullable()
    table.unique(['ruleId', 'ruleRevision', 'pageId', 'conditionKey', 'executionKey'], { indexName: 'page_lifecycle_cycle_identity' }); table.index(['batchId', 'status']); table.index(['completedAt'])
  })
  await knex.schema.createTable('pageLifecycleActionReceipts', table => {
    table.uuid('cycleId').notNullable().references('id').inTable('pageLifecycleCycles').onDelete('CASCADE'); table.integer('effectIndex').notNullable()
    table.string('kind', 24).notNullable(); table.string('state', 24).notNullable(); table.string('reason', 80).nullable()
    table.bigInteger('beforeSourceRevision').notNullable(); table.bigInteger('afterSourceRevision').notNullable(); table.uuid('operationId').nullable(); table.uuid('proposalId').nullable(); table.uuid('outboxId').nullable()
    table.timestamp('createdAt', { useTz: true }).notNullable(); table.timestamp('updatedAt', { useTz: true }).notNullable(); table.primary(['cycleId', 'effectIndex'])
  })
  await knex.schema.createTable('pageLifecycleNotices', table => {
    table.uuid('ruleId').notNullable().references('id').inTable('pageLifecycleRules').onDelete('RESTRICT')
    table.integer('pageId').unsigned().notNullable().references('id').inTable('pages').onDelete('CASCADE'); table.text('text').notNullable()
    table.timestamp('createdAt', { useTz: true }).notNullable(); table.timestamp('updatedAt', { useTz: true }).notNullable(); table.primary(['ruleId', 'pageId'])
  })
  await knex.schema.createTable('pageLifecycleMoveProposals', table => {
    table.uuid('id').primary(); table.uuid('ruleId').notNullable().references('id').inTable('pageLifecycleRules').onDelete('RESTRICT')
    table.uuid('cycleId').notNullable().references('id').inTable('pageLifecycleCycles').onDelete('RESTRICT'); table.integer('effectIndex').notNullable(); table.integer('ruleRevision').notNullable()
    table.integer('pageId').unsigned().notNullable(); table.bigInteger('sourceRevision').notNullable(); table.text('sourcePath').notNullable(); table.string('sourceLocale', 32).notNullable()
    table.text('destinationPath').notNullable(); table.string('destinationLocale', 32).notNullable(); table.string('selectorFingerprint', 64).notNullable()
    table.string('status', 24).notNullable(); table.string('reason', 80).nullable(); table.bigInteger('resultSourceRevision').nullable()
    table.integer('fulfilledBy').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL'); table.uuid('outboxId').nullable()
    table.timestamp('createdAt', { useTz: true }).notNullable(); table.timestamp('expiresAt', { useTz: true }).notNullable(); table.timestamp('settledAt', { useTz: true }).nullable()
    table.unique(['cycleId', 'effectIndex']); table.index(['ruleId', 'pageId', 'status']); table.index(['expiresAt'])
  })
}

export const down = async (): Promise<void> => {
  throw new Error('Lifecycle clocks, consumed epochs and human move receipts are durable; fix forward without erasing their provenance.')
}
