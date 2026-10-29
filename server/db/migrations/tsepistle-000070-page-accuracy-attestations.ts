import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('pageAccuracyAttestations', table => {
    table.uuid('id').primary()
    table.integer('pageId').unsigned().notNullable().references('id').inTable('pages').onDelete('CASCADE')
    table.bigInteger('sourceRevision').notNullable()
    // Account removal must not erase a human's historical attestation.
    table.integer('verifiedBy').unsigned().nullable().references('id').inTable('users').onDelete('SET NULL')
    table.timestamp('verifiedAt', { useTz: true }).notNullable()
    table.check('?? > 0', ['sourceRevision'], 'page_accuracy_source_revision_check')
    table.index(['pageId', 'sourceRevision', 'verifiedAt', 'id'], 'page_accuracy_current_revision_idx')
  })
}

export const down = async (): Promise<void> => {
  throw new Error('Accuracy attestations are durable human records; fix forward instead of dropping their history.')
}
