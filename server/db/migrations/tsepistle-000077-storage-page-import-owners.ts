import type { Knex } from 'knex'

/** Accepted source ownership is local operational state, never authored OKF data. */
export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('storagePageImportOwners', table => {
    // No FK: canonical deletion must retain the exact retired source identity.
    table.integer('pageId').primary()
    table.string('sourceKey', 64).notNullable()
    table.text('sourcePath').notNullable()
    table.string('sourceSha256', 64).notNullable()
    table.string('locationKey', 64).notNullable()
    table.boolean('mapped').notNullable().defaultTo(false)
    table.bigInteger('nativeRevision').notNullable()
    table.text('nativePath').notNullable()
    table.string('nativeLocaleCode', 255).notNullable()
    table.string('status', 16).notNullable().defaultTo('active')
    table.uuid('operationId').notNullable()
    table.jsonb('moveBinding').nullable()
    table.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('deletedAt', { useTz: true }).nullable()
    table.index(['sourceKey', 'sourcePath'], 'storage_page_import_source_idx')
    table.check('?? > 0 AND ?? > 0', ['pageId', 'nativeRevision'], 'storage_page_import_native_identity_check')
    const digestColumns = ['sourceKey', 'sourceSha256', 'locationKey']
    table.check(knex.client.config.client === 'pg'
      ? digestColumns.map(() => "?? ~ '^[a-f0-9]{64}$'").join(' AND ')
      : digestColumns.map(() => "length(??) = 64 AND ?? NOT GLOB '*[^a-f0-9]*'").join(' AND '),
    knex.client.config.client === 'pg' ? digestColumns : digestColumns.flatMap(column => [column, column]), 'storage_page_import_digest_check')
    table.check('length(??) BETWEEN 1 AND 4096 AND length(??) BETWEEN 1 AND 2048 AND length(??) BETWEEN 1 AND 255', ['sourcePath', 'nativePath', 'nativeLocaleCode'], 'storage_page_import_path_bounds_check')
    table.check("(?? = 'active' AND ?? IS NULL) OR (?? = 'deleted' AND ?? IS NOT NULL)", ['status', 'deletedAt', 'status', 'deletedAt'], 'storage_page_import_status_check')
    // The trusted helper validates the complete finite move binding, including
    // exact native move identity; the DB also refuses non-object JSON values.
    table.check(knex.client.config.client === 'pg'
      ? "?? IS NULL OR jsonb_typeof(??) = 'object'"
      : "?? IS NULL OR json_type(??) = 'object'", ['moveBinding', 'moveBinding'], 'storage_page_import_move_binding_check')
  })
  await knex.raw('CREATE UNIQUE INDEX storage_page_import_active_source_unique ON "storagePageImportOwners" ("sourceKey", "sourcePath") WHERE status = \'active\'')
}

export const down = async (knex: Knex): Promise<void> => {
  await knex.transaction(async transaction => {
    if (knex.client.config.client === 'pg') await transaction.raw('LOCK TABLE "storagePageImportOwners" IN ACCESS EXCLUSIVE MODE')
    if (await transaction('storagePageImportOwners').first('pageId')) {
      throw new Error('Storage page import ownership includes durable accepted and deleted identities; fix forward instead of dropping these receipts.')
    }
    await transaction.schema.dropTable('storagePageImportOwners')
  })
}
