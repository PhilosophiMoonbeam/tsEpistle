import type { Knex } from 'knex'

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('pageCreationReceipts', table => {
    table.integer('ownerId').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.uuid('requestId').notNullable()
    // Deliberately no page/note foreign key: deletion must not erase committed proof
    // or change the immutable destination/source identities.
    table.integer('pageId').unsigned().notNullable()
    table.bigInteger('sourceRevision').notNullable()
    table.string('originKind', 16).nullable()
    table.uuid('originId').nullable()
    table.bigInteger('originRevision').nullable()
    table.uuid('originSessionId').nullable()
    table.timestamp('createdAt', { useTz: true }).notNullable()
    table.primary(['ownerId', 'requestId'])
    table.index(['ownerId', 'originKind', 'originId', 'requestId'], 'page_creation_origin_inventory_idx')
    table.check('?? > 0', ['sourceRevision'], 'page_creation_source_revision_check')
    table.check(
      "(?? IS NULL AND ?? IS NULL AND ?? IS NULL AND ?? IS NULL) OR (?? IS NOT NULL AND ?? = 'live-note' AND ?? IS NOT NULL AND ?? IS NOT NULL AND ?? >= 0 AND ?? <= 9007199254740991 AND ?? IS NULL) OR (?? IS NOT NULL AND ?? = 'agent-answer' AND ?? IS NOT NULL AND ?? IS NOT NULL AND ?? IS NULL)",
      [
        'originKind',
        'originId',
        'originRevision',
        'originSessionId',
        'originKind',
        'originKind',
        'originId',
        'originRevision',
        'originRevision',
        'originRevision',
        'originSessionId',
        'originKind',
        'originKind',
        'originId',
        'originSessionId',
        'originRevision'
      ],
      'page_creation_origin_check'
    )
  })
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.transaction(async tx => {
    if (knex.client.config.client === 'pg') await tx.raw('LOCK TABLE "pageCreationReceipts" IN ACCESS EXCLUSIVE MODE')
    if (await tx('pageCreationReceipts').first('requestId')) {
      throw new Error('Page creation receipts contain authoritative success records; fix forward instead of dropping user data.')
    }
    await tx.schema.dropTable('pageCreationReceipts')
  })
}
